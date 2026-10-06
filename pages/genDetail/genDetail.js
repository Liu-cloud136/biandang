const cache = require('../../utils/cache');
const clientLog = require('../../utils/clientLog');
const { showServerBusy } = require('../../utils/util');
const { decorateGuide } = require('../../utils/ingredient_group');
const { chooseType: repChooseType, submitReport: repSubmit } = require('../../utils/dishReport');
clientLog.hook();

// 餐别缩写：早餐·菜 → 早·菜
function mealShortOf(raw) {
  if (!raw) return '';
  const parts = String(raw).split('·');
  if (parts.length < 2) return raw;
  return parts[0].slice(0, 1) + '·' + parts[1];
}

Page({
  data: {
    type: '',
    recordId: '',
    items: [],
    loaded: false,
    loading: false,
    // 评价态：菜名 -> good/normal/bad
    ratedMap: {},
    // 评价弹窗
    showRate: false,
    rateName: '',
    // 做法弹层
    showGuide: false,
    guideLoading: false,
    guide: { name: '', ingredients: [], steps: [], review: '', difficulty: '', tips: '' },
    rep: { show: false, dish: '', type: '', text: '' },  // 反馈补充说明（自定义大输入框）
    // 收藏（复用 history/detail）
    favOn: false,
    favLocal: false,
    favCloud: false,
    favCount: 0,
    showFav: false,
    favItem: ''
  },

  onLoad(query) {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    const type = query.type || '';
    const id = query.id || '';
    this.setData({ type, recordId: id });
    this.loadDetail();
  },

  // 反查购物清单真实状态：已在清单中的菜名 → 初始 inList:true（完成态以真实清单为准）
  applyInList(items) {
    if (!Array.isArray(items)) return items;
    const shopping = cache.getShoppingList() || [];
    const names = new Set();
    shopping.forEach(s => { if (s && s.group) names.add(s.group); });
    return items.map(it => {
      if (Array.isArray(it.meals)) {
        return Object.assign({}, it, { meals: it.meals.map(m => Object.assign({}, m, { inList: names.has(m.name), mealShort: mealShortOf(m.meal) })) });
      }
      return Object.assign({}, it, { inList: names.has(it.name) });
    });
  },
  async loadDetail() {
    if (!this.data.recordId) return;
    this.setData({ loading: true });
    // 先即时渲染本地缓存，再后台静默刷新云端
    const cached = cache.getGenDetail(this.data.recordId);
    if (cached && Array.isArray(cached.items)) {
      this.setData({ items: this.applyInList(cached.items), loaded: true });
    }
    try {
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'getGenRecord', id: this.data.recordId } });
      const r = res && res.result;
      if (r && r.code === 200 && r.data && r.data.record) {
        const rec = r.data.record;
        const items = Array.isArray(rec.items) ? rec.items : [];
        this.setData({ items: this.applyInList(items), loaded: true });
        cache.setGenDetail(this.data.recordId, { items });
      } else {
        if (!cached) wx.showToast({ title: (r && r.msg) || '记录不存在', icon: 'none' });
        this.setData({ loaded: true });
      }
    } catch (e) {
      if (!cached) wx.showToast({ title: '加载失败', icon: 'none' });
      clientLog.log('genDetail.load', e);
      this.setData({ loaded: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 单道菜加入购菜清单（按菜分组，后端展开食材）
  async onAddOne(e) {
    const ds = e && e.currentTarget && e.currentTarget.dataset;
    const name = ds && ds.name;
    if (!name) return;
    // 重入保护：避免快速连点导致多次 showLoading 配对异常
    if (this._adding) return;
    this._adding = true;
    wx.showLoading({ title: '加入中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'manageShopping', data: { action: 'add', items: [{ group: name, items: [] }] } });
      const r = res && res.result;
      wx.hideLoading();
      if (r && r.code === 200) {
        // 同步本地购物清单缓存，避免跳到清单页时因 15s 节流/缓存残留看不到新项
        if (r.data && Array.isArray(r.data.items)) cache.setShoppingList(r.data.items);
        // 标记该菜已加入清单（完成态）
        this._markInList(name);
        wx.showToast({ title: '已加入购菜清单', icon: 'success' });
      } else {
        wx.showToast({ title: (r && r.msg) || '加入失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      clientLog.log('genDetail.onAddOne', err);
      wx.showToast({ title: '网络异常', icon: 'none' });
    } finally {
      this._adding = false;
    }
  },
  // 在 items 里把指定菜名标记 inList:true。
  // week 型为 [{label, meals:[{meal,name,inList,_rated}]}]，需深入 meals；
  // fridge/leftover 顶层结构为 [{name, inList}]。两种结构都按 name 深找标记。
  _markInList(name) {
    const items = this.data.items;
    if (!Array.isArray(items)) return;
    const next = items.map(it => {
      // week 型：meals 数组
      if (Array.isArray(it.meals)) {
        return Object.assign({}, it, { meals: it.meals.map(m => m.name === name ? Object.assign({}, m, { inList: true }) : m) });
      }
      // fridge/leftover 顶层结构：name 直接在 item 上
      if (it.name === name) return Object.assign({}, it, { inList: true });
      return it;
    });
    this.setData({ items: next });
  },
  onAddedTip() {
    wx.showToast({ title: '已经在清单里啦', icon: 'none' });
  },

  // ===== 小爱心：点一下记「好吃」(good)，再点取消 =====
  // ===== 小爱心：点开评价弹窗（选 好吃/一般/不合胃口）=====
  onShowRate(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    this.setData({ showRate: true, rateName: name });
  },
  onCloseRate() {
    this.setData({ showRate: false });
  },
  onRatePick(e) {
    const rating = e.currentTarget.dataset.rating;
    const name = this.data.rateName;
    if (!name) return;
    this.setData({ showRate: false });
    // 难吃需二次确认，避免误触（与 history/detail 一致）
    if (rating === 'bad') {
      wx.showModal({
        title: '标记为不好吃？',
        content: '确认将「' + name + '」标记为不好吃？之后将尽量避免再推荐它。',
        confirmText: '确认标记',
        cancelText: '再想想',
        success: (res) => {
          if (res.confirm) this._commitRate(name, rating);
        }
      });
      return;
    }
    this._commitRate(name, rating);
  },
  _commitRate(name, rating) {
    const ratedMap = Object.assign({}, this.data.ratedMap, { [name]: rating });
    this.setData({ ratedMap });
    // 会话内回显：把评价状态写回对应 item（week 嵌套 meals / fridge 顶层 name 两种结构）
    const items = (this.data.items || []).map(it => {
      if (Array.isArray(it.meals)) {
        return Object.assign({}, it, { meals: it.meals.map(m => m.name === name ? Object.assign({}, m, { _rated: rating }) : m) });
      }
      if (it.name === name) return Object.assign({}, it, { _rated: rating });
      return it;
    });
    this.setData({ items });
    try {
      wx.cloud.callFunction({ name: 'rateDish', data: { dish: name, rating } }).catch(() => {});
    } catch (err) { /* 评价失败不影响前端态 */ }
  },

  // ===== 看做法（复用 cache + getCookGuide，扣次提醒同 history/detail）=====
  onCook(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    this.curItem = { dish: name, kind: '', imageUrl: '' };
    const cached = cache.getCookGuide(name);
    if (cached) {
      // 先重置收藏态，避免残留上一道菜的星标（搬 history/detail onCook 缓存命中分支）
      this.setData({ showGuide: true, guideLoading: false, guide: decorateGuide(cached), favLocal: false, favCloud: false, favOn: false, favCount: 0 });
      this.refreshFav();
      return;
    }
    wx.showModal({
      title: '查看做法',
      content: `「${name}」的做法仅首次查看消耗 1 次免费次数，已看过的不重复扣费。是否继续？`,
      confirmText: '继续',
      cancelText: '取消',
      success: (r) => { if (r.confirm) this.openGuide(name); }
    });
  },
  async openGuide(name) {
    // 先重置收藏态，避免「生成中」时残留上一道菜的收藏星标（搬 history/detail openGuide）
    this.setData({ showGuide: true, guideLoading: true, guide: { name, ingredients: [], steps: [], review: '', difficulty: '', tips: '' }, favLocal: false, favCloud: false, favOn: false });
    try {
      const res = await wx.cloud.callFunction({ name: 'getCookGuide', data: { dish: name } });
      const result = res && res.result;
      if (result && result.code === 200) {
        const guide = { name, ingredients: result.data.ingredients || [], steps: result.data.steps || [], review: result.data.review || '', difficulty: result.data.difficulty || '', tips: result.data.tips || '' };
        cache.setCookGuide(name, guide);
        this.setData({ guide: decorateGuide(guide), guideLoading: false });
        this.refreshFav();
      } else if (result && result.code === 403) {
        this.setData({ showGuide: false });
        wx.showToast({ title: result.msg || '免费次数不足，请去主页「领次数」按钮领取。', icon: 'none' });
      } else {
        console.error('[cook] 返回错误：', result && result.code, result && result.msg);
        this.setData({ showGuide: false });
        showServerBusy('没拿到做法');
      }
    } catch (e) {
      console.error('[cook] 调用异常：', e);
      this.setData({ showGuide: false });
      clientLog.log('genDetail.onGetGuide', e);
      showServerBusy();
    }
  },
  onCloseGuide() {
    if (this.data.guideLoading) return; // 生成中禁止关闭（蒙层空白/关闭按钮皆拦截，纯静默）
    this.setData({ showGuide: false, favCount: 0 });
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

  // ===== 收藏（复用 history/detail）=====
  // 刷新当前菜品的收藏状态：本地即时 + 云端列表（本地优先）——复用 history/detail 逻辑
  async refreshFav() {
    const dish = this.curItem && this.curItem.dish;
    const local = !!(dish && cache.isLocalFavorited(dish));
    this.setData({ favLocal: local });
    const cachedCloud = cache.getCloudFavorites();
    if (cachedCloud) {
      const map = {};
      cachedCloud.forEach(f => { map[f.dish] = true; });
      const cloud = !!(dish && map[dish]);
      this.setData({ favCloud: cloud, favOn: local || cloud });
    }
    const favTs = cache.getCloudFavTs() || 0;
    if (!(cachedCloud && Date.now() - favTs < 60000)) {
      try {
        const res = await wx.cloud.callFunction({ name: 'favorite', data: { action: 'list' } });
        if (res && res.result && res.result.code === 200) {
          const list = (res.result.data && res.result.data.list) || [];
          cache.setCloudFavorites(list);
          const map = {};
          list.forEach(f => { map[f.dish] = true; });
          const cloud = !!(dish && map[dish]);
          this.setData({ favCloud: cloud, favOn: local || cloud });
        }
      } catch (e) { /* 云端查询失败不影响本地态 */ }
    }
    this.loadFavCount(dish);
  },
  // 点击星标：打开收藏选择弹层——复用 history/detail 逻辑
  onToggleFav() {
    if (!this.curItem || !this.curItem.dish) return;
    this.setData({ showFav: true, favItem: { dish: this.curItem.dish } });
  },
  // 收藏到本地（免费，即时）——复用 history/detail 逻辑
  onFavLocal() {
    if (!this.curItem || !this.curItem.dish) return;
    const guide = (this.data.guide && this.data.guide.name === this.curItem.dish) ? this.data.guide : null;
    const item = Object.assign({}, this.curItem, { guide });
    const on = cache.toggleLocalFavorite(item);
    let cloud = this.data.favCloud;
    if (!on && cloud) {
      cache.removeCloudFavorite(this.curItem.dish);
      cloud = false;
      wx.cloud.callFunction({ name: 'favorite', data: { action: 'remove', item: { dish: this.curItem.dish } } }).catch(() => {});
    }
    this.setData({ favLocal: on, favOn: on || cloud, favCloud: cloud, showFav: false });
    wx.showToast({ title: on ? '已收藏到本地' : '已取消收藏', icon: 'none' });
    this._refreshMineFavCount();
    wx.cloud.callFunction({ name: 'favorite', data: { action: 'sync', item: { dish: this.curItem.dish, remove: !on } } })
      .then(() => this.loadFavCount(this.curItem.dish))
      .catch(() => this.loadFavCount(this.curItem.dish));
  },
  // 收藏到云端（消耗 1 次免费次数）——复用 history/detail 逻辑
  async onFavCloud() {
    if (!this.curItem || !this.curItem.dish) return;
    if (this._faving) return; // 重入保护：避免连点导致 showLoading 配对异常
    this._faving = true;
    const guide = (this.data.guide && this.data.guide.name === this.curItem.dish) ? this.data.guide : null;
    const item = Object.assign({}, this.curItem, { guide });
    const isAdd = !this.data.favCloud;
    wx.showLoading({ title: isAdd ? '收藏中' : '取消中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'favorite', data: isAdd ? { action: 'add', item } : { action: 'remove', item } });
      const r = res && res.result;
      wx.hideLoading();
      if (r && r.code === 200) {
        const d = r.data || {};
        if (d.added) {
          if (typeof d.remaining === 'number') cache.setFreeCount(d.remaining);
          cache.addCloudFavorite(Object.assign({}, this.curItem, { guide }));
          this.setData({ favCloud: true, favOn: true, showFav: false });
          wx.showToast({ title: '已收藏到云端', icon: 'success' });
          this.loadFavCount(this.curItem.dish);
          this._refreshMineFavCount();
        } else if (d.removed) {
          cache.removeCloudFavorite(this.curItem.dish);
          const localRemoved = cache.removeLocalFavorite(this.curItem.dish);
          this.setData({ favCloud: false, favLocal: false, favOn: false, showFav: false });
          wx.showToast({ title: '已取消收藏', icon: 'none' });
          if (localRemoved) wx.cloud.callFunction({ name: 'favorite', data: { action: 'sync', item: { dish: this.curItem.dish, remove: true } } }).catch(() => {});
          this.loadFavCount(this.curItem.dish);
          this._refreshMineFavCount();
        }
      } else if (r && r.code === 403) {
        wx.showToast({ title: '免费次数不足，请去主页「领次数」按钮领取。', icon: 'none' });
      } else {
        console.error('[fav] 返回错误：', r && r.code, r && r.msg);
        showServerBusy('收藏失败');
      }
    } catch (e) {
      wx.hideLoading();
      console.error('[fav] 调用异常：', e);
      clientLog.log('genDetail.onFavCloud', e);
      showServerBusy('收藏失败');
    } finally {
      this._faving = false;
    }
  },
  onCloseFav() {
    this.setData({ showFav: false });
  },
  loadFavCount(dish) {
    if (!dish) return;
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
  _refreshMineFavCount() {
    const local = cache.getLocalFavorites();
    const cloud = cache.getCloudFavorites() || [];
    const set = new Set(local.map(f => f.dish));
    cloud.forEach(f => set.add(f.dish));
    cache.setFavCount(set.size);
  },

  noop() {}
});
