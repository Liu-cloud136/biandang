// 会话内缓存复用：避免每次 onShow 都重复调用云函数
// 设计：内存(store) 与 本地(wx.storage) 双写；读取时内存优先、回退本地。
// 这样冷启动可直接用本地数据即时渲染，后台再静默刷新云端，减少无谓的云函数调用。
const store = {
  prefs: undefined,  // 用户偏好对象（含 taste/spicy/cuisine/type/meat/veg/cookMethod/avoid/scene）
  stats: undefined    // 当日统计（含 freeCount 等）
};

// 本地缓存有效期（毫秒）：超期的 prefs/stats 视为失效，穿透回云端刷新一次。
// 防止极端情况下（并发写入/代码 bug）本地脏数据长期不被云端覆盖。
const CACHE_TTL = 24 * 3600 * 1000;

// 统一封装 wx.storage 读写（在微信运行时之外调用时安全降级）
// 注意：wx.getStorageSync 对不存在的 key 返回 ''，故用 getStorageInfoSync 判断 key 是否真实存在，
// 缺失时返回 undefined，避免 '' 被误当作有效缓存值。
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
function lsSet(k, v) {
  try { if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(k, v); } catch (e) {}
}
function lsRemove(k) {
  try { if (typeof wx !== 'undefined' && wx.removeStorageSync) wx.removeStorageSync(k); } catch (e) {}
}

module.exports = {
  // 基础 storage 原语（2026-09-07 补导出：index tryWarmup 等直接调用 cache.lsGet/lsSet 曾静默失败）
  lsGet, lsSet, lsRemove,

  // ---------- 新用户引导状态（C+A 2026-09-07）----------
  // 首屏轻提示条是否已处理过（点过任何按钮/关闭即记，整机只出现一次）
  getGuideTipSeen() { return lsGet('bd_guide_tip_seen') === true; },
  setGuideTipSeen() { lsSet('bd_guide_tip_seen', true); },
  // 结果区引导卡已展示次数（前 5 次出菜；计数在 index 出菜成功后自增）
  getResultCardShown() { return Number(lsGet('bd_guide_card_cnt') || 0); },
  incResultCardShown() { lsSet('bd_guide_card_cnt', this.getResultCardShown() + 1); },
  // 历史兼容：旧版本「以后再说」曾永久屏蔽（bd_guide_card_dismissed）。
  // 2026-09-07 起「以后再说」改为仅跳过本次、不再写入此标记；仍保留读取，避免曾点过永久屏蔽的老用户被重新骚扰。
  getResultCardDismissed() { return lsGet('bd_guide_card_dismissed') === true; },
  setResultCardDismissed() { lsSet('bd_guide_card_dismissed', true); },
  // 结果引导是否显示（无偏好 + 老用户未永久屏蔽过 + 展示次数 < 5）
  shouldShowResultGuide() {
    if (this.getHasPrefs() === true) return false;
    if (this.getResultCardDismissed()) return false;
    return this.getResultCardShown() < 5;
  },

  // ---------- 偏好：内存 + 本地双写，读取回退本地 ----------
  getPrefs() {
    if (store.prefs !== undefined) return store.prefs;
    const ts = lsGet('bd_prefs_ts');
    if (ts && (Date.now() - ts) > CACHE_TTL) return undefined;  // 超期穿透，回云端刷新
    return lsGet('bd_prefs');
  },
  setPrefs(v) { store.prefs = v; lsSet('bd_prefs', v); lsSet('bd_prefs_ts', Date.now()); },
  getLocalPrefs() { return lsGet('bd_prefs'); },
  setLocalPrefs(v) { lsSet('bd_prefs', v); },
  // 偏好上次成功拉取时间戳（节流用）
  getPrefsTs() { try { return lsGet('bd_prefs_ts'); } catch (e) { return 0; } },

  // ---------- 统计：内存 + 本地双写，读取回退本地 ----------
  getStats() {
    if (store.stats !== undefined) return store.stats;
    const ts = lsGet('bd_stats_ts');
    if (ts && (Date.now() - ts) > CACHE_TTL) return undefined;  // 超期穿透，回云端刷新
    return lsGet('bd_stats');
  },
  setStats(v) { store.stats = v; lsSet('bd_stats', v); lsSet('bd_stats_ts', Date.now()); },
  getLocalStats() { return lsGet('bd_stats'); },
  setLocalStats(v) { lsSet('bd_stats', v); },
  // 是否已确认存在偏好：避免每次 onShow 都调 getPrefs（首页返回专用）
  getHasPrefs() { try { return lsGet('bd_has_prefs'); } catch (e) { return undefined; } },
  setHasPrefs(v) { lsSet('bd_has_prefs', !!v); },
  // 决定/领次数后剩余次数变化：更新内存并同步落地本地
  setFreeCount(n) {
    if (store.stats) {
      store.stats = Object.assign({}, store.stats, { freeCount: n });
      lsSet('bd_stats', store.stats);
    } else {
      // 内存无统计时，尝试合并到本地已有统计
      const local = lsGet('bd_stats');
      if (local) lsSet('bd_stats', Object.assign({}, local, { freeCount: n }));
    }
  },

  // ---------- 用户ID ----------
  // ⚠️ 缺失时返回 undefined（绝不能 || 0）：否则清缓存后首次读取会误得 0，被渲染成「用户ID 0」。
  getLocalUserId() { return lsGet('bd_userId'); },
  // null/undefined 表示清空：真正移除 key；不再 `v || 0`（会把 null 吞成 0 重新写入，导致 ID 0 反复出现）。
  // 0 不是合法用户编号（管理员固定 'admin'，普通用户从 1 起），故 v===0 也照常写入（防御性，实际不会发生）。
  setLocalUserId(v) {
    if (v === null || v === undefined) lsRemove('bd_userId');
    else lsSet('bd_userId', v);
  },

  // ---------- 「当前免费获取」提示每日只显示一次：记录上次展示日期 ----------
  getGrantTipDate() { return lsGet('bd_grant_tip_date') || ''; },
  setGrantTipDate(v) { lsSet('bd_grant_tip_date', v); },

  // ---------- 通知公告：本地持久化（刷新/网络异常也照常显示，不随刷新消失） ----------
  getLocalAnnouncement() { return lsGet('bd_announcement'); },
  setLocalAnnouncement(v) { lsSet('bd_announcement', v); },

  // ---------- 历史记录本地缓存：进入历史页先即时渲染，再后台静默刷新云端 ----------
  getLocalHistory() { return lsGet('bd_history'); },
  setLocalHistory(v) { lsSet('bd_history', v); lsSet('bd_history_ts', Date.now()); },
  // 历史列表上次成功拉取时间戳（节流用）
  getHistoryTs() { try { return lsGet('bd_history_ts'); } catch (e) { return 0; } },

  // ---------- 买菜清单本地缓存：进入清单页先即时渲染，再后台静默刷新云端 ----------
  getShoppingList() { return lsGet('bd_shopping'); },
  setShoppingList(v) { lsSet('bd_shopping', v); lsSet('bd_shopping_ts', Date.now()); },
  getShoppingTs() { try { return lsGet('bd_shopping_ts'); } catch (e) { return 0; } },
  // 产生新历史后调用，使历史页下次进入强制刷新（绕过节流）
  invalidateHistory() { try { lsRemove('bd_history_ts'); } catch (e) {} },
  // 恢复数据后调用：清空用户数据相关本地缓存（偏好/历史/统计/收藏/生成记录/画像/周报等），
  // 使各页面回到云端真实状态。注意：本地购菜清单（bd_shopping）为本地唯一副本、不属云端偏好，故不清。
  // 备份还原覆盖 user_preferences / favorites / recommend_history / free_log 等，
  // 若不失效，历史页(60s 节流+本地缓存)及其余页面会一直显示恢复前的旧数据。
  invalidateUserData() {
    try {
      // 历史：清时间戳(绕过 60s 节流) + 清数据(避免闪旧)
      lsRemove('bd_history');
      lsRemove('bd_history_ts');
      // 偏好 / 统计：内存(store) + 本地一并清，否则 store 仍返回旧值
      store.prefs = undefined;
      store.stats = undefined;
      lsRemove('bd_prefs');
      lsRemove('bd_has_prefs'); // 恢复/清本地：失效「已确认有偏好」标记，避免恢复无偏好备份仍卡主页
      lsRemove('bd_prefs_ts');
      // 新用户引导状态（C+A 2026-09-07）：注销/恢复后重置，重新注册重新走引导
      lsRemove('bd_guide_tip_seen');
      lsRemove('bd_guide_card_cnt');
      lsRemove('bd_guide_card_dismissed');
      lsRemove('bd_stats');
      lsRemove('bd_stats_ts');
      lsRemove('bd_favcount');
      // 云端收藏 / 次数明细 / 忌口 缓存
      lsRemove('bd_cloud_fav');
      lsRemove('bd_cloud_fav_ts');
      lsRemove('bd_freelog');
      lsRemove('bd_avoid');
      lsRemove('bd_tuning');
      // 生成记录（冰箱/剩菜/周表）：清时间戳(绕过节流) + 清详情(避免闪旧)
      lsRemove('bd_genrecords_fridge');
      lsRemove('bd_genrecords_leftover');
      lsRemove('bd_genrecords_fridge_all');
      lsRemove('bd_genrecords_week');
      lsRemove('bd_genrecords_ts');
      (lsGet('bd_gendetail_ids') || []).forEach(id => lsRemove('bd_gendetail_' + id));
      lsRemove('bd_gendetail_ids');
      lsRemove('bd_gendetails');
      // 口味周报 / 算法画像：恢复后强制重新拉取（绕过节流 + 避免闪旧）
      lsRemove('bd_insight');
      lsRemove('bd_insight_ts');
      lsRemove('bd_weight_overview');
      lsRemove('bd_weight_overview_ts');
      // 天气缓存：用户清理本地缓存即失效（下次出文重新算和风/云端缓存）
      lsRemove('bd_weather_ctx');
      lsRemove('bd_weather_ctx_ts');
    } catch (e) {}
  },

  // ---------- 口味周报（getInsight）本地缓存：进入「我的」先即时渲染，再后台静默刷新 ----------
  getInsight() { try { return lsGet('bd_insight'); } catch (e) { return null; } },
  setInsight(v) { if (v !== null && v !== undefined) { lsSet('bd_insight', v); lsSet('bd_insight_ts', Date.now()); } },
  getInsightTs() { try { return lsGet('bd_insight_ts'); } catch (e) { return 0; } },

  // ---------- 算法口味画像（getWeightOverview）本地缓存：同上 ----------
  getWeightOverview() { try { return lsGet('bd_weight_overview'); } catch (e) { return null; } },
  setWeightOverview(v) { if (v !== null && v !== undefined) { lsSet('bd_weight_overview', v); lsSet('bd_weight_overview_ts', Date.now()); } },
  getWeightOverviewTs() { try { return lsGet('bd_weight_overview_ts'); } catch (e) { return 0; } },

  // ---------- 生成记录（冰箱/剩菜/周表）本地缓存：进入页面先即时渲染，再后台静默刷新云端 ----------
  // 详情按 id 独立 key（bd_gendetail_<id>），避免读大对象；bd_gendetail_ids 为 ID 索引
  getGenDetail(id) {
    try {
      const v = lsGet('bd_gendetail_' + id);
      if (v !== undefined) return v;
      const old = lsGet('bd_gendetails');
      if (old && typeof old === 'object' && old[id] !== undefined) {
        lsSet('bd_gendetail_' + id, old[id]);
        const ids = lsGet('bd_gendetail_ids') || [];
        if (!ids.includes(id)) { ids.push(id); lsSet('bd_gendetail_ids', ids); }
        return old[id];
      }
      return undefined;
    } catch (e) { return undefined; }
  },
  setGenDetail(id, data) {
    try {
      lsSet('bd_gendetail_' + id, data);
      const ids = lsGet('bd_gendetail_ids') || [];
      if (!ids.includes(id)) { ids.push(id); lsSet('bd_gendetail_ids', ids); }
    } catch (e) {}
  },
  // 列表按 type 独立 key（bd_genrecords_<type>），ts 记录最后成功拉取时间
  getGenRecords(type) {
    try { return lsGet('bd_genrecords_' + type); } catch (e) { return null; }
  },
  setGenRecords(type, list) {
    if (Array.isArray(list)) { lsSet('bd_genrecords_' + type, list); lsSet('bd_genrecords_ts', Date.now()); }
  },
  getGenRecordsTs() { try { return lsGet('bd_genrecords_ts'); } catch (e) { return 0; } },
  // 单独刷新最后拉取时间戳（不重写列表时使用）。保存成功后调用，标记"刚刚更新过"。
  setGenRecordsTs(ts) { try { lsSet('bd_genrecords_ts', ts || Date.now()); } catch (e) {} },
  // 产生新生成记录后调用，使列表下次进入强制刷新（绕过节流）
  // 注意：必须同时清掉 bd_genrecords_fridge_all 合并缓存与各 type 缓存，
  // 否则 loadRecords 命中旧空数组 + ts 未过期会直接 return，导致保存后列表永久为空（2026-08-08 修复）
  invalidateGenRecords() {
    try {
      lsRemove('bd_genrecords_ts');
      lsRemove('bd_genrecords_fridge');
      lsRemove('bd_genrecords_leftover');
      lsRemove('bd_genrecords_fridge_all');
      lsRemove('bd_genrecords_week');
    } catch (e) {}
  },

  // ---------- 「看做法」结果按菜名缓存：已生成过的直接复用，避免重复扣次 ----------
  // 每条做法独立 key（bd_cook_<name>），避免读整个大对象；bd_cook_guide_ids 为索引
  // 兼容旧版 bd_cook_guide（大对象）：首次命中旧格式时自动迁移
  getCookGuide(name) {
    try {
      let v = lsGet('bd_cook_' + name);
      if (v !== undefined) return v;
      // 兼容旧版大对象，自动迁移
      const old = lsGet('bd_cook_guide');
      if (old && typeof old === 'object' && old[name] !== undefined) {
        lsSet('bd_cook_' + name, old[name]);
        const ids = lsGet('bd_cook_guide_ids') || [];
        if (!ids.includes(name)) { ids.push(name); lsSet('bd_cook_guide_ids', ids); }
        return old[name];
      }
      return undefined;
    } catch (e) { return undefined; }
  },
  setCookGuide(name, guide) {
    try {
      lsSet('bd_cook_' + name, guide);
      const ids = lsGet('bd_cook_guide_ids') || [];
      if (!ids.includes(name)) { ids.push(name); lsSet('bd_cook_guide_ids', ids); }
    } catch (e) {}
  },

  // ---------- 决定详情按 id 缓存：进入详情页先即时渲染，不再弹「加载中」 ----------
  // 每条记录独立 key（bd_detail_<id>），避免读整个大对象；bd_details_ids 为 ID 索引
  // 兼容旧版 bd_details（大对象）：首次命中旧格式时自动迁移到独立 key
  getHistoryDetail(id) {
    try {
      let v = lsGet('bd_detail_' + id);
      if (v !== undefined) return v;
      // 兼容旧版 bd_details 大对象，自动迁移
      const old = lsGet('bd_details');
      if (old && typeof old === 'object' && old[id] !== undefined) {
        lsSet('bd_detail_' + id, old[id]);
        const ids = lsGet('bd_details_ids') || [];
        if (!ids.includes(id)) { ids.push(id); lsSet('bd_details_ids', ids); }
        return old[id];
      }
      return undefined;
    } catch (e) { return undefined; }
  },
  setHistoryDetail(id, data) {
    try {
      lsSet('bd_detail_' + id, data);
      const ids = lsGet('bd_details_ids') || [];
      if (!ids.includes(id)) { ids.push(id); lsSet('bd_details_ids', ids); }
    } catch (e) {}
  },

  // ---------- 本地收藏（免费、即时；云端收藏见 favorite 云函数） ----------
  // 存为数组：[{ dish, scene, kind, imageUrl, ts }]，ts 为本地时间戳（毫秒）
  getLocalFavorites() {
    try {
      const m = lsGet('bd_favorites');
      return (m && Array.isArray(m)) ? m : [];
    } catch (e) { return []; }
  },
  setLocalFavorites(arr) { lsSet('bd_favorites', Array.isArray(arr) ? arr : []); },
  isLocalFavorited(dish) {
    return this.getLocalFavorites().some(f => f.dish === dish);
  },
  // 切换本地收藏（同一 dish 去重），返回切换后的布尔状态
  toggleLocalFavorite(item) {
    const list = this.getLocalFavorites().slice();
    const i = list.findIndex(f => f.dish === (item && item.dish));
    let on;
    if (i >= 0) { list.splice(i, 1); on = false; }
    else {
      list.unshift({
        dish: item.dish,
        scene: item.scene || '',
        kind: item.kind || '',
        imageUrl: item.imageUrl || '',
        guide: item.guide || null,
        ts: Date.now()
      });
      on = true;
    }
    this.setLocalFavorites(list);
    return on;
  },
  removeLocalFavorite(dish) {
    this.setLocalFavorites(this.getLocalFavorites().filter(f => f.dish !== dish));
  },
  // 生成做法后：把最新做法同步进已本地收藏的记录（做法随收藏走，清理缓存不丢）
  updateLocalFavoriteGuide(dish, guide) {
    if (!dish || !guide) return;
    const list = this.getLocalFavorites().slice();
    const i = list.findIndex(f => f.dish === dish);
    if (i >= 0) {
      list[i] = Object.assign({}, list[i], { guide });
      this.setLocalFavorites(list);
    }
  },

  // 收藏总数的本地缓存（值由外部计算「本地+云端合并去重」后写入）：进「我的」页先读它瞬时显示，避免先闪 0
  getFavCount() {
    try { const v = lsGet('bd_favcount'); return (typeof v === 'number') ? v : null; } catch (e) { return null; }
  },
  setFavCount(n) { if (typeof n === 'number') lsSet('bd_favcount', n); },

  // ---------- 菜品图片本地缓存：cloud:// fileID 首次下载后转存本地，后续进详情页秒显不重拉 ----------
  // 存为 bd_img_<fileID> = savedFilePath（本地持久路径，跨会话有效，直到用户清理缓存）
  // 解决：历史详情图片用的是 cloud:// 文件ID，<image> 每次进入都向云存储重新拉取、需再次加载的问题。
  getLocalImage(fileID) {
    try {
      if (!fileID) return null;
      const p = lsGet('bd_img_' + fileID);
      if (!p) return null;
      const fm = (typeof wx !== 'undefined' && wx.getFileSystemManager) ? wx.getFileSystemManager() : null;
      if (fm && fm.accessSync) {
        try { fm.accessSync(p); return p; } catch (e) { lsRemove('bd_img_' + fileID); return null; }
      }
      return p;
    } catch (e) { return null; }
  },
  setLocalImage(fileID, savedFilePath) {
    if (fileID && savedFilePath) lsSet('bd_img_' + fileID, savedFilePath);
  },
  // 后台把 cloud/http 图片下载并转存本地（best-effort），下次进详情复用，避免重复从云端拉取
  ensureImageCached(fileID) {
    try {
      if (!fileID || this.getLocalImage(fileID)) return;
      if (typeof wx === 'undefined') return;
      const fm = wx.getFileSystemManager ? wx.getFileSystemManager() : null;
      const done = (tempFilePath) => {
        if (!tempFilePath || !fm || !fm.saveFile) return;
        try {
          fm.saveFile({
            tempFilePath,
            success: (r) => { if (r && r.savedFilePath) this.setLocalImage(fileID, r.savedFilePath); },
            fail: () => {}
          });
        } catch (e) {}
      };
      if (fileID.indexOf('cloud://') === 0) {
        wx.cloud.downloadFile({ fileID, success: (res) => done(res && res.tempFilePath), fail: () => {} });
      } else if (/^https?:\/\//.test(fileID)) {
        wx.downloadFile({ url: fileID, success: (res) => { if (res && res.statusCode === 200) done(res.tempFilePath); }, fail: () => {} });
      }
    } catch (e) {}
  },

  // ---------- 免费次数明细流水本地缓存：点开「免费次数」先秒开本地，后台静默刷新 ----------
  // 存为 { ts: 写入时间戳, list: [...] }，用于判断缓存新鲜度、避免每次点开都联网
  getFreeLog() {
    try { return lsGet('bd_freelog'); } catch (e) { return null; }
  },
  setFreeLog(list) {
    if (Array.isArray(list)) lsSet('bd_freelog', { ts: Date.now(), list });
  },



  // ---------- 云端收藏列表本地缓存：进收藏页/我的页先即时渲染，后台静默刷新云端 ----------
  getCloudFavorites() {
    try { const m = lsGet('bd_cloud_fav'); return (m && Array.isArray(m)) ? m : null; } catch (e) { return null; }
  },
  setCloudFavorites(arr) { if (Array.isArray(arr)) { lsSet('bd_cloud_fav', arr); lsSet('bd_cloud_fav_ts', Date.now()); } },
  addCloudFavorite(item) {
    if (!item || !item.dish) return;
    const list = (this.getCloudFavorites() || []).slice();
    if (!list.some(f => f.dish === item.dish)) list.unshift(item);
    this.setCloudFavorites(list);
  },
  removeCloudFavorite(dish) {
    const list = this.getCloudFavorites();
    if (list) this.setCloudFavorites(list.filter(f => f.dish !== dish));
  },
  // 云端收藏列表上次成功拉取时间戳（节流用）
  getCloudFavTs() { try { return lsGet('bd_cloud_fav_ts'); } catch (e) { return 0; } },

  // ---------- 社区贡献食材库本地缓存：进偏好选择页先秒显，后台静默刷新云端 ----------
  // 存为 { ts: 写入时间戳, list: [...] }；食材库为全平台共享数据（非用户私有），清缓存时保留
  getCommunityIngredients() {
    try { return lsGet('bd_comm_ing'); } catch (e) { return null; }
  },
  setCommunityIngredients(list) {
    if (Array.isArray(list) && list.length) lsSet('bd_comm_ing', { ts: Date.now(), list });
  },
  getCommunityIngredientsTs() {
    try { const m = lsGet('bd_comm_ing'); return (m && m.ts) ? m.ts : 0; } catch (e) { return 0; }
  },
  // 社区食材贡献提交成功后调用：使偏好页/我的页下次进入强制刷新（绕过节流窗口，立即可见新食材）
  invalidateCommunityIngredients() {
    try { lsRemove('bd_comm_ing'); } catch (e) {}
  },

  // ---------- 使用说明（getGuide）本地缓存：进弹层先秒显，后台静默刷新云端 ----------
  // 存为 { ts: 写入时间戳, items: [...] }；items 为空数组/未命中返回 null，前端用内置默认兜底
  getGuideItems() {
    try {
      const m = lsGet('bd_guide');
      return (m && Array.isArray(m.items) && m.items.length) ? m.items : null;
    } catch (e) { return null; }
  },
  setGuideItems(items) {
    if (Array.isArray(items) && items.length) lsSet('bd_guide', { ts: Date.now(), items });
  },

  // ---------- 备份列表本地缓存：进「备份管理」弹窗先秒显，不再每次进去都联网转圈 ----------
  // 存为 { ts: 写入时间戳, list: [...] }；list 极轻量，用户自己的备份本地缓存无隐私风险
  getBackups() {
    try { return lsGet('bd_backups'); } catch (e) { return null; }
  },
  setBackups(list) {
    if (Array.isArray(list)) lsSet('bd_backups', { ts: Date.now(), list });
  },

  // ---------- 推荐调校 tuning 本地缓存：进调校页先秒显，后台静默刷新云端 ----------
  // 存为 tuning 对象本体；保存成功后同步写回，保证下次进入即为最新值
  getTuning() {
    try { const v = lsGet('bd_tuning'); return (v && typeof v === 'object') ? v : null; } catch (e) { return null; }
  },
  setTuning(t) { if (t && typeof t === 'object') lsSet('bd_tuning', t); },

  // ---------- 「我不喜欢的菜」本地缓存：进管理弹窗先秒显，不再每次点开都联网转圈 ----------
  // 存为 { ts: 写入时间戳, list: [...] }，list 为忌口菜名数组；仅本人数据，本地缓存无隐私风险
  getAvoid() {
    try { return lsGet('bd_avoid'); } catch (e) { return null; }
  },
  setAvoid(list) {
    lsSet('bd_avoid', { ts: Date.now(), list: Array.isArray(list) ? list : [] });
  },

  // ---------- 尝鲜清单（prefs.tryLiked）本地缓存：进「我的」页先秒显，后台静默刷新云端 ----------
  // 存为 { ts: 写入时间戳, list: [...] }，list 为尝鲜菜名数组；仅本人数据，本地缓存无隐私风险
  getTryLiked() {
    try { return lsGet('bd_tryliked'); } catch (e) { return null; }
  },
  setTryLiked(list) {
    if (Array.isArray(list)) lsSet('bd_tryliked', { ts: Date.now(), list });
  },
  // 删除某条后同步本地缓存，避免下次进入又拉回已删项
  removeTryLikedCache(name) {
    const m = this.getTryLiked();
    if (m && Array.isArray(m.list)) {
      m.list = m.list.filter(x => x !== name);
      lsSet('bd_tryliked', m);
    }
  },

  // ---------- 清理缓存：可释放大小估算（不含本地收藏，本地收藏无云端副本需保留） ----------
  // 返回字节数；用于「我的」页清理缓存弹窗展示"将释放约 X KB"
  getCacheSize() {
    const keys = ['bd_prefs','bd_stats','bd_stats_ts','bd_userId','bd_history','bd_history_ts','bd_grant_tip_date','bd_announcement','bd_cook_guide','bd_cook_guide_ids','bd_details_ids','bd_favcount','bd_cloud_fav','bd_freelog','bd_has_prefs','bd_avoid','bd_backups','bd_cloud_fav_ts','bd_prefs_ts','bd_tuning','bd_insight','bd_insight_ts','bd_weight_overview','bd_weight_overview_ts','bd_weather_ctx','bd_weather_ctx_ts','bd_guide_tip_seen','bd_guide_card_cnt','bd_guide_card_dismissed'];
    let bytes = 0;
    keys.forEach(k => {
      const v = lsGet(k);
      if (v !== undefined) {
        try { bytes += JSON.stringify(v).length; } catch (e) { bytes += ('' + v).length; }
      }
    });
    // 逐条统计详情缓存
    (lsGet('bd_details_ids') || []).forEach(id => {
      const v = lsGet('bd_detail_' + id);
      if (v !== undefined) {
        try { bytes += JSON.stringify(v).length; } catch (e) { bytes += ('' + v).length; }
      }
    });
    // 逐条统计做法缓存
    (lsGet('bd_cook_guide_ids') || []).forEach(name => {
      const v = lsGet('bd_cook_' + name);
      if (v !== undefined) {
        try { bytes += JSON.stringify(v).length; } catch (e) { bytes += ('' + v).length; }
      }
    });
    // 逐条统计生成记录详情缓存
    (lsGet('bd_gendetail_ids') || []).forEach(id => {
      const v = lsGet('bd_gendetail_' + id);
      if (v !== undefined) {
        try { bytes += JSON.stringify(v).length; } catch (e) { bytes += ('' + v).length; }
      }
    });
    return bytes;
  },

  // ---------- 清理缓存：删除除本地收藏外的所有本地缓存（本地收藏仅本机有、清掉会丢，故保留） ----------
  // 返回释放的字节数；云端数据不动，清理后由页面重新从云端拉取恢复
  clearCache() {
    const keys = ['bd_prefs','bd_stats','bd_stats_ts','bd_userId','bd_history','bd_history_ts','bd_grant_tip_date','bd_announcement','bd_cook_guide','bd_cook_guide_ids','bd_details','bd_details_ids','bd_favcount','bd_cloud_fav','bd_freelog','bd_has_prefs','bd_avoid','bd_backups','bd_cloud_fav_ts','bd_prefs_ts','bd_tuning','bd_insight','bd_insight_ts','bd_weight_overview','bd_weight_overview_ts','bd_weather_ctx','bd_weather_ctx_ts','bd_guide_tip_seen','bd_guide_card_cnt','bd_guide_card_dismissed'];
    let freed = 0;
    keys.forEach(k => {
      const v = lsGet(k);
      if (v !== undefined) {
        try { freed += JSON.stringify(v).length; } catch (e) { freed += ('' + v).length; }
        lsRemove(k);
      }
    });
    // 清理逐条详情缓存
    (lsGet('bd_details_ids') || []).forEach(id => {
      const v = lsGet('bd_detail_' + id);
      if (v !== undefined) {
        try { freed += JSON.stringify(v).length; } catch (e) { freed += ('' + v).length; }
        lsRemove('bd_detail_' + id);
      }
    });
    // 清理逐条做法缓存
    (lsGet('bd_cook_guide_ids') || []).forEach(name => {
      const v = lsGet('bd_cook_' + name);
      if (v !== undefined) {
        try { freed += JSON.stringify(v).length; } catch (e) { freed += ('' + v).length; }
        lsRemove('bd_cook_' + name);
      }
    });
    // 清理生成记录列表缓存 + 逐条详情缓存
    lsRemove('bd_genrecords_fridge');
    lsRemove('bd_genrecords_leftover');
    lsRemove('bd_genrecords_fridge_all');
    lsRemove('bd_genrecords_week');
    lsRemove('bd_genrecords_ts');
    lsRemove('bd_gendetails');
    (lsGet('bd_gendetail_ids') || []).forEach(id => {
      const v = lsGet('bd_gendetail_' + id);
      if (v !== undefined) {
        try { freed += JSON.stringify(v).length; } catch (e) { freed += ('' + v).length; }
        lsRemove('bd_gendetail_' + id);
      }
    });
    lsRemove('bd_gendetail_ids');
    // 清理已转存的菜品图片本地文件（释放磁盘，路径记录在 bd_img_*）
    try {
      const info = wx.getStorageInfoSync ? wx.getStorageInfoSync() : null;
      if (info && Array.isArray(info.keys)) {
        const fm = (typeof wx !== 'undefined' && wx.getFileSystemManager) ? wx.getFileSystemManager() : null;
        info.keys.filter(k => k.indexOf('bd_img_') === 0).forEach(k => {
          const p = lsGet(k);
          if (p && fm && fm.removeSavedFile) { try { fm.removeSavedFile({ filePath: p }); } catch (e) {} }
          lsRemove(k);
        });
      }
    } catch (e) {}
    store.prefs = undefined;
    store.stats = undefined;
    return freed;
  },

  // ---------- 注销/清理：内存与本地一并清除（含本地收藏，配合云端删除，不可逆） ----------
  clearLocal() {
    lsRemove('bd_prefs');
    lsRemove('bd_has_prefs'); // 注销/清本地：失效「已确认有偏好」标记，否则云端已删仍短路跳过引导页
    lsRemove('bd_guide_tip_seen'); // C+A：注销后重置引导提示（重新注册再走轻引导）
    lsRemove('bd_guide_card_cnt');
    lsRemove('bd_guide_card_dismissed');
    lsRemove('bd_stats');
    lsRemove('bd_userId');
    lsRemove('bd_history');
    lsRemove('bd_grant_tip_date');
    lsRemove('bd_announcement');
    lsRemove('bd_cook_guide');
    (lsGet('bd_cook_guide_ids') || []).forEach(name => lsRemove('bd_cook_' + name));
    lsRemove('bd_cook_guide_ids');
    lsRemove('bd_details');
    (lsGet('bd_details_ids') || []).forEach(id => lsRemove('bd_detail_' + id));
    lsRemove('bd_details_ids');
    lsRemove('bd_favorites');
    lsRemove('bd_favcount');
    lsRemove('bd_cloud_fav');
    lsRemove('bd_cloud_fav_ts');
    lsRemove('bd_history_ts');
    lsRemove('bd_prefs_ts');
    lsRemove('bd_freelog');
    lsRemove('bd_tuning');
    lsRemove('bd_genrecords_fridge');
    lsRemove('bd_genrecords_leftover');
    lsRemove('bd_genrecords_fridge_all');
    lsRemove('bd_genrecords_week');
    lsRemove('bd_genrecords_ts');
    lsRemove('bd_gendetails');
    (lsGet('bd_gendetail_ids') || []).forEach(id => lsRemove('bd_gendetail_' + id));
    lsRemove('bd_gendetail_ids');
    lsRemove('bd_weather_ctx');
    lsRemove('bd_weather_ctx_ts');
    store.prefs = undefined;
    store.stats = undefined;
  },

  // ---------- 天气缓存（本地优先，按自然日过期）----------
  // key 基于定位精度：经纬度优先，否则城市|区县。返回结构 {temp,feelsLike,text,city}，与云端 weatherCtx 一致。
  // 过期语义：按「自然日」过期（当天 00:00 ~ 次日 00:00），而非「写入后 24 小时」。
  //   例：晚 23:00 写入，到次日 00:01 即失效（跨天重算），避免沿用昨夜天气到白天。
  //   实现：写入时记 _day=本地 YYYY-MM-DD，读取时与今天比较，不同日即失效。
  // 语义：本地有缓存且未过期 → 出文时随 event.weatherCtx 带给云函数直接复用（跳过和风）；
  //       本地无/过期 → 云函数算完和风后把 weatherCtx 带回，前端再 setWeatherCache 落地。
  // 用户清理本地缓存（clearCache/clearLocal/invalidateUserData）即失效。
  _weatherKey(loc) {
    if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
      return 'coord:' + loc.lat.toFixed(3) + ',' + loc.lon.toFixed(3);
    }
    const c = (loc && loc.city && typeof loc.city === 'string') ? loc.city.trim() : '';
    const d = (loc && loc.district && typeof loc.district === 'string') ? loc.district.trim() : '';
    return 'name:' + c + '|' + d;
  },
  _todayStr() {
    const d = new Date();
    const m = ('0' + (d.getMonth() + 1)).slice(-2);
    const day = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + m + '-' + day;
  },
  getWeatherCache(loc) {
    if (!loc) return null;
    const k = this._weatherKey(loc);
    const ctx = lsGet('bd_weather_ctx');
    // 定位 key 一致 且 写入日期与今天同为自然日 → 命中；否则失效（跨天或地点变化）
    if (ctx && ctx._k === k && ctx._day === this._todayStr()) {
      const out = Object.assign({}, ctx);
      delete out._k;
      delete out._day;
      return out;
    }
    return null;
  },
  setWeatherCache(loc, ctx) {
    if (!loc || !ctx || typeof ctx !== 'object') return;
    const k = this._weatherKey(loc);
    lsSet('bd_weather_ctx', Object.assign({ _k: k, _day: this._todayStr() }, ctx));
    lsSet('bd_weather_ctx_ts', Date.now());
  }
};
