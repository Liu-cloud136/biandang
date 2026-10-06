const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 全局「禁用词/禁用食材」后台管理。禁用词由管理员手动维护（用户反馈怪名后，人工把食材/词缀加进来），
// getRecommendation 生成时会读取本集合并注入提示词 + 生成后兜底过滤，从而减少「蒜香拌韭菜」这类怪异拼接名。
// 文档结构：{ term: '韭菜', type: 'ingredient'|'word'|'dish'|'pattern', note: '用户反馈不爱吃', ts: Date }
// 后台管理工具：fail-closed 校验管理员；REAL_ADMIN 为兜底真实管理员，变量漏配时仍能操作。
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] manageBlocklist BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] manageBlocklist BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const ctx = cloud.getWXContext();
  // 优先用调用方显式传入的可信身份（manageFeedback 等已通过管理员校验的内部互调场景，
  // 云函数互调时 cloud.getWXContext().OPENID 为空，会导致误判无权限）；回退到上下文 OPENID。
  const OPENID = (event && event.OPENID) || ctx.OPENID;
  const REAL_ADMIN = '';
  const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));
  if (!isAdminOpenid(OPENID)) {
    return { code: 403, msg: '无权限' };
  }

  const { action, term, type, note, id } = event || {};
  try {
    if (action === 'list') {
      const res = await db.collection('name_blocklist').orderBy('ts', 'desc').limit(200).get();
      return { code: 200, data: res.data || [] };
    }

    if (action === 'add') {
      const t = (term && String(term).trim()) || '';
      if (!t) return { code: 400, msg: 'term 不能为空' };
      // 去重：同 term 已存在则更新类型/备注，避免重复文档
      const exist = await db.collection('name_blocklist').where({ term: t }).limit(1).get();
      if (exist.data && exist.data.length) {
        const eid = exist.data[0]._id;
        await db.collection('name_blocklist').doc(eid).update({
          data: { type: type || exist.data[0].type || 'word', note: (note || '').toString(), ts: new Date() }
        });
        return { code: 200, msg: '已更新', data: { _id: eid, term: t } };
      }
      const add = await db.collection('name_blocklist').add({
        data: { term: t, type: type || 'word', note: (note || '').toString(), ts: new Date() }
      });
      return { code: 200, msg: '已添加', data: { _id: add._id, term: t } };
    }

    if (action === 'remove') {
      if (!id) return { code: 400, msg: '缺少 id' };
      await db.collection('name_blocklist').doc(id).remove();
      return { code: 200, msg: '已删除' };
    }

    return { code: 400, msg: '未知 action：' + action };
  } catch (e) {
    console.error('manageBlocklist error:', e);
    return { code: 500, msg: (e && e.message) || '操作失败' };
  }
};
