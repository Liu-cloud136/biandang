// ============================================================================
// bypassAutoAdd · env2 补菜链自动化消费端（候选池 → mirror 全维 → ready → 漏斗）
// BUILD_TAG: 2026-09-11.bypass-auto-add-v3-invoketimeout
//
// 职责（对应 docs/env2补菜链自动化详细设计.md §4.1）：
//   1. 巡检对齐：status=ready 但 mirror 同名已消失 → 查 rejected_names 归属 → done/rejected
//   2. 认领：status=new → doing（条件更新+租约，防双 tick 并发）；规则查重（黑名单/rejected_names/env1 词库精确）
//   3. 逐维直调：reason→profile→ingredients→steps→tips→review→nutrition→image（硬 8 键），guide 软键
//      时间盒内串行；盒尽未齐 → 保 doing 下轮续跑（断点续传，mirror 是真相源）
//   4. 全维闸门通过 → ready，等 Armbian review-web 漏斗消费（AI 查重 → 入 env1 → 删 mirror）
//   5. 失败：单维空结果累计 ≥3 → failed（EMPTY 死磕纪律）；429/超时让出下轮自愈
//
// 2026-09-09 取消每日消费配额（autoAddQuotaDaily 不再限制）：有 new 即按 createdAt 认领，
// 节奏由触发器频率（4min/tick）与时间盒天然限速；候选质量由漏斗 AI 终审兜底。
//
// 触发器：sched-auto-add → 经 bypassScheduler 分发（每 4 分钟档位错开）
// 超时：函数 300s（时间盒 220s + 收尾余量）；出站调用 socket 超时 60s（INVOKE_TIMEOUT_MS）
// 跨账号：env1 词库拉名单查重（cloud.Cloud + ENV1_APPID/ENV1_ENV_ID）
// ============================================================================
const BUILD_TAG = '2026-09-11.bypass-auto-add-v3-invoketimeout';
const cloud = require('wx-server-sdk');

// 2026-09-11 修复「维度调用假超时」：cloud.callFunction 的出站 socket 超时取自
// tcb-admin-node httpRequest 的 `args.timeout || config.timeout || 15000`（默认 15s），
// 而下游维度函数（bypassGenSteps / bypassGenImage 等，内含 AI 调用）实跑常 >15s，
// 于是 invokeDim 每 tick 白烧 15s（时间盒仅 220s 被大量吃掉），并刷
// `[invokeDim] xxx 调用失败: callFunction:fail ESOCKETTIMEDOUT` 噪音（目标函数其实已跑完并写 mirror）。
// 故在 init 时把实例级 timeout 抬到 60s —— 与 bypassScheduler 同款修复。
const INVOKE_TIMEOUT_MS = 60 * 1000;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: INVOKE_TIMEOUT_MS });
const db = cloud.database();
const _ = db.command;

const ENV1_APPID = ''; // 跨账号读取在定时器链路拿不到 token（getCrossAccountToken 需小程序真机链），查重基线改用 env2 本地 dish_lexicon 镜像；漏网者由 Armbian 漏斗 AI 查重兜底
const TIMEBOX_MS = 220 * 1000;
const DIM_SLEEP = 900;
const CLAIM_N = 1;
const MAX_DIM_FAIL = 3;
const BLACKLIST_DISH = ['狗肉', '蛇肉', '猫肉', '果子狸', '蝙蝠', '穿山甲'];
// 硬 8 键顺序：reason/profile/ingredients/steps/tips/review/nutrition/imageUrl（image 最后最贵）
const HARD_DIMS = [
  ['reason', 'bypassGenReason'], ['profile', 'bypassAiEnrich'],
  ['ingredients', 'bypassGenIngredients'], ['steps', 'bypassGenSteps'],
  ['tips', 'bypassGenTips'], ['review', 'bypassText'],
  ['nutrition', 'bypassNutritionEst'], ['imageUrl', 'bypassGenImage'],
];
const GUIDE_DIM = ['guide', 'bypassGenGuide'];
const KIND_BY_CAT = { 荤菜: 'dish', 素菜: 'dish', 汤羹: 'dish', 小吃: 'dish', 甜品: 'dish', 主食: 'staple', 饮品: 'drink' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function logTask(task, name, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: null, status: status || 'ok', errMsg: (errMsg || '').slice(0, 200), computedAt: Date.now() },
    });
  } catch (e) { /* 日志失败不影响主流程 */ }
}
async function readMirror(name) {
  try {
    const r = await db.collection('dish_mirror').where({ name }).limit(1).get();
    return (r.data && r.data[0]) || null;
  } catch (e) { return null; }
}
async function markCand(name, patch) {
  try {
    patch.updatedAt = Date.now();
    await db.collection('dish_candidates').where({ name }).update({ data: patch });
  } catch (e) { console.warn('[markCand] 更新失败 name=' + name + '：', e && e.message); }
}
// ret 型维度（返回值、不写 mirror）：reason / tips / review(+difficulty)
const RET_DIMS = { reason: 'reason', tips: 'tips', review: 'review' };
async function applyRetToMirror(name, dim, payload) {
  // 把 ret 型返回值写入 mirror（幂等），供漏斗/闸门统一读 mirror
  if (!payload || typeof payload !== 'object') return false;
  const data = {};
  if (dim === 'reason' && typeof payload.reason === 'string' && payload.reason.trim()) data.reason = payload.reason.trim();
  if (dim === 'tips' && typeof payload.tips === 'string' && payload.tips.trim()) data.tips = payload.tips.trim();
  if (dim === 'review') {
    if (typeof payload.review === 'string' && payload.review.trim()) data.review = payload.review.trim();
    if (typeof payload.difficulty === 'string' && payload.difficulty.trim()) data.difficulty = payload.difficulty.trim();
    if (typeof payload.tips === 'string' && payload.tips.trim()) data.tips = payload.tips.trim(); // 部分函数把贴士随点评一起回
  }
  if (!Object.keys(data).length) return false;
  try {
    await db.collection('dish_mirror').where({ name }).update({ data: Object.assign(data, { updatedAt: Date.now() }) });
    return true;
  } catch (e) {
    console.warn('[applyRetToMirror] 失败 name=' + name + '：', e && e.message);
    return false;
  }
}
function dimOk(mir, dim) {
  if (!mir) return false;
  const v = mir[dim];
  if (Array.isArray(v)) return v.length > 0;
  if (dim === 'steps') return Array.isArray(v) && v.length >= 3;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return typeof v === 'string' && !!v.trim();
}
function hardLack(mir) {
  const lack = [];
  for (const [dim] of HARD_DIMS) if (!dimOk(mir, dim)) lack.push(dim);
  return lack;
}
const guideOk = (mir) => dimOk(mir, 'guide');

// ── ① 巡检对齐：ready 且 mirror 已消失 → 终态回标 ──────────────────────────
async function alignConsumed() {
  let done = 0, rejected = 0;
  try {
    const res = await db.collection('dish_candidates').where({ status: 'ready' }).limit(100).get();
    for (const cand of res.data || []) {
      const mir = await readMirror(cand.name);
      if (mir) continue;
      let isRejected = false;
      try {
        const r = await db.collection('rejected_names').where({ name: cand.name }).limit(1).get();
        isRejected = !!(r.data && r.data.length);
      } catch (e) { /* ignore */ }
      if (isRejected) { await markCand(cand.name, { status: 'rejected', note: 'funnel_rejected', doneAt: Date.now() }); rejected++; }
      else { await markCand(cand.name, { status: 'done', note: 'mirror_consumed', doneAt: Date.now() }); done++; }
      await logTask('bypassAutoAdd', cand.name, 'ok', 'align:' + (isRejected ? 'rejected' : 'done'));
    }
  } catch (e) {
    console.warn('[bypassAutoAdd] align 失败：', e && e.message);
  }
  return { done, rejected };
}

// ── ② 认领（条件更新 new→doing + 租约 + 规则查重）─────────────────────────
// 2026-09-09 取消每日消费配额（autoAddQuotaDaily 不再限制），有 new 即按 createdAt asc 认领
async function claimOne(lexNames) {
  if (!lexNames) return null;
  try {
    const res = await db.collection('dish_candidates').where({ status: 'new' }).orderBy('createdAt', 'asc').limit(CLAIM_N).get();
    for (const cand of res.data || []) {
      const nm = String(cand.name || '').trim();
      if (!nm) continue;
      const reject = async (why) => {
        await markCand(nm, { status: 'rejected', dupOf: '', note: why, doneAt: Date.now() });
        await logTask('bypassAutoAdd', nm, 'skip', why);
      };
      if (BLACKLIST_DISH.some(b => nm.indexOf(b) >= 0)) { await reject('blacklist'); continue; }
      let black = false;
      try {
        const r = await db.collection('rejected_names').where({ name: nm }).limit(1).get();
        black = !!(r.data && r.data.length);
      } catch (e) { /* ignore */ }
      if (black) { await reject('rejected_names'); continue; }
      if (lexNames.has(nm)) { await reject('dup_env1'); continue; }
      const mir = await readMirror(nm);
      if (mir && mir.source !== 'candidate-auto') { await reject('mirror_exists'); continue; }
      // mir==null（全新）或 source=candidate-auto（部分维度残留，断点续跑）→ 都可认领
      const upd = await db.collection('dish_candidates')
        .where({ name: nm, status: 'new' })
        .update({
          data: {
            status: 'doing',
            lease: { until: Date.now() + 20 * 60 * 1000, by: BUILD_TAG },
            progress: { doneDims: [], lastDim: '', rounds: 0 },
            fail: { count: 0, dims: {} },
            updatedAt: Date.now(),
          },
        });
      if (upd && upd.stats && upd.stats.updated > 0) {
        await ensureSkeletonMerge(cand);
        await logTask('bypassAutoAdd', nm, 'ok', 'claimed source=' + (cand.source || '?'));
        return Object.assign({}, cand, { name: nm });
      }
    }
  } catch (e) {
    console.warn('[bypassAutoAdd] claim 失败：', e && e.message);
  }
  return null;
}

// ── ③ 续跑选择：doing 中最早更新的那道 ─────────────────────────────────────
async function pickDoing() {
  try {
    const res = await db.collection('dish_candidates').where({ status: 'doing' }).orderBy('updatedAt', 'asc').limit(3).get();
    return (res.data && res.data[0]) || null;
  } catch (e) { return null; }
}

// ── ④ 单菜推进（时间盒内）──────────────────────────────────────────────────
// 骨架：已存在则合并骨架字段（不碰已生成的维度），不存在则整建
async function ensureSkeletonMerge(cand) {
  const kind = KIND_BY_CAT[cand.category] || cand.kind || 'dish';
  const patch = {
    source: 'candidate-auto', valid: true,
    category: cand.category || '', kind, cuisine: cand.cuisine || '家常',
    main: cand.main || '', mealTime: cand.mealTime || [], season: cand.season || [],
    updatedAt: Date.now(),
  };
  try {
    const ex = await db.collection('dish_mirror').where({ name: cand.name }).limit(1).get();
    if (ex.data && ex.data.length) {
      await db.collection('dish_mirror').doc(ex.data[0]._id).update({ data: patch });
    } else {
      await db.collection('dish_mirror').doc(cand.name).set({ data: Object.assign({ name: cand.name, norm_id: cand.name, genAt: Date.now() }, patch) });
    }
    return true;
  } catch (e) {
    console.warn('[ensureSkeletonMerge] 失败 name=' + cand.name + '：', e && e.message);
    return false;
  }
}
async function ensureSkeleton(cand) { return ensureSkeletonMerge(cand); }
async function invokeDim(fnName, dishName) {
  try {
    const r = await cloud.callFunction({ name: fnName, data: { dishName } });
    return r && r.result;
  } catch (e) {
    console.warn('[invokeDim] ' + fnName + ' 调用失败 name=' + dishName + '：', e && e.message);
    return null;
  }
}
async function finalizeReady(name) {
  const mir = await readMirror(name);
  if (!mir) {
    // 收尾瞬间已被漏斗消费 → 直接 done
    await markCand(name, { status: 'done', note: 'mirror_consumed_before_ready', doneAt: Date.now(), readyAt: Date.now() });
    await logTask('bypassAutoAdd', name, 'ok', 'done(mirror_consumed_before_ready)');
    return;
  }
  const g = guideOk(mir);
  await markCand(name, { status: 'ready', readyAt: Date.now(), note: g ? 'full_gate_passed' : 'full_gate_passed guide_missing', updatedAt: Date.now() });
  await logTask('bypassAutoAdd', name, 'ok', 'ready' + (g ? '' : '(guide缺)'));
}
async function processDish(cand) {
  const name = cand.name;
  const deadline = Date.now() + TIMEBOX_MS;
  const failDims = Object.assign({}, (cand.fail && cand.fail.dims) || {});
  let rounds = (cand.progress && cand.progress.rounds) || 0;

  await markCand(name, { lease: { until: Date.now() + 20 * 60 * 1000, by: BUILD_TAG } });

  let mir = await readMirror(name);
  if (!mir) { await ensureSkeleton(cand); mir = await readMirror(name); }
  if (!mir) { await markCand(name, { status: 'failed', note: 'mirror_unreadable' }); return; }

  let lack = hardLack(mir);
  // 硬 8 键齐 → 补软键 guide（尽力一次）→ ready
  if (!lack.length) {
    if (!guideOk(mir)) {
      await invokeDim(GUIDE_DIM[1], name);
      await sleep(DIM_SLEEP);
    }
    await finalizeReady(name);
    return;
  }

  let sameDimStreak = 0, lastDim = '';
  while (Date.now() < deadline) {
    lack = hardLack(mir);
    if (!lack.length) {
      if (!guideOk(mir)) { await invokeDim(GUIDE_DIM[1], name); await sleep(DIM_SLEEP); }
      await finalizeReady(name);
      return;
    }
    const dim = lack[0];
    if (dim !== lastDim) { sameDimStreak = 0; lastDim = dim; }
    const fnName = (HARD_DIMS.find(d => d[0] === dim) || [])[1];
    if (!fnName) { failDims[dim] = MAX_DIM_FAIL; break; }

    const ret = await invokeDim(fnName, name);
    // ret 型维度：把返回 payload 写入 mirror 后再判
    if (RET_DIMS[dim] && ret && typeof ret === 'object') {
      await applyRetToMirror(name, dim, ret);
    }
    const okNow = (await readMirror(name)) || mir;
    if (dimOk(okNow, dim)) {
      failDims[dim] = 0; sameDimStreak = 0;
      mir = okNow;
      rounds++;
      await markCand(name, { progress: { doneDims: [], lastDim: dim, rounds }, fail: { dims: failDims }, updatedAt: Date.now() });
      await sleep(150);
      continue;
    }
    // 没成功：区分 空结果 vs 瞬时失败
    if (ret === null) {
      // 瞬时（429/超时/异常）：同维连续 2 次仍失败 → 让出本 tick 下轮自愈
      sameDimStreak++;
      if (sameDimStreak >= 2) { await markCand(name, { note: 'transient_yield:' + dim }); return; }
      await sleep(400);
      continue;
    }
    // 确定性空结果
    failDims[dim] = (failDims[dim] || 0) + 1;
    await logTask('bypassAutoAdd-dim', name, 'fail', dim + '_empty x' + failDims[dim]);
    await markCand(name, { fail: { dims: failDims }, updatedAt: Date.now() });
    if (failDims[dim] >= MAX_DIM_FAIL) {
      await markCand(name, { status: 'failed', note: 'dim_empty_x' + MAX_DIM_FAIL + ':' + dim, fail: { dims: failDims, lastErr: dim + ' 确定性空结果' } });
      await logTask('bypassAutoAdd', name, 'fail', 'failed dim=' + dim);
      return;
    }
    // 该维本轮失败 → 尝试下一个缺失维
    const mirTmp = okNow;
    const nextLack = hardLack(mirTmp).filter(x => x !== dim);
    if (!nextLack.length) { await markCand(name, { note: 'stalled_at:' + dim }); return; }
    mir = mirTmp;
    await sleep(150);
  }
  // 时间盒尽
  const mirEnd = await readMirror(name) || mir;
  const endLack = hardLack(mirEnd);
  if (!endLack.length) { await finalizeReady(name); return; }
  await markCand(name, { progress: { doneDims: [], lastDim: endLack[0], rounds: rounds + 1 }, note: 'timebox:缺 ' + endLack.join('/'), updatedAt: Date.now() });
}

// ── 主入口 ──────────────────────────────────────────────────────────────────
exports.main = async (event) => {
  console.log('[build] bypassAutoAdd BUILD_TAG=' + BUILD_TAG);
  const { task } = event || {};
  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, timeboxMs: TIMEBOX_MS, claimN: CLAIM_N };
  }
  const startedAt = Date.now();
  const align = await alignConsumed();

  // 词库名单（规则查重基线 = env2 本地 dish_lexicon 镜像；失败则本轮不认领新菜，保守）
  let lexNames = null;
  try {
    lexNames = new Set();
    for (let off = 0; off < 6000; off += 1000) {
      const r = await db.collection('dish_lexicon').field({ name: true }).skip(off).limit(1000).get();
      const b = r.data || [];
      b.forEach(d => lexNames.add(String(d.name || '').trim()));
      if (b.length < 1000) break;
    }
  } catch (e) {
    console.warn('[bypassAutoAdd] 拉 env2 本地词库失败：', e && e.message);
    lexNames = null;
  }

  let working = await pickDoing();
  if (!working) working = await claimOne(lexNames);
  let processed = 0;
  if (working) { await processDish(working); processed = 1; }

  let stats = { new: -1, doing: -1, ready: -1, failed: -1 };
  try {
    const [a, b, c, d] = await Promise.all([
      db.collection('dish_candidates').where({ status: 'new' }).count(),
      db.collection('dish_candidates').where({ status: 'doing' }).count(),
      db.collection('dish_candidates').where({ status: 'ready' }).count(),
      db.collection('dish_candidates').where({ status: 'failed' }).count(),
    ]);
    stats = { new: a.total, doing: b.total, ready: c.total, failed: d.total };
  } catch (e) { /* ignore */ }

  await logTask('bypassAutoAdd', null, 'ok',
    'align=' + align.done + '/' + align.rejected + ' work=' + processed + ' stats=' + JSON.stringify(stats));
  console.log('[bypassAutoAdd] tick 完成 processed=' + processed + ' stats=' + JSON.stringify(stats) + ' 耗时ms=' + (Date.now() - startedAt));
  return { ok: true, build: BUILD_TAG, align, processed, stats };
};
