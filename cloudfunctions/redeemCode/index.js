const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 兑换码：用户输入码 -> 校验（存在/启用/未过期/额度未用尽/该用户未重复兑换）
// -> 一次性发放 count 次到 bonusFree（赠送池，不受 50 次 FREE_CAP 上限约束）。
// 构建指纹（2026-08-11 兑换码上线）
const BUILD_TAG = '2026-08-11.redeem-code';
console.log('[build] redeemCode BUILD_TAG=' + BUILD_TAG);

// 幂等建集合（控制台也可手动建；重复调用安全）
async function ensureCollections() {
  await Promise.allSettled([
    db.createCollection('redeem_codes'),
    db.createCollection('redeem_log')
  ]);
}

// NoSQL 读回的日期可能是 Date 对象或 { $date }，统一转时间戳
function toTs(v) {
  if (!v) return 0;
  if (v.$date) return new Date(v.$date).getTime();
  if (v instanceof Date) return v.getTime();
  return new Date(v).getTime();
}

exports.main = async (event) => {
  console.log('[build] redeemCode BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();

  // 幂等建集合（入口最顶部，确保首次调用即就绪，不受后续鉴权 return 影响）
  await ensureCollections();

  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const code = (event && event.code || '').toString().trim().toUpperCase();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) {
    return { code: 400, msg: '兑换码格式不正确' };
  }

  try {
    // 1) 取码（仅启用中的）
    const r = await db.collection('redeem_codes').where({ code, active: true }).limit(1).get();
    if (!r.data || !r.data.length) return { code: 404, msg: '兑换码无效或已停用' };
    const doc = r.data[0];

    const now = Date.now();
    if (doc.expireAt && toTs(doc.expireAt) < now) return { code: 410, msg: '兑换码已过期' };
    if ((doc.used || 0) >= (doc.quota || 0)) return { code: 409, msg: '该兑换码已被领完' };

    // 2) 防同用户重复兑换
    const dup = await db.collection('redeem_log').where({ _openid: OPENID, code }).limit(1).get();
    if (dup.data && dup.data.length) return { code: 409, msg: '你已兑换过该码' };

    // 3) 取/建用户偏好
    const prefs = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
    let uid = prefs.data[0] && prefs.data[0]._id;
    if (!uid) {
      const add = await db.collection('user_preferences').add({
        data: { baseFree: 0, bonusFree: 0, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', _openid: OPENID }
      });
      uid = add._id;
    }

    const count = doc.count || 0;
    // 4) 原子事务：额度 +1、赠送池 +count、记流水、记兑换日志
    const t = await db.startTransaction();
    try {
      await t.collection('redeem_codes').doc(doc._id).update({ data: { used: _.inc(1) } });
      await t.collection('user_preferences').doc(uid).update({ data: { bonusFree: _.inc(count) } });
      await t.collection('free_log').add({
        data: { _openid: OPENID, type: 'add', source: 'redeem', sourceName: '兑换码', amount: count, desc: '兑换码 ' + code + ' +' + count, ts: db.serverDate() }
      });
      await t.collection('redeem_log').add({
        data: { _openid: OPENID, code, grant: count, ts: db.serverDate() }
      });
      await t.commit();
    } catch (e) {
      await t.rollback();
      console.error('redeemCode tx failed:', e);
      return { code: 500, msg: '兑换失败，请重试' };
    }

    const cur = await db.collection('user_preferences').doc(uid).get();
    const d = cur.data || {};
    return {
      code: 200,
      data: { granted: count, freeCount: (d.baseFree || 0) + (d.bonusFree || 0), bonusFree: d.bonusFree || 0 }
    };
  } catch (e) {
    console.error('redeemCode error:', e);
    return { code: 500, msg: '兑换失败，请重试' };
  }
};
