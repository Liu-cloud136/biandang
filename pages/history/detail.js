const { formatDate, showServerBusy } = require('../../utils/util');
const cache = require('../../utils/cache');
const { drinkShowCook } = require('../../utils/drinks');
const { sceneRank } = require('../../utils/scene');
const clientLog = require('../../utils/clientLog');
const { decorateGuide } = require('../../utils/ingredient_group');
const { chooseType: repChooseType, submitReport: repSubmit } = require('../../utils/dishReport');
clientLog.hook();

// 去外卖平台（AppID 统一维护在 utils/config.js 的 TAKEOUT_PLATFORMS）
const { TAKEOUT_PLATFORMS } = require('../../utils/config');

// 兼容旧版（扁平/含 items）与新版（含 dishes/staples/drinks）
function normalizeGroups(recs) {
  if (!Array.isArray(recs) || !recs.length) return [];
  if (recs[0].dishes || recs[0].staples) {
    return recs.map(g => ({
      scene: g.scene || '推荐',
      dishes: g.dishes || [],
      staples: g.staples || [],
      drinks: g.drinks || []
    }));
  }
  if (recs[0].items) return recs;
  return [{ scene: '推荐', dishes: recs, staples: [], drinks: [] }];
}



Page({
  data: {
    date: '',
    groups: [],
    selected: [],
    empty: false,
    showGuide: false,
    guideLoading: false,
    guide: { name: '', ingredients: [], steps: [], review: '', difficulty: '', tips: '' },
    rep: { show: false, dish: '', type: '', text: '' },  // 反馈补充说明（自定义大输入框）
    // 收藏状态（本地 + 云端结合，本地优先）
    favOn: false,
    favLocal: false,
    favCount: null,
    favCloud: false,
    showFav: false,
    favItem: {},
    // B2 评价弹窗
    showRate: false,
    rateCtx: null,
    rateLoading: false,
    showTakeout: false,
    takeoutPlatforms: TAKEOUT_PLATFORMS
  },

  onLoad(o) {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    if (o && o.id) { this._histId = o.id; this.load(o.id); }
  },

  async load(id) {
    // 本地优先：已缓存这条详情则直接渲染，不再弹「加载中」（返回再进入也即时显示）
    const local = cache.getHistoryDetail(id);
    if (local) {
      this.applyDetail(local);
      return;
    }
    wx.showLoading({ title: '加载中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getHistoryDetail', data: { id } });
      if (res.result && res.result.code === 200) {
        cache.setHistoryDetail(id, res.result.data);
        wx.hideLoading();
        this.applyDetail(res.result.data);
      } else {
        wx.hideLoading();
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      clientLog.log('detail.load', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  // 把一条完整详情数据转换为页面展示结构并渲染
  applyDetail(d) {
    const selRaw = d.selected;
    const pickedList = Array.isArray(selRaw)
      ? selRaw
      : (selRaw && typeof selRaw === 'object' ? [selRaw] : []);
    // 仅显示所选菜品：先按用餐时间排序，再过滤掉未选中的，并去掉没有选中项的场景
    const groups = normalizeGroups(d.recommendations)
      .slice()
      .sort((a, b) => sceneRank(a.scene) - sceneRank(b.scene))
      .map(g => {
        const isSnack = g.scene === '小吃';
        const isTea = g.scene === '下午茶';
        // 该场景下用户选中的菜品/主食/配饮名（配饮选中记录在 p.drink 字段，见 index.js _getPicks）
        // 兼容旧版记录（selected 项可能无 scene 字段）：无 scene 视为匹配当前场景，与 history.js 列表卡片一致
        const pickedInScene = pickedList.filter(p => !p || !p.scene || p.scene === g.scene);
        const dishNames = pickedInScene.map(p => p.name).filter(Boolean);
        const stapleNames = pickedInScene.map(p => p.staple).filter(Boolean);
        // 是否为「带配饮选中」的新版记录：有 drink 字段才启用配饮过滤；旧版无该字段则保留整组（兼容历史数据）
        const hasDrinkField = pickedInScene.some(p => p && 'drink' in p);
        const drinkNames = pickedInScene.map(p => p.drink).filter(Boolean);

        const dishes = (g.dishes || [])
          .filter(it => dishNames.includes(it.name) || it.isTry)
          .map(it => {
            const localImg = cache.getLocalImage(it.imageUrl);
            if (!localImg) cache.ensureImageCached(it.imageUrl); // 首次：用云端，后台转存本地供下次秒显
            return { ...it, kind: isSnack ? '小吃' : isTea ? '糕点' : '菜', showCook: true, cat: it.cat || '', localImg: localImg || '' };
          });
        const staples = (g.staples || [])
          .filter(it => stapleNames.includes(it.name) || it.isTry)
          .map(it => {
            const localImg = cache.getLocalImage(it.imageUrl);
            if (!localImg) cache.ensureImageCached(it.imageUrl);
            return {
              ...it,
              kind: isSnack ? '饮料' : isTea ? '饮品' : '主食',
              cat: it.cat || '',
              localImg: localImg || '',
              // 「看做法」显隐：所有菜品/主食/配饮均展示做法（隐藏仅限 HIDDEN_DRINKS 所列配饮）
              showCook: true
            };
          });
        // 配饮：只显示用户选中的（drinkNames）；旧版无 drink 字段记录保留整组（兼容）。
        // 仅 HIDDEN_DRINKS（可乐/雪碧/咖啡/啤酒/气泡水/苏打水/豆浆/酸奶/奶茶）隐藏做法，其余配饮均显示
        const drinks = (g.drinks || [])
          .filter(it => !hasDrinkField || drinkNames.includes(it.name) || it.isTry)
          .map(it => {
            const localImg = cache.getLocalImage(it.imageUrl);
            if (!localImg) cache.ensureImageCached(it.imageUrl);
            return { ...it, kind: '饮料', showCook: drinkShowCook(it.name), _isDrink: true, cat: it.cat || '', localImg: localImg || '' };
          });
        // 小吃/下午茶：主食位即配饮，与独立配饮合并去重，避免两个「配饮」
        let items;
        if (isSnack || isTea) {
          const seen = new Set();
          const merged = staples.concat(drinks);
          items = dishes.concat(merged.filter(it => { const k = it && it.name; if (seen.has(k)) return false; seen.add(k); return true; }));
        } else {
          items = dishes.concat(staples).concat(drinks);
        }
        return { scene: g.scene, items: items };
      })
      .filter(g => g.items.length);
    this.setData({
      date: formatDate(d.timestamp),
      groups,
      selected: pickedList,
      empty: groups.length === 0
    });
    // 反查购物清单真实状态：已在清单中的菜名 → 初始 inList:true（完成态以真实清单为准）
    this._refreshInList();
  },
  // 按真实购物清单刷新本页所有小按钮的 inList 完成态（进入页面 / 批量导入后均调用）
  _refreshInList() {
    const shopping = cache.getShoppingList() || [];
    const inListNames = new Set();
    shopping.forEach(s => { if (s && s.group) inListNames.add(s.group); });
    const groups = this.data.groups.map(g => ({
      scene: g.scene,
      items: g.items.map(it => ({ ...it, inList: inListNames.has(it.name) }))
    }));
    this.setData({ groups });
  },

  // 点击「看做法」：若已生成过则直接展示；否则提示将消耗 1 次免费次数，确认后再生成
  onCook(e) {
    const { si, name } = e.currentTarget.dataset;
    const group = this.data.groups[si];
    if (!group) return;
    let item = (group.items || []).find(x => x.name === name) || null;
    if (!item) return;
    const nm = item.name;
    // 记录当前菜品上下文，供收藏使用（scene/kind/imageUrl 来自卡片）
    this.curItem = { dish: nm, scene: group.scene, kind: item.kind, imageUrl: item.imageUrl };

    // 已生成过（本地按菜名缓存）：直接展示，不再扣次（返回再进入也复用）
    const cached = cache.getCookGuide(nm);
    if (cached) {
      this.setData({ showGuide: true, guideLoading: false, guide: decorateGuide(cached), favLocal: false, favCloud: false, favOn: false, favCount: null });
      this.refreshFav();
      this.loadFavCount(nm);
      return;
    }

    wx.showModal({
      title: '查看做法',
      content: `「${nm}」的做法仅首次查看消耗 1 次免费次数，已看过的不重复扣费。是否继续？`,
      confirmText: '继续',
      cancelText: '取消',
      success: (r) => {
        if (r.confirm) this.openGuide(nm);
      }
    });
  },

  async openGuide(name) {
    this.setData({ showGuide: true, guideLoading: true, guide: { name, ingredients: [], steps: [], review: '', difficulty: '', tips: '' }, favLocal: false, favCloud: false, favOn: false });
    try {
      const res = await wx.cloud.callFunction({ name: 'getCookGuide', data: { dish: name } });
      const result = res && res.result;
      if (result && result.code === 200) {
        const guide = { name, ingredients: result.data.ingredients || [], steps: result.data.steps || [], review: result.data.review || '', difficulty: result.data.difficulty || '', tips: result.data.tips || '' };
        cache.setCookGuide(name, guide);
        // 若该菜已本地收藏，把最新做法同步进收藏（避免清理缓存后做法丢失）
        if (cache.isLocalFavorited(name)) cache.updateLocalFavoriteGuide(name, guide);
        this.setData({ guide: decorateGuide(guide), guideLoading: false });
        this.refreshFav();
        this.loadFavCount(name);
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
      clientLog.log('detail.onGetGuide', e);
      showServerBusy();
    }
  },

  // 刷新当前菜品的收藏状态：本地即时 + 云端列表（本地优先）
  async refreshFav() {
    const dish = this.curItem && this.curItem.dish;
    const local = !!(dish && cache.isLocalFavorited(dish));
    this.setData({ favLocal: local });
    // 先用缓存的云端收藏瞬时判定，避免星标先错再更正
    const cachedCloud = cache.getCloudFavorites();
    if (cachedCloud) {
      const map = {};
      cachedCloud.forEach(f => { map[f.dish] = true; });
      const cloud = !!(dish && map[dish]);
      this.setData({ favCloud: cloud, favOn: local || cloud });
    }
    // 60s 内且已有云端缓存则跳过核对，减少无效请求
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
  },

  // 点击星标：打开收藏选择弹层
  onToggleFav() {
    if (!this.curItem || !this.curItem.dish) return;
    this.setData({ showFav: true, favItem: { dish: this.curItem.dish } });
  },

  // 收藏到本地（免费，即时）；一并存当前做法内容，便于列表页直接查看
  onFavLocal() {
    if (!this.curItem || !this.curItem.dish) return;
    const guide = (this.data.guide && this.data.guide.name === this.curItem.dish) ? this.data.guide : null;
    const item = Object.assign({}, this.curItem, { guide });
    const on = cache.toggleLocalFavorite(item);
    let cloud = this.data.favCloud;
    // 取消本地时也取消云端
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

  // 收藏到云端（消耗 1 次免费次数）；已云端收藏则取消（免费，调 remove）
  async onFavCloud() {
    if (!this.curItem || !this.curItem.dish) return;
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
          // 同步本地云端收藏缓存，使「我的」与收藏列表即时正确
          cache.addCloudFavorite(Object.assign({}, this.curItem, { guide }));
          this.setData({ favCloud: true, favOn: true, showFav: false });
          wx.showToast({ title: '已收藏到云端', icon: 'success' });
          this.loadFavCount(this.curItem.dish);
          this._refreshMineFavCount();
        } else if (d.removed) {
          cache.removeCloudFavorite(this.curItem.dish);
          // 同步取消本地收藏
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
      clientLog.log('detail.onFavCloud', e);
      showServerBusy('收藏失败');
    }
  },

  onCloseFav() {
    this.setData({ showFav: false });
  },

  _refreshMineFavCount() {
    const local = cache.getLocalFavorites();
    const cloud = cache.getCloudFavorites() || [];
    const set = new Set(local.map(f => f.dish));
    cloud.forEach(f => set.add(f.dish));
    cache.setFavCount(set.size);
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

  // 单菜加入购菜清单：仅当前这道菜（带食材，缺食材时云端自动 AI 展开）
  async onAddDish(e) {
    const { si, name } = e.currentTarget.dataset;
    const group = this.data.groups[si];
    if (!group) return;
    const item = (group.items || []).find(x => x.name === name) || null;
    if (!item) return;
    wx.showLoading({ title: '加入中' });
    try {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients.filter(Boolean) : [];
      const res = await wx.cloud.callFunction({
        name: 'manageShopping',
        data: { action: 'add', items: [{ group: name, items: ingredients, from: 'history' }] }
      });
      const r = res && res.result;
      wx.hideLoading();
      if (r && r.code === 200) {
        if (r.data && Array.isArray(r.data.items)) cache.setShoppingList(r.data.items);
        const added = r.data.added || 0;
        // 标记该菜已加入清单（完成态）
        const groups = this.data.groups.slice();
        const items = groups[si].items.slice();
        const idx = items.findIndex(x => x.name === name);
        if (idx >= 0) items[idx] = Object.assign({}, items[idx], { inList: true });
        groups[si] = Object.assign({}, groups[si], { items });
        this.setData({ groups });
        wx.showToast({ title: added > 0 ? '已加入购菜清单' : '已在清单中', icon: 'none' });
      } else {
        wx.showToast({ title: (r && r.msg) || '加入失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      clientLog.log('detail.onAddDish', err);
      wx.showToast({ title: '加入失败', icon: 'none' });
    }
  },
  onAddedTip() {
    wx.showToast({ title: '已经在清单里啦', icon: 'none' });
  },

  // 加入购菜清单：导入本条历史所选菜/主食/配饮
  async onAddToList() {
    if (!this._histId) { wx.showToast({ title: '记录ID缺失', icon: 'none' }); return; }
    wx.showLoading({ title: '导入中' });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageShopping',
        data: { action: 'importFromHistory', historyId: this._histId }
      });
      const r = res && res.result;
      wx.hideLoading();
      if (r && r.code === 200) {
        // 同步本地购物清单缓存，进入清单页即可见新导入项
        if (r.data && Array.isArray(r.data.items)) cache.setShoppingList(r.data.items);
        // 立即按真实清单刷新本页小按钮完成态（批量导入后无需重进页面即可置灰）
        this._refreshInList();
        const added = r.data.added || 0;
        const dup = r.data.dup || 0;
        let msg = added > 0 ? `已加入 ${added} 项` : '已在清单中';
        if (dup > 0 && added === 0) msg = '该决定已在清单中';
        wx.showModal({
          title: '已加入购菜清单',
          content: msg + '，去清单页查看或继续补充？',
          confirmText: '去清单',
          cancelText: '留在这是',
          success: (m) => { if (m.confirm) wx.navigateTo({ url: '/pages/shoplist/shoplist' }); }
        });
      } else if (r && r.code === 400) {
        wx.showToast({ title: r.msg || '没有可导入的菜品', icon: 'none' });
      } else {
        wx.showToast({ title: (r && r.msg) || '导入失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      clientLog.log('detail.onAddToList', e);
      wx.showToast({ title: '导入失败', icon: 'none' });
    }
  },

  // 去外卖：自绘平台选择弹窗
  onShowTakeout(e) {
    // 点击时把该菜名字复制到剪贴板，方便去外卖平台直接搜索（菜名为纯文本，无注入风险）
    const name = e.currentTarget.dataset.name;
    if (name) {
      wx.setClipboardData({
        data: String(name),
        success() {
          wx.showToast({ title: '已复制：' + name, icon: 'none' });
        }
      });
    }
    this.setData({ showTakeout: true });
  },
  closeTakeout() {
    this.setData({ showTakeout: false });
  },
  onPickPlatform(e) {
    const { appid, name } = e.currentTarget.dataset;
    if (!appid) return;
    wx.navigateToMiniProgram({
      appId: appid,
      fail(err) {
        // 用户点微信系统确认框的「取消」属正常操作，不提示；其余失败才提示
        const msg = err && err.errMsg ? err.errMsg : '';
        if (msg.indexOf('cancel') >= 0) return;
        // 未在小程序后台配置跳转白名单时，给出明确指引
        if (msg.indexOf('navigateToMiniProgramAppIdList') >= 0) {
          wx.showModal({
            title: '暂不支持跳转',
            content: '小程序尚未在后台配置「跳转' + (name || '该平台') + '」权限，请稍后重试或自行打开' + (name || '对应') + '小程序搜索。',
            showCancel: false
          });
          return;
        }
        wx.showToast({ title: '跳转' + (name || '该平台') + '失败', icon: 'none' });
        console.warn('[takeout] navigateToMiniProgram fail', appid, err);
      }
    });
    this.setData({ showTakeout: false });
  },

  // B2 打开评价弹窗
  onShowRate(e) {
    const { si, ii, name } = e.currentTarget.dataset;
    this.setData({ showRate: true, rateCtx: { si, ii, name } });
  },
  onCloseRate() {
    this.setData({ showRate: false });
  },
  // B2 弹窗中选档：写入 prefs（好评入 dishLikes 优先，差评入 avoidDishes 规避）
  onRatePick(e) {
    const rating = e.currentTarget.dataset.rating;
    const ctx = this.data.rateCtx;
    if (!ctx || !ctx.name) return;
    // 差评（含「不好吃」）二次确认，避免误触把菜永久拉黑（E13 误触保护）
    if (rating === 'bad') {
      this.setData({ showRate: false });
      const name = ctx.name;
      wx.showModal({
        title: '标记为不好吃？',
        content: `确认将「${name}」标记为不好吃？之后将尽量避免再推荐它。`,
        confirmText: '确认标记',
        cancelText: '再想想',
        success: (r) => {
          if (r.confirm) this.onRate({ currentTarget: { dataset: { si: ctx.si, ii: ctx.ii, name, rating } } });
        }
      });
      return;
    }
    this.setData({ showRate: false });
    this.onRate({ currentTarget: { dataset: { si: ctx.si, ii: ctx.ii, name: ctx.name, rating } } });
  },
  // B2 实际写入逻辑
  async onRate(e) {
    const { si, ii, name, rating } = e.currentTarget.dataset;
    if (!name) return;
    // 乐观更新
    const groups = this.data.groups.slice();
    if (!groups[si] || !groups[si].items[ii]) return;
    const items = groups[si].items.slice();
    items[ii] = Object.assign({}, items[ii], { rated: rating });
    groups[si] = Object.assign({}, groups[si], { items });
    this.setData({ groups });
    try {
      const res = await wx.cloud.callFunction({ name: 'rateDish', data: { dish: name, rating } });
      const r = res && res.result;
      if (!r || r.code !== 200) {
        wx.showToast({ title: (r && r.msg) || '评价失败', icon: 'none' });
      }
    } catch (e) {
      clientLog.log('detail.onRate', e);
      wx.showToast({ title: '评价失败', icon: 'none' });
    }
  },

  noop() {}
});
