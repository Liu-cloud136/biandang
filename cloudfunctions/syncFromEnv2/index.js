// syncFromEnv2 · env1 主动从 env2 拉新菜产物到审核池
// 跨账号读 env2 dish_mirror（四件套齐全）→ 下载 env2 图片上传 env1 云存储 → 写 env1 五个 _pending
// 真机链路才能跨账号（管理员打开 env1 小程序时自动触发 / 手动调用）
// syncImages 模式：补全已入库菜（dish_lexicon）的图片到 dish_images 集合
const BUILD_TAG = '2026-08-26.v3-name-guard';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const crypto = require('crypto');
// 全量拉取统一用 _id 游标分页，规避云开发 skip 上限 1000（env1 本账号集合可能超 1000 条）
const { fetchAllNames, fetchAllIds, fetchAllNamesWhere, toNameSet } = require('./_shared/cursorFetch');

// 阶段 1：分表 schema 真源（幂等建 5 张新分表）
let ensureSchema;
try { ({ ensureSchema } = require('./ensureSchema')); }
catch (e) { ({ ensureSchema } = require('./_shared/ensureSchema')); }

const ENV2_APPID = 'wx1111111111111111';
const ENV2_ENV_ID = process.env.ENV2_ENV_ID || '';

exports.main = async (event, context) => {
  console.log('[build] syncFromEnv2 BUILD_TAG=' + BUILD_TAG);
  if (!ENV2_ENV_ID) return { ok: false, err: 'ENV2_ENV_ID 未配置' };

  let inst2, c2, _2;
  try {
    inst2 = new cloud.Cloud({ resourceAppid: ENV2_APPID, resourceEnv: ENV2_ENV_ID });
    await inst2.init();
    c2 = inst2.database();
    _2 = c2.command;
  } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }

  // 阶段 1：补齐新分表（幂等）
  await ensureSchema(db);

  // ---- syncImages 模式：补全/覆盖已入库菜图片到 dish_images ----
  if (event.syncImages === true) {
    const imgBatchSize = Math.min(Number(event.imgBatchSize) || 30, 60);
    const forceImg = event.force === true;
    const offset = Math.max(0, Number(event.offset) || 0);
    const ts = Date.now();

    // 读 env1 dish_lexicon 构建已入库菜名集合（游标分页，规避 skip 上限 1000）
    let lexiconNames;
    try {
      lexiconNames = toNameSet(await fetchAllNames('dish_lexicon'), (n) => n);
    } catch (e) { return { ok: false, err: '读 dish_lexicon 失败：' + ((e && e.message) || e) }; }

    // 读 env1 dish_images 构建已有图片菜名集合（游标分页）
    const dishImagesNames = new Set(await fetchAllIds('dish_image_v2'));
    console.log('[syncImg] dish_lexicon=' + lexiconNames.size + ' dish_images=' + dishImagesNames.size);

    // 查 env2 dish_mirror 有图片的菜
    let env2List = [];
    try {
      for (let off = 0; off < 1000; off += 100) {
        const r = await c2.collection('dish_mirror').where({
          source: 'ai-generated',
          imageUrl: _2.exists(true),
        }).field({ name: true, imageUrl: true }).skip(off).limit(100).get();
        env2List = env2List.concat(r.data || []);
        if (!r.data || r.data.length < 100) break;
      }
    } catch (e) { return { ok: false, err: '查 env2 dish_mirror 失败：' + ((e && e.message) || e) }; }

    let imgSynced = 0, imgFailed = 0, imgProcessed = 0;
    let skipNotInLex = 0, skipHasImage = 0, skipNoEnv2Img = 0;
    const details = [];
    const slice = env2List.slice(offset);
    for (const d of slice) {
      if (imgProcessed >= imgBatchSize) break;
      const name = d.name;
      if (!name) continue;
      if (!d.imageUrl) { skipNoEnv2Img++; continue; }
      const inLexicon = lexiconNames.has(name);
      const hasImage = dishImagesNames.has(name);
      if (!inLexicon && !hasImage) {
        // 不在 dish_lexicon，尝试写入 dish_image_pending（待审核菜补图）
        const ex = await db.collection('dish_lexicon_pending').where({ name }).limit(1).get();
        if (!ex || !ex.data || !ex.data.length) { skipNotInLex++; continue; }
        if (!forceImg) {
          const exImg = await db.collection('dish_image_pending').where({ name, status: 'pending' }).limit(1).get();
          if (exImg && exImg.data && exImg.data.length) { skipHasImage++; continue; }
        }
      } else if (hasImage && !forceImg) { skipHasImage++; continue; }
      else if (!inLexicon && !forceImg) { skipNotInLex++; continue; }
      imgProcessed++;
      try {
        const dlRes = await inst2.downloadFile({ fileID: d.imageUrl });
        if (!dlRes || !dlRes.fileContent || dlRes.fileContent.length < 10240) {
          imgFailed++; details.push({ name, status: 'img_too_small' }); continue;
        }
        const safe = crypto.createHash('md5').update(name).digest('hex');
        const upRes = await cloud.uploadFile({ cloudPath: 'dish-images/' + safe + '_' + Date.now() + '.png', fileContent: dlRes.fileContent });
        if (inLexicon) {
          await db.collection('dish_image_v2').doc(name).set({ data: { name, imageUrl: upRes.fileID, ts } });
        } else {
          if (forceImg) { try { await db.collection('dish_image_pending').where({ name }).remove(); } catch (e) { /* */ } }
          await db.collection('dish_image_pending').add({ data: { name, source: 'env2-newdish', imageUrl: upRes.fileID, status: 'pending', ts } });
        }
        imgSynced++;
        details.push({ name, status: inLexicon ? 'ok_lexicon' : 'ok_pending' });
      } catch (e) {
        imgFailed++;
        details.push({ name, status: 'fail', err: ((e && e.message) || String(e)).slice(0, 80) });
      }
    }
    const imgSkipped = skipNotInLex + skipHasImage + skipNoEnv2Img;
    return { ok: true, build: BUILD_TAG, mode: 'syncImages', total: env2List.length, offset, nextOffset: offset + imgProcessed + imgSkipped, imgSynced, imgFailed, imgSkipped, skipNotInLex, skipHasImage, skipNoEnv2Img, batch: imgProcessed, remaining: env2List.length - offset - imgProcessed - imgSkipped, details };
  }

  // ---- 默认模式：同步新菜到 _pending（仅 7 件套齐全的菜才同步）----
  // 7 件套：profile(画像) / nutrition(营养) / guide(做法点评) / ingredients(食材)
  //        / steps(详细步骤) / tips(小贴士) / imageUrl(菜图) —— 任一缺失则不同步，
  //        避免同步进审核池后才发现缺字段、需回 env2 重生成。
  let dishes = [];
  try {
    for (let off = 0; off < 1000; off += 100) {
      // 七件套用「非空值」判断（nin 排除 null/空串/空数组），不用 _.exists(true)
      // 原因：云数据库 _.exists(true) 对数组/对象/字符串字段匹配不稳定，会误把已生成的菜判为缺失，导致同步不出去
      const notEmpty = _2.nin([null, '', [], {}]);
      const r = await c2.collection('dish_mirror').where({
        source: _2.in(['ai-generated', 'regenerate']),
        profile: notEmpty,
        nutrition: notEmpty,
        guide: notEmpty,
        ingredients: notEmpty,
        steps: notEmpty,
        tips: notEmpty,
        imageUrl: notEmpty,
      }).skip(off).limit(100).get();
      dishes = dishes.concat(r.data || []);
      if (!r.data || r.data.length < 100) break;
    }
    console.log('[syncDebug] env2 查询到合格菜数 dishes=' + dishes.length + '，前3个名=' + JSON.stringify(dishes.slice(0, 3).map(x => x.name)));
  } catch (e) { console.log('[syncDebug] 查 env2 dish_mirror 异常：' + ((e && e.message) || e)); return { ok: false, err: '查 env2 dish_mirror 失败：' + ((e && e.message) || e) }; }

  const source = 'env2-newdish';
  const ts = Date.now();
  const force = event.force === true;
  const batchSize = event.batchSize || 15;
  let synced = 0, skipped = 0, failed = 0, imgSynced = 0, imgFailed = 0, newProcessed = 0;
  let skipLexicon = 0, skipExists = 0;
  const details = [];

  let existingNames = new Set();
  try {
    // 1) 排除「本流程已同步进审核池」的菜（source 限定）— 游标分页
    existingNames = toNameSet(await fetchAllNamesWhere('dish_lexicon_pending', { source }), (n) => n);
    // 2) 排除「已入正式库 dish_lexicon」的菜：已在正式库的菜不应再被拉进审核池（否则点入库显示重复）。
    //    注释原担忧「误把 env2 新菜全判重跳过」并不成立——env2 新菜名本就不在 dish_lexicon，只有真重名才被跳过，恰为正确去重。
    for (const n of await fetchAllNames('dish_lexicon')) existingNames.add(n);
    }
  catch (e) { console.warn('[sync] 读去重集合失败，去重跳过：' + ((e && e.message) || e)); }
  console.log('[syncDebug] 查重集 existingNames 大小=' + existingNames.size + '，dishes=' + dishes.length + '，开始遍历判重');

  for (const d of dishes) {
    if (newProcessed >= batchSize) break;
    const name = d.name;
    // name 守卫：env2 dish_mirror 可能缺 name，跳过避免写入缺 name 的空壳 pending（R-Sync 治本）
    if (!name || !String(name).trim()) { skipped++; skipLexicon++; details.push({ name: (name || '(空名)'), status: 'skip_empty_name' }); continue; }
    try {
      if (existingNames.has(name)) { skipped++; skipLexicon++; details.push({ name, status: 'skip_in_lexicon' }); continue; }
      const ex = await db.collection('dish_lexicon_pending').where({ name, source }).limit(1).get();
      const exists = ex && ex.data && ex.data.length;
      if (exists && !force) {
        const existing = ex.data[0];
        if (!existing.imageUrl && d.imageUrl) {
          // 4 件套已同步但图片缺失，自动重试图片
        } else {
          skipped++; skipExists++; details.push({ name, status: 'skip' }); continue;
        }
      }
      newProcessed++;
      let env1ImageUrl = '', imgErr = '';
      if (d.imageUrl) {
        try {
          const dlRes = await inst2.downloadFile({ fileID: d.imageUrl });

          const safe = crypto.createHash('md5').update(name).digest('hex');
          const upRes = await cloud.uploadFile({ cloudPath: 'dish-images/' + safe + '_' + Date.now() + '.png', fileContent: dlRes.fileContent });
          env1ImageUrl = upRes.fileID;
          imgSynced++;
        } catch (e) { imgFailed++; console.warn('[sync] img fail name=' + name + '：' + ((e && e.message) || e)); imgErr = ((e && e.message) || String(e)).slice(0, 100); }
      }
      if (exists && env1ImageUrl) {
        await Promise.all([
          db.collection('dish_lexicon_pending').where({ name, source }).update({ data: { imageUrl: env1ImageUrl } }),
          db.collection('dish_image_pending').add({ data: { name, source, imageUrl: env1ImageUrl, status: 'pending', ts } }),
        ]);
        synced++; details.push({ name, status: 'ok', img: 'ok' });
        continue;
      }
      if (exists && !env1ImageUrl) {
        imgFailed++; details.push({ name, status: 'ok', img: 'fail', imgErr: imgErr || undefined });
        continue;
      }
      const writes = [
        db.collection('dish_lexicon_pending').add({ data: { name, source, cuisine: (d.profile && d.profile.cuisine) || d.cuisine || '家常', category: d.category || '', mealTime: d.mealTime || [], season: d.season || ['spring', 'summer', 'autumn', 'winter'], reason: d.reason || ('env2 AI 新菜：' + (d.mainIngredient || '') + ' / ' + (d.cookingMethod || '')), imageUrl: env1ImageUrl, status: 'pending', ts } }),
        db.collection('dish_ai_profile_pending').add({ data: { name, source, profile: d.profile, status: 'pending', ts } }),
        db.collection('dish_nutrition_pending').add({ data: { name, source, nutrition: d.nutrition, status: 'pending', ts } }),
        db.collection('dish_guide_pending').add({ data: { name, source, guide: d.guide, review: d.review || null, difficulty: d.difficulty || null, tips: d.tips || null, ingredients: d.ingredients || null, steps: d.steps || null, status: 'pending', ts } }),
      ];
      if (env1ImageUrl) writes.push(db.collection('dish_image_pending').add({ data: { name, source, imageUrl: env1ImageUrl, status: 'pending', ts } }));
      await Promise.all(writes);
      synced++; details.push({ name, status: 'ok', img: env1ImageUrl ? 'ok' : (d.imageUrl ? 'fail' : 'none'), imgErr: imgErr || undefined });
    } catch (e) {
      failed++; details.push({ name, status: 'fail', err: (e && e.message) || 'unknown' });
    }
  }
  console.log('[syncDebug] 结束：dishes=' + dishes.length + '，existingNames=' + existingNames.size + '，synced=' + synced + '，skipLexicon=' + skipLexicon + '，skipExists=' + skipExists + '，failed=' + failed + '，newProcessed=' + newProcessed);
  return { ok: true, build: BUILD_TAG, debug: { dishes: dishes.length, existingNames: existingNames.size, skipLexicon, skipExists }, total: dishes.length, synced, skipped, failed, imgSynced, imgFailed, batch: newProcessed, remaining: dishes.length - synced - skipped - failed, details };
};
