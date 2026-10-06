// manageEnv2Regen · 一键同步 env2 → env1（拉新菜产物到审核池）+ 兜底修剪 env2 僵死 pending
// 另含 rejectWithReason：env1 审核池整菜驳回（删 _pending 五表 + 联动删 env2 同名菜 + 写审计）
// 真机链路：管理员打开 env1 小程序触发（跨账号需真机）
// BUILD_TAG: 2026-08-26.v7-deletelexicon-full 另含 listLexicon（tab20 菜库总览）/ deleteLexicon（补全新分表+_pending，纯本地）
const BUILD_TAG = '2026-08-26.v7-deletelexicon-full';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const ENV2_APPID = 'wx1111111111111111';
const ENV2_ENV_ID = process.env.ENV2_ENV_ID || '';

let cursorFetch;
try { ({ fetchAllNames, fetchAllIds, fetchAllNamesWhere, toNameSet } = require('./cursorFetch')); }
catch (e) { ({ fetchAllNames, fetchAllIds, fetchAllNamesWhere, toNameSet } = require('./_shared/cursorFetch')); }
let ensureSchema;
try { ({ ensureSchema } = require('./ensureSchema')); }
catch (e) { ({ ensureSchema } = require('./_shared/ensureSchema')); }

exports.main = async (event, context) => {
  console.log('[build] manageEnv2Regen BUILD_TAG=' + BUILD_TAG);

  // —— env1 菜库总览（tab 20）：读 dish_lexicon 正式库（纯本地，不依赖跨账号）——
  if (event.action === 'listLexicon') {
    const offset = event.offset || 0;
    const limit = event.limit || 100;
    const kw = (event.keyword || '').trim();
    let base = db.collection('dish_lexicon');
    if (kw) base = base.where({ name: db.RegExp({ regexp: kw, options: 'i' }) });
    const [listR, cntR] = await Promise.all([
      base.orderBy('ts', 'desc').skip(offset).limit(limit).get(),
      base.count(),
    ]);
    const list = (listR.data || []).map(it => ({
      _id: it._id, name: it.name,
      cuisine: it.cuisine || '', category: it.category || '',
      source: it.source || '', imageUrl: it.imageUrl || '', ts: it.ts || 0,
    }));
    return { ok: true, build: BUILD_TAG, list, total: (cntR && cntR.total) || 0 };
  }

  // —— tab20 菜库总览"驳回丢弃"：从 dish_lexicon 正式库 + 全分表整菜删除同名（纯本地，不依赖跨账号）——
  if (event.action === 'deleteLexicon') {
    const name = (event.name || '').trim();
    if (!name) return { ok: false, err: 'name 缺失' };
    // 旧表（_id 随机、含 name 字段）按 where(name) 删
    const whereTables = ['dish_lexicon', 'dish_ai_profile', 'dish_nutrition', 'dish_guide', 'dish_image'];
    // 新规范化分表（_id = norm_id = 归一化菜名）按 doc(name) 删，避免 where(name) 匹配不到无 name 字段的记录
    const docTables = ['dish_ingredients', 'dish_steps', 'dish_review', 'dish_tips', 'dish_nutrition_v2', 'dish_profile', 'dish_recommend', 'dish_image_v2', 'dish_lexicon_pending', 'dish_ai_profile_pending', 'dish_nutrition_pending', 'dish_guide_pending', 'dish_image_pending'];
    const writes = [];
    for (const t of whereTables) writes.push(db.collection(t).where({ name }).remove().then(r => (r && r.stats && r.stats.removed) || 0).catch(() => 0));
    for (const t of docTables) writes.push(db.collection(t).doc(name).remove().then(() => 1).catch(() => 0));
    const removed = await Promise.all(writes);
    const totalRemoved = removed.reduce((a, b) => a + b, 0);
    await db.collection('reject_audit').add({ data: { name, reasonCode: event.reasonCode || 'lexicon-reject', reason: event.reason || '菜库总览驳回丢弃', ts: Date.now() } }).catch(() => null);
    return { ok: true, build: BUILD_TAG, name, removed, totalRemoved };
  }

  if (!ENV2_ENV_ID) return { ok: false, err: 'ENV2_ENV_ID 未配置' };
  let inst2, c2, _2;
  try {
    inst2 = new cloud.Cloud({ resourceAppid: ENV2_APPID, resourceEnv: ENV2_ENV_ID });
    await inst2.init();
    c2 = inst2.database();
    _2 = c2.command;
  } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }

  // —— env1 审核池整菜驳回：删 _pending 五表 + 联动删 env2 同名菜 + 写审计 ——
  if (event.action === 'rejectWithReason') {
    const id = event.id;
    const reasonCode = event.reasonCode || 'other';
    const reason = event.reason || '管理员驳回';
    if (!id) return { ok: false, err: 'id 缺失' };
    const rec = await db.collection('dish_lexicon_pending').doc(id).get().catch(() => null);
    const name = (rec && rec.data && rec.data.name) || '';
    const writes = [];
    if (name) {
      writes.push(db.collection('dish_lexicon_pending').where({ name }).remove());
      writes.push(db.collection('dish_ai_profile_pending').where({ name }).remove());
      writes.push(db.collection('dish_nutrition_pending').where({ name }).remove());
      writes.push(db.collection('dish_guide_pending').where({ name }).remove());
      writes.push(db.collection('dish_image_pending').where({ name }).remove());
      writes.push(db.collection('reject_audit').add({ data: { name, reasonCode, reason, ts: Date.now() } }));
    }
    await Promise.all(writes).catch(() => null);
    // 联动 env2：删除同名菜，防止下次同步又拉回
    let env2Deleted = 0;
    try {
      if (name) {
        const r2 = await c2.collection('dish_mirror').where({ name }).remove();
        env2Deleted = (r2 && r2.stats && r2.stats.removed) || 0;
      }
    } catch (e) { console.warn('[regen] 联动删 env2 失败（忽略）：' + ((e && e.message) || e)); }
    return { ok: true, build: BUILD_TAG, env2Deleted, name };
  }

  // 阶段 1：补齐新分表（幂等）
  await ensureSchema(db);

  // 阶段 0：兜底修剪 env2 僵死 pending（status=pending 超过 72h 且有 7 件套则置 ready；彻底卡死则删）
  let pruned = 0;
  try {
    const now = Date.now();
    const stale = await c2.collection('dish_mirror').where({
      status: 'pending',
      createdAt: _2.lt(now - 72 * 3600 * 1000),
    }).limit(200).get();
    for (const d of (stale.data || [])) {
      const seven = ['profile', 'nutrition', 'guide', 'ingredients', 'steps', 'tips', 'imageUrl'];
      const ready = seven.every(k => d[k] && (Array.isArray(d[k]) ? d[k].length : true));
      if (ready) { await c2.collection('dish_mirror').doc(d._id).update({ data: { status: 'ready' } }); pruned++; }
    }
  } catch (e) { console.warn('[regen] 修剪 pending 失败（忽略）：' + ((e && e.message) || e)); }

  // 阶段 2：拉 env2 dish_mirror（7 件套齐全）→ 同步到 env1 审核池
  let dishes = [];
  try {
    for (let off = 0; off < 2000; off += 100) {
      const r = await c2.collection('dish_mirror').where({
        source: _2.in(['ai-generated', 'regenerate']),
        status: 'ready',
        profile: _2.exists(true),
        nutrition: _2.exists(true),
        guide: _2.exists(true),
        ingredients: _2.exists(true),
        steps: _2.exists(true),
        tips: _2.exists(true),
        imageUrl: _2.exists(true),
      }).skip(off).limit(100).get();
      dishes = dishes.concat(r.data || []);
      if (!r.data || r.data.length < 100) break;
    }
  } catch (e) { return { ok: false, err: '查 env2 dish_mirror 失败：' + ((e && e.message) || e) }; }

  const source = 'env2-newdish';
  const ts = Date.now();
  const force = event.force === true;
  const batchSize = event.batchSize || 20;
  let synced = 0, skipped = 0, failed = 0, newProcessed = 0;
  const details = [];
  let existingNames = new Set();
  try {
    existingNames = toNameSet(await fetchAllNamesWhere('dish_lexicon_pending', { source }), (n) => n);
    for (const n of await fetchAllNames('dish_lexicon')) existingNames.add(n);
  } catch (e) { console.warn('[regen] 读去重集合失败：' + ((e && e.message) || e)); }

  for (const d of dishes) {
    if (newProcessed >= batchSize) break;
    const name = d.name;
    // name 守卫：跳过缺 name 的 env2 记录，避免写入空壳 pending（R-Sync 治本）
    if (!name || !String(name).trim()) { skipped++; details.push({ name: (name || '(空名)'), status: 'skip_empty_name' }); continue; }
    if (existingNames.has(name)) { skipped++; details.push({ name, status: 'skip' }); continue; }
    const ex = await db.collection('dish_lexicon_pending').where({ name, source }).limit(1).get();
    if (ex && ex.data && ex.data.length && !force) { skipped++; details.push({ name, status: 'skip_ex' }); continue; }
    newProcessed++;
    try {
      const writes = [
        db.collection('dish_lexicon_pending').add({ data: { name, source, cuisine: (d.profile && d.profile.cuisine) || d.cuisine || '家常', category: d.category || '', mealTime: d.mealTime || [], season: d.season || ['spring', 'summer', 'autumn', 'winter'], reason: d.reason || ('env2 AI 新菜'), status: 'pending', ts } }),
        db.collection('dish_ai_profile_pending').add({ data: { name, source, profile: d.profile, status: 'pending', ts } }),
        db.collection('dish_nutrition_pending').add({ data: { name, source, nutrition: d.nutrition, status: 'pending', ts } }),
        db.collection('dish_guide_pending').add({ data: { name, source, guide: d.guide, review: d.review || null, difficulty: d.difficulty || null, tips: d.tips || null, ingredients: d.ingredients || null, steps: d.steps || null, status: 'pending', ts } }),
      ];
      await Promise.all(writes);
      synced++; details.push({ name, status: 'ok' });
    } catch (e) { failed++; details.push({ name, status: 'fail', err: (e && e.message) || 'unknown' }); }
  }
  return { ok: true, build: BUILD_TAG, total: dishes.length, pruned, synced, skipped, failed, batch: newProcessed, remaining: dishes.length - newProcessed, details };
};
