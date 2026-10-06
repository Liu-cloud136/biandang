// backfillNutrition —— 存量探索菜营养回填
//
// 背景（2026-08-26 修复断裂点1）：旧版 getCookGuide 仅双写做法/食材/评价/贴士分表，
//   从不产出营养，导致 ai-gen 探索菜 dish_nutrition_v2 缺失。新版已修复（生成时顺带写营养），
//   但此前已入库的存量菜需本脚本回补。
//
// 行为：
//   1) 拉 dish_steps（有做法=已生成探索菜）与 dish_nutrition_v2 全量，求差集 = 缺营养菜
//   2) 对每道菜：基于其 dish_ingredients + dish_steps 拼 prompt，让混元估 [热量,蛋白,碳水,脂肪]
//   3) 解析后写 dish_nutrition_v2（_id=norm_id，与 env2-nutrition / getCookGuide 同结构）
//   4) 幂等：已存在则跳过（除非 event.force=true 覆盖）
//
// 异常回退策略（用户明确要求）：任何一道菜 AI 生成失败 / JSON 解析异常 / 写入异常 →
//   直接 throw，整批以失败告终，由调用方重试（不静默吞错、不让部分成功伪装成全成功）。

const tcb = require('@cloudbase/node-sdk');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

let normLexName;
try { ({ normLexName } = require('./normLexName')); }
catch (e) { ({ normLexName } = require('./_shared/normLexName')); }

const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');

const BUILD_TAG = '2026-08-26.backfillNutrition';
console.log('[build] backfillNutrition BUILD_TAG=' + BUILD_TAG);

const TEXT_MODEL = 'hy3';

// 全量拉取统一用 _id 游标分页，规避云开发 skip 上限 1000（集合不存在时 cursorFetch 内部已容错返回空）
const { fetchAll } = require('./_shared/cursorFetch');

// 让模型基于食材+做法估营养四元组
async function estimateNutrition(dish, ingredients, steps) {
  const ingText = (Array.isArray(ingredients) && ingredients.length)
    ? ingredients.map(s => String(s)).join('、')
    : '（无食材清单）';
  const stepText = (Array.isArray(steps) && steps.length)
    ? steps.map((s, i) => (i + 1) + '. ' + String(s)).join('\n')
    : '（无步骤）';
  const prompt =
    '你是营养师。请基于下面这道家常菜的食材清单与烹饪步骤，估算整道菜的近似营养。\n' +
    '菜品：「' + dish + '」\n' +
    '食材：' + ingText + '\n' +
    '步骤：\n' + stepText + '\n\n' +
    '只输出 JSON，不要任何额外说明，格式为：{"nutrition":[热量kcal,蛋白质g,碳水化合物g,脂肪g]}，' +
    '四个数字均为非负，按常见家常做法估算。';

  const res = await textModel.generateText({ model: TEXT_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3, topP: 0.9 });
  if (!res || !res.text) throw new Error('AI 返回空正文 dish=' + dish);
  const t = String(res.text).trim();
  const fence = t.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/);
  const raw = fence ? fence[1].trim() : t;
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('AI 返回无法定位 JSON dish=' + dish + ' text=' + raw.slice(0, 80));
  const obj = JSON.parse(raw.slice(s, e + 1));
  if (!Array.isArray(obj.nutrition) || obj.nutrition.length < 4) {
    throw new Error('AI 返回 nutrition 非四元组 dish=' + dish + ' got=' + JSON.stringify(obj.nutrition));
  }
  const nutri = obj.nutrition.slice(0, 4).map(n => {
    const v = Number(n);
    if (!isFinite(v) || v < 0) throw new Error('AI 返回 nutrition 含非法值 dish=' + dish + ' got=' + JSON.stringify(obj.nutrition));
    return v;
  });
  return nutri;
}

exports.main = async (event, context) => {
  console.log('[build] backfillNutrition BUILD_TAG=' + BUILD_TAG + ' event=' + JSON.stringify(event || {}));
  const dryRun = !!(event && event.dryRun);
  const force = !!(event && event.force);
  const limit = (event && Number(event.limit)) || 0;
  const only = (event && Array.isArray(event.only)) ? event.only : null;

  // 1) 拉分表
  const stepsAll = await fetchAll('dish_steps', { norm_id: true, name: true, steps: true });
  const nutriAll = await fetchAll('dish_nutrition_v2', {});
  const ingAll = await fetchAll('dish_ingredients', { norm_id: true, name: true, ingredients: true });

  const nutriSet = new Set(nutriAll.map(d => d._id || d.norm_id));
  const ingMap = new Map();
  for (const d of ingAll) {
    const k = d.norm_id || d.name;
    if (k) ingMap.set(k, d.ingredients);
  }

  // 2) 求差集：有做法 且（不存在营养 或 force）
  const targets = [];
  for (const d of stepsAll) {
    const nid = d.norm_id || normLexName(d.name || d._id);
    if (!nid) continue;
    if (!force && nutriSet.has(nid)) continue;
    if (only && only.indexOf(d.name || d._id) === -1) continue;
    targets.push({ nid, name: d.name || d._id, steps: d.steps, ingredients: ingMap.get(nid) || [] });
  }
  if (limit > 0 && targets.length > limit) targets.length = limit;

  const plan = targets.map(t => t.name);
  if (dryRun) {
    return { ok: true, dryRun: true, total: targets.length, plan };
  }

  // 3) 逐菜回填（异常直接抛出 → 整批失败重试）
  const written = [];
  const failed = [];
  for (const t of targets) {
    try {
      const nutri = await estimateNutrition(t.name, t.ingredients, t.steps);
      await db.collection('dish_nutrition_v2').doc(t.nid).set({
        data: {
          name: t.name,
          nutrition: nutri,
          source: 'backfill-2026-08-26',
          ts: Date.now()
        }
      });
      written.push(t.name);
    } catch (e) {
      // 异常回退：直接失败，整批重试（不在循环内吞错）
      const msg = '[backfillNutrition] 菜「' + t.name + '」失败：' + ((e && e.message) || e);
      console.error(msg);
      failed.push({ name: t.name, err: (e && e.message) || String(e) });
      throw new Error(msg);
    }
  }

  return { ok: true, total: targets.length, written, failed };
};
