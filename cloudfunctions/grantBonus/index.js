const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 管理员手动发放免费次数（后台工具）。
// 调用方式：云开发控制台「测试」填入 { "openid": "目标用户OPENID", "count": 10 } 直接放行；
// 若从小程序端调用，可在环境变量 ADMIN_OPENIDS 配置管理员 OPENID 白名单（逗号分隔），非白名单拒绝。
// 行为：把 count 写入目标用户的 pendingBonus（待领取），不计入测试期自动发放上限 FREE_CAP；
//       接收方下次打开首页时，getDailyStats 会将 pendingBonus 并入赠送池并返回 bonusNotice，
//       前端据此弹出「管理员为您发放了 N 次」提示。这样保证发放后接收方能在 App 内看到通知，而非静默到账。
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-20.logoff-tomb';
console.log('[build] grantBonus BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] grantBonus BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  // 兼容登录用的 ADMIN_OPENID（单数）与发放白名单 ADMIN_OPENIDS（复数），
  // 任一命中即视为管理员；白名单都为空则放行（后台 UI 已由 adminLogin 保护）。
  const adminList = [
    ...(process.env.ADMIN_OPENID || '').split(',').map(s => s.trim()).filter(Boolean),
    ...(process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean)
  ];
  // fail-closed：仅「控制台调用（OPENID 为空，即云函数测试台）」或「白名单内管理员」放行；
  // 小程序端任意非白名单用户一律拒绝。即便 ADMIN_OPENIDS 被误清空，也不会退化成「任何人可发奖」。
  if (OPENID && !adminList.includes(OPENID)) {
    return { code: 403, msg: '无权限' };
  }

  // 目标用户：支持 openid 或 数字编号 no（自动解析为 openid），方便后台按编号发放
  const rawOpenid = (event && (event.openid || event.openId)) || '';
  let openid = rawOpenid;
  const rawNo = (event && event.no != null) ? Number(event.no) : NaN;
  if (!openid && !Number.isNaN(rawNo)) {
    try {
      const m = await db.collection('user_no_map').where({ no: rawNo }).limit(1).get();
    if (m.data[0]) openid = m.data[0]._openid;
  } catch (e) { console.warn('[grantBonus] resolve no failed:', e && e.message); }
  }
  const rawCount = (event && event.count);

  // ---- 输入校验（防注入 / 防滥用）----
  if (!openid || !/^[a-zA-Z0-9_-]{10,64}$/.test(openid)) {
    return { code: 400, msg: 'openid 非法或未找到该编号用户（应为目标 OPENID 或有效数字编号）' };
  }
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    return { code: 400, msg: 'count 须为 1~1000 的整数' };
  }

  try {
    // 注销守卫（墓碑优先 + user_no_map）：已注销用户不再建档，避免复活
    const tombR = await db.collection('deleted_users').where({ _openid: openid }).limit(1).get();
    if (tombR.data && tombR.data.length) {
      return { code: 404, msg: '目标账号已注销，无法发放' };
    }
    const mapR = await db.collection('user_no_map').where({ _openid: openid }).limit(1).get();
    if (!(mapR.data && mapR.data.length)) {
      return { code: 404, msg: '目标账号已注销或不存在，无法发放' };
    }
    const exist = await db.collection('user_preferences').where({ _openid: openid }).limit(1).get();
    let newBonus;
    if (exist.data && exist.data.length) {
      const uid = exist.data[0]._id;
      // 写入待领取 pendingBonus（不直接加 bonusFree）：接收方下次打开首页时，
      // getDailyStats 会把 pendingBonus 并入赠送池并返回 bonusNotice，前端据此弹出
      // 「管理员为您发放了 N 次」提示。这是「发放后接收方弹窗」体验的关键。
      newBonus = (exist.data[0].pendingBonus || 0) + count;
      await db.collection('user_preferences').doc(uid).update({
        data: { pendingBonus: _.inc(count) }
      });
    } else {
      // 用户尚未产生任何偏好记录：先建一份，次数记为待领取，待其打开首页时并入并弹窗
      newBonus = count;
      await db.collection('user_preferences').add({
        data: {
          baseFree: 0, bonusFree: 0, totalFreeGranted: 0, adCount: 0,
          pendingBonus: count, lastSignedDate: '', _openid: openid
        }
      });
    }

    // 注：free_log 流水由接收方 getDailyStats 真正将 pendingBonus 并入赠送池时统一记录，
    // 此处不重复记，避免一笔发放出现两条流水。

    return { code: 200, msg: '已发放 ' + count + ' 次到用户 ' + openid, data: { openid, granted: count, pendingBonus: newBonus } };
  } catch (e) {
    console.error('grantBonus error:', e);
    return { code: 500, msg: (e && e.message) || '发放失败' };
  }
};
