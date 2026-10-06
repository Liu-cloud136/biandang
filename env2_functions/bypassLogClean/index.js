// ============================================================================
// bypassLogClean · env2 bypass_log 保留期清理（保留 3 天）
// BUILD_TAG: 2026-09-09.bypass-log-clean-v1
// 职责：删除 bypass_log 中 computedAt < now-RETENTION_DAYS 的旧日志
// 触发器：sched-log-clean 每日 04:30（直接绑本函数，独立于 bypassScheduler）
// 说明：logTask 统一有 computedAt；无 computedAt 的早期脏数据保留不动（量极小）
// ============================================================================
const BUILD_TAG = '2026-09-09.bypass-log-clean-v1';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RETENTION_DAYS = 3;                 // 保留窗口（天）
const PAGE = 1000;                        // 拉取页大小
const CHUNK = 200;                        // 删除分块
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

exports.main = async (event) => {
  console.log('[build] bypassLogClean BUILD_TAG=' + BUILD_TAG);
  if (event && event.task === 'health') {
    return { ok: true, build: BUILD_TAG, retentionDays: RETENTION_DAYS };
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const startedAt = Date.now();
  const MAX_MS = 100 * 1000; // 单次运行上限（timeout 120s 内留余量）
  let deleted = 0, pages = 0;

  // 分页收集过期 _id
  const ids = [];
  for (let off = 0; ; off += PAGE) {
    if (Date.now() - startedAt > MAX_MS) break;
    let q = db.collection('bypass_log').field({ _id: true }).where({ computedAt: _.lt(cutoff) });
    const r = await q.skip(off).limit(PAGE).get().catch(() => null);
    const batch = (r && r.data) || [];
    ids.push(...batch.map(d => d._id));
    pages++;
    if (!batch || batch.length < PAGE) break;
    if (ids.length >= 50000) break; // 单次安全上限，下轮再清
    await sleep(40);
  }

  // 分块删除
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (Date.now() - startedAt > MAX_MS) break;
    const part = ids.slice(i, i + CHUNK);
    try {
      await db.collection('bypass_log').where({ _id: _.in(part) }).remove();
      deleted += part.length;
    } catch (e) {
      console.warn('[bypassLogClean] 删除块失败 offset=' + i + '：' + (e && e.message));
    }
    await sleep(30);
  }

  const remain = await db.collection('bypass_log').count().then(r => r.total).catch(() => -1);
  console.log('[bypassLogClean] cutoff=' + new Date(cutoff).toISOString() + ' 待删ids=' + ids.length + ' 已删=' + deleted + ' 剩余=' + remain + ' 耗时ms=' + (Date.now() - startedAt));
  return { ok: true, build: BUILD_TAG, retentionDays: RETENTION_DAYS, collected: ids.length, deleted, remain };
};
