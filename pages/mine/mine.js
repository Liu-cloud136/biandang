const cache = require('../../utils/cache');
const { showServerBusy } = require('../../utils/util');
const { HIER, ING_CATEGORIES } = require('../../utils/config');
const clientLog = require('../../utils/clientLog');
clientLog.hook(); // 自动收集 console.error/warn 到缓冲，便于反馈时上报

// 字段 → setup 步骤号（与 pages/setup 的 STEP_FIELD 对齐；mine 页点某条偏好跳到对应步骤单独编辑）
const PREF_FIELD_STEP = {
  taste: 1, spicy: 2, cuisine: 3, type: 4, meat: 5, veg: 6,
  communityIngredients: 7, cookMethod: 8, avoid: 9, scene: 10, drink: 11
};

// 管理员 openid（管理员 ID 固定为字符串 'admin'，由云端 amIAdmin 按此 OPENID 权威识别）。
// ⚠️ 前端 checkAdmin 已禁止回退管理员常量：openid 取不到时保守不显示后台入口，
// 避免普通新用户被误判成管理员。管理员真机正常（OPENID 有值）；开发者工具下管理员本人看不到入口，可走 adminLogin 密码进入后台。

function join(arr) {
  return Array.isArray(arr) && arr.length ? arr.join('、') : '未设置';
}

// 社区贡献食材按分类渲染：「分类（食材1、食材2）」，与 setup 第 7 步一致（选小类必显示大类）。
// catMap 来自 getCommunityIngredients 返回的 {value: category} 映射；未拉到时回退纯列表展示。
function formatCommunity(ingredients, catMap) {
  if (!Array.isArray(ingredients) || !ingredients.length) return '未设置';
  if (!catMap) return ingredients.join('、');
  // 分类顺序以 ING_CATEGORIES 为准；调味干货不在偏好展示（与 setup 第 7 步一致）
  const order = ING_CATEGORIES.slice().filter(c => c !== '调味干货');
  const map = {};
  ingredients.forEach(v => {
    const cat = (catMap[v] && String(catMap[v]).trim()) || '其他';
    if (!map[cat]) map[cat] = [];
    map[cat].push(v);
  });
  const parts = Object.keys(map).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  }).map(cat => cat + '（' + map[cat].join('、') + '）');
  return parts.length ? parts.join('、') : '未设置';
}

// 两级联动字段展示：小类渲染为「大类（小类）」，如 酸甜（偏酸）、猪肉（里脊肉）
function formatHier(field, arr) {
  if (!Array.isArray(arr) || !arr.length) return '未设置';
  const hier = HIER[field];
  if (!hier) return arr.join('、');
  const allChildren = new Set();
  Object.keys(hier).forEach(p => hier[p].forEach(c => allChildren.add(c)));
  const parts = [];
  const used = new Set();
  arr.forEach(item => {
    if (hier[item]) {
      const children = hier[item].filter(c => arr.indexOf(c) > -1);
      children.forEach(k => used.add(k));
      parts.push(children.length ? item + '（' + children.join('、') + '）' : item);
    } else if (allChildren.has(item)) {
      // 子类：若其父类也在选中列表中（子类将被包裹显示为「父（子）」），跳过独立显示
      const parentKey = Object.keys(hier).find(p => hier[p].indexOf(item) > -1);
      if (parentKey && arr.indexOf(parentKey) > -1) { used.add(item); }
      else if (!used.has(item)) parts.push(item); // 仅当父未选中时才单独显示
    } else {
      parts.push(item);
    }
  });
  return parts.length ? parts.join('、') : '未设置';
}

// 推荐调校 tuning 默认值（2026-07-29）：与后端 DEFAULT_TUNING 保持一致。
// 老用户无 tuning 字段时回退这些默认值，UI 直接填默认，用户改了才写回云端。
const DEFAULT_TUNING = {
  explore: 50,
  tasteShift: 0,
  health: 'casual',
  complexity: 'mid',
  repeatGuard: 7,
  surprise: 20,
  nutrition: 'none',
  seasonal: false,
  serving: 'solo'
};


Page({
  data: {
    prefFields: [],
    userId: null,           // 用户ID（管理员固定字符串 'admin'，普通用户数字）；null=未加载
    hasUserId: false,       // 是否已拿到真实用户ID，控制用户ID显示
    userIdLoading: false,   // 是否正在拉取用户ID（清缓存后首次 OPENID 未就绪时），加载中显示「加载中…」而非「已注销」
    userIdGuest: false,      // 身份拉取多次重试后仍失败（OPENID 未就绪/调用异常）：显示「未登录」而非误导的「已注销」
    userIdErr: '',           // 身份拉取失败的真实原因（code:401 / 调用异常信息），供排查
    favCount: null,         // 收藏总数（本地 + 云端去重，null=未加载）
    showLogout: false,     // 注销确认弹层
    showFeedback: false,   // 意见反馈自绘弹层（系统 showModal 输入框太小，改用 textarea）
    feedbackText: '',
    showRedeem: false,      // 兑换码自绘弹层
    redeemCode: '',
    redeemValid: null,      // 前端实时校验：null=未校验 | true=合法(✓) | false=非法(✗)
    redeemMsg: '',
    redeemMsgType: '',      // '' | 'err' | 'ok'
    showBackups: false,     // 备份管理自绘弹窗
    backupList: [],         // 备份记录列表
    showContribInfo: false, // 贡献说明弹窗（第一步）
    showContribForm: false, // 贡献填写弹窗（第二步）
    contribType: '',        // 本次贡献类型：'dish' | 'ingredient'
    contribDishes: '',      // 填写的菜名（多行）
    contribIngredients: '', // 填写的食材（多行）
    contribIngCategory: '', // 本次贡献食材的分类（整批共用）
    ING_CATEGORIES: ING_CATEGORIES, // 食材分类可选项（贡献表单展示）
    contribIng: false,      // 贡献提交进行中
    showContribResult: false, // 贡献提交结果自绘弹窗（显示通过/未通过及原因）
    contribResult: [],       // 提交结果明细：[{value,type,status,reason}] status: valid|pending|rejected
    isAdmin: false,         // 管理员入口显隐
    openid: '',              // 云端返回的真实 openid（供 checkAdmin 传给 amIAdmin；上下文 OPENID 为空时为空，回退 ADMIN_OPENID 兜底）
    // 我不喜欢的菜（个人忌口反馈记录）管理
    showAvoid: false,
    avoidList: [],
    // 尝鲜清单（首页「想尝试一些其他的？」加入偏好的菜）管理
    showTry: false,
    tryList: [],
    // 推荐调校 tuning（2026-07-29）：独立于硬偏好 prefs 的软旋钮，仅调节 AI 推荐风格
    tuning: null,
    // 所在城市（C 方案真实天气）：展示文案
    locText: '',
    // 周期性洞察（2026-08-05）：我的口味周报卡片
    insight: null,        // { empty, days, decidedCount, meatTop, repeated, suggested, ... }
    insightLoading: false,
    // 全局算法理解总览（2026-08-06）：算法对你口味的整体理解卡片
    weightOverview: null,  // { empty, days, decidedCount, meat[], veg[], drift[], down[], summary, ... }
    personaTags: [],        // 词云标签：[{text}]
    // 2026-08-07 锁定态进度：整体进度由后端字段在 loadWeightOverview 内派生到 weightOverview.overallPct/overallNeed
    showHalo: false,         // 头像光晕：近3天决定>5 或 总决定>10 时显示
  },

  async onShow() {
    if (getApp().enterGuard()) return;   // 封禁用户进不去（弹窗并 reLaunch 回首页）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.refreshLocText();
    // 根治冷启动 401：先等全局登录态闸门（app.ensureLogin 触发微信静默登录、拿到 openid，
    // 全程只发一次 getPrefs 且全局缓存），openid 就绪后再发本页所有云函数调用，
    // 避免 getWeightOverview/getPrefs 在空窗里撞 401。即使未就绪（resolve(false)）也继续，
    // 下方 load/loadWeightOverview 仍各自保留轻量重试兜底，双保险。
    await getApp().ensureLogin();
    // load() 内部会在云端 openid 就绪后自动校验管理员入口；此处再主动校验一次，
    // 覆盖 app 预热已拿到全局 openid、但本页 load 尚未取到的情况（真机体验版首进更稳）。
    this.checkAdmin();
    await this.load(0);
    // 拉取社区食材分类（ingredient_library），让「社区」偏好行显示「分类（食材）」；失败静默回退纯列表
    this.loadCommunityIngredients();
  },

  // 刷新「所在城市」展示文案（C 方案真实天气），展示 城市 · 区/县 两级
  refreshLocText() {
    try {
      const loc = require('../../utils/location').getCached();
      if (!loc) { this.setData({ locText: '' }); return; }
      let t = loc.city ? loc.city : '';
      if (loc.district) t = t ? (t + ' · ' + loc.district) : loc.district;
      this.setData({ locText: t });
    } catch (e) { this.setData({ locText: '' }); }
  },

  // 定位（IP 定位，无授权弹窗；替代原 wx.getLocation GPS 定位）
  async onLocate() {
    wx.showLoading({ title: '定位中' });
    try {
      const locMod = require('../../utils/location');
      const loc = await locMod.locateByIp();
      wx.hideLoading();
      if (loc && loc.ok !== false) {
        this.refreshLocText();
        wx.showToast({ title: '定位成功', icon: 'success' });
        return;
      }
      // 失败（未配置 key / 云函数异常 / 配额超限等）→ 提示失败即可，天气自动回退节气
      const reason = (loc && loc.reason) || 'unknown';
      const errMsg = (loc && loc.errMsg) || '';
      console.error('[onLocate] IP 定位失败 reason=', reason, 'errMsg=', errMsg);
      wx.showToast({ title: '定位失败，天气推荐将按节气近似', icon: 'none' });
    } catch (e) {
      wx.hideLoading();
      console.error('[onLocate] 异常', e);
      wx.showToast({ title: '定位失败，天气推荐将按节气近似', icon: 'none' });
    }
  },

  // 校验当前用户是否为管理员，决定是否显示管理入口
  async checkAdmin() {
    // 管理后台入口由 amIAdmin 云端校验决定（后端按管理员 OPENID 权威比对，ID 固定 'admin'）。
    // ⚠️ 仅当云端返回真实 openid 时才校验；openid 取不到（未授权 / 开发者工具）时保守不显示，
    // 绝不回退 ADMIN_OPENID 常量——否则所有取不到 openid 的普通新用户都会被误判成管理员、
    // 看到后台按钮。开发者工具下管理员本人亦看不到入口，但可走 adminLogin 密码进入后台。
    // openid 优先取本页 load 拿到的，再兜底 app 预热存入的全局 openid（真机首次冷启动时序更稳）。
    const openid = ((this.data.openid || getApp().globalData.openid || '').trim());
    if (!openid) {
      // 全局 openid 仍未就绪（真机冷启动偶发）：启动主动拉取 openid 兜底（200ms×最多25次≈5s），
      // 主动调 getPrefs 拉取，绕开 load 因本地缓存新鲜而跳过云端、导致 openid 一直空的短路。
      if (this._adminPolling) return; // 已在轮询中，避免重复建定时器
      this._adminPolling = true;
      let n = 0;
      const tick = async () => {
        // 先读内存（app 预热 / load 已写入的情形）
        const memId = (this.data.openid || getApp().globalData.openid || '').trim();
        if (memId) { this._adminPolling = false; this.checkAdmin(); return; }
        // 内存没有则主动调 getPrefs 拉取（load 可能因本地缓存新鲜而跳过云端，导致 openid 一直空）
        try {
          const p = await wx.cloud.callFunction({ name: 'getPrefs' });
          const id = (p.result && p.result.data && p.result.data.openid) || '';
          if (id) {
            this._adminPolling = false;
            if (id !== this.data.openid) this.setData({ openid: id });
            this.checkAdmin();
            return;
          }
        } catch (e) { /* 兜底拉取失败，继续轮询 */ }
        if (n++ < 25) setTimeout(tick, 200);
        else this._adminPolling = false;
      };
      setTimeout(tick, 200);
      return;
    }
    this._adminPolling = false;
    try {
      const r = await wx.cloud.callFunction({ name: 'amIAdmin', data: { openid } });
      const admin = !!(r.result && r.result.isAdmin);
      if (admin !== this.data.isAdmin) this.setData({ isAdmin: admin });
    } catch (e) {
      // 校验失败/超时：保守不显示入口，避免误开后台
    }
  },

  // 进入管理后台
  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  async load(retry = 0) {
    if (this._loading) return;
    this._loading = true;
    try {
      // 1. 本地缓存即时渲染
      const localPrefs = cache.getLocalPrefs();
      const localUserId = cache.getLocalUserId();
      // ⚠️ 旧版本曾把管理员标记为数字 0 写入本地缓存；该值已废弃，任何 0 一律视为无效，
      // 避免新用户（残留旧缓存 / 未授权环境）被显示成「用户ID 0」。
      const curUserId = (localUserId != null && localUserId !== 0) ? localUserId : null;
      if (localUserId === 0) cache.setLocalUserId(null); // 清掉已废弃的管理员旧标记（新 cache 实现会真正删除 key）
      const cachedPrefs = cache.getPrefs();
      const curPrefs = localPrefs || cachedPrefs;
      const hasLocal = !!(curPrefs || curUserId);
      if (hasLocal) this.applyData(curPrefs, curUserId);
      const cachedFav = cache.getFavCount();
      if (cachedFav != null) this.setData({ favCount: cachedFav });
      // 本地无数据时先进入「加载中」，避免误导显示为「已注销」
      if (!hasLocal) this.setData({ userIdLoading: true });

      // 2. 后台刷新：仅数据变化时才 applyData；60s 内且有本地数据则跳过，减少云函数/数据库请求
      const prefsTs = cache.getPrefsTs() || 0;
      // ⚠️ 关键修复：retry>0 表示上一次 getPrefs 返回 401/异常（OPENID 未就绪）。此时必须强制走云端，
      // 否则 401 时写入的 bd_prefs_ts 会让后续重试被「缓存新鲜(60s 内)」短路、永远不再请求云端，
      // 表现就是一直卡在「已注销」。点「清理缓存」能恢复，正是因为它清掉了 bd_prefs_ts 与时间戳。
      const forceCloud = retry > 0;
      // ⚠️ 关键修复2：若本地没有有效用户ID（hasUserId=false），必须强制走云端，绝不信任缓存。
      // 否则旧代码在 401 时写下的「空 bd_prefs + 新鲜 bd_prefs_ts」会让换上新包后首次 load 误判缓存新鲜、
      // 跳过云端调用、一直显示「已注销」；只有点「清理缓存」清掉时间戳才恢复。预览/体验版/线上版共用同 appid 本地存储，
      // 故换包也带毒。此前 forceCloud 只修了「重试」分支，漏了「首次 load 因有缓存而跳过云端」这一路径。
      const needId = !this.data.hasUserId;
      if (forceCloud || !hasLocal || needId || Date.now() - prefsTs > 60000) {
        const MAX_RETRY = 12;                // 最多重试次数（覆盖清缓存后较长的登录窗口，真机通常 1~2 次内恢复）
        const retryDelay = Math.min(8000, 1000 + retry * 600); // 重试间隔渐增（1s 起，封顶 8s），OPENID 就绪即恢复正确 ID
        try {
          const p = await wx.cloud.callFunction({ name: 'getPrefs' });
          const ok = !!(p.result && p.result.code === 200);
          // 云端返回真实 openid（供 checkAdmin 传给 amIAdmin；上下文 OPENID 未就绪时为空）
          const cloudOpenid = (p.result && p.result.data && p.result.data.openid) || '';
          if (cloudOpenid && cloudOpenid !== this.data.openid) {
            this.setData({ openid: cloudOpenid });
            // openid 一就绪立即校验管理入口（不等 setData 异步刷新、也不等下方统一判断），实现秒显
            this.checkAdmin();
          }
          const prefs = (ok && p.result.data.prefs) ? p.result.data.prefs : curPrefs;
          // ⚠️ 强制以云端编号为准：云端返回有效 userId 才用，否则一律 null；绝不回退本地缓存。
          // 任何 0（旧管理员标记 / 异常）均视为无效，避免误显「用户ID 0」。
          const userId = (ok && p.result.data.userId != null && p.result.data.userId !== 0)
            ? p.result.data.userId
            : null;
          // 数据未变则跳过 setData，避免不必要的渲染
          if (JSON.stringify(prefs) !== JSON.stringify(curPrefs) || userId !== curUserId) {
            cache.setPrefs(prefs);
            cache.setLocalUserId(userId); // userId 为 null 时 cache 会删除 key，不再误存 0
            this.applyData(prefs, userId);
          }
          // 410 兜底：云端 getPrefs 已改为「注销后再进自动重新开通」（墓碑命中即清并重发号，不再返 410）。
          // 此分支仅防御旧版云函数尚未热更的窗口——仍收到 410 时自动触发 reopen 后重拉，绝不展示「已注销」死态。
          if (p.result && p.result.code === 410) {
            console.warn('[load] 收到 410（云函数旧版本/并发窗口），自动重新开通后重试：', p.result.msg || '');
            cache.setHasPrefs(false);
            cache.invalidateUserData();
            try {
              await wx.cloud.callFunction({ name: 'savePreferences', data: { action: 'reopen' } });
            } catch (e2) { /* reopen 失败继续走下方重试 */ }
            this.setData({ userIdLoading: true, userIdGuest: false, userIdErr: '' });
            setTimeout(() => this.load(retry + 1), 1200);
            return;
          }
          if (ok) {
            // 云端已返回明确结果（含 userId 为 null 的真实情形）：停止加载态
            this.setData({ userIdLoading: false, userIdGuest: false, userIdErr: '' });
          } else {
            // 未拿到身份（401=OPENID 未就绪，或其它非 200，或调用异常）：记录原因，延迟重试；
            // 绝不显示「已注销」（那会误导成用户主动注销）。重试耗尽则显示「未登录」+原因，并允许手动重试。
            const reason = (p.result && p.result.code)
              ? `code:${p.result.code} ${p.result.msg || ''}`.trim()
              : '调用失败（无返回）';
            if (retry < MAX_RETRY) {
              console.warn('[load] getPrefs 未就绪，延迟重试：', reason, 'retry=', retry);
              setTimeout(() => this.load(retry + 1), retryDelay);
            } else {
              this.setData({ userIdLoading: false, userIdGuest: true, userIdErr: reason });
            }
          }
        } catch (e) {
          const reason = '调用异常：' + (e && e.message ? e.message : String(e));
          if (retry < MAX_RETRY) {
            setTimeout(() => this.load(retry + 1), retryDelay);
          } else {
            this.setData({ userIdLoading: false, userIdGuest: true, userIdErr: reason });
            wx.showToast({ title: '加载失败', icon: 'none' });
          }
        }
      }
      // openid 就绪则立即校验管理入口：普通用户返回 false（不显示），空 openid 不校验（保守不显示）
      if (this.data.openid) this.checkAdmin();
    } finally {
      this._loading = false;
    }
    this.refreshFavCount();
    this.loadInsight();   // 周期性洞察：进入我的页即静默拉取口味周报（零扣次）
    this.loadWeightOverview(); // 全局算法理解总览（零扣次）
    this.loadDecideStats();    // 头像光晕：统计决定次数，决定是否显示光晕（零扣次）
  },

  // 头像光晕机制（2026-08-19）：近3天决定次数>5 或 总决定次数>10 时，头像外围显示一圈光晕。
  // 决定次数 = recommend_history 记录数（每次 commitRecommendation 即一次决定）。失败静默降级，不显示光晕。
  async loadDecideStats() {
    try {
      const r = await wx.cloud.callFunction({ name: 'getDecideStats' });
      if (r.result && r.result.code === 200 && r.result.data) {
        const { total, recent3 } = r.result.data;
        const show = (recent3 > 5) || (total > 10);
        if (show !== this.data.showHalo) this.setData({ showHalo: show });
      }
    } catch (e) {
      // 静默降级：统计失败不影响主流程
      console.warn('[loadDecideStats] 失败，静默降级：', e);
    }
  },

  // 点击头像进入作者信息页
  onAvatarTap() {
    wx.navigateTo({ url: '/pages/author/author' });
  },

  // 周期性洞察（2026-08-05）：调用 getInsight 拉取用户近期口味分布，作为回访动机。失败静默降级，不影响主流程。
  // 2026-08-07 加缓存：进入先读本地即时渲染，5 分钟内且已有缓存则跳过请求，否则后台静默刷新。
  async loadInsight() {
    if (this.data.insightLoading) return;
    const cached = cache.getInsight();
    if (cached) this.setData({ insight: cached, insightLoading: false });
    const ts = cache.getInsightTs() || 0;
    if (cached && (Date.now() - ts) < 5 * 60 * 1000) return; // 5 分钟窗口内不重复请求
    this.setData({ insightLoading: true });
    try {
      const r = await wx.cloud.callFunction({ name: 'getInsight', data: { days: 14 } });
      if (r.result && r.result.code === 200 && r.result.data) {
        cache.setInsight(r.result.data);
        this.setData({ insight: r.result.data, insightLoading: false });
      } else if (!cached) {
        this.setData({ insight: null, insightLoading: false });
      } else {
        this.setData({ insightLoading: false });
      }
    } catch (e) {
      if (!cached) this.setData({ insight: null, insightLoading: false });
      else this.setData({ insightLoading: false });
    }
  },

  // 全局算法理解总览（2026-08-06）：调用 getWeightOverview 拉取算法对你口味的整体理解
  // （肉类/菜类权重强度、探索方向、降档方向）。零扣次、失败静默降级，不影响主流程。
  // 2026-08-07 加缓存：进入先读本地即时渲染，5 分钟内且已有缓存则跳过请求，否则后台静默刷新。
  async loadWeightOverview(retry = 0) {
    const cached = cache.getWeightOverview();
    if (cached) {
      this.setData({
        weightOverview: cached.weightOverview,
        personaTags: cached.personaTags
      });
    }
    const ts = cache.getWeightOverviewTs() || 0;
    // 5 分钟窗口内且有缓存：直接跳过请求（retry 分支除外，401 后必须强制走云端刷新，否则写入的新鲜时间戳会永久短路）。
    if (cached && retry === 0 && (Date.now() - ts) < 5 * 60 * 1000) return;
    const MAX_RETRY = 12;
    const retryDelay = Math.min(8000, 1000 + retry * 600); // 与 load() 一致：渐增 1s→8s，OPENID 就绪即恢复
    try {
      const r = await wx.cloud.callFunction({ name: 'getWeightOverview', data: { days: 60 } });
      if (r.result && r.result.code === 200 && r.result.data) {
        const d = r.result.data;
        // 口味人格标签：优先用后端按正交维度劈好的 personaTags（{text,dim}：core 人格 / flavor 口味 / trend 趋势），
        // 回退到把 persona 整串按 · 拆（兼容旧版本后端未返回 personaTags 的情况，默认 dim=core）。
        let rawTags;
        if (Array.isArray(d.personaTags) && d.personaTags.length) {
          rawTags = d.personaTags.map(t => (typeof t === 'string' ? { text: t, dim: 'core' } : t));
        } else {
          rawTags = (d.persona || '').split('·').map(s => s.trim()).filter(Boolean).map(t => ({ text: t, dim: 'core' }));
        }
        // 2026-08-07 锁定态进度：由后端 selfCount/selfNeed/selfThreshold/baselineN/baselineNeed/baselineThreshold 派生百分比
        const st = d.selfThreshold || 50;
        const bt = d.baselineThreshold || 500;
        const selfPct = st > 0 ? Math.min(100, Math.round(((d.selfCount || 0) / st) * 100)) : 100;
        const basePct = bt > 0 ? Math.min(100, Math.round(((d.baselineN || 0) / bt) * 100)) : 100;
        // 整体进度取短板（任一未达标则整体未满）
        const overallPct = Math.min(selfPct, basePct);
        // 用「已积累 / 总门槛」的人话形式展示（selfCount+baselineN 合计贡献度）
        const overallCur = (d.selfCount || 0) + (d.baselineN || 0);
        const overallTotal = st + bt;
        const weightOverview = Object.assign({}, d, { overallPct, overallCur, overallTotal });
        cache.setWeightOverview({ weightOverview, personaTags: rawTags });
        this.setData({ weightOverview, personaTags: rawTags });
      } else if (!cached && retry >= MAX_RETRY) {
        // 重试耗尽且从未拿到过缓存：静默留空（不阻断主流程），不报错骚扰用户
        this.setData({ weightOverview: null });
      } else if (!cached) {
        // 未就绪（401 OPENID 未就绪等）：延迟重试，OPENID 就绪即恢复正确画像
        const reason = (r.result && r.result.code)
          ? `code:${r.result.code} ${r.result.msg || ''}`.trim()
          : '调用失败（无返回）';
        if (retry < MAX_RETRY) {
          console.warn('[loadWeightOverview] getWeightOverview 未就绪，延迟重试：', reason, 'retry=', retry);
          setTimeout(() => this.loadWeightOverview(retry + 1), retryDelay);
        } else {
          this.setData({ weightOverview: null });
        }
      }
    } catch (e) {
      if (!cached && retry < MAX_RETRY) {
        setTimeout(() => this.loadWeightOverview(retry + 1), retryDelay);
      } else if (!cached) {
        this.setData({ weightOverview: null });
      }
    }
  },

  // 手动重试拉取用户身份（未登录态下用户主动点击）
  retryLoad() {
    if (this._loading) return;
    this.setData({ userIdGuest: false, userIdLoading: true, userIdErr: '' });
    this.load(0);
  },

  // 收藏数 = 本地 + 云端去重（同一 dish 只计一次）
  async refreshFavCount() {
    const local = cache.getLocalFavorites();
    // 先用缓存的云端收藏瞬时算数，避免先闪 0 再变真实数字
    const cachedCloud = cache.getCloudFavorites();
    if (cachedCloud) {
      const set = new Set(local.map(f => f.dish));
      cachedCloud.forEach(f => set.add(f.dish));
      const c = set.size;
      cache.setFavCount(c);
      if (this.data.favCount !== c) this.setData({ favCount: c });
    }
    // 后台刷新云端收藏，更新缓存与计数；60s 内且已有云端缓存则跳过，减少无效请求
    const favTs = cache.getCloudFavTs() || 0;
    if (!(cachedCloud && Date.now() - favTs < 60000)) {
      try {
        const res = await wx.cloud.callFunction({ name: 'favorite', data: { action: 'list' } });
        if (res && res.result && res.result.code === 200) {
          const list = (res.result.data && res.result.data.list) || [];
          cache.setCloudFavorites(list);
          const set = new Set(local.map(f => f.dish));
          list.forEach(f => set.add(f.dish));
          const count = set.size;
          cache.setFavCount(count);
          if (this.data.favCount !== count) this.setData({ favCount: count });
        }
      } catch (e) {}
    }
  },

  applyData(prefs, userId) {
    // prefs 为 null（纯新用户、云端+本地均无记录）时也统一渲染全部字段为空态，
    // 确保「社区贡献食材」等分类入口不丢失，且 allEmpty 成立会自动跳首次引导。
    const p = prefs || {};
    // 缓存最近一次偏好与用户ID，供社区分类库异步拉取完成后重刷社区行展示
    this._lastPrefs = prefs;
    this._lastUserId = userId;
    const fields = [
      { field: 'taste', k: '口味', v: formatHier('taste', p.taste) },
      { field: 'spicy', k: '辣度', v: p.spicy },
      { field: 'cuisine', k: '菜系', v: formatHier('cuisine', p.cuisine) },
      { field: 'type', k: '主食', v: formatHier('type', p.type) },
      { field: 'meat', k: '肉类', v: formatHier('meat', p.meat) },
      { field: 'veg', k: '菜类', v: formatHier('veg', p.veg) },
      { field: 'communityIngredients', k: '社区', v: formatCommunity(p.communityIngredients, this._commCatMap) },
      { field: 'cookMethod', k: '做法', v: join(p.cookMethod) },
      { field: 'avoid', k: '忌口', v: join(p.avoid) },
      { field: 'drink', k: '饮料', v: formatHier('drink', p.drink) },
      { field: 'scene', k: '场景', v: join(p.scene) }
    ];
    const prefFields = fields.map(f => {
      const empty = !f.v || f.v === '未设置';
      return { field: f.field, k: f.k, v: empty ? '未设置' : f.v, empty };
    });
    const allEmpty = prefFields.length > 0 && prefFields.every(f => f.empty);
    const hasUserId = (userId != null && userId !== 0);
    // 推荐调校 tuning：合并默认，老用户无 tuning 字段时填默认，UI 直接可交互；用户改了才写回云端
    const tuning = Object.assign({}, DEFAULT_TUNING, (prefs && prefs.tuning) || {});
    this.setData({ prefFields, allEmpty, userId: hasUserId ? userId : null, hasUserId, tuning });
    // C+A（2026-09-07）：无偏好用户不再自动踢去 setup（首页已放行先出菜）——
    // 这里仅展示可点「去设置/进入次数中心」的手动入口，绝不弹回引导页。
    // 已填过偏好的用户即使某分类为空（如社区贡献食材未选）也绝不弹回 setup。
  },

  // 拉取社区贡献食材库分类（ingredient_library），供「社区」偏好行按「分类（食材）」展示。
  // 本地缓存优先构建映射（秒显），超过节流窗口再后台静默刷新云端；未拉到映射时保持纯列表兜底。
  loadCommunityIngredients() {
    const refresh = (list) => {
      if (!Array.isArray(list) || !list.length) return;
      const map = {};
      list.forEach(it => { if (it.value) map[it.value] = it.category; });
      this._commCatMap = map;
      if (this._lastPrefs) this.applyData(this._lastPrefs, this._lastUserId);
    };
    const cached = cache.getCommunityIngredients();
    if (cached && Array.isArray(cached.list) && cached.list.length) refresh(cached.list);
    const ts = cache.getCommunityIngredientsTs();
    if (ts && Date.now() - ts < 6 * 3600 * 1000) return;
    wx.cloud.callFunction({ name: 'getCommunityIngredients' }).then(res => {
      const list = (res.result && res.result.code === 200 && Array.isArray(res.result.list)) ? res.result.list : [];
      if (!list.length) return;
      cache.setCommunityIngredients(list);
      refresh(list);
    }).catch(() => {});
  },

  goSetup() {
    wx.navigateTo({ url: '/pages/setup/setup?mode=edit' });
  },

  // 全新用户兜底入口：直接进首次完整引导（无 mode，走 steps 1~10），与上方自动跳转一致
  goFirstSetup() {
    wx.navigateTo({ url: '/pages/setup/setup' });
  },

  // 直接进入场景设置：跳到 setup 第 10 步（场景），仅改用餐场景，不展示其余步骤
  goSceneSetup() {
    wx.navigateTo({ url: '/pages/setup/setup?mode=edit&step=10&sceneOnly=1' });
  },

  // ===== 单条偏好：点击进入 setup 对应步骤单独编辑并保存（复用已有 setup 页面） =====
  onPrefItemTap(e) {
    const field = e.currentTarget.dataset.field;
    const step = PREF_FIELD_STEP[field];
    if (!step) return;
    wx.navigateTo({ url: '/pages/setup/setup?mode=edit&step=' + step });
  },

  // 进入收藏列表页
  goFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' });
  },

  // 进入购菜清单页（独立组件入口）
  goShop() {
    wx.navigateTo({ url: '/pages/shoplist/shoplist' });
  },

  // 进入次数中心（虚拟支付购买次数包，2026-09-07）
  goPayCenter() {
    wx.navigateTo({ url: '/pages/paycenter/paycenter' });
  },

  // 阻止点击弹层内容时冒泡到遮罩
  noop() {},

  // —— 贡献菜名/食材 ——
  // 第一步：打开说明弹窗
  onContribOpen() {
    this.setData({ showContribInfo: true });
    this.setTabBarHidden(true);
  },
  onContribInfoCancel() {
    this.setData({ showContribInfo: false });
    this.setTabBarHidden(false);
  },
  // 点「贡献菜品 / 贡献食材」→ 关闭说明，按所选类型打开填写弹窗
  onContribInfoOk(e) {
    const type = (e.currentTarget && e.currentTarget.dataset.type) || 'dish';
    this.setData({ showContribInfo: false, showContribForm: true, contribType: type, contribDishes: '', contribIngredients: '', contribIngCategory: '' });
  },
  onContribDishInput(e) { this.setData({ contribDishes: e.detail.value }); },
  onContribIngInput(e) { this.setData({ contribIngredients: e.detail.value }); },
  onContribIngCat(e) { this.setData({ contribIngCategory: e.currentTarget.dataset.cat }); },
  onContribCancel() {
    this.setData({ showContribForm: false, contribType: '', contribDishes: '', contribIngredients: '', contribIngCategory: '', contribIng: false });
    this.setTabBarHidden(false);
  },
  // 结果弹窗「我知道了」：关闭并恢复 tabbar
  onContribResultClose() {
    this.setData({ showContribResult: false, contribResult: [] });
    this.setTabBarHidden(false);
  },
  splitItems(s) {
    return String(s || '').split(/[\n,，、;；\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 20);
  },
  async onSubmitContrib() {
    if (this.data.contribIng) return;
    const dishes = this.splitItems(this.data.contribDishes);
    const ings = this.splitItems(this.data.contribIngredients);
    if (!dishes.length && !ings.length) { wx.showToast({ title: '请填写菜名或食材', icon: 'none' }); return; }
    // 贡献食材时分类为必选
    if (this.data.contribType === 'ingredient' && !this.data.contribIngCategory) {
      wx.showToast({ title: '请先选择食材分类', icon: 'none' });
      return;
    }
    this.setData({ contribIng: true });
    wx.showLoading({ title: '提交中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'submitContribution', data: { dishes, ingredients: ings, ingredientCategory: this.data.contribIngCategory } });
      wx.hideLoading();
      const r = res && res.result;
      if (r && r.code === 200) {
        // 提交了食材则失效社区食材库缓存，下次进偏好页/我的页立即拉取到新食材
        if (Array.isArray(ings) && ings.length) cache.invalidateCommunityIngredients();
        // 组装自绘结果弹窗明细：通过(valid)/待审核(pending)/未通过(rejected) 各带 AI 审核原因
        const accepted = (r.accepted || []).map(x => ({ value: x.value, type: x.type, status: x.status || 'valid', reason: x.reason || '' }));
        const rejected = (r.rejected || []).map(x => ({ value: x.value, type: x.type, status: x.status || 'rejected', reason: x.reason || '' }));
        this.setData({
          showContribForm: false,
          contribType: '', contribDishes: '', contribIngredients: '', contribIngCategory: '', contribIng: false,
          showContribResult: true,
          contribResult: accepted.concat(rejected)
        });
        this.setTabBarHidden(true); // 结果弹窗期间继续隐藏 tabbar
      } else {
        clientLog.log('mine.onSubmitContrib', 'code=' + (r && r.code) + ' msg=' + ((r && r.msg) || ''));
        wx.showToast({ title: (r && r.msg) || '提交失败', icon: 'none' });
        this.setData({ contribIng: false });
      }
    } catch (e) {
      wx.hideLoading();
      clientLog.log('mine.onSubmitContrib', e);
      wx.showToast({ title: '提交失败', icon: 'none' });
      this.setData({ contribIng: false });
    }
  },

  // 隐藏自定义 tab bar，避免被弹层遮挡
  setTabBarHidden(hidden) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ hidden: !!hidden });
    }
  },

  // 意见反馈：打开自绘弹层（系统 showModal 输入框太小，改用大 textarea）
  onFeedback() {
    this.setData({ showFeedback: true, feedbackText: '' });
    this.setTabBarHidden(true);
  },

  onFeedbackInput(e) {
    this.setData({ feedbackText: e.detail.value });
  },

  onFeedbackCancel() {
    this.setData({ showFeedback: false, feedbackText: '' });
    this.setTabBarHidden(false);
  },

  // 提交反馈
  async onFeedbackSubmit() {
    const text = (this.data.feedbackText || '').trim();
    if (!text) { wx.showToast({ title: '内容为空', icon: 'none' }); return; }
    wx.showLoading({ title: '提交中' });
    try {
      // 附带近期运行日志，便于维护定位（不收集用户输入与 OPENID）
      clientLog.log('mine.onFeedbackSubmit', 'feedback submitted, logs=' + clientLog.getLogs().length);
      const logs = clientLog.getLogs();
      const res = await wx.cloud.callFunction({ name: 'submitFeedback', data: { text, logs } });
      clientLog.clear();
      wx.hideLoading();
      if (res.result && res.result.code === 200) {
        this.setData({ showFeedback: false, feedbackText: '' });
        this.setTabBarHidden(false);
        wx.showToast({ title: '感谢反馈！', icon: 'success' });
      } else {
        wx.showToast({ title: '提交失败', icon: 'none' });
      }
    } catch (e) {
      clientLog.log('mine.onFeedbackSubmit', e);
      wx.hideLoading();
      wx.showToast({ title: '提交失败', icon: 'none' });
    }
  },

  // 兑换码：打开弹层
  onOpenRedeem() {
    this.setData({ showRedeem: true, redeemCode: '', redeemValid: null, redeemMsg: '', redeemMsgType: '' });
    this.setTabBarHidden(true);
  },

  onRedeemInput(e) {
    const raw = e.detail.value || '';
    // 前端实时校验（与后端 redeemCode 规则一致：转大写后 [A-Za-z0-9_-]{4,40}）
    const v = raw.trim().toUpperCase();
    const valid = v.length === 0 ? null : /^[A-Za-z0-9_-]{4,40}$/.test(v);
    this.setData({ redeemCode: raw, redeemValid: valid, redeemMsg: '', redeemMsgType: '' });
  },

  onRedeemClose() {
    this.setData({ showRedeem: false, redeemCode: '', redeemValid: null, redeemMsg: '', redeemMsgType: '' });
    this.setTabBarHidden(false);
  },

  // 兑换码：提交兑换
  async onRedeemSubmit() {
    if (getApp().guard()) return;   // 封禁用户全局拒绝
    const code = (this.data.redeemCode || '').trim().toUpperCase();
    if (!code) {
      this.setData({ redeemMsg: '请输入兑换码', redeemMsgType: 'err' });
      return;
    }
    wx.showLoading({ title: '兑换中', mask: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'redeemCode', data: { code } });
      wx.hideLoading();
      const r = res.result || {};
      if (r.code !== 200) clientLog.log('mine.onRedeemSubmit', 'code=' + r.code + ' msg=' + (r.msg || ''));
      if (r.code === 200) {
        wx.showToast({ title: '兑换成功 +' + r.data.granted, icon: 'success' });
        setTimeout(() => this.onRedeemClose(), 900);
      } else if (r.code === 409 && /领完/.test(r.msg || '')) {
        // 已兑完：单独弹窗提示，关闭兑换层
        wx.showModal({
          title: '兑换码已领完',
          content: '该兑换码的名额已被领取完毕，无法再兑换。',
          showCancel: false,
          confirmText: '我知道了',
          success: () => this.onRedeemClose()
        });
      } else if (r.code === 409 && /已兑换过/.test(r.msg || '')) {
        // 已兑换过：单独弹窗提示，关闭兑换层
        wx.showModal({
          title: '已兑换过',
          content: '你已用该兑换码兑换过，每个兑换码限每账号使用一次。',
          showCancel: false,
          confirmText: '我知道了',
          success: () => this.onRedeemClose()
        });
      } else if (r.code === 404 && /已停用/.test(r.msg || '')) {
        // 已停用：单独弹窗提示，关闭兑换层
        wx.showModal({
          title: '兑换码已停用',
          content: '该兑换码已被管理员停用，无法兑换。',
          showCancel: false,
          confirmText: '我知道了',
          success: () => this.onRedeemClose()
        });
      } else if (r.code === 410) {
        // 已过期：单独弹窗提示，关闭兑换层
        wx.showModal({
          title: '兑换码已过期',
          content: '该兑换码已过有效期，无法兑换。',
          showCancel: false,
          confirmText: '我知道了',
          success: () => this.onRedeemClose()
        });
      } else {
        this.setData({ redeemMsg: r.msg || '兑换失败', redeemMsgType: 'err' });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ redeemMsg: '网络异常，请重试', redeemMsgType: 'err' });
    }
  },

  // 备份数据（消耗 1 次免费次数）
  async onBackup() {
    const res = await new Promise(r => wx.showModal({
      title: '备份数据',
      content: '将备份你的偏好、历史、次数流水和收藏到云端，消耗 1 次免费次数。确定备份？',
      confirmText: '备份',
      success: r
    }));
    if (!res.confirm) return;
    wx.showLoading({ title: '备份中', mask: true });
    try {
      const r = await wx.cloud.callFunction({ name: 'backupData', data: { action: 'backup' } });
      wx.hideLoading();
      if (r.result && r.result.code === 200) {
        wx.showToast({ title: '备份成功', icon: 'success' });
        this.load();
        this._refreshBackups(false);
      } else if (r.result && r.result.code === 403) {
        wx.showToast({ title: '免费次数不足，请去主页「领次数」按钮领取。', icon: 'none' });
      } else {
        console.error('[backup] 返回错误：', r.result && r.result.code, r.result && r.result.msg);
        clientLog.log('mine.onBackup', 'code=' + (r.result && r.result.code) + ' msg=' + ((r.result && r.result.msg) || ''));
        showServerBusy('备份失败');
      }
    } catch (e) {
      wx.hideLoading();
      console.error('[backup] 调用异常：', e);
      clientLog.log('mine.onBackup', e);
      showServerBusy('备份失败');
    }
  },

  // 备份管理：打开自绘弹窗并列出所有备份记录
  // 有本地缓存则秒显、不再转圈；无缓存才弹 loading 联网。list 极轻量，打开后后台静默刷新保持最新
  async onManageBackups() {
    this.setData({ showBackups: true });
    this.setTabBarHidden(true);
    const cached = cache.getBackups();
    // ⚠️ 空列表（length===0）也是合法缓存命中：直接渲染空态（「还没有备份记录」），
    // 后台静默刷新即可。若误加 `&& cached.list.length`，无记录时每次打开都会弹「加载中」。
    if (cached && Array.isArray(cached.list)) {
      this.setData({ backupList: cached.list });
      this._refreshBackups(false);
    } else {
      this._refreshBackups(true);
    }
  },

  // 拉取备份列表；showLoading=true（无缓存）才显示加载圈，否则静默后台刷新
  async _refreshBackups(showLoading) {
    if (showLoading) wx.showLoading({ title: '加载中', mask: true });
    try {
      const listRes = await wx.cloud.callFunction({ name: 'backupData', data: { action: 'list', mine: true } });
      if (showLoading) wx.hideLoading();
      const list = (listRes.result && listRes.result.data) || [];
      cache.setBackups(list);
      this.setData({ backupList: list });
    } catch (e) {
      if (showLoading) {
        wx.hideLoading();
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    }
  },

  onBackupsClose() {
    this.setData({ showBackups: false });
    this.setTabBarHidden(false);
  },

  // 删除单条备份
  async onDeleteBackup(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const ok = await new Promise(r => wx.showModal({
      title: '删除备份',
      content: '确定删除这条备份？此操作不可恢复。',
      confirmText: '删除',
      confirmColor: '#E8533E',
      success: r
    }));
    if (!ok.confirm) return;
    wx.showLoading({ title: '删除中', mask: true });
    try {
      const r = await wx.cloud.callFunction({ name: 'backupData', data: { action: 'delete', backupId: id }, timeout: 60000 });
      wx.hideLoading();
      if (r.result && r.result.code === 200) {
        const list = this.data.backupList.filter(b => b.id !== id);
        this.setData({ backupList: list });
        cache.setBackups(list);
        wx.showToast({ title: '已删除', icon: 'none' });
      } else {
        wx.showToast({ title: '删除失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      clientLog.log('mine.onDeleteBackup', e);
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  // 从指定备份恢复（免费，替换当前数据）
  async onRestoreBackup(e) {
    const id = e.currentTarget.dataset.id;
    const label = e.currentTarget.dataset.label || '';
    if (!id) return;
    const ok = await new Promise(r => wx.showModal({
      title: '恢复数据',
      content: '将从「' + label + '」恢复，当前数据将被替换。确定？',
      confirmText: '恢复',
      success: r
    }));
    if (!ok.confirm) return;
    wx.showLoading({ title: '恢复中', mask: true });
    try {
      const r = await wx.cloud.callFunction({ name: 'backupData', data: { action: 'restore', backupId: id }, timeout: 60000 });
      wx.hideLoading();
      if (r.result && r.result.code === 200) {
        this.setData({ showBackups: false });
        this.setTabBarHidden(false);
        cache.invalidateUserData(); // 恢复后清空本地缓存，历史/偏好/次数等回到云端真实状态
        wx.showToast({ title: '恢复成功', icon: 'success' });
        this.load();
      } else {
        clientLog.log('mine.onRestoreBackup', 'code=' + (r.result && r.result.code) + ' msg=' + ((r.result && r.result.msg) || ''));
        wx.showToast({ title: r.result ? r.result.msg : '恢复失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      clientLog.log('mine.onRestoreBackup', e);
      wx.showToast({ title: '恢复失败', icon: 'none' });
    }
  },

  // —— 我不喜欢的菜（个人忌口反馈记录，仅本人可见）管理 ——
  // 打开弹窗先读本地缓存秒显（含空数组），再后台静默刷新云端；
  // 空数组也是合法缓存命中，直接渲染空态，避免每次点开都弹「加载中」
  async onManageAvoid() {
    this.setData({ showAvoid: true });
    this.setTabBarHidden(true);
    const cached = cache.getAvoid();
    if (cached && Array.isArray(cached.list)) {
      this.setData({ avoidList: cached.list });
      this._refreshAvoid(false);
    } else {
      this._refreshAvoid(true);
    }
  },

  // 拉取不喜欢列表；showLoading=true（无缓存）才显示加载圈，否则静默后台刷新
  async _refreshAvoid(showLoading) {
    if (showLoading) wx.showLoading({ title: '加载中' });
    try {
      const r = await wx.cloud.callFunction({ name: 'userAvoid', data: { action: 'list' } });
      if (showLoading) wx.hideLoading();
      if (r.result && r.result.code === 200) {
        const list = Array.isArray(r.result.data) ? r.result.data : [];
        cache.setAvoid(list);
        this.setData({ avoidList: list });
      } else if (showLoading) {
        wx.showToast({ title: (r.result && r.result.msg) || '加载失败', icon: 'none' });
      }
    } catch (err) {
      if (showLoading) {
        wx.hideLoading();
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    }
  },

  onAvoidClose() {
    this.setData({ showAvoid: false });
    this.setTabBarHidden(false);
  },
  async onRemoveAvoid(e) {
    const dish = e.currentTarget.dataset.dish;
    if (!dish) return;
    wx.showLoading({ title: '删除中' });
    try {
      const r = await wx.cloud.callFunction({ name: 'userAvoid', data: { action: 'remove', dish } });
      wx.hideLoading();
      if (r.result && r.result.code === 200) {
        const list = this.data.avoidList.filter(x => x !== dish);
        this.setData({ avoidList: list });
        cache.setAvoid(list);
        wx.showToast({ title: '已删除', icon: 'success' });
      } else {
        wx.showToast({ title: (r.result && r.result.msg) || '删除失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  // —— 尝鲜清单（首页「想尝试一些其他的？」加入偏好的菜）管理 ——
  // 打开弹窗读取云端 tryLiked（prefs.tryLiked），可删除
  async onManageTry() {
    this.setData({ showTry: true });
    this.setTabBarHidden(true);
    // 先读本地缓存即时渲染（缓存命中则不再转圈，实现进入即显示）
    const cached = cache.getTryLiked();
    if (cached && Array.isArray(cached.list)) {
      this.setData({ tryList: cached.list });
    }
    // 后台静默刷新云端，成功则写回缓存；失败不影响已显示的缓存
    try {
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'getTryLiked' } });
      if (res.result && res.result.code === 200) {
        const list = Array.isArray(res.result.data.list) ? res.result.data.list : [];
        this.setData({ tryList: list });
        cache.setTryLiked(list);
      }
    } catch (err) { /* 静默失败，沿用缓存 */ }
  },
  onTryClose() {
    this.setData({ showTry: false });
    this.setTabBarHidden(false);
  },
  async onRemoveTry(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    wx.showLoading({ title: '删除中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'removeTryLiked', name } });
      wx.hideLoading();
      if (res.result && res.result.code === 200) {
        const list = this.data.tryList.filter(x => x !== name);
        this.setData({ tryList: list });
        cache.removeTryLikedCache(name);
        wx.showToast({ title: '已删除', icon: 'success' });
      } else {
        wx.showToast({ title: (res.result && res.result.msg) || '删除失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '删除失败', icon: 'none' });
    }
  },

  // ===== 推荐调校 tuning（2026-07-29）：独立页面 pages/tuning 负责编辑与保存，此处仅做跳转入口 =====
  goTuning() {
    if (this.data.tuning) wx.navigateTo({ url: '/pages/tuning/tuning' });
  },

  // 清理缓存：仅清本机可重建缓存，保留本地收藏（仅本机、无云端副本）；云端数据不动
  onClearCache() {
    const bytes = cache.getCacheSize();
    const sizeText = bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
    wx.showModal({
      title: '清理缓存',
      content: `将释放约 ${sizeText} 本机全部缓存，云端数据不受影响。本地收藏记录仍将保留，确定清理？`,
      confirmText: '清理',
      confirmColor: '#FF8C42',
      success: (r) => {
        if (!r.confirm) return;
        cache.clearCache();
        wx.showToast({ title: '已清理', icon: 'none' });
        this.load();
      }
    });
  },

  onLogout() {
    this.setData({ showLogout: true });
  },
  onLogoutCancel() {
    this.setData({ showLogout: false });
  },
  async onLogoutConfirm() {
    this.setData({ showLogout: false });
    wx.showLoading({ title: '注销中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'deleteAccount', data: { action: 'deleteAccount' } });
      if (res.result && res.result.code === 200) {
        cache.setPrefs(undefined);
        cache.clearLocal();
        cache.invalidateUserData();   // 重置引导标记与本地缓存，重新注册走 C+A 轻引导（2026-09-07）
        wx.hideLoading();
        wx.showToast({ title: '已注销', icon: 'success' });
        setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
      } else {
        wx.hideLoading();
        wx.showToast({ title: '注销失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '注销失败', icon: 'none' });
    }
  },

});
