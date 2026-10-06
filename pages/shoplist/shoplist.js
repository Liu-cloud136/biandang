const cache = require('../../utils/cache');
const clientLog = require('../../utils/clientLog');
clientLog.hook();

// 去外卖平台（AppID 统一维护在 utils/config.js 的 TAKEOUT_PLATFORMS）
const { TAKEOUT_PLATFORMS } = require('../../utils/config');

function call(action, data) {
  return wx.cloud.callFunction({ name: 'manageShopping', data: Object.assign({ action }, data) });
}

Page({
  data: {
    items: [],          // [{group,items,checked,from,ts,qty,remark} 或 {text,checked,from,ts,qty,remark}]
    pending: [],        // 待买（渲染用，带 _i 真实索引）
    bought: [],         // 已购（渲染用，带 _i 真实索引）
    loading: true,
    total: 0,
    boughtCount: 0,
    showDetail: false,
    detailName: '',
    detailItems: [],
    showTakeout: false,
    takeoutPlatforms: TAKEOUT_PLATFORMS
  },

  // 统一写入 items 并派生 pending/bought（待买优先、已购沉底折叠）
  setItems(arr) {
    const withIdx = (it, i) => Object.assign({}, it, { _i: i });
    const pending = [];
    const bought = [];
    (arr || []).forEach((it, i) => {
      if (it.checked) bought.push(withIdx(it, i));
      else pending.push(withIdx(it, i));
    });
    this.setData({ items: arr, pending, bought });
    this.refreshCount();
  },

  // 仅重排视图（items 不变时，如折叠切换）
  renderItems() {
    const arr = this.data.items;
    const withIdx = (it, i) => Object.assign({}, it, { _i: i });
    const pending = [];
    const bought = [];
    (arr || []).forEach((it, i) => {
      if (it.checked) bought.push(withIdx(it, i));
      else pending.push(withIdx(it, i));
    });
    this.setData({ pending, bought });
  },

  onShow() {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    // 本地秒显
    const local = cache.getShoppingList();
    if (Array.isArray(local)) {
      this.setItems(local);
      this.setData({ loading: false });
    }
    this._syncCloud();
  },

  onPullDownRefresh() {
    Promise.resolve(this._syncCloud(true)).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  async _syncCloud(force) {
    const ts = cache.getShoppingTs() || 0;
    if (!force && Date.now() - ts < 15000 && this.data.items.length) return;
    try {
      const res = await call('get');
      if (res && res.result && res.result.code === 200) {
        const items = res.result.data.items || [];
        cache.setShoppingList(items);
        this.setItems(items);
        this.setData({ loading: false });
      }
    } catch (e) { /* 静默 */ }
  },

  refreshCount() {
    const items = this.data.items;
    this.setData({ total: items.length, boughtCount: items.filter(x => x.checked).length });
  },

  async onToggle(e) {
    const idx = e.currentTarget.dataset.idx;
    const items = this.data.items.slice();
    const target = Object.assign({}, items[idx], { checked: !items[idx].checked });
    const newItems = items.slice();
    newItems[idx] = target;
    // 乐观更新
    cache.setShoppingList(newItems);
    this.setItems(newItems);
    try {
      const res = await call('toggle', { index: idx });
      const r = res && res.result;
      if (r && r.code === 200) {
        cache.setShoppingList(r.data.items);
        this.setItems(r.data.items);
      }
    } catch (e) { /* 保留乐观态 */ }
  },

  async onRemove(e) {
    const idx = e.currentTarget.dataset.idx;
    const it = this.data.items[idx] || {};
    const label = it.group || it.text || '该项';
    wx.showModal({
      title: '删除',
      content: '从清单移除「' + label + '」？',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '删除中' });
        try {
          const res = await call('remove', { index: idx });
          const rr = res && res.result;
          if (rr && rr.code === 200) {
            cache.setShoppingList(rr.data.items);
            this.setItems(rr.data.items);
          } else {
            wx.showToast({ title: (rr && rr.msg) || '删除失败', icon: 'none' });
          }
        } catch (e) { clientLog.log('shoplist.onRemove', e); wx.showToast({ title: '删除失败', icon: 'none' }); }
        finally { wx.hideLoading(); }
      }
    });
  },

  onClearBought() {
    const boughtIdx = (this.data.bought || []).map(x => x._i).filter(i => typeof i === 'number');
    if (!boughtIdx.length) { wx.showToast({ title: '没有已购项', icon: 'none' }); return; }
    wx.showLoading({ title: '清除中' });
    // 从大到小逐个 remove，避免下标漂移；仅删已购项，不动待买项，且不会丢失菜品结构
    const desc = boughtIdx.slice().sort((a, b) => b - a);
    this._removeMany(desc).then(() => {
      wx.hideLoading();
      wx.showToast({ title: '已清除已购', icon: 'none' });
    }).catch(() => {
      wx.hideLoading();
      // 失败则重新拉取云端真实状态，保证界面与云端一致
      this._syncCloud(true);
      wx.showToast({ title: '清除失败，已恢复', icon: 'none' });
    });
  },
  // 依次按云端下标 remove（从大到小），返回 Promise，最终用云端余量刷新
  async _removeMany(idxs) {
    let last = null;
    for (const i of idxs) {
      const res = await call('remove', { index: i });
      const r = res && res.result;
      if (!r || r.code !== 200) throw new Error('remove failed');
      last = r.data.items;
    }
    if (last) {
      cache.setShoppingList(last);
      this.setItems(last);
    }
  },

  onClearAll() {
    if (!this.data.items.length) return;
    wx.showModal({
      title: '清空清单',
      content: '确定清空全部购菜清单？',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '清空中' });
        try {
          const res = await call('clearAll');
          const rr = res && res.result;
          if (rr && rr.code === 200) {
            cache.setShoppingList([]);
            this.setItems([]);
          } else {
            wx.showToast({ title: (rr && rr.msg) || '清空失败', icon: 'none' });
          }
        } catch (e) { clientLog.log('shoplist.onClearBought', e); wx.showToast({ title: '清空失败', icon: 'none' }); }
        finally { wx.hideLoading(); }
      }
    });
  },

  // 复制当前菜的具体食材清单（弹窗内 detailItems）
  onCopyList() {
    const items = this.data.detailItems || [];
    if (!items.length) { wx.showToast({ title: '暂无食材可复制', icon: 'none' }); return; }
    const text = items.join('、');
    const doCopy = () => wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制食材清单', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请先同意隐私授权', icon: 'none' })
    });
    // 基础库 >= 2.32.3：setClipboardData 受隐私协议约束，需先确保授权
    if (typeof wx.requirePrivacyAuthorize === 'function') {
      wx.requirePrivacyAuthorize({ success: doCopy, fail: doCopy });
    } else {
      doCopy();
    }
  },

  // 点菜名查看该菜的食材详情（自绘弹窗）
  onOpenDetail(e) {
    const idx = e.currentTarget.dataset.idx;
    const item = this.data.items[idx];
    if (!item || !item.group) return;
    this.setData({
      showDetail: true,
      detailName: item.group,
      detailItems: Array.isArray(item.items) ? item.items : []
    });
  },

  closeDetail() {
    this.setData({ showDetail: false });
  },

  // 去外卖：自绘平台选择弹窗
  onShowTakeout() {
    this.setData({ showTakeout: true });
  },

  closeTakeout() {
    this.setData({ showTakeout: false });
  },

  onPickPlatform(e) {
    const { appid, name } = e.currentTarget.dataset;
    if (!appid) return;
    const that = this;
    wx.navigateToMiniProgram({
      appId: appid,
      fail(err) {
        // 用户点微信系统确认框的「取消」属正常操作，不提示；其余失败才提示
        const msg = err && err.errMsg ? err.errMsg : '';
        if (msg.indexOf('cancel') >= 0) return;
        wx.showToast({ title: '跳转' + (name || '该平台') + '失败', icon: 'none' });
        console.warn('[takeout] navigateToMiniProgram fail', appid, err);
      }
    });
    // 微信基础库 >= 2.3.0 会自行弹系统确认框；用户确认后跳转，关闭弹窗
    that.setData({ showTakeout: false });
  },

  goHistory() {
    wx.switchTab({ url: '/pages/history/history' });
  },

  noop() {}
});
