const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-11.accepted-only';
console.log('[build] getHistory BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] getHistory BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const res = await db.collection('recommend_history')
    .where({ _openid: OPENID })
    .orderBy('timestamp', 'desc')
    .limit(50)
    .get();

  // 仅返回「已采纳」的决定记录（selected 为非空数组）；未采纳的不再展示
  const data = res.data.filter(d => Array.isArray(d.selected) && d.selected.length > 0);

  return { code: 200, data };
};
