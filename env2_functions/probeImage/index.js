// ============================================================================
// probeImage · env2 混元生图并发上限探针
// BUILD_TAG: 2026-08-23.probe-image-concurrency
//
// 用法：invokeFunction probeImage { n: 8 }
//   - 同时发起 n 个 hunyuan-image generateImage 请求
//   - 不上传 COS，只测 generateImage 的并发能力
//   - 返回汇总：{ n, ok, fail, avgMs, maxMs, minMs, p95Ms, errors[] }
// ============================================================================

const BUILD_TAG = '2026-08-23.probe-image-concurrency';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const tcb = require('@cloudbase/node-sdk');

const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 120000 });
const ai = app.ai();
const imageModelObj = ai.createImageModel('hunyuan-image');
const IMAGE_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0';

exports.main = async (event) => {
  console.log('[build] probeImage BUILD_TAG=' + BUILD_TAG);
  const n = Math.min(Math.max(Number(event && event.n) || 5, 1), 30);

  const prompts = [
    '一盘清炒时蔬，写实摄影，浅色陶瓷盘，桌面干净',
    '一碗番茄鸡蛋面，写实摄影，浅色陶瓷碗，桌面干净',
    '一盘红烧肉，写实摄影，浅色陶瓷盘，桌面干净',
    '一碗清蒸鱼，写实摄影，浅色陶瓷盘，桌面干净',
    '一盘麻婆豆腐，写实摄影，浅色陶瓷盘，桌面干净',
    '一碗蛋炒饭，写实摄影，浅色陶瓷碗，桌面干净',
    '一盘糖醋排骨，写实摄影，浅色陶瓷盘，桌面干净',
    '一碗酸辣汤，写实摄影，浅色陶瓷碗，桌面干净',
    '一盘鱼香肉丝，写实摄影，浅色陶瓷盘，桌面干净',
    '一碗排骨汤，写实摄影，浅色陶瓷碗，桌面干净',
  ];

  console.log('[probeImage] 开始并发压测 n=' + n);
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

  console.log('[probeImage] 压测完成：' + JSON.stringify(summary));
  return summary;
};

async function runOne(idx, prompt) {
  const t0 = Date.now();
  try {
    const resp = await imageModelObj.generateImage({
      model: IMAGE_MODEL,
      prompt,
      size: '768x768',
      revise: { value: false },
    });
    const url = (resp && resp.data && resp.data[0] && resp.data[0].url) || '';
    const ms = Date.now() - t0;
    if (!url) return { idx, ok: false, ms, err: 'empty_url' };
    return { idx, ok: true, ms, urlLen: url.length };
  } catch (e) {
    return { idx, ok: false, ms: Date.now() - t0, err: (e && e.message) || String(e) };
  }
}