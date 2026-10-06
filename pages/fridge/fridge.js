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
    mode: 'fridge',          // fridge=现有食材 | leftover=剩菜改造
    input: '',
    result: [],              // 生成结果
    loading: false,
    loadingText: '',
    msg: '',
    records: [],             // 历史生成记录（持久）
    _pendingDeleted: [],      // 已发起删除但云端落库延迟未生效的 id，loadRecords 云端合并时需屏蔽，避免闪白读回
    showCostConfirm: false,
    costConfirmType: '',
    costConfirmInput: null,
    saving: false
  },

  onLoad() {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    this.loadRecords();
  },
  onShow() {
    // 从购菜清单页返回后刷新历史
    this.loadRecords();
  },

  onFridgeMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.setData({ mode, input: '', result: [], msg: '' });
    this.loadRecords();
  },
  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  async loadRecords() {
    // 两个 tab 共用一份历史（fridge + leftover 合并），用固定 key 缓存
    const cached = cache.getGenRecords('fridge_all');
    if (Array.isArray(cached)) {
      cached.forEach(r => { if (!r._hm) r._hm = formatDate(r.createdAt); });
      this.setData({ records: cached });
    }
    const needCloud = cached ? (Date.now() - cache.getGenRecordsTs() > 5 * 60 * 1000) : true;
    if (!needCloud) return;
    try {
      const [fr, lo] = await Promise.all([
        wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'listGenRecords', type: 'fridge' } }),
        wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'listGenRecords', type: 'leftover' } })
      ]);
      const list = [];
      [fr, lo].forEach(res => {
        const arr = (res && res.result && res.result.data && res.result.data.records) || [];
        arr.forEach(r => { r._hm = formatDate(r.createdAt); list.push(r); });
      });
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const seen = {};
      const pendingSet = this.data._pendingDeleted || [];
      // 屏蔽云端延迟期读回的已删记录（pendingSet 内的 id），避免删除后切 tab 闪白
      const deduped = list.filter(r => {
        if (pendingSet.indexOf(r._id) >= 0) return false; // 已删，云端延迟期仍返回则丢弃
        if (seen[r._id]) return false;
        seen[r._id] = true;
        return true;
      });
      // 云端可能因落库延迟暂未返回刚保存的记录，保留本地占位（isLocal）直到真实记录到达；
      // 若云端已返回同 _id 真实记录（落库生效），用真实记录替换占位（避免重复显示/丢字段）。
      // 真实记录优先：先收集占位，再用云端同 id 真实记录覆盖。
      const localMap = {};
      (this.data.records || []).forEach(r => { if (r && r.isLocal && !seen[r._id]) localMap[r._id] = r; });
      const replaced = deduped.map(r => (localMap[r._id] ? Object.assign({}, r, { _fromLocal: true }) : r));
      const locals = Object.keys(localMap).map(id => localMap[id]);
      const finalList = locals.length ? locals.concat(replaced) : replaced;
      // 云端已确认这些待删 id 不再返回 → 从 pendingSet 清除
      const stillPending = pendingSet.filter(pid => list.some(r => r._id === pid));
      if (stillPending.length !== pendingSet.length) {
        this.setData({ _pendingDeleted: stillPending });
      }
      // 仅当云端拿到真实数据才写回缓存，避免把延迟期的空结果污染 fridge_all 缓存
      if (list.length) {
        // 与当前展示一致则跳过 setData，避免切 tab 时缓存→云端两次渲染交替闪烁
        if (!this._recordsEqual(this.data.records, finalList)) {
          this.setData({ records: finalList });
        }
        cache.setGenRecords('fridge_all', finalList);
        cache.setGenRecordsTs(Date.now());
      } else {
        // 云端空：保留当前（含本地占位）展示，不写空缓存
        if (!this._recordsEqual(this.data.records, finalList)) {
          this.setData({ records: finalList });
        }
      }
    } catch (e) {
      if (!cached) this.setData({ records: [] });
    }
  },

  // 比较两次列表是否真不同（避免云端与本地一致时重复 setData 造成切 tab 闪烁）
  // 注意：必须比较 isLocal 标记。云端真实记录 _id 与本地占位 _id 相同时，
  // 真实记录应替换占位（占位带 isLocal=true），若只看 _id 会判定相等而不更新，
  // 导致列表一直显示 isLocal 占位（且可能缺字段），表现为"记录不显示/显示异常"。
  _recordsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i]._id !== b[i]._id) return false;
      if (!!a[i].isLocal !== !!b[i].isLocal) return false;
    }
    return true;
  },

  onFridgeSubmit() {
    const raw = (this.data.input || '').split(/[\n,，、；;]+/).map(s => s.trim()).filter(Boolean);
    if (!raw.length) {
      this.setData({ msg: this.data.mode === 'leftover' ? '先填点剩菜吧，如：剩饭、炒青菜' : '先填点食材吧，如：鸡蛋、西红柿' });
      return;
    }
    this.setData({ showCostConfirm: true, costConfirmType: this.data.mode, costConfirmInput: raw });
  },

  onCostCancel() {
    this.setData({ showCostConfirm: false, costConfirmType: '', costConfirmInput: null });
  },
  onCostConfirm() {
    const type = this.data.costConfirmType;
    const input = this.data.costConfirmInput;
    if (type === 'fridge' || type === 'leftover') this.doSubmit(input);
    else this.setData({ showCostConfirm: false });
  },

  async doSubmit(raw) {
    const isLeftover = this.data.mode === 'leftover';
    this.setData({ showCostConfirm: false, loading: true, loadingText: isLeftover ? '正在琢磨剩菜的新吃法…' : '正在看看这些食材能做什么…', msg: '', result: [] });
    try {
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: Object.assign({ action: isLeftover ? 'leftoverMakeover' : 'fridgeCook', ingredients: raw }, getWeatherLoc()) });
      const r = res && res.result;
      if (r && r.code === 200) {
        // 冰箱/剩菜均默认全选，供用户勾选后保存
        const dishes = (r.data.dishes || []).map(d => ({ name: d.name, selected: true }));
        this.setData({
          result: dishes,
          msg: (r.data.dishes && r.data.dishes.length) ? '' : (isLeftover ? '这些剩料暂时想不到改造菜，加种主料试试？' : '这些食材暂时想不到能做的菜，试试加一种主料？')
        });
        if (typeof r.data.remainingFreeCount === 'number') cache.setFreeCount(r.data.remainingFreeCount);
      } else if (r && r.code === 403) {
        wx.showModal({ title: '免费次数不足', content: '免费次数不足，请去主页「领次数」按钮领取。', showCancel: false });
      } else {
        // 430 限流与其余服务侧错误统一文案（服务异常）；码/文案进 console + clientLog 便于排障
        console.error('[fridge.doSubmit] 返回错误：', r && r.code, r && r.msg);
        clientLog.log('fridge.doSubmit', 'code=' + (r && r.code) + ' msg=' + ((r && r.msg) || ''));
        showServerBusy();
      }
    } catch (e) {
      console.error('[fridge.doSubmit] callFunction reject:', e);
      clientLog.log('fridge.doSubmit', e);
      showServerBusy();
    } finally {
      this.setData({ loading: false });
    }
  },

  // 冰箱反推：切换某道菜的选中态（多选）
  onToggleDish(e) {
    const idx = e.currentTarget.dataset.idx;
    const result = this.data.result.slice();
    if (!result[idx]) return;
    result[idx] = Object.assign({}, result[idx], { selected: !result[idx].selected });
    this.setData({ result });
  },

  // 冰箱反推：仅保存用户勾选的菜品到历史
  async onSavePick() {
    if (this.data.saving) return;
    const picks = this.data.result.filter(d => d && d.selected).map(d => ({ name: d.name }));
    if (!picks.length) {
      wx.showToast({ title: '先选几道菜吧', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'saveFridgePick', dishes: picks, type: this.data.mode } });
      const r = res && res.result;
      if (r && r.code === 200) {
        wx.showToast({ title: '已保存所选', icon: 'success' });
        // 用后端返回的真实 recordId 作占位 _id（不要用 local_xxx 伪 id，否则详情页云端查不到报"记录不存在"）
        const now = Date.now();
        const realId = r.recordId || ('local_' + now);
        const localRec = { _id: realId, _openid: '', type: this.data.mode, items: picks, createdAt: now, _hm: formatDate(now), isLocal: true };
        // 保留所有旧的 isLocal 占位（代表云端延迟落库中的记录），仅把当前新占位插到最前。
        // 注意：不能用 filter(!isLocal) 清掉旧占位——连续保存时旧占位对应的云端记录可能尚未落库，
        // 若此刻命中缓存（setGenRecordsTs 刚刷新，5 分钟内不拉云端），旧记录会永久从列表消失（"保存后不显示"）。
        const prevLocals = (this.data.records || []).filter(x => x && x.isLocal);
        const prevReal = (this.data.records || []).filter(x => x && !x.isLocal);
        const merged = [localRec].concat(prevLocals).concat(prevReal);
        this.setData({ result: [], msg: '', records: merged, input: '' });
        // 写回缓存（即使之前无缓存也要建），并刷新 timestamp，确保切 tab / 重进页能立即看到这条；
        // 云端延迟落库期这条 isLocal 占位会被天然保留，落库生效后 loadRecords 去重自动合并
        cache.setGenRecords('fridge_all', merged);
        // 清 ts + 清各 type 合并缓存，使下次 loadRecords 强制拉云端并避开旧占位数据；
        // 云端落库后真实记录与占位同 _id，去重逻辑自动用真实记录替换占位。
        // （setGenRecordsTs 已在 cache.js 补齐，但 invalidateGenRecords 语义更准确，优先用）
        cache.invalidateGenRecords();
      } else if (r && r.code === 400) {
        // 后端明确拒绝（无菜品），不视为网络异常
        wx.showToast({ title: (r.msg) || '没有可保存的菜品', icon: 'none' });
      } else {
        // 业务返回非 200（如云端旧版本无此 action），给出明确提示而非笼统"网络异常"
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    } catch (err) {
      // callFunction 真正 reject（云环境未就绪/弱网超时）：提示网络异常但保留已选，允许重试
      console.error('[onSavePick] callFunction reject:', err);
      clientLog.log('fridge.onSavePick', err);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onOpenRecord(e) {
    const id = e.currentTarget.dataset.id;
    const type = e.currentTarget.dataset.type;
    wx.navigateTo({ url: '/pages/genDetail/genDetail?type=' + type + '&id=' + id });
  },

  // 长按删除单条生成历史（冰箱/剩菜）
  onDeleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 本地占位记录（云端落库延迟期）直接本地移除，不调云端
    if (String(id).indexOf('local_') === 0) {
      const rest = (this.data.records || []).filter(r => r._id !== id);
      this.setData({ records: rest });
      return;
    }
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
            // 先乐观本地移除该条，避免云端落库延迟期间出现空白窗口
            const rest = (this.data.records || []).filter(r => r._id !== id);
            // 记入待删除集合，屏蔽云端延迟期读回的已删记录，避免切 tab 闪白
            const pending = this.data._pendingDeleted.slice();
            if (pending.indexOf(id) < 0) pending.push(id);
            this.setData({ records: rest, _pendingDeleted: pending });
            // 关键：不要 invalidate 整个缓存（会迫使切 tab 时必走云端，而云端删除延迟未生效会把已删记录读回造成闪白）。
            // 改为直接更新本地缓存过滤掉该条，切 tab 命中缓存即显示，避开删除延迟窗口；缓存过期后云端删除已生效也不会再读回。
            const cached = cache.getGenRecords('fridge_all');
            if (Array.isArray(cached)) {
              cache.setGenRecords('fridge_all', cached.filter(r => r._id !== id));
            }
          } else {
            wx.showToast({ title: (ret && ret.msg) || '删除失败', icon: 'none' });
          }
        } catch (err) {
          clientLog.log('fridge.onDelete', err);
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
