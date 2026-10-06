// fixCuisinePrefix · env2 侧剥离菜名中的中式菜系/风味前缀
// 规则：name 以 {中式前缀} 开头 → 去掉前缀得 newName
//   - newName 合法 且 集合内无重复（除自身）→ rename
//   - newName 已存在（含自身以外记录）→ 整条丢弃（删除该脏记录）
// 日式/泰式/韩式/东南亚 等天然带国别前缀的保留不动
// 全程客户端 startsWith 判断，不用服务端 RegExp（规避 db.RegExp 兼容问题）
// dryRun=true（默认）只统计不写；dryRun=false 才真正 rename/delete
const BUILD_TAG = '2026-08-24.env2-fix-cuisine-prefix.v2';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PREFIXES = ['鲁菜', '川菜', '鲁味', '川味', '湘味', '湘菜', '家常', '苏菜', '浙菜', '闽菜', '徽菜', '鄂菜', '赣菜', '京菜', '沪菜', '东北菜', '西北菜', '客家菜', '潮菜', '本帮菜', '淮扬菜', '黔菜', '滇菜', '新疆菜', '清真', '风味', '私房', '土家', '苗家', '傣味', '宫廷', '老字号'];

function stripPrefix(name) {
  for (const p of PREFIXES) {
    if (name.startsWith(p)) return name.slice(p.length);
  }
  return null;
}

exports.main = async (event, context) => {
  console.log('[build] fixCuisinePrefix BUILD_TAG=' + BUILD_TAG);
  const dryRun = !(event && event.dryRun === false);

  // 1) 全量读 dish_mirror（_id, name, cuisine）
  const all = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const r = await db.collection('dish_mirror').field({ name: true, cuisine: true }).skip(offset).limit(PAGE).get();
    const batch = r.data || [];
    all.push(...batch);
    if (batch.length < PAGE) break;
  }

  // 2) 全量 name 集合（用于重名判定）
  const nameSet = new Set();
  for (const d of all) if (d.name) nameSet.add(d.name);

  // 3) 找脏菜（客户端 startsWith）
  const dirty = all.filter(d => d.name && stripPrefix(d.name) !== null);

  const toRename = [];
  const toDelete = [];
  for (const d of dirty) {
    const newName = stripPrefix(d.name);
    if (!newName || newName.trim().length === 0) {
      toDelete.push({ _id: d._id, name: d.name, reason: 'strip 后为空' });
      continue;
    }
    const others = new Set(nameSet);
    others.delete(d.name);
    if (others.has(newName)) {
      toDelete.push({ _id: d._id, name: d.name, newName, reason: '重名丢弃' });
    } else {
      toRename.push({ _id: d._id, name: d.name, newName });
    }
  }

  if (dryRun) {
    return {
      ok: true, dryRun: true, build: BUILD_TAG,
      total: all.length,
      dirtyCount: dirty.length,
      renameCount: toRename.length,
      deleteCount: toDelete.length,
      renameSample: toRename.slice(0, 60),
      deleteSample: toDelete.slice(0, 60),
    };
  }

  let renamed = 0, deleted = 0, failed = 0;
  const errs = [];
  for (const x of toRename) {
    try { await db.collection('dish_mirror').doc(x._id).update({ data: { name: x.newName } }); renamed++; }
    catch (e) { failed++; if (errs.length < 20) errs.push({ name: x.name, err: (e && e.message) || e }); }
  }
  for (const x of toDelete) {
    try { await db.collection('dish_mirror').doc(x._id).remove(); deleted++; }
    catch (e) { failed++; if (errs.length < 20) errs.push({ name: x.name, err: (e && e.message) || e }); }
  }
  return { ok: true, dryRun: false, build: BUILD_TAG, renamed, deleted, failed, errs };
};
