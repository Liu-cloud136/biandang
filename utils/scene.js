// 用餐场景：顺序即“正常用餐时间排序”，小吃排最后。
// 同时被 pages/setup（场景选择）、pages/history/detail（历史按时间排序）复用，改这里即可全量生效。
const SCENE = ['早餐', '午餐', '下午茶', '晚餐', '夜宵', '小吃'];
const SCENE_ORDER = { '早餐': 1, '午餐': 2, '下午茶': 3, '晚餐': 4, '夜宵': 5, '小吃': 6 };
function sceneRank(s) {
  return SCENE_ORDER[s] != null ? SCENE_ORDER[s] : 99;
}
// 预计算场景选中态（WXML 不支持方法调用，需预计算为 {label, sel} 数组）
function sceneListSel(scene) {
  return SCENE.map(s => ({ label: s, sel: (scene || []).indexOf(s) > -1 }));
}

// 按当前小时返回默认用餐场景（单场景；小吃为加餐不参与时段默认）
// 时段边界归属：整点边界归「后」一时段（5 点起算新一天：早餐 5–10，午餐 10–14，下午茶 14–17，晚餐 17–21，夜宵 21–次日5）
function defaultSceneByHour(now) {
  const d = now instanceof Date ? now : new Date();
  const h = d.getHours();
  if (h >= 5 && h < 10) return '早餐';
  if (h >= 10 && h < 14) return '午餐';
  if (h >= 14 && h < 17) return '下午茶';
  if (h >= 17 && h < 21) return '晚餐';
  return '夜宵';
}
module.exports = { SCENE, SCENE_ORDER, sceneRank, sceneListSel, defaultSceneByHour };
