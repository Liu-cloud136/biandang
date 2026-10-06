const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const BUILD_TAG = '2026-08-15.seed-ing-lib';

const INGREDIENTS = require('./ingredients.json');

exports.main = async (event, context) => {
  console.log('[build] seedIngLib BUILD_TAG=' + BUILD_TAG);
  const COL = 'ingredient_library';

  // 已有 value（小写）集合，避免重复
  const exist = new Set();
  let skip = 0;
  while (true) {
    const res = await db.collection(COL).field({ value: true }).skip(skip).limit(1000).get();
    (res.data || []).forEach(d => d.value && exist.add(String(d.value).trim().toLowerCase()));
    if (!res.data || res.data.length < 1000) break;
    skip += 1000;
  }

  // 去重后的待入库数组
  const docs = [];
  for (const it of INGREDIENTS) {
    const v = String(it.value || '').trim().toLowerCase();
    if (!v || exist.has(v)) continue;
    exist.add(v);
    docs.push({ value: v, category: it.category || '其他', userNos: [], addedAt: new Date() });
  }

  // 批量插入（每批 100）
  let added = 0;
  for (let i = 0; i < docs.length; i += 100) {
    const batch = docs.slice(i, i + 100);
    await db.collection(COL).add({ data: batch });
    added += batch.length;
  }

  const total = await db.collection(COL).count();
  return { added, total: total.total };
};
