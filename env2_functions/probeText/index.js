// ============================================================================
// probeText · env2 hy3 文本生成并发上限探针
// BUILD_TAG: 2026-08-23.probe-text-concurrency
//
// 用法：invokeFunction probeText { n: 8 }
//   - 同时发起 n 个 hy3 generateText 请求
//   - 记录每个请求的耗时 / 成功 / 失败
//   - 返回汇总：{ n, ok, fail, avgMs, maxMs, minMs, p95Ms, errors[] }
// ============================================================================

const BUILD_TAG = '2026-08-23.probe-text-concurrency';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const tcb = require('@cloudbase/node-sdk');

const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 120000 });
const ai = app.ai();

exports.main = async (event) => {
  console.log('[build] probeText BUILD_TAG=' + BUILD_TAG);
  const n = Math.min(Math.max(Number(event && event.n) || 6, 1), 40);

  const prompts = [
    '请只回复两个字：成功',
    '请只回复两个字：正常',
    '请只回复两个字：完毕',
    '请只回复两个字：就绪',
    '请只回复两个字：通过',
    '请只回复两个字：可用',
    '请只回复两个字：在线',
    '请只回复两个字：畅通',
    '请只回复两个字：良好',
    '请只回复两个字：达标',
  ];

  console.log('[probeText] 开始并发压测 n=' + n);
  const t0 = Date.now();

  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push(runOne(i, prompts[i % prompts.length]));
  }

  const settled = await Promise.allSettled(tasks);
  const elapsed = Date.now() - t0;

  const results = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { idx: i, ok: false, ms: 0, err: (r.reason && r.reason.message) || String(r.reason) };
  });

  const okResults = results.filter(r => r.ok);
  const failResults = results.filter(r => !r.ok);
  const latencies = okResults.map(r => r.ms).sort((a, b) => a - b);

  const avgMs = latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
  const maxMs = latencies.length ? latencies[latencies.length - 1] : 0;
  const minMs = latencies.length ? latencies[0] : 0;
  const p95Idx = latencies.length ? Math.min(Math.floor(latencies.length * 0.95), latencies.length - 1) : 0;
  const p95Ms = latencies.length ? latencies[p95Idx] : 0;

  const errors = {};
  for (const r of failResults) {
    const key = (r.err || 'unknown').slice(0, 80);
    errors[key] = (errors[key] || 0) + 1;
  }

  const summary = {
    ok: true,
    build: BUILD_TAG,
    n,
    okCount: okResults.length,
    failCount: failResults.length,
    avgMs,
    maxMs,
    minMs,
    p95Ms,
    totalMs: elapsed,
    errors,
  };

  console.log('[probeText] 压测完成：' + JSON.stringify(summary));
  return summary;
};

async function runOne(idx, prompt) {
  const t0 = Date.now();
  try {
    const textModel = ai.createModel('cloudbase');
    const resp = await textModel.generateText({
      model: 'hy3',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      maxTokens: 16,
    });
    const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
    const ms = Date.now() - t0;
    if (!text) return { idx, ok: false, ms, err: 'empty_response' };
    return { idx, ok: true, ms, len: text.length };
  } catch (e) {
    return { idx, ok: false, ms: Date.now() - t0, err: (e && e.message) || String(e) };
  }
}