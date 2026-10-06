// rateDish —— B2 做过了/打分闭环（2026-08-04）
// 写 user_preferences：
//   · 好评入 dishLikes（推荐优先）
//   · 差评入 softDislike（【偶发软信号】，仅权重算法软降档，40 下限、只降不封；不永久拉黑，
//     因为用户偶尔一次差评不代表永远不吃，避免把明确偏好误伤；与「长期不吃」的硬约束 avoidDishes 分流）
// 不新建集合，复用 prefs 已有字段。
// ⚠️ 语义隔离（彻底根治第4项）：avoidDishes 仅承载「用户长期不吃」硬约束（来自 mine 页 userAvoid
//   管理 + feedback 忌口/不合口味反馈），由 getRecommendation 硬剔除；偶发差评软信号独立存 softDislike。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLL = 'user_preferences';
const RATINGS = { good: 1, normal: 0, bad: -1 };

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-11.neutral-events-ts';
console.log('[build] rateDish BUILD_TAG=' + BUILD_TAG);

exports.main = async (event, context) => {
  console.log('[build] rateDish BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { code: 401, msg: '未获取到用户身份' };
    const rating = (event && event.rating);
    const dish = (event && typeof event.dish === 'string') ? event.dish.trim().slice(0, 30) : '';
    if (!dish) return { code: 400, msg: '菜名为空' };
    if (!RATINGS.hasOwnProperty(rating)) return { code: 400, msg: '评价类型无效' };

    const r = await db.collection(COLL).where({ _openid: OPENID }).limit(1).get();
    if (!(r.data && r.data.length)) return { code: 400, msg: '请先设置偏好' };
    const uid = r.data[0]._id;
    const v = RATINGS[rating];

    const data = {};
    if (v === 1) {
      // 好评：加入优先清单（若该菜曾被差评/软信号标记，一并移出兼容字段）
      data.dishLikes = _.addToSet(dish);
      const curA = Array.isArray(r.data[0].avoidDishes) ? r.data[0].avoidDishes : [];
      if (curA.indexOf(dish) >= 0) data.avoidDishes = _.pull(dish);
      const curS = Array.isArray(r.data[0].softDislike) ? r.data[0].softDislike : [];
      if (curS.indexOf(dish) >= 0) data.softDislike = _.pull(dish);
    } else if (v === -1) {
      // 差评：写入【软信号】softDislike（同时移出优先清单）；不写 avoidDishes（避免偶发差评被永久硬拉黑）
      // 2026-08-06 优化#2：softDislike 升级为 {dish, ts} 对象，使差评可按时间衰减（避免永久霸凌权重）。
      // 读取端经 sync_weights.extractDislikeNames 兼容旧纯字符串数组，本函数只写新格式。
      // 2026-08-10 修复③：按 dish 名去重——已存在则仅更新 ts（刷新衰减起点），不再叠加多条，
      // 否则同菜每次差评都堆一条，时间衰减被多次命中过度压权。
      const curLikes = Array.isArray(r.data[0].dishLikes) ? r.data[0].dishLikes : [];
      if (curLikes.indexOf(dish) >= 0) data.dishLikes = _.pull(dish);
      const curS = Array.isArray(r.data[0].softDislike) ? r.data[0].softDislike : [];
      const ts = Date.now();
      const idx = curS.findIndex(x => (x && typeof x === 'string' ? x : x.dish) === dish);
      if (idx >= 0) {
        const next = curS.slice();
        next[idx] = { dish: dish, ts: ts };
        data.softDislike = next;
      } else {
        data.softDislike = _.addToSet({ dish: dish, ts: ts });
      }
    } else {
      // v === 0（一般/无感）：2026-08-10 修复② 中性反馈采集——不进 softDislike 降权，
      // 但累计 neutralCount，供后续算法区分「无感」与「未评」，防止偶发好评被过度放大。
      // 2026-08-11 升级：同时把每次无感事件写入 neutralEvents（仅带 ts、不带菜名，保持「全局标量」语义），
      // 供 sync_weights.extractNeutralTimed 按时间衰减加权——「三个月前频繁无感」与「上周刚频繁无感」可区分。
      // 不进 addToSet 去重（同一菜可能多次给无感，每次都是独立信号），用 push 追加；ts 为采集时间戳。
      const ts = Date.now();
      data.neutralCount = _.inc(1);
      data.neutralEvents = _.push([{ ts: ts }]);
    }
    if (Object.keys(data).length) {
      await db.collection(COLL).doc(uid).update({ data });
    }
    return { code: 200, msg: 'ok', rating: v };
  } catch (err) {
    console.error('[rateDish] error:', err);
    return { code: 500, msg: (err && err.message) || '服务异常' };
  }
};
