// checkSevenPiece · 检查 env1 通过审核和待审核菜的 7 件套完整性
// 7 件套：profile / nutrition / guide / ingredients / steps / tips / imageUrl
const BUILD_TAG = '2026-08-26.checkSevenPiece-steps-from-shunt';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const FIELDS = ['profile', 'nutrition', 'guide', 'ingredients', 'steps', 'tips', 'imageUrl'];

const ENV2_APPID = 'wx1111111111111111';
const ENV2_ENV_ID = 'your-env-id-2';

// 全量拉取统一用 _id 游标分页，规避云开发 skip 上限 1000（集合不存在时 cursorFetch 内部已容错返回空）
const { fetchAll } = require('./_shared/cursorFetch');

exports.main = async (event, context) => {
  console.log('[build] checkSevenPiece BUILD_TAG=' + BUILD_TAG);

  // ---- deletePending 模式：删除指定菜名在 5 个 _pending 集合的记录 ----
  if (event.action === 'deletePending') {
    const names = Array.isArray(event.names) ? event.names : [];
    if (!names.length) return { ok: false, err: 'names 为空' };
    const colls = ['dish_lexicon_pending', 'dish_ai_profile_pending', 'dish_nutrition_pending', 'dish_guide_pending', 'dish_image_pending'];
    const result = {};
    for (const coll of colls) {
      let removed = 0;
      for (const name of names) {
        try {
          const r = await db.collection(coll).where({ name }).remove();
          removed += (r && r.stats && r.stats.removed) || 0;
        } catch (e) { console.warn('[del] ' + coll + ' ' + name + ' 失败：' + ((e && e.message) || e)); }
      }
      result[coll] = removed;
    }
    return { ok: true, action: 'deletePending', count: names.length, result };
  }

  // ---- regenReq 模式：跨账号写 env2 dish_regenerate_req（绕过 OPENID 校验）----
  if (event.action === 'regenReq') {
    const name = event.name;
    if (!name) return { ok: false, err: '缺少菜名' };
    const targets = Array.isArray(event.targets) ? event.targets : ['steps'];
    let inst2, c2;
    try {
      inst2 = new cloud.Cloud({ resourceAppid: ENV2_APPID, resourceEnv: ENV2_ENV_ID });
      await inst2.init();
      c2 = inst2.database();
    } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }
    let reqId = '';
    try {
      const r = await c2.collection('dish_regenerate_req').add({
        data: { name, targets, status: 'pending', createdAt: Date.now() }
      });
      reqId = r._id;
    } catch (e) { return { ok: false, err: '写 env2 dish_regenerate_req 失败：' + ((e && e.message) || e) }; }
    return { ok: true, action: 'regenReq', name, targets, reqId, msg: '已提交 env2，约2分钟后可 resyncSteps' };
  }

  // ---- resyncSteps 模式：从 env2 dish_mirror 读回指定菜的字段，更新 env1 ----
  if (event.action === 'resyncSteps') {
    const name = event.name;
    if (!name) return { ok: false, err: '缺少菜名' };
    let inst2, c2;
    try {
      inst2 = new cloud.Cloud({ resourceAppid: ENV2_APPID, resourceEnv: ENV2_ENV_ID });
      await inst2.init();
      c2 = inst2.database();
    } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }
    // 读 env2 dish_mirror
    let mirror = null;
    try {
      const r = await c2.collection('dish_mirror').where({ name }).limit(1).get();
      mirror = (r.data && r.data[0]) || null;
    } catch (e) { return { ok: false, err: '读 env2 dish_mirror 失败：' + ((e && e.message) || e) }; }
    if (!mirror) return { ok: false, err: 'env2 dish_mirror 无此菜' };
    const steps = mirror.steps || null;
    if (!steps || !Array.isArray(steps) || !steps.length) {
      return { ok: false, err: 'env2 steps 仍为空，dishRegenPoll 可能还没跑完', env2HasGuide: !!mirror.guide };
    }
    // 更新 env1 dish_guide_pending.steps
    let updatedGP = 0;
    try {
      const r = await db.collection('dish_guide_pending').where({ name }).update({ data: { steps } });
      updatedGP = (r && r.stats && r.stats.updated) || 0;
    } catch (e) { console.warn('[resyncSteps] 更新 dish_guide_pending 失败：' + ((e && e.message) || e)); }
    // 写入/更新 cook_guides（补 steps + ingredients + tips）
    let cgOk = false;
    try {
      const existCG = await db.collection('cook_guides').where({ name }).limit(1).get();
      const cgData = { steps, ingredients: mirror.ingredients || null, tips: mirror.tips || null, review: mirror.review || null, difficulty: mirror.difficulty || null };
      if (existCG.data && existCG.data.length) {
        await db.collection('cook_guides').where({ name }).update({ data: cgData });
      } else {
        await db.collection('cook_guides').add({ data: { name, ...cgData, createdAt: db.serverDate() } });
      }
      cgOk = true;
    } catch (e) { console.warn('[resyncSteps] 写 cook_guides 失败：' + ((e && e.message) || e)); }
    return { ok: true, action: 'resyncSteps', name, stepsCount: steps.length, updatedGuidePending: updatedGP, cookGuidesOk: cgOk };
  }

  // 1. dish_guide_pending: name, status, guide/ingredients/steps/tips 存在性
  const gp = await fetchAll('dish_guide_pending', {
    name: true, status: true, guide: true, ingredients: true, steps: true, tips: true
  });

  // 2. dish_ai_profile_pending: name, status, profile 存在性
  const ap = await fetchAll('dish_ai_profile_pending', { name: true, status: true, profile: true });

  // 3. dish_nutrition_pending: name
  const np = await fetchAll('dish_nutrition_pending', { name: true });

  // 4. dish_image_pending: name
  const ip = await fetchAll('dish_image_pending', { name: true });

  // 5. dish_nutrition_v2: _id (菜名，替代已删旧表 dish_nutrition)
  const nut = await fetchAll('dish_nutrition_v2', {});

  // 6. dish_steps: _id (菜名，替代已废弃旧表 dish_guide)
  const dg = await fetchAll('dish_steps', {});

  // 7. cook_guides: _id/name, ingredients/steps/tips 存在性
  const cg = await fetchAll('cook_guides', { name: true, ingredients: true, steps: true, tips: true });

  // 8. dish_image_v2: _id (菜名，替代已删旧表 dish_images)
  const img = await fetchAll('dish_image_v2', {});

  // 9. dish_lexicon: name, profile 存在性
  const lex = await fetchAll('dish_lexicon', { name: true, profile: true });

  // 9.1 阶段 4：新分表纳入七件套判定（_id=norm_id，弱归一对齐菜名）
  // dish_ingredients: ingredients[] + steps[]
  const di = await fetchAll('dish_ingredients', { norm_id: true, ingredients: true, steps: true });
  // dish_review: review + difficulty
  const dr = await fetchAll('dish_review', { norm_id: true, review: true, difficulty: true });
  // dish_tips: tips
  const dt = await fetchAll('dish_tips', { norm_id: true, tips: true });
  const diMap = new Map();   // norm_id -> {hasIng, hasSteps}
  for (const d of di) {
    if (!d.norm_id) continue;
    diMap.set(d.norm_id, {
      hasIng: Array.isArray(d.ingredients) && d.ingredients.length > 0,
      hasSteps: Array.isArray(d.steps) && d.steps.length > 0
    });
  }
  const drMap = new Map();   // norm_id -> hasReview
  for (const d of dr) {
    if (!d.norm_id) continue;
    drMap.set(d.norm_id, !!(d.review && String(d.review).trim()));
  }
  const dtMap = new Map();   // norm_id -> hasTips
  for (const d of dt) {
    if (!d.norm_id) continue;
    dtMap.set(d.norm_id, !!(d.tips && String(d.tips).trim()));
  }
  const normName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // 构建索引
  const apMap = new Map(); // name -> {status, hasProfile}
  for (const d of ap) {
    if (!d.name) continue;
    const hasProfile = d.profile != null && typeof d.profile === 'object' && Object.keys(d.profile).length > 0;
    // 保留 status=approved 优先，否则任意
    const prev = apMap.get(d.name);
    if (!prev || (d.status === 'approved' && prev.status !== 'approved')) {
      apMap.set(d.name, { status: d.status, hasProfile });
    } else if (prev && !prev.hasProfile && hasProfile) {
      prev.hasProfile = true;
    }
  }

  const npSet = new Set(np.filter(d => d.name).map(d => d.name));
  const ipSet = new Set(ip.filter(d => d.name).map(d => d.name));
  const nutSet = new Set(nut.map(d => d._id));
  const dgSet = new Set(dg.map(d => d._id));
  const dgHasSteps = new Set(dg.filter(d => Array.isArray(d.steps) && d.steps.length > 0).map(d => d._id)); // 分表 steps 非空才认（优先口径）
  const imgSet = new Set(img.map(d => d._id));

  const cgMap = new Map(); // name -> {hasIng, hasSteps, hasTips}
  for (const d of cg) {
    const key = d.name || d._id;
    if (!key) continue;
    cgMap.set(key, {
      hasIng: Array.isArray(d.ingredients) && d.ingredients.length > 0,
      hasSteps: Array.isArray(d.steps) && d.steps.length > 0,
      hasTips: !!d.tips
    });
  }

  const lexProfileSet = new Set(); // 有 profile 的 lexicon 菜名
  const lexNameSet = new Set();
  for (const d of lex) {
    if (!d.name) continue;
    lexNameSet.add(d.name);
    if (d.profile != null && typeof d.profile === 'object' && Object.keys(d.profile).length > 0) {
      lexProfileSet.add(d.name);
    }
  }

  // 分析每个 dish_guide_pending 记录
  const pendingIssues = [];   // 待审核不齐
  const approvedIssues = [];  // 已审核不齐
  const pendingOk = [];
  const approvedOk = [];

  for (const d of gp) {
    const name = d.name;
    if (!name) continue;
    const status = d.status || 'pending';

    // 自身字段
    const selfGuide = !!d.guide;
    const selfIng = Array.isArray(d.ingredients) && d.ingredients.length > 0;
    const selfSteps = Array.isArray(d.steps) && d.steps.length > 0;
    const selfTips = !!d.tips;

    const missing = [];

    if (status === 'pending') {
      // 待审核：检查 _pending 体系
      // profile
      const apInfo = apMap.get(name);
      if (!apInfo || !apInfo.hasProfile) missing.push('profile');
      // nutrition
      if (!npSet.has(name)) missing.push('nutrition');
      // guide
      if (!selfGuide) missing.push('guide');
      // ingredients
      if (!selfIng) missing.push('ingredients');
      // steps（优先认分表 dish_steps 的 steps 非空；pending.steps 也兼容）
      if (!selfSteps && !dgHasSteps.has(name)) missing.push('steps');
      // tips
      if (!selfTips) missing.push('tips');
      // imageUrl
      if (!ipSet.has(name)) missing.push('imageUrl');

      if (missing.length > 0) pendingIssues.push({ name, missing });
      else pendingOk.push(name);
    } else {
      // 已审核：检查正式集合 + _pending(approved)
      // profile: dish_ai_profile_pending(approved) 有 profile，或 dish_lexicon 有 profile
      const apInfo = apMap.get(name);
      const hasProfile = (apInfo && apInfo.hasProfile) || lexProfileSet.has(name);
      if (!hasProfile) missing.push('profile');
      // nutrition: dish_nutrition_v2 有
      if (!nutSet.has(name)) missing.push('nutrition');
      // steps: dish_steps 分表 steps 非空（替代已废弃 dish_guide；仅存在但 steps 空不算有）
      if (!dgHasSteps.has(name)) missing.push('steps');
      // 阶段 4：新分表按 norm_id 对齐菜名判定 ingredients/steps/tips/review
      const nid = normName(name);
      const diInfo = diMap.get(nid);
      const drInfo = drMap.get(nid);
      const dtInfo = dtMap.get(nid);
      const cgInfo = cgMap.get(name);
      const hasIng = (diInfo && diInfo.hasIng) || (cgInfo && cgInfo.hasIng) || selfIng;
      if (!hasIng) missing.push('ingredients');
      const hasSteps = (diInfo && diInfo.hasSteps) || (cgInfo && cgInfo.hasSteps) || selfSteps || dgHasSteps.has(name);
      if (!hasSteps) missing.push('steps');
      const hasTips = (dtInfo) || (cgInfo && cgInfo.hasTips) || selfTips;
      if (!hasTips) missing.push('tips');
      // review: 新分表 dish_review 有（难度同源，计入七件套 review 维度）
      if (!drInfo) missing.push('review');
      // imageUrl: dish_image_v2 有（替代已删 dish_images）
      if (!imgSet.has(name)) missing.push('imageUrl');

      if (missing.length > 0) approvedIssues.push({ name, missing });
      else approvedOk.push(name);
    }
  }

  // 统计
  const summary = {
    buildTag: BUILD_TAG,
    collections: {
      dish_guide_pending: gp.length,
      dish_ai_profile_pending: ap.length,
      dish_nutrition_pending: np.length,
      dish_image_pending: ip.length,
      dish_nutrition_v2: nut.length,
      dish_steps: dg.length,
      cook_guides: cg.length,
      dish_image_v2: img.length,
      dish_lexicon: lex.length
    },
    pending: {
      total: pendingOk.length + pendingIssues.length,
      ok: pendingOk.length,
      issue: pendingIssues.length
    },
    approved: {
      total: approvedOk.length + approvedIssues.length,
      ok: approvedOk.length,
      issue: approvedIssues.length
    }
  };

  return { ok: true, summary, pendingIssues, approvedIssues };
};
