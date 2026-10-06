const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 查询最新一条「已发布」公告，返回给所有用户（前端按 _id 去重只对新公告弹）
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] getAnnouncement BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] getAnnouncement BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  try {
    const res = await db.collection('announcements')
      .where({ active: true })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    if (res.data && res.data.length) {
      const a = res.data[0];
      return { code: 200, data: { _id: a._id, content: a.content || '' } };
    }
    return { code: 200, data: null };
  } catch (e) {
    // 集合未创建或查询异常时，宁可不显示公告也不要报错中断主流程
    return { code: 200, data: null };
  }
};
