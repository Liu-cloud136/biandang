// ============================================================================
// bypassGenGuide · env2 兜底：补齐 dish_mirror.guide（详细做法）
//
// BUILD_TAG: 2026-08-24.bypass-gen-guide-v2
//
// 职责：
//   - 扫 env2 本地 dish_mirror 缺 guide（详细做法）的菜；
//   - 若菜已有 steps，用 steps 文本拼接补 guide（与主链 bypassGenSteps 同源）；
//   - 若 steps 也缺失，调 hy3 生成详细步骤并同时写 steps 与 guide。
//
// 背景（根因）：
//   guide（详细做法）自 2026-08-24 起由主链 bypassGenSteps 生成（步骤文本落
//   steps 与 guide）。本函数仅作兜底：扫 guide 仍缺失的菜，优先复用 steps 补，
//   避免重复调 AI；steps 也缺时才生成。早期 402 个 guide 为 null 的存量菜已由
//   本函数 v1 用 hy3 补过（已是步骤风格文本），本次 v2 主要是主链接管后的查漏。
//
// 说明：
//   guide 字段存在但值为 null，因此扫描条件用 guide: null（而非 $exists(false)）。
// ============================================================================

const BUILD_TAG = '2026-08-25.bypass-gen-guide-parsekit';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';

const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();

const SLOT_N = 5;
const BATCH = 24;
const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '抽烟', '饮酒', 'hei'];
const { RateLimiter } = require('./rateLimiter');
const parseKit = require('./parseKit');
const limiter = new RateLimiter({ rateInit: 5, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 200, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassGenGuide BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'guide', env: TCB_ENV };
  }

  // 全局生成开关：默认停用（GEN_DISABLED 未显式置 'false' 即停），彻底停止生成/补齐
  if (process.env.GEN_DISABLED !== 'false') {
    console.log('[bypassGenGuide] GEN_DISABLED 已开启，跳过执行');
    return { ok: false, disabled: true, reason: 'gen_disabled' };
  }

  // 全量重刷：用 steps 重拼 guide（把旧版点评风格 guide 替换为详细做法）
  if (task === 'resyncAll') {
    const MAX_MS = 105000;
    const startedAt = Date.now();
    let totalComputed = 0;
    let lastId = cursor && cursor.lastId;
    while (true) {
      const batchSize = Math.min(Number(limit) || BATCH, BATCH);
      const cond = { source: 'ai-generated' };
      if (lastId) cond._id = _.gt(lastId);
      let q = db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize);
      let list = [];
      try { const res = await q.get(); list = res.data || []; } catch (e) { list = []; }
      if (!list.length) break;
      let computed = 0;
      for (const d of list) {
        if (Array.isArray(d.steps) && d.steps.length >= 3) {
          const guide = d.steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + (s.text || '')).join(' ');
          await db.collection('dish_mirror').doc(d._id).update({ data: { guide, guideUpdatedAt: Date.now() } });
          computed++; lastId = d._id;
        }
      }
      totalComputed += computed;
      if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
    }
    return { ok: true, computed: totalComputed, task: 'resyncAll' };
  }

  await ensureCollections();

  if (dishName) {
    const r = await genOne(dishName);
    return Object.assign({ ok: true }, r);
  }

  // 循环补齐：一次调用内翻页扫描所有 guide 为 null 的菜，直到补齐或逼近函数超时。
  const MAX_MS = 105000;
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    // guide 字段存在但值为 null（402 个菜正是此状态），用 guide: null 精确命中
    const cond = { source: 'ai-generated', $or: [{ guide: null }, { guide: _.exists(false) }] };
    if (lastId) cond._id = _.gt(lastId);
    let q = db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize);
    let list = [];
    try { const res = await q.get(); list = res.data || []; } catch (e) { list = []; }
    if (!list.length) break;

    let computed = 0;
    await pool(list, SLOT_N, async (d) => {
      const name = d.name || d.dishName;
      if (!name) return;
      for (const w of BAD_WORDS) { if (name.includes(w)) return; }
      try {
        // 优先用已有 steps 拼 guide（与主链同源，免重复 AI）
        if (Array.isArray(d.steps) && d.steps.length >= 3) {
          const guide = d.steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + (s.text || '')).join(' ');
          await db.collection('dish_mirror').doc(d._id).update({
            data: { guide, guideUpdatedAt: Date.now() },
          });
          computed++;
          lastId = d._id;
          console.log('[bypassGenGuide] steps 复用补 guide name=' + name);
          return;
        }
        // steps 也缺：调 hy3 生成详细步骤，写 steps + guide
        const steps = await genSteps(name, d.cuisine, d.mainIngredient, d.cookingMethod, d.ingredients);
        if (steps && steps.length >= 3) {
          const guide = steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + s.text).join(' ');
          await db.collection('dish_mirror').doc(d._id).update({
            data: { steps, guide, stepsUpdatedAt: Date.now(), guideUpdatedAt: Date.now() },
          });
          computed++;
          lastId = d._id;
          console.log('[bypassGenGuide] 生成 steps+guide name=' + name + ' count=' + steps.length);
        } else {
          console.warn('[bypassGenGuide] 生成过少/空 name=' + name);
          await logTask('bypassGenGuide', null, 'fail', 'steps_too_few name=' + name);
        }
      } catch (e) {
        console.warn('[bypassGenGuide] 生成失败 name=' + name + '：', e && e.message);
        await logTask('bypassGenGuide', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e;
      }
    }, limiter);

    totalComputed += computed;
    rounds++;
    if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
  }

  await logTask('rateLimiter', null, 'info', limiter.monitorMsg()).catch(() => {});
  return { ok: true, computed: totalComputed, rounds, hasMore: false, lastId };
};

async function genOne(name) {
  if (!name) return { skip: true, reason: '空菜名' };
  const steps = await genSteps(name);
  if (!steps || steps.length < 3) return { skip: true, reason: 'steps 过少' };
  const guide = steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + s.text).join(' ');
  return { ok: true, steps, guide };
}

async function genSteps(name, cuisine, mainIngredient, cookingMethod, ingredients) {
  const hints = [];
  if (cuisine) hints.push('菜系：' + cuisine);
  if (mainIngredient) hints.push('主料：' + mainIngredient);
  if (cookingMethod) hints.push('做法：' + cookingMethod);
  if (ingredients && Array.isArray(ingredients) && ingredients.length) {
    hints.push('食材：' + ingredients.map(i => i.name || i).join('、'));
  }
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';
  const messages = [
    {
      role: 'system',
      content: '你是家常菜谱助手。请针对菜品生成详细的烹饪步骤。【严格输出格式】只输出一个 JSON 数组，不要任何解释、不要加 markdown 代码围栏、不要加 ```json 标记，直接以 [ 开头、] 结尾。数组每个元素为对象：{"stepNo": 数字步号从1开始, "text": "该步具体操作描述"}。'
    },
    {
      role: 'user',
      content: '菜品：' + name + hintStr + '\n\n请生成大概的烹饪步骤（4~7 步，每步一句话，按操作顺序排列），每步包含具体操作（如油温、火候、时间、用量等），口语化、可操作。只返回 JSON 数组。'
    }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages,
        temperature: 0.5,
        maxTokens: 600,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const { items, source } = parseKit.extractListItems(text, 'step');
      if (!items || !items.length) throw new Error('空数组');
      for (const w of BAD_WORDS) {
        for (const item of items) {
          if (item && item.text && String(item.text).includes(w)) {
            console.warn('[bypassGenGuide] 黑名单命中 name=' + name + ' word=' + w);
            return null;
          }
        }
      }
      const cleaned = items
        .filter(item => item && item.text && typeof item.text === 'string')
        .map((item, i) => ({
          stepNo: Number(item.stepNo) || (i + 1),
          text: String(item.text).trim().slice(0, 100),
        }));
      if (cleaned.length < 3) throw new Error('步骤过少');
      if (source === 'heuristic') {
        console.warn('[bypassGenGuide] 启发式兜底切分 name=' + name + ' count=' + cleaned.length + ' raw=' + text.slice(0, 200));
        await logTask('bypassGenGuide', null, 'warn', 'heuristic_fallback name=' + name + ' raw=' + text.slice(0, 200)).catch(() => {});
      }
      return cleaned;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else {
        console.warn('[genSteps] hy3 失败 name=' + name + '：', e && e.message);
        await logTask('bypassGenGuide', null, 'fail', 'steps_parse_failed name=' + name + ' raw=' + (e && e.message || '')).catch(() => {});
      }
    }
  }
  return null;
}

function parseJsonArray(text) {
  return parseKit.extractJsonArray(text);
}

async function ensureCollections() {
  await Promise.allSettled([db.createCollection('dish_mirror')]);
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* */ }
}

async function pool(items, concurrency, worker, limiter) {
  let idx = 0;
  const runners = [];
  for (let i = 0; i < concurrency && i < items.length; i++) {
    runners.push((async () => {
      while (idx < items.length) {
        const pos = idx++;
        if (limiter) await limiter.acquire();
        try {
          await worker(items[pos], pos);
          if (limiter) limiter.onSuccess();
        } catch (e) {
          if (limiter) limiter.onLimit();
          else throw e;
        }
      }
    })());
  }
  await Promise.all(runners);
}
