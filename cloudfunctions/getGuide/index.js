const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 查询最新一份「使用说明」文档（全量覆盖，单文档），返回解析后的条目数组，供前端渲染。
// 解析规则：每行一条；「标题｜正文」用第一个全角竖线分割；行首 `*` 标记高亮重要条。
// 集合未创建/无数据时返回空数组，前端用内置默认文案兜底，不中断主流程。
const BUILD_TAG = '2026-08-14.guide';
console.log('[build] getGuide BUILD_TAG=' + BUILD_TAG);

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
  console.log('[build] getGuide BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  try {
    const res = await db.collection('guide_docs')
      .where({ active: true })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    if (res.data && res.data.length) {
      const d = res.data[0];
      return { code: 200, data: { items: parseGuide(d.content || ''), updatedAt: d.updatedAt || null } };
    }
    return { code: 200, data: { items: [] } };
  } catch (e) {
    return { code: 200, data: { items: [] } };
  }
};
