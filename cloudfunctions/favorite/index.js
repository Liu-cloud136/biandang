const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 写入免费次数流水（非关键，失败不影响主流程）
async function logFree(OPENID, type, source, amount, desc) {
  try {
    await db.collection('free_log').add({
      data: { _openid: OPENID, type, source, amount, desc: desc || '', ts: db.serverDate() }
    });
  } catch (e) { console.error('logFree failed:', e); }
}

// 全局收藏计数缓存（集合 fav_count，doc._id=dish）：按用户贡献原子增减。
// ⚠️ 关键修复：CloudBase NoSQL 的 where().update() 在文档**不存在时为 no-op（不 upsert）**。
// 「彻底零增长」后本地收藏不再写 favorites 集合，若此处不创建文档，则：
//   ① 首次 +1 直接丢失；② count 兜底聚合只扫 favorites（无本地记录）→ 恒返 0 → 本地收藏永远显示「已有0人收藏」。
// 故改为 upsert：update 未命中（updated=0）且为增量时，add 创建文档（并发重复键则再 update 兜底）；
// 负 delta 且文档不存在则跳过（不会造出负数文档）。
async function bumpCount(dish, delta) {
  if (!delta) return;
  try {
    const r = await db.collection('fav_count').where({ _id: dish }).update({ data: { count: _.inc(delta) } });
    if (r.stats && r.stats.updated > 0) return;
    if (delta > 0) {
      try {
        await db.collection('fav_count').add({ data: { _id: dish, count: delta } });
      } catch (e) {
        // 并发重复键（他人已创建）：再 update 一次兜底应用增量
        await db.collection('fav_count').where({ _id: dish }).update({ data: { count: _.inc(delta) } });
      }
    }
    // delta < 0 且文档不存在：无需操作（计数不为负）
  } catch (e) { console.error('bumpCount failed:', e); }
}

// 每用户贡献标记（集合 fav_contrib，doc._id = OPENID + '::' + dish）：
// 用于「完全不写 favorites 本地 doc、仅 bumpCount 计数」时，防止同一用户重复 +1。
async function getMarker(OPENID, dish) {
  const r = await db.collection('fav_contrib').where({ _id: OPENID + '::' + dish }).limit(1).get();
  return r.data[0] || null;
}
async function setMarker(OPENID, dish) {
  try {
    await db.collection('fav_contrib').add({ data: { _id: OPENID + '::' + dish, dish, createdAt: db.serverDate() } });
    return true; // 新创建成功
  } catch (e) {
    // 已存在（重复键）是预期幂等场景，静默；其他错误须留痕，避免贡献标记静默丢失
    const msg = (e && (e.message || e.errMsg)) || '';
    if (!/exist|duplicate|已存在/i.test(msg)) console.error('[favorite] setMarker failed:', msg);
    return false; // 已存在或失败，均视为“非新建”
  }
}
async function delMarker(OPENID, dish) {
  try { await db.collection('fav_contrib').where({ _id: OPENID + '::' + dish }).remove(); }
  catch (e) { console.error('[favorite] delMarker failed:', e && e.message); }
}
// 是否已存在完整云端收藏（不含 legacy 本地 doc）
async function hasCloud(OPENID, dish) {
  const r = await db.collection('favorites').where({ _openid: OPENID, dish, source: _.neq('local') }).limit(1).get();
  return r.data.length > 0;
}
// 老数据迁移：把 legacy 的 source:'local' 文档转为标记（保留既有 +1 贡献，不重复 +1），再删本地 doc
async function migrateLocal(OPENID, dish) {
  try {
    const r = await db.collection('favorites').where({ _openid: OPENID, dish, source: 'local' }).limit(1).get();
    if (!r.data.length) return;
    await setMarker(OPENID, dish);
    await db.collection('favorites').where({ _openid: OPENID, dish, source: 'local' }).remove();
  } catch (e) { console.error('migrateLocal failed:', e); }
}

// 每个用户只保留一份计数（永久计数池，跨天保留），无则创建
async function getPrefs(OPENID) {
  const r = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
  return r.data[0] || null;
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] favorite BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] favorite BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const action = (event && event.action) || 'list';
  const item = (event && event.item) || {};
  const dish = (item.dish || '').trim();

  try {
    // 列表：返回当前用户云端收藏（分页拉全，避免 limit(100) 截断）
    if (action === 'list') {
      const BATCH = 100;
      const all = [];
      let skip = 0;
      while (true) {
        const res = await db.collection('favorites')
          .where({ _openid: OPENID, source: _.neq('local') })
          .orderBy('ts', 'desc')
          .skip(skip)
          .limit(BATCH)
          .get();
        all.push(...res.data);
        if (res.data.length < BATCH) break;
        if (skip >= 900) break; // 安全上限：skip+limit ≤ 1000
        skip += BATCH;
      }
      return {
        code: 200,
        data: {
          list: all.map(d => ({
            dish: d.dish,
            scene: d.scene || '',
            kind: d.kind || '',
            imageUrl: d.imageUrl || '',
            guide: d.guide || null,
            ts: d.ts || null
          }))
        }
      };
    }

    // 收藏到云端（与本地收藏相互独立）：已存在则视为取消，不扣次；否则校验并扣 1 次免费次数
    if (action === 'add') {
      if (!dish) return { code: 400, msg: '缺少菜品名称' };
      await migrateLocal(OPENID, dish); // 老数据迁移，保证计数不丢失/不重复
      const cloudExist = await db.collection('favorites').where({ _openid: OPENID, dish, source: _.neq('local') }).limit(1).get();
      const marker = await getMarker(OPENID, dish);
      if (cloudExist.data.length) {
        // 完整云端记录：再次点击视为取消（移除本人该菜唯一云端贡献；本地标记仍在则仍计数，不计减）
        // 用确定性 _id 定向删除并校验 removed 计数，避免并发双取消重复 -1
        const rm = await db.collection('favorites').doc(cloudExist.data[0]._id).remove();
        if (rm.stats && rm.stats.removed > 0 && !marker) await bumpCount(dish, -1);
        return { code: 200, data: { removed: true, remaining: null } };
      }
      const prefs = await getPrefs(OPENID);
      let baseFree = prefs && typeof prefs.baseFree === 'number' ? prefs.baseFree : 0;
      let bonusFree = prefs && typeof prefs.bonusFree === 'number' ? prefs.bonusFree : 0;
      const avail = baseFree + bonusFree;
      if (!prefs || avail < 1) return { code: 403, msg: '免费次数不足，无法收藏到云端' };
      const fromBase = Math.min(1, baseFree);
      const fromBonus = 1 - fromBase;
      // 并发防护：用确定性 _id（OPENID::dish）写入云端收藏，重复点击会命中重复键 → 幂等返回，避免重复扣次/重复收藏。
      // 先写收藏成功（唯一胜出请求）再扣次，确保绝不会“扣了次却没收藏”或“扣两次”。
      const favId = OPENID + '::' + dish;
      try {
        await db.collection('favorites').add({
          data: {
            _id: favId,
            _openid: OPENID,
            dish,
            scene: item.scene || '',
            kind: item.kind || '',
            imageUrl: item.imageUrl || '',
            guide: item.guide || null,
            ts: db.serverDate()
          }
        });
      } catch (e) {
        const msg = (e && (e.message || e.errMsg)) || '';
        if (/exist|duplicate|已存在/i.test(msg)) {
          // 并发重复收藏：已有记录，幂等返回（不重复扣次）；remaining 按本次应扣后返回
          return { code: 200, data: { added: true, duplicate: true, remaining: avail - 1, _id: favId } };
        }
        throw e;
      }
      if (prefs._id) {
        if (fromBase > 0) await db.collection('user_preferences').doc(prefs._id).update({ data: { baseFree: _.inc(-fromBase) } });
        if (fromBonus > 0) await db.collection('user_preferences').doc(prefs._id).update({ data: { bonusFree: _.inc(-fromBonus) } });
      }
      await logFree(OPENID, 'deduct', 'favorite', 1, '收藏到云端 -1');
      if (marker) {
        // 由本地标记升级为云端收藏：计数已含，删标记不再 +1（贡献转为云端 doc 承载）
        await delMarker(OPENID, dish);
      } else {
        await bumpCount(dish, 1);
      }
      return { code: 200, data: { added: true, remaining: avail - 1, _id: favId } };
    }

    // 取消云端收藏（免费）
    if (action === 'remove') {
      if (!dish) return { code: 400, msg: '缺少菜品名称' };
      await migrateLocal(OPENID, dish); // 老数据迁移
      const marker = await getMarker(OPENID, dish);
      // 定向移除并校验 removed 计数：并发双取消只有首个真正删掉文档的请求才 -1，避免重复 -1
      const rm = await db.collection('favorites').where({ _openid: OPENID, dish }).remove();
      const removed = (rm.stats && rm.stats.removed) || 0;
      // 本地标记仍在则贡献未消失（前端会另走 sync 移除），本步不计减；否则本人末次取消，-1（仅当确有文档被删）
      if (!marker && removed > 0) await bumpCount(dish, -1);
      await delMarker(OPENID, dish); // 清残留标记（幂等）
      return { code: 200, data: { removed: true } };
    }

    // 本地收藏同步到云端计数（不写 favorites 本地 doc，仅维护每用户贡献标记 + fav_count）
    if (action === 'sync') {
      if (!dish) return { code: 400, msg: '缺少菜品名称' };
      await migrateLocal(OPENID, dish); // 老数据迁移：legacy 本地 doc → 标记
      const cloud = await hasCloud(OPENID, dish);
      const marker = await getMarker(OPENID, dish);
      // 移除本地收藏
      if (item && item.remove) {
        if (marker) {
          await delMarker(OPENID, dish);
          if (!cloud) await bumpCount(dish, -1); // 仍有云端收藏则贡献不变
        }
        // 无标记则幂等无操作
        return { code: 200, data: { synced: false } };
      }
      // 新增本地收藏：已有云端或已有标记则不再 +1（避免重复计数）
      if (cloud || marker) {
        if (cloud && marker) await delMarker(OPENID, dish); // 云端已承载贡献，标记冗余清除
        return { code: 200, data: { synced: true } };
      }
      // 用 setMarker 的重复键原子性做并发防护：仅“新创建标记”的请求才 +1，避免并发双点重复计数
      const created = await setMarker(OPENID, dish);
      if (created) await bumpCount(dish, 1);
      return { code: 200, data: { synced: true } };
    }

    // 某道菜的收藏人数：优先读全局计数缓存（O(1)），缺失则聚合回填
    if (action === 'count') {
      if (!dish) return { code: 400, msg: '缺少菜品名称' };
      try {
        const cr = await db.collection('fav_count').where({ _id: dish }).limit(1).get();
        if (cr.data && cr.data[0]) return { code: 200, data: { count: cr.data[0].count || 0 } };
      } catch (e) { console.warn('[favorite] fav_count 读取失败，降级为聚合统计（不影响结果，仅性能）:', e && e.message); }
      const res = await db.collection('favorites').aggregate()
        .match({ dish })
        .group({ _id: '$_openid' })
        .count('total')
        .end();
      const total = (res.list && res.list[0] && res.list[0].total) || 0;
      // 回填计数缓存（失败忽略，下次再补），避免后续每次都聚合
      db.collection('fav_count').add({ data: { _id: dish, count: total } }).catch((e) => {
        // 重复键（他人已回填）属预期，静默；其他失败留痕，下次请求会再聚合补
        const msg = (e && (e.message || e.errMsg)) || '';
        if (!/exist|duplicate|已存在/i.test(msg)) console.warn('[favorite] fav_count 回填失败（下次聚合再补）:', msg);
      });
      return { code: 200, data: { count: total } };
    }

    return { code: 400, msg: '未知操作' };
  } catch (e) {
    console.error('favorite error:', e);
    return { code: 500, msg: (e && e.message) || '服务异常' };
  }
};
