// getCookGuide · 取菜谱详情（读分表 + 缺做法时 AI 实时生成回流 + 消耗 1 次免费次数）
// 读链路：dish_lexicon 主库（按 name 字段查——_id 是系统生成的，doc(dish) 查不到）+ 五个分表（按 normLexName 归一 key）
// 生成链路（2026-08-30 v6 恢复）：读库缺 ingredients/steps（或主库无此菜）→ 校验并扣减免费次数(1) → 混元 hy3 实时生成
//   食材/步骤/贴士 → 写分表 → 返回。已生成的菜直接读库（前端本地缓存避免重复扣次）。
// 提示词复用 env2 原始生成提示词（bypassGenIngredients/bypassGenSteps/bypassGenTips，其中步骤提示词源自 getCookGuide 原始 buildPrompt）。
// 前端约定：data.ingredients / data.steps 必须是字符串数组（WXML 直接 {{ing}}/{{st}} 渲染），本函数负责对象→字符串转换。
// 依赖：@cloudbase/node-sdk + utils/aiGateway.js 副本（与 getRecommendation 同版）
// BUILD_TAG: 2026-09-02.v7.3-write-sub-cache（词典无菜生成照旧写回现有 8 分表并读回——废弃 cookguide_gen 独立缓存表，
//   写回记录带 source='cookguide-ai' 与历史孤儿区分，孤儿判定/清理豁免该 source）
// 2026-09-07.cook-firstview-charge：扣次语义修正——首次查看扣 1 次（库内四维齐同样扣），
//   cook_viewed 判重复看免费；生成失败同池退款；free_log source 统一 cook/sourceName 中文。
const BUILD_TAG = '2026-09-07.cook-firstview-charge';
const cloud = require('wx-server-sdk');
const tcb = require('@cloudbase/node-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1'; // 与 getRecommendation 一致（env1 兜底）
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase'); // 模块级单例
const TEXT_MODEL = 'hy3';                     // 混元文本模型（hy3-preview 已下线）
const aiGateway = require('./utils/aiGateway');

let normLexName;
try { const m = require('./_shared/normLexName'); normLexName = m.normLexName || m; }
catch (e) { const m = require('./normLexName'); normLexName = m.normLexName || m; }



// ---- 用户次数（复刻 consumeFreeCount 的建档，不做注销守卫细节）----
async function ensurePrefs(OPENID) {
  const r = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
  if (r.data && r.data[0]) return r.data[0];
  const add = await db.collection('user_preferences').add({
    data: { baseFree: 0, bonusFree: 0, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', _openid: OPENID }
  });
  return { _id: add._id, baseFree: 0, bonusFree: 0 };
}

// 扣减 1 次（事务：bonusFree 优先，其次 baseFree；free_log 记 type:'deduct' source:'cook'）
// 返回 {code:200, pool}：pool = 实际扣除池（'bonusFree'|'baseFree'），供生成失败退款同池退回。
async function deductFree(OPENID, prefsId) {
  const t = await db.startTransaction();
  try {
    const cur = (await t.collection('user_preferences').doc(prefsId).get()).data || {};
    const b = cur.baseFree || 0, bo = cur.bonusFree || 0;
    if (b + bo <= 0) { await t.rollback(); return { code: 403 }; }
    const pool = bo > 0 ? 'bonusFree' : 'baseFree';
    await t.collection('user_preferences').doc(prefsId).update({ data: { [pool]: _.inc(-1) } });
    await t.collection('free_log').add({
      data: { _openid: OPENID, type: 'deduct', source: 'cook', sourceName: '查看做法', amount: 1, desc: '看做法 -1', ts: db.serverDate() }
    });
    await t.commit();
    return { code: 200, pool };
  } catch (e) {
    try { await t.rollback(); } catch (e2) { /* 忽略 */ }
    throw e;
  }
}

// ---- AI 实时生成（混元 hy3 + aiGateway 降级）----
// 提示词复用 env2 原始生成提示词：
//   食材  ← env2_functions/bypassGenIngredients（含量词约束）
//   步骤  ← env2_functions/bypassGenSteps（原为 env1 getCookGuide 的 buildPrompt）
//   贴士  ← env2_functions/bypassGenTips
function buildGuidePrompt(dish) {
  return `菜品：${dish}

一、请生成完整的食材列表（含主料和调料）：请生成 3-8 项食材，包含主料和常用调料。amount 用中文数字（如"200"、"1"），unit 用中文单位（如"克"、"毫升"、"个"）。当用量为模糊量词时，amount 填"适量"或"少许"，unit 留空字符串。严禁 amount 和 unit 都填模糊量词（如"适量"+"适量"），严禁 amount 填模糊量词时 unit 填具体单位（如"少许"+"克"）。

二、请生成详细的烹饪步骤（4~7 步，每步一句话，按操作顺序排列），每步包含具体操作（如油温、火候、时间、用量等），口语化、可操作。

三、请给出一条最实用的家常小贴士，20-40 字，聚焦火候/去腥/入味/防粘锅等关键要点。

只输出一个 JSON 对象（不要任何解释、不要 markdown 代码围栏、不要 \`\`\`json 标记），结构固定：
{"ingredients":[{"name":"食材名","amount":"用量","unit":"单位"}],"steps":[{"stepNo":1,"text":"操作"}],"tips":"贴士文本"}`;
}

async function genText(messages, opts) {
  const maxTokens = (opts && opts.maxTokens) || 1500;
  const label = (opts && opts.label) || 'cookguide';
  const temperature = (opts && opts.temperature != null) ? opts.temperature : 0.8;
  const callHy3 = async () => textModel.generateText({ model: TEXT_MODEL, messages, temperature, topP: 0.9, maxTokens });
  return await aiGateway.callUnifiedText(messages, { temperature, topP: 0.9, primary: 'hy3', maxTokens, label }, { callHy3 }, db);
}

function parseJson(text) {
  const s = String(text || '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 返回无 JSON');
  return JSON.parse(m[0]);
}

// 前端 WXML 直接 {{ing}}/{{st}} 渲染 → 必须返回字符串数组；分表存对象数组，转换仅限返回层
function fmtIngredients(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => {
    if (typeof x === 'string') return x.trim();
    const n = String((x && x.name) || '').trim();
    const a = (x && x.amount == null) ? '' : String(x.amount).trim();
    const u = String((x && x.unit) || '').trim();
    return [n, a, u].filter(Boolean).join(' ');
  }).filter(Boolean);
}
function fmtSteps(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(x => (typeof x === 'string' ? x.trim() : String((x && x.text) || '').trim())).filter(Boolean);
}

async function generateGuide(dish, nid, opts) {
  // AI 生成（扣次由 main 按「首次查看」统一收，此处不再扣——2026-09-07 语义修正）
  try {
    const messages = [
      { role: 'system', content: '你是严谨专业的家常中餐菜谱作者，只输出 JSON。' },
      { role: 'user', content: buildGuidePrompt(dish) },
    ];
    const r = await genText(messages, { maxTokens: 1800, label: 'cookguide' });
    const j = parseJson(r.text);
    if (!Array.isArray(j.ingredients) || !j.ingredients.length) throw new Error('食材缺失');
    if (!Array.isArray(j.steps) || !j.steps.length) throw new Error('步骤缺失');
    const ingredients = (j.ingredients || [])
      .map(x => ({ name: String((x && x.name) || '').trim(), amount: String((x && x.amount) == null ? '' : x.amount).trim(), unit: String((x && x.unit) || '').trim() }))
      .filter(x => x.name);
    const steps = (j.steps || [])
      .map((x, i) => ({ stepNo: Number((x && x.stepNo)) || (i + 1), text: String((x && x.text) || '').trim() }))
      .filter(x => x.text);
    if (!ingredients.length || !steps.length) throw new Error('生成内容为空');
    let review = String((j.review || '')).trim();
    let difficulty = ['简单', '中等', '较难'].includes(j.difficulty) ? j.difficulty : '';
    let tips = String((j.tips || '')).trim();

    // 3) 缺失维度补生成（尽力而为，失败不致命——保证每次生成的菜维度尽量齐全）
    if (!tips) { try { tips = await genTipsOnly(dish); } catch (e) { console.warn('[getCookGuide] tips 补生成失败: ' + (e && e.message)); } }
    if (!review || !difficulty) {
      try {
        const rv = await genReviewOnly(dish);
        if (!review) review = rv.review;
        if (!difficulty) difficulty = rv.difficulty;
      } catch (e) { console.warn('[getCookGuide] review 补生成失败: ' + (e && e.message)); }
    }

    // 4) 写回现有 8 分表作缓存（词典无菜时 tagCache=true：带 source='cookguide-ai' 标记，
    //    与历史孤儿区分开，孤儿判定/清理豁免此类受控生成缓存）
    const ts = Date.now();
    const mk = (extra) => (opts && opts.tagCache ? Object.assign({}, extra, { source: 'cookguide-ai' }) : extra);
    const writes = [
      db.collection('dish_ingredients').doc(nid).set({ data: mk({ name: dish, ingredients, ts }) }),
      db.collection('dish_steps').doc(nid).set({ data: mk({ name: dish, steps, ts }) }),
    ];
    if (review || difficulty) writes.push(db.collection('dish_review').doc(nid).set({ data: mk({ name: dish, review, difficulty, ts }) }));
    if (tips) writes.push(db.collection('dish_tips').doc(nid).set({ data: mk({ name: dish, tips, ts }) }));
    await Promise.all(writes);
    return { code: 200, ingredients, steps, review, difficulty, tips };
  } catch (e) {
    console.error('[getCookGuide] 生成失败 ' + dish + ': ' + (e && e.message));
    return { code: 500, msg: '生成失败，请稍后重试' };
  }
}

// 贴士补生成（复用 env2 bypassGenTips 提示词）
async function genTipsOnly(dish) {
  const messages = [
    { role: 'system', content: '你是家常菜烹饪助手。只输出纯文本，不要任何 JSON、解释或标点包裹。' },
    { role: 'user', content: '菜品：' + dish + '\n\n请给出一条最实用的家常小贴士，20-40 字，聚焦火候/去腥/入味/防粘锅等关键要点。只回贴文本本身。' },
  ];
  const r = await genText(messages, { maxTokens: 200, temperature: 0.5, label: 'cookguide-tips' });
  return String((r && r.text) || '').trim();
}

// 点评/难度补生成
async function genReviewOnly(dish) {
  const messages = [
    { role: 'system', content: '你是家常菜点评助手。只输出一个 JSON 对象，不要其他文字：{"review":"8-14字点评","difficulty":"简单|中等|较难"}' },
    { role: 'user', content: '菜品：' + dish + '\n\n给出一句点评（8-14 个汉字，如"肥而不腻，软糯咸香"）和烹饪难度（简单/中等/较难）。只返回 JSON。' },
  ];
  const r = await genText(messages, { maxTokens: 200, temperature: 0.4, label: 'cookguide-review' });
  const j = parseJson((r && r.text) || '');
  return { review: String((j && j.review) || '').trim(), difficulty: ['简单', '中等', '较难'].includes(j && j.difficulty) ? j.difficulty : '' };
}

exports.main = async (event, context) => {
  const { dish } = event;
  console.log('[build] getCookGuide BUILD_TAG=' + BUILD_TAG + ' dish=' + dish);
  if (!dish) return { ok: false, code: 400, msg: 'dish 缺失' };

  // 归一 key：统一主库/分表读写 key
  const nid = normLexName(dish);
  // OPENID 兜底（2026-09-12）：webApi 聚合入口以 event.OPENID 透传游客身份（'w' 前缀），wxContext 优先不变形
  const OPENID = cloud.getWXContext().OPENID || (event && event.OPENID) || '';

  // 读：主库（name 原文/norm_id or 匹配——前端传名可能与主库 name 有空格/写法差异；_id 系统生成不可用）
  //     + 分表（并行）。dish_guide 已废弃，做法/点评/贴士/食材读分项表
  // 孤儿治理（v7）：词典（dish_lexicon）是读取唯一门槛——主库无此菜（lexRow=null）时**不读任何分表**，
  //   分表中残留的"分表有、词典无"记录（孤儿）一律视为无效沉积物，直接走 AI 实时生成（用户明确：不存在也应生成）
  const lexQ = await db.collection('dish_lexicon').where(_.or([{ name: dish }, { name: nid }, { norm_id: nid }])).limit(1).get().catch(() => null);
  const lexRow = (lexQ && lexQ.data && lexQ.data[0]) || null; // where().get() 返回数组
  const basic = lexRow || {};

  // 分表 doc().get() 返回 {data: 文档对象}（wx-server-sdk）。词典有菜 → 读全部分表（画像/营养/图）；
  // 词典无菜 → 只读 4 个做法表（可命中本函数此前生成写回的 cookguide-ai 缓存），不读画像/营养/图，
  //   避免把历史残留或跨环境坏图当数据返回
  let p = {}, n = {}, s = {}, rv = {}, t = {}, ing = {}, i = {};
  const [profile, nutri, stepsDoc, reviewDoc, tipsDoc, ingDoc, img] = lexRow
    ? await Promise.all([
        db.collection('dish_profile').doc(nid).get().catch(() => null),
        db.collection('dish_nutrition_v2').doc(nid).get().catch(() => null),
        db.collection('dish_steps').doc(nid).get().catch(() => null),
        db.collection('dish_review').doc(nid).get().catch(() => null),
        db.collection('dish_tips').doc(nid).get().catch(() => null),
        db.collection('dish_ingredients').doc(nid).get().catch(() => null),
        db.collection('dish_image_v2').doc(dish).get().catch(() => null),
      ])
    : await Promise.all([
        Promise.resolve(null), Promise.resolve(null),
        db.collection('dish_steps').doc(nid).get().catch(() => null),
        db.collection('dish_review').doc(nid).get().catch(() => null),
        db.collection('dish_tips').doc(nid).get().catch(() => null),
        db.collection('dish_ingredients').doc(nid).get().catch(() => null),
        Promise.resolve(null),
      ]);
  p = (profile && profile.data) || {};
  n = (nutri && nutri.data) || {};
  s = (stepsDoc && stepsDoc.data) || {};
  rv = (reviewDoc && reviewDoc.data) || {};
  t = (tipsDoc && tipsDoc.data) || {};
  ing = (ingDoc && ingDoc.data) || {};
  i = (img && img.data) || {};

  const result = {
    name: dish,
    cuisine: basic.cuisine || (p.profile && p.profile.cuisine) || '',
    category: basic.category || '',
    mealTime: basic.mealTime || [],
    season: basic.season || [],
    reason: basic.reason || '',
    profile: p.profile || basic.profile || null,
    nutrition: n.nutrition || basic.nutrition || null,
    guide: s.steps || basic.guide || null,
    review: rv.review || basic.review || null,
    difficulty: rv.difficulty || basic.difficulty || null,
    tips: t.tips || basic.tips || null,
    ingredients: fmtIngredients(ing.ingredients || basic.ingredients),
    steps: fmtSteps(s.steps || basic.steps),
    imageUrl: i.imageUrl || basic.imageUrl || '',
  };

  // 前端需要的四维（食材/步骤/贴士/点评）只要缺一个 → 整体丢给 AI 重新生成完整版
  // 注意空数组 [] 是 truthy，判缺必须带 length
  const FRONT_NEED = ['ingredients', 'steps', 'tips', 'review'];
  const missAny = FRONT_NEED.some(k => { const v = result[k]; return !v || (Array.isArray(v) && !v.length); });

  // 已看过判重（cook_viewed，_id = openid::菜名 历史格式）：看过 → 本次免费（复看）；未看过 → 首次查看扣 1 次。
  // 2026-09-07 语义修正：不再按 missAny（是否生成）扣，而是按「是否首次查看」扣——
  //   库内四维齐的菜首次查看同样扣 1 次，与前端「消耗 1 次」文案一致；复看不扣（含换机/清缓存由 cook_viewed 兜底）。
  //   无 OPENID（部署验证 / 内部只读）跳过扣次，与原行为一致：库内齐直接返回、missAny 需身份生成。
  let viewed = false;
  if (OPENID && dish) {
    try {
      const vq = await db.collection('cook_viewed').where({ _openid: OPENID, dish }).limit(1).get();
      viewed = !!(vq && vq.data && vq.data.length);
    } catch (e) { viewed = false; /* 读失败按未看过 → 走扣次，宁严勿漏 */ }
  }

  // 首次查看（有身份）：扣 1 次（含库内已齐、需 AI 生成两类）。扣成功后记 cook_viewed，保证后续复看免费。
  let charged = false;
  let chargedPool = 'baseFree';
  if (OPENID && !viewed) {
    const prefs = await ensurePrefs(OPENID);
    if (!prefs || prefs._id == null) return { ok: false, code: 403, msg: '免费次数不足，请去主页「领次数」按钮领取。' };
    const d = await deductFree(OPENID, prefs._id);
    if (d.code !== 200) return { ok: false, code: 403, msg: '免费次数不足，请去主页「领次数」按钮领取。' };
    charged = true;
    if (d.pool) chargedPool = d.pool;
    try {
      // _id 用 openid::菜名（与历史 cook_viewed 格式一致），幂等 set
      await db.collection('cook_viewed').doc(OPENID + '::' + dish).set({ data: { _openid: OPENID, dish, ts: db.serverDate() } });
    } catch (e) { console.warn('[getCookGuide] cook_viewed 记录失败：', (e && e.message) || e); }
  }

  if (missAny && !viewed) {
    // 内容缺失但无身份（部署验证等只读调用）：不免费生成，报 401（与原行为一致，扣次前置后需身份）
    if (!OPENID) return { ok: false, code: 401, msg: '未获取到用户身份' };
    // 首次查看且内容缺失 → 扣次已在上方完成，这里仅 AI 生成并写回（tagCache=词典无菜时带 source='cookguide-ai'）
    const g = await generateGuide(dish, nid, { tagCache: !lexRow });
    if (g.code === 200) {
      result.ingredients = fmtIngredients(g.ingredients);
      result.steps = fmtSteps(g.steps);
      if (g.review) result.review = g.review;
      if (g.difficulty) result.difficulty = g.difficulty;
      if (g.tips) result.tips = g.tips;
      result.generated = true;
    } else {
      // 500 生成失败：本次已扣的 1 次退回（不应让用户为失败内容付费）——退回同一池，sourceName 直接带中文
      if (charged) {
        try {
          const prefs = await ensurePrefs(OPENID);
          if (prefs && prefs._id) {
            await db.collection('user_preferences').doc(prefs._id).update({ data: { [chargedPool]: _.inc(1) } });
            await db.collection('free_log').add({
              data: { _openid: OPENID, type: 'add', source: 'cook_refund', sourceName: '做法生成失败退回', amount: 1, desc: '看做法生成失败退回', ts: db.serverDate() }
            }).catch(() => {});
            // 同时删除已写的 viewed 记录，让下次重试仍按首次扣费口径处理
            await db.collection('cook_viewed').doc(OPENID + '::' + dish).remove().catch(() => {});
          }
        } catch (re) { console.error('[getCookGuide] 生成失败退款失败：', (re && re.message) || re); }
      }
      return { ok: false, code: g.code, msg: g.msg || '生成失败，请稍后重试' };
    }
  }
  // 复看且内容缺失（viewed=true 极端：分表被外部清空）→ 不免费生成（防烧钱），返回已有内容留空即可

  // 额外字段（透传给前端做展示与收藏；charged 供前端判断本次是否实际扣次，消除「说了扣没扣」困惑）
  if (OPENID) {
    result.charged = charged;
    result.viewed = viewed || charged;
  }

  const seven = ['profile', 'nutrition', 'guide', 'ingredients', 'steps', 'tips', 'imageUrl'];
  result.missing = seven.filter(k => !result[k]);
  result.complete = result.missing.length === 0;

  // ---- 写链路：AI 生成回流（兼容调用方传 aiGen 产物）----
  if (event.aiGen) {
    const ag = event.aiGen;
    const ts = Date.now();
    try {
      const writes = [];
      if (ag.profile) writes.push(db.collection('dish_profile').doc(nid).set({ data: { name: dish, profile: ag.profile, ts } }));
      if (ag.nutrition) writes.push(db.collection('dish_nutrition_v2').doc(nid).set({ data: { name: dish, nutrition: ag.nutrition, ts } }));
      if (ag.ingredients) writes.push(db.collection('dish_ingredients').doc(nid).set({ data: { name: dish, ingredients: ag.ingredients, ts } }));
      if (ag.steps) writes.push(db.collection('dish_steps').doc(nid).set({ data: { name: dish, steps: ag.steps, ts } }));
      if (ag.tips) writes.push(db.collection('dish_tips').doc(nid).set({ data: { name: dish, tips: ag.tips, ts } }));
      if (ag.review || ag.difficulty) writes.push(db.collection('dish_review').doc(nid).set({ data: { name: dish, review: ag.review || null, difficulty: ag.difficulty || null, ts } }));
      await Promise.all(writes);
      result.synced = true;
    } catch (e) { result.syncErr = (e && e.message) || 'unknown'; }
  }

  return { ok: true, code: 200, build: BUILD_TAG, data: result };
};
