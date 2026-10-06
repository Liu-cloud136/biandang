// ============================================================================
// bypassGapFix · env1 存量菜缺维度补齐（2026-09-01 库内清洗 step4 / 2026-09-02 扩 category）
// BUILD_TAG: 2026-09-02.bypass-gap-fix-catreason
//
// 职责：扫 env2 dish_mirror 中缺维度（profile/reason/category/nutrition）的菜——含
//      env1-backfill / regenerate / regen-steps / regen-ing / ai-generated / cookbook 各来源——
//      缺 profile → hy3 生成画像、缺 reason → hy3 生成推荐语、缺 category → hy3 判类、
//      缺 nutrition → hy3 估算营养，写回 dish_mirror。完成后由同步脚本写回 env1。
// 纪律：
//   - 不受 GEN_DISABLED 限制（这是用户明确的维护补缺，非生菜）；一次性/定时均可。
//   - 复用 bypassAiEnrich / bypassGenReason / bypassNutritionEst 的提示词与解析逻辑（同源）。
//   - hy3 调用直配 'hy3'（hy3-preview 已下线）；限流走自适应令牌桶。
//   - category 判类与 reason 同缺时合并一次 hy3 生成（省调用）；食材摘要作上下文（R-AI-05 教训）。
// ============================================================================

const BUILD_TAG = '2026-09-02.bypass-gap-fix-catreason';
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
const MAX_MS = 170000;
const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '抽烟', '饮酒', 'hei'];
const { RateLimiter } = require('./rateLimiter');
const parseKit = require('./parseKit');
const limiter = new RateLimiter({ rateInit: 5, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 200, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassGapFix BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit } = event || {};
  if (task === 'health') return { ok: true, build: BUILD_TAG, mode: 'gap-fix', env: TCB_ENV };

  const startedAt = Date.now();
  let done = { profile: 0, reason: 0, category: 0, nutrition: 0 };
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    // 扫任意 source 且任一维度缺失（category/reason 为空、profile/nutrition 不存在）
    const miss = _.or([
      { profile: _.exists(false) },
      { reason: _.or(_.exists(false), _.eq('')) },
      { category: _.or(_.exists(false), _.eq('')) },
      { nutrition: _.exists(false) },
    ]);
    let cond = miss;
    if (lastId) cond = _.and([miss, { _id: _.gt(lastId) }]);
    let list = [];
    try { const res = await db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize).get(); list = res.data || []; } catch (e) { list = []; }
    if (!list.length) break;

    await pool(list, SLOT_N, async (d) => {
      const name = d.name || d.dishName;
      if (!name) return;
      try {
        const upd = {};
        const hint = dishHint(d);
        const needsCat = !d.category || !String(d.category).trim();
        const needsRea = !d.reason || !String(d.reason).trim();
        if (needsCat && needsRea) {
          // 两字段同缺：一次 hy3 同出 category + reason
          const cr = await genCatReason(name, hint);
          if (cr) {
            if (cr.category) { upd.category = cr.category; upd.categoryUpdatedAt = Date.now(); done.category++; }
            if (cr.reason) { upd.reason = cr.reason; upd.reasonUpdatedAt = Date.now(); done.reason++; }
          }
        } else if (needsCat) {
          const c = await genCategory(name, hint);
          if (c) { upd.category = c; upd.categoryUpdatedAt = Date.now(); done.category++; }
        } else if (needsRea) {
          const reason = await genReason(name, d.category, d.mainIngredient, d.cookingMethod);
          if (reason) { upd.reason = reason; upd.reasonUpdatedAt = Date.now(); done.reason++; }
        }
        if (!d.profile || !Object.keys(d.profile).length) {
          const profile = await genDishProfile(name);
          if (profile) { upd.profile = profile; upd.aiUpdatedAt = Date.now(); done.profile++; }
        }
        if (!d.nutrition || !Array.isArray(d.nutrition) || !d.nutrition.length) {
          const nutri = await estNutrition(name, d.profile || upd.profile);
          if (nutri) { upd.nutrition = nutri; upd.nutritionUpdatedAt = Date.now(); done.nutrition++; }
        }
        if (Object.keys(upd).length) {
          await db.collection('dish_mirror').doc(d._id).update({ data: upd });
          console.log('[bypassGapFix] 补齐 name=' + name + ' keys=' + Object.keys(upd).join(','));
        }
        lastId = d._id;
      } catch (e) {
        console.warn('[bypassGapFix] 失败 name=' + name + '：', e && e.message);
        await logTask('bypassGapFix', null, 'fail', 'dish [' + name + '] ' + (e && e.message)).catch(() => {});
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e;
      }
    }, limiter);

    rounds++;
    if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
  }

  await logTask('rateLimiter', null, 'info', limiter.monitorMsg()).catch(() => {});
  return { ok: true, done, rounds, hasMore: false, lastId };
};

// ── AI-1 画像（同 bypassAiEnrich.genDishProfile）──────────────────────────
async function genDishProfile(name) {
  const prompt = [
    '你是美食特征分析器。为给定菜品输出结构化画像 JSON。',
    '【严格输出格式】只输出一个 JSON 对象，不要任何解释、不要 markdown 围栏，直接以 { 开头、} 结尾。',
    '字段（键名必须是英文）：spicy(0=不辣 1=微辣 2=中辣 3=特辣 数字)，flavors(1~4个字符串数组：咸/甜/酸/辣/麻/鲜/香/清淡/浓郁/酱香/蒜香/椒麻/酸甜/咸鲜)，cuisine(1个字符串，川菜/湘菜/粤菜/鲁菜/东北菜/家常菜/甜点/汤羹…没有则"家常")，type(荤菜/素菜/汤/主食/小吃/甜品/饮品)，main(主要食材/主料字符串，必须非空)，isVeg(布尔)，isSoup(布尔)，mealTime(字符串数组：早餐/午餐/晚餐/夜宵)',
    'type-mealTime 搭配规则：小吃类→["小吃"]；饮品类→["小吃","下午茶"]；其余按实际餐次',
    '示例：{"spicy":2,"flavors":["香","麻","辣"],"cuisine":"川菜","type":"荤菜","main":"鸡肉","isVeg":false,"isSoup":false,"mealTime":["午餐","晚餐"]}',
    '菜品：' + name
  ].join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages: [{ role: 'user', content: prompt }], temperature: 0.3, maxTokens: 256 });
      const text = resp && (resp.text || (resp.data && resp.data.text)) || '';
      const o = parseKit.extractJsonObject(text);
      if (o) {
        const p = parseJsonProfile(o, 'dish');
        if (p) return p;
      }
      if (attempt === 2) console.warn('[genDishProfile] 解析失败 name=' + name + ' raw=' + text.slice(0, 300));
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genDishProfile] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}

// ── AI-2 推荐语（同 bypassGenReason.genReason）─────────────────────────────
async function genReason(name, category, mainIngredient, cookingMethod) {
  const hints = [];
  if (category) hints.push('类别：' + category);
  if (mainIngredient) hints.push('主料：' + mainIngredient);
  if (cookingMethod) hints.push('做法：' + cookingMethod);
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';
  const messages = [
    { role: 'system', content: '你是菜品推荐语助手。只输出 JSON，不要任何解释。格式：{"reason":"推荐语"}' },
    { role: 'user', content: '菜品：' + name + hintStr + '\n\n请给一句推荐语，格式硬性要求：\n1. 恰好 4 个汉字，文言文（如"咸鲜下饭"、"浓香入味"）\n2. 要贴合主料与做法的具体风味特征，不要套用万能词\n3. 严禁 3 字或 5 字、严禁白话、严禁出现菜名本身、严禁带标点\n4. 同段语义不重复' }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.7, maxTokens: 100 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      let cand = '';
      const obj = parseJsonObject(text);
      if (obj && obj.reason) cand = String(obj.reason).trim();
      if (!/^[\u4e00-\u9fa5]{4}$/.test(cand)) {
        const bare = text.trim();
        if (/^[\u4e00-\u9fa5]{4}$/.test(bare)) cand = bare;
      }
      if (!cand || !/^[\u4e00-\u9fa5]{4}$/.test(cand)) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 800));
        continue;
      }
      for (const w of BAD_WORDS) { if (cand.includes(w)) return null; }
      return cand;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genReason] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}

// ── AI-2.5 类别判类 + 合并生成（2026-09-02 新增）────────────────────────────
const VALID_CATEGORIES = ['饮品', '汤羹', '主食', '荤菜', '素菜', '小吃', '甜品', '其他'];
function normCategory(v) {
  if (!v) return null;
  const t = String(v).trim();
  if (VALID_CATEGORIES.indexOf(t) >= 0) return t;
  // 容错别名
  const ALIAS = { '荤': '荤菜', '素': '素菜', '汤': '汤羹', '甜点': '甜品', '甜食': '甜品', '点心': '小吃', '零嘴': '小吃', '凉菜': '素菜', '家常菜': '其他' };
  if (ALIAS[t]) return ALIAS[t];
  for (const c of VALID_CATEGORIES) {
    if (t.indexOf(c) >= 0 || c.indexOf(t) >= 0) return c;
  }
  return null; // 判不出的（含'菜'这类不规范值）返回 null 留待重试
}
// 判类/推荐语上下文摘要：category + 做法 + 食材列表（R-AI-05：生成必带食材上下文）
function dishHint(d) {
  const parts = [];
  if (d.category && String(d.category).trim()) parts.push('类别：' + String(d.category).trim());
  if (d.mainIngredient && String(d.mainIngredient).trim()) parts.push('主料：' + String(d.mainIngredient).trim());
  if (d.cookingMethod && String(d.cookingMethod).trim()) parts.push('做法：' + String(d.cookingMethod).trim());
  if (Array.isArray(d.ingredients) && d.ingredients.length) {
    const ings = d.ingredients.map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean).slice(0, 8).join('、');
    if (ings) parts.push('食材：' + ings);
  }
  return parts.join('，');
}
const CAT_PROMPT_LINES = [
  '你是菜品分类器。为菜品判断类别，只能从以下 8 类中选一个：饮品/汤羹/主食/荤菜/素菜/小吃/甜品/其他。',
  '判定口径：饮品=液态可饮用（茶饮/果汁/豆浆/咖啡/奶昔/糖水）；汤羹=汤/羹/煲/炖盅；主食=饭/面/粥/粉/饼/饺/包等充饥主餐；荤菜=主料含肉/海鲜/蛋/内脏的菜；素菜=纯素食材的菜；小吃=点心零嘴（酥/糕/饺/卷等非正餐）；甜品=甜口点心糖水（如蒸梨/玛芬/布丁）；都不匹配则"其他"。',
  '严格只输出 JSON，不要解释。格式：{"category":"类别"}',
  '示例：菜名"肉末茄子"→{"category":"荤菜"}；"冬瓜虾仁汤"→{"category":"汤羹"}；"蒸山药糕"→{"category":"甜品"}；"茉莉花茶"→{"category":"饮品"}',
].join('\n');
async function genCategory(name, hint) {
  const prompt = CAT_PROMPT_LINES + '\n菜品：' + name + (hint ? '（' + hint + '）' : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages: [{ role: 'user', content: prompt }], temperature: 0.2, maxTokens: 80 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const obj = parseJsonObject(text);
      const c = obj && normCategory(obj.category);
      if (c) return c;
      if (attempt < 2) await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genCategory] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}
async function genCatReason(name, hint) {
  const prompt = [
    CAT_PROMPT_LINES,
    '同时给一句 4 字文言推荐语（如"咸鲜下饭"/"浓香入味"，点明风味，严禁白话/标点/菜名本身）。',
    '严格只输出 JSON：{"category":"类别","reason":"四字推荐语"}',
    '菜品：' + name + (hint ? '（' + hint + '）' : ''),
  ].join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages: [{ role: 'user', content: prompt }], temperature: 0.4, maxTokens: 120 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const obj = parseJsonObject(text);
      if (!obj) { if (attempt < 2) await new Promise(r => setTimeout(r, 800)); continue; }
      const out = {};
      const c = obj.category ? normCategory(obj.category) : null;
      if (c) out.category = c;
      let cand = (obj.reason && String(obj.reason).trim()) || '';
      if (!/^[\u4e00-\u9fa5]{4}$/.test(cand)) cand = '';
      if (cand) {
        for (const w of BAD_WORDS) { if (cand.indexOf(w) >= 0) cand = ''; }
      }
      if (cand) out.reason = cand;
      if (out.category || out.reason) return out;
      if (attempt < 2) await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genCatReason] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}

// ── AI-3 营养估算（同 bypassNutritionEst.estNutrition）────────────────────
async function estNutrition(name, profile) {
  const prompt = [
    '你是营养估算器。为给定家常菜估算每份（一人份家常量）的营养，只输出 JSON，不要解释。',
    '字段：calories(热量kcal整数), protein(蛋白g), carbs(碳水g), fat(脂肪g)',
    '参考：番茄炒蛋≈{calories:180,protein:9,carbs:10,fat:12}，清炒时蔬≈{calories:120,protein:3,carbs:8,fat:8}，红烧肉≈{calories:480,protein:18,carbs:10,fat:42}',
    '菜品：' + name
  ].join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages: [{ role: 'user', content: prompt }], temperature: 0.3, maxTokens: 128 });
      const text = resp && (resp.text || (resp.data && resp.data.text)) || '';
      const n = parseNutrition(text, profile);
      if (n) return n;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[estNutrition] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}

// ── 解析辅助 ───────────────────────────────────────────────────────────────
function parseJsonProfile(input, kind) {
  let o = input;
  if (typeof input === 'string') o = parseKit.extractJsonObject(input);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  try {
    if (kind === 'dish') {
      const profile = {
        spicy: clampInt(o.spicy, 0, 3, 0),
        flavors: toArr(o.flavors), cuisine: pickStr(o.cuisine, 8),
        type: pickStr(o.type, 8), main: pickStr(o.main, 12),
        isVeg: !!o.isVeg, isSoup: !!o.isSoup,
        mealTime: toArr(o.mealTime),
      };
      const validated = validateDishProfile(profile);
      if (!validated) return null;
      return validated;
    }
    return null;
  } catch (e) { return null; }
}
function validateDishProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const MEATS = ['猪肉', '牛肉', '鸡肉', '鸭肉', '鱼肉', '虾', '羊肉', '排骨', '腊肉', '火腿'];
  if (profile.isVeg && MEATS.some(m => profile.main && profile.main.includes(m))) profile.isVeg = false;
  if (profile.isSoup && ['炒菜', '凉菜', '荤菜', '素菜'].includes(profile.type)) profile.type = '汤';
  if (profile.spicy >= 2 && !(profile.flavors || []).includes('辣')) profile.flavors = [...(profile.flavors || []), '辣'];
  if (!profile.main) return null;
  if (!profile.type) return null;
  return profile;
}
function parseJsonObject(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (e2) { return null; }
}
function parseNutrition(text, profile) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    const cal = clampNum(o.calories || o.kcal, 20, 2000, 280);
    const pro = clampNum(o.protein, 0, 100, 15);
    const carb = clampNum(o.carbs || o.carbohydrate, 0, 200, 20);
    const fat = clampNum(o.fat, 0, 150, 12);
    const result = [Math.round(cal), Math.round(pro), Math.round(carb), Math.round(fat)];
    if (result.every(v => v === 0)) return null;
    if (profile && profile.isSoup && result[0] > 400) result[0] = Math.round(result[0] * 0.6);
    return result;
  } catch (e) { return null; }
}
function clampInt(v, min, max, dft) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}
function clampNum(v, min, max, dft) {
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}
function pickStr(v, maxLen) { return typeof v === 'string' ? v.slice(0, maxLen) : ''; }
function toArr(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).slice(0, 6);
  if (typeof v === 'string' && v.trim()) return [v.trim().slice(0, 16)];
  return [];
}
async function logTask(task, openid, status, errMsg) {
  try { await db.collection('bypass_log').add({ data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() } }); } catch (e) {}
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
