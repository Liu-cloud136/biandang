// ============================================================================
// bypassGenTips · env2 AI 生成菜品小贴士（阶段4，方案 §5 / §7 阶段4）
// BUILD_TAG: 2026-09-16b.bypass-gen-tips-steplocked
//
// 职责：
//   - 扫 env2 本地 dish_mirror 缺 tips 的菜；
//   - hy3 生成 tips（小贴士）；
//   - 写 env2 本地 dish_mirror.tips。
//
// 说明：
//   tips 从 bypassText（原 review+难度+tips 一锅出）拆出独立函数，
//   避免任一字段生成失败互相拖累，且单字段调用更快、更不易超时截断。
//
// 纪律：
//   - 与 bypassAiEnrich/bypassGenImage/bypassGenIngredients/bypassGenSteps/bypassText 并行；
//   - hy3 直配 'hy3'；并发 SLOT_N=8；
//   - 内容自检：tips 非空才收，BAD_WORDS 黑名单命中则丢弃；
//   - 失败静默记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-09-16b.bypass-gen-tips-steplocked';
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
// 自适应速率控制器（文）：初始 5、上限 8、60s 窗硬上限 200、429 退避 2/4/8s
const limiter = new RateLimiter({ rateInit: 5, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 200, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassGenTips BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'tips', env: TCB_ENV };
  }

  await ensureCollections();

  if (dishName) {
    const r = await genOne(dishName);
    return Object.assign({ ok: true }, r);
  }

  // 循环补齐：一次调用内翻页扫描所有缺 tips 的菜，直到补齐或逼近函数超时（留 15s 余量）。
  // 这样 bypassGenDish 入库新菜后触发一次，就能把之前积压的缺字段菜一并补上，而不是堆到下轮 timer。
  const MAX_MS = 105000; // 120s 超时内留出余量
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    const cond = { tips: _.exists(false) };
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
        // 2026-09-16【P1】注入步骤 + 食材清单：贴士与步骤冲突（"要求焯水/冷藏但步骤没有"、"火候时间对不上"）的
        // 根因就是原来完全没给模型看步骤。
        const stepsText = Array.isArray(d.steps) ? d.steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + String((s && s.text) || '')).join(' ') : '';
        const ingText = Array.isArray(d.ingredients) ? d.ingredients.map(i => (i && i.name) ? String(i.name) + (i.amount ? ' ' + i.amount + (i.unit || '') : '') : '').filter(Boolean).join('、') : '';
        const tips = await genTips(name, d.cuisine, d.mainIngredient, d.cookingMethod, stepsText, ingText);
        if (tips && tips.length >= 6) {
          await db.collection('dish_mirror').doc(d._id).update({
            data: { tips, tipsUpdatedAt: Date.now() },
          });
          computed++;
          lastId = d._id;
          console.log('[bypassGenTips] 生成成功 name=' + name + ' tips=' + tips);
        } else {
          console.warn('[bypassGenTips] 生成过少/空 name=' + name);
          await logTask('bypassGenTips', null, 'fail', 'tips_too_few name=' + name);
        }
      } catch (e) {
        console.warn('[bypassGenTips] 生成失败 name=' + name + '：', e && e.message);
        await logTask('bypassGenTips', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e; // 限流类错误上抛，触发自适应降速
      }
    }, limiter);

    totalComputed += computed;
    rounds++;
    // 时间到或本批不足 BATCH（说明已到末尾）则停止
    if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
  }

  await logTask('rateLimiter', null, 'info', limiter.monitorMsg()).catch(() => {});
  return { ok: true, computed: totalComputed, rounds, hasMore: false, lastId };
};

async function genOne(name) {
  if (!name) return { skip: true, reason: '空菜名' };
  // 2026-09-16【P1】：单菜模式原来只传菜名 → 贴士凭空生成、与步骤冲突。改为先读 mirror 拿步骤/食材再生成。
  let cuisine = '', mainIngredient = '', stepsText = '', ingText = '';
  try {
    const q = await db.collection('dish_mirror').where({ name }).limit(1).get();
    const d = (q.data || [])[0] || null;
    if (d) {
      cuisine = d.cuisine || '';
      mainIngredient = d.mainIngredient || '';
      stepsText = Array.isArray(d.steps) ? d.steps.map(s => (s.stepNo ? s.stepNo + '. ' : '') + String((s && s.text) || '')).join(' ') : '';
      ingText = Array.isArray(d.ingredients) ? d.ingredients.map(i => (i && i.name) ? String(i.name) + (i.amount ? ' ' + i.amount + (i.unit || '') : '') : '').filter(Boolean).join('、') : '';
    }
  } catch (e) {}
  const tips = await genTips(name, cuisine, mainIngredient, '', stepsText, ingText);
  if (!tips || tips.length < 6) return { skip: true, reason: 'tips 过少' };
  // 2026-09-11 修：同 bypassText —— 单菜模式须写回 mirror，否则 tips 维返工空转
  //（review-web 的 regenDimOnMirror 丢弃返回值，approve 时把旧 tips 原样写回 env1）。
  try {
    const q = await db.collection('dish_mirror').where({ name }).limit(1).get();
    const doc = (q.data || [])[0];
    const patch = { tips, ts: Date.now() };
    if (doc && doc._id) await db.collection('dish_mirror').doc(doc._id).update({ data: patch });
    else await db.collection('dish_mirror').doc(name).update({ data: patch });
    console.log('[bypassGenTips] 单菜写回 mirror name=' + name);
  } catch (e) {
    console.warn('[bypassGenTips] 单菜写回 mirror 失败 name=' + name + '：' + ((e && e.message) || e));
  }
  return { ok: true, tips };
}

async function genTips(name, cuisine, mainIngredient, cookingMethod, stepsText, ingText) {
  const hints = [];
  if (cuisine) hints.push('菜系：' + cuisine);
  if (mainIngredient) hints.push('主料：' + mainIngredient);
  if (cookingMethod) hints.push('做法：' + cookingMethod);
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';
  // 2026-09-16【P1】：把该菜的**实际步骤与食材清单**喂进来，贴士只能在其基础上补充，不得凭空要求别的操作。
  const ctxText = (stepsText || ingText)
    ? '\n\n【该菜的实际做法（贴士必须与此一致）】\n'
      + (ingText ? '食材：' + String(ingText).slice(0, 400) + '\n' : '')
      + (stepsText ? '步骤：' + String(stepsText).slice(0, 900) : '')
    : '';
  const ruleText = stepsText
    ? '\n\n【硬约束（违反会被判定为矛盾并打回）】'
      // 2026-09-16 强化：实测贴士仍是最大类矛盾（"贴士要求焯水但步骤没焯"）。硬性要求建议必须落在步骤已有动作上。
      + '① 贴士的**主体建议必须落在步骤里已经出现的操作上**（步骤焯了就讲焯水要点，步骤炒了就讲油温/下锅时机）；'
      + '② **不得把步骤里没有的动作写成要求**（如步骤没焯水就不要写"先焯水"）——若确有经验要补充，只能写成**条件式**："若…可…"（如"若时间充裕，可先焯水去腥"），不得写成必须动作；'
      + '③ 火候（小火/中火/大火）、时间（X 分钟）、下料时机必须与步骤完全一致，不得给出不同数字；'
      + '④ 不得与步骤相反（步骤是炒就不能说"应当炖"）。'
    : '';

  const messages = [
    {
      role: 'system',
      content: '你是家常菜烹饪助手。只输出纯文本，不要任何 JSON、解释或标点包裹。'
    },
    {
      role: 'user',
      content: '菜品：' + name + hintStr + ctxText + '\n\n请给出一条最实用的家常小贴士，20-40 字，聚焦火候/去腥/入味/防粘锅等关键要点。' + ruleText + '只回贴文本本身。'
    }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages,
        temperature: 0.6,
        maxTokens: 120,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      let tips = String(text).trim().replace(/^["'「]|["'」]$/g, '').trim();
      if (!tips) throw new Error('空 tips');
      for (const w of BAD_WORDS) {
        if (tips.includes(w)) {
          console.warn('[bypassGenTips] 黑名单命中 name=' + name + ' word=' + w);
          return null;
        }
      }
      if (tips.length < 6) throw new Error('tips 过短');
      return tips.slice(0, 60);
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genTips] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
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
