// virtualPayNotify —— 接收平台「虚拟支付发货推送」，双形态兼容：
//   形态A（HTTP 访问服务 / MP 消息推送 URL）：event = { httpMethod, body(明文XML或base64) }，返回 XML ErrCode；
//   形态B（云开发「云函数免鉴权接收」）：event = JSON 对象（虚拟支付回调字段），返回 'success' 即可。
// 本函数同时兼容两种：先尝试 XML 解析，再尝试 JSON 对象直接取字段（Event=xpay_goods_deliver_notify）。
// 处理逻辑：验单 → 幂等（OutTradeNo/平台单号）→ 事务发货 bonusFree+N + free_log(source=virtualpay) → 回执。
// 构建指纹（2026-09-07 虚拟支付 P0，双形态 + URL 验证）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const crypto = require('crypto');
const BUILD_TAG = '2026-09-07.virtualpay-p0.bi3';
console.log('[build] virtualPayNotify BUILD_TAG=' + BUILD_TAG);

// MP「消息推送」URL 接入验证：微信 GET 带 signature/timestamp/nonce/echostr，
// 校验 sha1(字典序[token,timestamp,nonce])==signature，原样返回 echostr 即验证通过。
// Token 从环境变量 VP_MSG_TOKEN 读取：未配置时宽松放行（便于先配通 URL，再补 Token 收紧）。
function handleUrlVerify(event) {
  if (!event || String(event.httpMethod || '').toUpperCase() !== 'GET') return null;
  const q = event.queryStringParameters || {};
  const signature = q.signature || '';
  const timestamp = String(q.timestamp || '');
  const nonce = String(q.nonce || '');
  const echostr = q.echostr || '';
  if (!signature || !echostr) return null; // 非 URL 验证 GET
  const token = process.env.VP_MSG_TOKEN || '';
  if (token) {
    const raw = [token, timestamp, nonce].sort().join('');
    const calc = crypto.createHash('sha1').update(raw).digest('hex');
    if (calc !== signature) {
      console.log('[notify] url-verify signature mismatch');
      return { statusCode: 403, body: 'invalid signature' };
    }
  }
  console.log('[notify] url-verify ok (token=' + (token ? 'set' : 'none') + ')');
  return { statusCode: 200, body: echostr };
}

// 极简 XML 单标签取值（本项目通知结构固定，无需完整 XML 解析器）
// ⚠️ 微信推送文本多用 CDATA 包裹（<Event><![CDATA[x]]></Event>），取值时必须剥离 <![CDATA[ ]]>，
// 否则 Event 值会带上外壳导致判断失败（2026-09-07 实测：漏发根因）。
function stripCdata(s) {
  return String(s).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}
function xmlTag(xml, tag) {
  if (!xml || typeof xml !== 'string') return '';
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? stripCdata(m[1]).trim() : '';
}
// 取对象字段（兼容多写法/大小写）
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const v = obj[k];
      return (typeof v === 'object') ? v : String(v);
    }
  }
  return undefined;
}
// 从 JSON event 取平台单号（WeChatPayInfo.MchOrderNo 可能嵌套/或 MchOrderNo/wx_order_id 平铺）
function jsonWxOrderId(obj) {
  if (!obj) return '';
  const direct = pick(obj, ['MchOrderNo', 'wxOrderId', 'wx_order_id', 'WeChatPayInfo']);
  if (direct && typeof direct === 'object') {
    return String(direct.MchOrderNo || direct.wx_order_id || direct.wxOrderId || '');
  }
  return String(direct || '');
}
// 从 JSON event 取商品信息
function jsonGoods(obj) {
  if (!obj) return { productId: '', quantity: 0 };
  const g = obj.GoodsInfo && typeof obj.GoodsInfo === 'object' ? obj.GoodsInfo : {};
  const productId = pick(obj, ['ProductId']) || pick(g, ['ProductId', 'productId']) || '';
  const quantity = Number(pick(obj, ['Quantity']) || pick(g, ['Quantity', 'quantity']) || 0) || 0;
  return { productId: String(productId), quantity };
}

// 发货：bonusFree +N + free_log + 订单 delivered（事务）
async function deliver(OPENID, orderId, count, wxOrderId, note) {
  const t = await db.startTransaction();
  try {
    const prefs = await t.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
    if (prefs.data && prefs.data.length) {
      const doc = prefs.data[0];
      await t.collection('user_preferences').doc(doc._id).update({
        data: { bonusFree: _.inc(count) }
      });
    } else {
      await t.collection('user_preferences').add({
        data: { baseFree: 0, bonusFree: count, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', _openid: OPENID }
      });
    }
    await t.collection('free_log').add({
      data: {
        _openid: OPENID, type: 'add', source: 'virtualpay', amount: count,
        sourceName: '虚拟支付购买',
        desc: note, ts: db.serverDate()
      }
    });
    await t.collection('payment_order').doc(orderId).update({
      data: { status: 'delivered', wxOrderId: wxOrderId, deliveredAt: Date.now() }
    });
    await t.commit();
    return true;
  } catch (e) {
    await t.rollback();
    throw e;
  }
}

// 统一发货入口；返回 true=已发 false=幂等已发/忽略
async function handleDelivery(openId, outTradeNo, wxOrderId, productId, quantity) {
  if (!outTradeNo) return { ok: false, retry: true, reason: 'no outTradeNo' };
  const ord = await db.collection('payment_order').where({ outTradeNo: outTradeNo }).limit(1).get();
  const order = (ord.data && ord.data[0]) || null;
  if (!order) return { ok: false, retry: true, reason: 'order not found' };
  if (order.status === 'delivered') return { ok: false, retry: false, reason: 'dup delivered' };
  if (order._openid && openId && order._openid !== openId) return { ok: false, retry: true, reason: 'openid mismatch' };
  if (productId && order.productId && order.productId !== productId) return { ok: false, retry: true, reason: 'product mismatch' };
  const count = (quantity > 0) ? quantity : (order.count || 0);
  const note = '虚拟支付购买 ' + (order.name || '') + ' ' + count + ' 次（订单 ' + outTradeNo + '）';
  await deliver(order._openid, order._id, count, wxOrderId, note);
  console.log('[notify] delivered outTradeNo=' + outTradeNo + ' count=' + count + ' wxOrderId=' + wxOrderId);
  return { ok: true };
}

exports.main = async (event) => {
  console.log('[build] virtualPayNotify BUILD_TAG=' + BUILD_TAG + ' httpMethod=' + String((event && event.httpMethod) || ''));
  // MP 消息推送 URL 接入验证（GET echostr）
  const urlVerify = handleUrlVerify(event);
  if (urlVerify) return urlVerify;
  // 形态A 标记：HTTP 网关/mp URL 直达（需回 XML）；形态B（云函数免鉴权）回 'success'
  const isHttp = !!(event && (event.httpMethod || event.isBase64Encoded !== undefined || (event.body && typeof event.body === 'string')));
  // ── 诊断落库：每一条进来的推送请求都记录（定位「推送没到」vs「到了没发货」），失败不影响主流程 ──
  try {
    const rawBody = (event && event.body != null) ? String(event.body) : (event && typeof event === 'object' ? JSON.stringify(event) : '');
    await db.collection('notify_log').add({
      data: {
        ts: Date.now(),
        method: String((event && event.httpMethod) || ''),
        bodyHead: rawBody.slice(0, 2000),
        env: process.env.TCB_ENV || '',
        source: 'virtualpay'
      }
    });
    console.log('[notify] logged incoming, len=' + rawBody.length);
  } catch (e) { console.log('[notify] notify_log 落库失败(忽略): ' + String((e && e.message) || e).slice(0, 120)); }
  try {
    // ── 取推送内容 ──
    let xml = '';
    let evt = null;
    if (event && event.body != null) {
      let raw = event.body;
      if (typeof raw === 'object') {
        evt = raw;                       // body 已是 JSON 对象
      } else {
        xml = String(raw);
        if (event.isBase64Encoded) xml = Buffer.from(xml, 'base64').toString('utf8');
        if (!/<[a-zA-Z]/.test(xml)) {
          // body 是 JSON 字符串 → 尝试解析
          try { evt = JSON.parse(xml); xml = ''; } catch (e) { /* 保持 xml */ }
        }
      }
    } else if (event && typeof event === 'object') {
      // 云函数免鉴权形态：event 本身就是虚拟支付回调 JSON（或含 XML 的兼容兜底）
      if (event.Event || event.MsgType || event.OutTradeNo) evt = event;
      else if (event.xml) xml = String(event.xml);
      else if (event.bodyStr) {
        const s = String(event.bodyStr);
        if (/<[a-zA-Z]/.test(s)) xml = s; else { try { evt = JSON.parse(s); } catch (e) {} }
      }
    }
    // 都没识别出内容：打日志便于首推后核对结构
    if (!xml && !evt) {
      console.log('[notify] empty/unrecognized event, sample=' + JSON.stringify(event).slice(0, 500));
      return isHttp ? { statusCode: 400, body: '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[empty body]]></ErrMsg></xml>' } : 'fail';
    }
    // 打印完整样本（联调核对字段结构用；上线稳定后可降级）
    console.log('[notify] raw=' + (xml ? xml.slice(0, 800) : JSON.stringify(evt).slice(0, 800)));

    // ── 解析字段（XML / JSON 双路） ──
    let evName = '', outTradeNo = '', openId = '', wxOrderId = '', productId = '', quantity = 0;
    if (xml) {
      evName = xmlTag(xml, 'Event');
      outTradeNo = xmlTag(xml, 'OutTradeNo');
      openId = xmlTag(xml, 'OpenId');
      wxOrderId = xmlTag(xml, 'MchOrderNo') || xmlTag(xml, 'wxOrderId');
      productId = xmlTag(xml, 'ProductId');
      quantity = Number(xmlTag(xml, 'Quantity')) || 0;
    } else if (evt) {
      evName = String(pick(evt, ['Event']) || '');
      outTradeNo = String(pick(evt, ['OutTradeNo', 'out_trade_no', 'order_id']) || '');
      openId = String(pick(evt, ['OpenId', 'openid', 'FromUserName']) || '');
      wxOrderId = jsonWxOrderId(evt);
      const g = jsonGoods(evt);
      productId = g.productId;
      quantity = g.quantity;
    }

    // 非发货事件：回成功（不重试轰炸）；虚拟支付其它 xpay_* 也先收下打日志
    if (evName && evName !== 'xpay_goods_deliver_notify') {
      console.log('[notify] ignore event=' + evName);
      return isHttp ? { statusCode: 200, body: '<xml><ErrCode>0</ErrCode></xml>' } : 'success';
    }

    const r = await handleDelivery(openId, outTradeNo, wxOrderId, productId, quantity);
    if (r.ok) {
      return isHttp ? { statusCode: 200, body: '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>' } : 'success';
    }
    if (!r.retry) {
      // 幂等（已发货）也回 0，平台不重试
      console.log('[notify] idempotent ignore: ' + r.reason + ' outTradeNo=' + outTradeNo);
      return isHttp ? { statusCode: 200, body: '<xml><ErrCode>0</ErrCode></xml>' } : 'success';
    }
    // 业务失败需平台重试
    console.log('[notify] retryable fail: ' + r.reason + ' outTradeNo=' + outTradeNo);
    return isHttp
      ? { statusCode: 200, body: '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[' + r.reason + ']]></ErrMsg></xml>' }
      : 'fail';
  } catch (e) {
    console.error('virtualPayNotify error:', e);
    return isHttp
      ? { statusCode: 500, body: '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[' + String((e && e.message) || 'internal error') + ']]></ErrMsg></xml>' }
      : 'fail';
  }
};
