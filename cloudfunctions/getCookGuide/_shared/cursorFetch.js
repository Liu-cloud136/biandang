// cursorFetch —— 全量拉取统一用 _id 游标分页，规避云开发 skip 上限 1000
// 适用于：集合数据量可能超过 1000 条的全量扫描（去重集、比对待同步集等）
// 用法：const all = await fetchAll('dish_lexicon', { name: true });
//       const ids = await fetchAllIds('dish_nutrition_v2'); // 仅 _id 集合

let cloud;
try { cloud = require('wx-server-sdk'); } catch (e) { cloud = require('@cloudbase/node-sdk'); }
const db = cloud.database();
const _ = db.command;

const PAGE = 100;

async function onePage(coll, fieldSpec, lastId) {
  let q = db.collection(coll).orderBy('_id', 'asc').limit(PAGE);
  if (fieldSpec) q = q.field(fieldSpec);
  if (lastId) q = q.where({ _id: _.gt(lastId) });
  const r = await q.get().catch(() => ({ data: [] }));
  return r.data || [];
}

// 拉全量文档（带 field 投影）。返回数组。
async function fetchAll(coll, fieldSpec) {
  const out = [];
  let lastId = '';
  for (;;) {
    const arr = await onePage(coll, fieldSpec, lastId);
    for (const d of arr) out.push(d);
    if (arr.length < PAGE) break;
    lastId = arr[arr.length - 1]._id;
  }
  return out;
}

// 仅拉 _id 列表（去重集场景）
async function fetchAllIds(coll) {
  const out = [];
  let lastId = '';
  for (;;) {
    const arr = await onePage(coll, { _id: true }, lastId);
    for (const d of arr) if (d._id) out.push(d._id);
    if (arr.length < PAGE) break;
    lastId = arr[arr.length - 1]._id;
  }
  return out;
}

// 拉 name 列表（构建已入库名集合，用于查重）
async function fetchAllNames(coll) {
  const out = [];
  let lastId = '';
  for (;;) {
    const arr = await onePage(coll, { _id: true, name: true }, lastId);
    for (const d of arr) if (d.name) out.push(d.name);
    if (arr.length < PAGE) break;
    lastId = arr[arr.length - 1]._id;
  }
  return out;
}

function toNameSet(docs, normFn) {
  const s = new Set();
  const norm = normFn || ((x) => x);
  for (const n of docs) if (n) s.add(norm(n));
  return s;
}

// 带 where 条件的 name 列表（如仅 source 限定的 pending）
async function fetchAllNamesWhere(coll, whereObj) {
  const out = [];
  let lastId = '';
  for (;;) {
    let q = db.collection(coll).field({ _id: true, name: true }).orderBy('_id', 'asc').limit(PAGE);
    if (lastId) {
      // 游标分页:把 whereObj 与 _id 游标条件合并为单次 where(云数据库不允许连续两次 .where())
      const cond = Object.assign({}, whereObj, { _id: _.gt(lastId) });
      q = q.where(cond);
    } else if (whereObj) {
      q = q.where(whereObj);
    }
    const r = await q.get().catch(() => ({ data: [] }));
    const arr = r.data || [];
    for (const d of arr) if (d.name) out.push(d.name);
    if (arr.length < PAGE) break;
    lastId = arr[arr.length - 1]._id;
  }
  return out;
}

module.exports = { fetchAll, fetchAllIds, fetchAllNames, fetchAllNamesWhere, toNameSet };
