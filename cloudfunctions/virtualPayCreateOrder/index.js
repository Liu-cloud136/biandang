// virtualPayCreateOrder —— 虚拟支付「次数包」下单（道具直购 short_series_goods）。
// 职责：校验商品 → 用 wx.login code 换 session_key → 生成 outTradeNo → 组装 signData
//       → 计算 paySig(AppKey) 与 signature(sessionKey) → 落订单 created → 返回前端拉起支付。
// 签名规则（官方 + 实测 2026-09-07）：
//   paySig    = HMAC-SHA256(AppKey, 'requestVirtualPayment&' + signData)，hex 小写
//   signature = HMAC-SHA256(session_key, signData)，hex 小写
//   signData 是 8 字段 JSON 字符串（固定键序、紧凑、不含多余空格）；offerId 必须字符串。
// 密钥来源：AppKey/AppSecret 一律 process.env（VP_APP_KEY / VP_APP_SECRET），不入库不入代码。
// 构建指纹（2026-09-07 虚拟支付 P0）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const https = require('https');
const crypto = require('crypto');

const BUILD_TAG = '2026-09-07.virtualpay-p0';
console.log('[build] virtualPayCreateOrder BUILD_TAG=' + BUILD_TAG);

function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', String(key)).update(String(data), 'utf8').digest('hex');
}

// code2Session：用小程序 AppSecret + wx.login code 换 session_key（服务端云函数发起 HTTPS）
function code2Session(appid, secret, code) {
  return new Promise((resolve, reject) => {
    const qs = 'appid=' + encodeURIComponent(appid)
      + '&secret=' + encodeURIComponent(secret)
      + '&js_code=' + encodeURIComponent(code)
      + '&grant_type=authorization_code';
    const url = 'https://api.weixin.qq.com/sns/jscode2session?' + qs;
    https.get(url, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.errcode) reject(new Error('code2Session ' + j.errcode + ' ' + (j.errmsg || '')));
          else resolve(j); // { openid, session_key }
        } catch (e) { reject(new Error('code2Session 解析失败')); }
      });
    }).on('error', reject);
  });
}

// 读虚拟支付配置（sys_config/virtual_pay）。AppKey/AppSecret 不在库里，从环境变量读。
async function readCfg() {
  let cfg = {};
  try {
    const r = await db.collection('sys_config').doc('virtual_pay').get();
    cfg = (r && r.data) ? r.data : {};
  } catch (e) { /* 用默认 */ }
  cfg.appid = cfg.appid || (cloud.getWXContext().APPID) || '';
  cfg.offerId = String(cfg.offerId || '').trim();
  cfg.env = String(cfg.env == null ? '0' : cfg.env).trim();
  cfg.appKey = process.env.VP_APP_KEY || '';
  cfg.appSecret = process.env.VP_APP_SECRET || '';
  return cfg;
}

// signData 固定键序（对齐官方文档字段表，offerId 必须字符串；金额全分）
function buildSignData(cfg, g, outTradeNo) {
  const attach = outTradeNo; // 透传原样回传，用于发货通知定位订单
  const keys = ['offerId', 'buyQuantity', 'env', 'currencyType', 'productId', 'goodsPrice', 'outTradeNo', 'attach'];
  const vals = {
    offerId: cfg.offerId,
    buyQuantity: 1,
    env: Number(cfg.env),               // 0 现网
    currencyType: 'CNY',
    productId: g.productId,
    goodsPrice: Number(g.price),        // 分
    outTradeNo: outTradeNo,
    attach: attach
  };
  const parts = keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(vals[k]));
  return '{' + parts.join(',') + '}';
}

function genOutTradeNo() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 8).toUpperCase();
  return 'T' + t + r; // 不以_开头、字母数字，<=32
}

exports.main = async (event) => {
  console.log('[build] virtualPayCreateOrder BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'create'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const action = (event && event.action) || 'create';
  const productId = (event && event.productId) || '';
  const code = (event && event.code) || '';   // wx.login() 的 code

  try {
    const cfg = await readCfg();
    if (!cfg.offerId) return { code: 500, msg: '服务端未配置虚拟支付 OfferID' };
    if (!cfg.appKey) return { code: 500, msg: '服务端未配置虚拟支付 AppKey（VP_APP_KEY）' };

    // 商品校验：只允许 enabled 的商品；首期 android 由前端把关，这里不过度限制
    let g = null;
    if (action === 'create' && productId) {
      const gr = await db.collection('pay_goods').doc(productId).get().catch(() => null);
      if (gr && gr.data) {
        const d = gr.data;
        if (d.enabled !== false) g = { productId: d.productId, name: d.name, count: d.count, price: d.price, terminal: d.terminal || 'android' };
      }
    }
    if (!g) return { code: 404, msg: '商品不存在或已下架' };

    // 需要 session_key → 必须拿到 AppSecret
    if (!cfg.appSecret) return { code: 503, msg: '服务端未配置小程序 AppSecret（VP_APP_SECRET），无法生成支付签名' };
    if (!code) return { code: 400, msg: '缺少登录凭证 code（请先 wx.login）' };
    const sess = await code2Session(cfg.appid, cfg.appSecret, code);
    const sessionKey = sess.session_key || '';
    // 安全：code 换出的 openid 必须等于当前会话 OPENID，防止替他人下单
    if (!sessionKey || (sess.openid && sess.openid !== OPENID)) {
      return { code: 403, msg: '登录态校验失败，请重试' };
    }

    const outTradeNo = genOutTradeNo();
    const signData = buildSignData(cfg, g, outTradeNo);
    const paySig = hmacSha256Hex(cfg.appKey, 'requestVirtualPayment&' + signData);
    const signature = hmacSha256Hex(sessionKey, signData);

    // 落订单（created）。attach 记录 outTradeNo 供发货核对；status 状态机 created→delivered
    await db.collection('payment_order').add({
      data: {
        _openid: OPENID,
        outTradeNo: outTradeNo,
        wxOrderId: '',              // 平台 MchOrderNo，通知时回填
        productId: g.productId,
        name: g.name,
        count: g.count,
        price: g.price,
        terminal: g.terminal,
        attach: signData,           // 保留完整 signData，便于对账
        status: 'created',
        env: Number(cfg.env),
        createAt: Date.now(),
        deliveredAt: 0,
        notifyAt: 0
      }
    });

    return {
      code: 200,
      data: {
        outTradeNo: outTradeNo,
        signData: signData,
        paySig: paySig,
        signature: signature,
        mode: 'short_series_goods',
        productId: g.productId,
        name: g.name,
        count: g.count,
        price: g.price
      }
    };
  } catch (e) {
    console.error('virtualPayCreateOrder error:', e);
    return { code: 500, msg: (e && e.message) || '下单失败' };
  }
};
