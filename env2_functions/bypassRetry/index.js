const cloud = require('wx-server-sdk');

// 2026-09-11 修复「重试调用假超时」：出站 socket 超时取自 tcb-admin-node httpRequest 的
// `args.timeout || config.timeout || 15000`（默认 15s），而 VALID_FNS 里目标函数实跑常 20~300s
// → callFunction 必然 ESOCKETTIMEDOUT（目标其实跑完了），重试等于白跑还记一条假错误。
// 故把实例级 timeout 抬到 60s（与本函数自身 Timeout=60s 对齐；同 bypassScheduler / bypassAutoAdd 修法）。
const RETRY_TIMEOUT_MS = 60 * 1000;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: RETRY_TIMEOUT_MS });
const db = cloud.database();
const _ = db.command;

// ============================================================================
// bypassRetry · env2 生成失败死信重试器
// BUILD_TAG: 2026-09-11.bypass-retry-v2-cleanup
//
// 职责：扫 bypass_log 中 status='fail' 的任务，对合法生成函数（VALID_FNS）
//       重新 callFunction 触发一次，作为生成链路的失败兜底重试。
// 注意：本函数独立于主链路（bypassGenDish 串行下游），属于主链路外的
//       触发生成入口，按用户 2026-08-25 决策保留为"生成失败自动兜底"。
// ============================================================================

const VALID_FNS = [
  // 2026-09-11：移除 'bypassGenDish' —— 该函数云端已不存在（发明模式删除时整函数下线），
  // 命中它的重试必然 callFunction 失败并把日志标成 retried_error，属纯噪音。
  'bypassAiEnrich',
  'bypassNutritionEst',
  'bypassGenGuide',
  'bypassGenSteps',
  'bypassGenIngredients',
  'bypassGenImage',
  'bypassText',
];

const MAX_RETRY = 2;

exports.main = async (event = {}) => {
  console.log('[build] bypassRetry BUILD_TAG=2026-09-11.bypass-retry-v2-cleanup');
  const limit = Math.min(Number(event.limit) || 20, 50);

  let res;
  try {
    res = await db.collection('bypass_log')
      .where({ status: 'fail', fn: _.in(VALID_FNS), retry: _.lt(MAX_RETRY) })
      .limit(limit)
      .get();
  } catch (e) {
    console.error('[bypassRetry] 查询 bypass_log 失败: ' + (e && e.message));
    return { ok: false, err: (e && e.message) || 'query_fail' };
  }

  const logs = (res && res.data) || [];
  const results = [];
  for (const item of logs) {
    const fn = item.fn;
    if (!VALID_FNS.includes(fn)) continue;
    try {
      const r = await cloud.callFunction({ name: fn, data: item.event || { task: 'incremental' } });
      const ok = r && r.result && r.result.ok;
      await db.collection('bypass_log').doc(item._id).update({
        data: { retry: _.inc(1), status: ok ? 'retried_ok' : 'retried_fail', lastRetryAt: Date.now() }
      });
      results.push({ fn, _id: item._id, ok: !!ok });
    } catch (e) {
      await db.collection('bypass_log').doc(item._id).update({
        data: { retry: _.inc(1), status: 'retried_error', lastErr: (e && e.message) || '', lastRetryAt: Date.now() }
      });
      results.push({ fn, _id: item._id, ok: false, err: (e && e.message) || '' });
    }
  }

  return { ok: true, scanned: logs.length, results };
};
