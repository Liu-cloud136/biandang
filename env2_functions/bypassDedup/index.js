// ============================================================================
// bypassDedup · env2 相似菜去重（§10 增强方向）
// BUILD_TAG: 2026-08-21.bypass-dedup-v1
//
// 职责：
//   - 扫 dish_mirror 缺 dedupChecked 的菜
//   - hy3 判断与库中其他菜是否同义/近似（同一道菜不同叫法）
//   - 重复菜标记 dish_mirror.isDuplicate=true, duplicateOf=原菜名（不删除，候选排序时降权）
//   - 并发 SLOT_N=6，失败静默记 bypass_log
// ============================================================================
const BUILD_TAG = '2026-08-21.bypass-dedup-v2';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();

const SLOT_N = 6;
const BATCH = 20;

// —— 菜名归一化（复用 manageShopping SYNONYMS，解决"不同名但同菜"去重缺口）——
const SYNONYMS = [
  [/番茄/g, '西红柿'],
  [/蕃茄/g, '西红柿'],
  [/马铃薯/g, '土豆'],
  [/洋芋/g, '土豆'],
  [/柿子椒/g, '青椒'],
  [/红萝卜/g, '胡萝卜'],
  [/胡罗卜/g, '胡萝卜'],
  [/大葱/g, '葱'],
  [/小葱/g, '葱'],
  [/香葱/g, '葱'],
  [/虾仁/g, '虾'],
  [/鸡蛋/g, '蛋']
];
function normalizeDishName(name) {
  let n = String(name || '');
  n = n.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
  n = n.replace(/\s+/g, '');
  for (const [re, rep] of SYNONYMS) n = n.replace(re, rep);
  return n;
}

exports.main = async (event) => {
  console.log('[build] bypassDedup BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'dedup', env: TCB_ENV };
  }

  // 全局生成开关：默认停用（GEN_DISABLED 未显式置 'false' 即停）
  if (process.env.GEN_DISABLED !== 'false') {
    console.log('[bypassDedup] GEN_DISABLED 已开启，跳过执行');
    return { ok: false, disabled: true, reason: 'gen_disabled' };
  }

  // 取库中所有菜名（用于比对）
  let allNames = [];
  try {
    const res = await db.collection('dish_mirror').field({ name: true }).limit(1000).get();
    allNames = (res.data || []).map(d => d.name || d.dishName).filter(Boolean);
  } catch (e) { return { ok: false, err: 'read_dish_mirror_failed' }; }

  // 扫缺 dedupChecked 的菜
  const batchSize = Math.min(Number(limit) || BATCH, BATCH);
  const baseCond = { dedupChecked: _.exists(false) };
  const cond = (cursor && cursor.lastId) ? _.and([baseCond, { _id: _.gt(cursor.lastId) }]) : baseCond;
  let list = [];
  try { const res = await db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize).get(); list = res.data || []; } catch (e) { list = []; }
  if (!list.length) return { ok: true, done: true, computed: 0 };

  let computed = 0, lastId = cursor && cursor.lastId;
  await pool(list, SLOT_N, async (d) => {
    const name = d.name || d.dishName;
    if (!name) return;
    try {
      const result = await checkDedup(name, allNames);
      await db.collection('dish_mirror').doc(d._id).update({
        data: { dedupChecked: true, isDuplicate: result.isDup, duplicateOf: result.similar || '', dedupUpdatedAt: Date.now() },
      });
      computed++;
      lastId = d._id;
      if (result.isDup) console.log('[bypassDedup] 重复菜 name=' + name + ' similar=' + result.similar);
    } catch (e) {
      console.warn('[bypassDedup] 失败 name=' + name + '：', e && e.message);
      await logTask('bypassDedup', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
    }
  });
  return { ok: true, computed, hasMore: list.length === batchSize, lastId };
};


// 2026-09-12：hy3 偶发吐畸形 JSON（实锤 "amount"::"3瓣" 双冒号，temp 0.3 下 100% 复现）
// 解析失败走三级修复梯（同 bypassConsistencyRepair v3-jsonfix / parseKit.repairJson）
function jsonParseRepair(s) {
  try { return JSON.parse(s); } catch (e) { /* 修复梯 */ }
  let r = String(s).replace(/,(s*[}]])/g, '$1');   // ① 收尾逗号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/"s*:s*:/g, '":');                 // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/""s*:s*"/g, '"');                 // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e) { return null; }
}
async function checkDedup(name, allNames) {
  const others = allNames.filter(n => n !== name);
  if (!others.length) return { isDup: false, similar: '' };

  // 第0层：别名归一化预检（番茄炒蛋≈西红柿炒蛋，快速零 AI 调用）
  const normName = normalizeDishName(name);
  for (const n of others) {
    if (normalizeDishName(n) === normName) {
      return { isDup: true, similar: n };
    }
  }

  // 第1层：快速字符串包含检查
  for (const n of others) {
    if (n.length >= 2 && name.length >= 2 && (n.includes(name) || name.includes(n))) {
      return { isDup: true, similar: n };
    }
  }

  // 第2层：hy3 语义相似度判定
  const prompt = [
    '你是菜名相似度判定器。给定一道菜名和菜库列表，判断是否有同义/近似菜（同一道菜的不同叫法/冗余前缀）。',
    '只输出 JSON：{"similar":"","isDup":false}',
    'similar=相似菜名（空串表示无重复），isDup=true 表示是重复菜。',
    '判定标准：蒜香韭菜≈蒜香拌韭菜（同菜）、番茄炒蛋≈西红柿炒蛋（同菜）；但 番茄炒蛋≠番茄炖牛腩（不同菜）。',
    '菜名：' + name,
    '菜库：' + others.slice(0, 80).join('、'),
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 128,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) throw new Error('非 JSON');
      const obj = jsonParseRepair(m[0]);
      if (!obj) throw new Error('JSON 解析失败');
      return { isDup: obj.isDup === true, similar: String(obj.similar || '').trim() };
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[checkDedup] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return { isDup: false, similar: '' };
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* */ }
}

async function pool(items, concurrency, worker) {
  let idx = 0;
  const runners = [];
  for (let i = 0; i < concurrency && i < items.length; i++) {
    runners.push((async () => { while (idx < items.length) { const pos = idx++; await worker(items[pos], pos); } })());
  }
  await Promise.all(runners);
}