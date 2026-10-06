// env2Console · env2 旁路助手控制台数据聚合（只读为主 + 降级档位读写 + 同步）
// task=overview   : 总览（集合统计 + 函数巡检 + 产物覆盖 + 日志 + 告警）
// task=dead-letter: 死信队列 bypass_dead_letter 前 20 条
// task=collection : 传 colName → 该集合前 20 条文档
// task=dish-detail: 传 dishName → dish_mirror 该菜全字段
// task=degrade-get: 读 sys_config.degradeLevel
// task=degrade-set: 传 value → 写 sys_config.degradeLevel
// task=logs-filtered: 传 filter{task,status} → 筛选后前 50 条
// task=sync-to-env1: 把 dish_mirror 四件套齐全的新菜跨账号写 env1 四个 _pending 审核池（真机链路才能跨账号）
// task=sync-lexicon-from-env1: 跨账号读 env1 dish_lexicon 全量菜名 → 写 env2 dish_lexicon（供 bypassGenDish 去重）
// task=gen-progress: 生成流水线进度（13 道骨架五件套覆盖 + byCategory）
const BUILD_TAG = '2026-08-26.sync-name-guard';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTIONS = [
  'dish_mirror', 'exposure_mirror', 'prefs_mirror', 'recommend_cache',
  'bypass_log', 'dish_nutrition', 'dish_lexicon_pending',
  'bypass_dead_letter', 'sys_config',
];

const FUNCS = [
  'bypassAiEnrich', 'bypassGenImage', 'bypassNutritionEst',
  'bypassText', 'bypassLexiconFix', 'bypassCandidate',
  'bypassEnrich', 'aiProbe', 'env2Console',
  'bypassScheduler', 'bypassRetry', 'bypassHealthCheck',
  'bypassDedup', 'bypassReviewContribution',
  'bypassGenDish', 'bypassGenIngredients', 'bypassGenSteps',
];

function withTimeout(p, ms, label) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error((label || 'op') + ' timeout')), ms); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

exports.main = async (event) => {
  console.log('[build] env2Console BUILD_TAG=' + BUILD_TAG);
  const task = (event && event.task) || 'overview';
  try {
    if (task === 'health') {
      return { ok: true, build: BUILD_TAG, name: 'env2Console', funcs: FUNCS.length };
    }

    // ── 日志轮转：删除 bypass_log 中 N 天前的记录（默认 7 天）──
    if (task === 'log-rotate') {
      const days = Number(event.days) || 7;
      const cutoff = Date.now() - days * 86400000;
      let deleted = 0;
      for (let i = 0; i < 20; i++) {
        const r = await db.collection('bypass_log').where({ ts: _.lt(cutoff) }).limit(100).get();
        if (!r.data || !r.data.length) break;
        for (const d of r.data) {
          await db.collection('bypass_log').doc(d._id).remove().catch(() => {});
          deleted++;
        }
      }
      return { ok: true, build: BUILD_TAG, deleted, days };
    }

    // ── 死信队列（翻页）──
    if (task === 'dead-letter') {
      const batchSize = Math.min(Number(event.limit) || 20, 100);
      const cond = {};
      if (event.cursor && event.cursor.lastTs) cond.deadAt = _.lt(event.cursor.lastTs);
      try {
        const r = await db.collection('bypass_dead_letter').where(cond).orderBy('deadAt', 'desc').limit(batchSize).get();
        const items = r.data || [];
        return { ok: true, build: BUILD_TAG, items, hasMore: items.length === batchSize, lastTs: items.length ? items[items.length - 1].deadAt : null };
      } catch (e) {
        return { ok: true, build: BUILD_TAG, items: [], err: 'bypass_dead_letter 不存在或空' };
      }
    }

    // ── 集合内容浏览（翻页）──
    if (task === 'collection') {
      const colName = event.colName;
      if (!colName) return { ok: false, err: 'missing colName' };
      const batchSize = Math.min(Number(event.limit) || 20, 100);
      const cond = {};
      if (event.cursor && event.cursor.lastId) cond._id = _.gt(event.cursor.lastId);
      try {
        const r = await db.collection(colName).where(cond).orderBy('_id', 'asc').limit(batchSize).get();
        const items = r.data || [];
        return { ok: true, build: BUILD_TAG, colName, items, hasMore: items.length === batchSize, lastId: items.length ? items[items.length - 1]._id : null };
      } catch (e) {
        return { ok: false, err: (e && e.message) || 'collection_read_failed' };
      }
    }

    // ── 菜库详情 ──
    if (task === 'dish-detail') {
      const dishName = event.dishName;
      if (!dishName) return { ok: false, err: 'missing dishName' };
      try {
        const r = await db.collection('dish_mirror').where({ name: dishName }).limit(1).get();
        return { ok: true, build: BUILD_TAG, dish: (r.data && r.data[0]) || null };
      } catch (e) {
        return { ok: false, err: (e && e.message) || 'dish_detail_failed' };
      }
    }

    // ── 降级档位读 ──
    if (task === 'degrade-get') {
      try {
        const r = await db.collection('sys_config').where({ key: 'degradeLevel' }).limit(1).get();
        const val = (r.data && r.data.length) ? Number(r.data[0].value) || 0 : 0;
        return { ok: true, build: BUILD_TAG, level: val };
      } catch (e) {
        return { ok: true, build: BUILD_TAG, level: 0, err: 'sys_config 不存在，默认 0' };
      }
    }

    // ── 降级档位写 ──
    if (task === 'degrade-set') {
      const val = Number(event.value);
      if (isNaN(val) || val < 0 || val > 3) return { ok: false, err: 'value 须 0-3' };
      try {
        let exist;
        try {
          exist = await db.collection('sys_config').where({ key: 'degradeLevel' }).limit(1).get();
        } catch (e1) {
          exist = { data: [] };
        }
        if (exist.data && exist.data.length) {
          await db.collection('sys_config').doc(exist.data[0]._id).update({ data: { value: val, updatedAt: Date.now() } });
        } else {
          await db.collection('sys_config').add({ data: { key: 'degradeLevel', value: val, updatedAt: Date.now() } });
        }
        return { ok: true, build: BUILD_TAG, level: val };
      } catch (e) {
        return { ok: false, err: (e && e.message) || 'degrade_set_failed' };
      }
    }

    // ── 筛选日志（翻页）──
    if (task === 'logs-filtered') {
      const filter = event.filter || {};
      const cond = {};
      if (filter.task) cond.task = filter.task;
      if (filter.status) cond.status = filter.status;
      const batchSize = Math.min(Number(event.limit) || 20, 100);
      if (event.cursor && event.cursor.lastTs) cond.computedAt = _.lt(event.cursor.lastTs);
      try {
        const r = await db.collection('bypass_log').where(cond).orderBy('computedAt', 'desc').limit(batchSize).get();
        const logs = r.data || [];
        return { ok: true, build: BUILD_TAG, logs, hasMore: logs.length === batchSize, lastTs: logs.length ? logs[logs.length - 1].computedAt : null };
      } catch (e) {
        return { ok: false, err: (e && e.message) || 'logs_filtered_failed' };
      }
    }

    // ── 生成流水线进度（dish_mirror 各件套覆盖统计，前端第 6 Tab 展示）──
    if (task === 'gen-progress') {
      const steps = [];
      let total = 0;
      try {
        const r = await db.collection('dish_mirror').where({ source: 'ai-generated' }).count();
        total = r.total;
      } catch (e) { total = 0; }
      steps.push({ key: 'name', label: '1. 生成菜名', fn: 'bypassGenDish', total, done: total, missing: 0, detail: total ? '已生成 ' + total + ' 道新菜' : '尚无新菜' });
      const fields = [
        { key: 'profile', label: '2. AI 画像', fn: 'bypassAiEnrich' },
        { key: 'nutrition', label: '3. 营养补估', fn: 'bypassNutritionEst' },
        { key: 'review', label: '4. 点评/难度/贴士', fn: 'bypassText' },
        { key: 'guide', label: '4b. 做法文本', fn: 'bypassGenSteps' },
        { key: 'imageUrl', label: '5. 菜图生成', fn: 'bypassGenImage' },
        { key: 'ingredients', label: '6. 食材列表', fn: 'bypassGenIngredients' },
        { key: 'steps', label: '7. 详细步骤', fn: 'bypassGenSteps' },
      ];
      for (const f of fields) {
        let done = 0;
        try {
          const r = await db.collection('dish_mirror').where({ source: 'ai-generated', [f.key]: _.nin([null, '', [], {}]) }).count();
          done = r.total;
        } catch (e) { done = 0; }
        steps.push({ key: f.key, label: f.label, fn: f.fn, total, done, missing: total - done, detail: done + '/' + total + (total - done ? '（缺 ' + (total - done) + '）' : '') });
      }
      // §11 按大类分组统计
      const byCategory = {};
      try {
        const all = await db.collection('dish_mirror').where({ source: 'ai-generated' }).field({ category: true }).limit(500).get();
        (all.data || []).forEach(d => { const c = d.category || '菜'; byCategory[c] = (byCategory[c] || 0) + 1; });
      } catch (e) { /* */ }
      return { ok: true, build: BUILD_TAG, total, steps, byCategory };
    }

    // ── sync-to-env1：跨账号写 env1 审核池（真机链路才能跨账号）──
    // 查 dish_mirror 四件套齐全 → 下载 env2 图片上传 env1 云存储 → 跨账号写 env1 五个 _pending（含 dish_image_pending）
    if (task === 'sync-to-env1') {
      const ENV1_APPID = 'wx0000000000000000';
      const ENV1_ENV_ID = process.env.ENV1_ENV_ID || '';
      if (!ENV1_ENV_ID) return { ok: false, err: 'ENV1_ENV_ID 未配置' };
      const fs = require('fs');
      const ts = Date.now();
      const source = 'env2-newdish';
      let dishes = [];
      try {
        const r = await db.collection('dish_mirror').where({
          source: 'ai-generated',
          profile: _.exists(true),
          nutrition: _.exists(true),
          review: _.exists(true),
        }).limit(100).get();
        dishes = r.data || [];
      } catch (e) { return { ok: false, err: '查 dish_mirror 失败：' + ((e && e.message) || e) }; }
      let c1, inst1;
      try {
        inst1 = new cloud.Cloud({ resourceAppid: ENV1_APPID, resourceEnv: ENV1_ENV_ID });
        await inst1.init();
        c1 = inst1.database();
      } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }
      let synced = 0, skipped = 0, failed = 0, imgSynced = 0, imgFailed = 0;
      const details = [];
      const force = event.force === true;
      for (const d of dishes) {
        const name = d.name;
        // name 守卫：跳过缺 name 的 env2 记录，避免写入空壳 pending（R-Sync 治本）
        if (!name || !String(name).trim()) { skipped++; details.push({ name: (name || '(空名)'), status: 'skip_empty_name' }); continue; }
        try {
          const ex = await c1.collection('dish_lexicon_pending').where({ name, source }).limit(1).get();
          const exists = ex && ex.data && ex.data.length;
          if (exists && !force) {
            const existing = ex.data[0];
            if (!existing.imageUrl && d.imageUrl) {
              // 4 件套已同步但图片缺失，自动重试图片
            } else {
              skipped++; details.push({ name, status: 'skip' }); continue;
            }
          }
          let env1ImageUrl = '', imgErr = '';
          if (d.imageUrl) {
            try {
              const dlRes = await cloud.downloadFile({ fileID: d.imageUrl });
              const fileContent = dlRes.fileContent;
              const upRes = await inst1.uploadFile({ cloudPath: 'dish-images/' + name + '-' + ts + '.jpg', fileContent });
              env1ImageUrl = upRes.fileID;
              imgSynced++;
            } catch (e) { imgFailed++; console.warn('[sync] img fail name=' + name + '：' + ((e && e.message) || e)); imgErr = ((e && e.message) || String(e)).slice(0, 100); }
          }
          if (exists && env1ImageUrl) {
            await Promise.all([
              c1.collection('dish_lexicon_pending').where({ name, source }).update({ data: { imageUrl: env1ImageUrl } }),
              c1.collection('dish_image_pending').add({ data: { name, source, imageUrl: env1ImageUrl, status: 'pending', ts } }),
            ]);
            synced++; details.push({ name, status: 'ok', img: 'ok' });
            continue;
          }
          if (exists && !env1ImageUrl) {
            imgFailed++; details.push({ name, status: 'ok', img: 'fail', imgErr: imgErr || undefined });
            continue;
          }
          const writes = [
            c1.collection('dish_lexicon_pending').add({ data: { name, source, cuisine: (d.profile && d.profile.cuisine) || d.cuisine || '家常', category: d.category || '', mealTime: d.mealTime || [], season: d.season || ['spring', 'summer', 'autumn', 'winter'], reason: d.reason || ('env2 AI 新菜：' + (d.mainIngredient || '') + ' / ' + (d.cookingMethod || '')), imageUrl: env1ImageUrl, status: 'pending', ts } }),
            c1.collection('dish_ai_profile_pending').add({ data: { name, source, profile: d.profile, status: 'pending', ts } }),
            c1.collection('dish_nutrition_pending').add({ data: { name, source, nutrition: d.nutrition, status: 'pending', ts } }),
            c1.collection('dish_guide_pending').add({ data: { name, source, guide: d.guide, review: d.review || null, difficulty: d.difficulty || null, tips: d.tips || null, ingredients: d.ingredients || null, steps: d.steps || null, status: 'pending', ts } }),
          ];
          if (env1ImageUrl) writes.push(c1.collection('dish_image_pending').add({ data: { name, source, imageUrl: env1ImageUrl, status: 'pending', ts } }));
          await Promise.all(writes);
          synced++; details.push({ name, status: 'ok', img: env1ImageUrl ? 'ok' : (d.imageUrl ? 'fail' : 'none'), imgErr: imgErr || undefined });
        } catch (e) {
          failed++; details.push({ name, status: 'fail', err: (e && e.message) || 'unknown' });
        }
      }
      return { ok: true, build: BUILD_TAG, total: dishes.length, synced, skipped, failed, imgSynced, imgFailed, details };
    }

    // ── sync-lexicon-from-env1：跨账号读 env1 dish_lexicon 全量菜名 → 写 env2 dish_lexicon（供 bypassGenDish 去重）
    if (task === 'sync-lexicon-from-env1') {
      const ENV1_APPID = 'wx0000000000000000';
      const ENV1_ENV_ID = process.env.ENV1_ENV_ID || '';
      if (!ENV1_ENV_ID) return { ok: false, err: 'ENV1_ENV_ID 未配置' };
      let c1, inst1;
      try {
        inst1 = new cloud.Cloud({ resourceAppid: ENV1_APPID, resourceEnv: ENV1_ENV_ID });
        await inst1.init();
        c1 = inst1.database();
      } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }
      let allNames = [];
      const PAGE = 100;
      for (let offset = 0; ; offset += PAGE) {
        try {
          const r = await c1.collection('dish_lexicon').field({ name: true }).skip(offset).limit(PAGE).get();
          const batch = r.data || [];
          batch.forEach(d => { if (d.name) allNames.push(d.name); });
          if (batch.length < PAGE) break;
        } catch (e) { return { ok: false, err: '读 env1 dish_lexicon 失败：' + ((e && e.message) || e) }; }
      }
      let synced = 0, skipped = 0, failed = 0;
      const BATCH_SIZE = 20;
      for (let i = 0; i < allNames.length; i += BATCH_SIZE) {
        const batch = allNames.slice(i, i + BATCH_SIZE);
        const tasks = batch.map(async (name) => {
          try {
            const ex = await db.collection('dish_lexicon').where({ name }).limit(1).get();
            if (ex && ex.data && ex.data.length) { skipped++; return; }
            await db.collection('dish_lexicon').add({ data: { name, source: 'env1-sync', ts: Date.now() } });
            synced++;
          } catch (e) { failed++; }
        });
        await Promise.all(tasks);
      }
      return { ok: true, build: BUILD_TAG, total: allNames.length, synced, skipped, failed };
    }

    // ── fix-reason：调 fixReasonInEnv2 用 env2 AI 补全 env1 菜品 reason 并写回 ──
    if (task === 'fix-reason') {
      try {
        const r = await cloud.callFunction({ name: 'fixReasonInEnv2' });
        return r && r.result || { ok: false, err: 'fixReasonInEnv2 无结果' };
      } catch (e) { return { ok: false, err: 'fixReasonInEnv2 调用失败：' + ((e && e.message) || e) }; }
    }

    // ── overview（默认）──
    const cols = [];
    for (const name of COLLECTIONS) {
      try {
        const r = await withTimeout(db.collection(name).count(), 8000, 'count-' + name);
        cols.push({ name, count: r.total });
      } catch (e) {
        cols.push({ name, count: null });
      }
    }

    const fun = {};
    const names = event && Array.isArray(event.funcs) ? event.funcs.filter((f) => FUNCS.indexOf(f) >= 0) : FUNCS;
    await Promise.all(names.map(async (f) => {
      try {
        const r = await withTimeout(
          (async () => { const res = await cloud.callFunction({ name: f, data: { task: 'health' } }); return res && res.result; })(),
          8000, 'health-' + f);
        fun[f] = r || { ok: false, err: 'health 无结果' };
      } catch (e) {
        fun[f] = { ok: false, err: (e && e.message) || 'health_failed' };
      }
    }));

    const cover = {};
    try {
      const total = await withTimeout(db.collection('dish_mirror').count(), 8000, 'cov-total');
      cover.total = total.total;
    } catch (e) { cover.total = null; }
    for (const f of ['profile', 'imageUrl', 'nutrition', 'review', 'ingredients', 'steps']) {
      try {
        const q = await withTimeout(db.collection('dish_mirror').where({ [f]: _.exists(true) }).count(), 8000, 'cov-' + f);
        cover[f] = q.total;
      } catch (e) { cover[f] = null; }
    }

    const logs = [];
    let failRecent = 0, fail24h = 0, lastStatus = '';
    try {
      const r = await db.collection('bypass_log').orderBy('computedAt', 'desc').limit(30).get();
      logs.push(...r.data.map((d) => ({
        task: d.task || '', status: d.status || '', errMsg: d.errMsg || '',
        openid: d._openid || '', computedAt: d.computedAt || 0,
      })));
      failRecent = logs.filter((l) => l.status === 'fail').length;
      const now = Date.now();
      const r24 = await db.collection('bypass_log').where({ computedAt: _.gt(now - 24 * 3600 * 1000), status: 'fail' }).count();
      fail24h = r24.total;
      if (logs.length) lastStatus = logs[0].status;
    } catch (e) { /* */ }

    return { ok: true, build: BUILD_TAG, ts: Date.now(), cols, logs, cover, fun, warn: { failRecent, fail24h, lastStatus } };
  } catch (e) {
    console.error('[env2Console] ' + task + ' 失败：', e && e.message);
    return { ok: false, err: (e && e.message) || 'console_failed' };
  }
};
