// 菜品分表 schema 真源 · 幂等建表（阶段 1，2026-08-26；2026-08-26 续：存续表规范化）
// ---------------------------------------------------------------------------
// 以 docs/菜品库分表规范化执行方案.md 第四节为真源。
// 新建 5 张内容分表（冷/热层）+ 2 张存续表规范化分表(dish_nutrition_v2 / dish_image_v2)。
// 旧表(dish_lexicon 系 / dish_nutrition / dish_guide / dish_images) 由各自函数 ensureCollections 负责，本文件不重复建。
// 用法（部署时把 _shared 复制到写入函数目录后 require）：
//   const { ensureSchema } = require('./ensureSchema');
//   await ensureSchema(db);
// createCollection 失败（已存在）由 Promise.allSettled 吞掉，幂等安全。
// ---------------------------------------------------------------------------
const NEW_COLLECTIONS = [
  'dish_ingredients', // 食材清单（冷层）
  'dish_profile',     // 口味画像（热层，D1 反推 kind 用）
  'dish_recommend',   // 推荐理由（冷层）
  'dish_review',      // AI 点评 + difficulty（冷层）
  'dish_tips',        // 小贴士（冷层）
  'dish_steps',       // 做法步骤（冷层，2026-08-26 补充：从 dish_guide_pending.steps 迁入，废弃 dish_guide 旧表）
  // 2026-08-26 续 · 存续表规范化（D10 落地）：营养/图片 _id=norm_id 进分表体系，字段对齐、读取统一
  'dish_nutrition_v2', // 营养（冷层）：{ nutrition:[{name,amount,unit}], source, ts }，_id=norm_id
  'dish_image_v2',     // 菜图（冷层）：{ imageUrl, status, source, ts }，_id=norm_id
];

async function ensureSchema(db) {
  if (!db || typeof db.createCollection !== 'function') {
    console.warn('[ensureSchema] 传入 db 不可用，跳过建表');
    return;
  }
  const tasks = NEW_COLLECTIONS.map((name) =>
    db.createCollection(name).then(
      () => console.log('[ensureSchema] 已建/已存在：' + name),
      (e) => console.log('[ensureSchema] 建表跳过(' + name + ')：' + ((e && e.message) || e))
    )
  );
  await Promise.allSettled(tasks);
}

module.exports = { ensureSchema, NEW_COLLECTIONS };
