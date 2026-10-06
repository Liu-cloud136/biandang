// fixCuisinePrefixEnv1 · env1 侧剥离菜名中的中式菜系/风味前缀
// 扫描 env1 全部菜名集合，剥离中式前缀；新名已存在则整条丢弃
// 集合：dish_lexicon / dish_lexicon_pending / dish_ai_profile_pending /
//       dish_nutrition_pending / dish_guide_pending / dish_image_pending / dish_env2_regen
// dryRun=true（默认）只统计不写；dryRun=false 才真正写
const BUILD_TAG = '2026-08-24.env1-fix-cuisine-prefix.v1';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PREFIXES = ['鲁菜', '川菜', '鲁味', '川味', '湘味', '湘菜', '家常', '苏菜', '浙菜', '闽菜', '徽菜', '鄂菜', '赣菜', '京菜', '沪菜', '东北菜', '西北菜', '客家菜', '潮菜', '本帮菜', '淮扬菜', '黔菜', '滇菜', '新疆菜', '清真', '风味', '私房', '土家', '苗家', '傣味', '宫廷', '老字号'];
const COLLECTIONS = ['dish_lexicon', 'dish_lexicon_pending', 'dish_ai_profile_pending', 'dish_nutrition_pending', 'dish_guide_pending', 'dish_image_pending', 'dish_env2_regen'];

function stripPrefix(name) {
  for (const p of PREFIXES) {
    if (name.startsWith(p)) return name.slice(p.length);
  }
  return null;
}

async function readAll(coll) {
  const out = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const r = await db.collection(coll).field({ name: true }).skip(offset).limit(PAGE).get();
    const b = r.data || [];
    out.push(...b);
    if (b.length < PAGE) break;
  }
  return out;
}

exports.main = async (event, context) => {
  console.log('[build] fixCuisinePrefixEnv1 BUILD_TAG=' + BUILD_TAG);
  const dryRun = !(event && event.dryRun === false);

  const summary = {};
  const allRename = [];
  const allDelete = [];

  for (const coll of COLLECTIONS) {
    let docs;
    try { docs = await readAll(coll); } catch (e) {
      summary[coll] = { err: (e && e.message) || e };
      continue;
    }
    // 全量 name 集合（含自身）用于重名判定
    const nameSet = new Set();
    for (const d of docs) if (d.name) nameSet.add(d.name);
    const dirty = docs.filter(d => d.name && stripPrefix(d.name) !== null);
    const toRename = [];
    const toDelete = [];
    for (const d of dirty) {
      const newName = stripPrefix(d.name);
      if (!newName || newName.trim().length === 0) {
        toDelete.push({ _id: d._id, name: d.name, reason: 'strip空' });
        continue;
      }
      const others = new Set(nameSet);
      others.delete(d.name);
      if (others.has(newName)) toDelete.push({ _id: d._id, name: d.name, newName, reason: '重名丢弃' });
      else toRename.push({ _id: d._id, name: d.name, newName });
    }
    summary[coll] = { total: docs.length, dirty: dirty.length, rename: toRename.length, delete: toDelete.length };
    for (const x of toRename) allRename.push({ coll, ...x });
    for (const x of toDelete) allDelete.push({ coll, ...x });
  }

  if (dryRun) {
    return { ok: true, dryRun: true, build: BUILD_TAG, perCollection: summary, totalRename: allRename.length, totalDelete: allDelete.length, renameSample: allRename.slice(0, 80), deleteSample: allDelete.slice(0, 80) };
  }

  let renamed = 0, deleted = 0, failed = 0;
  const errs = [];
  for (const x of allRename) {
    try { await db.collection(x.coll).doc(x._id).update({ data: { name: x.newName } }); renamed++; }
    catch (e) { failed++; if (errs.length < 20) errs.push({ coll: x.coll, name: x.name, err: (e && e.message) || e }); }
  }
  for (const x of allDelete) {
    try { await db.collection(x.coll).doc(x._id).remove(); deleted++; }
    catch (e) { failed++; if (errs.length < 20) errs.push({ coll: x.coll, name: x.name, err: (e && e.message) || e }); }
  }
  return { ok: true, dryRun: false, build: BUILD_TAG, renamed, deleted, failed, errs };
};
