const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 决定次数统计：供「我的」页头像光晕机制使用。
// 决定次数 = 该用户在 recommend_history 中的记录总数（每次 commitRecommendation 即一次决定）。
// 近 3 天决定次数 = timestamp >= 3 天前的记录数。
// 纯读、零扣次。

const BUILD_TAG = '2026-08-19.decide-stats';
console.log('[build] getDecideStats BUILD_TAG=' + BUILD_TAG);

// 近 N 天窗口起点（中国时区近似）
function sinceDate(days) {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600 * 1000);
  utc8.setDate(utc8.getDate() - days);
  return new Date(utc8.getTime() - 8 * 3600 * 1000);
}

exports.main = async (event) => {
  console.log('[build] getDecideStats BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未登录' };

  try {
    // 总决定次数
    const totalRes = await db.collection('recommend_history').where({ _openid: OPENID }).count();
    const total = totalRes.total || 0;

    // 近 3 天决定次数
    const since = sinceDate(3);
    const recentRes = await db.collection('recommend_history')
      .where({ _openid: OPENID, timestamp: _.gte(since) })
      .count();
    const recent3 = recentRes.total || 0;

    return {
      code: 200,
      data: { total, recent3 }
    };
  } catch (e) {
    console.error('[getDecideStats] error:', e);
    return { code: 500, msg: '统计失败', err: String((e && e.message) || e) };
  }
};
