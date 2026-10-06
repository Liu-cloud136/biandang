// 次数中心 —— 虚拟支付「次数包」购买页（P0：仅 Android 拉起支付，iOS 显示提示）
// 流程：onShow 拉余额(getDailyStats)+套餐(payGoodsList) → 点购买：
//   wx.login 拿 code → 云函数 virtualPayCreateOrder({productId,code}) → 返回 signData/paySig/signature/mode
//   → wx.requestVirtualPayment(payData) 拉起微信虚拟支付 → success 仅刷新本地，到账以余额为准。
// 平台/版本：iOS 本期不展示支付入口（提示用安卓）；Android 直接走 wx.requestVirtualPayment。
const clientLog = require('../../utils/clientLog');
clientLog.hook();

// 套餐缓存节流（套餐为低频静态数据，避免每次进页都重新拉云函数）：
// 内存 + 本地双写；60s 内重复进入直接秒开缓存，超时才后台刷新一次。
const GOODS_TTL = 60 * 1000;
let _goodsCache = null; // { terminal, ts, goods }

function lsGet(k) {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return undefined;
    if (wx.getStorageInfoSync) {
      const info = wx.getStorageInfoSync();
      if (info && Array.isArray(info.keys) && !info.keys.includes(k)) return undefined;
    }
    return wx.getStorageSync(k);
  } catch (e) { return undefined; }
}
function lsSet(k, v) { try { if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(k, v); } catch (e) {} }

function readGoodsCache(terminal) {
  if (_goodsCache && _goodsCache.terminal === terminal && Array.isArray(_goodsCache.goods)) return _goodsCache;
  const m = lsGet('bd_pay_goods_' + terminal);
  if (m && m.terminal === terminal && Array.isArray(m.goods)) {
    _goodsCache = m;
    return m;
  }
  return null;
}
function writeGoodsCache(terminal, goods) {
  const m = { terminal, ts: Date.now(), goods };
  _goodsCache = m;
  lsSet('bd_pay_goods_' + terminal, m);
}

Page({
  data: {
    loading: true,
    freeCountText: '-',
    goods: [],
    buyingId: '',     // 正在支付的商品ID（防连点）
    isIos: false,
    terminal: 'android' // 设备端：android 拉真支付；ios 提示（首期方案 A）
  },

  onLoad() {
    if (getApp().enterGuard()) return;
    // 平台判定：iOS 不开放真支付（合规/费率/需 IAP 配置，首期方案 A）。
    // 用新 API wx.getDeviceInfo（老基础库回退 wx.getSystemInfoSync），避免 deprecation 警告刷屏。
    try {
      const dev = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      const platform = String(dev.platform || '').toLowerCase();
      const ios = platform.indexOf('ios') === 0;
      const terminal = ios ? 'ios' : 'android';
      this.setData({ isIos: ios, terminal });
    } catch (e) {}
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    await getApp().ensureLogin();
    this.loadBalance();
    this.loadGoods();
  },

  // 当前剩余次数（免费池 = baseFree + bonusFree；购买次数并入 bonusFree 后自然反映）
  // 返回数字（供支付后轮询判断到账）；失败返回 null
  async loadBalance() {
    try {
      const r = await wx.cloud.callFunction({ name: 'getDailyStats' });
      const d = r && r.result && r.result.code === 200 && r.result.data;
      if (d) {
        const n = Number(d.freeCount) || 0;
        this.setData({ freeCountText: String(n) });
        return n;
      }
      return null;
    } catch (e) {
      clientLog.log('paycenter.loadBalance', e);
      this.setData({ freeCountText: '-' });
      return null;
    }
  },

  // 套餐列表（payGoodsList 登录态返回明文商品，price=特惠价分）
  // 缓存策略：60s 内有缓存 → 秒开不请求；否则先展示缓存再后台刷新（首次才转圈）。
  async loadGoods() {
    const terminal = this.data.terminal || 'android';
    const cached = readGoodsCache(terminal);
    const fresh = cached && (Date.now() - cached.ts) < GOODS_TTL;
    if (cached && Array.isArray(cached.goods) && cached.goods.length) {
      this.setData({ goods: cached.goods, loading: false }); // 缓存秒开
      if (fresh) return;                                      // 未过期：不再请求
    } else {
      this.setData({ loading: true });                        // 无缓存：首次转圈
    }
    try {
      const r = await wx.cloud.callFunction({ name: 'payGoodsList', data: { terminal } });
      const list = (r && r.result && r.result.code === 200 && r.result.data && r.result.data.list) || [];
      const goods = list.map(g => ({
        productId: g.productId,
        name: g.name,
        count: g.count,
        priceText: ((g.price || 0) / 100).toFixed(2),
        origPriceText: ((g.origPrice || 0) / 100).toFixed(2),
        origPrice: g.origPrice || 0
      }));
      writeGoodsCache(terminal, goods);
      this.setData({ goods });
    } catch (e) {
      clientLog.log('paycenter.loadGoods', e);
    } finally {
      this.setData({ loading: false });
    }
  },

  // 分 → 元展示（WXML 内不能算小数，这里在 JS 里算好）
  fenToYuan(fen) {
    return ((fen || 0) / 100).toFixed(2);
  },

  onBuy(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.buyingId) return;
    if (this.data.isIos) {
      wx.showModal({
        title: '暂不支持 iOS 支付',
        content: '苹果 iOS 端购买能力开发中，请先用安卓设备购买次数包，或等待后续开放。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }
    // 基础库能力检查
    if (!wx.requestVirtualPayment) {
      wx.showModal({
        title: '微信版本过低',
        content: '请将微信升级到最新版本后重试。',
        showCancel: false
      });
      return;
    }
    this.doBuy(id);
  },

  // 下单 + 拉起支付
  async doBuy(productId) {
    this.setData({ buyingId: productId });
    wx.showLoading({ title: '下单中', mask: true });
    try {
      // 0) 记录支付前余额作为到账基准
      const before = await this.loadBalance();
      // 1) wx.login 拿 code（下单签名需 sessionKey，云函数用 code 换）
      const code = await new Promise((resolve, reject) => {
        wx.login({
          success: r => (r && r.code ? resolve(r.code) : reject(new Error('wx.login 失败'))),
          fail: reject
        });
      });
      // 2) 服务端下单：返回 { signData, paySig, signature, mode, outTradeNo }
      const res = await wx.cloud.callFunction({
        name: 'virtualPayCreateOrder',
        data: { productId, code }
      });
      wx.hideLoading();
      const r = res && res.result;
      if (!r || r.code !== 200) {
        clientLog.log('paycenter.doBuy', 'createOrder code=' + (r && r.code) + ' msg=' + ((r && r.msg) || ''));
        this.setData({ buyingId: '' });
        wx.showModal({
          title: '下单失败',
          content: (r && r.msg) || '请稍后重试',
          showCancel: false
        });
        return;
      }
      const pd = r.data;
      // 3) 拉起微信虚拟支付（signData 服务端生成，前端原样透传，勿二次 JSON.stringify）
      await new Promise((resolve, reject) => {
        wx.requestVirtualPayment({
          signData: pd.signData,
          paySig: pd.paySig,
          signature: pd.signature,
          mode: pd.mode || 'short_series_goods',
          success: resolve,
          fail: reject
        });
      });
      // 4) 支付成功：发货由平台推送异步完成，轮询余额直至到账（最长约 12s）
      //    到账基准：下单前余额 before；推送发货通常 1~3s，微信客户端有时更慢
      let arrived = false;
      const maxTry = 8;
      for (let i = 0; i < maxTry; i++) {
        await new Promise(ok => setTimeout(ok, 1500));
        const cur = await this.loadBalance();
        if (cur !== null && before !== null && cur > before) { arrived = true; break; }
        if (cur === null) break; // 接口异常：不再空等，提示稍后刷新
      }
      this.setData({ buyingId: '' });
      wx.showModal({
        title: '支付成功',
        content: arrived
          ? '次数已到账，回首页点「剩余次数」可查看明细。'
          : '支付成功，次数将在几秒内到账，可下拉刷新查看。',
        showCancel: false,
        confirmText: '知道了'
      });
      this.loadBalance();
    } catch (err) {
      wx.hideLoading();
      const msg = (err && err.errMsg) || (err && err.message) || '';
      const isCancel = /cancel/i.test(msg);
      this.setData({ buyingId: '' });
      if (isCancel) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        clientLog.log('paycenter.doBuy', msg);
        wx.showModal({
          title: '支付失败',
          content: /下单失败|登录态/.test(msg) ? msg : '未完成支付，可稍后重试',
          showCancel: false
        });
      }
    }
  }
});
