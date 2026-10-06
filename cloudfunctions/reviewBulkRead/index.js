// ============================================================================
// reviewBulkRead · env1 内部批量读（review-web 专用）
// BUILD_TAG: 2026-09-14.review-bulk-read-v1
//
// 目的（2026-09-14 降耗 E）：review-web 原「按菜逐条读分表」（每菜 5~10 次外部请求）
// 改为「一次函数调用取一批」——外部只剩 1 次函数调用，省掉每次外部请求的「云开发API调用」计费，
// 且把 N 次往返压成 1 次；单次最多 MAX_IDS 个 _id（默认 200，内部按 100 分块）。
//
// 安全：①必须带 token（函数环境变量 REVIEW_TOKEN，与 scripts/.env 的 REVIEW_TOKEN 一致）
//       ②集合白名单（只读用到的这些）③只读、无写路径 ④ids 数量上限
// ============================================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const BUILD_TAG = '2026-09-14.review-bulk-read-v1';
const MAX_IDS = Math.max(1, Number(process.env.MAX_IDS) || 200);
const COLS = new Set([
  'dish_lexicon', 'dish_ingredients', 'dish_profile', 'dish_steps', 'dish_tips', 'dish_review',
  'dish_nutrition_v2', 'dish_image_v2', 'dish_recommend', 'dish_lexicon_pending',
  'dish_patch_backup', 'dish_guide_pending', 'dish_image_pending', 'sys_config', 'counters',
]);

exports.main = async (event) => {
  const ev = event || {};
  if (ev.task === 'health') return { ok: true, build: BUILD_TAG, maxIds: MAX_IDS, cols: COLS.size };
  console.log('[reviewBulkRead] BUILD_TAG=' + BUILD_TAG + ' col=' + ev.collection + ' ids=' + ((ev.ids || []).length));
  const expect = String(process.env.REVIEW_TOKEN || '');
  if (!expect || String(ev.token || '') !== expect) return { ok: false, err: 'unauthorized' };
  const col = String(ev.collection || '');
  if (!COLS.has(col)) return { ok: false, err: 'collection not allowed' };
  const ids = Array.isArray(ev.ids) ? ev.ids.map((x) => String(x || '')).filter(Boolean).slice(0, MAX_IDS) : [];
  const projection = (ev.projection && typeof ev.projection === 'object') ? ev.projection : null;
  try {
    const out = [];
    if (ids.length) {
      for (let i = 0; i < ids.length; i += 100) {
        let req = db.collection(col).where({ _id: _.in(ids.slice(i, i + 100)) });
        if (projection) req = req.field(projection);
        const r = await req.limit(100).get();
        out.push(...((r && r.data) || []));
      }
    } else if (ev.all) {
      const limit = Math.min(500, Math.max(1, Number(ev.limit) || 500));
      let req = db.collection(col);
      if (projection) req = req.field(projection);
      const r = await req.orderBy('_id', 'asc').limit(limit).get();
      out.push(...((r && r.data) || []));
    }
    return { ok: true, build: BUILD_TAG, collection: col, count: out.length, docs: out };
  } catch (e) {
    console.log('[reviewBulkRead] 读取失败 ' + col + '：' + ((e && e.message) || e));
    return { ok: false, err: String((e && e.message) || e).slice(0, 200) };
  }
};
