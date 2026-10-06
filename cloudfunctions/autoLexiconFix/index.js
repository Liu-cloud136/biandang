// autoLexiconFix —— 出文后处理剔除怪名的「异步 AI 规范化 + 合法性判定」轻函数
//
// 触发：getRecommendation 后处理命中 ③-b（风味前缀）/ ③-e（味型+做法动词冗余）时，
//        fire-and-forget 调本函数（不阻塞主出文链路）。
// 职责：把被剔除的怪名（如「黑椒炒牛里脊」「奶香蒸南瓜」）交给 AI 规范化成正确菜名，
//        并判定其是否真实合法；合法则写入探索审核池 dish_lexicon_pending（source:'auto-fix'），
//        供管理员在 manageLexicon 审核入正式菜库 dish_lexicon 复用。
//
// 设计铁律：
//   1) 绝不阻塞主出文；本函数任何异常只记日志，不影响用户。
//   2) AI 调用服从限流：走 genTextWithFallback（封装 callUnifiedText），preview 优先、超时降级 hy3。
//   3) 只进审核池、不直落正式库；合法性由 AI 判定 + 规则兜底 + 人工终审三重把关，宁可漏补不可错补。
//
// 模型路由（函数内重试，不跨函数）：
//   primary:'hy3' → 仅 hy3 单一通道（hy3-preview 已于 2026-08-31 下线移除）。
//   网关 callUnifiedText 按 mode 编排 hy3 → 自定义 → [SF] 降级链。

const tcb = require('@cloudbase/node-sdk');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const aiGateway = require('./utils/aiGateway');

const BUILD_TAG = '2026-08-27.env1-hy3-preview-removed';
console.log('[build] autoLexiconFix BUILD_TAG=' + BUILD_TAG);

const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');


const TEXT_MODEL = 'hy3';
const TXT_GEN_TIMEOUT_MS = 15000;   // 单个文本生成上限，超时即释放并降级
const TTL_SKIP_FAILED_MS = 7 * 24 * 60 * 60 * 1000; // skip/failed 7 天 TTL

// 命名轻量归一（与 manageLexicon.normLexName 一致）
function normName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function pickText(resp) {
  if (resp && typeof resp.text === 'string' && resp.text.trim()) return resp.text;
  if (resp && resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && typeof resp.data.choices[0].message.content === 'string') {
    return resp.data.choices[0].message.content;
  }
  return '';
}

function withTimeout(p, ms, label) {
  let timer;
  const to = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error((label || 'op') + ' timeout ' + ms + 'ms')), ms); });
  return Promise.race([p, to]).finally(() => { if (timer) clearTimeout(timer); });
}

// ── 文本生成（preview 优先 → 降级 hy3），对齐 genTextWithFallback 行为但 primary=preview ──
async function genTextWithFallback(messages, opts) {
  const temperature = (opts && opts.temperature != null) ? opts.temperature : 0.3; // 规范化任务要稳，低温
  const topP = (opts && opts.topP != null) ? opts.topP : 0.9;
  const maxTokens = (opts && opts.maxTokens != null) ? opts.maxTokens : 300;
  const label = (opts && opts.label) || 'lexicon-fix';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const callHy3 = async () => textModel.generateText({ model: TEXT_MODEL, messages, temperature, topP, maxTokens });
  const calls = { callHy3 };
  const gwOpts = { temperature, topP, primary: 'hy3', maxTokens, label, enableSF: false };
  return await aiGateway.callUnifiedText(messages, gwOpts, calls, db);
}

// ── 黑名单词表（运行时加载，复用 name_blocklist 规则兜底）──
let BL_CACHE = null;
const BL_CACHE_TTL = 60 * 1000;
async function loadBlocklist() {
  const now = Date.now();
  if (BL_CACHE && now - BL_CACHE.t < BL_CACHE_TTL) return BL_CACHE.set;
  try {
    const d = await db.collection('name_blocklist').doc('main').get();
    const arr = (d && d.data && Array.isArray(d.data.words)) ? d.data.words : [];
    BL_CACHE = { set: new Set(arr), t: now };
    return BL_CACHE.set;
  } catch (e) {
    BL_CACHE = { set: new Set(), t: now };
    return BL_CACHE.set;
  }
}
function hitsBlocklist(name) {
  if (!BL_CACHE || !BL_CACHE.set) return false;
  const n = normName(name);
  for (const w of BL_CACHE.set) {
    if (n.includes(String(w))) return true;
  }
  return false;
}

// ── AI 规范化 + 合法性判定 ──
// 返回 { normName, legal, reason } 或抛错
async function aiNormalize(rawName, category) {
  const sysHint = category === 'flavorVerb'
    ? '该类怪名是「味型+做法动词冗余」（如 黑椒炒牛里脊→黑椒牛里脊，黑椒煎鸡腿→黑椒鸡腿），去掉冗余做法动词保留「味型+食材」。'
    : '该类怪名是「风味前缀怪名」（如 蒜香拌韭菜→蒜香韭菜，孜然炒羊肉→孜然羊肉，奶香蒸南瓜→奶香南瓜），剥掉冗余做法动词/介词（蒸/炒/煮/拌/煎等）保留「风味+食材」。「风味+食材」通常为合法家常菜（如奶香南瓜、蒜香茄子、孜然羊肉），应判 legal:true 入审核池。仅当风味+食材本身不成立（如奶香蒸石头、咖喱炖水泥）才判 legal:false。';

  const messages = [
    { role: 'system', content: '你是中餐菜名规范化助手。只输出 JSON，不要解释。' },
    {
      role: 'user',
      content:
        '给定一道被后处理判定为「命名不规范」的 AI 生成菜名，请：\n' +
        '1) 规范成正确、真实存在的中餐菜名（若原名为「味型+做法动词冗余」则去掉冗余做法动词；若为「风味前缀怪名」则剥冗余做法动词/介词，保留「风味+食材」，风味+食材组合成立即视为合法家常菜）；\n' +
        '2) 判定规范后的菜名是否真实存在、是否适合收录进菜谱库（风味+食材成立的家常搭配都应 legal:true）。\n' +
        sysHint + '\n' +
        '原怪名：「' + rawName + '」\n' +
        '输出严格 JSON：{"normName":"规范化后的菜名（若无法规范为真实菜名则填空字符串）","legal":true|false,"reason":"一句话说明"}'
    }
  ];

  const r = await genTextWithFallback(messages, { temperature: 0.2, maxTokens: 200, label: 'lexicon-norm' });
  const text = pickText(r);
  if (!text) throw new Error('AI 返回空');
  // 抽取首个 JSON 对象
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 返回非 JSON: ' + text.slice(0, 120));
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { throw new Error('AI JSON 解析失败: ' + text.slice(0, 120)); }
  const normNameOut = normName(obj.normName);
  const legal = obj.legal === true;
  return { normName: normNameOut, legal, reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 100) : '' };
}

// ── 中转集合（审计 + 可重试）──
async function ensureCollections() {
  await Promise.allSettled([
    db.createCollection('lexicon_auto_pending'),
    db.createCollection('dish_lexicon_pending'),
    db.createCollection('dish_lexicon')
  ]);
}

// 轻量自清理：TTL 索引无法经 SDK/MCP 自动建，改为每次调用顺带清理一次过期的 skip/failed
// （expireAt 由 setPendingStatus 写入，到期即删除，防 lexicon_auto_pending 堆积）
async function cleanExpired() {
  try {
    const now = Date.now();
    const res = await db.collection('lexicon_auto_pending')
      .where({ expireAt: db.command.lt(now) })
      .get();
    if (res && res.data && res.data.length) {
      await Promise.allSettled(
        res.data.map(d => db.collection('lexicon_auto_pending').doc(d._id).remove().catch(() => {}))
      );
    }
  } catch (e) { /* 清理失败不影响主流程 */ }
}

async function setPendingStatus(id, status, extra) {
  if (!id) return;
  const data = Object.assign({ status, processedAt: Date.now() }, extra || {});
  if (status === 'skip' || status === 'failed') {
    // 7 天 TTL（需控制台为 lexicon_auto_pending.expireAt 建 TTL 索引）
    data.expireAt = new Date(Date.now() + TTL_SKIP_FAILED_MS);
  }
  await db.collection('lexicon_auto_pending').doc(id).update({ data }).catch(() => {});
}

// ── 主流程 ──
async function processOne(rawName, category, scene) {
  const nRaw = normName(rawName);
  if (!nRaw) return { skip: true, reason: '空怪名' };

  await ensureCollections();
  await cleanExpired();

  // 中转记录（审计 + 防重复调 AI）
  let pendingId = null;
  try {
    const dupPending = await db.collection('lexicon_auto_pending')
      .where({ rawName: nRaw, status: 'done' }).limit(1).get();
    if (dupPending && Array.isArray(dupPending.data) && dupPending.data.length) {
      return { skip: true, reason: '已有 done 中转记录，跳过' };
    }
    const addRes = await db.collection('lexicon_auto_pending').add({
      data: { rawName: nRaw, kind: 'dish', category: category || '', scene: scene || '', status: 'pending', createdAt: Date.now() }
    });
    pendingId = addRes && addRes._id;
  } catch (e) {
    console.warn('[autoLexiconFix] 写中转记录失败（继续处理）: ' + ((e && e.message) || e));
  }

  try {
    // 去重：库内/审核池已有同名规范结果则跳过
    const dupLib = await db.collection('dish_lexicon').where({ valid: true }).limit(1000).get();
    const dupPendingPool = await db.collection('dish_lexicon_pending')
      .where({ status: 'pending' }).limit(1000).get();
    const existing = new Set();
    (dupLib.data || []).forEach(x => { if (x.name) existing.add(normName(x.name)); });
    (dupPendingPool.data || []).forEach(x => { if (x.name) existing.add(normName(x.name)); });

    // —— env1 本地 AI 规范化（原有逻辑）——
    const ai = await aiNormalize(nRaw, category);

    // 规则兜底：规范后仍为空 / 命中黑名单 / 判为非合法 → skip
    if (!ai.normName) {
      await setPendingStatus(pendingId, 'skip', { reason: 'AI 无法规范为真实菜名' });
      return { skip: true, reason: '无法规范' };
    }
    if (existing.has(ai.normName)) {
      await setPendingStatus(pendingId, 'skip', { normName: ai.normName, legal: ai.legal, reason: '库内已存在同名(' + ai.normName + ')' });
      return { skip: true, reason: '库内已存在' };
    }
    if (hitsBlocklist(ai.normName)) {
      await setPendingStatus(pendingId, 'skip', { normName: ai.normName, legal: false, reason: '规范后仍命中黑名单' });
      return { skip: true, reason: '命中黑名单' };
    }
    // 注意：AI 判 legal=false 时，即便规则没拦也 skip（AI 不可全信，但 legal=false 明确不应进库）
    if (!ai.legal) {
      await setPendingStatus(pendingId, 'skip', { normName: ai.normName, legal: false, reason: 'AI 判非合法: ' + ai.reason });
      return { skip: true, reason: 'AI 判非合法' };
    }

    // 合法 → 写审核池（source:'auto-fix' 供 manageLexicon 透传、管理员区分机器建议）
    await db.collection('dish_lexicon_pending').add({
      data: {
        name: ai.normName,
        cuisine: '家常',
        reason: '机器自动规范化（' + (category === 'flavorVerb' ? '味型+做法动词冗余' : '风味前缀怪名') + '）：原「' + nRaw + '」→ ' + ai.reason,
        source: 'auto-fix',
        category: category || '',
        auto: true,
        rawName: nRaw,
        exploreDir: '',
        status: 'pending',
        ts: Date.now(),
        openid: ''
      }
    });
    await setPendingStatus(pendingId, 'done', { normName: ai.normName, legal: true, reason: ai.reason });
    return { ok: true, normName: ai.normName };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await setPendingStatus(pendingId, 'failed', { errMsg: msg.slice(0, 200) });
    throw e; // 由外层捕获记日志
  }
}

exports.main = async (event) => {
  console.log('[build] autoLexiconFix BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const rawName = (event && event.rawName) || '';
  const category = (event && event.category) || '';
  const scene = (event && event.scene) || '';
  if (!rawName) return { ok: false, err: '缺少 rawName' };
  try {
    const res = await processOne(rawName, category, scene);
    return Object.assign({ ok: true }, res);
  } catch (e) {
    console.error('[autoLexiconFix] 处理失败: ' + ((e && e.message) || e));
    return { ok: false, err: (e && e.message) || String(e) };
  }
};
