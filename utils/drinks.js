// 配饮做法按钮显隐规则（结果页 pages/index 与历史详情页 pages/history 共用，唯一真源）
// 仅以下几类配饮不显示「做法」按钮，其余配饮（酸梅汤/柠檬水/果汁/清茶等）均显示。
const HIDDEN_DRINKS = ['可乐', '雪碧', '咖啡', '啤酒', '气泡水', '苏打水', '豆浆', '酸奶', '奶茶'];

// 某配饮是否展示「做法」按钮：不在 HIDDEN_DRINKS 列表里才显示。
function drinkShowCook(name) {
  const n = String(name || '');
  return !HIDDEN_DRINKS.some(d => n.indexOf(d) !== -1);
}

module.exports = { HIDDEN_DRINKS, drinkShowCook };
