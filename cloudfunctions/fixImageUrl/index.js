const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const BUILD_TAG = '2026-08-26.v2-write-shunt';

exports.main = async (event = {}, context) => {
  console.log('[build] fixImageUrl BUILD_TAG=' + BUILD_TAG);
  const map = {};
  let off = 0;
  while (true) {
    const res = await db.collection('dish_image_v2').skip(off).limit(100).field({ _id: true, imageUrl: true }).get();
    for (const r of res.data) if (r._id && r.imageUrl) map[r._id] = r.imageUrl;
    if (res.data.length < 100) break;
    off += 100;
  }
  console.log('[fiximg] dish_image_v2 映射条数:', Object.keys(map).length);

  const extractName = (url) => {
    if (typeof url !== 'string') return null;
    const m = url.match(/recommend-images\/(.+)\.png$/);
    return m ? m[1] : null;
  };

  // recommend_history
  const hist = await db.collection('recommend_history').skip(0).limit(1000).get();
  let histFixed = 0;
  for (const doc of hist.data) {
    const recs = doc.recommendations;
    if (!Array.isArray(recs)) continue;
    let changed = false;
    const newRecs = recs.map(block => {
      const fixArr = (arr) => (Array.isArray(arr) ? arr.map(it => {
        if (!it || typeof it !== 'object') return it;
        const name = extractName(it.imageUrl);
        if (name && map[name] && it.imageUrl !== map[name]) { changed = true; histFixed++; return { ...it, imageUrl: map[name] }; }
        return it;
      }) : arr);
      return { ...block, dishes: fixArr(block.dishes), drinks: fixArr(block.drinks), staples: fixArr(block.staples) };
    });
    if (changed) await db.collection('recommend_history').doc(doc._id).update({ data: { recommendations: newRecs } });
  }
  console.log('[fiximg] recommend_history 修复计数:', histFixed, '总条数:', hist.data.length);

  // favorites
  const favs = await db.collection('favorites').skip(0).limit(1000).get();
  let favFixed = 0;
  for (const doc of favs.data) {
    const name = extractName(doc.imageUrl);
    if (name && map[name] && doc.imageUrl !== map[name]) {
      await db.collection('favorites').doc(doc._id).update({ data: { imageUrl: map[name] } });
      favFixed++;
    }
  }
  console.log('[fiximg] favorites 修复计数:', favFixed, '总条数:', favs.data.length);
  return { ok: true, histFixed, favFixed, mapSize: Object.keys(map).length };
};
