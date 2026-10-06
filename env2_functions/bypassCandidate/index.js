// ============================================================================
// bypassCandidate · env2 候菜 per-user 预计算缓存（异步补充模式）
// BUILD_TAG: 2026-08-21.bypass-candidate-season-validate
//
// 职责（详见 env2旁路服务env1规划.md §2 任务③ / §9 T2）：
//   env1 把【每个现有用户】的偏好快照（自带 env1 的 _openid 透传键）批量投递给本函数，
//   本函数逐用户跑候菜算法（UCB 探索 + mmrRerank + dish_exposure 计数），
//   算完【回写 env1 的 recommend_cache 集合】。env1 出文直接读缓存，零候菜计算。
//
// AI-3 匹配打分（阶段1，方案 §7 阶段1，2026-08-21）：
//   bypassAiEnrich 已为 dish_mirror/每道菜生成 profile（AI-1）、为 prefs_mirror/每用户生成
//   profile（AI-2）。本函数 rankCandidates 消费两份画像：用户 likeFlavors/likeCuisines/
//   likeTypes/spicy/avoid 与 菜 flavors/cuisine/type/spicy/main/isVeg/isSoup 做本地匹配打分，
//   叠加到原评分（曝光惩罚等）上，让候选排序体现偏好命中。
//
// 当前阶段（回写已接通 2026-08-21）：
//   - 读数据只来自 env2 本地镜像集合（dish_mirror / exposure_mirror / prefs_mirror），
//     这些集合由 env1 经数据镜像同步填入（§10.2 阻塞项）。
//   - 回写 env1 由配置开关 ENV1_WRITE_BACK 控制；配置 true + ENV1_ENV_ID 后，经共享
//     实例（new cloud.Cloud + 对称 cloudbase_auth + auth.custom 安全规则，§8.1）反向写回
//     env1 recommend_cache。跨账号回写必须在真机小程序端调用链下才换得到 getCrossAccountToken。
//   - 算法核心（computePrefWeights / ucbPick / mmrRerank）为可读简化实现，标注 TODO：
//     待 dish_mirror 等数据就位后，从 env1 getRecommendation 迁入精确逻辑。
// ============================================================================

const BUILD_TAG = '2026-08-22.bypass-candidate-detach-env1';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ── 配置开关 ──────────────────────────────────────────────────────────────

// 批量分片上限（防函数超时，§8.4）
const BATCH_LIMIT = 500;

// §10 时令/过期下架：菜名关键词 → 时令月份集合（1-12），不在表内默认全年应季
// 反季菜在 rankCandidates 中 score -= SEASON_PENALTY 降权（不剔除，好菜仍能上榜）
const SEASON_PENALTY = 3;
const SEASONAL_KEYWORDS = [
  { kw: ['西瓜', '冬瓜', '苦瓜', '丝瓜', '黄瓜', '茄子', '番茄', '西红柿', '豆角', '玉米', '毛豆'], months: [6, 7, 8, 9] },
  { kw: ['白菜', '萝卜', '白萝卜', '茼蒿', '菠菜', '芹菜', '莲藕', '藕', '羊肉', '狗肉', '鲈鱼', '桂鱼', '鲫鱼', '板栗', '山药', '红薯', '白薯'], months: [10, 11, 12, 1, 2, 3] },
  { kw: ['鸭肉', '绿豆', '丝瓜', '苋菜', '空心菜', '龙虾', '大闸蟹', '螃蟹'], months: [6, 7, 8, 9, 10] },
  { kw: ['春笋', '香椿', '豌豆', '蚕豆', '草莓', '樱桃', '枇杷'], months: [3, 4, 5] },
];
// §10 候选包一致性校验：黑名单菜绝不出现在候选中
const BLACKLIST_DISH = ['狗肉', '蛇肉', '猫肉', '果子狸', '蝙蝠', '穿山甲'];

exports.main = async (event) => {
  console.log('[build] bypassCandidate BUILD_TAG=' + BUILD_TAG);
  const { task, openidList, cursor, limit } = event || {};

  // 自检入口：无参数时返回健康信息，便于部署后 invoke 验证 BUILD_TAG 命中
  if (task === 'health') {
    return { ok: true, build: BUILD_TAG };
  }

  // 数据镜像接收（2026-08-21 env1 接线）：env1 getRecommendation 出文后 fire-and-forget
  // 投递该用户偏好快照 + 本次曝光 → 写 env2 本地 prefs_mirror / exposure_mirror。
  // ⚠️ 本分支必须与 env1 侧 env2Client.js 的 payload 约定一致（§3.1 计算输入镜像例外）。
  if (task === 'mirror') {
    return await handleMirror(event);
  }

  // 分片拉取待算用户（来自 env2 本地 prefs_mirror）
  const batchSize = Math.min(Number(limit) || BATCH_LIMIT, BATCH_LIMIT);
  let query = db.collection('prefs_mirror').orderBy('_id', 'asc').limit(batchSize);
  if (cursor) query = query.where(_.gt('_id', cursor));

  let users;
  try {
    const res = await query.get();
    users = res.data || [];
  } catch (e) {
    console.error('[bypassCandidate] 读 prefs_mirror 失败：', e && e.message);
    await logTask('bypassCandidate', null, 'fail', e && e.message);
    return { ok: false, err: 'read_prefs_mirror_failed' };
  }

  if (!users.length) {
    console.log('[bypassCandidate] 本轮无待算用户（prefs_mirror 空或已到末批）');
    return { ok: true, done: true, computed: 0 };
  }

  let computed = 0;
  let lastCursor = cursor;
  for (const u of users) {
    try {
      await computeForUser(u);
      computed++;
      lastCursor = u._id;
    } catch (e) {
      console.error('[bypassCandidate] 用户计算失败 _openid=' + u._openid + '：', e && e.message);
      await logTask('bypassCandidate', u._openid, 'fail', e && e.message);
    }
  }

  // 返回 cursor 供下一轮 cron / 消息驱动继续（§8.4 分片）
  return { ok: true, computed, hasMore: users.length === batchSize, nextCursor: lastCursor };
};

// ── env1 数据镜像接收（task='mirror'，2026-08-21 env1 接线）─────────────────
// env1 getRecommendation 出文后 fire-and-forget 投递该用户偏好快照 + 本次曝光，
// 本函数写 env2 本地 prefs_mirror / exposure_mirror（T2 候菜预计算输入）。
// 与 env1 侧 env2Client.js payload 约定一致：{ task:'mirror', _openid, prefs,
//   chosenPairs, exposedNames, sceneMode, ts }（§3.1 计算输入镜像例外）。
// 写入结构对齐 computeForUser / rankCandidates 的读取端：
//   prefs_mirror    → 按 _openid upsert（读 _openid/prefs/chosenPairs/sceneMode）
//   exposure_mirror → 按 {_openid, name} 累计 cnt（读 name/cnt）
async function handleMirror(event) {
  const openid = event._openid;
  if (!openid) {
    console.warn('[bypassCandidate] mirror 缺 _openid，跳过');
    return { ok: false, err: 'missing_openid' };
  }

  try {
    // 1) 偏好快照 upsert（命中则更新，未命中则新增）。
    //    ⚠️ 2026-08-21 真机实测修复：wx-server-sdk 2.6.3 无 .where().upsert() 方法
    //    （env1 投递 mirror 返回 "db.collection(...).where(...).upsert is not a function"）。
    //    改为先查后写：exists → doc(id).update，否则 add。建议给 prefs_mirror 补
    //    {_openid} 唯一索引防并发重复，骨架阶段容忍。
    await upsertDoc('prefs_mirror', { _openid: openid }, {
      _openid: openid,
      prefs: event.prefs || {},
      chosenPairs: Array.isArray(event.chosenPairs) ? event.chosenPairs : [],
      sceneMode: event.sceneMode || 'default',
      ts: event.ts || Date.now(),
      updatedAt: Date.now(),
    });

    // 2) 曝光计数累计（同批去重；建议 exposure_mirror 补 {_openid, name} 唯一索引）
    const names = [...new Set((Array.isArray(event.exposedNames) ? event.exposedNames : []).filter(Boolean))];
    for (const name of names) {
      await bumpExposureMirror(openid, name);
    }

    // 3) 菜库镜像（dish_mirror 候选池）：
    //    ⚠️ 2026-08-21 实测修复：dish_mirror 原本没有任何写入源（env1 未投递菜库、env2 无写入点），
    //    预计算读空池 → rankCandidates 恒返回 [] → 回写 env1 recommend_cache candidates=[]（空缓存）。
    //    改为每次 mirror 把【本次曝光菜 + 本次候选菜】按 name upsert 进 dish_mirror（baseScore=1），
    //    随出文次数累积候选池；rankCandidates 按曝光惩罚排序，天然倾向「没被推荐过的菜」（探索语义）。
    //    骨架阶段 chosenPairs 只取前 30，避免单次 mirror 写太多、撞 env1 侧 3s 超时兜底。
    const dishNames = new Set(names);
    (Array.isArray(event.chosenPairs) ? event.chosenPairs : [])
      .slice(0, 30)
      .forEach(p => { if (p && typeof p.name === 'string' && p.name) dishNames.add(p.name); });
    for (const name of dishNames) {
      await upsertDoc('dish_mirror', { name }, {
        name,
        baseScore: 1,
        updatedAt: Date.now(),
      });
    }

    await logTask('bypassCandidate-mirror', openid, 'ok', null);
    return { ok: true, exposureBumped: names.length };
  } catch (e) {
    console.error('[bypassCandidate] mirror 失败 _openid=' + openid + '：', e && e.message);
    await logTask('bypassCandidate-mirror', openid, 'fail', e && e.message);
    return { ok: false, err: (e && e.message) || 'mirror_failed' };
  }
}

// 通用 upsert（先查后写）：wx-server-sdk 2.6.3 无 .where().upsert()，
// 命中 where 条件则更新首个文档，未命中则新增。按记忆中的 2.6.3 写回坑规范：
// 更新用 doc(id).update({data})，新增用 add({data})，禁止 doc(id).set()。
async function upsertDoc(colName, whereObj, data) {
  const col = db.collection(colName);
  const exist = await col.where(whereObj).limit(1).get();
  if (exist.data && exist.data.length) {
    await col.doc(exist.data[0]._id).update({ data });
    return { mode: 'update', id: exist.data[0]._id };
  }
  const added = await col.add({ data });
  return { mode: 'add', id: added._id };
}

// exposure_mirror 按 {_openid, name} 原子累加曝光计数（inc-or-add 模式）
async function bumpExposureMirror(openid, name) {
  const col = db.collection('exposure_mirror');
  try {
    const upd = await col.where({ _openid: openid, name }).update({ data: { cnt: _.inc(1), updatedAt: Date.now() } });
    if (!upd.stats || !upd.stats.updated) {
      // 文档不存在 → 首条曝光
      try {
        await col.add({ data: { _openid: openid, name, cnt: 1, updatedAt: Date.now() } });
      } catch (e2) {
        // 并发 add 撞唯一约束：改查后 inc
        const q = await col.where({ _openid: openid, name }).limit(1).get();
        if (q.data && q.data.length) {
          await col.doc(q.data[0]._id).update({ data: { cnt: _.inc(1) } });
        } else {
          throw e2;
        }
      }
    }
  } catch (e) {
    console.warn('[bypassCandidate] exposure_mirror bump 失败 _openid=' + openid + ' name=' + name + '：', e && e.message);
  }
}

// 单用户候菜预计算
async function computeForUser(user) {
  const openid = user._openid; // env1 透传键，原样回写
  if (!openid) {
    console.warn('[bypassCandidate] 用户缺 _openid，跳过');
    return;
  }

  // 读该用户镜像状态（exposure_mirror / dish_mirror 候选池）
  const [exposure, dishPool] = await Promise.all([
    db.collection('exposure_mirror').where({ _openid: openid }).get(),
    db.collection('dish_mirror').limit(1000).get(),
  ]);

  const candidates = rankCandidates({
    prefs: user.prefs || {},
    prefsProfile: user.profile || null,   // AI-2 偏好画像（bypassAiEnrich 生成）
    chosenPairs: user.chosenPairs || [],
    exposure: exposure.data || [],
    dishPool: dishPool.data || [],
    sceneMode: user.sceneMode || 'default',  // §11 场景匹配（早午晚餐）
  });

  const cacheDoc = {
    _openid: openid,
    sceneMode: user.sceneMode || 'default',
    candidates,
    computedAt: Date.now(),
    expireAt: Date.now() + 24 * 3600 * 1000, // 24h 过期
  };
  // AI-3 观察日志：验证候选排序是否体现偏好画像命中（不改变任何行为）
  console.log('[bypassCandidate] AI-3 测算 candidates=' + JSON.stringify(candidates));

  // §10 候选包一致性校验：回写前校验候选合法性，校验失败不回写（保留已有缓存）
  const validation = validateCacheDoc(cacheDoc);
  if (!validation.ok) {
    console.warn('[bypassCandidate] 候选包校验失败 _openid=' + openid + '：' + validation.err);
    await logTask('bypassCandidate', openid, 'fail', 'validate_failed: ' + validation.err);
    return;
  }

  // 写 env2 本地 recommend_cache（env2 副本）
  // ⚠️ 2026-08-21 修复：wx-server-sdk 无 .upsert()，改先查后写。
  await upsertDoc('recommend_cache', { _openid: openid }, cacheDoc);

  await logTask('bypassCandidate', openid, 'ok', null);
}



// ── 候菜算法（简化骨架，TODO 待迁 env1 getRecommendation 精确实现）────────────
// 精确版应含：computePrefWeights（时间衰减偏好）、ucbPick（UCB 定向探索）、
// mmrRerank（MMR 跨场景去重）。当前为可读占位，保证管道可跑。
function rankCandidates({ prefs, prefsProfile, chosenPairs, exposure, dishPool, sceneMode }) {
  // TODO: 接入 env1 算法（getRecommendation/index.js:
  //   computePrefWeights@1067 / ucbPick@1501 / mmrRerank@1684 / readExploreStats@1487）
  // 骨架：AI 画像匹配加分（AI-3）+ 曝光反向降权 + 忌口过滤，返回前 N 个候选名
  const blocked = new Set((prefs.avoid || []).concat(prefs.softDislike || []));
  // exposure_mirror 文档结构 {_openid, name, cnt}（env1 镜像写入，handleMirror），
  // 菜名取 name 而非 _id（_id 为自动主键）
  const expMap = {};
  (exposure || []).forEach(e => { expMap[e.name] = e.cnt || 0; });

  const scored = (dishPool || [])
    .map(d => {
      const name = d.name || d.dishName;
      if (blocked.has(name)) return null;
      let score = (d.baseScore || 1) - Math.log1p(expMap[name] || 0); // 曝光越多降权越多（探索）
      // §10 时令/过期下架：反季菜降权（不剔除，好菜仍能上榜）
      if (isOutOfSeason(name)) score -= SEASON_PENALTY;
      // AI-3 匹配打分：用户偏好画像 × 菜品画像（bypassAiEnrich 生成）
      if (prefsProfile && d.profile) {
        score += aiMatchBonus(prefsProfile, d.profile);
      }
      // §11 早午晚餐场景匹配：场景命中加分，不符降权
      if (sceneMode && sceneMode !== 'default' && Array.isArray(d.mealTime)) {
        if (d.mealTime.indexOf(sceneMode) >= 0) score += 3;
        else score -= 2;
      }
      return { name, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 20).map(s => s.name);
}

// AI-3 画像匹配加分（0~N，全本地计算，不消耗 AI 额度）：
// 口味命中/菜系命中/分类命中/忌口扣分/辣度落位 都算进去，让候选排序体现偏好。
function aiMatchBonus(pp, dp) {
  let bonus = 0;
  const dishFlavors = dp.flavors || [];
  const dishCuisine = dp.cuisine || '';
  const dishType = dp.type || '';
  // 口味命中
  (pp.likeFlavors || []).forEach(f => {
    if (dishFlavors.indexOf(f) >= 0) bonus += 2;
  });
  // 菜系命中
  (pp.likeCuisines || []).forEach(c => {
    if (c && dishCuisine && dishCuisine.indexOf(c) >= 0) bonus += 3;
  });
  // 分类命中（荤/素/汤/主食）
  (pp.likeTypes || []).forEach(t => {
    if (t && dishType && dishType.indexOf(t) >= 0) bonus += 2;
  });
  // 忌口扣分（画像级避免）
  (pp.avoid || []).forEach(a => {
    if (a && (dishFlavors.indexOf(a) >= 0 || (dishType && dishType.indexOf(a) >= 0))) bonus -= 6;
  });
  // 主食品类：只在偏好主食时给主食加分
  if (pp.likeStaple && dishType === '主食') bonus += 2;
  // 辣度落位：偏好中辣配中辣 +1；偏好不辣遇重辣 -2
  if (typeof pp.spicy === 'number' && typeof dp.spicy === 'number') {
    if (Math.abs(pp.spicy - dp.spicy) <= 1) bonus += 1;
    else if (pp.spicy === 0 && dp.spicy >= 3) bonus -= 2;
  }
  return bonus;
}

// §10 时令/过期下架：判断菜名是否反季（当前月份不在时令月份集合内）
// 不在 SEASONAL_KEYWORDS 表内的菜默认全年应季（返回 false）
// 返回中国时区（UTC+8）的 Date，避免云函数运行在 UTC 时区导致 getMonth 判断错乱
function chinaDate() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + 8 * 3600000);
}
function isOutOfSeason(name) {
  if (!name) return false;
  const month = chinaDate().getMonth() + 1; // 1-12
  for (const seg of SEASONAL_KEYWORDS) {
    for (const kw of seg.kw) {
      if (name.indexOf(kw) >= 0) {
        return seg.months.indexOf(month) < 0; // 命中关键词但当前月不在时令集合 → 反季
      }
    }
  }
  return false; // 未命中任何关键词 → 全年应季
}

// §10 候选包一致性校验：回写 recommend_cache 前校验候选合法性
// 校验失败仅记 bypass_log 不写库，不影响主链路（env1 有兜底）
function validateCacheDoc(cacheDoc) {
  if (!cacheDoc || !Array.isArray(cacheDoc.candidates)) {
    return { ok: false, err: 'candidates_not_array' };
  }
  if (cacheDoc.candidates.length === 0) {
    return { ok: false, err: 'candidates_empty' }; // 空候选不回写，避免覆盖已有好缓存
  }
  if (cacheDoc.candidates.length > 20) {
    return { ok: false, err: 'candidates_too_many:' + cacheDoc.candidates.length };
  }
  for (const name of cacheDoc.candidates) {
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, err: 'candidate_invalid_name' };
    }
    if (BLACKLIST_DISH.some(b => name.indexOf(b) >= 0)) {
      return { ok: false, err: 'blacklist_dish:' + name };
    }
  }
  return { ok: true };
}

// bypass_log 可观测性（§8.7）
async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* 日志失败不影响主流程 */ }
}
