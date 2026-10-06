// app.js —— 小程序入口，负责初始化云环境
App({
  globalData: {
    envId: 'your-env-id-1',
    cloudInited: false,
    // 云端返回的真实 openid（预热 getPrefs 拿到后存这里，供各页 checkAdmin 等直接读取，
    // 避免依赖页面自身 getPrefs 时序；真机首次冷启动 OPENID 偶发未注入时，预热成功即补齐）。
    openid: '',
    // 封禁状态：启动后由 getPrefs 的 prefs.banned 填充；被封禁用户全局拒绝
    banned: false,
    bannedReason: '',
    // 登录态闸门：首次静默登录（触发微信注入 openid）的 Promise，全局缓存只发一次。
    // 各页调云函数前 await getApp().ensureLogin()，避免在 openid 未就绪的冷启动空窗里发调用。
    ensureLoginPromise: null
  },

  // 全局一次性登录态预热：触发微信静默登录、拿到 openid 后 resolve(true)；
  // 未就绪/异常也 resolve(false)（下方调用自行重试兜底），绝不 reject 以免阻塞页面。
  // 重复调用复用同一个 Promise（只发一次 getPrefs），天然幂等。
  ensureLogin() {
    if (this.globalData.ensureLoginPromise) return this.globalData.ensureLoginPromise;
    this.globalData.ensureLoginPromise = new Promise((resolve) => {
      wx.cloud.callFunction({ name: 'getPrefs' })
        .then(r => {
          if (r && r.result) {
            if (r.result.data && r.result.data.openid) this.globalData.openid = r.result.data.openid;
            // 顺手补齐封禁态（getPrefs 已返回 prefs），让 onLaunch 复用、不再发第二次请求
            if (r.result.data && r.result.data.prefs) {
              this.globalData.banned = !!r.result.data.prefs.banned;
              this.globalData.bannedReason = r.result.data.prefs.bannedReason || '';
            }
            if (r.result.code === 200) { resolve(true); return; }
          }
          resolve(false);
        })
        .catch(() => resolve(false));
    });
    return this.globalData.ensureLoginPromise;
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库版本过低，请使用 2.2.3 以上基础库以使用云能力');
      wx.showModal({
        title: '版本过低',
        content: '请升级微信到最新版本后重试',
        showCancel: false
      });
      return;
    }
    wx.cloud.init({
      env: this.globalData.envId,
      traceUser: true
    });
    this.globalData.cloudInited = true;
    // 预热云函数登录态：复用 ensureLogin()（全局单次 Promise），清缓存/删小程序后首次进入，
    // getWXContext().OPENID 可能短暂为空，先触发一次静默登录，使后续页面调用能拿到 OPENID，
    // 避免「用户ID 显示已注销、需重进」。失败（401 等）不影响启动，命中失败本身也会建立微信登录态。
    // ensureLogin 已顺手把 banned/bannedReason 写入 globalData，这里只负责就绪后补弹封禁窗（零额外请求）。
    this.ensureLogin().then(ok => {
      if (ok && this.globalData.banned) {
        // 首屏 onShow 早于本回调时，enterGuard 已靠 isBanned() 快拦；这里再补一次实时封禁弹窗。
        setTimeout(() => this.showBannedModal(), 300);
      }
    });
  },

  // 是否被封禁（读启动预热值，用于同步快拦；实时性由 refreshBan 保证）
  isBanned() {
    return !!this.globalData.banned;
  },

  // 实时刷新封禁状态：调 getDailyStats，403 → 已封禁并弹窗，200 → 解除。
  // 解决「用户启动后管理员才封禁、globalData.banned 仍为 false 导致所有拦截失效」的问题。
  // 应在各业务页 onShow 调用，保证进入页面即同步最新封禁态。
  async refreshBan() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getDailyStats' });
      if (res && res.result && res.result.code === 403) {
        this.globalData.banned = true;
        this.showBannedModal();
      } else if (res && res.result && res.result.code === 200) {
        this.globalData.banned = false;
      }
    } catch (e) { /* 网络失败不改动现有状态，下次 onShow 再试 */ }
  },

  // 展示封禁弹窗（不可取消）。统一出口：所有封禁提示都走这里，避免多处各自弹窗导致重复。
  // 内部 2 秒内去重，防止 enterGuard / refreshBan / loadStats 等多处短间隔触发时连弹多个。
  showBannedModal() {
    if (this.globalData._bannedModalShown) return;
    this.globalData._bannedModalShown = true;
    setTimeout(() => { this.globalData._bannedModalShown = false; }, 2000);
    wx.showModal({
      title: '账号已被封禁',
      content: '你的账号因违反使用规范已被封禁，暂时无法使用本小程序的功能。如有疑问可联系管理员。',
      showCancel: false,
      confirmText: '我知道了'
    });
  },

  // 操作前拦截：封禁则弹窗并返回 true（调用方应 return）；未封禁返回 false
  guard() {
    if (this.isBanned()) {
      this.showBannedModal();
      return true;
    }
    return false;
  },

  // 页面进入拦截：封禁用户直接进不去（reLaunch 回首页）。
  // 用法：业务页 onLoad/onShow 开头调 getApp().enterGuard()，返回 true 即表示已拦截（调用方无需再渲染）。
  // 同步读 globalData.banned（预热 + 各页 onShow 的 refreshBan 已写入），避免内容闪现；
  // 并异步补一次 refreshBan，覆盖「本次会话中途被封禁、尚未刷新」的边缘场景。
  // 弹窗去重：子页面拦截后 reLaunch 回首页会再次触发 enterGuard，用 _bannedModalShown 防止连弹两个。
  enterGuard(noRelaunch) {
    if (this.isBanned()) {
      this.showBannedModal();   // 内部已去重（2s），不会连弹
      // 非首页页面：弹窗后踢回首页（封禁用户落脚页）。首页自身不能 reLaunch 自己，否则死循环。
      if (!noRelaunch) wx.reLaunch({ url: '/pages/index/index' });
      return true;
    }
    this.refreshBan();   // 异步兜底，下次进入即同步
    return false;
  }
});
