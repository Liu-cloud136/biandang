// getAdminStats —— 管理后台数据看板（A4，2026-08-04）
// 只读统计，不写任何集合。仅管理员可调用。
// 设计约束：
//  1) NoSQL 单次 get 上限 1000 条 → 需要遍历的集合一律分页，并设总扫描上限防超时。
//  2) 云函数默认超时有限 → 所有 count() 并行发起；重扫描只对 recommend_history 做，且限定近 N 天。
//  3) 任一子统计失败都不能拖垮整体 → 每项独立 catch，失败返回 null，前端显示「—」。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 管理员白名单（与 manageUser 保持一致：环境变量优先，REAL_ADMIN 兜底）
const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));

const DAY = 24 * 3600 * 1000;
// 东八区当天 00:00 的时间戳（云函数跑在 UTC，必须换算，否则「今日」会错 8 小时）
function cnDayStart(offsetDay = 0) {
  const cnNow = new Date(Date.now() + 8 * 3600 * 1000);
  const y = cnNow.getUTCFullYear(), m = cnNow.getUTCMonth(), d = cnNow.getUTCDate();
  return Date.UTC(y, m, d) - 8 * 3600 * 1000 - offsetDay * DAY;
}
// ⚠️ recommend_history.timestamp 实际存的是 Date 类型（导出为 {$date:...}）。
// NoSQL 中 Date 字段必须与 Date 对象比较，传数字时间戳会匹配不到任何记录（静默返回 0）。
const D = (ts) => new Date(ts);

const safeCount = (col, where) => {
  const q = where ? db.collection(col).where(where) : db.collection(col);
  return q.count().then(r => (r && r.total) || 0).catch(() => null);
};

// 分页扫描 recommend_history，返回统计结果。
// 硬上限 MAX_SCAN 条，超出即停并置 truncated=true（宁可数据不全，也不能让函数超时）。
async function scanHistory(sinceTs, MAX_SCAN = 3000) {
  const PAGE = 500;
  let off = 0, scanned = 0, truncated = false;
  const dishCnt = new Map();     // 菜名 → 被 selected 次数
  const userSet = new Set();     // 去重用户
  const dayUser = new Map();     // 'YYYY-MM-DD'(东八区) → Set(openid)，算 DAU 趋势
  let commitCnt = 0;             // 有 selected 的记录数（真实采纳）

  while (scanned < MAX_SCAN) {
    let res;
    try {
      res = await db.collection('recommend_history')
        .where({ timestamp: _.gte(D(sinceTs)) })
        .orderBy('timestamp', 'desc')
        .field({ timestamp: true, selected: true, _openid: true })
        .skip(off).limit(PAGE)
        .get();
    } catch (e) {
      truncated = true;
      break;
    }
    const rows = (res && res.data) || [];
    if (!rows.length) break;

    rows.forEach(h => {
      if (h._openid) userSet.add(h._openid);
      let tms = 0;
      const t = h.timestamp;
      if (t instanceof Date) tms = t.getTime();
      else if (typeof t === 'number') tms = t;
      else if (t && typeof t.$date === 'number') tms = t.$date;
      if (tms && h._openid) {
        const cn = new Date(tms + 8 * 3600 * 1000);
        const key = cn.getUTCFullYear() + '-' +
          String(cn.getUTCMonth() + 1).padStart(2, '0') + '-' +
          String(cn.getUTCDate()).padStart(2, '0');
        if (!dayUser.has(key)) dayUser.set(key, new Set());
        dayUser.get(key).add(h._openid);
      }
      if (Array.isArray(h.selected) && h.selected.length) {
        commitCnt++;
        h.selected.forEach(s => {
          if (!s) return;
          // selected 项结构：{ name, staple, drink, scene }
          [s.name, s.staple, s.drink].forEach(n => {
            if (!n || typeof n !== 'string') return;
            const k = n.trim();
            if (!k) return;
            dishCnt.set(k, (dishCnt.get(k) || 0) + 1);
          });
        });
      }
    });

    scanned += rows.length;
    off += PAGE;
    if (rows.length < PAGE) break;
  }
  if (scanned >= MAX_SCAN) truncated = true;

  const topDishes = Array.from(dishCnt.entries())
    .map(([name, cnt]) => ({ name, cnt }))
    .sort((a, b) => b.cnt - a.cnt)
    .slice(0, 20);

  const trend = Array.from(dayUser.entries())
    .map(([date, set]) => ({ date, uv: set.size }))
    .sort((a, b) => a.date < b.date ? -1 : 1)
    .slice(-14);

  return { scanned, truncated, topDishes, trend, activeUsers: userSet.size, commitCnt };
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-15.ing-preset-stats';
console.log('[build] getAdminStats BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] getAdminStats BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const days = Math.min(Math.max(Number((event && event.days) || 30), 1), 90);
  const sinceTs = cnDayStart(days - 1);
  const todayTs = cnDayStart(0);
  const yestTs = cnDayStart(1);

  try {
    // 全部 count 并行，单次往返即可拿齐总量类指标
    let [
      totalUsers, totalHistory, totalFav, totalContribPending,
      totalDishLib, totalIngLib, totalIngPreset, totalFeedback, totalGuides,
      todayHistory, yestHistory, bannedUsers, blocklistCnt
    ] = await Promise.all([
      safeCount('user_preferences'),
      safeCount('recommend_history'),
      safeCount('favorites'),
      safeCount('dish_contrib', { status: 'pending' }),
      safeCount('dish_library'),
      safeCount('ingredient_library'),
      safeCount('ingredient_preset'),
      safeCount('feedback'),
      safeCount('cook_guides'),
      safeCount('recommend_history', { timestamp: _.gte(D(todayTs)) }),
      safeCount('recommend_history', { timestamp: _.gte(D(yestTs)).and(_.lt(D(todayTs))) }),
      safeCount('user_preferences', { banned: true }),
      safeCount('name_blocklist')
    ]);

    // 食材库 = 预置主库(ingredient_preset) + 社区贡献(ingredient_library)
    totalIngLib = (totalIngLib || 0) + (totalIngPreset || 0);

    // 重扫描单独做（受 MAX_SCAN 保护）
    let scan = null;
    try {
      scan = await scanHistory(sinceTs);
    } catch (e) {
      console.warn('[getAdminStats] 历史扫描失败：', e && e.message);
    }

    return {
      code: 200,
      data: {
        rangeDays: days,
        generatedAt: Date.now(),
        totals: {
          users: totalUsers,
          banned: bannedUsers,
          history: totalHistory,
          favorites: totalFav,
          contribPending: totalContribPending,
          dishLibrary: totalDishLib,
          ingredientLibrary: totalIngLib,
          feedback: totalFeedback,
          cookGuides: totalGuides,
          blocklist: blocklistCnt
        },
        today: { history: todayHistory },
        yesterday: { history: yestHistory },
        range: scan ? {
          activeUsers: scan.activeUsers,
          commitCount: scan.commitCnt,
          scanned: scan.scanned,
          truncated: scan.truncated,
          topDishes: scan.topDishes,
          trend: scan.trend
        } : null
      }
    };
  } catch (e) {
    console.error('[getAdminStats] 失败：', e);
    return { code: 500, msg: '统计失败：' + ((e && e.message) || e) };
  }
};
