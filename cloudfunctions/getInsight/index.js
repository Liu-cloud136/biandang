const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 周期性洞察（2026-08-05）：基于用户 recommend_history 中 selected 的菜名做轻量统计，
// 产出「你近期常吃 X / 建议试试 Y / 本周决策次数」等结构化洞察，作为回访动机（不依赖库查询，纯菜名关键词+频率）。
// 零扣次、纯读，供「我的口味周报」卡片调用。
// 复用 getRecommendation 的肉类映射思路（DRIFT_MEAT），此处内联一份避免跨函数依赖。
const DRIFT_MEAT = [
  { kw: ['猪', '排骨', '五花', '肘', '猪蹄'], label: '猪肉' },
  { kw: ['牛', '牛腩', '牛柳', '肥牛'], label: '牛肉' },
  { kw: ['羊', '羊肉', '羊排'], label: '羊肉' },
  { kw: ['鸡', '鸡腿', '鸡翅', '鸡胸'], label: '鸡肉' },
  { kw: ['鸭', '烤鸭', '鸭腿'], label: '鸭肉' },
  { kw: ['鱼', '鲈', '鲫', '带鱼', '鳕', '鲑', '虾', '蟹', '海鲜', '鱿', '贝'], label: '鱼虾海鲜' },
  { kw: ['蛋'], label: '蛋类' },
  { kw: ['豆腐', '豆干', '素', '蔬', '青菜', '白菜', '茄', '土豆', '番茄'], label: '素菜/豆制品' }
];

// 近 N 天窗口（按中国时区近似：用 UTC 偏移 8h 计算）
function sinceDate(days) {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600 * 1000);
  utc8.setDate(utc8.getDate() - days);
  return new Date(utc8.getTime() - 8 * 3600 * 1000);
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] getInsight BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] getInsight BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未登录' };

  const windowDays = Math.min(30, Math.max(7, parseInt(event && event.days, 10) || 14));
  const since = sinceDate(windowDays);

  // 取该用户近 windowDays 天的推荐历史（含 selected）
  let records = [];
  try {
    const res = await db.collection('recommend_history')
      .where({ _openid: OPENID, timestamp: _.gte(since) })
      .limit(1000)
      .get();
    records = res.data || [];
  } catch (e) {
    return { code: 200, data: { empty: true, reason: 'load_fail' } };
  }

  // 收集所有 selected 菜名
  const names = [];
  let decidedCount = 0;
  records.forEach(r => {
    const sel = r.selected;
    if (Array.isArray(sel) && sel.length) {
      decidedCount++;
      sel.forEach(it => { if (it && it.name) names.push(String(it.name)); });
    }
  });

  if (!names.length) {
    return { code: 200, data: { empty: true, days: windowDays, decidedCount: 0 } };
  }

  // 肉类分布
  const meatCnt = {};
  names.forEach(n => {
    DRIFT_MEAT.forEach(m => { if (m.kw.some(k => n.indexOf(k) >= 0)) meatCnt[m.label] = (meatCnt[m.label] || 0) + 1; });
  });
  const meatTop = Object.keys(meatCnt).sort((a, b) => meatCnt[b] - meatCnt[a]).slice(0, 3)
    .map(k => ({ label: k, count: meatCnt[k] }));

  // 高频菜（重复点过的，提示可换换）
  const freq = {};
  names.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
  const repeated = Object.keys(freq).filter(k => freq[k] >= 2).sort((a, b) => freq[b] - freq[a]).slice(0, 3);

  // 建议方向：肉类 Top 之外、且当前窗口未高频的一个方向（轻量建议，不查询库）
  const ALL_LABELS = DRIFT_MEAT.map(m => m.label);
  const suggested = ALL_LABELS.filter(l => !meatCnt[l]).slice(0, 2);

  return {
    code: 200,
    data: {
      empty: false,
      days: windowDays,
      decidedCount,           // 近窗口内「就它了」次数
      dishCount: names.length, // 近窗口内选定菜品总数
      meatTop,                // 常吃肉类 [{label,count}]
      repeated,               // 重复点过的菜名
      suggested,              // 建议尝试方向（肉类标签）
      meatRate: meatCnt,      // 完整肉类计数（前端可自选展示）
      generatedAt: Date.now()
    }
  };
};
