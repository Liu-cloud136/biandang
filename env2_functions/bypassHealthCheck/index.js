// ============================================================================
// bypassHealthCheck · env2 旁路健康巡检（§10 增强方向）
// BUILD_TAG: 2026-08-21.bypass-healthcheck-v1
//
// 职责：
//   - 定时走全链路探针：invoke 9 个 bypass 函数 health + 检查关键集合可读 + 统计 fail
//   - 通道失效（函数 health 失败 / 集合不可读 / 1h fail > 10）→ 记 bypass_log status='warn'
//   - 不 await 主流程，失败仅告警，不触发 env1 主链路
// ============================================================================
const BUILD_TAG = '2026-08-21.bypass-healthcheck-v1';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const CHECK_FNS = [
  'bypassAiEnrich', 'bypassGenImage', 'bypassNutritionEst',
  'bypassText', 'bypassLexiconFix', 'bypassCandidate',
  'bypassScheduler', 'bypassRetry', 'env2Console',
  'bypassGenDish',
];
const CHECK_COLS = ['dish_mirror', 'prefs_mirror', 'bypass_log'];

exports.main = async (event) => {
  console.log('[build] bypassHealthCheck BUILD_TAG=' + BUILD_TAG);

  if (event.task === 'health') {
    return { ok: true, build: BUILD_TAG, checkFns: CHECK_FNS.length, checkCols: CHECK_COLS.length };
  }

  // 1) 函数健康巡检（并行 invoke health）
  const fnResults = await Promise.allSettled(
    CHECK_FNS.map(fn => cloud.callFunction({ name: fn, data: { task: 'health' } }))
  );
  const fnHealth = CHECK_FNS.map((fn, i) => {
    const r = fnResults[i];
    if (r.status === 'fulfilled' && r.value && r.value.result && r.value.result.ok) {
      return { fn, ok: true, build: r.value.result.build };
    }
    return { fn, ok: false, err: r.status === 'rejected' ? String(r.reason || '').slice(0, 100) : 'no_ok' };
  });

  // 2) 集合可读性
  const colResults = await Promise.allSettled(
    CHECK_COLS.map(col => db.collection(col).count())
  );
  const colHealth = CHECK_COLS.map((col, i) => {
    const r = colResults[i];
    if (r.status === 'fulfilled' && r.value) {
      return { col, ok: true, count: r.value.total };
    }
    return { col, ok: false };
  });

  // 3) 最近 1 小时 fail 数
  let failCount = 0;
  try {
    const since = Date.now() - 3600000;
    const fc = await db.collection('bypass_log').where({ status: 'fail', computedAt: _.gt(since) }).count();
    failCount = (fc && fc.total) || 0;
  } catch (e) { /* */ }

  // 4) 告警判定
  const failedFns = fnHealth.filter(f => !f.ok);
  const failedCols = colHealth.filter(c => !c.ok);
  const hasAlert = failedFns.length > 0 || failedCols.length > 0 || failCount > 10;

  if (hasAlert) {
    const msg = 'fns:[' + failedFns.map(f => f.fn).join(',') + '] cols:[' + failedCols.map(c => c.col).join(',') + '] fail1h=' + failCount;
    console.warn('[bypassHealthCheck] 告警：' + msg);
    await logTask('bypassHealthCheck', null, 'warn', msg);
  } else {
    await logTask('bypassHealthCheck', null, 'ok', 'all_healthy');
  }

  return { ok: true, build: BUILD_TAG, fnHealth, colHealth, failCount1h: failCount, hasAlert };
};

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* */ }
}