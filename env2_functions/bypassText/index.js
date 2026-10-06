// ============================================================================
// bypassText · env2 AI 生成菜品点评/难度（阶段4，方案 §5 / §7 阶段4）
// BUILD_TAG: 2026-09-11.bypass-text-single-writeback
//
// 职责：
//   - 扫 env2 本地 dish_mirror 缺 review 的菜；
//   - hy3 生成 review（点评）+ difficulty（难度）；
//   - 写 env2 本地 dish_mirror.review / difficulty。
//
// 说明：
//   tips（小贴士）已拆到独立函数 bypassGenTips，避免一锅出互相拖累。
//   guide（详细做法）由 bypassGenSteps 主链生成（步骤文本落 guide 与 steps），
//   本函数不再生成 guide，避免重复调用与字段冲突。
//
// 纪律：
//   - 与 bypassAiEnrich/bypassGenImage/bypassGenIngredients/bypassGenSteps/bypassGenTips 并行执行；
//   - hy3 直配 'hy3'；并发 SLOT_N=5；
//   - 内容自检：review 非空才收，BAD_WORDS 黑名单命中则丢弃；
//   - 失败静默记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-09-11.bypass-text-single-writeback';
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
  console.log('[build] bypassText BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'text', env: TCB_ENV };
  }

  // 全局生成开关：默认停用（GEN_DISABLED 未显式置 'false' 即停），彻底停止生成/补齐
  if (process.env.GEN_DISABLED !== 'false') {
    console.log('[bypassText] GEN_DISABLED 已开启，跳过执行');
    return { ok: false, disabled: true, reason: 'gen_disabled' };
  }

  await ensureCollections();

  if (dishName) {
    const r = await genOne(dishName);
    return Object.assign({ ok: true }, r);
  }

  // 循环补齐：一次调用内翻页扫描所有缺 review 的菜，直到补齐或逼近函数超时（留 15s 余量）。
  const MAX_MS = 105000;
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    const cond = { review: _.exists(false) };
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
        const result = await genReview(name, d.cuisine, d.mainIngredient, d.cookingMethod);
        if (result && result.review && result.review.length >= 2) {
          await db.collection('dish_mirror').doc(d._id).update({
            data: {
              review: result.review,
              difficulty: result.difficulty || '',
              guideUpdatedAt: Date.now(),
            },
          });
          computed++;
          lastId = d._id;
          console.log('[bypassText] 生成成功 name=' + name + ' review=' + result.review);
        } else {
          console.warn('[bypassText] 生成失败 name=' + name);
          await logTask('bypassText', null, 'fail', 'review_empty name=' + name);
        }
      } catch (e) {
        console.warn('[bypassText] 生成失败 name=' + name + '：', e && e.message);
        await logTask('bypassText', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
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
  const result = await genReview(name);
  if (!result || !result.review) return { skip: true, reason: 'review 为空' };
  // 2026-09-11 修：单菜模式必须写回 mirror（与 bypassGenSteps / bypassGenIngredients 保持一致）。
  // 原先只 return、不落库 → review-web 的 regenDimOnMirror 假定"生成器自己写 mirror"、丢弃返回值，
  // 于是 review 维的返工是**空转**：approve 时把 syncBaseToMirror 复制过来的旧值原样写回 env1，
  // 七件套 review 维永远缺、每 6h 反复入队（黑椒猪里脊 dish_review={review:"",difficulty:""} 即此因）。
  try {
    const q = await db.collection('dish_mirror').where({ name }).limit(1).get();
    const doc = (q.data || [])[0];
    const patch = { review: result.review, difficulty: result.difficulty || '', ts: Date.now() };
    if (doc && doc._id) await db.collection('dish_mirror').doc(doc._id).update({ data: patch });
    else await db.collection('dish_mirror').doc(name).update({ data: patch });
    console.log('[bypassText] 单菜写回 mirror name=' + name + ' review=' + result.review);
  } catch (e) {
    console.warn('[bypassText] 单菜写回 mirror 失败 name=' + name + '：' + ((e && e.message) || e));
  }
  return { ok: true, ...result };
}

async function genReview(name, cuisine, mainIngredient, cookingMethod) {
  const hints = [];
  if (cuisine) hints.push('菜系：' + cuisine);
  if (mainIngredient) hints.push('主料：' + mainIngredient);
  if (cookingMethod) hints.push('做法：' + cookingMethod);
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';

  const messages = [
    {
      role: 'system',
      content: '你是菜品点评助手。只输出 JSON，不要任何解释。格式：{"review":"点评","difficulty":"简单"}'
    },
    {
      role: 'user',
      content: '菜品：' + name + hintStr + '\n\n请给出：\n1. review：4-12 字文言文或半文半白点评，点明口感风味（如"咸鲜下饭，软糯鲜香"、"酸甜适口，开胃"）\n2. difficulty：难度，只取"简单"/"中等"/"较难"三者之一'
    }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages,
        temperature: 0.6,
        maxTokens: 200,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const obj = parseJsonObject(text);
      if (!obj || !obj.review) throw new Error('空 review');
      for (const w of BAD_WORDS) {
        if (String(obj.review).includes(w)) {
          console.warn('[bypassText] 黑名单命中 name=' + name + ' word=' + w);
          return null;
        }
      }
      let difficulty = String(obj.difficulty || '').trim();
      if (difficulty && !['简单', '中等', '较难'].includes(difficulty)) {
        if (/难|复杂|高/.test(difficulty)) difficulty = '较难';
        else if (/中|一般/.test(difficulty)) difficulty = '中等';
        else if (/易|简/.test(difficulty)) difficulty = '简单';
        else difficulty = '';
      }
      return {
        review: String(obj.review).trim().slice(0, 20),
        difficulty,
      };
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genReview] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}

function parseJsonObject(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (e2) { /* 走修复梯 */ }
  // 2026-09-12 三级修复梯（hy3 glitch 实锤："amount"::"3瓣" 双冒号 100% 复现，同 v3-jsonfix）
  let r = t.replace(/,(\s*[}\]])/g, '$1');            // ① 收尾逗号
  try { return JSON.parse(r); } catch (e2) { /* 下一级 */ }
  r = r.replace(/"\s*:\s*:/g, '":');                  // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e2) { /* 下一级 */ }
  r = r.replace(/""\s*:\s*"/g, '"');                  // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e2) { return null; }
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
