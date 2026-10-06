const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const crypto = require('crypto');

// 管理员后台：兑换码管理
//   action:'create'  建码（支持手工指定 code 或系统随机生成），参数：count,quota,expireAt?,desc?,code?
//   action:'list'    查码列表（全部，上限 1000 条）
//   action:'disable' 停用某码 code
//   action:'delete'  彻底删除某码 code（并级联删除该码的兑换记录 redeem_log）
// 管理员判定：OPENID（或前端传 openid）命中 ADMIN_OPENID 白名单。
// 构建指纹（2026-08-11 兑换码上线）
const BUILD_TAG = '2026-08-11.redeem-code-all';
console.log('[build] manageRedeem BUILD_TAG=' + BUILD_TAG);

const ADMIN_OPENID = process.env.ADMIN_OPENID || '';

// 易读、去除易混字符（0/O、1/I/L）
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  const b = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return 'EAT-' + s; // 例：EAT-K7M2P9
}

async function ensureCollections() {
  await Promise.allSettled([db.createCollection('redeem_codes')]);
}

// 解析 expireAt：数字=天数；字符串=日期；空=null
function parseExpire(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (v <= 0) return null;
    return new Date(Date.now() + v * 86400000);
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

exports.main = async (event) => {
  console.log('[build] manageRedeem BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  const id = (OPENID || (event && (event.openid || event.openId)) || '').trim();

  // 幂等建集合（入口最顶部，确保首次调用即就绪，不受后续鉴权 return 影响）
  await ensureCollections();

  if (!id || id !== ADMIN_OPENID) return { code: 403, msg: '无权限' };

  const action = (event && event.action) || 'list';

  try {
    if (action === 'create') {
      const count = Number(event.count);
      const quota = Number(event.quota);
      if (!Number.isInteger(count) || count < 1 || count > 1000) return { code: 400, msg: 'count 须为 1~1000 的整数' };
      if (!Number.isInteger(quota) || quota < 1 || quota > 1000000) return { code: 400, msg: 'quota 须为 1~1000000 的整数' };

      let code = (event.code || '').toString().trim().toUpperCase();
      if (code) {
        if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) return { code: 400, msg: 'code 格式不正确（4~40 位字母数字下划线连字符）' };
        const ex = await db.collection('redeem_codes').where({ code }).limit(1).get();
        if (ex.data && ex.data.length) return { code: 409, msg: '该 code 已存在' };
      } else {
        // 系统随机生成，确保唯一（最多重试 8 次）
        for (let i = 0; i < 8; i++) {
          code = genCode();
          const ex = await db.collection('redeem_codes').where({ code }).limit(1).get();
          if (!(ex.data && ex.data.length)) break;
          code = '';
        }
        if (!code) return { code: 500, msg: '生成码失败，请重试' };
      }

      const expireAt = parseExpire(event.expireAt);
      const add = await db.collection('redeem_codes').add({
        data: {
          code,
          count,
          quota,
          used: 0,
          active: true,
          expireAt,
          desc: (event.desc || '').toString().slice(0, 100),
          createAt: db.serverDate()
        }
      });
      return { code: 200, data: { _id: add._id, code, count, quota, expireAt, desc: event.desc || '' } };
    }

    if (action === 'list') {
      const res = await db.collection('redeem_codes').orderBy('createAt', 'desc').limit(1000).get();
      const list = (res.data || []).map(x => ({
        code: x.code,
        count: x.count,
        quota: x.quota,
        used: x.used || 0,
        active: !!x.active,
        expireAt: x.expireAt || null,
        desc: x.desc || ''
      }));
      return { code: 200, data: { list } };
    }

    if (action === 'disable') {
      const code = (event.code || '').toString().trim().toUpperCase();
      if (!code) return { code: 400, msg: 'code 必填' };
      const r = await db.collection('redeem_codes').where({ code }).limit(1).get();
      if (!(r.data && r.data.length)) return { code: 404, msg: '码不存在' };
      await db.collection('redeem_codes').doc(r.data[0]._id).update({ data: { active: false } });
      return { code: 200, msg: '已停用 ' + code };
    }

    if (action === 'delete') {
      const code = (event.code || '').toString().trim().toUpperCase();
      if (!code) return { code: 400, msg: 'code 必填' };
      const r = await db.collection('redeem_codes').where({ code }).limit(1).get();
      if (!(r.data && r.data.length)) return { code: 404, msg: '码不存在' };
      await db.collection('redeem_codes').doc(r.data[0]._id).remove();
      // 级联清理该码的兑换记录（已领次的赠送不受此影响，记录仅用于审计/防重兑）
      try { await db.collection('redeem_log').where({ code }).remove(); } catch (e) { console.warn('redeem_log 级联删除失败', code, e); }
      return { code: 200, msg: '已删除 ' + code };
    }

    return { code: 400, msg: '未知 action' };
  } catch (e) {
    console.error('manageRedeem error:', e);
    return { code: 500, msg: '操作失败' };
  }
};
