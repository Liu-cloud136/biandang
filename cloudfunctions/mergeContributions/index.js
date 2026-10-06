// mergeContributions —— 贡献「合并」函数
// 入库(合并)触发条件（与本函数的「比对」分开）：菜名有效≥50 条 或 食材有效≥5 种 才执行合并。
// 合并内容：①把通过审核的菜名/食材并入 dish_library / ingredient_library（供后续去重）；
//           ②按数字用户ID(userNo)汇总发放次数（菜名每个2次、食材每个1次）；③标记已合并避免重复发放。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DISH_LIB = 'dish_library';
const ING_LIB = 'ingredient_library';
const CONTRIB = 'dish_contrib';
const USER_NO_MAP = 'user_no_map';

const DISH_THRESHOLD = 50;  // 正式阈值：菜名累计 50 条有效即合并
const ING_THRESHOLD = 5;    // 食材阈值（与 submitContribution 对齐）：食材累计 5 条有效即合并
const DISH_REWARD = 2;   // 菜名每个 2 次
const ING_REWARD = 1;

// 入库归一化：折叠内部空白 + 去首尾空格，使「红烧鸡爪」与「红烧鸡爪 」（尾空格/多空格）判定为同名，
// 直接丢弃不入库，避免审核界面出现两个一模一样的菜。
function normName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}
// 食材同物异名归一化：别名→通用名。历史提交的旧名在此折叠进通用名，避免重复条目。
// ⚠️ 四副本同源：前端 config.VEG_ALIAS / getRecommendation.VEG_ALIAS / submitContribution.ALIAS / 本表，改其一必同步另三处。
// 2026-07-24 扩充：并入社区库重分类整理的同物异名+品种归一全量映射。
const ALIAS = {
  // —— 原有 4 条 ——
  '芋艿': '芋头', '甘蓝': '包菜', '豆皮': '千张', '辣椒': '小米辣',
  // —— 根茎/薯芋 ——
  '地瓜': '甘薯', '豆薯': '沙葛', '蒟蒻': '魔芋',
  '淮山': '山药', '脆山药': '山药', '铁棍山药': '山药',
  '红菜头': '甜菜根', '紫菜头': '甜菜根',
  '红萝卜': '胡萝卜', '手指胡萝卜': '胡萝卜',
  '红心萝卜': '心里美萝卜',
  // —— 甘蓝/花菜/叶菜 ——
  '白花菜': '菜花', '白花椰菜': '菜花', '有机菜花': '菜花',
  '包心菜': '包菜', '圆白菜': '包菜',
  '紫包菜': '紫甘蓝', '紫椰菜': '紫甘蓝', '紫甘蓝菜': '紫甘蓝',
  '雪菜': '雪里蕻', '荠荠菜': '荠菜', '马齿菜': '马齿苋',
  '苦菊': '苦苣', '苜蓿芽': '苜蓿', '盖菜': '芥兰',
  // —— 豆制品/豆类 ——
  '白香干': '豆干', '豆腐干': '豆干', '干豆腐': '千张',
  '白豆': '白芸豆', '红腰豆': '红芸豆', '眉豆': '白扁豆',
  '龙牙豆': '扁豆', '马牙大豆': '大豆', '小黑豆': '黑豆',
  // —— 菌菇 ——
  '鸡土从': '鸡枞', '双孢菇': '口蘑', '双孢蘑菇': '口蘑',
  '小草菇': '草菇', '干松茸': '松茸',
  // —— 水产海鲜 ——
  '干贝': '瑶柱', '淡菜': '青口贝', '贻贝': '青口贝',
  '海蛎子': '牡蛎', '生蚝': '牡蛎', '乌贼': '墨鱼',
  '平鱼': '鲳鱼', '白鲳鱼': '鲳鱼', '大闸蟹': '河蟹', '鳝鱼': '黄鳝',
  '海米': '干虾仁', '虾米': '干虾仁',
  // —— 畜肉 ——
  '牛骨髓': '牛髓', '牛筋': '牛蹄筋', '羊下水': '羊杂',
  '猪龙骨': '龙骨', '猪肥肠': '猪大肠', '猪夹心肉': '猪前夹肉', '大鸡腿': '鸡腿', '岭南黄': '三黄鸡',
  // —— 主食杂粮 ——
  '高粱': '高粱米', '荞麦': '荞麦米',
  '江米': '长糯米', '血糯米': '长糯米', '黑糯米': '长糯米',
  '红薏米': '薏米', '粟米': '小米',
  // —— 水果品种归一 ——
    '红富士': '苹果', '红果': '山楂',
    // —— 2026-07-24 二次扩充：常见同物异名/方言/品种归一（续）——
    '马铃薯': '土豆', '洋芋': '土豆', '山药蛋': '土豆',
    '番薯': '甘薯', '山芋': '甘薯', '红苕': '甘薯', '凉薯': '沙葛',
    '莲藕': '藕', '西红柿': '番茄', '洋柿子': '番茄', '圣女果': '番茄', '奶柿子': '番茄', '小西红柿': '番茄',
    '卷心菜': '包菜', '大白菜': '白菜', '乌塌菜': '塌棵菜',
    '芥兰': '芥蓝', '雪里红': '雪里蕻',
    '莴苣': '莴笋', '青笋': '莴笋',
    '西芹': '芹菜', '香芹': '芹菜', '旱芹': '芹菜',
    '芫荽': '香菜', '胡荽': '香菜', '香葱': '小葱', '大蒜': '蒜', '蒜头': '蒜',
    '生姜': '姜', '老姜': '姜', '仔姜': '姜',
    '通菜': '空心菜', '蕹菜': '空心菜', '落葵': '木耳菜', '米苋': '苋菜',
    '菠薐菜': '菠菜', '莜麦菜': '油麦菜', '蓬蒿': '茼蒿', '蒿子秆': '茼蒿',
    '龙须菜': '芦笋', '笋': '竹笋', '春笋': '竹笋', '冬笋': '竹笋',
    '白萝卜': '萝卜', '青萝卜': '萝卜', '紫心红薯': '紫薯',
    '豆腐皮': '千张', '百叶': '千张', '千张皮': '千张', '豆米': '毛豆',
    '黄豆': '大豆', '芸豆': '白芸豆', '四季豆': '豆角', '豇豆': '豆角',
    '冬菇': '香菇', '花菇': '香菇', '白蘑菇': '口蘑',
    '螃蟹': '蟹', '花蛤': '蛤蜊', '枪乌贼': '鱿鱼', '非洲鲫鱼': '罗非鱼',
    '胡子鲶': '鲶鱼', '刀鱼': '带鱼', '黄鱼': '黄花鱼', '金针菜': '黄花菜',
    '蹄髈': '猪蹄',
    '苞谷': '玉米', '包谷': '玉米', '燕麦': '莜麦',
    '奇异果': '猕猴桃', '凤梨': '菠萝', '车厘子': '樱桃', '提子': '葡萄',
    '鳄梨': '牛油果', '西番莲': '百香果'
};

async function getValidCounts() {
  const dRes = await db.collection(CONTRIB).where({ type: 'dish', status: 'valid' }).count().catch(() => ({ total: 0 }));
  const iRes = await db.collection(CONTRIB).where({ type: 'ingredient', status: 'valid' }).limit(1000).get().catch(() => ({ data: [] }));
  const ingVals = new Set((iRes.data || []).map(x => x.value));
  return { dish: dRes.total || 0, ing: ingVals.size };
}

// 合并锁：防止并发重复合并（counters.merge_lock）
async function acquireLock() {
  const id = 'merge_lock';
  const now = Date.now();
  const cur = await db.collection('counters').where({ _id: id }).get().catch(() => ({ data: [] }));
  if (!cur.data || !cur.data.length) {
    // 首次调用：counters 集合刚建，尚缺该锁文档，先创建
    await db.collection('counters').doc(id).set({ data: { locked: false, ts: 0 } }).catch(() => {});
  } else {
    // 释放过期锁（占用超过 5 分钟视为主动退出/异常）
    await db.collection('counters').where({ _id: id, locked: true, ts: _.lt(now - 5 * 60000) }).update({ data: { locked: false } }).catch(() => {});
  }
  const r = await db.collection('counters').where({ _id: id, locked: false }).update({ data: { locked: true, ts: now } }).catch(() => ({ stats: { updated: 0 } }));
  return r && r.stats && r.stats.updated > 0;
}
async function releaseLock() { await db.collection('counters').doc('merge_lock').update({ data: { locked: false } }).catch(() => {}); }

// 批量把值并入库集合（已存在则累积贡献者数字ID）。map：归一化 value -> category（食材分类；菜名为 undefined）；mapNos：value -> 数字ID数组
async function upsertLib(col, map, mapNos) {
  let added = 0;
  for (const v of Object.keys(map)) {
    const ex = await db.collection(col).where({ value: v }).limit(1).get().catch(() => ({ data: [] }));
    const nos = (mapNos && mapNos[v]) || [];
    if (ex.data && ex.data.length) {
      if (nos.length) await db.collection(col).where({ _id: ex.data[0]._id }).update({ data: { userNos: _.addToSet(_.each(nos)) } }).catch(() => {});
      continue;
    }
    const doc = { value: v, addedAt: db.serverDate(), userNos: nos };
    const cat = map[v];
    if (cat) doc.category = cat;   // 仅食材带分类；菜名不写 category
    await db.collection(col).add({ data: doc }).catch(() => {});
    added++;
  }
  return added;
}

async function mergeOne(id) {
  const itemRes = await db.collection(CONTRIB).doc(id).get().catch(() => ({ data: null }));
  const item = itemRes && itemRes.data;
  if (!item) return { code: 404, msg: '记录不存在' };
  if (item.status === 'merged') return { code: 200, merged: false, msg: '该条已合并过' };

  const isDish = item.type === 'dish';
  const col = isDish ? DISH_LIB : ING_LIB;
  const val = normName(ALIAS[item.value] || item.value);

  // ① 入库去重（已存在则累积贡献者数字ID）
  let added = 0;
  const ex = await db.collection(col).where({ value: val }).limit(1).get().catch(() => ({ data: [] }));
  if (!ex.data || !ex.data.length) {
    const doc = { value: val, addedAt: db.serverDate(), userNos: (item.userNo != null ? [item.userNo] : []) };
    if (!isDish) doc.category = (item.category && String(item.category).trim()) || '其他';
    await db.collection(col).add({ data: doc }).catch(() => {});
    added++;
  } else if (item.userNo != null) {
    await db.collection(col).where({ _id: ex.data[0]._id }).update({ data: { userNos: _.addToSet(_.each([item.userNo])) } }).catch(() => {});
  }

  // ③ 先标记已合并（防重复发放），再发放。标记失败必须抛错中止，否则「没标记成功却发了奖」会导致重跑重复发放
  await db.collection(CONTRIB).doc(id).update({ data: { status: 'merged', mergedAt: db.serverDate(), adminSetAt: new Date() } }).catch(e => { console.error('[mergeOne] 标记已合并失败，中止以免重复发放:', e); throw e; });

  // ② 发放（按数字 userNo；缺失则不发）
  let awarded = 0;
  const no = item.userNo;
  if (no != null) {
    const reward = isDish ? DISH_REWARD : ING_REWARD;
    const openid = item._openid;
    await db.collection('user_preferences').where({ _openid: openid }).update({ data: { bonusFree: _.inc(reward) } }).catch(e => { console.error('[mergeOne] 发放 bonusFree 失败:', e); });
    await db.collection('free_log').add({
      data: { _openid: openid, userNo: Number(no), type: 'add', source: 'contrib', amount: reward, desc: '贡献合并发放 +' + reward, detail: (isDish ? '贡献菜名' : '贡献食材') + '1个', ts: db.serverDate() }
    }).catch(e => { console.error('[mergeOne] 写入发放流水失败:', e); });
    awarded = reward;
  }

  return { code: 200, merged: true, added, awarded, type: item.type, value: val };
}

async function merge(force) {
  const c = await getValidCounts();
  if (!force && c.dish < DISH_THRESHOLD && c.ing < ING_THRESHOLD) {
    return { code: 200, merged: false, dishValid: c.dish, ingValid: c.ing, msg: '未达合并阈值' };
  }
  const dishItems = await db.collection(CONTRIB).where({ type: 'dish', status: 'valid' }).limit(1000).get().catch(() => ({ data: [] }));
  const ingItems = await db.collection(CONTRIB).where({ type: 'ingredient', status: 'valid' }).limit(1000).get().catch(() => ({ data: [] }));
  const dList = dishItems.data || [];
  const iList = ingItems.data || [];

  // ① 并入库（去重）：upsertLib 接收 value->category 映射；菜名无分类(空)
  //    键统一经 normName 归一化，使「红烧鸡爪」与「红烧鸡爪 」视为同名、仅留一条，名字一样直接丢弃。
  const dishMap = {};
  dList.forEach(x => { const v = normName(x.value); if (!dishMap[v]) dishMap[v] = ''; });
  const dishAdded = await upsertLib(DISH_LIB, dishMap, {});
  const ingMap = {};
  iList.forEach(x => { const v = normName(ALIAS[x.value] || x.value); if (!ingMap[v]) ingMap[v] = (x.category && String(x.category).trim()) || '其他'; });
  const ingNosMap = {};
  iList.forEach(x => {
    const v = normName(ALIAS[x.value] || x.value), no = x.userNo;
    if (no == null) return;
    if (!ingNosMap[v]) ingNosMap[v] = [];
    if (ingNosMap[v].indexOf(no) < 0) ingNosMap[v].push(no);
  });
  const ingAdded = await upsertLib(ING_LIB, ingMap, ingNosMap);

  // ② 按数字用户ID 汇总发放
  const byUser = {}; // userNo -> {openid, dish, ing}
  function acc(arr, isDish) {
    arr.forEach(x => {
      const no = x.userNo;
      if (no == null) return;
      if (!byUser[no]) byUser[no] = { openid: x._openid, dish: 0, ing: 0 };
      if (isDish) byUser[no].dish++; else byUser[no].ing++;
    });
  }
  acc(dList, true);
  acc(iList, false);

  // ③ 先标记已合并（必须在发奖前），避免发奖中途异常/函数超时导致已发奖记录仍 status:'valid' 被下次合并重复发放
  const ids = dList.concat(iList).map(x => x._id).filter(Boolean);
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 90) {
      const batch = ids.slice(i, i + 90);
      await db.collection(CONTRIB).where({ _id: _.in(batch), status: 'valid' }).update({ data: { status: 'merged', mergedAt: db.serverDate() } }).catch(e => { console.error('[merge] 批量标记已合并失败，中止以免重复发放:', e); throw e; });
    }
  }

  // ② 按数字用户ID 汇总发放（标记已完成，即使中途异常也不会重复发放）
  const awarded = [];
  for (const no of Object.keys(byUser)) {
    const u = byUser[no];
    const reward = u.dish * DISH_REWARD + u.ing * ING_REWARD;
    if (reward <= 0) continue;
    const openid = u.openid;
    // 写入 user_preferences.bonusFree
    await db.collection('user_preferences').where({ _openid: openid }).update({ data: { bonusFree: _.inc(reward) } }).catch(e => { console.error('[merge] 发放 bonusFree 失败:', e); });
    // 发放流水（与签到/赠送等保持一致：type='add' + source + amount，供 getFreeLog 明细正确展示）
    await db.collection('free_log').add({
      data: { _openid: openid, userNo: Number(no), type: 'add', source: 'contrib', amount: reward, desc: '贡献合并发放 +' + reward, detail: '贡献菜名' + u.dish + '个/食材' + u.ing + '个', ts: db.serverDate() }
    }).catch(e => { console.error('[merge] 写入发放流水失败:', e); });
    awarded.push({ userNo: Number(no), openid, reward, dish: u.dish, ing: u.ing });
  }

  return { code: 200, merged: true, dishMerged: dList.length, ingMerged: iList.length, dishLibAdded: dishAdded, ingLibAdded: ingAdded, awardedUsers: awarded.length, awarded };
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-18.merge-norm-dedup';
console.log('[build] mergeContributions BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] mergeContributions BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const ctx = cloud.getWXContext ? cloud.getWXContext() : {};
  // 合并有两条触发路径：①管理员客户端直连（上下文 OPENID = 管理员真实 OPENID）；
  // ②受信云函数内部调用（manageContrib 后台合并 / submitContribution 达阈值自动合并），
  //   此时 cloud.callFunction 不携带用户 OPENID（上下文为空），由调用方显式传入 _sys 内部密钥鉴权。
  const OPENID = (ctx && ctx.OPENID) || (event && event.OPENID) || '';
  // fail-closed：仅管理员（真实身份命中白名单/REAL_ADMIN）或携带合法内部密钥的受信调用可触发，其余一律拒绝
  const REAL_ADMIN = '';
  const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const SYS_SECRET = process.env.MERGE_SYS_SECRET || '';
  const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));
  const isInternal = !!SYS_SECRET && (event && event._sys) === SYS_SECRET;
  if (!isAdminOpenid(OPENID) && !isInternal) return { code: 403, msg: '无权限' };
  const action = (event && event.action) || 'status';
  if (action === 'status') {
    const c = await getValidCounts();
    return { code: 200, dishValid: c.dish, ingValid: c.ing, dishThreshold: DISH_THRESHOLD, ingThreshold: ING_THRESHOLD, ready: (c.dish >= DISH_THRESHOLD || c.ing >= ING_THRESHOLD) };
  }
  if (action === 'merge') {
    const ok = await acquireLock();
    if (!ok) return { code: 409, msg: '合并进行中，请稍后重试' };
    try { return await merge(!!(event && event.force)); }
    finally { await releaseLock(); }
  }
  if (action === 'mergeOne') {
    if (!event || !event.id) return { code: 400, msg: '缺少 id' };
    const ok = await acquireLock();
    if (!ok) return { code: 409, msg: '合并进行中，请稍后重试' };
    try { return await mergeOne(event.id); }
    finally { await releaseLock(); }
  }
  return { code: 400, msg: 'unknown action' };
};
