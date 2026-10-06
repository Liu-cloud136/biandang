// virtualPayQueryCron —— 查单兜底（定时 5 分钟）。
// 场景：平台发货推送丢失/处理失败时，主动调 query_order 确认用户是否已支付，已支付则补发货。
// 官方接口（2026-09-07 核实）：
//   POST https://api.weixin.qq.com/xpay/query_order?access_token=ACCESS_TOKEN&pay_sig=PAY_SIG
//   body { openid, env, order_id }；pay_sig = HMAC-SHA256(AppKey, '/xpay/query_order&' + body串)
//   order.status：2=已支付待发货，4=已发货，5/6/8=退款/关闭/退款完成（不发货）
// access_token 用小程序 appid+secret 换取（cgi-bin/token）；需 .env 配 VP_APP_SECRET。
// 发货与 virtualPayNotify 共用语义：bonusFree+N + free_log(source=virtualpay) + 订单 delivered。
// 构建指纹（2026-09-07 虚拟支付 P0）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const https = require('https');
const crypto = require('crypto');
const BUILD_TAG = '2026-09-07.virtualpay-p0';
console.log('[build] virtualPayQueryCron BUILD_TAG=' + BUILD_TAG);

function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', String(key)).update(String(data), 'utf8').digest('hex');
}
function httpJson(method, url, payload, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: method || 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ errcode: -99, errmsg: buf.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}
// access_token 缓存（实例级；cron 每 5min 一次，token 2h 有效足够）
let _tokenCache = { token: '', exp: 0 };
async function getAccessToken(cfg) {
  if (_tokenCache.token && Date.now() < _tokenCache.exp) return _tokenCache.token;
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid='
    + encodeURIComponent(cfg.appid) + '&secret=' + encodeURIComponent(cfg.appSecret);
  const j = await httpJson('GET', url, null);
  if (!j.access_token) throw new Error('access_token 获取失败 ' + (j.errcode || '') + ' ' + (j.errmsg || ''));
  _tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 7200) * 900 };
  return j.access_token;
}
async function readCfg() {
  let cfg = {};
  try {
    const r = await db.collection('sys_config').doc('virtual_pay').get();
    cfg = (r && r.data) ? r.data : {};
  } catch (e) {}
  cfg.appid = cfg.appid || '';
  cfg.offerId = String(cfg.offerId || '').trim();
  cfg.env = String(cfg.env == null ? '0' : cfg.env).trim();
  cfg.appKey = process.env.VP_APP_KEY || '';
  cfg.appSecret = process.env.VP_APP_SECRET || '';
  return cfg;
}
// 发货（与 notify 同口径）
async function deliver(OPENID, orderId, count, wxOrderId, note) {
  const t = await db.startTransaction();
  try {
    const prefs = await t.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
    if (prefs.data && prefs.data.length) {
      await t.collection('user_preferences').doc(prefs.data[0]._id).update({ data: { bonusFree: _.inc(count) } });
    } else {
      await t.collection('user_preferences').add({
        data: { baseFree: 0, bonusFree: count, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', _openid: OPENID }
      });
    }
    await t.collection('free_log').add({
      data: { _openid: OPENID, type: 'add', source: 'virtualpay', amount: count, sourceName: '虚拟支付购买', desc: note, ts: db.serverDate() }
    });
    await t.collection('payment_order').doc(orderId).update({
      data: { status: 'delivered', wxOrderId: wxOrderId || '', deliveredAt: Date.now() }
    });
    await t.commit();
    return true;
  } catch (e) { await t.rollback(); throw e; }
}

exports.main = async () => {
  console.log('[build] virtualPayQueryCron BUILD_TAG=' + BUILD_TAG);
  const cfg = await readCfg();
  if (!cfg.appKey || !cfg.appSecret) {
    console.log('[cron] 缺 VP_APP_KEY/VP_APP_SECRET，跳过本轮查单');
    return { code: 200, msg: 'skip: 未配置密钥' };
  }
  try {
    // 超过 2 分钟仍未 delivered 的订单（下单时间 > 2min），可能推送丢失，主动查单
    const cutoff = Date.now() - 2 * 60 * 1000;
    const r = await db.collection('payment_order')
      .where({ status: 'created', createAt: _.lt(cutoff) })
      .orderBy('createAt', 'asc')
      .limit(20)
      .get();
    const pending = (r.data || []).filter(o => o && o._openid && o.outTradeNo);
    if (!pending.length) return { code: 200, msg: '无待查订单' };
    const token = await getAccessToken(cfg);
    let okCount = 0, failCount = 0;
    for (const o of pending) {
      try {
        const body = JSON.stringify({ openid: o._openid, env: Number(cfg.env), order_id: o.outTradeNo });
        const paySig = hmacSha256Hex(cfg.appKey, '/xpay/query_order&' + body);
        const url = 'https://api.weixin.qq.com/xpay/query_order?access_token=' + encodeURIComponent(token) + '&pay_sig=' + encodeURIComponent(paySig);
        const q = await httpJson('POST', url, body);
        const st = q && q.order ? q.order.status : -1;
        if (q && q.errcode === 0 && (st === 2 || st === 4)) {
          // 已支付（待发货=2 或已发货=4）→ 补发货；若平台已标发货但推送丢失，同样补上账（幂等靠订单 status）
          const count = o.count || 0;
          const note = '虚拟支付购买 ' + (o.name || '') + ' ' + count + ' 次（订单 ' + o.outTradeNo + '，查单补发）';
          await deliver(o._openid, o._id, count, (q.order && q.order.wx_order_id) || o.wxOrderId || '', note);
          okCount++;
          console.log('[cron] 补发 ' + o.outTradeNo + ' status=' + st);
        } else {
          failCount++;
          console.log('[cron] 未支付或异常 ' + o.outTradeNo + ' errcode=' + (q && q.errcode) + ' status=' + st + ' msg=' + ((q && q.errmsg) || '').slice(0, 120));
        }
      } catch (e) {
        failCount++;
        console.error('[cron] 查单失败 ' + (o && o.outTradeNo) + ' : ' + (e && e.message));
      }
    }
    return { code: 200, data: { scanned: pending.length, okCount, failCount } };
  } catch (e) {
    console.error('virtualPayQueryCron error:', e);
    return { code: 500, msg: (e && e.message) || '查单失败' };
  }
};
