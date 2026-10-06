const cache = require('../../utils/cache');
const clientLog = require('../../utils/clientLog');
const { decorateGuide } = require('../../utils/ingredient_group');
const { chooseType: repChooseType, submitReport: repSubmit } = require('../../utils/dishReport');
clientLog.hook();

Page({
  data: {
    list: [],
    loading: true,
    showGuide: false,
    guideLoading: false,
    guide: { name: '', ingredients: [], steps: [], review: '', difficulty: '', tips: '' },
    rep: { show: false, dish: '', type: '', text: '' },  // 反馈补充说明（自定义大输入框）
    favCount: null,
    offline: false
  },

  onShow() {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    // 用缓存秒出，避免每次切 tab 整页重建导致图片重新加载
    const local = cache.getLocalFavorites();
    const cachedCloud = cache.getCloudFavorites() || [];
    this.mergeAndShow(local, cachedCloud);
    this.setData({ loading: false });
    // 后台静默刷新云端（数据变了才更新，不变则不 setData）
    this._syncCloud(local);
  },

  _syncCloud(local) {
    // 15s 内且已有云端缓存则跳过，减少无效云函数/数据库请求（缩短窗口，新收藏更快可见）
    const cachedCloud = cache.getCloudFavorites();
    const ts = cache.getCloudFavTs() || 0;
    if (cachedCloud && Date.now() - ts < 15000) return;
    wx.cloud.callFunction({ name: 'favorite', data: { action: 'list' } })
      .then(res => {
        if (res && res.result && res.result.code === 200) {
          const cloud = (res.result.data && res.result.data.list) || [];
          const prev = cache.getCloudFavorites() || [];
          if (JSON.stringify(cloud) !== JSON.stringify(prev)) {
            cache.setCloudFavorites(cloud);
            this.mergeAndShow(local, cloud);
          }
          if (this.data.offline) this.setData({ offline: false }); // 恢复网络，消除离线提示（E12）
        }
      })
      .catch(() => {
        // 离线：保持本地缓存渲染，并显示离线提示（E12）
        clientLog.log('favorites.load', 'list failed/offline');
        if ((this.data.list || []).length) this.setData({ offline: true });
      });
  },

  // 合并去重：本地优先，云端未在本地的补在后面
  mergeAndShow(local, cloud) {
    const cloudSet = {};
    const cloudGuide = {};
    cloud.forEach(f => {
      cloudSet[f.dish] = true;
      // 预存云端非空做法，供本地副本做法为空时兜底
      if (f.guide && (f.guide.ingredients || f.guide.steps)) cloudGuide[f.dish] = f.guide;
    });
    const map = {};
    const out = [];
    local.forEach(f => {
      if (!map[f.dish]) {
        map[f.dish] = true;
        const localGuideOk = f.guide && (f.guide.ingredients || f.guide.steps);
        const guide = localGuideOk ? f.guide : (cloudGuide[f.dish] || null);
        out.push(Object.assign({}, f, { synced: !!cloudSet[f.dish], from: 'local', guide }));
      }
    });
    cloud.forEach(f => {
      if (!map[f.dish]) {
        map[f.dish] = true;
        out.push({
          dish: f.dish, scene: f.scene || '', kind: f.kind || '',
          imageUrl: f.imageUrl || '', guide: f.guide || null,
          ts: f.ts || 0, synced: true, from: 'cloud'
        });
      }
    });
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    this.setData({ list: out });
  },

  async onRemove(e) {
    const { dish, synced } = e.currentTarget.dataset;
    const item = this.data.list.find(f => f.dish === dish) || {};
    wx.showLoading({ title: '移除中' });
    try {
      if (synced) {
        const res = await wx.cloud.callFunction({ name: 'favorite', data: { action: 'remove', item: { dish } } });
        if (!(res && res.result && res.result.code === 200)) throw new Error('cloud');
        cache.removeCloudFavorite(dish);
      }
      cache.removeLocalFavorite(dish);
      // 纯本地收藏：清掉云端 source:'local' 记录，避免该菜全局人数多算 1
      if (item.from === 'local') {
        wx.cloud.callFunction({ name: 'favorite', data: { action: 'sync', item: { dish, remove: true } } }).catch(() => {});
      }
      const c = cache.getFavCount();
      if (c != null) cache.setFavCount(Math.max(0, c - 1));
      wx.hideLoading();
      wx.showToast({ title: '已取消收藏', icon: 'none' });
      this.onShow();
    } catch (err) {
      wx.hideLoading();
      clientLog.log('favorites.onRemove', err);
      wx.showToast({ title: '移除失败', icon: 'none' });
    }
  },

  onOpenGuide(e) {
    const { dish } = e.currentTarget.dataset;
    const item = this.data.list.find(f => f.dish === dish);
    if (!item) return;
    const openGuide = (guide) => {
      this.setData({ showGuide: true, guideLoading: false, guide: decorateGuide(guide), favCount: null });
      // 本地收藏：先补同步到云端（幂等），保证 count 能查到本人在内的记录
      if (item.from === 'local') {
        wx.cloud.callFunction({ name: 'favorite', data: { action: 'sync', item: { dish } } })
          .then(() => this.loadFavCount(dish))
          .catch(() => this.loadFavCount(dish));
      } else {
        this.loadFavCount(dish);
      }
    };
    if (item.guide && (item.guide.ingredients || item.guide.steps)) {
      openGuide(item.guide);
      return;
    }
    const cached = cache.getCookGuide(dish);
    if (cached) {
      openGuide(cached);
      return;
    }
    wx.showToast({ title: '暂无做法内容，请在详情页重新查看', icon: 'none' });
  },

  loadFavCount(dish) {
    const ver = ++this._favVer || (this._favVer = 1);
    wx.cloud.callFunction({ name: 'favorite', data: { action: 'count', item: { dish } } })
      .then(res => {
        if (this._favVer !== ver) return;
        if (res && res.result && res.result.code === 200) {
          this.setData({ favCount: res.result.data.count });
        }
      }).catch(() => {
        if (this._favVer !== ver) return;
        this.setData({ favCount: 0 });
      });
  },

  onCloseGuide() {
    if (this.data.guideLoading) return; // 生成中禁止关闭（蒙层空白/关闭按钮皆拦截，纯静默）
    this.setData({ showGuide: false, favCount: null });
  },

  // 不喜欢/举报（阶段5 ②）：选原因 → 自定义大输入框补说明 → submitDishFeedback → review-web 返工闭环
  async onReportDish(e) {
    const name = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.name) || '';
    if (!name) return;
    const item = await repChooseType();
    if (!item) return;
    this.setData({ rep: { show: true, dish: name, type: item.t, text: '' } });
  },
  onRepNoteInput(e) {
    this.setData({ 'rep.text': e.detail.value });
  },
  onRepNoteCancel() {
    this.setData({ 'rep.show': false });
  },
  async onRepNoteSubmit() {
    const dlg = this.data.rep || {};
    this.setData({ 'rep.show': false });
    const r = await repSubmit(dlg.dish, [dlg.type], dlg.text || '');
    if (!r) return;
    wx.showModal({
      title: r.ok ? '已收到反馈' : '提交失败',
      content: r.ok ? '感谢反馈，我们会复查这道菜并持续优化。' : (r.msg || '请稍后重试'),
      showCancel: false,
      confirmText: '知道了',
    });
  },
  noop() {}
});
