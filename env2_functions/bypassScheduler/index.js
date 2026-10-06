// ============================================================================
// bypassScheduler · env2 旁路任务统一调度入口（§10 任务错峰 + 额度熔断）
// BUILD_TAG: 2026-09-10.bypass-scheduler-dispatch-timeout
//
// 职责：
//   1. 额度熔断：查 sys_config.degradeLevel，按档位阶梯降级（先停生图→再停文本→保留候菜）
//   2. 统一调度：5 个 timer 触发器指向本函数，按 TriggerName 映射到目标 bypass 函数
//   注：饭点硬跳/软跳规则已去除（2026-08-25），10 分钟定时器全天候运行，生成避让完全交给下游 rateLimiter 自适应限流
//
// 降级档位（sys_config.degradeLevel）：
//   0=正常 | 1=停生图 | 2=停非实时文本+补估 | 3=只保留候菜+画像
//   设置方式：db.collection('sys_config').add({data:{key:'degradeLevel',value:2}})
// ============================================================================
const BUILD_TAG = '2026-09-10.bypass-scheduler-dispatch-timeout';
const cloud = require('wx-server-sdk');

// 2026-09-10 修复「调度假失败」：调度器 await cloud.callFunction 的 socket 超时，
// 底层取自 tcb-admin-node httpRequest: `args.timeout || config.timeout || 15000`（默认 15s），
// 而下游 bypassAutoAdd 单次实跑 21~30s → 每个 tick 都误记 `调度 X 失败: ESOCKETTIMEDOUT`
// （目标函数其实正常跑完并写库，属假失败，却污染 bypass_log 审计）。
// 故在 init 时把实例级 timeout 抬到 60s，与各下游函数 300s 上限匹配。
const DISPATCH_TIMEOUT_MS = 60 * 1000;
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: DISPATCH_TIMEOUT_MS });
const db = cloud.database();

// TriggerName → 目标函数名映射
const TRIGGER_MAP = {
  'sched-ai-enrich': 'bypassAiEnrich',
  'sched-gen-image': 'bypassGenImage',
  'sched-nutrition': 'bypassNutritionEst',
  'sched-text': 'bypassText',
  'sched-auto-add': 'bypassAutoAdd',  // 补菜链自动化消费端（候选池→mirror→ready）；bypassGenDish 发明模式已于 2026-09-09 删除
};

// 降级阶梯：各函数在哪个 degradeLevel 停止（0=永不停）
const DEGRADE_STOPS = {
  bypassGenImage: 1,
  bypassText: 2,
  bypassNutritionEst: 2,
  bypassAiEnrich: 3,
  bypassAutoAdd: 2,   // 停文本档即停新菜生成（生成依赖文本 AI）
};

exports.main = async (event) => {
  console.log('[build] bypassScheduler BUILD_TAG=' + BUILD_TAG);

  // 确保 scheduler_control 集合存在（软停止开关）
  try { await db.createCollection('scheduler_control'); } catch (e) { /* 已存在 */ }

  if (event.task === 'health') {
    return { ok: true, build: BUILD_TAG, triggers: Object.keys(TRIGGER_MAP) };
  }

  // 仅接受 Timer 触发（移除主链路外的手动 target 入口，防止绕过主链路触发生成）
  let targetFn = null;
  if (event.Type === 'Timer') {
    targetFn = TRIGGER_MAP[event.TriggerName];
    if (!targetFn) {
      console.warn('[scheduler] 未知 TriggerName: ' + event.TriggerName);
      return { ok: false, err: 'unknown_trigger:' + event.TriggerName };
    }
  }

  if (!targetFn) {
    return { ok: true, build: BUILD_TAG, triggers: Object.keys(TRIGGER_MAP), msg: 'only Timer triggers allowed; manual target disabled' };
  }

  return await dispatch(targetFn);
};

async function dispatch(targetFn) {
  // 饭点规则已去除：不再做高峰硬跳/软跳，10 分钟定时器全天候运行，均走各下游函数自适应限流（rateLimiter 按 429 实时退避）。
  // 保留自适应机制：降级档位（degradeLevel）熔断不变。

  // 1) 熔断：查降级档位
  const level = await getDegradeLevel();
  const stopAt = DEGRADE_STOPS[targetFn] || 0;
  if (stopAt > 0 && level >= stopAt) {
    console.log('[scheduler] 降级跳过 ' + targetFn + ' level=' + level + ' stopAt=' + stopAt);
    await logTask('bypassScheduler', null, 'skip', 'degrade:' + targetFn + '_level=' + level);
    return { ok: true, skipped: true, target: targetFn, reason: 'degrade', level };
  }

  // 3) 调度目标函数
  try {
    const res = await cloud.callFunction({ name: targetFn, data: { task: 'incremental' }, timeout: DISPATCH_TIMEOUT_MS });
    console.log('[scheduler] 调度 ' + targetFn + ' 完成');
    await logTask('bypassScheduler', null, 'ok', 'dispatched:' + targetFn);
    return { ok: true, target: targetFn, result: res.result };
  } catch (e) {
    console.error('[scheduler] 调度 ' + targetFn + ' 失败: ' + (e && e.message));
    await logTask('bypassScheduler', null, 'fail', 'dispatch:' + targetFn + ' ' + (e && e.message));
    return { ok: false, target: targetFn, err: (e && e.message) || 'dispatch_failed' };
  }
}

async function getDegradeLevel() {
  try {
    const res = await db.collection('sys_config').where({ key: 'degradeLevel' }).limit(1).get();
    if (res.data && res.data.length) return Number(res.data[0].value) || 0;
  } catch (e) { /* sys_config 不存在 → 正常模式 */ }
  return 0;
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* 日志失败不影响调度 */ }
}