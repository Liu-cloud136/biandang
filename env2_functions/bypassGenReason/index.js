// ============================================================================
// bypassGenReason · env2 AI 生成推荐语（2026-08-29 cookbook 补库专用）
// BUILD_TAG: 2026-08-29.bypass-gen-reason-v1
//
// 职责：扫 dish_mirror 中 source='cookbook' 且缺 reason 的菜，hy3 逐道生成推荐语
//      （4-12 字，半文半白，点明风味口感），写回 dish_mirror.reason。
//      （mirror 审核入库时经 dish_recommend 分表，供查表推荐完整句口径使用。）
// 纪律：与 bypassText 的 review 并行不冲突（review 入 dish_review，reason 入 dish_recommend）；
//      自限 170s/轮；无任务即快速退出；失败静默记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-09-01.bypass-gen-reason-env1backfill';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const app = tcbInit();
function tcbInit() {
  const tcb = require('@cloudbase/node-sdk');
  return tcb.init({ env: process.env.TCB_ENV || 'your-env-id-2', timeout: 60000 });
}
const ai = app.ai();

const SLOT_N = 6;
const BATCH = 40;
const MAX_MS = 170000;
const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '抽烟', '饮酒', 'hei'];
const { RateLimiter } = require('./rateLimiter');
// 自适应速率控制器（文）：初始 4、上限 8、60s 窗硬上限 160、429 退避 2/4/8s
const limiter = new RateLimiter({ rateInit: 4, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 160, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassGenReason BUILD_TAG=' + BUILD_TAG);
  const { task, dishName } = event || {};
  if (task === 'health') return { ok: true, build: BUILD_TAG, mode: 'gen-reason', env: process.env.TCB_ENV };

  if (dishName) {
    const r = await genReason(dishName, '', '', '');
    return r ? { ok: true, dishName, reason: r } : { ok: false, dishName };
  }

  const startedAt = Date.now();
  let totalComputed = 0, rounds = 0, lastId = '';

  while (true) {
    const cond = { source: _.in(['cookbook', 'env1-backfill']), reason: _.or(_.exists(false), _.eq('')) };
    if (lastId) cond._id = _.gt(lastId);
    let list = [];
    try { const res = await db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(BATCH).get(); list = res.data || []; } catch (e) { break; }
    if (!list.length) break;

    let computed = 0;
    await pool(list, SLOT_N, async (d) => {
      const name = d.name || d.dishName;
      if (!name) return;
      for (const w of BAD_WORDS) { if (name.includes(w)) return; }
      try {
        const reason = await genReason(name, d.category, d.mainIngredient, d.cookingMethod);
        if (reason) {
          await db.collection('dish_mirror').doc(d._id).update({ data: { reason, reasonUpdatedAt: Date.now() } });
          computed++;
          lastId = d._id;
          console.log('[bypassGenReason] 生成成功 name=' + name + ' reason=' + reason);
        } else {
          await logTask('bypassGenReason', 'fail', 'reason_empty name=' + name).catch(() => {});
        }
      } catch (e) {
        await logTask('bypassGenReason', 'fail', 'dish [' + name + '] ' + (e && e.message)).catch(() => {});
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e;
      }
    }, limiter);

    totalComputed += computed;
    rounds++;
    if (Date.now() - startedAt > MAX_MS || list.length < BATCH) break;
  }

  await logTask('rateLimiter', 'info', limiter.monitorMsg()).catch(() => {});
  return { ok: true, computed: totalComputed, rounds };
};

async function genReason(name, category, mainIngredient, cookingMethod) {
  const hints = [];
  if (category) hints.push('类别：' + category);
  if (mainIngredient) hints.push('主料：' + mainIngredient);
  if (cookingMethod) hints.push('做法：' + cookingMethod);
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';

  const messages = [
    { role: 'system', content: '你是菜品推荐语助手。只输出 JSON，不要任何解释。格式：{"reason":"推荐语"}' },
    { role: 'user', content: '菜品：' + name + hintStr + '\n\n请给一句推荐语，格式硬性要求：\n1. 恰好 4 个汉字，文言文（如"咸鲜下饭"、"浓香入味"、"原汁原味"、"酸辣开胃"、"清鲜爽口"、"焦香四溢"、"软糯入味"、"醇香浓厚"）\n2. 要贴合主料与做法的具体风味特征（如金针菇→"脆爽滑嫩"、五花肉→"肥而不腻"、蒜蓉→"蒜香扑鼻"），不要套用万能词\n3. 严禁 3 字或 5 字、严禁白话、严禁出现菜名本身、严禁带标点\n4. 同段语义不重复（不要"鲜香鲜嫩"这类同字堆叠）' }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.7, maxTokens: 100 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      if (!text) console.warn('[genReason] hy3 原始返回为空 resp=' + JSON.stringify(resp).slice(0, 300));
      // 兼容两种形态：① JSON（{"reason":".."}）② 纯文本直接给 4 字（hy3 对超短输出任务常不包 JSON，22:34 实测全挂原因）
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

function parseJsonObject(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (e2) { /* 走修复梯 */ }
  // 2026-09-12 三级修复梯（hy3 glitch 实锤："amount"::"3瓣" 双冒号 100% 复现）
  let r = t.replace(/,(s*[}]])/g, '$1');            // ① 收尾逗号
  try { return JSON.parse(r); } catch (e2) { /* 下一级 */ }
  r = r.replace(/"s*:s*:/g, '":');                  // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e2) { /* 下一级 */ }
  r = r.replace(/""s*:s*"/g, '"');                  // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e2) { return null; }
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({ data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() } });
  } catch (e) {}
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
