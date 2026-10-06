const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ════════════════════════════════════════════════════════════════════════
// 方案B · 协同过滤（Item-based CF）离线模型 —— 影子模式（2026-08-07）
// ────────────────────────────────────────────────────────────────────────
// 【为什么是"影子模式"】协同过滤靠的是"用户之间行为交叉"。当前生产用户量/记录量很小，
//   直接生效必失真（两个用户恰好都点过番茄炒蛋就判"口味像"→ 过拟合乱推）。
//   所以本函数：① 照常离线计算 CF 模型并落库；② 同时产出"数据就绪信号"；
//   ③ 是否让 getRecommendation 真正使用，由 sys_config.cf_enabled 开关 + 就绪阈值共同决定，
//      默认关闭。等数据达标（活跃用户数、有效共现对数够）后再打开，避免小样本失真。
//
// 【选 Item-based 而非 User-based】物品数（数百）远小于用户数增长，物品相似更稳定、
//   冷启动更友好、可解释（"你选过A，很多人选A也选B → 推B"）。且物品向量可复用方案A聚类。
//
// 【算法】
//   1. 扫全量 recommend_history + gen_records，按用户(_openid)聚合其历史选过的菜集合。
//   2. 对每个用户的菜集合，两两生成共现（co-occurrence）计数 co[A][B]++。
//   3. 物品相似 sim(A,B) = co[A][B] / sqrt(freq[A]*freq[B])（余弦式，抑制热门物品霸榜）。
//   4. 每个物品取 topK 相似物品，写 cf_model 集合（_id=物品名，data.sim=[{name,score}]）。
//   5. 就绪信号：活跃用户数 users、有效共现对数 pairs（co>=MIN_CO 的对数），写 sys_config.cf_ready。
//
// 触发：手动 invoke（或接定时器周期跑）。数据量大时分页 limit 1000。
// ════════════════════════════════════════════════════════════════════════

const TOP_K = 20;            // 每个物品保留的相似物品数
const MIN_CO = 2;            // 共现次数下限：<2 的对视为偶然噪声，不计入模型/就绪信号
const MIN_USER_ITEMS = 2;    // 用户至少选过 2 道不同菜才有共现价值
// 就绪阈值（getRecommendation 侧会再校验一次，双保险）：
const READY_MIN_USERS = 200;   // 活跃用户数门槛
const READY_MIN_PAIRS = 800;   // 有效共现对数门槛

// 提取一条记录的 _openid 与菜名集合（与 computeBaseline / getWeightOverview 同源口径）
function extractNames(doc) {
  const out = [];
  if (doc && Array.isArray(doc.selected) && doc.selected.length) {
    doc.selected.forEach(it => { const n = it && it.name; if (n && typeof n === 'string') out.push(n); });
  }
  const items = doc && doc.items;
  if (Array.isArray(items)) {
    items.forEach(it => {
      if (it && it.name != null) out.push(String(it.name));
      if (it && Array.isArray(it.dishes)) it.dishes.forEach(x => { if (x && x.name != null) out.push(String(x.name)); });
    });
  } else if (items && Array.isArray(items.days)) {
    items.days.forEach(day => { if (day && Array.isArray(day.dishes)) day.dishes.forEach(x => { if (x && x.name != null) out.push(String(x.name)); }); });
  }
  return out.filter(n => typeof n === 'string' && n);
}

async function scanInto(collection, userItems) {
  let skip = 0;
  const BATCH = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await db.collection(collection).limit(BATCH).skip(skip).get();
    const list = (res && res.data) || [];
    if (!list.length) break;
    list.forEach(d => {
      const uid = d && d._openid;
      if (!uid) return;
      const names = extractNames(d);
      if (!names.length) return;
      if (!userItems[uid]) userItems[uid] = new Set();
      names.forEach(n => userItems[uid].add(n));
    });
    if (list.length < BATCH) break;
    skip += BATCH;
  }
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.timer';
console.log('[build] computeCF BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] computeCF BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  // 1. 聚合 用户 → 菜集合
  const userItems = {};
  await scanInto('recommend_history', userItems);
  await scanInto('gen_records', userItems);

  // 2. 物品频次 + 两两共现
  const freq = {};                 // { item: 出现在多少个用户集合里 }
  const co = {};                   // { item: { item: 共现次数 } }
  let activeUsers = 0;
  Object.keys(userItems).forEach(uid => {
    const arr = Array.from(userItems[uid]);
    if (arr.length < MIN_USER_ITEMS) return;
    activeUsers++;
    arr.forEach(a => { freq[a] = (freq[a] || 0) + 1; });
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        if (!co[a]) co[a] = {};
        if (!co[b]) co[b] = {};
        co[a][b] = (co[a][b] || 0) + 1;
        co[b][a] = (co[b][a] || 0) + 1;
      }
    }
  });

  // 3. 相似度 + topK；同时统计有效共现对数（去重，仅 co>=MIN_CO）
  const seenPair = new Set();
  let validPairs = 0;
  const simModel = {}; // { item: [{name, score}] }
  Object.keys(co).forEach(a => {
    const sims = [];
    Object.keys(co[a]).forEach(b => {
      const c = co[a][b];
      if (c >= MIN_CO) {
        const key = a < b ? a + '\u0001' + b : b + '\u0001' + a;
        if (!seenPair.has(key)) { seenPair.add(key); validPairs++; }
      }
      const denom = Math.sqrt((freq[a] || 1) * (freq[b] || 1));
      const score = denom > 0 ? c / denom : 0;
      if (score > 0) sims.push({ name: b, score: Math.round(score * 1000) / 1000 });
    });
    sims.sort((x, y) => y.score - x.score);
    if (sims.length) simModel[a] = sims.slice(0, TOP_K);
  });

  // 4. 落库 cf_model（每个物品一条文档；先清空旧的不做——用 upsert 覆盖，删除残留由 TTL/后续维护处理）
  //    为控制写入量，逐条 upsert（wx-server-sdk 无批量 upsert）。
  const items = Object.keys(simModel);
  for (const item of items) {
    const id = 'ITEM::' + item;
    const dataDoc = { _id: id, item, sim: simModel[item], computedAt: Date.now() };
    try {
      await db.collection('cf_model').doc(id).get();
      await db.collection('cf_model').doc(id).update({ data: { item, sim: simModel[item], computedAt: dataDoc.computedAt } });
    } catch (e) {
      try { await db.collection('cf_model').add({ data: dataDoc }); } catch (e2) { /* 单条失败静默，不阻断全量 */ }
    }
  }

  // 5. 就绪信号写 sys_config.cf_ready（getRecommendation 侧读它 + cf_enabled 双判定）
  const ready = activeUsers >= READY_MIN_USERS && validPairs >= READY_MIN_PAIRS;
  const readyDoc = {
    users: activeUsers,
    pairs: validPairs,
    items: items.length,
    ready,                    // 数据是否达标（供开关自动放行参考）
    threshold: { users: READY_MIN_USERS, pairs: READY_MIN_PAIRS },
    computedAt: Date.now()
  };
  try {
    await db.collection('sys_config').doc('cf_ready').get();
    await db.collection('sys_config').doc('cf_ready').update({ data: readyDoc });
  } catch (e) {
    try { await db.collection('sys_config').add({ data: Object.assign({ _id: 'cf_ready' }, readyDoc) }); } catch (e2) { /* 静默 */ }
  }

  // 确保开关文档存在且默认关闭（首次运行时创建，不覆盖人工已设置的值）
  try {
    await db.collection('sys_config').doc('cf_switch').get();
  } catch (e) {
    try { await db.collection('sys_config').add({ data: { _id: 'cf_switch', cf_enabled: false, note: 'CF影子模式总开关，默认关；达标后手动或自动置true', updatedAt: Date.now() } }); } catch (e2) { /* 静默 */ }
  }

  return { code: 200, users: activeUsers, pairs: validPairs, items: items.length, ready, msg: 'cf model computed (shadow mode)' };
};
