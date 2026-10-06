// 推荐调校 tuning 默认值（2026-07-29）：与后端 DEFAULT_TUNING 保持一致。
// 老用户无 tuning 字段时回退这些默认值，UI 直接填默认，用户改了才写回云端。
const cache = require('../../utils/cache.js');
const clientLog = require('../../utils/clientLog');
clientLog.hook();
const DEFAULT_TUNING = {
  explore: 50,
  tasteShift: 0,
  health: 'casual',
  complexity: 'mid',
  repeatGuard: 7,
  surprise: 20,
  nutrition: 'none',
  seasonal: false,
  serving: 'solo',
  recency: 50        // 念旧↔喜新 0-100：0=最喜新(只认最近)，50=均衡(默认)，100=最念旧(历史都算数)
};

Page({
  data: {
    tuning: null,
    saving: false
  },

  onLoad() {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    this.load();
  },

  // 读现有 tuning：先读本地缓存秒显，再后台静默刷新云端（getPrefs），缺字段回退默认值
  async load() {
    // 1) 本地缓存命中 → 立即渲染（不转圈不等网络）
    const local = cache.getTuning();
    if (local) this.setData({ tuning: Object.assign({}, DEFAULT_TUNING, local) });
    // 2) 后台拉云端最新，回来后覆盖并写回缓存
    try {
      const p = await wx.cloud.callFunction({ name: 'getPrefs' });
      const ok = !!(p.result && p.result.code === 200);
      const prefs = (ok && p.result.data && p.result.data.prefs) ? p.result.data.prefs : null;
      const tuning = Object.assign({}, DEFAULT_TUNING, (prefs && prefs.tuning) || {});
      this.setData({ tuning });
      cache.setTuning(tuning);
    } catch (e) {
      // 云端失败：已有缓存则维持缓存值；否则回退默认
      if (!this.data.tuning) this.setData({ tuning: Object.assign({}, DEFAULT_TUNING) });
    }
  },

  // 滑块类（尝鲜意愿/口味微调/重复度/惊喜度）
  onTuningSlide(e) {
    const key = e.currentTarget.dataset.key;
    const val = Number(e.detail.value);
    this.setData({ ['tuning.' + key]: val });
  },
  // 分段类（健康倾向/下厨复杂度/营养目标/一人食多人餐）
  onTuningRadio(e) {
    const key = e.currentTarget.dataset.key;
    const val = e.detail.value;
    this.setData({ ['tuning.' + key]: val });
  },
  // 开关类（应季时令优先）
  onTuningSwitch(e) {
    const key = e.currentTarget.dataset.key;
    const val = !!e.detail.value;
    this.setData({ ['tuning.' + key]: val });
  },

  // 保存（saveTuning）：仅把 tuning 写库，不动 prefs
  async saveTuning() {
    const tuning = this.data.tuning;
    if (!tuning || this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'savePreferences', data: { action: 'saveTuning', tuning } });
      wx.hideLoading();
      this.setData({ saving: false });
      if (res.result && res.result.code === 200) {
        cache.setTuning(tuning); // 保存成功同步写本地缓存，下次进页即为最新值
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ saving: false });
      clientLog.log('tuning.saveTuning', err);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  }
});
