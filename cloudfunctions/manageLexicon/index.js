// manageLexicon · 词库管理（审核通过 / 驳回 / 列表）
// approve 分流：
//   1) source === 'env2-nutrition' → 写 dish_nutrition_v2（营养分表）
//   2) 其余（explore / auto-fix / ai-gen / env2-newdish）→ 双写主库 dish_lexicon + 五个分表
//      且主库写入已含 norm_id（断裂点2 修复），跨表对齐用 norm_id 而非弱归一 name
// 另含产物分流审核：listPending / approvePending / rejectPending / deletePending（tab 15-18）
// 另含 batchApprove：一键把 dish_lexicon_pending 待入库菜批量写正式库 dish_lexicon + 五分表（tab 19 一键入库）
// BUILD_TAG: 2026-08-27.batch-result-fix（新增 countApprovedSince 用 ts 核对真实入库数，修复结果弹窗显示 0 误导）
//           2026-09-03.verify-content-gate：入库前内容级自检（食材表空/步骤空文本=hard 拒入；主料不匹配/缺贴士点评推荐语=soft 提示），force 可绕过
//           2026-09-09.pending-img-env-guard：写正式图库前校验 pending 图须属当前环境，跨环境 fileID 跳过图写并告警（防 env2 图写进 env1）
const BUILD_TAG = '2026-09-09.pending-img-env-guard';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { normLexName } = require('./normLexName');
let cursorFetch;
try { ({ fetchAllNames, fetchAllIds } = require('./cursorFetch')); }
catch (e) { ({ fetchAllNames, fetchAllIds } = require('./_shared/cursorFetch')); }

// ── 内容级自检（2026-09-03 审核门槛）：防止"空壳/主料缺失"进正式库 ──
// hard=硬缺（拒入库）；soft=可疑（放行但随结果返回提示，供审核员参考）
function mainInIngredients(main, ingText) {
  const m = String(main || '').trim();
  if (!m || m.length < 2) return true;
  // 载体/成品类 main（米饭/馒头/包子/饺子/粥/饼/面等）不必逐字匹配食材
  if (/(米饭|馒头|包子|饺子|馄饨|抄手|烧麦|面条|面包|年糕|粥|饼|杂粮|汤底|面团|粉)$/.test(m)) return true;
  const meatChar = [...m].find(ch => '猪牛鸡鸭羊鱼虾蟹鹅鸽兔'.includes(ch));
  if (meatChar && ingText.includes(meatChar)) return true; // 荤属字放宽：猪肉↔五花肉、鸡肉↔鸡胸肉
  // 去限定字后子串包含（嫩豆腐→豆腐）
  const core = String(m).replace(/^(嫩|老|鲜|冰|冻|水|半|整|去骨|脱骨|无骨|新鲜|有机|土|本地)/, '');
  if (ingText.includes(m) || ingText.includes(core)) return true;
  // 任意连续两字同现（猪小排 vs 排骨 / 牛腩 vs 牛腩肉）
  const items = ingText.split('|');
  for (const it of items) {
    const a = String(it).trim();
    if (!a) continue;
    if (a.includes(m) || m.includes(a) || a.includes(core) || core.includes(a)) return true;
    for (let i = 0; i + 1 < m.length; i++) {
      const bi = m.slice(i, i + 2);
      if (bi.length === 2 && a.includes(bi)) return true;
    }
  }
  return false;
}
function validateApprovalContent(g, prof, lib) {
  const issues = { hard: [], soft: [] };
  const ingArr = Array.isArray(g && g.ingredients) ? g.ingredients : [];
  const ingNames = ingArr
    .map(x => (x && typeof x === 'object' ? x.name : x) || '')
    .map(s => String(s).trim()).filter(Boolean);
  const stepArr = Array.isArray(g && g.steps) ? g.steps : [];
  const stepTexts = stepArr
    .map(x => (x && typeof x === 'object' ? (x.text || x.content) : x) || '')
    .map(s => String(s).trim()).filter(Boolean);
  const tips = String((g && g.tips) || '').trim();
  const review = String((g && g.review) || '').trim();
  if (!ingNames.length) issues.hard.push('食材表为空');
  if (stepArr.length && !stepTexts.length) issues.hard.push('步骤文本为空');
  if (!ingNames.length) return issues; // 食材空则后续主料/贴士无从判断
  if (stepArr.length && stepTexts.length < 2) issues.hard.push('步骤不足 2 步');
  const main = (prof && prof.main) ? String(prof.main).trim() : '';
  if (!main) issues.soft.push('缺画像主料');
  else if (!mainInIngredients(main, ingNames.join('|'))) issues.soft.push('画像主料「' + main + '」未在食材表中找到');
  if (!tips) issues.soft.push('缺贴士');
  if (!review) issues.soft.push('缺点评');
  if (!lib.reason) issues.soft.push('缺推荐语');
  return issues;
}

exports.main = async (event, context) => {
  const { action, name, source, data } = event;
  console.log('[build] manageLexicon BUILD_TAG=' + BUILD_TAG + ' action=' + action + ' name=' + name);

  if (action === 'list') {
    const pending = await db.collection('dish_lexicon_pending').where({ status: 'pending' }).limit(100).get();
    return { ok: true, build: BUILD_TAG, pending: (pending.data || []).map(x => ({
      _id: x._id,
      name: x.name,
      source: x.source,
      cuisine: x.cuisine,
      category: x.category || '',
      mealTime: x.mealTime || '',
      reason: x.reason || '',
      imageUrl: x.imageUrl || '',
      status: x.status || 'pending',
    })) };
  }

  // 单菜入库核心逻辑（approve / batchApprove 共用）：读 _pending 五表 → 双写 dish_lexicon + 五分表 → 清理 pending → 回写 env2
  async function approveDish(name, source, force) {
    const nid = normLexName(name);
    const ts = Date.now();
    const [lexP, profP, nutP, guideP, imgP] = await Promise.all([
      db.collection('dish_lexicon_pending').where({ name }).limit(1).get().catch(() => null),
      db.collection('dish_ai_profile_pending').where({ name }).limit(1).get().catch(() => null),
      db.collection('dish_nutrition_pending').where({ name }).limit(1).get().catch(() => null),
      db.collection('dish_guide_pending').where({ name }).limit(1).get().catch(() => null),
      db.collection('dish_image_pending').where({ name, status: 'pending' }).limit(1).get().catch(() => null),
    ]);
    const lib = (lexP && lexP.data && lexP.data[0]) || {};
    const src = source || lib.source || '';
    const prof = (profP && profP.data && profP.data[0] && profP.data[0].profile) || null;
    const g = (guideP && guideP.data && guideP.data[0]) || {};
    // 内容级自检门槛（2026-09-03）：空壳/步骤空文本挡在正式库外；env2-nutrition 分流仅补营养，不校验做法四维
    const _issues = src === 'env2-nutrition' ? { hard: [], soft: [] } : validateApprovalContent(g, prof, lib);
    if (!force && _issues.hard.length) {
      throw new Error('内容自检未通过：' + _issues.hard.join('；') + '（菜名：' + name + '）'
        + (_issues.soft.length ? '；提示：' + _issues.soft.join('；') : '') + '。如需强制入库请传 force=true');
    }
    const writes = [];
    const libData = {
      name, norm_id: nid,
      cuisine: lib.cuisine || '', category: lib.category || '',
      mealTime: lib.mealTime || [], season: lib.season || ['spring', 'summer', 'autumn', 'winter'],
      reason: lib.reason || '', valid: true, ts,
    };
    writes.push(db.collection('dish_lexicon').doc(name).set({ data: libData }));
    if (src === 'env2-nutrition') {
      const nut = (nutP && nutP.data && nutP.data[0] && nutP.data[0].nutrition);
      if (nut) writes.push(db.collection('dish_nutrition_v2').doc(nid).set({ data: { name, nutrition: nut, ts } }));
    } else {
      // 画像写规范化分表 dish_profile（废弃旧表 dish_ai_profile 已删，写入会抛错致假失败）
      if (prof) writes.push(db.collection('dish_profile').doc(nid).set({ data: { name, profile: prof, ts } }));
      // 推荐理由写 dish_recommend（lib.reason，避免缺推荐维度）
      if (lib.reason) writes.push(db.collection('dish_recommend').doc(nid).set({ data: { name, reason: lib.reason, ts } }));
      const nut = (nutP && nutP.data && nutP.data[0] && nutP.data[0].nutrition);
      if (nut) writes.push(db.collection('dish_nutrition_v2').doc(nid).set({ data: { name, nutrition: nut, ts } }));
      // dish_guide 废弃旧表已删，删除整表写入；steps/ingredients/review/tips 已拆分为独立分表写入
      if (g.ingredients) writes.push(db.collection('dish_ingredients').doc(nid).set({ data: { name, ingredients: g.ingredients, ts } }));
      if (g.steps) writes.push(db.collection('dish_steps').doc(nid).set({ data: { name, steps: g.steps, ts } }));
      if (g.tips) writes.push(db.collection('dish_tips').doc(nid).set({ data: { name, tips: g.tips, ts } }));
      if (g.review) writes.push(db.collection('dish_review').doc(nid).set({ data: { name, review: g.review, ts } }));
    }
    const img = (imgP && imgP.data && imgP.data[0] && imgP.data[0].imageUrl);
    // 2026-09-09：pending 图必须属当前环境(env1)才写正式图库——跨环境 fileID（env2 等）在现环境前端加载不了，
    // env1 云函数无法跨账号下载转存 → 跳过图写并告警（正式图留空，前端 getDishImage 兜底重拉/重生成）；pending 记录照常清理。
    const envNow = cloud.DYNAMIC_CURRENT_ENV || process.env.TCB_ENV || '';
    if (img && typeof img === 'string' && img.indexOf('cloud://' + envNow + '.') === 0) {
      writes.push(db.collection('dish_image_v2').doc(name).set({ data: { name, imageUrl: img, ts } }));
    } else if (img) {
      console.warn('[approve] 跨环境 pending 图跳过（待转存）name=' + name + ' url=' + String(img).slice(0, 60));
    }
    if (img) {
      // 一键入库后同步清理 dish_image_pending，避免 approved 残留堆积（R-Doc 根治，与其它 _pending 一致用 remove）
      writes.push(db.collection('dish_image_pending').where({ name }).remove());
    }
    writes.push(db.collection('dish_lexicon_pending').where({ name }).remove());
    writes.push(db.collection('dish_ai_profile_pending').where({ name }).remove());
    writes.push(db.collection('dish_nutrition_pending').where({ name }).remove());
    writes.push(db.collection('dish_guide_pending').where({ name }).remove());
    await Promise.all(writes);
    syncBackToEnv2(name, libData).catch(e => console.warn('[approve] 回写 env2 失败（忽略）：' + ((e && e.message) || e)));
    return { name, norm_id: nid, soft: _issues.soft };
  }

  if (action === 'approve') {
    if (!name) return { ok: false, err: 'name 缺失' };
    try {
      const r = await approveDish(name, event.source, event.force === true);
      return { ok: true, build: BUILD_TAG, name: r.name, norm_id: r.norm_id, soft: r.soft || [] };
    } catch (e) { return { ok: false, err: (e && e.message) || 'unknown' }; }
  }

  // 一键入库预览：仅统计待入库菜中「将入库(主库不存在) / 重复丢弃(主库已存在)」清单，不写入
  if (action === 'batchApprovePreview') {
    const limit = event.limit || 200;
    const pending = await db.collection('dish_lexicon_pending').where({ status: _.in(['pending', 'approved']) }).limit(limit).get();
    const names = (pending.data || []).filter(it => it.name).map(it => it.name);
    const toApprove = [], toSkip = [];
    if (names.length) {
      // 批量比对：一次查询主库已存在同名集合，做差集（避免逐条查询冷启动超时）
      const exRows = await db.collection('dish_lexicon').where({ name: _.in(names) }).limit(1000).field({ name: 1 }).get().catch(() => null);
      const existSet = new Set((exRows && exRows.data || []).map(r => r.name));
      for (const nm of names) {
        if (existSet.has(nm)) toSkip.push(nm);
        else toApprove.push(nm);
      }
    }
    return { ok: true, build: BUILD_TAG, approveCount: toApprove.length, skipCount: toSkip.length, toApprove, toSkip };
  }

  if (action === 'batchApprove') {
    const limit = event.limit || 50;
    const force = event.force === true;
    const pending = await db.collection('dish_lexicon_pending').where({ status: _.in(['pending', 'approved']) }).limit(limit).get();
    const items = (pending.data || []);
    let approved = 0, failed = 0, skipped = 0;
    const details = [];
    for (const it of items) {
      const nm = it.name;
      if (!nm) { skipped++; continue; }
      if (!force) {
        const ex = await db.collection('dish_lexicon').where({ name: nm }).limit(1).get().catch(() => null);
        if (ex && ex.data && ex.data.length) { skipped++; details.push({ name: nm, status: 'skip_exist' }); continue; }
      }
      try {
        await approveDish(nm, it.source, event.force === true);
        approved++; details.push({ name: nm, status: 'ok' });
      } catch (e) { failed++; details.push({ name: nm, status: 'fail', err: ((e && e.message) || 'unknown').slice(0, 80) }); }
    }
    const remain = await db.collection('dish_lexicon_pending').where({ status: _.in(['pending', 'approved']) }).count().catch(() => ({ total: 0 }));
    return { ok: true, build: BUILD_TAG, approved, failed, skipped, remaining: (remain && remain.total) || 0, details };
  }

  // 清理脏残留：dish_lexicon_pending 里主库 dish_lexicon 已存在同名的记录（菜已入主库/分表，pending 记录因超时未被删），仅删 pending 记录，不动主库/分表
  // 批量预查询提速：每批仅 1 次主库 in 查询 + 批量删，单批耗时远低于 3s 调用方限制
  if (action === 'cleanApprovedResidual') {
    const batch = event.batch || 20;
    const pending = await db.collection('dish_lexicon_pending').where({ status: _.in(['pending', 'approved']) }).limit(batch).get();
    const items = (pending.data || []);
    if (!items.length) {
      const remain = await db.collection('dish_lexicon_pending').where({ status: _.in(['pending', 'approved']) }).count().catch(() => ({ total: 0 }));
      return { ok: true, build: BUILD_TAG, cleaned: 0, kept: 0, remaining: (remain && remain.total) || 0 };
    }
    const names = items.map(it => it.name).filter(Boolean);
    const exRes = await db.collection('dish_lexicon').where({ name: _.in(names) }).limit(batch).get().catch(() => ({ data: [] }));
    const exSet = new Set((exRes.data || []).map(d => d.name));
    const toClean = names.filter(n => exSet.has(n));
    const kept = names.length - toClean.length;
    if (toClean.length) {
      await Promise.all([
        db.collection('dish_lexicon_pending').where({ name: _.in(toClean) }).remove().catch(() => null),
        db.collection('dish_ai_profile_pending').where({ name: _.in(toClean) }).remove().catch(() => null),
        db.collection('dish_nutrition_pending').where({ name: _.in(toClean) }).remove().catch(() => null),
        db.collection('dish_guide_pending').where({ name: _.in(toClean) }).remove().catch(() => null),
      ]);
    }
    const remain = await db.collection('dish_lexicon_pending').where({ status: _.in(['pending', 'approved']) }).count().catch(() => ({ total: 0 }));
    return { ok: true, build: BUILD_TAG, cleaned: toClean.length, kept, remaining: (remain && remain.total) || 0 };
  }

  // 统计自某时间戳以来实际新入库的菜（用 ts 字段核对真实入库数，避免冷启动超时导致结果弹窗显示 0 的误导）
  if (action === 'countApprovedSince') {
    const since = event.since || 0;
    const rows = await db.collection('dish_lexicon').where({ ts: _.gte(since) }).limit(1000).field({ name: 1, ts: 1 }).get().catch(() => ({ data: [] }));
    const names = (rows.data || []).map(r => r.name).filter(Boolean);
    return { ok: true, build: BUILD_TAG, count: names.length, names };
  }

  // 分表重复诊断：查各分表按 name 分组出现多条的重复（env1 分表可能一个菜出现多个重复）
  if (action === 'diagDups') {
    const $a = db.command.aggregate;
    const cols = ['dish_lexicon', 'dish_profile', 'dish_ingredients', 'dish_steps', 'dish_review', 'dish_tips', 'dish_recommend', 'dish_nutrition_v2', 'dish_guide', 'dish_nutrition', 'dish_images'];
    const out = {};
    for (const c of cols) {
      try {
        const byName = await db.collection(c).aggregate()
          .group({ _id: '$name', c: $a.sum(1) })
          .match({ c: $a.gt(1) })
          .count('dups').end().catch(() => ({ data: [] }));
        const byId = await db.collection(c).aggregate()
          .group({ _id: '$_id', c: $a.sum(1) })
          .match({ c: $a.gt(1) })
          .count('dups').end().catch(() => ({ data: [] }));
        out[c] = {
          dupByName: (byName.data && byName.data[0] && byName.data[0].dups) || 0,
          dupById: (byId.data && byId.data[0] && byId.data[0].dups) || 0,
          sample: (byName.data || []).slice(0, 5).map(d => ({ name: d._id, count: d.c })),
        };
      } catch (e) {
        out[c] = { err: e.message || String(e) };
      }
    }
    return { ok: true, build: BUILD_TAG, out };
  }

  // 营养分表重复诊断：按归一菜名聚类，找出一道菜写了多条的重复组
  if (action === 'diagNutritionDups') {
    const all = [];
    let skip = 0;
    while (true) {
      const r = await db.collection('dish_nutrition_v2').field({ name: true }).limit(1000).skip(skip).get();
      if (!r.data || r.data.length === 0) break;
      all.push(...r.data);
      if (r.data.length < 1000) break;
      skip += 1000;
    }
    const normName = (s) => (s || '').trim().replace(/\s+/g, '').toLowerCase();
    const m = {};
    for (const d of all) {
      const n = normName(d.name || '');
      (m[n] = m[n] || []).push(d.name);
    }
    const dups = [];
    for (const k in m) {
      if (m[k].length > 1) dups.push({ norm: k, count: m[k].length, names: m[k] });
    }
    dups.sort((a, b) => b.count - a.count);
    return { ok: true, build: BUILD_TAG, total: all.length, dupGroups: dups.length, dupDocs: dups.reduce((s, x) => s + x.count, 0), top: dups.slice(0, 40) };
  }

  // 清理 dish_nutrition_v2 重复：按 name 聚类，同组保留 ts 最新一条，其余删除；name 为空直接删。默认 dry-run。
  if (action === 'cleanNutritionDups') {
    const dry = event.dry !== false;
    const all = [];
    let skip = 0;
    while (true) {
      const r = await db.collection('dish_nutrition_v2').limit(1000).skip(skip).get();
      if (!r.data || r.data.length === 0) break;
      all.push(...r.data);
      if (r.data.length < 1000) break;
      skip += 1000;
    }
    const m = {};
    for (const d of all) {
      const key = (d.name && String(d.name).trim()) || '__NULL__';
      (m[key] = m[key] || []).push(d);
    }
    const toRemove = [];
    const groups = [];
    const nullGroups = [];
    for (const k in m) {
      const arr = m[k];
      if (arr.length > 1) {
        if (k === '__NULL__') {
          // name 为空的文档：_id 其实是菜名，是有效数据，不删，待后续补 name
          nullGroups.push(arr.length);
          continue;
        }
        arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const keep = arr[0];
        const rm = arr.slice(1);
        toRemove.push(...rm);
        groups.push({ name: k, count: arr.length, keepId: keep._id, keepTs: keep.ts, removeIds: rm.map(x => x._id) });
      }
    }
    if (!dry) {
      let removed = 0;
      for (let i = 0; i < toRemove.length; i += 20) {
        const batch = toRemove.slice(i, i + 20);
        await Promise.all(batch.map(d => db.collection('dish_nutrition_v2').doc(d._id).remove().catch(e => ({ err: e.message }))));
        removed += batch.length;
      }
      return { ok: true, build: BUILD_TAG, dry: false, total: all.length, removed, dupGroups: groups.length, nullDocs: nullGroups.reduce((s, x) => s + x, 0), sample: groups.slice(0, 10) };
    }
    return { ok: true, build: BUILD_TAG, dry: true, total: all.length, dupGroups: groups.length, willRemove: toRemove.length, nullDocs: nullGroups.reduce((s, x) => s + x, 0), groups: groups.slice(0, 10) };
  }

  // 修复 dish_nutrition_v2 中 name 为空的文档：name = _id（_id 即菜名）
  if (action === 'fixNullNames') {
    const all = [];
    let skip = 0;
    while (true) {
      const r = await db.collection('dish_nutrition_v2').limit(1000).skip(skip).get();
      if (!r.data || r.data.length === 0) break;
      all.push(...r.data);
      if (r.data.length < 1000) break;
      skip += 1000;
    }
    const bad = all.filter(d => !d.name || !String(d.name).trim());
    let fixed = 0;
    for (let i = 0; i < bad.length; i += 20) {
      const batch = bad.slice(i, i + 20);
      await Promise.all(batch.map(d => db.collection('dish_nutrition_v2').doc(d._id).update({ data: { name: d._id } }).catch(e => ({ err: e.message }))));
      fixed += batch.length;
    }
    return { ok: true, build: BUILD_TAG, total: all.length, badFound: bad.length, fixed };
  }

  // 字段完整率诊断：分表 + 待审核池，统计各核心字段缺失数（空/null/空数组/空对象）
  if (action === 'diagFields') {
    const schema = {
      dish_steps: ['name', 'steps'],
      dish_review: ['name', 'review'],
      dish_tips: ['name', 'tips'],
      dish_ingredients: ['name', 'ingredients'],
      dish_nutrition_v2: ['name', 'nutrition'],
      dish_ai_profile: ['name', 'profile'],
      dish_recommend: ['name', 'reason'],
      dish_profile: ['name', 'profile'],
      dish_image_v2: ['name', 'imageUrl'],
      dish_lexicon_pending: ['name', 'kind'],
      dish_guide_pending: ['name', 'steps', 'review', 'tips', 'ingredients'],
      dish_ai_profile_pending: ['name', 'profile'],
      dish_nutrition_pending: ['name', 'nutrition'],
      dish_image_pending: ['name', 'imageUrl'],
    };
    const $a = db.command.aggregate;
    const out = {};
    for (const c of Object.keys(schema)) {
      const fields = schema[c];
      let total = 0;
      try { const cnt = await db.collection(c).count(); total = cnt.total; } catch (e) {}
      const miss = {};
      for (const f of fields) miss[f] = 0;
      let sampleKeys = [];
      try { const s = await db.collection(c).limit(1).get(); sampleKeys = s.data[0] ? Object.keys(s.data[0]) : []; } catch (e) {}
      if (total > 0) {
        const grp = { _id: '$name' };
        for (const f of fields) grp['m_' + f] = $a.sum($a.cond([$a.or([$a.eq(['$' + f, null]), $a.eq(['$' + f, ''])]), 1, 0]));
        try {
          const agg = await db.collection(c).aggregate().group(grp).end();
          for (const f of fields) miss[f] = (agg.data || []).reduce((s, d) => s + (d['m_' + f] || 0), 0);
        } catch (e) { out[c] = { err: e.message, total, sampleKeys }; continue; }
      }
      out[c] = { total, missing: miss, sampleKeys };
    }
    return { ok: true, build: BUILD_TAG, out };
  }

  // 维度覆盖诊断：各分表/待审核池的菜名集合差集，找出缺某个维度的菜
  if (action === 'diagCoverage') {
    const cols = {
      steps: 'dish_steps', review: 'dish_review', tips: 'dish_tips', ing: 'dish_ingredients',
      nutri: 'dish_nutrition_v2', profile: 'dish_profile', image: 'dish_image_v2', aiProfile: 'dish_ai_profile',
      guidePending: 'dish_guide_pending', aiProfilePending: 'dish_ai_profile_pending',
      nutriPending: 'dish_nutrition_pending', imagePending: 'dish_image_pending', lexiconPending: 'dish_lexicon_pending',
      lexicon: 'dish_lexicon',
    };
    const $a = db.command.aggregate;
    const sets = {};
    for (const k in cols) {
      try {
        const agg = await db.collection(cols[k]).aggregate().group({ _id: '$name', c: $a.sum(1) }).end();
        sets[k] = new Set((agg.data || []).map(d => d._id).filter(Boolean));
      } catch (e) { sets[k] = new Set(); }
    }
    const all = new Set();
    for (const k in sets) for (const v of sets[k]) all.add(v);
    const report = { unionTotal: all.size, sets: {} };
    for (const k in sets) {
      const missingVsUnion = [...all].filter(x => !sets[k].has(x));
      report.sets[k] = { have: sets[k].size, missingVsUnion: missingVsUnion.length, sample: missingVsUnion.slice(0, 8) };
    }
    const base = (sets.lexicon && sets.lexicon.size) ? sets.lexicon : sets.nutri;
    const baseName = (sets.lexicon && sets.lexicon.size) ? 'dish_lexicon' : 'dish_nutrition_v2';
    const core = ['steps', 'review', 'tips', 'ing', 'nutri', 'profile', 'image'];
    report.coreMissingFromBase = { base: baseName, baseSize: base.size };
    for (const k of core) {
      const miss = [...base].filter(x => !sets[k].has(x));
      report.coreMissingFromBase[k] = { missing: miss.length, sample: miss.slice(0, 8) };
    }
    return { ok: true, build: BUILD_TAG, report };
  }

  if (action === 'reject') {
    if (!name) return { ok: false, err: 'name 缺失' };
    await Promise.all([
      db.collection('dish_lexicon_pending').where({ name }).remove(),
      db.collection('dish_ai_profile_pending').where({ name }).remove(),
      db.collection('dish_nutrition_pending').where({ name }).remove(),
      db.collection('dish_guide_pending').where({ name }).remove(),
    ]);
    return { ok: true, build: BUILD_TAG, name };
  }

  // —— 产物分流审核（tab 15-18）：单产物集合的列表 / 通过 / 驳回 / 删除 ——
  const PENDING_COLS = ['dish_lexicon_pending', 'dish_ai_profile_pending', 'dish_nutrition_pending', 'dish_guide_pending', 'dish_image_pending'];
  if (action === 'listPending') {
    const col = event.collection;
    if (!PENDING_COLS.includes(col)) return { ok: false, err: 'collection 不在白名单' };
    const status = event.status || 'pending';
    const res = await db.collection(col).where({ status }).limit(100).get();
    return { ok: true, build: BUILD_TAG, list: (res.data || []) };
  }
  if (action === 'approvePending') {
    const col = event.collection, id = event.id;
    if (!PENDING_COLS.includes(col) || !id) return { ok: false, err: 'collection/id 缺失' };
    await db.collection(col).doc(id).update({ data: { status: 'approved' } });
    return { ok: true, build: BUILD_TAG, id };
  }
  if (action === 'rejectPending' || action === 'deletePending') {
    const col = event.collection, id = event.id;
    if (!PENDING_COLS.includes(col) || !id) return { ok: false, err: 'collection/id 缺失' };
    await db.collection(col).doc(id).remove();
    return { ok: true, build: BUILD_TAG, id };
  }

  return { ok: false, err: 'unknown action' };
};

async function syncBackToEnv2(name, libData) {
  const ENV2_ENV_ID = process.env.ENV2_ENV_ID;
  if (!ENV2_ENV_ID) return;
  const inst2 = new cloud.Cloud({ resourceAppid: 'wx1111111111111111', resourceEnv: ENV2_ENV_ID });
  await inst2.init();
  const c2 = inst2.database();
  await c2.collection('dish_mirror').where({ name }).update({ data: { source: 'env1-lexicon', updatedAt: Date.now() } }).catch(() => null);
}
