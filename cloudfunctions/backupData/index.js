const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 备份集合（用户数据维度，不含共享库 dish_library/ingredient_library 等）
const COLLECTIONS = [
  'user_preferences',
  'favorites',
  'recommend_history',
  'dish_feedback',
  'free_log',
  'cook_viewed',
  'dish_contrib',
  'fav_contrib',
  'user_no_map'
];

// 全局全量备份最多保留份数（超出则删除最旧的，防止手动备份无限堆积）
const RETAIN_GLOBAL = 5;

// 管理员权威识别源：OPENID 直接比对（ID 固定 'admin'，不再依赖数字 0）。
const ADMIN_OPENID = process.env.ADMIN_OPENID || '';

// 管理员判定：OPENID === 管理员 OPENID（fail-closed：空身份或非法身份一律拒绝）
async function amIAdmin(OPENID) {
  return !!(OPENID && OPENID === ADMIN_OPENID);
}

async function resolveByNo(userNo) {
  // 管理员固定标识 'admin'：直接映射到管理员 OPENID
  if (userNo === 'admin') return ADMIN_OPENID;
  try {
    const m = await db.collection('user_no_map').where({ no: Number(userNo) }).limit(1).get();
    if (m.data[0]) return m.data[0]._openid;
  } catch (e) { console.warn('[backupData] resolveByNo failed:', e && e.message); }
  return null;
}

// 分页导出某个集合（filter 为空 = 全量）
async function dumpCollection(col, filter) {
  const docs = [];
  let last = null;
  while (true) {
    let q = db.collection(col).limit(100).orderBy('_id', 'asc');
    if (filter) q = q.where(filter);
    if (last) q = q.where({ _id: _.gt(last) });
    const r = await q.get();
    if (!r.data.length) break;
    r.data.forEach(d => docs.push(d));
    last = r.data[r.data.length - 1]._id;
    if (r.data.length < 100) break;
  }
  return docs;
}

// 清空整个集合（用于全量备份恢复）
async function clearAll(col) {
  for (let i = 0; i < 200; i++) {
    const r = await db.collection(col).where({ _id: _.exists(true) }).limit(1000).remove();
    if (!r.stats || !r.stats.removed || r.stats.removed === 0) break;
  }
}

// 创建单个用户备份
async function backupUser(targetId) {
  const snapshot = {};
  for (const col of COLLECTIONS) {
    snapshot[col] = await dumpCollection(col, { _openid: targetId });
  }
  const rec = {
    scope: 'user',
    _openid: targetId,
    createdAt: new Date().toISOString(),
    desc: '用户数据备份',
    snapshot
  };
  const add = await db.collection('data_backups').add({ data: rec });
  return add._id;
}

// 删除超出 RETAIN_GLOBAL 份的全局备份（保留最近 RETAIN_GLOBAL 份，删最旧的）
async function rotateGlobalBackups() {
  const list = await db.collection('data_backups')
    .where({ scope: 'global' })
    .orderBy('createdAt', 'desc')
    .limit(1000)
    .get();
  if (list.data.length <= RETAIN_GLOBAL) return;
  const toDelete = list.data.slice(RETAIN_GLOBAL);
  for (const b of toDelete) {
    await db.collection('data_backups').doc(b._id).remove().catch(e => console.warn('[backupData] rotate remove failed:', e && e.message));
  }
}

// 创建全量（全部用户）备份
async function backupAll() {
  const snapshot = {};
  for (const col of COLLECTIONS) {
    snapshot[col] = await dumpCollection(col, null);
  }
  const rec = {
    scope: 'global',
    _openid: '__GLOBAL__',
    createdAt: new Date().toISOString(),
    desc: '全量备份（全部用户）',
    snapshot
  };
  const add = await db.collection('data_backups').add({ data: rec });
  // 轮转：仅保留最近 RETAIN_GLOBAL 份全局备份，超出删除最旧的
  await rotateGlobalBackups();
  return add._id;
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-10.userno-dedup';
console.log('[build] backupData BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] backupData BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const ctx = cloud.getWXContext ? cloud.getWXContext() : {};
  // 优先用云端上下文的真实调用者 OPENID：客户端调用时 event.OPENID 经常为空，
  // 若只用 event.OPENID 会让 id 落到空串，被 amIAdmin 误判为 admin，备份便按 _openid='' 查询导致快照全空。
  const realOPENID = (ctx && ctx.OPENID) || '';
  const { OPENID: evtOPENID, openid, action, userId, userNo, targetOpenid, backupId, mine } = event || {};
  const OPENID = realOPENID || evtOPENID || '';
  // 身份来源：云端上下文的 OPENID 优先；管理后台从页面显式传递的 openid 兜底。
  // 列表/恢复/删除/全量均为管理员操作，由 amIAdmin 校验（空身份视作控制台 admin）。
  const id = OPENID || openid || '';
  const backupsCol = db.collection('data_backups');

  try {
    // 创建全量备份（仅管理员）
    if (action === 'backupAll') {
      const isAdmin = await amIAdmin(id);
      if (!isAdmin) return { code: 403, msg: '无权限' };
      const bid = await backupAll();
      return { code: 200, backupId: bid, msg: '全量备份已创建' };
    }

    // 列表（管理员不指定用户 = 全部，含全量备份；mine=true 时即使管理员也只返回自己，用于「我的」页备份管理）
    if (action === 'list') {
      const isAdmin = await amIAdmin(id);
      let q = {};
      if (!(isAdmin && !userId && !userNo && !targetOpenid && !mine)) {
        const tid = targetOpenid || (userNo ? (await resolveByNo(userNo)) : id);
        if (!tid) return { code: 404, msg: '未找到用户' };
        q = { _openid: tid };
      }
      const res = await backupsCol.where(q).orderBy('createdAt', 'desc').limit(100).get();
      // 解析 openid -> 数字编号（user_no_map），用于"归属"显示
      const openids = [...new Set(res.data.map(b => b._openid).filter(o => o && o !== '__GLOBAL__'))];
      let noMap = {};
      if (openids.length) {
        const mres = await db.collection('user_no_map').where({ _openid: _.in(openids) }).limit(1000).get();
        // 同一 _openid 可能有多条残留记录（历史 add 重复 bug）：稳定取 no 最小的一条，
        // 不依赖遍历顺序的后写覆盖，避免不同次查询显示漂移。
        mres.data.forEach(m => {
          const o = m._openid;
          if (o == null || m.no == null) return;
          if (!(o in noMap) || m.no < noMap[o]) noMap[o] = m.no;
        });
      }
      const list = res.data.map(b => {
        let size = 0;
        if (b.snapshot) { for (const k in b.snapshot) size += (b.snapshot[k] || []).length; }
        const no = (b._openid && b._openid !== '__GLOBAL__') ? noMap[b._openid] : undefined;
        return {
          id: b._id,
          createdAt: b.createdAt || '',
          label: b.label || '',
          desc: b.desc || '',
          openid: b._openid,
          no,
          scope: b.scope || 'user',
          size
        };
      });
      return { code: 200, data: list };
    }

    // 创建单用户备份
    if (action === 'backup') {
      const isAdmin = await amIAdmin(id);
      if (!isAdmin && !id) return { code: 401, msg: '未获取到用户身份' };
      let targetId = id;
      if (isAdmin && targetOpenid) targetId = targetOpenid;
      else if (isAdmin && userNo) {
        const t = await resolveByNo(userNo);
        if (!t) return { code: 404, msg: '未找到该编号用户' };
        targetId = t;
      }

      // 普通用户备份消耗 1 次免费次数（管理员免费，便于日常运维）。
      // 事务内原子扣减：并发双点被串行化，杜绝透支 / 白送；扣次成功后再备份，
      // 若备份失败则回退次数，避免用户既扣次又没备份到。
      if (!isAdmin) {
        const t = await db.startTransaction();
        try {
          const prefsRes = await t.collection('user_preferences').where({ _openid: targetId }).limit(1).get();
          const prefs = prefsRes.data[0];
          if (!prefs) { await t.rollback(); return { code: 400, msg: '请先设置饮食偏好' }; }
          const baseFree = (typeof prefs.baseFree === 'number') ? prefs.baseFree : 0;
          const bonusFree = (typeof prefs.bonusFree === 'number') ? prefs.bonusFree : 0;
          const available = baseFree + bonusFree;
          if (available < 1) { await t.rollback(); return { code: 403, msg: '免费次数不足，无法备份' }; }
          const fromBase = Math.min(1, baseFree);
          const fromBonus = 1 - fromBase;
          if (fromBase > 0) {
            await t.collection('user_preferences').doc(prefs._id).update({ data: { baseFree: _.inc(-fromBase) } });
          }
          if (fromBonus > 0) {
            await t.collection('user_preferences').doc(prefs._id).update({ data: { bonusFree: _.inc(-fromBonus) } });
          }
          await t.commit();
          try {
            await db.collection('free_log').add({
              data: { _openid: targetId, type: 'deduct', source: 'backup', amount: 1, desc: '备份数据 -1', ts: db.serverDate() }
            });
          } catch (e) { console.error('[backupData] logFree failed:', e); }
        } catch (err) {
          await t.rollback().catch(() => {});
          return { code: 500, msg: '备份扣次失败：' + (err && err.message ? err.message : err) };
        }
      }

      try {
        const bid = await backupUser(targetId);
        return { code: 200, backupId: bid, msg: '备份已创建' };
      } catch (err) {
        // 备份失败则回退已扣次数（仅普通用户）
        if (!isAdmin) {
          try {
            const pr = await db.collection('user_preferences').where({ _openid: targetId }).limit(1).get();
            if (pr.data[0]) {
              await db.collection('user_preferences').doc(pr.data[0]._id).update({ data: { baseFree: _.inc(1) } });
            }
          } catch (e) { console.error('[backupData] refund failed:', e); }
        }
        return { code: 500, msg: '备份创建失败：' + (err && err.message ? err.message : err) };
      }
    }

    // 恢复 / 删除
    if (action === 'restore' || action === 'delete') {
      const isAdmin = await amIAdmin(id);

      // 管理员可按 targetOpenid 操作他人 / 全量备份；普通用户只能操作自己的备份（q._openid = id）
      const q = { _id: backupId };
      if (!isAdmin) q._openid = id;
      else if (targetOpenid) q._openid = targetOpenid;
      const bkpRes = await backupsCol.where(q).limit(1).get();
      if (!bkpRes.data[0]) return { code: 404, msg: '备份不存在或无权限' };
      const bkp = bkpRes.data[0];
      const isGlobal = bkp.scope === 'global';
      const effTarget = targetOpenid || bkp._openid;

      if (action === 'delete') {
        await backupsCol.doc(bkp._id).remove();
        return { code: 200, msg: '已删除' };
      }

      // 恢复时跳过「贡献 / 反馈」类集合：这些是社区级数据（菜名/食材/收藏贡献、菜名问题与意见反馈），
      // 恢复个人备份不应覆盖或回退线上已有的贡献与反馈，仅恢复个人数据（偏好/历史/次数/收藏/编号）。
      const SKIP_RESTORE = new Set(['dish_contrib', 'fav_contrib', 'dish_feedback', 'feedback']);
      // restore
      for (const col of COLLECTIONS) {
        if (SKIP_RESTORE.has(col)) continue;
        const snap = (bkp.snapshot && bkp.snapshot[col]) || [];
        if (isGlobal) {
          await clearAll(col); // 全量恢复：清空整集合后重写
        } else {
          await db.collection(col).where({ _openid: effTarget }).remove();
        }
        for (const doc of snap) {
          const nd = Object.assign({}, doc);
          delete nd._id;
          await db.collection(col).add({ data: nd });
        }
      }
      return { code: 200, msg: isGlobal ? '全量备份已恢复' : '已恢复' };
    }

    return { code: 400, msg: '未知操作' };
  } catch (e) {
    console.error('[backupData]', e);
    return { code: 500, msg: '备份操作失败：' + ((e && e.message) || e) };
  }
};
