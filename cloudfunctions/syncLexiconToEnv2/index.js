// syncLexiconToEnv2 · 词库(env1 dish_lexicon 主库五维 + 分表)单向同步到 env2 dish_mirror
// 全量扫描 dish_lexicon 主库(游标分页)，比对 env2 dish_mirror(游标分页)，按名字匹配对齐 7 件套字段
// 仅 env1 有而 env2 缺的字段才补齐(源字段非空)，不覆盖 env2 已有数据，避免来回污染
const BUILD_TAG = '2026-08-26.v2-write-shunt';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const ENV2_APPID = 'wx1111111111111111';
const ENV2_ENV_ID = process.env.ENV2_ENV_ID || '';
// 游标分页工具（规避 skip 上限 1000）
const { fetchAllNames, fetchAllIds, fetchAllNamesWhere, toNameSet } = require('./_shared/cursorFetch');

exports.main = async (event, context) => {
  console.log('[build] syncLexiconToEnv2 BUILD_TAG=' + BUILD_TAG);
  if (!ENV2_ENV_ID) return { ok: false, err: 'ENV2_ENV_ID 未配置' };
  let inst2, c2, _2;
  try {
    inst2 = new cloud.Cloud({ resourceAppid: ENV2_APPID, resourceEnv: ENV2_ENV_ID });
    await inst2.init();
    c2 = inst2.database();
    _2 = c2.command;
  } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }

  // 1) env1 全量 dish_lexicon（主库五维）
  let lex = [];
  try { lex = await fetchAllNames('dish_lexicon'); }
  catch (e) { return { ok: false, err: '读 dish_lexicon 失败：' + ((e && e.message) || e) }; }
  console.log('[sync] dish_lexicon 主库数=' + lex.length);

  // 2) env2 dish_mirror 全量（游标分页，按 name 建索引）
  let mirror = [];
  try {
    for (let off = 0; off < 10000; off += 100) {
      const r = await c2.collection('dish_mirror').skip(off).limit(100).get();
      mirror = mirror.concat(r.data || []);
      if (!r.data || r.data.length < 100) break;
    }
  } catch (e) { return { ok: false, err: '读 env2 dish_mirror 失败：' + ((e && e.message) || e) }; }
  console.log('[sync] env2 dish_mirror 数=' + mirror.length);

  const mirrorByName = {};
  mirror.forEach(m => { if (m && m.name) mirrorByName[m.name] = m; });

  let synced = 0, skipped = 0, failed = 0;
  const batchSize = event.batchSize || 30;
  let processed = 0;
  const details = [];

  for (const l of lex) {
    if (processed >= batchSize) break;
    const name = l.name;
    if (!name) continue;
    const m = mirrorByName[name];
    if (!m) { skipped++; details.push({ name, status: 'skip_no_mirror' }); continue; }
    processed++;
    try {
      // 对齐 7 件套：env1 有而 env2 缺的才补（env1 侧字段来自主库五维 + 分表）
      // 主库五维
      const updates = {};
      if (!m.profile && l.profile) updates.profile = l.profile;
      if (!m.nutrition && l.nutrition) updates.nutrition = l.nutrition;
      if (!m.guide && l.guide) updates.guide = l.guide;
      if (!m.ingredients && l.ingredients) updates.ingredients = l.ingredients;
      if (!m.review && l.review) updates.review = l.review;
      if (!m.steps && l.steps) updates.steps = l.steps;
      if (!m.tips && l.tips) updates.tips = l.tips;
      if (!m.imageUrl && l.imageUrl) updates.imageUrl = l.imageUrl;
      // 标记来源，避免 env2 regen 把它当 ai-generated 重跑
      if (m.source !== 'env1-lexicon') updates.source = 'env1-lexicon';
      // 7 件套齐则置 ready
      const seven = ['profile', 'nutrition', 'guide', 'ingredients', 'steps', 'tips', 'imageUrl'];
      const allHave = seven.every(k => (updates[k] !== undefined) || (m[k] && (Array.isArray(m[k]) ? m[k].length : true)));
      if (allHave) updates.status = 'ready';
      if (Object.keys(updates).length === 0) { skipped++; details.push({ name, status: 'skip_up_to_date' }); continue; }
      await c2.collection('dish_mirror').doc(m._id).update({ data: updates });
      synced++; details.push({ name, status: 'ok', fields: Object.keys(updates) });
    } catch (e) {
      failed++; details.push({ name, status: 'fail', err: (e && e.message) || 'unknown' });
    }
  }
  return { ok: true, build: BUILD_TAG, total: lex.length, mirrorTotal: mirror.length, synced, skipped, failed, batch: processed, remaining: lex.length - processed, details };
};
