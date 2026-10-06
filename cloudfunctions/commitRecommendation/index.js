const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 探索方向精确采纳（方案A）：菜名→大类 label 映射，与 getRecommendation 同源副本。
// DISH_TAGS 不引入（探索为粗粒度大类，matchKeyword 缺省回退子串匹配足够）。
const { DRIFT_MEAT, matchKeyword } = require('./sync_weights');
const { logErr } = require('./logErr');

// BUILD_TAG: 2026-09-06.user-dish-log（用户档案埋点：selectedDishes 回填 history.selected + 逐道写 user_dish_log）
// 2026-09-07.per-scene-deduct：扣次去阶梯，N 场景扣 N 次（每场景 1 次），用户定稿
// 2026-09-07.drop-userdishlog：移除 user_dish_log 死埋点（集合从未建/零读取），仅保留 history.selected 回填
const BUILD_TAG = '2026-09-07.drop-userdishlog';

// 内容安全：合并文本一次性校验，命中返回 true（拦截）
async function secCheck(text) {
  if (!text) return false;
  try {
    await cloud.openapi.security.msgSecCheck({ content: String(text) });
    return false;
  } catch (e) {
    const code = e && (e.errCode || e.errcode);
    if (code === 87014) return true;
    console.warn('[commitRecommendation.secCheck] 未拦截（接口可能未开通）：', code, e && e.errMsg);
    return false;
  }
}

// 注：原 3.0 主食/配饮入库保底（ensureStaples）已删除（2026-08-14）——主食/配饮全部交由 AI 生成，
// 函数内不再强制补默认。跨场景去重兜底保留。
// 3.1 跨场景去重兜底：不同场景的「菜品」不应同名重复；保留首次、删后续，每场景至少留 1 道
function dedupCrossScene(groups) {
  const seen = {};
  groups.forEach(g => {
    const dishes = g.dishes || [];
    const hasFresh = dishes.some(it => { const k = (it && it.name) || ''; return k && !seen[k]; });
    const keep = [];
    dishes.forEach(it => {
      const k = (it && it.name) || '';
      if (k && seen[k]) {
        if (hasFresh) return;
        if (keep.length >= 1) return;
      }
      if (k) seen[k] = true;
      keep.push(it);
    });
    g.dishes = keep;
  });
}

// 写入历史带重试：规模大时 recommend_history 写入可能被限流，瞬时失败重试即可恢复，避免用户「决定」失败
async function addHistoryRetry(t, data, times = 3) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await t.collection('recommend_history').add({ data }); }
    catch (e) {
      lastErr = e;
      console.error('[commitRecommendation] 写历史失败(第' + (i + 1) + '次)：', e);
      if (i < times - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

// 探索方向精确采纳回写（方案A）：在事务提交后 await 串行执行，避免 fire-and-forget 被丢弃。
// 仅当【用户实际选中的菜命中探索方向大类】才记 accept+1；未命中则只保留出文侧已记的 cnt。
// 文档 _id='EXPLORE::<dir>'：先 get，存在则 update(accept+1)；不存在则 add 新建（accept:1）。
async function acceptExploreDirs(event, _) {
  const expl = (event && Array.isArray(event.exploreDirs)) ? event.exploreDirs : [];
  const seen = new Set();
  const uniq = expl.filter(d => d && !seen.has(d) && (seen.add(d), true));
  if (!uniq.length) return;
  const sel = (event && Array.isArray(event.selectedDishes)) ? event.selectedDishes : [];
  console.log('[explore] 进入 accept 分支 uniq=' + JSON.stringify(uniq) + ' sel=' + JSON.stringify(sel));
  const now = Date.now();
  // 用户实际选中的菜命中的大类 label 集合（DRIFT_MEAT 映射，与 getRecommendation 同源）
  const dishLabels = new Set();
  sel.forEach(nm => {
    if (!nm) return;
    DRIFT_MEAT.forEach(m => { if (m.kw && m.kw.some(k => matchKeyword(String(nm), k))) dishLabels.add(m.label); });
  });
  // 向后兼容：老前端未回传 selectedDishes（sel 为空）时回退旧行为（整轮接受即记 accept），
  // 避免前端未发版导致 accept 全部归零、B② 进度卡死。新前端发版后走精确采纳。
  const oldFrontend = sel.length === 0;
  for (const d of uniq) {
    const dir = String(d || '').trim();
    if (!dir) continue;
    // ⚠️ 精确采纳口径：exploreTarget/exploreCross 抽中的是小类名（如"五花肉"），
    // 而 dishLabels 收集的是 DRIFT_MEAT 的 label（如"猪肉"）。这里把探索方向 dir 归一为其所属
    // DRIFT_MEAT 项的 kw 簇，再判【用户选中菜名】是否命中任一 kw（dir 是 label 或小类都覆盖）。
    // ⚠️ 匹配方向修正（2026-08-14.fix-explore-dirmatch）：原 `m.kw.indexOf(dir)>=0` 是反向子串匹配，
    // 即要求 DRIFT_MEAT 的 kw 数组里存在与探索方向 dir 完全相等的字符串（如 kw=["肘"] 含 "肘子" → false），
    // 导致 dir="肘子" 永远匹配不上 → dirKw 恒空 → 判定未采纳 → accept 永不 +1。
    // 修正：用 matchKeyword(dir, m.kw) 判【探索方向 dir 是否命中该 DRIFT_MEAT 项的 kw 簇】
    // （如 "肘子" 经 matchKeyword 命中 kw "肘" → 收集 dirKw），与 dishLabels 构建口径一致。
    const dirKw = [];
    DRIFT_MEAT.forEach(m => {
      if (m.label === dir || (m.kw && m.kw.some(k => matchKeyword(dir, k)))) {
        (m.kw || []).forEach(k => { if (dirKw.indexOf(k) < 0) dirKw.push(k); });
      }
    });
    const adopted = oldFrontend
      ? true
      : (dirKw.length
          ? sel.some(nm => dirKw.some(k => matchKeyword(String(nm), k)))
          : dishLabels.has(dir));
    const id = 'EXPLORE::' + dir;
    if (!adopted) {
      console.log('[explore] 未采纳（用户未选探索菜） id=' + id);
      continue; // 未采纳则只保留出文侧已记的 cnt，不再虚增 accept
    }
    // 先 get，查到就 update(accept+1, cnt同步+1)；查不到(文档不存在)则 add 新建（cnt:1, accept:1）。
    // 注：采纳必然隐含"至少被推过1次"，故 cnt 初值不可为 0（修复 cnt=0/accept=N 脏数据）。
    try {
      await db.collection('dish_exposure').doc(id).get();
      await db.collection('dish_exposure').doc(id).update({ data: { accept: _.inc(1), cnt: _.inc(1), ts: now } });
      console.log('[explore] accept+1 OK(id存在) id=' + id);
    } catch (ge) {
      // get 抛错（含文档不存在 或大概率 matchedCount=0）时新建，cnt 初值=1（采纳即已推1次）
      try {
        await db.collection('dish_exposure').add({ data: { _id: id, cnt: 1, accept: 1, ts: now } });
        console.log('[explore] accept=1 新建 OK(id=' + id + ', cnt初值1)');
      } catch (ae) {
        console.log('[explore] 写入失败 id=' + id + ' err=' + ((ae && ae.message) || ae));
      }
    }
  }
}

exports.main = async (event, context) => {
  console.log('[build] commitRecommendation BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

    const recs = (event && Array.isArray(event.recommendations)) ? event.recommendations : [];
    // 仅保留有内容的场景，避免为失败/空场景扣次
    const commitRecs = recs.filter(g => g && ((g.dishes || []).length || (g.staples || []).length));
    if (!commitRecs.length) return { code: 400, msg: '无推荐数据' };

    dedupCrossScene(commitRecs);

    // 内容安全（放事务外，纯校验不依赖事务隔离）：命中则拦截，不入库不扣次
    const checkText = commitRecs.map(g =>
      (g.dishes || []).concat(g.staples || [])
        .map(it => (it.name || '') + ' ' + (it.reason || '')).join('\n')
    ).join('\n');
    if (await secCheck(checkText)) {
      return { code: 449, msg: '内容包含不合规信息，已被安全拦截' };
    }

    // ⚠️ 扣次原子化：把「读余额 → 判断 → 写 history → 扣次」放进同一事务，要么全成要么全败。
    // 旧实现读/判断/扣分步进行，用户快速双点或弱网重试 commit 时两个请求都读到同一旧余额，
    // 都能通过 available>=DEDUCT 判断，结果 inc 扣成负数（透支）且都返回成功（白送一次推荐）；
    // 此外旧实现先写 history 再扣次，扣次失败会白送。事务化后：
    // ① 并发请求被串行化——第二个读到已扣减余额 → available<DEDUCT → 403，杜绝透支/白送；
    // ② 扣次失败 / 余额不足 → 整个事务回滚，history 也不留，绝不白送。
    const t = await db.startTransaction();
    try {
      const prefsRes = await t.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
      const prefs = prefsRes.data[0];
      if (!prefs) { await t.rollback(); return { code: 400, msg: '请先设置饮食偏好' }; }
      const baseFree = (typeof prefs.baseFree === 'number') ? prefs.baseFree : 0;
      const bonusFree = (typeof prefs.bonusFree === 'number') ? prefs.bonusFree : 0;

      // 每场景 1 次线性扣（2026-09-07 用户定：去掉「第 3 个起各 2 次」阶梯，N 场景扣 N 次）
      const sceneN = commitRecs.length;
      const DEDUCT = sceneN;
      const available = baseFree + bonusFree;
      if (available < DEDUCT) { await t.rollback(); return { code: 403, msg: '免费次数不足，无法完成本次决定' }; }

      // 写入历史（图片初始为空，用户接受后由 recordFeedback 回填 imageUrl）
      // 带重试：规模大时 recommend_history 写入可能被限流，瞬时失败重试即可恢复，避免用户「决定」失败
      const histAdd = await addHistoryRetry(t, {
        recommendations: commitRecs,
        selected: null,
        feedback: null,
        _openid: OPENID,
        timestamp: new Date()
      });

      // 扣减免费次数（先基础池，不足再从赠送池）
      const fromBase = Math.min(DEDUCT, baseFree);
      const fromBonus = DEDUCT - fromBase;
      if (fromBase > 0) {
        await t.collection('user_preferences').doc(prefs._id).update({ data: { baseFree: _.inc(-fromBase) } });
      }
      if (fromBonus > 0) {
        await t.collection('user_preferences').doc(prefs._id).update({ data: { bonusFree: _.inc(-fromBonus) } });
      }
      await t.commit();

      // 回填 history.selected（2026-09-06）：A2 吃腻/久违统计与 getWeightOverview 画像样本依赖此字段，
      // 历史恒 null 会导致统计空转。原含 user_dish_log 死埋点（集合从未建、零读取）已于 2026-09-07 移除。
      try {
        const selDishes = (Array.isArray(event.selectedDishes) && event.selectedDishes.length) ? event.selectedDishes.map(String) : [];
        if (selDishes.length && histAdd && histAdd._id) {
          await db.collection('recommend_history').doc(histAdd._id).update({ data: { selected: selDishes } }).catch(() => {});
          console.log('[档案] selected 回填 ' + selDishes.length + ' 道: ' + selDishes.join('、'));
        }
      } catch (e) { console.error('[档案] selected 回填失败（不阻断）:', e && e.message); }

      // 流水（非关键，放事务外，失败不阻断主流程）
      try {
        await db.collection('free_log').add({
          data: { _openid: OPENID, type: 'deduct', source: 'recommend', amount: DEDUCT, desc: '推荐决定 -' + DEDUCT, ts: db.serverDate() }
        });
      } catch (e) { console.error('[commitRecommendation] logFree failed:', e); }

      // 方向1 UCB 闭环（方案A 精确采纳）：用户「决定接受」本次推荐，且【实际选中的菜命中探索方向大类】
      // 才算该方向被采纳。修复此前「整轮接受即记 accept」导致的采纳率虚高（用户没选探索菜也计采纳）。
      // 前端回传 exploreDirs（本轮各场景探索方向）+ selectedDishes（用户最终选中的菜名数组）。
      // ⚠️ 2026-08-14.fix-explore-accept-get：原实现把 accept 回写写成「游离的 fire-and-forget Promise 链」
      // 且函数开头设了 callbackWaitsForEmptyEventLoop=false，导致 commit 后函数立即 return、SCF 杀容器，
      // 未 await 的 .get().then(update) 链被丢弃 → EXPLORE::<dir> 文档 accept 永远不 +1（实测 cnt=1/accept=0）。
      // 修复：抽出 async 函数 acceptExploreDirs，在本块内 await 串行执行，确保回写完成再返回。
      await acceptExploreDirs(event, _);
      return {
        code: 200,
        data: {
          historyId: histAdd._id,
          remainingFreeCount: available - DEDUCT
        }
      };
    } catch (err) {
      await t.rollback().catch(() => {});
      throw err;
    }
  } catch (err) {
    console.error('[commitRecommendation] error:', err);
    await logErr('commitRecommendation', err);
    return { code: 500, msg: (err && err.message) || '服务异常，请稍后重试' };
  }
};
