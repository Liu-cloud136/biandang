// 菜名弱归一真源（D12）
// ---------------------------------------------------------------------------
// 唯一主键真源：norm_id / 各分表 _id / 存续表(_id=菜名) 一律经此归一，
// 保证与 dish_nutrition_v2._id / dish_image_v2._id / dish_lexicon.norm_id 同口径零迁移（旧表 dish_nutrition/dish_guide/dish_images 已删）。
// 语义：折叠内部连续空白为单空格 + 去首尾空格。
// 职责分离：env2 强归一（bypassGenDish.normalizeDishName）仅作去重池口径，
//           不参与 env1 主键；env1 主键只认本弱归一。
// 口径对齐：与 manageLexicon:50 / manageEnv2Regen:24 既有实现完全一致。
// ---------------------------------------------------------------------------
function normLexName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

module.exports = { normLexName };
