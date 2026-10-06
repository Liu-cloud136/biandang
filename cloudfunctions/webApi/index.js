const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const crypto = require('crypto');

// webApi —— Web 版（智能体涌现奖参赛作品）对外的唯一聚合入口。
// 设计原则：本函数是浏览器/Agent 访问 env1 的【唯一】白名单通道；
//   ① 游客身份：前端随机 guestToken → 服务端加盐哈希成 'w' 前缀假 openid（与真实 'o' 前缀/ADMIN 永不冲突），
//     后续所有数据（偏好/历史/收藏/cook_viewed）天然隔离在 webg 命名空间，可整体清理。
//   ② 下游复用：getRecommendation 原生支持 event.OPENID 透传；getCookGuide 已打 event.OPENID 兜底补丁；
//     getDishImage 无身份依赖。偏好/历史/收藏等薄壳逻辑在本函数内镜像实现，不暴露原函数。
//   ③ 限流：实例内存滑动窗（ recommend 6次/分/IP，其余 30次/分/IP）；免费次数每日 +2（镜像 signIn）兜底防滥用。
//   ④ 双模式：云接入 HTTP（event=网关式，返回 {statusCode,headers,body} 集成响应并自带 CORS）
//     与 invokeFunction 直调（event=业务对象，直接返回业务结果）均可用。
// 构建指纹（R-Env-01 验证约定）
const BUILD_TAG = '2026-09-12.webapi-v4';
console.log('[build] webApi BUILD_TAG=' + BUILD_TAG);

const SALT = process.env.WEB_SALT || '';

// ---------- 游客身份 ----------

function guestOpenidOf(token) {
  const t = String(token || '').trim();
  // Reject guest identity when WEB_SALT is unset (fail-closed: avoids a predictable fixed salt).
  if (!SALT) return '';
  // token 只允许十六进制（前端生成 32hex），防止注入杂字符
  if (!/^[0-9a-f]{8,64}$/.test(t)) return '';
  const h = crypto.createHash('sha256').update(t + '::' + SALT).digest('hex');
  return 'w' + h.slice(0, 23);
}

// ---------- 限流（实例内存滑动窗） ----------

const buckets = new Map();
const RL_RULES = { recommend: { win: 60000, max: 6 }, default: { win: 60000, max: 30 } };
function rateLimit(key, kind) {
  const rule = RL_RULES[kind] || RL_RULES.default;
  const now = Date.now();
  const k = kind + '|' + key;
  let arr = buckets.get(k);
  if (!arr) { arr = []; buckets.set(k, arr); }
  while (arr.length && now - arr[0] > rule.win) arr.shift();
  if (arr.length >= rule.max) return false;
  arr.push(now);
  if (buckets.size > 5000) { // 防 map 无界膨胀
    for (const [bk, v] of buckets) { if (!v.length || now - v[v.length - 1] > 300000) buckets.delete(bk); }
  }
  return true;
}

// ---------- 字段净化 ----------

function strArr(v, cap) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim().slice(0, 20);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= (cap || 30)) break;
  }
  return out;
}

const PREF_FIELDS = ['taste', 'cuisine', 'type', 'meat', 'veg', 'cookMethod', 'drink', 'avoid', 'scene', 'communityIngredients', 'masterIngredients'];

function sanitizePrefsOut(p) {
  const out = {};
  for (const f of PREF_FIELDS) if (Array.isArray(p[f])) out[f] = p[f];
  if (Array.isArray(p.avoidDishes)) out.avoidDishes = p.avoidDishes;
  out.freeCount = (p.baseFree || 0) + (p.bonusFree || 0);
  return out;
}

// cloud:// fileID → 浏览器可用的临时 https URL（存储桶默认私有，直链会 403）
async function toHttpUrl(fileID) {
  if (!fileID || typeof fileID !== 'string' || !fileID.startsWith('cloud://')) return fileID || '';
  try {
    const r = await cloud.getTempFileURL({ fileList: [fileID] });
    const f = (r && r.fileList && r.fileList[0]) || {};
    return f.tempFileURL || '';
  } catch (e) {
    console.error('[webApi][toHttpUrl] ' + ((e && e.message) || e));
    return '';
  }
}

// Web 游客不限次体验：次数池常驻补满（下游扣次逻辑照常跑，只是永远扣不空）。限流仍由 rateLimit 把守。
async function ensureGuestQuota(guestOpenid) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await db.collection('user_preferences').where({ _openid: guestOpenid }).limit(1).get();
  if (r.data.length) {
    if ((r.data[0].baseFree || 0) < 9) {
      await db.collection('user_preferences').doc(r.data[0]._id).update({ data: { baseFree: _.set(9) } });
    }
  } else {
    await db.collection('user_preferences').add({
      data: { baseFree: 9, bonusFree: 0, totalFreeGranted: 9, adCount: 0, pendingBonus: 0, webGrantDate: today, scene: [], _openid: guestOpenid }
    });
  }
}

// ---------- main ----------

// 云接入（HTTP Service）event 形状 = API 网关式：{httpMethod, headers, body, isBase64Encoded}；
// 直接 invokeFunction 时 event 即业务对象。此处统一归一，httpMode 下以 {statusCode,headers,body} 集成响应返回（自带 CORS）。
function normalizeEvent(event) {
  const e = event || {};
  if (e.httpMethod && typeof e.body === 'string') {
    let biz = {};
    try {
      const raw = e.isBase64Encoded ? Buffer.from(e.body, 'base64').toString('utf8') : e.body;
      biz = JSON.parse(raw || '{}');
    } catch (err) { biz = {}; }
    return { biz, httpMode: true, headers: e.headers || {}, method: String(e.httpMethod).toUpperCase() };
  }
  return { biz: e, httpMode: false, headers: {}, method: '' };
}

const CORS_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function respond(httpMode, result) {
  if (!httpMode) return result;
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(result) };
}

exports.main = async (event, context) => {
  const { biz, httpMode, headers, method } = normalizeEvent(event);
  if (httpMode && method === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  const action = biz.action || '';
  console.log('[build] webApi BUILD_TAG=' + BUILD_TAG + ' action=' + action + ' httpMode=' + httpMode);

  if (action === 'buildInfo') return respond(httpMode, { code: 200, build: BUILD_TAG });

  const wxCtx = cloud.getWXContext() || {};
  const ip = (httpMode && (headers['x-forwarded-for'] || '').split(',')[0].trim()) || wxCtx.CLIENTIP || 'unknown';
  const guestOpenid = guestOpenidOf(biz.guestToken);
  if (!guestOpenid) return respond(httpMode, { code: 401, msg: 'guestToken 缺失或不合法' });
  if (!rateLimit(ip, action)) return respond(httpMode, { code: 429, msg: '请求太频繁，请稍后再试' });

  try {
    switch (action) {

      // 游客注册/领每日次数：无档建档，有档每日 +2（镜像 signIn 语义，字段 webGrantDate 区分小程序签到）
      case 'init': {
        const today = new Date().toISOString().slice(0, 10);
        const r = await db.collection('user_preferences').where({ _openid: guestOpenid }).limit(1).get();
        if (!r.data.length) {
          const add = await db.collection('user_preferences').add({
            data: { baseFree: 2, bonusFree: 0, totalFreeGranted: 2, adCount: 0, pendingBonus: 0, webGrantDate: today, scene: [], _openid: guestOpenid }
          });
          return respond(httpMode, { code: 200, data: { isNew: true, freeCount: 2, prefs: null } });
        }
        const p = r.data[0];
        let freeCount = (p.baseFree || 0) + (p.bonusFree || 0);
        if (p.webGrantDate !== today) {
          await db.collection('user_preferences').doc(p._id).update({ data: { baseFree: _.inc(2), webGrantDate: today } });
          freeCount += 2;
        }
        return respond(httpMode, { code: 200, data: { isNew: false, freeCount, prefs: sanitizePrefsOut(p) } });
      }

      // 主推荐：透传 getRecommendation（其原生支持 event.OPENID；只放行 scene，偏好走 user_preferences 档）
      case 'recommend': {
        const scene = typeof biz.scene === 'string' ? biz.scene.trim().slice(0, 10) : '';
        await ensureGuestQuota(guestOpenid);
        const r = await cloud.callFunction({
          name: 'getRecommendation',
          data: Object.assign({ OPENID: guestOpenid }, scene ? { scene } : {})
        });
        return respond(httpMode, r.result);
      }

      // 历史决定（镜像 getHistory：仅已采纳，web 版限 20 条）
      case 'history': {
        const res = await db.collection('recommend_history')
          .where({ _openid: guestOpenid })
          .orderBy('timestamp', 'desc')
          .limit(20)
          .get();
        return respond(httpMode, { code: 200, data: res.data.filter(d => Array.isArray(d.selected) && d.selected.length) });
      }

      // 做法页：getCookGuide 已打 event.OPENID 兜底补丁（次数池由 ensureGuestQuota 常驻补满）
      case 'cookGuide': {
        const dish = typeof biz.dish === 'string' ? biz.dish.trim().slice(0, 30) : '';
        if (!dish) return respond(httpMode, { code: 400, msg: 'dish 缺失' });
        await ensureGuestQuota(guestOpenid);
        const r = await cloud.callFunction({ name: 'getCookGuide', data: { dish, OPENID: guestOpenid } });
        return respond(httpMode, r.result);
      }

      // 菜品图（无身份依赖，缓存复用；fileID 转临时 https URL 供浏览器直显）
      case 'dishImage': {
        const name = typeof biz.name === 'string' ? biz.name.trim().slice(0, 30) : '';
        if (!name) return respond(httpMode, { code: 400, msg: 'name 缺失' });
        const r = await cloud.callFunction({
          name: 'getDishImage',
          data: { name, cuisine: typeof biz.cuisine === 'string' ? biz.cuisine.slice(0, 10) : '' }
        });
        const out = r.result || {};
        if (out.data && out.data.imageUrl) out.data.imageUrl = await toHttpUrl(out.data.imageUrl);
        return respond(httpMode, out);
      }

      case 'prefsGet': {
        const r = await db.collection('user_preferences').where({ _openid: guestOpenid }).limit(1).get();
        return respond(httpMode, { code: 200, data: r.data.length ? sanitizePrefsOut(r.data[0]) : null });
      }

      // 保存偏好（镜像 savePreferences 字段白名单；不含 tuning/引导奖励，游客不发币）
      case 'prefsSave': {
        const data = { updatedAt: new Date(), _openid: guestOpenid };
        for (const f of PREF_FIELDS) data[f] = strArr(biz[f]);
        const r = await db.collection('user_preferences').where({ _openid: guestOpenid }).limit(1).get();
        if (r.data.length) {
          await db.collection('user_preferences').doc(r.data[0]._id).update({ data });
        } else {
          await db.collection('user_preferences').add({ data: Object.assign({ baseFree: 2, bonusFree: 0, webGrantDate: new Date().toISOString().slice(0, 10) }, data) });
        }
        return respond(httpMode, { code: 200, msg: 'ok' });
      }

      // 不喜欢的菜（镜像 userAvoid，另补 add；存 user_preferences.avoidDishes）
      case 'avoidList': {
        const r = await db.collection('user_preferences').where({ _openid: guestOpenid }).limit(1).get();
        const list = (r.data.length && Array.isArray(r.data[0].avoidDishes)) ? r.data[0].avoidDishes : [];
        return respond(httpMode, { code: 200, data: list });
      }
      case 'avoidAdd': {
        const d = typeof biz.dish === 'string' ? biz.dish.trim().slice(0, 30) : '';
        if (!d) return respond(httpMode, { code: 400, msg: 'dish 缺失' });
        const p = await db.collection('user_preferences').where({ _openid: guestOpenid }).limit(1).get();
        if (!p.data.length) return respond(httpMode, { code: 404, msg: '请先完成 init' });
        await db.collection('user_preferences').doc(p.data[0]._id).update({ data: { avoidDishes: _.addToSet(d) } });
        return respond(httpMode, { code: 200, msg: 'ok' });
      }
      case 'avoidRemove': {
        const d = typeof biz.dish === 'string' ? biz.dish.trim().slice(0, 30) : '';
        if (!d) return respond(httpMode, { code: 400, msg: 'dish 缺失' });
        const p = await db.collection('user_preferences').where({ _openid: guestOpenid }).limit(1).get();
        if (!p.data.length) return respond(httpMode, { code: 200, msg: '无记录' });
        await db.collection('user_preferences').doc(p.data[0]._id).update({ data: { avoidDishes: _.pull(d) } });
        return respond(httpMode, { code: 200, msg: '已删除' });
      }

      // 收藏（简版：不进 fav_count 贡献池、不扣次；文档形状与 favorite 一致便于日后合并）
      case 'favList': {
        const res = await db.collection('favorites')
          .where({ _openid: guestOpenid, source: _.neq('local') })
          .orderBy('ts', 'desc')
          .limit(100)
          .get();
        return respond(httpMode, { code: 200, data: res.data.map(d => ({ dish: d.dish, scene: d.scene || '', kind: d.kind || '', imageUrl: d.imageUrl || '', ts: d.ts || null })) });
      }
      case 'favAdd': {
        const dish = typeof biz.dish === 'string' ? biz.dish.trim().slice(0, 30) : '';
        if (!dish) return respond(httpMode, { code: 400, msg: 'dish 缺失' });
        const favId = guestOpenid + '::' + dish;
        try {
          await db.collection('favorites').add({
            data: {
              _id: favId, _openid: guestOpenid, dish,
              scene: typeof biz.scene === 'string' ? biz.scene.slice(0, 10) : '',
              kind: typeof biz.kind === 'string' ? biz.kind.slice(0, 10) : '',
              imageUrl: typeof biz.imageUrl === 'string' ? biz.imageUrl.slice(0, 300) : '',
              source: 'web',
              ts: db.serverDate()
            }
          });
        } catch (e) {
          if (!/exist|duplicate|已存在/i.test((e && e.message) || '')) throw e;
        }
        return respond(httpMode, { code: 200, data: { added: true, _id: favId } });
      }
      case 'favRemove': {
        const dish = typeof biz.dish === 'string' ? biz.dish.trim().slice(0, 30) : '';
        if (!dish) return respond(httpMode, { code: 400, msg: 'dish 缺失' });
        await db.collection('favorites').where({ _openid: guestOpenid, dish }).remove();
        return respond(httpMode, { code: 200, data: { removed: true } });
      }

      default:
        return respond(httpMode, { code: 400, msg: '未知 action' });
    }
  } catch (e) {
    console.error('[webApi][' + action + '] ' + ((e && e.message) || e));
    return respond(httpMode, { code: 500, msg: (e && e.message) || '服务繁忙' });
  }
};
