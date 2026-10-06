// syncImagesFromEnv2 · 把 env1 dish_images / dish_image_pending 的图片同步到 env2 dish_mirror.imageUrl
// 反向补全：env1 已审核通过的图，回写 env2，使 env2 菜图也完整
const BUILD_TAG = '2026-08-26.v2-write-shunt';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const ENV2_APPID = 'wx1111111111111111';
const ENV2_ENV_ID = process.env.ENV2_ENV_ID || '';
const { fetchAllIds } = require('./_shared/cursorFetch');

exports.main = async (event, context) => {
  console.log('[build] syncImagesFromEnv2 BUILD_TAG=' + BUILD_TAG);
  if (!ENV2_ENV_ID) return { ok: false, err: 'ENV2_ENV_ID 未配置' };
  let inst2, c2, _2;
  try {
    inst2 = new cloud.Cloud({ resourceAppid: ENV2_APPID, resourceEnv: ENV2_ENV_ID });
    await inst2.init();
    c2 = inst2.database();
    _2 = c2.command;
  } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }

  // env1 全量图片（游标分页）
  let imgs = [];
  try { imgs = await fetchAllIds('dish_image_v2'); }
  catch (e) { return { ok: false, err: '读 dish_image_v2 失败：' + ((e && e.message) || e) }; }
  const pendingImgs = [];
  try {
    const p = await db.collection('dish_image_pending').where({ status: 'approved' }).limit(1000).get();
    pendingImgs.push(...(p.data || []));
  } catch (e) { /* ignore */ }
  console.log('[syncImg] dish_image_v2=' + imgs.length + ' pendingApproved=' + pendingImgs.length);

  const byName = {};
  imgs.forEach(i => { if (i && i.name) byName[i.name] = i; });
  pendingImgs.forEach(i => { if (i && i.name && !byName[i.name]) byName[i.name] = i; });

  // env2 dish_mirror 全量（游标分页）
  let mirror = [];
  try {
    for (let off = 0; off < 10000; off += 100) {
      const r = await c2.collection('dish_mirror').skip(off).limit(100).get();
      mirror = mirror.concat(r.data || []);
      if (!r.data || r.data.length < 100) break;
    }
  } catch (e) { return { ok: false, err: '读 env2 dish_mirror 失败：' + ((e && e.message) || e) }; }

  let synced = 0, skipped = 0, failed = 0;
  const batchSize = event.batchSize || 20;
  let processed = 0;
  const details = [];
  for (const m of mirror) {
    if (processed >= batchSize) break;
    const name = m.name;
    if (!name) continue;
    const env1Img = byName[name];
    if (!env1Img || !env1Img.imageUrl) { skipped++; continue; }
    if (m.imageUrl && m.imageUrl.indexOf('cloud://') >= 0) { skipped++; details.push({ name, status: 'skip_has_img' }); continue; }
    processed++;
    try {
      // 校验 env1 图非空（避免同步 0 字节坏图）
      const chk = await cloud.downloadFile({ fileID: env1Img.imageUrl });
      if (!chk || !chk.fileContent || chk.fileContent.length < 10240) { skipped++; details.push({ name, status: 'skip_img_small' }); continue; }
      await c2.collection('dish_mirror').doc(m._id).update({ data: { imageUrl: env1Img.imageUrl, updatedAt: Date.now() } });
      synced++; details.push({ name, status: 'ok' });
    } catch (e) { failed++; details.push({ name, status: 'fail', err: (e && e.message) || 'unknown' }); }
  }
  return { ok: true, build: BUILD_TAG, total: mirror.length, synced, skipped, failed, batch: processed, remaining: mirror.length - processed, details };
};
