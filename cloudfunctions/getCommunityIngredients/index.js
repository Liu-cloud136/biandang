const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 读取「社区贡献食材库」(ingredient_library)，供前端偏好选择「社区贡献食材名称」步骤展示。
// 返回 {value, category} 列表（分类来自贡献时用户所选）；库为空或异常时返回空数组。
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] getCommunityIngredients BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] getCommunityIngredients BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  try {
    const res = await db.collection('ingredient_library').field({ value: true, category: true, userNos: true }).limit(1000).get();
    const list = (res.data || [])
      .map(d => ({ value: d.value, category: (d.category && String(d.category).trim()) || '其他', userNos: Array.isArray(d.userNos) ? d.userNos : [] }))
      .filter(x => x.value);
    return { code: 200, list };
  } catch (e) {
    console.error('[getCommunityIngredients] failed:', e && e.message);
    return { code: 200, list: [] };
  }
};
