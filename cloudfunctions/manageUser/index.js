const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 管理员 OPENID（仅用于列表显示 'admin' 与跳过编号分配，不做接口鉴权——鉴权由前端 adminLogin 完成）
const ADMIN_OPENID = (process.env.ADMIN_OPENID || '').trim();
const isAdminOpenid = (oid) => !!(oid && oid === ADMIN_OPENID);

// 编号计数器（与 getPrefs.getUserId 共用，保证顺序连续、不冲突）
const COUNTER_COL = 'counters';
const COUNTER_ID = 'user_no';

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-20.userid-fixmissingno';
console.log('[build] manageUser BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] manageUser BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  // 身份校验交由前端 adminLogin 完成（能进入管理页即已通过验证），本函数不再单独鉴权。

  const { openid, userNo, action } = event || {};
  try {
    // 用户列表（分页拉取 user_preferences，join user_no_map 取 userNo）
    if (action === 'list') {
      const pageSize = Math.min(Math.max(Number(event.pageSize) || 20, 1), 50);
      const page = Math.max(Number(event.page) || 0, 0);
      const countRes = await db.collection('user_preferences').count().catch(() => ({ total: 0 }));
      const total = countRes.total || 0;
      const list = [];
      if (total > 0) {
        const rows = await db.collection('user_preferences')
          .orderBy('baseFree', 'desc')
          .skip(page * pageSize).limit(pageSize).get();
        const ids = (rows.data || []).map(x => x._openid);
        const mapRes = await db.collection('user_no_map').where({ _openid: _.in(ids) }).get().catch(() => ({ data: [] }));
        const noMap = {};
        (mapRes.data || []).forEach(m => { noMap[m._openid] = m.no; });
        (rows.data || []).forEach(p => {
          const base = p.baseFree || 0, bonus = p.bonusFree || 0;
          const oid = p._openid || '';
          // 管理员固定显示 'admin'，不占用数字编号、不进计数器
          const no = isAdminOpenid(oid) ? 'admin' : (noMap[oid] != null ? noMap[oid] : null);
          list.push({
            openid: oid,
            openidMask: oid.length > 10 ? (oid.slice(0, 6) + '…' + oid.slice(-4)) : oid,
            userNo: no,
            baseFree: base,
            bonusFree: bonus,
            freeCount: base + bonus,
            banned: !!p.banned,
            lastSignedDate: p.lastSignedDate || ''
          });
        });
      }
      return {
        code: 200,
        data: {
          list,
          total,
          page,
          pageSize,
          pages: Math.ceil(total / pageSize)
        }
      };
    }

    // 一次性补建缺失编号：扫描所有 user_preferences，对 user_no_map 缺失且非管理员者分配顺序编号
    if (action === 'fixMissingNo') {
      const mapRes = await db.collection('user_no_map').get().catch(() => ({ data: [] }));
      const have = {};
      (mapRes.data || []).forEach(m => { if (m && m._openid) have[m._openid] = true; });
      let maxNo = 0;
      (mapRes.data || []).forEach(m => { if (m && typeof m.no === 'number' && m.no > maxNo) maxNo = m.no; });
      const all = await db.collection('user_preferences').limit(1000).get().catch(() => ({ data: [] }));
      const assigned = [];
      for (const p of (all.data || [])) {
        const oid = p._openid;
        if (!oid || isAdminOpenid(oid) || have[oid]) continue;
        const t = await db.startTransaction();
        try {
          const c = await t.collection(COUNTER_COL).doc(COUNTER_ID).get().catch(() => null);
          const base = (c && c.data && typeof c.data.seq === 'number') ? c.data.seq : maxNo;
          const no = Math.max(base, maxNo) + 1;
          await t.collection(COUNTER_COL).doc(COUNTER_ID).update({ data: { seq: no } }).catch(async () => {
            await t.collection(COUNTER_COL).doc(COUNTER_ID).set({ data: { seq: maxNo } });
          });
          await t.commit();
          // ⚠️ wx-server-sdk 2.6.3 下 doc(oid).set(obj) 会把 data 解析为 undefined（no 丢失 → 后台显示「未分配」）。
          // 改用 add 指定 _id 幂等写入；冲突则 update 补 no（update 不受影响）。
          try {
            await db.collection('user_no_map').add({ data: { _id: oid, _openid: oid, no, createdAt: new Date() } });
          } catch (addErr) {
            await db.collection('user_no_map').doc(oid).update({ data: { no, _openid: oid } }).catch(() => {});
          }
          have[oid] = true;
          maxNo = no;
          assigned.push({ openid: oid, no });
        } catch (e) {
          await t.rollback().catch(() => {});
          // 计数器文档可能未初始化：先建再重试
          await db.collection(COUNTER_COL).doc(COUNTER_ID).set({ data: { seq: maxNo } }).catch(() => {});
        }
      }
      return { code: 200, data: { assigned, count: assigned.length } };
    }

    let targetId = (openid || '').toString().trim();
    if (!targetId && userNo != null) {
      const map = await db.collection('user_no_map').where({ no: Number(userNo) }).limit(1).get();
      if (map.data && map.data[0]) targetId = map.data[0]._openid;
    }
    if (!/^[a-zA-Z0-9_-]{10,64}$/.test(targetId)) return { code: 400, msg: '请提供合法的 openid 或 userNo' };

    // 封禁 / 解封（管理员操作）
    if (action === 'ban' || action === 'unban') {
      try {
        const r = await db.collection('user_preferences').where({ _openid: targetId }).limit(1).get();
        if (r.data && r.data[0]) {
          await db.collection('user_preferences').doc(r.data[0]._id).update({ data: { banned: action === 'ban' } });
        } else {
          await db.collection('user_preferences').add({
            data: { _openid: targetId, banned: action === 'ban', baseFree: 0, bonusFree: 0, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '' }
          });
        }
      } catch (e) {
        return { code: 500, msg: '封禁操作失败：' + ((e && e.message) || e) };
      }
    }

    const prefs = await db.collection('user_preferences').where({ _openid: targetId }).limit(1).get();
    const p = prefs.data && prefs.data[0];
    const base = (p && p.baseFree) || 0;
    const bonus = (p && p.bonusFree) || 0;

    const map = await db.collection('user_no_map').where({ _openid: targetId }).limit(1).get();
    const no = (map.data && map.data[0] && map.data[0].no != null) ? map.data[0].no : null;

    const contrib = await db.collection('dish_contrib').where({ _openid: targetId }).count().catch(() => ({ total: 0 }));
    const fb = await db.collection('dish_feedback').where({ _openid: targetId }).count().catch(() => ({ total: 0 }));

    return {
      code: 200,
      data: {
        openid: targetId,
        userNo: no,
        baseFree: base,
        bonusFree: bonus,
        freeCount: base + bonus,
        contribCount: contrib.total || 0,
        feedbackCount: fb.total || 0,
        lastSignedDate: p ? p.lastSignedDate : '',
        banned: !!(p && p.banned)
      }
    };
  } catch (e) {
    return { code: 500, msg: (e && e.message) || '查询失败' };
  }
};
