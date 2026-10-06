const { formatDate } = require('../../utils/util');
const cache = require('../../utils/cache');
const clientLog = require('../../utils/clientLog');
clientLog.hook();

function normalizeGroups(recs) {
  if (!Array.isArray(recs) || !recs.length) return [];
  if (recs[0].dishes || recs[0].staples) {
    return recs.map(g => ({ scene: g.scene || '推荐', dishes: g.dishes || [], staples: g.staples || [], drinks: g.drinks || [] }));
  }
  if (recs[0].items) return recs;
  return [{ scene: '推荐', dishes: recs, staples: [], drinks: [] }];
}

// 归一化：确保多场景记录有 activeScene（默认 0）与 activeBlock，兼容旧缓存格式
function ensureActive(rec) {
  if (!rec || !Array.isArray(rec.blocks) || !rec.blocks.length) return rec;
  let ai = rec.activeScene;
  if (typeof ai !== 'number' || !rec.blocks[ai]) ai = 0;
  rec.activeScene = ai;
  rec.activeBlock = rec.blocks[ai];
  return rec;
}

Page({
  data: {
    list: [], allCount: 0, visibleCount: 0, filter: 'all', loading: true, offline: false
  },

  onShow() {
    if (getApp().enterGuard()) return;   // 封禁用户进不去（弹窗并 reLaunch 回首页）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    // 缓存秒出 + 后台静默刷新
    const local = cache.getLocalHistory();
    if (local && local[0] && local[0].blocks) {
      this._allList = local.map(ensureActive);
      this.setData({ loading: false });
      this.applyFilter();
    } else if (!this._allList || !this._allList.length) {
      // 空态：本地无缓存时无需等待云端，立即渲染空态占位符，
      // 避免「loading 中一片空白」造成的切换卡顿感；云端在 _syncCloud 后台静默确认。
      this.setData({ loading: false });
      this.applyFilter();
    }
    // 若本地历史时间戳已被 invalidateHistory 清除（刚采纳过），强制拉云端，
    // 避免 60s 节流 + _allList 有旧数据导致「采纳后切回历史页看不到新记录」
    this._syncCloud(!cache.getHistoryTs());
  },

  // 下拉刷新：强制刷新历史列表，并收起微信原生下拉刷新动画
  // ⚠️ 必须调用 wx.stopPullDownRefresh()，否则刷新动画会一直转（卡住）
  onPullDownRefresh() {
    Promise.resolve(this._syncCloud(true))
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh());
  },

  _sameIds(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { if (a[i]._id !== b[i]._id) return false; }
    return true;
  },

  async _syncCloud(force) {
    // 60s 内且已有数据则跳过，减少无效云函数/数据库请求（决定后 invalidateHistory 会强制刷新）
    const ts = cache.getHistoryTs() || 0;
    if (this._allList && this._allList.length && !force && Date.now() - ts < 60000) { return; }
    try {
      const res = await wx.cloud.callFunction({ name: 'getHistory' });
      if (!res.result || res.result.code !== 200) {
        // 云端未返回 200（如登录态失效/网络错误）：兜底结束 loading，避免页面永久卡白
        this.setData({ loading: false });
        this.applyFilter();
        return;
      }
      const fetched = res.result.data.map(d => {
        const groups = normalizeGroups(d.recommendations);
        const sel = d.selected;
        const selArr = Array.isArray(sel) ? sel : (sel && typeof sel === 'object' ? [sel] : []);
        const blocks = groups.map((g, i) => {
          const picked = selArr.find(s => s && (!s.scene || s.scene === g.scene)) || {};
          const dishPick = (g.dishes || []).find(it => it.name === picked.name) || (g.dishes || [])[0] || null;
          // 小吃/下午茶场景的「主食位」实际展示的是配饮（drinks），其余场景用 staples
          const isDrinkScene = (g.scene === '小吃' || g.scene === '下午茶');
          const stapleSrc = isDrinkScene ? (g.drinks || []) : (g.staples || []);
          // 小吃/下午茶场景的「主食位」实为配饮，选中记录在主键 drink 上（见 index.js _getPicks），须用 picked.drink 匹配
          const staplePickName = isDrinkScene ? picked.drink : picked.staple;
          const staplePick = stapleSrc.find(it => it.name === staplePickName) || stapleSrc[0] || null;
          // 历史区块标签：小吃/下午茶保持原样，其余回退 菜/饭
          let dishTag = '菜', stapleTag = '饭';
          if (g.scene === '小吃') { dishTag = '小吃'; stapleTag = '饮料'; }
          else if (g.scene === '下午茶') { dishTag = '糕点'; stapleTag = '饮品'; }
          return {
            scene: g.scene || '',
            dishTag,
            stapleTag,
            dish: dishPick ? { name: dishPick.name, imageUrl: dishPick.imageUrl || '' } : null,
            staple: staplePick ? { name: staplePick.name, imageUrl: staplePick.imageUrl || '' } : null
          };
        });
        const tsRaw = d.timestamp && d.timestamp.$date ? d.timestamp.$date : d.timestamp;
        const rec = { _id: d._id, date: formatDate(d.timestamp), ts: +new Date(tsRaw) || 0, blocks, sceneCount: groups.length };
        return ensureActive(rec);
      });
      // ID 集合变化 → 重建 _allList（保留分段切换状态、避免图片重载）
      // ID 集合未变但内容（采纳态/图片）可能已更新 → 逐条同步最新内容，避免「采纳后历史页不刷新」
      const prevById = {}; (this._allList || []).forEach(it => { prevById[it._id] = it; });
      // 以云端 fetched 为权威基准重建（云端是新数据的唯一可信源），
      // 避免旧「merged 以本地为基准」逻辑在 ID 集合看似相同却漏掉云端新增/更新记录。
      // 仅从本地 prev 继承 activeScene 分段切换状态（避免刷新时图片重载/分段跳回）。
      const list = fetched.map(it => {
        const prev = prevById[it._id];
        if (prev && typeof prev.activeScene === 'number' && it.blocks[prev.activeScene]) {
          return ensureActive({ ...it, activeScene: prev.activeScene });
        }
        return it;
      });
      this._allList = list;
      cache.setLocalHistory(list);
      // ⚠️ 无论数据是否变化都必须结束 loading 并刷新筛选：
      // 空列表（如注销后重新进入 / 新用户首进）也要显示「还没有任何决定」占位符；
      // 否则会卡在 loading=true，导致空态占位符永不显示、页面一片空白。
      this.setData({ loading: false });
      this.applyFilter();
      if (this.data.offline) this.setData({ offline: false }); // 恢复网络，消除离线提示（E12）
    } catch (e) {
      console.error('history sync failed', e);
      clientLog.log('history.load', e);
      // 离线：保持本地缓存渲染，并显示离线提示（E12）
      if (this._allList && this._allList.length) this.setData({ offline: true });
    }
  },

  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.f });
    this.applyFilter();
  },

  applyFilter() {
    const all = this._allList || [];
    const f = this.data.filter;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const match = it => {
      if (f === 'today') return it.ts >= todayStart;
      if (f === 'threeday') return it.ts >= todayStart - 3 * 864e5;
      if (f === 'week') return it.ts >= todayStart - 7 * 864e5;
      return true;
    };
    // 保持 list 引用稳定（始终指向 _allList），仅切换每项的 _hidden，
    // 避免 wx:for 重建 image 节点导致筛选时图片重新加载
    let visible = 0;
    all.forEach(it => {
      const hid = !match(it);
      if (it._hidden !== hid) it._hidden = hid;
      if (!hid) visible++;
    });
    this.setData({ list: all, allCount: all.length, visibleCount: visible });
  },

  // 分段标签切换：多场景记录点标签切换当前显示的场景（原地修改，保持 list 引用稳定，不重建其它图片节点）
  onSwitchScene(e) {
    const { id, bi } = e.currentTarget.dataset;
    const all = this._allList || [];
    let changed = false;
    all.forEach(it => {
      if (it._id === id && it.activeScene !== bi && it.blocks[bi]) {
        it.activeScene = bi;
        it.activeBlock = it.blocks[bi];
        changed = true;
      }
    });
    if (changed) this.setData({ list: all });
  },
  noop() {},

  // 图片加载失败（模拟器常见 ERR_HTTP2_PROTOCOL_ERROR，多因云存储并发流被中断）：
  // 自动重建 image 节点重试，最多 3 次，仍失败则保留占位图
  onImgErr(e) {
    const { id, kind } = e.currentTarget.dataset;
    const list = this.data.list;
    const idx = list.findIndex(x => x._id === id);
    if (idx < 0) return;
    const it = list[idx];
    const tries = it._imgTries || 0;
    if (tries >= 3) return;
    const errKey = kind === 'dish' ? '_imgErrDish' : '_imgErrStaple';
    this.setData({ ['list[' + idx + '].' + errKey]: true });
    setTimeout(() => {
      const l2 = this.data.list;
      const i2 = l2[idx];
      if (!i2) return;
      i2._imgTries = (i2._imgTries || 0) + 1;
      i2[errKey] = false; // 重建 image 节点重新拉取
      this.setData({ ['list[' + idx + ']']: i2 });
    }, 600);
  },

  // 卡片点击：进详情
  onTapCard(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/history/detail?id=' + id });
  },
  // 长按卡片：直接删除（查看详情走点击卡片进入，长按不再提供查看，与提示文案一致）
  onLongPress(e) {
    const id = e.currentTarget.dataset.id;
    this.onDelete({ currentTarget: { dataset: { id } } });
  },
  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除记录',
      content: '确定删除这条推荐记录吗？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const res = await wx.cloud.callFunction({
            name: 'deleteAccount',
            data: { action: 'deleteHistory', id }
          });
          if (res && res.result && res.result.code === 200) {
            this._allList = (this._allList || []).filter(it => it._id !== id);
            cache.setLocalHistory(this._allList);
            this.applyFilter();
          }
        } catch (e) { clientLog.log('history.onDelete', e); wx.showToast({ title: '删除失败', icon: 'none' }); }
      }
    });
  }
});
