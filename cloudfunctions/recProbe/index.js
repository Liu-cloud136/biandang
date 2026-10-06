// 临时探针：测完整 getRecommendation(action=sceneMode) 单路真实耗时
// 复现前端 genTextForScene 真实路径（含权重/去重/画像注入），而非裸模型最小 token。
// 入参 { conc:N, runs:3 }：并发 N 路调 getRecommendation，统计每路耗时 + 430/429。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}) => {
  const conc = Math.max(1, Math.min(20, Number(event.conc) || 1));
  const runs = Math.max(1, Math.min(5, Number(event.runs) || 3));
  const out = [];
  for (let r = 0; r < runs; r++) {
    const tasks = [];
    for (let i = 0; i < conc; i++) {
      tasks.push((async () => {
        const t0 = Date.now();
        try {
          const res = await cloud.callFunction({
            name: 'getRecommendation',
            data: { action: 'sceneMode', scene: '正餐', usedStaples: [], usedDishes: [] }
          });
          const rt = res && res.result;
          const code = rt && rt.code;
          return { ok: code === 200, code, ms: Date.now() - t0, errType: (rt && rt.errType) || '' };
        } catch (e) {
          return { ok: false, code: 'NET', ms: Date.now() - t0, err: String(e && e.message || e) };
        }
      })());
    }
    const rs = await Promise.all(tasks);
    const ok = rs.filter(x => x.ok).length;
    const busy = rs.filter(x => x.code === 430).length;
    const upstream = rs.filter(x => x.code === 429).length;
    const lat = rs.map(x => x.ms).sort((a, b) => a - b);
    const avg = Math.round(lat.reduce((s, v) => s + v, 0) / lat.length);
    const p95 = lat[Math.floor(lat.length * 0.95)] || lat[lat.length - 1];
    const max = lat[lat.length - 1];
    out.push({ run: r, conc, ok, busy, upstream, avgMs: avg, p95Ms: p95, maxMs: max, perMs: rs.map(x => x.ms) });
  }
  return { conc, runs, detail: out };
};
