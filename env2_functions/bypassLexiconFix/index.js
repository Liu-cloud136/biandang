// ============================================================================
// bypassLexiconFix · env2 菜名规范化（阶段5，方案 §2 菜名规范化 / §7 阶段5）
// BUILD_TAG: 2026-08-22.bypass-lexiconfix-detach-env1
//
// 职责：
//   - 扫 env2 本地 dish_mirror 中可疑怪名（含英文字母/非中文符号/疑似味型冗余等），
//     hy3 规范化成正确中餐菜名 + 合法性判定；
//   - 合法且无重复 → 写本地 dish_lexicon_pending（source='env2-lexicon'）；
//   - 产物经 env2Console sync-to-env1 同步到 env1 审核池，管理员审核后入库。
//
// 纪律：
//   - hy3 直配 'hy3'（preview 8-31 下线）；并发 SLOT_N=6。
//   - 产物进审核池不直落正式库；失败静默记 bypass_log。
//   - env1 回写已删除（detach），不再跨账号调用。
// ============================================================================

const BUILD_TAG = '2026-08-22.bypass-lexiconfix-detach-env1';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';

const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();

const SLOT_N = 6;
const BATCH = 30;

// 疑似怪名硬规则（避免对正常菜名误判，只挑肉眼确实可疑的）
function looksSuspicious(name) {
  if (!name) return false;
  const n = String(name).trim();
  if (n.length > 12) return true;                       // 过长大概率拼接怪名
  if (/[a-zA-Z0-9]/.test(n)) return true;               // 含字母/数字
  if (/[^\u4e00-\u9fa5·、]/.test(n)) return true;       // 非中文（除中位点、顿号）
  return false;
}

function normName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

exports.main = async (event) => {
  console.log('[build] bypassLexiconFix BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'lexicon-fix', env: TCB_ENV };
  }

  await ensureCollections();

  // 单菜规范化（A 模式投递点可直接 event {dishName} 触发）
  if (dishName) {
    const r = await fixOne(dishName);
    return Object.assign({ ok: true }, r);
  }

  // 批量：扫本地 dish_mirror 疑似怪名
  const batchSize = Math.min(Number(limit) || BATCH, BATCH);
  const all = [];
  let q = db.collection('dish_mirror').orderBy('_id', 'asc').limit(batchSize);
  if (cursor && cursor.lastId) q = q.where({ _id: _.gt(cursor.lastId) });
  try {
    const res = await q.get();
    const data = res.data || [];
    for (const d of data) { if (looksSuspicious(d.name || d.dishName)) all.push(d); }
  } catch (e) { all.length = 0; }
  if (!all.length) return { ok: true, done: true, skipped: 0 };

  let fixed = 0, lastId = cursor && cursor.lastId;
  await pool(all, SLOT_N, async (d) => {
    const name = d.name || d.dishName;
    if (!name) return;
    try {
      const r = await fixOne(name);
      if (r && r.ok) { fixed++; lastId = d._id; }
    } catch (e) {
      console.warn('[bypassLexiconFix] 失败 name=' + name + '：', e && e.message);
      await logTask('bypassLexiconFix', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
    }
  });
  return { ok: true, fixed, hasMore: all.length === batchSize, lastId };
};

async function fixOne(name) {
  const raw = normName(name);
  if (!raw) return { skip: true, reason: '空菜名' };
  const norm = await aiNormalizeMesh(raw);
  if (!norm.normName) return { skip: true, reason: 'AI 无法规范' };
  if (!norm.legal) return { skip: true, reason: 'AI 判非合法: ' + norm.reason };
  // §10 产物体检：规范化结果与原文相同则无意义，跳过
  if (norm.normName === raw) return { skip: true, reason: '规范化结果与原文相同' };

  // 去重：库内/审核池已有该规范名则跳过
  const existing = new Set();
  try {
    const plib = await db.collection('dish_lexicon').where({ name: name }).limit(3).get();
    (plib.data || []).forEach(x => existing.add(normName(x.name)));
  } catch (e) { /* 库可能不存在 */ }
  try {
    const pp = await db.collection('dish_lexicon_pending').where({ name: norm.normName, source: 'env2-lexicon' }).limit(1).get();
    (pp.data || []).forEach(x => existing.add(normName(x.name)));
  } catch (e) { /* */ }
  if (existing.has(norm.normName)) return { skip: true, reason: '已存在同 normName=' + norm.normName };

  await writePending(raw, norm);
  return { ok: true, normName: norm.normName, reason: norm.reason };
}

async function aiNormalizeMesh(rawName) {
  const messages = [
    { role: 'system', content: '你是中餐菜名规范化助手。只输出 JSON，不要解释。' },
    {
      role: 'user',
      content:
        '给定一道 AI 味型前缀/疑怪菜名，请：\n' +
        '1) 规范成正确、真实存在的中餐菜名（剥掉冗余做法动词/介词如 蒸/炒/煮/拌/煎 等，保留「风味+食材」，如 蒜香拌韭菜→蒜香韭菜、奶香蒸南瓜→奶香南瓜）；\n' +
        '2) 判定规范后是否真实存在、适合收录（味+食材成立的家常搭配应 legal:true）。\n' +
        '原怪名：「' + rawName + '」\n' +
        '输出严格 JSON：{"normName":"规范化菜名（无法规范则空串）","legal":true|false,"reason":"一句话说明"}'
    }
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages,
        temperature: 0.2,
        maxTokens: 200,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) throw new Error('AI 非 JSON');
      const obj = jsonParseRepair(m[0]);
      if (!obj) throw new Error('JSON 解析失败');
      return { normName: normName(obj.normName), legal: obj.legal === true, reason: String(obj.reason || '').slice(0, 100) };
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[aiNormalizeMesh] hy3 失败 name=' + rawName + '：', e && e.message);
    }
  }
  return { normName: '', legal: false, reason: '' };
}

function pendingPayload(rawName, norm, extra) {
  return {
    name: norm.normName,
    cuisine: '家常',
    reason: 'env2 菜名规范化：原「' + rawName + '」→ ' + (norm.reason || ''),
    source: 'env2-lexicon',
    category: (extra && extra.category) || '',
    auto: true,
    rawName,
    explodeDir: 'env2菜名规范化',
    status: 'pending',
    ts: Date.now(),
    openid: ''
  };
}

async function hasPending(col, normName) {
  try {
    const ex = await col.where({ name: normName, source: 'env2-lexicon' }).limit(1).get();
    return !!(ex && ex.data && ex.data.length);
  } catch (e) { return false; }
}

async function writePending(rawName, norm) {
  try {
    const col = db.collection('dish_lexicon_pending');
    if (await hasPending(col, norm.normName)) return;
    await col.add({ data: pendingPayload(rawName, norm) });
  } catch (e) { /* 本地写入失败不影响 */ }
}

async function ensureCollections() {
  await Promise.allSettled([
    db.createCollection('dish_lexicon_pending'),
    db.createCollection('dish_lexicon'),
  ]);
}


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
    runners.push((async () => {
      while (idx < items.length) {
        const pos = idx++;
        await worker(items[pos], pos);
      }
    })());
  }
  await Promise.all(runners);
}