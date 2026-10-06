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
    console.error('[consumeFreeCount] isUserAlive 查询异常 openid=' + OPENID + ':', e && e.message);
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

// 当前每个用户免费获取总次数上限（终身累计，超出需到反馈里申请）
const FREE_CAP = 50;

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-20.logoff-guard';
console.log('[build] consumeFreeCount BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] consumeFreeCount BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const prefs = await ensurePrefs(OPENID);
  // 已注销用户：守卫拦截，返回 410 让前端重新引导（不再自动建档复活）
  if (prefs && prefs._deleted) {
    return { code: 410, msg: '账号已注销，请重新注册', deleted: true };
  }
  let bonusFree = prefs.bonusFree || 0;
  const granted0 = prefs.totalFreeGranted || 0;

  // 管理员手动赠送：若用户只走「领次数」路径而未触发 getDailyStats，
  // 这里也要把待发放次数并入永久赠送池，否则赠送次数永远到不了用户。
  // 事务化（方案A）：余额 inc 与 free_log add 原子提交，避免「余额加但流水漏写」账实不符（历史差额20）。
  let pendingBonus = prefs.pendingBonus || 0;
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
    } catch (e) {
      await t.rollback();
      console.error('grantBonus apply failed, rolled back:', e);
      // 不影响主流程；pendingBonus 保留，下次访问重试
    }
  }

  // 已达上限快速返回：告知到「我的-意见反馈」提交 ID + 需要的次数
  if (granted0 >= FREE_CAP) {
    return {
      code: 449,
      msg: '免费次数领取已到上限（当前共 ' + FREE_CAP + ' 次）。因服务器算力有限，为保证更多用户正常体验设此上限；如仍需要，请在「我的 → 意见反馈」提交你的数字 ID 与所需次数，管理员会及时发放。'
    };
  }

  // 发放：用 doc(_id).update 直接原子自增（云端 inc 本就原子，并发安全）。
  // 单次增量由上方 min(25, FREE_CAP-g) 限制，永不突破 FREE_CAP；并发两次各 +25 最终也只到 50，不会越界。
  // 此前误用 where({_id, totalFreeGranted:g}).update()：CloudBase 下 _id 作 where 条件匹配不到 → updated 恒 0 →
  // 4 次重试全失败 → 正常单次领次数也误报「免费次数发放冲突」。已改回 doc().update()。
  let grantedNow = 0;
  let latest = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await db.collection('user_preferences').doc(prefs._id).get();
    latest = cur.data || {};
    const g = latest.totalFreeGranted || 0;
    // 已到当前上限：直接返回，避免进入下方 update 后再误判为「冲突」
    if (g >= FREE_CAP) {
      return {
        code: 449,
        msg: '免费次数领取已到上限（当前共 ' + FREE_CAP + ' 次）。因服务器算力有限，为保证更多用户正常体验设此上限；如仍需要，请在「我的 → 意见反馈」提交你的数字 ID 与所需次数，管理员会及时发放。'
      };
    }
    const grant = Math.min(25, FREE_CAP - g);
    const upd = await db.collection('user_preferences')
      .doc(prefs._id)
      .update({
        data: { baseFree: _.inc(grant), totalFreeGranted: _.inc(grant), adCount: _.inc(1) }
      });
    if (upd.stats && upd.stats.updated > 0) {
      grantedNow = grant;
      latest = (await db.collection('user_preferences').doc(prefs._id).get()).data || {};
      break;
    }
  }

  if (grantedNow === 0) {
    // 并发抢占或已触顶
    if (latest && (latest.totalFreeGranted || 0) >= FREE_CAP) {
      return {
        code: 449,
        msg: '免费次数领取已到上限（当前共 ' + FREE_CAP + ' 次）。因服务器算力有限，为保证更多用户正常体验设此上限；如仍需要，请在「我的 → 意见反馈」提交你的数字 ID 与所需次数，管理员会及时发放。'
      };
    }
    return { code: 449, msg: '免费次数发放冲突，请稍后再试（当前上限 ' + FREE_CAP + ' 次）。' };
  }

  await logFree(OPENID, 'add', 'ad', grantedNow, '领次数 +' + grantedNow);
  const newBase = latest.baseFree || 0;
  const newBonus = latest.bonusFree || 0;
  const newGranted = latest.totalFreeGranted || 0;
  return { code: 200, data: { freeCount: newBase + newBonus, totalFreeGranted: newGranted, bonusFree: newBonus, freeCap: FREE_CAP } };
};
