const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] getHistoryDetail BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] getHistoryDetail BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const { id } = event || {};
  if (!id) return { code: 400, msg: '缺少 id' };

  const res = await db.collection('recommend_history').doc(id).get();
  const doc = res.data && res.data[0] ? res.data[0] : (res.data || null);
  if (!doc || doc._openid !== OPENID) return { code: 404, msg: '记录不存在' };

  return { code: 200, data: doc };
};
