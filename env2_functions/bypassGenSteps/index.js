// ============================================================================
// bypassGenSteps · env2 AI 生成详细菜谱步骤（阶段4，方案 §5 / §7 阶段4）
// BUILD_TAG: 2026-09-16c.bypass-gen-steps-numfmt
//
// 职责：
//   - 扫 env2 本地 dish_mirror 缺 steps 的菜；
//   - hy3 生成结构化详细步骤 [{stepNo, text}]，提示词复用 env1 getCookGuide buildPrompt
//     「大概的烹饪步骤（4~7 步，每步一句话，按操作顺序排列）」与「详细做法」同源；
//   - 写 env2 本地 dish_mirror.steps（数组）+ dish_mirror.guide（步骤文本拼接，作为"详细做法"）。
//
// 说明：
//   guide（详细做法）自 v3 起由本函数主链生成：生成的详细步骤同时落 steps 与 guide，
//   保证 syncFromEnv2 七件套 guide 非空且内容与 env1「详细做法」同源。bypassGenGuide
//   仅作兜底（扫 guide 仍缺失的菜，用 steps 拼接补，不再单独调 AI）。
//
// 纪律：
//   - 与 bypassAiEnrich/bypassNutritionEst/bypassText/bypassGenImage/bypassGenIngredients 并行执行；
//   - hy3 直配 'hy3'；并发 SLOT_N=5；
//   - 内容自检：步骤 ≥3 步才收，BAD_WORDS 黑名单命中则丢弃；
//   - 失败静默记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-09-16c.bypass-gen-steps-numfmt';
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
const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '抽烟', '饮酒', 'hei', '果子狸', '穿山甲', '蝙蝠'];
const { RateLimiter } = require('./rateLimiter');
const parseKit = require('./parseKit');
// 自适应速率控制器（文）：初始 5、上限 8、60s 窗硬上限 200、429 退避 2/4/8s
const limiter = new RateLimiter({ rateInit: 5, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 200, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassGenSteps BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'steps', env: TCB_ENV };
  }

  // 2026-09-02：解除 GEN_DISABLED——env1-backfill 补缺场景需要本函数补齐 372 道缺 steps 的存量菜
  // 生菜停用仍由 bypassGenDish 自身开关控制，本补齐函数不再受全局开关限制
  // if (process.env.GEN_DISABLED !== 'false') {
  //   console.log('[bypassGenSteps] GEN_DISABLED 已开启，跳过执行');
  //   return { ok: false, disabled: true, reason: 'gen_disabled' };
  // }

  await ensureCollections();

  if (dishName) {
    const r = await genOne(dishName);
    return Object.assign({ ok: true }, r);
  }

  // 循环补齐：一次调用内翻页扫描所有缺 steps 的菜，直到补齐或逼近函数超时（留 15s 余量）。
  const MAX_MS = 105000;
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    const cond = { steps: _.exists(false) };
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
        const prof = (d.profile && typeof d.profile === 'object') ? d.profile : {};
        const steps = await genSteps(name, d.cuisine, d.mainIngredient, d.cookingMethod, d.ingredients, { profMain: prof.main || '', fixNotes: d.fixNotes ? String(d.fixNotes).trim() : '' });
        if (steps && steps.length >= 3) {
          // guide（详细做法）复用同一份步骤文本：拼成 "1. xxx 2. yyy" 字符串，与 env1「详细做法」同源
          const guide = steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + s.text).join(' ');
          await db.collection('dish_mirror').doc(d._id).update({
            data: { steps, guide, stepsUpdatedAt: Date.now(), guideUpdatedAt: Date.now() },
          });
          computed++;
          lastId = d._id;
          console.log('[bypassGenSteps] 生成成功 name=' + name + ' count=' + steps.length + ' guide=' + guide);
        } else {
          console.warn('[bypassGenSteps] 生成过少/空 name=' + name);
          await logTask('bypassGenSteps', null, 'fail', 'steps_too_few name=' + name);
        }
      } catch (e) {
        console.warn('[bypassGenSteps] 生成失败 name=' + name + '：', e && e.message);
        await logTask('bypassGenSteps', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e; // 限流类错误上抛，触发自适应降速
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
  // 2026-09-02：从 mirror 读食材/菜系等上下文传给 genSteps，AI 按食材生成步骤，保证步骤与食材匹配
  // 2026-09-05：增加读 mirror.fixNotes（修正要求）+ profile.main（画像主料），步骤须落实上轮问题并执行菜名核心主料
  let cuisine = '', mainIngredient = '', cookingMethod = '', ingredients = [], profMain = '', fixNotes = '';
  try {
    const r = await db.collection('dish_mirror').where({ name }).limit(1).get();
    const d = (r.data && r.data[0]) || null;
    if (d) {
      cuisine = d.cuisine || '';
      mainIngredient = d.mainIngredient || '';
      cookingMethod = d.cookingMethod || '';
      ingredients = Array.isArray(d.ingredients) ? d.ingredients : [];
      const prof = (d.profile && typeof d.profile === 'object') ? d.profile : {};
      profMain = prof.main || '';
      fixNotes = d.fixNotes ? String(d.fixNotes).trim() : '';
    }
  } catch (e) {}
  const steps = await genSteps(name, cuisine, mainIngredient, cookingMethod, ingredients, { profMain, fixNotes });
  if (!steps || steps.length < 3) return { skip: true, reason: 'steps 过少' };
  const guide = steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + s.text).join(' ');
  // 2026-09-02：单菜模式同时写回 mirror（清洗"步骤食材错误"重生成用）
  try {
    const r = await db.collection('dish_mirror').where({ name }).limit(1).get();
    const d = (r.data && r.data[0]) || null;
    if (d && d._id) {
      await db.collection('dish_mirror').doc(d._id).update({ data: { steps, guide, stepsUpdatedAt: Date.now() } });
    } else {
      await db.collection('dish_mirror').add({ data: { name, steps, guide, source: 'regen-steps', genAt: Date.now(), stepsUpdatedAt: Date.now() } });
    }
  } catch (e) { console.warn('[bypassGenSteps] genOne 写 mirror 失败 name=' + name + ' ' + (e && e.message)); }
  return { ok: true, steps, guide };
}

async function genSteps(name, cuisine, mainIngredient, cookingMethod, ingredients, ctx) {
  const hints = [];
  if (cuisine) hints.push('菜系：' + cuisine);
  if (mainIngredient) hints.push('主料：' + mainIngredient);
  else if (ctx && ctx.profMain) hints.push('主料：' + ctx.profMain);
  if (cookingMethod) hints.push('做法：' + cookingMethod);
  if (ingredients && Array.isArray(ingredients) && ingredients.length) {
    // 2026-09-16【P2】：原来只传食材**名称**，步骤于是凭感觉写用量 → 与清单用量不符（判定侧报"清单标注 X 克、
    //   步骤仅用 Y 克/超出"）。改为带上用量，步骤按清单量执行。
    hints.push('食材：' + ingredients.map(i => (i && i.name) ? String(i.name) + (i.amount ? ' ' + i.amount + (i.unit || '') : '') : '').filter(Boolean).join('、'));
  }
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';
  const c = ctx || {};
  const fixNotes = c.fixNotes ? String(c.fixNotes).slice(0, 900) : '';
  // 2026-09-05：放宽"只能使用列表食材"——菜名点名的核心主料（拌面的面条/米糊的主粮/滑肉的肉片）
  // 即使列表暂缺也必须在步骤中执行，对应食材由随后的食材修订补入，避免"菜名核心步骤缺失"死结。
  const constrainText = (Array.isArray(ingredients) && ingredients.length)
    ? '【食材使用】步骤优先使用上方"食材"列表里的食材（可搭配盐、糖、生抽、油、料酒等通用调料），列表中的主要食材都要在步骤中被实际使用；严禁自造与菜名无关的食材。'
      // 2026-09-16【P2】：用量必须与清单一致（原来无限定 → 步骤写 "两汤匙油" 而清单是 "10克" ⇒ 被判用量矛盾）
      + '【用量铁律】上方清单给出的是**本菜实际用量**（不是备料量）：清单给了明确量（如"番茄 200克"）的，步骤必须**用完这个量**（可写同量或"适量"），'
      + '**严禁超出清单量、严禁换用不同数字/单位、严禁出现"取一半/只用 X 克（少于清单）/剩余备用/留作他用"这类与清单量不符的表述**；清单写"适量/少许"的，步骤也不要给出具体数字。'
     // 2026-09-16【P3】：**数量词一律阿拉伯数字** —— 判定侧会抓"步骤里姜的用量写成「五十个」"（与清单 50克 不一致），
     //   中文数量词（五十/三百/十分钟/两瓣）既不一致也不便比对；统一成 50/300/10分钟/2瓣。
     + '**数字一律用阿拉伯数字**（写"50克/10分钟/2瓣/6成热"，**严禁**"五十克/十分钟/两瓣/六成热"）；模糊表述可保留（"六七成热""适量""少许"）。'
      + '**重要例外**：若菜名本身点名了某核心主料的操作（如「拌面」必须煮面条、过凉再拌；「米糊」必须把主粮打成米糊或熬煮成糊；「滑肉汤」必须把肉片裹淀粉滑煮；「丸子里」必须搓成丸子），即使该主料不在上方列表，也必须在步骤中完成这些核心操作——该主料随后会自动补入食材列表，不得因列表缺失而省略菜名核心步骤。'
    : '';
  const content = '菜品：' + name + hintStr + '\n\n请生成大概的烹饪步骤（4~7 步，每步一句话，按操作顺序排列），每步包含具体操作（如油温、火候、时间、用量等），口语化、可操作。\n'
    + constrainText
    + (fixNotes ? '\n\n【修正要求（上轮 AI 复核指出的问题，务必逐条落实，不得遗漏）】\n' + fixNotes : '')
    + '\n只返回 JSON 数组。';

  const messages = [
    {
      role: 'system',
      content: '你是家常菜谱助手。请针对菜品生成详细的烹饪步骤。【严格输出格式】只输出一个 JSON 数组，不要任何解释、不要加 markdown 代码围栏、不要加 ```json 标记，直接以 [ 开头、] 结尾。数组每个元素为对象：{"stepNo": 数字步号从1开始, "text": "该步具体操作描述"}。'
    },
    { role: 'user', content }
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
            console.warn('[bypassGenSteps] 黑名单命中 name=' + name + ' word=' + w);
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
        console.warn('[bypassGenSteps] 启发式兜底切分 name=' + name + ' count=' + cleaned.length + ' raw=' + text.slice(0, 200));
        await logTask('bypassGenSteps', null, 'warn', 'heuristic_fallback name=' + name + ' raw=' + text.slice(0, 200)).catch(() => {});
      }
      return cleaned;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else {
        console.warn('[genSteps] hy3 失败 name=' + name + '：', e && e.message);
        await logTask('bypassGenSteps', null, 'fail', 'steps_parse_failed name=' + name + ' raw=' + (e && e.message || '')).catch(() => {});
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