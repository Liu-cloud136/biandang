const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 用户个人「不喜欢的菜」管理（仅本人可见，供 AI 推荐规避）。
// 数据存于 user_preferences.avoidDishes（数组，由 submitDishFeedback 写入）。
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] userAvoid BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] userAvoid BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };
  const { action, dish } = event || {};
  try {
    if (action === 'list') {
      const r = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
      const list = (r.data && r.data.length && Array.isArray(r.data[0].avoidDishes)) ? r.data[0].avoidDishes : [];
      return { code: 200, data: list };
    }
    if (action === 'remove') {
      const d = (dish && String(dish).trim()) || '';
      if (!d) return { code: 400, msg: '菜名不能为空' };
      const r = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
      if (!(r.data && r.data.length)) return { code: 200, msg: '无记录' };
      await db.collection('user_preferences').doc(r.data[0]._id).update({
        data: { avoidDishes: _.pull(d) }
      });
      return { code: 200, msg: '已删除' };
    }
    return { code: 400, msg: '未知 action' };
  } catch (e) {
    return { code: 500, msg: (e && e.message) || '操作失败' };
  }
};
