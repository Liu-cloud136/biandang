const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 管理员权威识别源：OPENID 直接比对（ID 固定 'admin'，不进数字命名空间）。
const ADMIN_OPENID = process.env.ADMIN_OPENID || '';

function getToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 中国时区 UTC+8
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// 写入免费次数流水（非关键，失败不影响主流程）
async function logFree(OPENID, type, source, amount, desc) {
  try {
    await db.collection('free_log').add({
      data: { _openid: OPENID, type, source, amount, desc: desc || '', ts: db.serverDate() }
    });
  } catch (e) { console.error('logFree failed:', e); }
}

// 注销守卫：已注销用户（user_no_map 已被 deleteAccount 删除）不再建档，杜绝「注销后自动复活」
async function isUserAlive(OPENID) {
  try {
    // 墓碑优先：命中 deleted_users 即已注销（权威判定源，独立于 user_no_map 是否被重建）
    const tombR = await db.collection('deleted_users').where({ _openid: OPENID }).limit(1).get();
    if (tombR.data && tombR.data.length) return false;
    const m = await db.collection('user_no_map').where({ _openid: OPENID }).limit(1).get();
    return !!(m.data && m.data.length);
  } catch (e) {
    console.error('[getDailyStats] isUserAlive 查询异常 openid=' + OPENID + ':', e && e.message);
    return false; // fail-closed：查询异常时按已注销处理，禁止建档
  }
}

// 每个用户只保留一份计数（永久计数池，跨天保留），无则创建
async function ensurePrefs(OPENID) {
  const r = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
  if (r.data[0]) return r.data[0];
  // 无档：仅当为有效用户（user_no_map 存在、未注销）才建档；已注销则永不重建
  if (!(await isUserAlive(OPENID))) {
    return { _deleted: true, _openid: OPENID };
  }
  const add = await db.collection('user_preferences').add({
    data: { baseFree: 0, bonusFree: 0, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', _openid: OPENID }
  });
  return { _id: add._id, baseFree: 0, bonusFree: 0, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '' };
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-20.logoff-guard';
console.log('[build] getDailyStats BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] getDailyStats BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const today = getToday();
  const FREE_CAP = 50; // 当前免费获取总次数上限
  const prefs = await ensurePrefs(OPENID);

  // 已注销用户：守卫拦截，返回 410 让前端重新引导（不再自动建档复活）
  if (prefs && prefs._deleted) {
    return { code: 410, msg: '账号已注销，请重新注册', deleted: true };
  }

  // 封禁拦截：被管理员封禁的用户直接拒绝服务
  if (prefs.banned) {
    return { code: 403, msg: '账号已被封禁，请联系管理员', banned: true };
  }

  // 用户ID：管理员固定为字符串 'admin'（按 OPENID 权威识别，不进数字命名空间）；
  // 普通用户取自 user_no_map.no（>=1；缺失则为 null，不误显）。
  let userId = null;
  if (OPENID === ADMIN_OPENID) {
    userId = 'admin';
  } else {
    try {
      const mapR = await db.collection('user_no_map').where({ _openid: OPENID }).limit(1).get();
      if (mapR.data[0] && mapR.data[0].no != null) userId = mapR.data[0].no;
    } catch (e) { /* 不影响主流程 */ }
  }

  let baseFree = prefs.baseFree || 0;
  let bonusFree = prefs.bonusFree || 0;
  let totalFreeGranted = prefs.totalFreeGranted || 0;
  let pendingBonus = prefs.pendingBonus || 0;

  // 管理员手动赠送：把待发放次数并入永久赠送池，并回传弹窗通知（仅发放这一次返回 notice，避免重复弹窗）
  // 事务化（方案A）：余额 inc 与 free_log add 必须原子，否则任一步失败会导致「余额加了但流水漏写」的账实不符（历史已出现管理员 bonusFree 实然55/应然35 差额20）。
  let bonusNotice = null;
  if (pendingBonus > 0) {
    const t = await db.startTransaction();
    try {
      await t.collection('user_preferences').doc(prefs._id).update({
        data: { bonusFree: _.inc(pendingBonus), pendingBonus: 0 }
      });
      await t.collection('free_log').add({
        data: { _openid: OPENID, type: 'add', source: 'bonus', amount: pendingBonus, desc: '管理员赠送 +' + pendingBonus, ts: db.serverDate() }
      });
      await t.commit();
      bonusFree += pendingBonus;
      bonusNotice = { count: pendingBonus };
    } catch (e) {
      await t.rollback();
      console.error('grantBonus apply failed, rolled back:', e);
      // 不影响主流程；本次发放失败，pendingBonus 保留，下次访问重试
    }
  }

  // 对外统一返回「永久基础池 + 赠送池」的合并可用值，便于前端直接展示
  const avail = baseFree + bonusFree;
  const signed = (prefs.lastSignedDate === today);
  return { code: 200, data: { freeCount: avail, signed, bonusFree, totalFreeGranted, freeCap: FREE_CAP, bonusNotice, userId } };
};
