const cache = require('../../utils/cache.js');
const { formatDate, showServerBusy } = require('../../utils/util.js');
const weatherLoc = require('../../utils/location');
const clientLog = require('../../utils/clientLog');
clientLog.hook();

// 读取已缓存的 IP 定位对象（含经纬度/城市/区），供后端注入天气上下文；无则返回空对象。
function getWeatherLoc() {
  try {
    const loc = weatherLoc.getLocationForWeather();
    if (!loc) return {};
    return loc;
  } catch (e) { return {}; }
}

Page({
  data: {
    activeIndex: 2,
    dayOpts: ['3', '5', '7'],
    meals: ['早餐', '午餐', '晚餐'],
    result: [],
    loading: false,
    loadingText: '',
    msg: '',
    records: [],
    showCostConfirm: false,
    costDays: 7
  },

  onLoad() {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    this.loadRecords();
  },
  onShow() {
    this.loadRecords();
  },

  onDay(e) {
    this.setData({ activeIndex: Number(e.currentTarget.dataset.idx) });
  },

  async loadRecords() {
    const key = 'week';
    // 先即时渲染本地缓存，再后台静默刷新云端
    const cached = cache.getGenRecords(key);
    if (Array.isArray(cached)) {
      cached.forEach(r => { if (!r._hm) r._hm = formatDate(r.createdAt); });
      this.setData({ records: cached });
    }
    try {
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'listGenRecords', type: key } });
      const list = (res && res.result && res.result.data && res.result.data.records) || [];
      list.forEach(r => { r._hm = formatDate(r.createdAt); });
      this.setData({ records: list });
      cache.setGenRecords(key, list);
    } catch (e) {
      if (!cached) this.setData({ records: [] });
    }
  },

  onWeekSubmit() {
    const days = Number(this.data.dayOpts[this.data.activeIndex]) || 7;
    this.setData({ showCostConfirm: true, costDays: days });
  },
  onCostCancel() {
    this.setData({ showCostConfirm: false });
  },
  async onCostConfirm() {
    this.setData({ showCostConfirm: false, loading: true, loadingText: '正在为你安排这一周…', msg: '', result: [] });
    try {
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: Object.assign({ action: 'weekPlan', days: Number(this.data.dayOpts[this.data.activeIndex]), meals: this.data.meals }, getWeatherLoc()) });
      const r = res && res.result;
      if (r && r.code === 200) {
        // 生成成功仅刷新历史记录，不展开显示、不跳转，由用户自行点历史查看
        this.setData({ result: [], msg: '' });
        this.loadRecords();
        if (typeof r.data.remainingFreeCount === 'number') cache.setFreeCount(r.data.remainingFreeCount);
        wx.showToast({ title: '已安排好，去历史记录查看', icon: 'none' });
      } else if (r && r.code === 403) {
        wx.showModal({ title: '免费次数不足', content: '免费次数不足，请去主页「领次数」按钮领取。', showCancel: false });
      } else {
        // 430 限流与其余服务侧错误统一文案（服务异常）；码/文案进 console + clientLog 便于排障
        console.error('[week.onCostConfirm] 返回错误：', r && r.code, r && r.msg);
        clientLog.log('week.onCostConfirm', 'code=' + (r && r.code) + ' msg=' + ((r && r.msg) || ''));
        showServerBusy();
      }
    } catch (e) {
      console.error('[week.onCostConfirm] callFunction reject:', e);
      clientLog.log('week.onCostConfirm', e);
      showServerBusy();
    } finally {
      this.setData({ loading: false });
    }
  },

  onOpenRecord(e) {
    const id = e.currentTarget.dataset.id;
    const type = e.currentTarget.dataset.type;
    wx.navigateTo({ url: '/pages/genDetail/genDetail?type=' + type + '&id=' + id });
  },

  // 长按删除单条生成历史（周表）
  onDeleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除记录',
      content: '确定删除这条历史记录吗？',
      confirmText: '删除',
      confirmColor: '#FF4D4F',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const r = await wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'deleteGenRecord', id } });
          const ret = r && r.result;
          if (ret && ret.code === 200) {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.loadRecords();
          } else {
            wx.showToast({ title: (ret && ret.msg) || '删除失败', icon: 'none' });
          }
        } catch (err) {
          clientLog.log('week.onDelete', err);
          wx.showToast({ title: '网络异常', icon: 'none' });
        }
      }
    });
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shoplist/shoplist' });
  },
  noop() {}
});
