const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 管理员 OPENID 白名单（环境变量优先；REAL_ADMIN 为兜底真实管理员，变量漏配时本地/后台仍能操作）
const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));
// 合并内部密钥：manageContrib 后台触发合并时传给 mergeContributions 做受信鉴权（与 mergeContributions 同源常量）
const SYS_SECRET = process.env.MERGE_SYS_SECRET || '';

// 食材分类白名单（与 utils/config.js ING_CATEGORIES 一致；云端不依赖前端 require，自存副本）
const ING_CATEGORIES = ['蔬菜菌菇', '肉禽蛋', '水产海鲜', '主食杂粮', '豆制品', '调味干货', '水果', '其他'];

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] manageContrib BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] manageContrib BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const { action, status, id, newStatus, force, category } = event || {};
  try {
    if (action === 'list') {
      const q = {};
      // 'review' = 待人工复核：AI 待定(pending) + AI 通过待复核(valid) 一并归入「待审核」
      if (status === 'review') q.status = _.in(['pending', 'valid']);
      else if (status) q.status = status;
      const res = await db.collection('dish_contrib').where(q).orderBy('createdAt', 'desc').limit(100).get();
      return { code: 200, data: res.data || [] };
    }

    if (action === 'stats') {
      const counts = {};
      for (const s of ['valid', 'pending', 'dup', 'fabricated', 'merged', 'blocked']) {
        const r = await db.collection('dish_contrib').where({ status: s }).count().catch(() => ({ total: 0 }));
        counts[s] = r.total || 0;
      }
      return { code: 200, data: counts };
    }

    if (action === 'setStatus') {
      if (!id) return { code: 400, msg: '缺少 id' };
      const allowed = ['valid', 'dup', 'fabricated', 'pending', 'blocked', 'merged'];
      if (!allowed.includes(newStatus)) return { code: 400, msg: '非法状态' };
      await db.collection('dish_contrib').doc(id).update({ data: { status: newStatus, adminSetAt: new Date() } });
      return { code: 200, msg: '已更新状态为 ' + newStatus };
    }

    if (action === 'delete') {
      // 真正删除一条贡献记录（如 fabricated/虚假食材需彻底移除时）
      if (!id) return { code: 400, msg: '缺少 id' };
      await db.collection('dish_contrib').doc(id).remove();
      return { code: 200, msg: '已删除记录' };
    }

    if (action === 'merge') {
      // 人工强制合并：仍走 mergeContributions 的加锁与发放逻辑，force 绕过阈值
      const r = await cloud.callFunction({ name: 'mergeContributions', data: { action: 'merge', force: !!force, _sys: SYS_SECRET } });
      return (r && r.result) ? r.result : { code: 500, msg: '合并调用失败' };
    }

    if (action === 'mergeOne') {
      // 单条合并：把指定贡献入库并发放次数
      if (!id) return { code: 400, msg: '缺少 id' };
      const r = await cloud.callFunction({ name: 'mergeContributions', data: { action: 'mergeOne', id, _sys: SYS_SECRET } });
      return (r && r.result) ? r.result : { code: 500, msg: '合并调用失败' };
    }

    if (action === 'setCategory') {
      // 修正食材错误分类：同步更新贡献记录与已入库的食材库（用户可见分类来自 ingredient_library）
      if (!id) return { code: 400, msg: '缺少 id' };
      const cat = String(category || '').trim();
      if (ING_CATEGORIES.indexOf(cat) < 0) return { code: 400, msg: '非法分类' };
      const rec = await db.collection('dish_contrib').doc(id).get().catch(() => ({ data: null }));
      const item = rec && rec.data;
      if (!item) return { code: 404, msg: '记录不存在' };
      if (item.type !== 'ingredient') return { code: 400, msg: '仅食材可改分类' };
      await db.collection('dish_contrib').doc(id).update({ data: { category: cat, adminSetAt: new Date() } });
      // 已合并入库的食材库一并同步（按归一化 value 匹配）
      await db.collection('ingredient_library').where({ value: item.value }).update({ data: { category: cat } }).catch(() => {});
      return { code: 200, msg: '已更新分类为「' + cat + '」' };
    }

    return { code: 400, msg: '未知 action' };
  } catch (e) {
    return { code: 500, msg: (e && e.message) || '操作失败' };
  }
};
