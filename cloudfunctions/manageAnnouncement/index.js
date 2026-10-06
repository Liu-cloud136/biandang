const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 管理员 OPENID 白名单（环境变量优先；REAL_ADMIN 为兜底真实管理员，变量漏配时本地/后台仍能操作）
const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] manageAnnouncement BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] manageAnnouncement BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const { action, content } = event || {};
  try {
    if (action === 'get') {
      const res = await db.collection('announcements').orderBy('createdAt', 'desc').limit(1).get();
      const a = (res.data && res.data[0]) || null;
      return { code: 200, data: a ? { _id: a._id, content: a.content || '', active: !!a.active } : null };
    }

    if (action === 'save') {
      const c = (content || '').toString().trim();
      if (!c) return { code: 400, msg: '公告内容不能为空' };
      const res = await db.collection('announcements').orderBy('createdAt', 'desc').limit(1).get();
      const a = (res.data && res.data[0]) || null;
      if (a && a._id) {
        await db.collection('announcements').doc(a._id).update({ data: { content: c, active: true, updatedAt: db.serverDate() } });
        return { code: 200, msg: '已更新公告', data: { _id: a._id } };
      }
      const add = await db.collection('announcements').add({ data: { content: c, active: true, createdAt: db.serverDate(), updatedAt: db.serverDate() } });
      return { code: 200, msg: '已新建公告', data: { _id: add._id } };
    }

    return { code: 400, msg: '未知 action' };
  } catch (e) {
    return { code: 500, msg: (e && e.message) || '操作失败' };
  }
};
