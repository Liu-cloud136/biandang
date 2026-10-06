const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 管理员 OPENID 白名单（环境变量优先；REAL_ADMIN 为兜底真实管理员，变量漏配时本地/后台仍能操作）
const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));

// 使用说明后台编辑。文档固定 _id='guide' 单条全量覆盖。
// 文本格式：每行一条，`标题｜正文`（第一个全角竖线分割）；行首 `*` 标记高亮重要条。
const BUILD_TAG = '2026-08-14.guide';
console.log('[build] manageGuide BUILD_TAG=' + BUILD_TAG);

const DOC_ID = 'guide';

function parseGuide(text) {
  const items = [];
  const raw = (text || '').split('\n');
  for (const lineRaw of raw) {
    const line = lineRaw.replace(/\r/g, '').trim();
    if (!line) continue;
    let important = false;
    let content = line;
    if (content.charAt(0) === '*') { important = true; content = content.slice(1).trim(); }
    if (!content) continue;
    const idx = content.indexOf('｜');
    if (idx === -1) continue;
    const h = content.slice(0, idx).trim().replace(/^\d+[.．、]\s*/, ''); // 兼容粘贴带编号
    const body = content.slice(idx + 1).trim();
    if (!h || !body) continue;
    items.push({ h, body, important });
  }
  return items;
}

exports.main = async (event) => {
  console.log('[build] manageGuide BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const { action, content } = event || {};
  try {
    if (action === 'get') {
      const res = await db.collection('guide_docs').orderBy('createdAt', 'desc').limit(1).get();
      const d = (res.data && res.data[0]) || null;
      return { code: 200, data: d ? { content: d.content || '', active: !!d.active } : null };
    }

    if (action === 'save') {
      const c = (content || '').toString().trim();
      if (!c) return { code: 400, msg: '说明内容不能为空' };
      const items = parseGuide(c);
      if (!items.length) return { code: 400, msg: '格式不对：每行一条「标题｜正文」，标题与正文用全角竖线｜分隔' };

      const now = db.serverDate();
      // 固定 _id='guide'，不存在则新建（避免重复文档）
      let existed = null;
      try { existed = await db.collection('guide_docs').doc(DOC_ID).get(); } catch (e) { existed = null; }

      if (existed && existed.data) {
        await db.collection('guide_docs').doc(DOC_ID).update({ data: { content: c, active: true, updatedAt: now } });
        return { code: 200, msg: '已更新使用说明', data: { count: items.length } };
      }
      await db.collection('guide_docs').add({ data: { _id: DOC_ID, content: c, active: true, createdAt: now, updatedAt: now } });
      return { code: 200, msg: '已新建使用说明', data: { count: items.length } };
    }

    return { code: 400, msg: '未知 action' };
  } catch (e) {
    return { code: 500, msg: (e && e.message) || '操作失败' };
  }
};
