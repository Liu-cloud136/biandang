const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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
    console.error('[signIn] isUserAlive 查询异常 openid=' + OPENID + ':', e && e.message);
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

// 每日签到：点击才发放 +2 次（永久计数池，跨天保留）。每日限一次。
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-20.logoff-guard';
console.log('[build] signIn BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] signIn BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const today = getToday();
  const prefs = await ensurePrefs(OPENID);
  // 已注销用户：守卫拦截，返回 410 让前端重新引导（不再自动建档复活）
  if (prefs && prefs._deleted) {
    return { code: 410, msg: '账号已注销，请重新注册', deleted: true };
  }
  let baseFree = prefs.baseFree || 0;
  let bonusFree = prefs.bonusFree || 0;

  // 已签到（同日）：直接返回当前次数（不重复发放）
  if (prefs.lastSignedDate === today) {
    return { code: 200, data: { freeCount: baseFree + bonusFree, signed: true, already: true } };
  }

  // 签到 +2（写入永久基础池，跨天保留）——用「lastSignedDate != today」作 where 条件原子更新，
  // 防止快速双击/弱网重试下两个请求都通过上面的日期检查而重复 +2（读写非原子的竞态）。
  // 注：这里 where 用业务字段（_openid + lastSignedDate），非 _id，CloudBase 可正常匹配。
  const upd = await db.collection('user_preferences')
    .where({ _openid: OPENID, lastSignedDate: _.neq(today) })
    .update({ data: { baseFree: _.inc(2), lastSignedDate: today } });
  if (!(upd.stats && upd.stats.updated > 0)) {
    // 并发下已被另一个请求签到：不重复发放，返回当前值（重新读取以拿到已 +2 后的最新数）
    const cur = (await db.collection('user_preferences').doc(prefs._id).get()).data || {};
    return { code: 200, data: { freeCount: (cur.baseFree || 0) + (cur.bonusFree || 0), signed: true, already: true } };
  }
  await logFree(OPENID, 'add', 'signin', 2, '每日签到 +2');
  return { code: 200, data: { freeCount: baseFree + 2 + bonusFree, signed: true, already: false } };
};
