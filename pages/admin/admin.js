const cache = require('../../utils/cache');
const { showServerBusy } = require('../../utils/util');
const { ING_CATEGORIES } = require('../../utils/config');
const clientLog = require('../../utils/clientLog');
clientLog.hook();

function fmt(ts) {
  if (!ts) return '';
  let d = ts;
  if (!(ts instanceof Date)) {
    // 云端 serverDate 返回的是对象或字符串
    d = new Date(ts.$date ? ts.$date : ts);
  }
  if (isNaN(d.getTime())) return '';
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const STATUS_CLASS = {
  pending: 'st-pending', valid: 'st-valid', invalid: 'st-invalid',
  dup: 'st-dup', fabricated: 'st-fab', blocked: 'st-block', merged: 'st-merged'
};

// 中文标签映射（汉化后台英文枚举）
const BLOCK_TYPE_LABEL = { word: '词', example: '示例菜名', dish: '菜名', ingredient: '食材' };
const FB_STATUS_LABEL = { pending: '待审核', valid: '有效', invalid: '无效' };
const NAMEFIX_STATUS_LABEL = { pending: '待审核', valid: '已处理', invalid: '无效' };
const CONTRIB_STATUS_LABEL = { valid: '已通过', pending: '待审核', dup: '重复', fabricated: '虚假', merged: '已合并', blocked: '已驳回' };
const CONTRIB_TYPE_LABEL = { dish: '菜名', ingredient: '食材', tip: '提示', pattern: '模式' };

Page({
  data: {
    isAdmin: false,
      showLogin: false,
      loginOpenid: '',
      loginPwd: '',
    alert: { show: false, title: '', content: '' },
    approveConfirm: { show: false, approveCount: 0, skipCount: 0, list: [], overflow: 0 },
    openid: '',
    tab: 0,
    tabs: ['发次', '黑名单', '反馈', '贡献', '备份', '公告', '账户', '协同过滤', '采样', '数据看板', '截断修复', '兑换码', '用户管理', '探索菜库', '通用配置', '画像审核', '营养审核', '做法审核', '菜图审核', 'env2菜审核', 'env1菜库总览'],

    // —— 通用配置（dynamicTabs，2026-08-18）——
    // 该 tab 根据下方 SCHEMA 动态渲染，新增 A 类 / 简单 B 类管理功能时：
    //   ① 在 adminGeneric 云函数 ALLOWED 白名单追加 docId + 字段；
    //   ② 在下方 SCHEMA 追加对应 section + 字段定义（type: boolean/enum/string）。
    // 即可在管理界面出现，无需新增独立 tab，也无需为功能改前端发版（改已登记字段值更是零发版）。
    // type 说明：boolean→开关；enum→下拉(需 options:[{label,value}])；string→文本输入。
    dynLoading: false,
    dynSections: [
      {
        title: 'AI 自定义通道（文本）',
        docId: 'ai_custom',
        switchKey: 'enabled',
        switchLabel: '启用自定义通道',
        keyEnv: 'CUSTOM_AI_KEY',
        tip: '免费混元额度到期后，可把文本出文整体切到自备平台。mode=fallback 时混元主、自定义兜底；mode=replace 时完全用自定义平台。密钥在 adminGeneric 云函数环境变量 CUSTOM_AI_KEY 配置（不落库）。',
        fields: [
          { key: 'enabled', label: '启用自定义通道', type: 'boolean' },
          { key: 'mode', label: '模式', type: 'enum', options: [
            { label: '兜底(fallback)', value: 'fallback' },
            { label: '替换(replace)', value: 'replace' }
          ] },
          { key: 'baseUrl', label: '接口地址', type: 'string' },
          { key: 'model', label: '模型名', type: 'string' }
        ]
      },
      {
        title: 'AI 自定义通道（出图）',
        docId: 'ai_custom_image',
        switchKey: 'enabled',
        switchLabel: '启用自定义出图',
        keyEnv: 'CUSTOM_IMAGE_KEY',
        tip: '同上，针对菜品出图通道。密钥在 adminGeneric 云函数环境变量 CUSTOM_IMAGE_KEY 配置。',
        fields: [
          { key: 'enabled', label: '启用自定义出图', type: 'boolean' },
          { key: 'mode', label: '模式', type: 'enum', options: [
            { label: '兜底(fallback)', value: 'fallback' },
            { label: '替换(replace)', value: 'replace' }
          ] },
          { key: 'baseUrl', label: '接口地址', type: 'string' },
          { key: 'model', label: '模型名', type: 'string' }
        ]
      }
    ],
    // 当前各 section 的字段值（按 docId 存：{ docId: { fieldKey: value } }）
    dynValues: {},
    // enum 字段当前选中的 option 下标（与 dynValues 平行，便于 picker 显示）
    dynIndex: {},
    // —— env2 菜审核（tab 19，manageEnv2Regen 云函数）——
    env2ReviewLoading: false,
    env2ReviewList: [],
    env2PreviewShow: false,
    env2PreviewData: null,
    env2RejectShow: false,
    env2RejectId: '',
    env2RejectName: '',
    env2RejectReason: '',
    env2RejectReasonCode: '',
    env2RejectReasonOptions: [
      { label: '做法不符实际', value: 'guide_bad' },
      { label: '食材不合理', value: 'ingredients_bad' },
      { label: '营养偏差大', value: 'nutrition_bad' },
      { label: '图片质量差', value: 'image_bad' },
      { label: '画像标签错', value: 'profile_bad' },
      { label: '菜名不当', value: 'name_bad' },
      { label: '其他', value: 'other' },
    ],
    env2RejectReasonIndex: 0,

    // —— env1 菜库总览（tab 20，manageEnv2Regen listLexicon）——
    env1LexiconLoading: false,
    env1LexiconList: [],
    env1LexiconTotal: 0,
    env1LexiconOffset: 0,
    env1LexiconKeyword: '',

    stats: null,
    statsLoading: false,
    maxTrend: 1,

    // 选择器选项（含中文标签；wxml 不支持内联数组字面量，range 必须放 data）
    feedbackStatusOptions: [
      { label: '待审核', value: 'pending' },
      { label: '有效', value: 'valid' },
      { label: '无效', value: 'invalid' },
      { label: '全部', value: '' }
    ],
    contribStatusOptions: [
      { label: '待审核', value: 'review' },
      { label: '重复', value: 'dup' },
      { label: '虚假', value: 'fabricated' },
      { label: '已合并', value: 'merged' },
      { label: '已驳回', value: 'blocked' }
    ],
    blockTypeOptions: [
      { label: '词', value: 'word' },
      { label: '示例菜名', value: 'example' },
      { label: '菜名', value: 'dish' },
      { label: '食材', value: 'ingredient' }
    ],
    feedbackFilterIndex: 0,
    contribFilterIndex: 0,
    blockTypeIndex: 0,

    // 截断修复反馈（dish_name_fix 隔离表，系统误伤类不进黑名单，但 valid 审核照常发次）
    nameFixStatusOptions: [
      { label: '待审核', value: 'pending' },
      { label: '已处理', value: 'valid' },
      { label: '无效', value: 'invalid' }
    ],
    nameFixFilterIndex: 0,
    nameFixList: [],

    // 发次 / 用户查询
    grantOpenid: '',
    grantCount: '',
    userKey: '',
    userInfo: null,

    // CF影子模式开关与就绪进度（管理员后台，2026-08-07）
    // 协同过滤默认关，避免小样本失真。需数据达标（computeCF 产出 cf_ready）后再开。
    cfLoading: false,
    cfEnabled: false,         // 总开关是否开启
    cfReady: false,           // 数据是否已达标（可开）
    cfCanEnable: false,       // 数据达标但开关仍关 → 提示管理员"可以开了"
    cfUsers: 0,
    cfPairs: 0,
    cfItems: 0,
    cfThresholdUsers: 200,    // 活跃用户门槛（computeCF 同款常量）
    cfThresholdPairs: 800,    // 有效共现对门槛
    cfUsersPct: 0,            // 进度条百分比（前端预计算，wxml 不支持 Math）
    cfPairsPct: 0,
    cfComputedAt: 0,
    cfComputedAtText: '',     // 格式化后的计算时间（wxml 不能调 fmt 函数，预计算）

    // B② Thompson 采样开关与进度（管理员后台，2026-08-08）
    // Thompson 采样默认关，避免小样本失真。仅在 enabled 且单臂 accept>=minSuccess 且 cnt>=minTotal 时启用。
    thLoading: false,
    thEnabled: false,          // 总开关是否开启
    thMinSuccess: 15,          // 单臂达标最小采纳数门槛
    thMinTotal: 30,            // 单臂达标最小推送数门槛
    thArms: 0,                 // 探索方向总数（dish_exposure 中 EXPLORE::* 文档数）
    thArmsQualified: 0,        // 已达标臂数（cnt>=minTotal 且 accept>=minSuccess）
    thArmsPct: 0,              // 达标率进度条百分比（前端预计算）
    thTotalCnt: 0,             // 探索总推送次数
    thTotalAccept: 0,          // 探索总采纳次数
    thAcceptRate: 0,           // 探索总采纳率
    thAcceptRatePct: 0,        // 采纳率进度条百分比
    thUpdatedAt: 0,
    thUpdatedAtText: '',       // 格式化后的更新时间
    thArmsList: [],            // 逐臂明细（{dir,cnt,accept,qualified}），可展开列表
    thShowList: false,         // 是否展开明细列表

    // 黑名单
    blocklist: [],
    blockTerm: '',
    blockType: 'word',
    blockNote: '',

    // 反馈
    feedbackList: [],
    opinionList: [],
    feedbackFilter: 'pending',

    // 贡献
    contribList: [],
    contribFilter: 'review',
    contribStats: null,
    categoryOptions: ING_CATEGORIES,
    showCatSheet: false,
    catEditId: '',
    catEditValue: '',

    // 备份
    backups: [],

    // 公告
    annContent: '',
    // 使用说明（guide_docs，2026-08-14）
    guideContent: '',

    // 账户
    targetOpenid: '',

    // 兑换码管理（manageRedeem，2026-08-11）
    rdCode: '',
    rdCount: '',
    rdQuota: '',
    rdExpire: '',
    rdDesc: '',
    redeemList: [],
    rdTotal: 0,
    rdActive: 0,
    rdLifeUsed: 0,

    // 用户管理（tab 12）：用户列表 + 精确查询
    userList: [],
    userTotal: 0,
    userPage: 0,
    userPageSize: 20,
    userPages: 0,
    userLoading: false,
    userQueryKey: '',
    userQueryResult: null,
    userBanLoading: false,

    // 探索菜库审核（tab 13，2026-08-17）：dish_lexicon_pending 审核池
    lexiconList: [],
    lexiconFilter: 'pending',
    lexiconStatusOptions: [
      { label: '待审核', value: 'pending' },
      { label: '已通过', value: 'approved' },
      { label: '已驳回', value: 'rejected' }
    ],
    lexiconFilterIndex: 0,
    lexiconLoading: false,
    // 产物分流审核（tab 15-18，2026-08-21）
    pendingReviewList: [],
    pendingReviewFilter: 'pending',
    pendingReviewLoading: false,
    pendingReviewFilterIndex: 0,
    pendingReviewStatusOptions: [
      { label: '待审核', value: 'pending' },
      { label: '已通过', value: 'approved' },
      { label: '已驳回', value: 'rejected' }
    ],

    loading: false
  },

  call(name, data, opts = {}) {
    const timeout = opts.timeout || 20000;
    const retries = opts.retries != null ? opts.retries : 1;
    const attempt = (n) => new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name, data, timeout,
        success: r => resolve(r.result),
        fail: (err) => {
          // 冷启动导致的 3s 握手超时(-504003)：重试一次命中热实例
          if (n < retries) { attempt(n + 1).then(resolve, reject); }
          else reject(err);
        }
      });
    });
    return attempt(0);
  },

  async   onLoad() {
    // 进入后台先校验：openid + 密码 双重验证（adminLogin 服务端比对），通过后才加载面板
    // 不做自动聚焦：微信 input 原生点击即聚焦，focus 属性常驻会持续抢焦点（密码框点不进去）
    // 密码框不用 password 属性：安卓上 password 会唤起密码键盘导致键盘弹出又收起（微信官方已知 bug，多年未修），
    // 改为 type=text 普通键盘 + JS 掩码（onLoginPwd），真实密码存 this._pwdReal，不进入 data。
    this._pwdReal = '';
    this.setData({ showLogin: true, isAdmin: false, loginPwd: '' });
  },

  onShow() {
    // 进入即拉取数据看板统计
    if (this.data.isAdmin) {
      this.loadAdminStats();
      // autoSyncEnv2 已关闭，改为 tab 19 手动触发
    }
  },

  // 自动同步 env2 产物（30 分钟节流，静默执行不阻塞 UI）
  // 管理员进后台即触发：syncFromEnv2（拉 env2 新菜到审核池）+ syncLexiconToEnv2（推菜名到 env2 供去重）
  autoSyncEnv2() {
    const LAST_KEY = 'env2_sync_last_ts';
    const INTERVAL = 30 * 60 * 1000;
    try {
      const last = wx.getStorageSync(LAST_KEY) || 0;
      if (Date.now() - last < INTERVAL) return;
    } catch (e) { /* */ }
    wx.setStorageSync(LAST_KEY, Date.now());
    wx.cloud.callFunction({ name: 'syncFromEnv2', data: { batchSize: 15 }, timeout: 60000 }).then(r => {
      const d = r && r.result;
      if (d && d.ok) console.log('[autoSync] syncFromEnv2:', d.synced, '同步', d.skipped, '跳过', d.failed, '失败', d.imgSynced, '图', d.remaining, '剩余');
      else console.warn('[autoSync] syncFromEnv2:', d && d.err);
    }).catch(e => console.warn('[autoSync] syncFromEnv2 fail:', e));
    // syncImages：前 5 轮 force=true 强制覆盖旧图片，5 轮后自动切回只补缺
    const FORCE_COUNT_KEY = 'env2_img_force_count';
    const OFFSET_KEY = 'env2_img_offset';
    const FORCE_MAX = 5;
    let forceImg = false, forceCount = 0, imgOffset = 0;
    try { forceCount = wx.getStorageSync(FORCE_COUNT_KEY) || 0; if (forceCount < FORCE_MAX) forceImg = true; } catch (e) { /* */ }
    try { imgOffset = wx.getStorageSync(OFFSET_KEY) || 0; } catch (e) { /* */ }
    wx.cloud.callFunction({ name: 'syncFromEnv2', data: { syncImages: true, force: forceImg, imgBatchSize: 50, offset: imgOffset }, timeout: 60000 }).then(r => {
      const d = r && r.result;
      if (d && d.ok) {
        console.log('[autoSync] syncImages:', d.imgSynced, '图同步', d.imgFailed, '失败', d.imgSkipped, '跳过', d.remaining, '剩余', forceImg ? '(force ' + (forceCount + 1) + '/' + FORCE_MAX + ')' : '', 'offset=' + imgOffset);
        let nextOffset = d.nextOffset || 0;
        if (nextOffset >= d.total) nextOffset = 0;
        try { wx.setStorageSync(OFFSET_KEY, nextOffset); } catch (e) { /* */ }
        if (forceImg && (d.imgSynced > 0 || d.imgFailed > 0)) { try { wx.setStorageSync(FORCE_COUNT_KEY, forceCount + 1); } catch (e) { /* */ } }
      } else console.warn('[autoSync] syncImages:', d && d.err);
    }).catch(e => console.warn('[autoSync] syncImages fail:', e));
    wx.cloud.callFunction({ name: 'syncLexiconToEnv2' }).then(r => {
      const d = r && r.result;
      if (d && d.ok) console.log('[autoSync] syncLexiconToEnv2:', d.synced, '同步', d.skipped, '跳过', d.failed, '失败');
      else console.warn('[autoSync] syncLexiconToEnv2:', d && d.err);
    }).catch(e => console.warn('[autoSync] syncLexiconToEnv2 fail:', e));
  },

  // 统一自绘弹窗（替代行内提示）
  showAlert(title, content) {
    this.setData({ alert: { show: true, title: title || '提示', content: content || '' } });
  },
  closeAlert() {
    this.setData({ 'alert.show': false });
  },
  noop() {},

  onLoginOpenid(e) { this.setData({ loginOpenid: (e.detail.value || '').trim() }); },
  // JS 掩码密码框：value 显示 ●，真实密码存 this._pwdReal（支持追加/退格/中间插入/粘贴；约定密码不含 ●）
  onLoginPwd(e) {
    const v = e.detail.value || '';
    const real = this._pwdReal || '';
    let next;
    if (v.length < real.length) {
      // 删除：显示为掩码串，无法定位删除点，按末尾删除处理
      next = real.slice(0, v.length);
    } else {
      // 追加 / 中间插入 / 粘贴：逐字符重建（●=real 中对应位字符，其余=本次真实输入）
      let idx = 0, out = '';
      for (const ch of v) {
        if (ch === '●') { out += real[idx] || ''; idx++; }
        else { out += ch; }
      }
      next = out;
    }
    this._pwdReal = next;
    this.setData({ loginPwd: '●'.repeat(next.length) });
  },
  async doLogin() {
    const openid = this.data.loginOpenid;
    const password = this._pwdReal || '';
    if (!openid || !password) { wx.showToast({ title: '请输入 openid 与密码', icon: 'none' }); return; }
    this.setData({ loading: true });
    try {
      const r = await this.call('adminLogin', { openid, password });
      if (r && r.code === 200) {
        this._pwdReal = '';
        this.setData({ showLogin: false, isAdmin: true, openid });
        this.loadCFSwitch();   // 登录即拉取 CF 开关与就绪进度（全局展示，不限于数据看板 tab）
        this.loadThompson();   // 同步拉取 B② Thompson 采样开关与进度
        this.loadTab();
        // autoSyncEnv2 已关闭，改为 tab 19 手动触发
      } else {
        this.showAlert('登录失败', (r && r.msg) || '验证失败');
      }
    } catch (e) {
      clientLog.log('admin.login', e);
      this.showAlert('登录失败', '验证失败，请重试');
    } finally {
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    const t = Number(e.currentTarget.dataset.tab);
    if (t === this.data.tab) return;
    this.setData({ tab: t });
    this.loadTab();
  },

  loadTab() {
    const t = this.data.tab;
    if (t === 1) this.loadBlocklist();
    else if (t === 2) { this.loadFeedback(); this.loadOpinion(); }
    else if (t === 3) { this.loadContribStats(); this.loadContrib(); }
    else if (t === 4) this.loadBackups();
    else if (t === 5) { this.loadAnnouncement(); this.loadGuide(); }
    else if (t === 9) this.loadAdminStats();
    else if (t === 10) this.loadNameFix();
    else if (t === 11) this.loadRedeemCodes();
    else if (t === 12) this.loadUserList();
    else if (t === 13) this.loadLexiconList();
    else if (t === 14) this.dynLoad();
    else if (t >= 15 && t <= 18) this.loadPendingReview();
    else if (t === 19) this.loadEnv2Review();
    else if (t === 20) this.loadEnv1Lexicon();
  },

  // —— 探索菜库审核（manageLexicon 云函数，2026-08-17）——
  onLexiconFilter(e) {
    const idx = Number(e.detail.value);
    this.setData({ lexiconFilterIndex: idx, lexiconFilter: this.data.lexiconStatusOptions[idx].value });
    this.loadLexiconList();
  },
  async loadLexiconList() {
    if (!this.data.isAdmin) return;
    this.setData({ lexiconLoading: true });
    try {
      const r = await this.call('manageLexicon', { action: 'list', status: this.data.lexiconFilter });
      const list = (r && (r.pending || r.list)) || [];
      const formatted = list.map(it => ({
        _id: it._id,
        name: it.name,
        cuisine: it.cuisine || '家常',
        category: it.category || '',
        mealTime: Array.isArray(it.mealTime) ? it.mealTime.join('、') : (it.mealTime || ''),
        reason: it.reason || '',
        source: it.source || '',
        exploreDir: it.exploreDir || '',
        imageUrl: it.imageUrl || '',
        statusLabel: it.status === 'approved' ? '已通过' : it.status === 'rejected' ? '已驳回' : '待审核',
        statusClass: it.status === 'approved' ? 'st-valid' : it.status === 'rejected' ? 'st-block' : 'st-pending',
        timeText: it.ts ? (new Date(it.ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
      }));
      this.setData({ lexiconList: formatted });
    } catch (e) {
      this.showAlert('加载失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    } finally {
      this.setData({ lexiconLoading: false });
    }
  },
  async approveLexicon(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showLoading({ title: '处理中' });
    try {
      const r = await this.call('manageLexicon', { action: 'approve', id });
      wx.hideLoading();
      if (r && r.ok) {
        wx.showToast({ title: '已通过并入菜库', icon: 'success' });
        this.loadLexiconList();
      } else {
        this.showAlert('操作失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      wx.hideLoading();
      this.showAlert('操作失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },
  async rejectLexicon(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showLoading({ title: '处理中' });
    try {
      const r = await this.call('manageLexicon', { action: 'reject', id });
      wx.hideLoading();
      if (r && r.ok) {
        wx.showToast({ title: '已驳回', icon: 'none' });
        this.loadLexiconList();
      } else {
        this.showAlert('操作失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      wx.hideLoading();
      this.showAlert('操作失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },
  async deleteLexicon(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const ok = await new Promise(r => wx.showModal({
      title: '删除记录',
      content: '将彻底删除该已驳回记录，不可恢复。确定？',
      confirmText: '删除', confirmColor: '#E8533E', success: r
    }));
    if (!ok.confirm) return;
    wx.showLoading({ title: '处理中' });
    try {
      const r = await this.call('manageLexicon', { action: 'delete', id });
      wx.hideLoading();
      if (r && r.ok) {
        wx.showToast({ title: '已删除', icon: 'none' });
        this.loadLexiconList();
      } else {
        this.showAlert('操作失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      wx.hideLoading();
      this.showAlert('操作失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },

  // —— 产物分流审核（tab 15-18，manageLexicon listPending/approvePending，2026-08-21）——
  // tab 15=画像(dish_ai_profile_pending) 16=营养(dish_nutrition_pending) 17=做法(dish_guide_pending) 18=菜图(dish_image_pending)
  _pendingCollection() {
    const t = this.data.tab;
    if (t === 15) return 'dish_ai_profile_pending';
    if (t === 16) return 'dish_nutrition_pending';
    if (t === 17) return 'dish_guide_pending';
    if (t === 18) return 'dish_image_pending';
    return '';
  },
  onPendingReviewFilter(e) {
    const idx = Number(e.detail.value);
    this.setData({ pendingReviewFilterIndex: idx, pendingReviewFilter: this.data.pendingReviewStatusOptions[idx].value });
    this.loadPendingReview();
  },
  async loadPendingReview() {
    if (!this.data.isAdmin) return;
    const col = this._pendingCollection();
    if (!col) return;
    this.setData({ pendingReviewLoading: true });
    try {
      const r = await this.call('manageLexicon', { action: 'listPending', collection: col, status: this.data.pendingReviewFilter });
      const list = (r && r.list) || [];
      const formatted = list.map(it => {
        const item = {
          _id: it._id,
          name: it.name || '',
          source: it.source || '',
          statusLabel: it.status === 'approved' ? '已通过' : it.status === 'rejected' ? '已驳回' : '待审核',
          statusClass: it.status === 'approved' ? 'st-valid' : it.status === 'rejected' ? 'st-block' : 'st-pending',
          timeText: it.ts ? (new Date(it.ts)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
        };
        if (it.profile) {
          item.profile = {
            cuisine: it.profile.cuisine || '',
            type: it.profile.type || '',
            main: it.profile.main || '',
            spicy: it.profile.spicy || 0,
            isVeg: it.profile.isVeg ? '是' : '否',
            isSoup: it.profile.isSoup ? '是' : '否',
            flavorText: Array.isArray(it.profile.flavors) ? it.profile.flavors.join('、') : '',
            mealTimeText: Array.isArray(it.profile.mealTime) ? it.profile.mealTime.join('、') : '',
          };
        }
        if (Array.isArray(it.nutrition)) item.nutrition = it.nutrition;
        if (it.guide) item.guide = it.guide;
        if (it.imageUrl) item.imageUrl = it.imageUrl;
        if (Array.isArray(it.ingredients)) item.ingredients = it.ingredients;
        if (Array.isArray(it.steps)) item.steps = it.steps;
        if (it.review) item.review = it.review;
        if (it.difficulty) item.difficulty = it.difficulty;
        if (it.tips) item.tips = it.tips;
        return item;
      });
      this.setData({ pendingReviewList: formatted });
    } catch (e) {
      this.showAlert('加载失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    } finally {
      this.setData({ pendingReviewLoading: false });
    }
  },
  async approvePendingReview(e) {
    const id = e.currentTarget.dataset.id;
    const col = this._pendingCollection();
    if (!id || !col) return;
    wx.showLoading({ title: '处理中' });
    try {
      const r = await this.call('manageLexicon', { action: 'approvePending', collection: col, id });
      wx.hideLoading();
      if (r && r.ok) {
        wx.showToast({ title: '已通过', icon: 'success' });
        this.loadPendingReview();
      } else {
        this.showAlert('操作失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      wx.hideLoading();
      this.showAlert('操作失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },
  async rejectPendingReview(e) {
    const id = e.currentTarget.dataset.id;
    const col = this._pendingCollection();
    if (!id || !col) return;
    wx.showLoading({ title: '处理中' });
    try {
      const r = await this.call('manageLexicon', { action: 'rejectPending', collection: col, id });
      wx.hideLoading();
      if (r && r.ok) {
        // 驳回即纯净丢弃：不触发 env2 重生成（env2 重生成逻辑已由 manageEnv2Regen.rejectWithReason 移除）
        wx.showToast({ title: '已驳回', icon: 'none' });
        this.loadPendingReview();
      } else {
        this.showAlert('操作失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      wx.hideLoading();
      this.showAlert('操作失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },
  async deletePendingReview(e) {
    const id = e.currentTarget.dataset.id;
    const col = this._pendingCollection();
    if (!id || !col) return;
    const ok = await new Promise(r => wx.showModal({
      title: '删除记录', content: '将彻底删除该记录，不可恢复。确定？',
      confirmText: '删除', confirmColor: '#E8533E', success: r
    }));
    if (!ok.confirm) return;
    wx.showLoading({ title: '处理中' });
    try {
      const r = await this.call('manageLexicon', { action: 'deletePending', collection: col, id });
      wx.hideLoading();
      if (r && r.ok) {
        wx.showToast({ title: '已删除', icon: 'none' });
        this.loadPendingReview();
      } else {
        this.showAlert('操作失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      wx.hideLoading();
      this.showAlert('操作失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },

  // —— env2 菜审核（tab 19，manageEnv2Regen 云函数，2026-08-24）——
  async loadEnv2Review() {
    if (!this.data.isAdmin) return;
    this.setData({ env2ReviewLoading: true });
    try {
      const r = await this.call('manageLexicon', { action: 'list', status: 'pending' });
      const list = ((r && (r.pending || r.list)) || []).filter(it => it.source === 'env2-newdish');
      const formatted = list.map(it => ({
        _id: it._id,
        name: it.name,
        cuisine: it.cuisine || '家常',
        mealTime: Array.isArray(it.mealTime) ? it.mealTime.join('、') : (it.mealTime || ''),
        reason: it.reason || '',
        imageUrl: it.imageUrl || '',
        timeText: it.ts ? new Date(it.ts).toLocaleString() : '',
      }));
      this.setData({ env2ReviewList: formatted });
    } catch (e) {
      this.showAlert('加载失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    } finally {
      this.setData({ env2ReviewLoading: false });
    }
  },

  async runSync() {
    wx.showLoading({ title: '同步中' });
    try {
      const r = await this.call('syncFromEnv2', { batchSize: 15 }, { timeout: 60000 });
      if (r && r.ok) {
        const dbg = r.debug ? ('\n[调试] 查询=' + r.debug.dishes + ' 查重集=' + r.debug.existingNames + ' 跳重=' + r.debug.skipLexicon + ' 已存在=' + r.debug.skipExists) : '';
        wx.hideLoading();
        this.showAlert('同步完成', '已同步 ' + (r.synced || 0) + ' / 跳过 ' + (r.skipped || 0) + ' / 剩余 ' + (r.remaining || 0) + dbg);
        this.loadEnv2Review();
      } else {
        wx.hideLoading();
        this.showAlert('同步失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      wx.hideLoading();
      this.showAlert('同步失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },


  // 一键入库：先预览（统计将入库/重复丢弃 + 列出将入库菜），弹自绘确认框；点确认才执行真实入库
  async batchApproveLexicon() {
    wx.showLoading({ title: '统计中' });
    let preview;
    try {
      preview = await this.call('manageLexicon', { action: 'batchApprovePreview', limit: 200 }, { timeout: 60000 });
    } catch (e) {
      wx.hideLoading();
      this.showAlert('预览失败', (e && e.errMsg) || (e && e.message) || '未知错误');
      return;
    }
    wx.hideLoading();
    if (!preview || !preview.ok) { this.showAlert('预览失败', (preview && preview.err) || '未知错误'); return; }
    const approveCount = preview.approveCount || 0;
    const skipCount = preview.skipCount || 0;
    const toApprove = preview.toApprove || [];
    if (approveCount === 0) {
      this.showAlert('无需入库', '待入库菜 ' + (approveCount + skipCount) + ' 道，其中重复(将丢弃) ' + skipCount + ' 道，没有可入库的新菜。');
      return;
    }
    // 自绘确认弹窗：显示入库/丢弃数量 + 将入库菜品清单，底部取消/确认
    this.setData({
      approveConfirm: {
        show: true,
        approveCount, skipCount,
        list: toApprove.slice(0, 100),
        overflow: toApprove.length > 100 ? (toApprove.length - 100) : 0,
      }
    });
  },

  // 自绘确认弹窗 —— 取消
  cancelApprove() {
    this.setData({ 'approveConfirm.show': false });
  },

  // 自绘确认弹窗 —— 确认才执行真实入库
  async confirmApprove() {
    this.setData({ 'approveConfirm.show': false });
    wx.showLoading({ title: '入库中 0%' });
    const startTs = Date.now();
    try {
      let totalApproved = 0, totalFailed = 0, totalSkipped = 0, rounds = 0;
      const approvedList = [], failedList = [];
      let lastRemaining = -1, noProgressCount = 0, noShrinkCount = 0;
      while (true) {
        rounds++;
        const r = await this.call('manageLexicon', { action: 'batchApprove', limit: 50 }, { timeout: 60000, retries: 2 });
        if (!r || !r.ok) { wx.hideLoading(); this.showAlert('入库失败', (r && r.err) || '未知错误'); return; }
        const roundApproved = (r.approved || 0), roundFailed = (r.failed || 0), roundSkipped = (r.skipped || 0);
        totalApproved += roundApproved;
        totalFailed += roundFailed;
        totalSkipped += roundSkipped;
        if (r.details && r.details.length) {
          for (const d of r.details) {
            if (d.status === 'ok' && d.name) approvedList.push(d.name);
            else if (d.status === 'fail' && d.name) failedList.push(d.name);
          }
        }
        const remaining = r.remaining || 0;
        // 无进展终止保护：本批一个都没处理（全部待办被卡住）→ 连续 2 轮终止，避免空转虚假累加
        if (roundApproved + roundFailed + roundSkipped === 0) noProgressCount++;
        else noProgressCount = 0;
        // remaining 不降保护：连续 3 轮 pending 数不下降（approveDish 持续失败不清理）→ 终止
        if (lastRemaining >= 0 && remaining >= lastRemaining) noShrinkCount++;
        else noShrinkCount = 0;
        lastRemaining = remaining;
        const pct = remaining ? (totalApproved > 0 ? Math.round(totalApproved / (totalApproved + remaining) * 100) : 0) : 100;
        wx.showLoading({ title: '入库中 ' + pct + '%' });
        if (remaining === 0 || rounds >= 50 || noProgressCount >= 2 || noShrinkCount >= 3) break;
      }
      wx.hideLoading();
      // 用 ts 时间窗核对本次真实入库（避免冷启动超时导致累加为 0 的误导）：覆盖 startTs 前后的容差
      let realNames = approvedList;
      try {
        const since = Math.max(0, startTs - 5000);
        const cnt = await this.call('manageLexicon', { action: 'countApprovedSince', since }, { timeout: 15000 });
        if (cnt && cnt.ok && cnt.names && cnt.names.length) realNames = cnt.names;
      } catch (_) { /* 核对失败则用累加结果 */ }
      const finalApproved = realNames.length || totalApproved;
      // 结果弹窗：入库几项 / 丢弃(重复)几项 + 入库清单
      const okNames = realNames.slice(0, 40);
      const failNames = failedList.slice(0, 20);
      let content = '入库 ' + finalApproved + ' 道 / 丢弃(重复) ' + (totalSkipped + totalFailed) + ' 道';
      if (okNames.length) {
        content += '\n\n【已入库】\n' + okNames.join('\n') + (realNames.length > 40 ? '\n…共 ' + realNames.length + ' 道' : '');
      }
      if (failNames.length) {
        content += '\n\n【入库失败】\n' + failNames.join('\n') + (failedList.length > 20 ? '\n…共 ' + failedList.length + ' 道' : '');
      }
      this.showAlert('入库完成', content);
      this.loadEnv2Review();
    } catch (e) {
      wx.hideLoading();
      // 超时/异常兜底：若调用失败但 pending 已清空，多半是入库已完成（前次调用已成功，本次冗余调用超时），提示刷新而非误报失败
      try {
        const chk = await this.call('manageLexicon', { action: 'batchApprovePreview', limit: 1 }, { timeout: 15000 });
        if (chk && chk.ok && (chk.approveCount + chk.skipCount) === 0) {
          this.showAlert('入库可能已完成', '本次调用超时，但审核池已无待入库菜，菜可能已成功入库。请刷新管理页确认；如确已入库无需重复操作。');
          this.loadEnv2Review();
          return;
        }
      } catch (_) { /* 忽略二次检查失败，走下方通用提示 */ }
      this.showAlert('入库异常', ((e && e.errMsg) || (e && e.message) || '未知错误') + '\n（可能网络超时，可重试；若审核池已空说明已入库完成）');
    }
  },

  // 清理脏残留：dish_lexicon_pending 里主库 dish_lexicon 已存在同名的记录（菜已入库但 pending 因超时未删），仅删 pending 记录
  async cleanResidual() {
    const ok = await new Promise(r => wx.showModal({
      title: '清理脏残留',
      content: '将删除审核池中「主库已存在同名」的菜记录（这些菜已入库，仅留待审残影）。不影响主库与分表数据。确定？',
      confirmText: '开始清理', success: r
    }));
    if (!ok.confirm) return;
    wx.showLoading({ title: '清理中 0%' });
    try {
      let totalCleaned = 0, totalKept = 0, rounds = 0;
      while (true) {
        rounds++;
        const r = await this.call('manageLexicon', { action: 'cleanApprovedResidual', batch: 20 }, { timeout: 60000 });
        if (!r || !r.ok) { wx.hideLoading(); this.showAlert('清理失败', (r && r.err) || '未知错误'); return; }
        totalCleaned += (r.cleaned || 0);
        totalKept += (r.kept || 0);
        const remaining = r.remaining || 0;
        const pct = remaining ? Math.round(totalCleaned / (totalCleaned + remaining) * 100) : 100;
        wx.showLoading({ title: '清理中 ' + pct + '%' });
        if (remaining === 0 || rounds >= 100) break;
      }
      wx.hideLoading();
      this.showAlert('清理完成', '已清理脏残留 ' + totalCleaned + ' 条 / 保留未入库 ' + totalKept + ' 条');
      this.loadEnv2Review();
    } catch (e) {
      wx.hideLoading();
      this.showAlert('清理异常', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },

  // 点「驳回」直接执行（无原因弹层），默认原因 = 第一个原因选项
  openReject(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const opts = (this.data.env2RejectReasonOptions || []);
    const reasonCode = (opts[0] && opts[0].value) || 'other';
    this.submitReject({ id, name, reasonCode, reasonText: (opts[0] && opts[0].label) || '管理员驳回' });
  },

  async submitReject({ id, name, reasonCode, reasonText }) {
    if (!id) return;
    wx.showLoading({ title: '提交中' });
    try {
      // 纯净驳回 + 联动删除 env2 真库同名菜 + 写审计（不触发 env2 重生成）
      const r = await this.call('manageEnv2Regen', { action: 'rejectWithReason', id, reasonCode, reason: reasonText });
      wx.hideLoading();
      if (!r || !r.ok) {
        this.showAlert('驳回失败', (r && r.err) || '未知错误');
        return;
      }
      const env2Deleted = (r && r.env2Deleted) || 0;
      const tip = env2Deleted > 0
        ? '已驳回并从 env2 删除 ' + env2Deleted + ' 条'
        : '已驳回（env2 删除未生效，请检查）';
      wx.showToast({ title: tip, icon: env2Deleted > 0 ? 'none' : 'warn' });
      this.loadEnv2Review();
    } catch (e) {
      wx.hideLoading();
      this.showAlert('驳回失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    }
  },

  // —— env1 菜库总览（tab 20，manageEnv2Regen listLexicon，2026-08-24）——
  async loadEnv1Lexicon() {
    if (!this.data.isAdmin) return;
    this.setData({ env1LexiconLoading: true });
    try {
      const r = await this.call('manageEnv2Regen', { action: 'listLexicon', offset: this.data.env1LexiconOffset, limit: 100, keyword: this.data.env1LexiconKeyword });
      if (r && r.ok) {
        this.setData({ env1LexiconList: r.list || [], env1LexiconTotal: r.total || 0 });
      } else {
        this.showAlert('加载失败', (r && r.err) || '未知错误');
      }
    } catch (e) {
      this.showAlert('加载失败', (e && e.errMsg) || (e && e.message) || '未知错误');
    } finally {
      this.setData({ env1LexiconLoading: false });
    }
  },

  onEnv1LexiconSearch(e) {
    this.setData({ env1LexiconKeyword: e.detail.value, env1LexiconOffset: 0 });
  },

  doEnv1LexiconSearch() {
    this.loadEnv1Lexicon();
  },

  env1LexiconPrevPage() {
    const offset = Math.max(0, this.data.env1LexiconOffset - 100);
    this.setData({ env1LexiconOffset: offset });
    this.loadEnv1Lexicon();
  },

  env1LexiconNextPage() {
    const offset = this.data.env1LexiconOffset + 100;
    if (offset >= this.data.env1LexiconTotal) return;
    this.setData({ env1LexiconOffset: offset });
    this.loadEnv1Lexicon();
  },

  // 整菜丢弃：tab20 菜库总览驳回 → 删除 env1 各 _pending 同名记录（不重生成）
  async env1LexiconReject(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    wx.showModal({
      title: '驳回并丢弃',
      content: '将「' + name + '」从审核池整菜删除（不重生成）。确定？',
      confirmText: '驳回丢弃',
      confirmColor: '#E8533E',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '提交中' });
        try {
          const rr = await this.call('manageEnv2Regen', { action: 'deleteLexicon', name });
          wx.hideLoading();
          if (rr && rr.ok) wx.showToast({ title: '已丢弃（不收录）', icon: 'none' });
          else this.showAlert('提交失败', (rr && rr.err) || '未知错误');
        } catch (e2) {
          wx.hideLoading();
          this.showAlert('提交失败', (e2 && e2.errMsg) || (e2 && e2.message) || '未知错误');
        }
      }
    });
  },

  // —— 兑换码管理（manageRedeem 云函数，2026-08-11）——
  onRdCode(e) { this.setData({ rdCode: (e.detail.value || '').trim().toUpperCase() }); },
  onRdCount(e) { this.setData({ rdCount: (e.detail.value || '').trim() }); },
  onRdQuota(e) { this.setData({ rdQuota: (e.detail.value || '').trim() }); },
  onRdExpire(e) { this.setData({ rdExpire: (e.detail.value || '').trim() }); },
  onRdDesc(e) { this.setData({ rdDesc: (e.detail.value || '').trim() }); },
  async createRedeemCode() {
    const count = parseInt(this.data.rdCount, 10);
    const quota = parseInt(this.data.rdQuota, 10);
    if (!count || count <= 0) { wx.showToast({ title: '每张次数须为正整数', icon: 'none' }); return; }
    if (!quota || quota <= 0) { wx.showToast({ title: '总可兑换人数须为正整数', icon: 'none' }); return; }
    const expireRaw = (this.data.rdExpire || '').trim();
    let expireAt = '';
    if (expireRaw) {
      if (!/^\d+$/.test(expireRaw)) { wx.showToast({ title: '有效期须为天数(纯数字)', icon: 'none' }); return; }
      expireAt = Number(expireRaw);
    }
    const payload = { action: 'create', count, quota, expireAt, desc: this.data.rdDesc || '' };
    if (this.data.rdCode) {
      if (!/^[A-Za-z0-9_-]{4,40}$/.test(this.data.rdCode)) { wx.showToast({ title: '码格式不正确(4~40位字母数字_-)', icon: 'none' }); return; }
      payload.code = this.data.rdCode;
    }
    this.setData({ loading: true });
    try {
      const r = await this.call('manageRedeem', payload);
      if (r && r.code === 200) {
        const d = r.data || {};
        const succ = '已建码：' + d.code + '（每张 ' + d.count + ' 次 / 共 ' + d.quota + ' 人' + (d.expireAt ? ' / 有效期至 ' + fmt(d.expireAt) : '') + '）';
        this.setData({ rdCode: '', rdCount: '', rdQuota: '', rdExpire: '', rdDesc: '' });
        this.loadRedeemCodes();
        this.showAlert('兑换码已生成', succ);
      } else {
        this.showAlert('生成失败', (r && r.msg) || '未知错误');
      }
    } catch (e) { clientLog.log('admin.genCode', e); this.showAlert('生成失败', '调用失败'); }
    finally { this.setData({ loading: false }); }
  },
  async loadRedeemCodes() {
    try {
      const r = await this.call('manageRedeem', { action: 'list' });
      if (r && r.code === 200) {
        const src = (r.data && r.data.list) || [];
        const list = src.map(x => Object.assign({}, x, {
          expireText: x.expireAt ? fmt(x.expireAt) : '长期有效',
          statusLabel: x.active ? (x.used >= x.quota ? '已领完' : '启用中') : '已停用',
          statusClass: x.active ? (x.used >= x.quota ? 'st-block' : 'st-valid') : 'st-invalid'
        }));
        const rdTotal = list.length;
        const rdActive = list.filter(x => x.active).length;
        const rdLifeUsed = src.reduce((s, x) => s + (Number(x.used) || 0) * (Number(x.count) || 0), 0);
        this.setData({ redeemList: list, rdTotal, rdActive, rdLifeUsed });
      }
    } catch (e) {}
  },
  async disableRedeemCode(e) {
    const code = e.currentTarget.dataset.code;
    const ok = await new Promise(r => wx.showModal({ title: '停用兑换码', content: '将停用「' + code + '」（已领的次仍有效，仅不再接受新兑换）。确定？', confirmText: '停用', confirmColor: '#E8533E', success: r }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageRedeem', { action: 'disable', code });
      if (r && r.code === 200) { this.loadRedeemCodes(); wx.showToast({ title: '已停用', icon: 'none' }); }
      else wx.showToast({ title: '操作失败：' + ((r && r.msg) || ''), icon: 'none' });
    } catch (e) { wx.showToast({ title: '操作失败', icon: 'none' }); }
  },
  async deleteRedeemCode(e) {
    const code = e.currentTarget.dataset.code;
    const ok = await new Promise(r => wx.showModal({ title: '删除兑换码', content: '将彻底删除「' + code + '」及其兑换记录，不可恢复。确定？', confirmText: '删除', confirmColor: '#E8533E', success: r }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageRedeem', { action: 'delete', code });
      if (r && r.code === 200) { this.loadRedeemCodes(); wx.showToast({ title: '已删除', icon: 'none' }); }
      else wx.showToast({ title: '操作失败：' + ((r && r.msg) || ''), icon: 'none' });
    }     catch (e) { wx.showToast({ title: '操作失败', icon: 'none' }); }
  },
  copyRedeemCode(e) {
    const code = e.currentTarget.dataset.code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '已复制 ' + code, icon: 'none' })
    });
  },

  // —— 发次发放 ——
  onGrantOpenid(e) { this.setData({ grantOpenid: (e.detail.value || '').trim() }); },
  onGrantCount(e) { this.setData({ grantCount: (e.detail.value || '').trim() }); },
  async doGrant() {
    const key = (this.data.grantOpenid || '').trim();
    const count = parseInt(this.data.grantCount, 10);
    if (!key) { wx.showToast({ title: '请输入 openid 或编号', icon: 'none' }); return; }
    // 支持两种输入：openid（10~64 位字母数字/_/-） 或 纯数字编号（自动解析为 openid）
    const isNo = /^\d+$/.test(key);
    const isOpenid = /^[a-zA-Z0-9_-]{10,64}$/.test(key);
    if (!isNo && !isOpenid) { wx.showToast({ title: '请输入正确的 openid 或数字编号', icon: 'none' }); return; }
    if (!count || count <= 0) { wx.showToast({ title: '次数须为正整数', icon: 'none' }); return; }
    this.setData({ loading: true });
    try {
      const payload = isNo ? { no: Number(key), count } : { openid: key, count };
      const r = await this.call('grantBonus', payload);
      if (r && r.code === 200) {
        this.showAlert('发放成功', '已发放 ' + count + ' 次');
      } else {
        this.showAlert('发放失败', (r && r.msg) || '未知错误');
      }
    } catch (e) { clientLog.log('admin.grantByNo', e); this.showAlert('发放失败', '调用失败'); }
    finally { this.setData({ loading: false }); }
  },

  // 一键给自己发次（管理员无数字编号，避免手输长 openid）
  async grantSelf() {
    const count = parseInt(this.data.grantCount, 10);
    if (!count || count <= 0) { wx.showToast({ title: '次数须为正整数', icon: 'none' }); return; }
    if (!this.data.openid) { wx.showToast({ title: '未获取到管理员身份', icon: 'none' }); return; }
    this.setData({ loading: true });
    try {
      const r = await this.call('grantBonus', { openid: this.data.openid, count });
      if (r && r.code === 200) {
        this.showAlert('发放成功', '已给自己发放 ' + count + ' 次');
      } else {
        this.showAlert('发放失败', (r && r.msg) || '未知错误');
      }
    } catch (e) { this.showAlert('发放失败', '调用失败'); }
    finally { this.setData({ loading: false }); }
  },

  // —— 用户管理（tab 12：用户列表 + 精确查询）——
  // 用户列表（分页拉取）
  async loadUserList(page) {
    const p = typeof page === 'number' ? page : this.data.userPage;
    this.setData({ userLoading: true });
    try {
      const r = await this.call('manageUser', { action: 'list', page: p, pageSize: this.data.userPageSize, callerOpenid: this.data.openid });
      if (r && r.code === 200) {
        const d = r.data || {};
        this.setData({
          userList: d.list || [],
          userTotal: d.total || 0,
          userPage: d.page || 0,
          userPages: d.pages || 0
        });
      } else {
        this.showAlert('加载失败', (r && r.msg) || '未知错误');
      }
    } catch (e) { clientLog.log('admin.loadUsers', e); this.showAlert('加载失败', '调用失败'); }
    finally { this.setData({ userLoading: false }); }
  },
  onUserPagePrev() {
    if (this.data.userPage > 0) this.loadUserList(this.data.userPage - 1);
  },
  onUserPageNext() {
    if (this.data.userPage + 1 < this.data.userPages) this.loadUserList(this.data.userPage + 1);
  },
  // 点列表中某用户 → 优先用编号、无编号时用 openid 精确查询详情
  async onUserListTap(e) {
    const no = e.currentTarget.dataset.no;
    const oid = e.currentTarget.dataset.openid || '';
    if (no == null && !oid) return;
    this.setData({ userQueryKey: no != null ? String(no) : oid, userQueryResult: null });
    this.doUserQuery();
  },

  // 精确查询
  onUserKey(e) { this.setData({ userQueryKey: (e.detail.value || '').trim() }); },
  async doUserQuery() {
    const key = this.data.userQueryKey;
    if (!key) { wx.showToast({ title: '输入 openid 或 userNo', icon: 'none' }); return; }
    this.setData({ loading: true });
    try {
      const data = /^\d+$/.test(key) ? { userNo: Number(key) } : { openid: key };
      const r = await this.call('manageUser', Object.assign({ callerOpenid: this.data.openid }, data));
      if (r && r.code === 200) this.setData({ userQueryResult: r.data });
      else this.showAlert('查询失败', (r && r.msg) || '未知错误');
    } catch (e) { clientLog.log('admin.queryUser', e); this.setData({ userQueryResult: null }); }
    finally { this.setData({ loading: false }); }
  },

  // 封禁 / 解封查询到的用户
  async toggleBan() {
    const u = this.data.userQueryResult;
    if (!u || !u.openid) { wx.showToast({ title: '请先查询用户', icon: 'none' }); return; }
    const action = u.banned ? 'unban' : 'ban';
    const ok = await new Promise(r => wx.showModal({
      title: action === 'ban' ? '封禁用户' : '解封用户',
      content: action === 'ban' ? '封禁后该用户将无法使用本小程序（每次打开即被拦截）。确定封禁？' : '确定解封该用户？',
      confirmColor: action === 'ban' ? '#E8533E' : '#007aff',
      success: r
    }));
    if (!ok.confirm) return;
    this.setData({ userBanLoading: true });
    try {
      const r = await this.call('manageUser', { openid: u.openid, action, callerOpenid: this.data.openid });
      if (r && r.code === 200) {
        this.setData({ userQueryResult: Object.assign({}, u, { banned: r.data.banned }) });
        wx.showToast({ title: r.data.banned ? '已封禁' : '已解封', icon: 'success' });
      } else {
        wx.showToast({ title: '操作失败：' + ((r && r.msg) || ''), icon: 'none' });
      }
    } catch (e) { clientLog.log('admin.banUser', e); wx.showToast({ title: '操作失败', icon: 'none' }); }
    finally { this.setData({ userBanLoading: false }); }
  },

  // —— 黑名单 ——
  onBlockTerm(e) { this.setData({ blockTerm: (e.detail.value || '').trim() }); },
  onBlockType(e) {
    const idx = Number(e.detail.value);
    this.setData({ blockTypeIndex: idx, blockType: this.data.blockTypeOptions[idx].value });
  },
  onBlockNote(e) { this.setData({ blockNote: (e.detail.value || '').trim() }); },
  async loadBlocklist() {
    try {
      const r = await this.call('manageBlocklist', { action: 'list' });
      if (r && r.code === 200) {
        const list = (r.data || []).map(x => Object.assign({}, x, {
          term: x.term || x._id || '',
          typeLabel: BLOCK_TYPE_LABEL[x.type] || x.type || '未分类'
        }));
        this.setData({ blocklist: list });
      }
    } catch (e) {}
  },
  async addBlock() {
    const term = this.data.blockTerm;
    if (!term) { wx.showToast({ title: '请输入词', icon: 'none' }); return; }
    this.setData({ loading: true });
    try {
      const r = await this.call('manageBlocklist', { action: 'add', term, type: this.data.blockType, note: this.data.blockNote });
      if (r && r.code === 200) {
        this.setData({ blockTerm: '', blockNote: '' });
        this.loadBlocklist();
        this.showAlert('添加成功', '已添加：' + term);
      } else {
        this.showAlert('添加失败', (r && r.msg) || '未知错误');
      }
    } catch (e) { this.showAlert('添加失败', '调用失败'); }
    finally { this.setData({ loading: false }); }
  },
  async removeBlock(e) {
    const id = e.currentTarget.dataset.id;
    const term = e.currentTarget.dataset.term || '';
    const ok = await new Promise(r => wx.showModal({ title: '删除黑名单词', content: '确定删除「' + term + '」？', confirmText: '删除', confirmColor: '#E8533E', success: r }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageBlocklist', { action: 'remove', id });
      if (r && r.code === 200) { this.loadBlocklist(); wx.showToast({ title: '已删除', icon: 'none' }); }
      else wx.showToast({ title: '删除失败', icon: 'none' });
    } catch (e) { wx.showToast({ title: '删除失败', icon: 'none' }); }
  },

  // —— 反馈审核 ——
  onFeedbackFilter(e) {
    const idx = Number(e.detail.value);
    this.setData({ feedbackFilterIndex: idx, feedbackFilter: this.data.feedbackStatusOptions[idx].value });
    this.loadFeedback();
  },
  async loadFeedback() {
    try {
      const r = await this.call('manageFeedback', { action: 'list', status: this.data.feedbackFilter });
      if (r && r.code === 200) {
        const list = (r.data || []).map(x => Object.assign({}, x, { timeText: fmt(x.ts), statusClass: STATUS_CLASS[x.status] || '', statusLabel: FB_STATUS_LABEL[x.status] || x.status || '' }));
        this.setData({ feedbackList: list });
      }
    } catch (e) {}
  },
  async reviewFeedback(e) {
    const id = e.currentTarget.dataset.id;
    const decision = e.currentTarget.dataset.decision;
    const source = e.currentTarget.dataset.source;
    const isAuto = source === 'auto'; // 机器后处理自动上报类，仅进黑名单拦截、不发放次数
    let modalTitle, modalContent;
    if (decision === 'valid') {
      if (isAuto) {
        modalTitle = '标记有效（仅拦截）';
        modalContent = '此为机器后处理自动上报，标记有效后仅强化黑名单拦截该菜名，不会向任何用户发放次数。';
      } else {
        modalTitle = '标记有效并发次';
        modalContent = '将给该用户发放 1 次免费次数';
      }
    } else {
      modalTitle = '标记无效';
      modalContent = '将标记此反馈无效（不发次）';
    }
    const ok = await new Promise(r => wx.showModal({
      title: modalTitle,
      content: modalContent,
      confirmText: '确定', success: r
    }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageFeedback', { action: 'review', id, decision });
      if (r && r.code === 200) { this.loadFeedback(); wx.showToast({ title: '已处理', icon: 'success' }); }
      else this.showAlert('处理失败', (r && r.msg) || '调用失败');
    } catch (e) { this.showAlert('处理失败', '调用失败'); }
  },

  // 我的页「意见反馈」集合（feedback）—— 与上方 dish_feedback 隔开展示
  async loadOpinion() {
    try {
      const r = await this.call('manageFeedback', { action: 'listOpinion' });
      if (r && r.code === 200) this.setData({ opinionList: r.data || [] });
    } catch (e) {}
  },
  async deleteOpinion(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise(r => wx.showModal({
      title: '删除反馈', content: '确定删除这条用户意见反馈？', confirmText: '删除', success: r
    }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageFeedback', { action: 'delOpinion', id });
      if (r && r.code === 200) { this.loadOpinion(); wx.showToast({ title: '已删除', icon: 'success' }); }
      else this.showAlert('删除失败', (r && r.msg) || '调用失败');
    } catch (e) { this.showAlert('删除失败', '调用失败'); }
  },

  // 截断修复反馈（dish_name_fix）：系统误伤类隔离表，不进黑名单，但 valid 审核照常发次。
  async loadNameFix() {
    try {
      const opt = this.data.nameFixStatusOptions[this.data.nameFixFilterIndex];
      const r = await this.call('manageFeedback', { action: 'listNameFix', status: opt.value });
      if (r && r.code === 200) {
        this.setData({
          nameFixList: (r.data || []).map(F => ({
            ...F,
            timeText: F.ts ? fmt(new Date(F.ts)) : '',
            statusLabel: NAMEFIX_STATUS_LABEL[F.status] || F.status,
            statusClass: ({ pending: 'st-pending', valid: 'st-valid', invalid: 'st-invalid' }[F.status] || 'gray')
          }))
        });
      } else {
        this.showAlert('加载失败', (r && r.msg) || '未知错误');
      }
    } catch (e) { this.showAlert('加载失败', '调用失败'); }
  },
  onNameFixFilter(e) {
    this.setData({ nameFixFilterIndex: Number(e.detail.value) }, () => this.loadNameFix());
  },
  async reviewNameFix(e) {
    const id = e.currentTarget.dataset.id;
    const decision = e.currentTarget.dataset.decision;
    const ok = await new Promise(r => wx.showModal({
      title: '截断修复审核',
      content: decision === 'valid' ? '标记为有效（系统误伤，已补全，不进黑名单/照常发次）？' : '标记为无效？',
      success: r
    }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageFeedback', { action: 'reviewNameFix', id, decision });
      if (r && r.code === 200) { this.loadNameFix(); wx.showToast({ title: '已处理', icon: 'success' }); }
      else this.showAlert('处理失败', (r && r.msg) || '调用失败');
    } catch (e) { this.showAlert('处理失败', '调用失败'); }
  },

  async deleteNameFix(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise(r => wx.showModal({
      title: '删除截断修复记录',
      content: '确定删除这条记录？此操作不可恢复。',
      confirmColor: '#e64340',
      success: r
    }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageFeedback', { action: 'delNameFix', id });
      if (r && r.code === 200) { this.loadNameFix(); wx.showToast({ title: '已删除', icon: 'success' }); }
      else this.showAlert('删除失败', (r && r.msg) || '调用失败');
    } catch (e) { this.showAlert('删除失败', '调用失败'); }
  },

  // —— 贡献审核 ——
  onContribFilter(e) {
    const idx = Number(e.detail.value);
    this.setData({ contribFilterIndex: idx, contribFilter: this.data.contribStatusOptions[idx].value });
    this.loadContrib();
  },
  async loadContribStats() {
    try {
      const r = await this.call('manageContrib', { action: 'stats' });
      if (r && r.code === 200) this.setData({ contribStats: r.data });
    } catch (e) {}
  },
  async loadContrib() {
    try {
      const r = await this.call('manageContrib', { action: 'list', status: this.data.contribFilter });
      if (r && r.code === 200) {
        const list = (r.data || []).map(x => Object.assign({}, x, {
          timeText: fmt(x.createdAt),
          statusClass: STATUS_CLASS[x.status] || '',
          statusLabel: CONTRIB_STATUS_LABEL[x.status] || x.status || '',
          typeLabel: CONTRIB_TYPE_LABEL[x.type] || x.type || '其他',
          categoryLabel: x.type === 'ingredient' ? (x.category || '其他') : '',
          display: x.raw || x.value || ''
        }));
        this.setData({ contribList: list });
      }
    } catch (e) {}
  },
  async setContribStatus(e) {
    const id = e.currentTarget.dataset.id;
    const newStatus = e.currentTarget.dataset.status;
    try {
      const r = await this.call('manageContrib', { action: 'setStatus', id, newStatus });
      this.flashContrib((r && r.msg) || '');
      if (r && r.code === 200) { this.loadContribStats(); this.loadContrib(); }
    } catch (e) { this.flashContrib('调用失败'); }
  },
  async mergeOneContrib(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise(r => wx.showModal({ title: '合并该条', content: '将该条贡献入库并发放次数（菜名+2/食材+1），并标记已合并。确定？', confirmText: '合并', success: r }));
    if (!ok.confirm) return;
    this.setData({ loading: true });
    try {
      const r = await this.call('manageContrib', { action: 'mergeOne', id });
      if (r && r.code === 200) {
        this.flashContrib('已合并：' + ((r.added ? '入库+' + r.added + ' ' : '') + '发放+' + (r.awarded || 0)) );
        this.loadContribStats(); this.loadContrib();
        wx.showToast({ title: '已合并', icon: 'success' });
      } else {
        this.flashContrib('失败：' + ((r && r.msg) || '') );
      }
    } catch (e) { this.flashContrib('调用失败'); }
    finally { this.setData({ loading: false }); }
  },
  async rejectContrib(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise(r => wx.showModal({ title: '驳回该条', content: '将该条贡献标记为已驳回（不入库、不发次）。确定？', confirmText: '驳回', confirmColor: '#E8533E', success: r }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('manageContrib', { action: 'setStatus', id, newStatus: 'blocked' });
      this.flashContrib((r && r.msg) || '');
      if (r && r.code === 200) { this.loadContribStats(); this.loadContrib(); }
    } catch (e) { this.flashContrib('调用失败'); }
  },
  // 贡献审核区结果提示（自绘弹窗统一）
  flashContrib(msg) {
    if (this._contribTimer) { clearTimeout(this._contribTimer); this._contribTimer = null; }
    this.showAlert('提示', msg || '');
  },
  async deleteContrib(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise(r => wx.showModal({
      title: '彻底删除',
      content: '将永久删除这条贡献记录（不可恢复）。确定？',
      confirmText: '删除',
      confirmColor: '#E8533E',
      success: r
    }));
    if (!ok.confirm) return;
    this.setData({ loading: true });
    try {
      const r = await this.call('manageContrib', { action: 'delete', id });
      if (r && r.code === 200) {
        this.flashContrib('已删除该条记录');
        this.loadContribStats(); this.loadContrib();
        wx.showToast({ title: '已删除', icon: 'success' });
      } else {
        this.flashContrib('失败：' + ((r && r.msg) || '') );
      }
    } catch (e) { this.flashContrib('调用失败'); }
    finally { this.setData({ loading: false }); }
  },
  // 打开分类修改弹窗
  openCatEdit(e) {
    const id = e.currentTarget.dataset.id;
    const cat = e.currentTarget.dataset.cat || '其他';
    this.setData({ showCatSheet: true, catEditId: id, catEditValue: cat });
  },

  // 弹窗内选择分类
  onCatPick(e) {
    this.setData({ catEditValue: e.currentTarget.dataset.cat });
  },

  // 阻止点击内容区关闭弹窗
  noop() {},

  closeCatSheet() {
    this.setData({ showCatSheet: false, catEditId: '', catEditValue: '' });
  },

  // 确认修改分类
  async confirmCatEdit() {
    if (!this.data.catEditId) return;
    this.setData({ loading: true });
    try {
      const r = await this.call('manageContrib', {
        action: 'setCategory',
        id: this.data.catEditId,
        category: this.data.catEditValue
      });
      if (r && r.code === 200) {
        wx.showToast({ title: '已更新', icon: 'success' });
        this.setData({ showCatSheet: false, catEditId: '', catEditValue: '' });
        this.loadContrib();
      } else {
        this.flashContrib('修改失败：' + ((r && r.msg) || '') );
      }
    } catch (e) { this.flashContrib('调用失败'); }
    finally { this.setData({ loading: false }); }
  },

  async doMerge() {
    const ok = await new Promise(r => wx.showModal({ title: '强制合并', content: '将把当前所有 valid 的菜名/食材合并入库并发放次数（绕过阈值）。确定？', confirmText: '合并', success: r }));
    if (!ok.confirm) return;
    this.setData({ loading: true });
    try {
      const r = await this.call('manageContrib', { action: 'merge', force: true });
      if (r && r.code === 200) {
        this.flashContrib('合并结果：菜名+' + (r.dishMerged || 0) + ' 食材+' + (r.ingMerged || 0) + '（新增入库 菜名+' + (r.dishLibAdded || 0) + '/食材+' + (r.ingLibAdded || 0) + '），发放用户+' + (r.awardedUsers || 0) + ' 人');
        this.loadContribStats(); this.loadContrib();
        wx.showToast({ title: '已合并', icon: 'success' });
      } else {
        this.flashContrib('合并失败：' + ((r && r.msg) || '') );
      }
    } catch (e) { this.flashContrib('调用失败'); }
    finally { this.setData({ loading: false }); }
  },

  // 列表含每位用户的备份与「全量备份」；恢复/删除支持跨用户，全量备份恢复将覆盖所有用户数据。
  async loadBackups() {
    try {
      const r = await this.call('backupData', { action: 'list', openid: this.data.openid });
      if (r && r.code === 200) {
        const backups = (r.data || []).map(d => {
          // 定时全量：括号里显示备份时间（从 label "定时全量 YYYY-MM-DD HH:MM" 提取时间段）
          let label;
          if (d.scope === 'global') {
            if (d.desc === '定时全量备份') {
              const t = (d.label || '').replace(/^定时全量\s*/, '');
              label = '定时全量备份（' + (t || '—') + '）';
            } else {
              label = '全量备份（全部用户）';
            }
          } else {
            label = d.desc || '用户备份';
          }
          return Object.assign({}, d, {
            _id: d.id,
            scope: d.scope || 'user',
            owner: (d.scope === 'global'
              ? (d.desc === '定时全量备份' ? '定时全量' : '全量')
              : ('#' + (d.no != null ? d.no : (d._openid || '').slice(-6)))),
            label,
            count: d.size || 0
          });
        });
        this.setData({ backups });
      }
    } catch (e) {}
  },
  async doBackup() {
    const ok = await new Promise(r => wx.showModal({ title: '备份数据', content: '将备份你的数据到云端，确定？', confirmText: '备份', success: r }));
    if (!ok.confirm) return;
    this.setData({ loading: true });
    try {
      const r = await this.call('backupData', { action: 'backup', openid: this.data.openid }, { timeout: 60000 });
      if (r && r.code === 200) { this.loadBackups(); wx.showToast({ title: '备份成功', icon: 'success' }); }
      else if (r && r.code === 403) wx.showToast({ title: '免费次数不足，请去主页「领次数」按钮领取。', icon: 'none' });
      else { console.error('[adminBackup] 返回错误：', r && r.code, r && r.msg); showServerBusy('备份失败'); }
    } catch (e) { console.error('[adminBackup] 调用异常：', e); showServerBusy('备份失败'); }
    finally { this.setData({ loading: false }); }
  },
  async doGlobalBackup() {
    const ok = await new Promise(r => wx.showModal({
      title: '创建全量备份',
      content: '将快照所有用户的 9 类数据，可在下方列表统一管理（恢复/删除）。确定？',
      confirmText: '创建', success: r
    }));
    if (!ok.confirm) return;
    this.setData({ loading: true });
    try {
      const r = await this.call('backupData', { action: 'backupAll', openid: this.data.openid }, { timeout: 60000 });
      if (r && r.code === 200) { this.loadBackups(); wx.showToast({ title: '全量备份已创建', icon: 'success' }); }
      else { console.error('[adminBackupAll] 返回错误：', r && r.code, r && r.msg); showServerBusy('创建失败'); }
    } catch (e) { console.error('[adminBackupAll] 调用异常：', e); showServerBusy('创建失败'); }
    finally { this.setData({ loading: false }); }
  },
  async restoreBackup(e) {
    const { id, openid, scope } = e.currentTarget.dataset;
    const isGlobal = scope === 'global';
    const ok = await new Promise(r => wx.showModal({
      title: isGlobal ? '⚠️ 全量恢复' : '恢复数据',
      content: isGlobal
        ? '全量恢复将清空并覆盖【所有用户】的 9 类数据（恢复到备份时间点），操作不可撤销。确定？'
        : '将从该备份恢复，当前数据被替换。确定？',
      confirmColor: isGlobal ? '#E8533E' : '#007aff',
      success: r
    }));
    if (!ok.confirm) return;
    if (isGlobal) {
      const ok2 = await new Promise(r => wx.showModal({
        title: '再次确认',
        content: '即将全量恢复所有用户数据，此操作不可撤销。',
        confirmColor: '#E8533E', success: r
      }));
      if (!ok2.confirm) return;
    }
    try {
      const r = await this.call('backupData', { action: 'restore', backupId: id, targetOpenid: openid, openid: this.data.openid });
      if (r && r.code === 200) { this.loadBackups(); cache.invalidateUserData(); wx.showToast({ title: '恢复成功', icon: 'success' }); }
      else { console.error('[adminRestore] 返回错误：', r && r.code, r && r.msg); showServerBusy('恢复失败'); }
    } catch (e) { console.error('[adminRestore] 调用异常：', e); showServerBusy('恢复失败'); }
  },
  async deleteBackup(e) {
    const id = e.currentTarget.dataset.id;
    const openid = e.currentTarget.dataset.openid;
    const ok = await new Promise(r => wx.showModal({ title: '删除备份', content: '确定删除？不可恢复。', confirmText: '删除', confirmColor: '#E8533E', success: r }));
    if (!ok.confirm) return;
    try {
      const r = await this.call('backupData', { action: 'delete', backupId: id, targetOpenid: openid, openid: this.data.openid });
      if (r && r.code === 200) { this.loadBackups(); wx.showToast({ title: '已删除', icon: 'none' }); }
      else { console.error('[adminDeleteBackup] 返回错误：', r && r.code, r && r.msg); showServerBusy('删除失败'); }
    } catch (e) { console.error('[adminDeleteBackup] 调用异常：', e); showServerBusy('删除失败'); }
  },
  // —— 数据看板（getAdminStats）——
  async loadAdminStats() {
    if (this.data.statsLoading) return;
    this.setData({ statsLoading: true });
    try {
      const r = await this.call('getAdminStats', { days: 30 });
      if (r && r.code === 200 && r.data) {
        const d = r.data;
        const trend = (d.range && d.range.trend) || [];
        const maxTrend = trend.reduce((m, x) => Math.max(m, x.uv || 0), 1) || 1;
        this.setData({ stats: d, maxTrend });
      } else {
        wx.showToast({ title: (r && r.msg) || '统计失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '统计失败', icon: 'none' });
    } finally {
      this.setData({ statsLoading: false });
    }
    this.loadCFSwitch(); // 看板刷新时一并刷新 CF 进度（不阻塞主统计）
    this.loadThompson(); // 一并刷新 B② Thompson 进度
  },

  // CF影子模式开关与就绪进度（2026-08-07）
  // 读取 sys_config.cf_switch（开关）+ cf_ready（数据就绪进度，由 computeCF 离线产出）。
  // 进度两大指标：活跃用户数(users) 与 有效共现对数(pairs)，均达门槛才可安全开启。
  async loadCFSwitch() {
    this.setData({ cfLoading: true });
    try {
      const r = await this.call('manageCFSwitch', { action: 'get' });
      if (r && r.code === 200) {
        const tu = (r.threshold && r.threshold.users) || 200;
        const tp = (r.threshold && r.threshold.pairs) || 800;
        const users = r.users || 0;
        const pairs = r.pairs || 0;
        this.setData({
          cfEnabled: !!(r.enabled),
          cfReady: !!(r.ready),
          cfCanEnable: !!(r.canEnable),
          cfUsers: users,
          cfPairs: pairs,
          cfItems: r.items || 0,
          cfThresholdUsers: tu,
          cfThresholdPairs: tp,
          cfUsersPct: tu > 0 ? Math.min(Math.round(users / tu * 100), 100) : 0,
          cfPairsPct: tp > 0 ? Math.min(Math.round(pairs / tp * 100), 100) : 0,
          cfComputedAt: r.computedAt || 0,
          cfComputedAtText: fmt(r.computedAt)
        });
      }
    } catch (e) {
      // 静默失败，不阻断后台其他功能；进度卡片显示占位即可
    } finally {
      this.setData({ cfLoading: false });
    }
  },

  // 翻转 CF 总开关。开启后 getRecommendation 会在「数据就绪」前提下启用协同过滤软约束。
  async toggleCFSwitch(e) {
    const wantOn = !!e.detail.value;
    // 二次确认：未达标就开，会推失真结果（小样本过拟合）
    if (wantOn && !this.data.cfReady) {
      const ok = await new Promise(res => {
        wx.showModal({
          title: '确认开启协同过滤？',
          content: '当前数据尚未达标（活跃用户 ' + this.data.cfUsers + '/' + this.data.cfThresholdUsers +
            '，共现对 ' + this.data.cfPairs + '/' + this.data.cfThresholdPairs +
            '）。未达标开启可能推失真结果，确定开启？',
          success: r => res(!!r.confirm),
          fail: () => res(false)
        });
      });
      if (!ok) { this.setData({ cfEnabled: false }); return; }
    }
    this.setData({ cfLoading: true });
    try {
      const r = await this.call('manageCFSwitch', { action: 'set', enabled: wantOn });
      if (r && r.code === 200) {
        this.setData({ cfEnabled: !!r.enabled, cfCanEnable: false });
        wx.showToast({ title: r.msg || (wantOn ? '已开启' : '已关闭'), icon: 'none' });
      } else {
        wx.showToast({ title: (r && r.msg) || '操作失败', icon: 'none' });
        this.setData({ cfEnabled: !wantOn }); // 回滚 UI
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
      this.setData({ cfEnabled: !wantOn });
    } finally {
      this.setData({ cfLoading: false });
    }
  },

  // 读取 B② Thompson 采样开关与进度（管理员后台，2026-08-08）
  async loadThompson() {
    this.setData({ thLoading: true });
    try {
      const r = await this.call('manageThompson', { action: 'get' });
      if (r && r.code === 200) {
        const minS = (typeof r.minSuccess === 'number') ? r.minSuccess : 15;
        const minT = (typeof r.minTotal === 'number') ? r.minTotal : 30;
        const arms = r.arms || 0;
        const qualified = r.armsQualified || 0;
        const rate = (typeof r.acceptRate === 'number') ? r.acceptRate : 0;
        this.setData({
          thEnabled: !!(r.enabled),
          thMinSuccess: minS,
          thMinTotal: minT,
          thArms: arms,
          thArmsQualified: qualified,
          thArmsPct: arms > 0 ? Math.min(Math.round(qualified / arms * 100), 100) : 0,
          thTotalCnt: r.totalCnt || 0,
          thTotalAccept: r.totalAccept || 0,
          thAcceptRate: rate,
          thAcceptRatePct: Math.min(Math.round(rate * 100), 100),
          thUpdatedAt: r.computedAt || 0,
          thUpdatedAtText: fmt(r.computedAt),
          thArmsList: Array.isArray(r.armsList) ? r.armsList : []
        });
      }
    } catch (e) {
      // 静默失败，不阻断后台其他功能
    } finally {
      this.setData({ thLoading: false });
    }
  },

  // 翻转 B② Thompson 采样总开关。开启后 thompsonPick 会在「单臂达标」前提下启用 Beta 抽样替 UCB。
  async toggleThompsonSwitch(e) {
    const wantOn = !!e.detail.value;
    // 二次确认：达标臂数为 0 时开启，等于所有臂仍走 UCB（等同于没开），提示先积累数据。
    if (wantOn && this.data.thArmsQualified === 0) {
      const ok = await new Promise(res => {
        wx.showModal({
          title: '确认开启 Thompson 采样？',
          content: '当前尚无达标探索臂（达标 ' + this.data.thArmsQualified + '/' + this.data.thArms +
            '，门槛：单臂采纳≥' + this.data.thMinSuccess + ' 且 推送≥' + this.data.thMinTotal +
            '）。开启后所有臂仍按 UCB 探索，效果与未开一致；待探索数据积累、达标臂增多后才有意义。确定开启？',
          success: r => res(!!r.confirm),
          fail: () => res(false)
        });
      });
      if (!ok) { this.setData({ thEnabled: false }); return; }
    }
    this.setData({ thLoading: true });
    try {
      const r = await this.call('manageThompson', { action: 'set', enabled: wantOn });
      if (r && r.code === 200) {
        this.setData({ thEnabled: !!r.enabled });
        wx.showToast({ title: r.msg || (wantOn ? '已开启' : '已关闭'), icon: 'none' });
      } else {
        wx.showToast({ title: (r && r.msg) || '操作失败', icon: 'none' });
        this.setData({ thEnabled: !wantOn }); // 回滚 UI
      }
    } catch (err) {
      wx.showToast({ title: '操作失败', icon: 'none' });
      this.setData({ thEnabled: !wantOn });
    } finally {
      this.setData({ thLoading: false });
    }
  },

  // 展开/折叠 B② 单臂明细列表
  toggleThList() {
    this.setData({ thShowList: !this.data.thShowList });
  },

  // —— 公告 ——
  async loadAnnouncement() {
    try {
      const r = await this.call('manageAnnouncement', { action: 'get' });
      if (r && r.code === 200 && r.data) this.setData({ annContent: r.data.content || '' });
    } catch (e) {}
  },
  onAnnContent(e) { this.setData({ annContent: e.detail.value }); },
  async saveAnnouncement() {
    const content = this.data.annContent.trim();
    if (!content) { wx.showToast({ title: '内容不能为空', icon: 'none' }); return; }
    this.setData({ loading: true });
    try {
      const r = await this.call('manageAnnouncement', { action: 'save', content });
      if (r && r.code === 200) { this.showAlert('保存成功', '已保存公告'); }
      else this.showAlert('保存失败', (r && r.msg) || '未知错误');
    } catch (e) { this.showAlert('保存失败', '调用失败'); }
    finally { this.setData({ loading: false }); }
  },

  // —— 使用说明（guide_docs，2026-08-14）——
  async loadGuide() {
    try {
      const r = await this.call('manageGuide', { action: 'get' });
      if (r && r.code === 200 && r.data) this.setData({ guideContent: r.data.content || '' });
    } catch (e) {}
  },
  onGuideContent(e) { this.setData({ guideContent: e.detail.value }); },
  async saveGuide() {
    const content = this.data.guideContent.trim();
    if (!content) { wx.showToast({ title: '内容不能为空', icon: 'none' }); return; }
    this.setData({ loading: true });
    try {
      const r = await this.call('manageGuide', { action: 'save', content });
      if (r && r.code === 200) { this.showAlert('保存成功', '已保存使用说明（' + (r.data && r.data.count || 0) + ' 条）'); }
      else this.showAlert('保存失败', (r && r.msg) || '未知错误');
    } catch (e) { this.showAlert('保存失败', '调用失败'); }
    finally { this.setData({ loading: false }); }
  },

  // —— 通用配置（dynamicTabs，2026-08-18）——
  async dynLoad() {
    if (this.data.dynLoading) return;
    this.setData({ dynLoading: true });
    try {
      const vals = {};
      const idxs = {};
      for (const sec of this.data.dynSections) {
        let doc = {};
        try {
          const r = await this.call('adminGeneric', { action: 'genericGet', docId: sec.docId, openid: this.data.openid });
          if (r && r.code === 200 && r.data) doc = r.data;
        } catch (e) { /* 单 section 失败不阻断其余 */ }
        const fv = {};
        const fi = {};
        for (const f of sec.fields) {
          if (f.type === 'boolean') {
            fv[f.key] = !!doc[f.key];
          } else if (f.type === 'enum') {
            fv[f.key] = (doc[f.key] === undefined || doc[f.key] === null) ? '' : doc[f.key];
            const oi = f.options.findIndex(o => o.value === fv[f.key]);
            fi[f.key] = oi < 0 ? 0 : oi;
          } else {
            fv[f.key] = (doc[f.key] === undefined || doc[f.key] === null) ? '' : doc[f.key];
          }
        }
        vals[sec.docId] = fv;
        idxs[sec.docId] = fi;
      }
      this.setData({ dynValues: vals, dynIndex: idxs });
    } catch (e) { this.showAlert('加载失败', '通用配置读取失败'); }
    finally { this.setData({ dynLoading: false }); }
  },

  // 开关（boolean）：仅改本地，不自动落库
  dynSwitch(e) {
    const { docId, key } = e.currentTarget.dataset;
    const val = e.detail.value;
    const cur = Object.assign({}, this.data.dynValues[docId]);
    cur[key] = val;
    this.setData({ ['dynValues.' + docId]: cur });
  },

  // 文本输入（string）：仅改本地，失焦不再自动保存
  dynInput(e) {
    const { docId, key } = e.currentTarget.dataset;
    const cur = Object.assign({}, this.data.dynValues[docId]);
    cur[key] = e.detail.value;
    this.setData({ ['dynValues.' + docId]: cur });
  },

  // 枚举（enum）：仅改本地，不自动落库
  dynEnumChange(e) {
    const { docId, key } = e.currentTarget.dataset;
    const idx = e.detail.value;
    const sec = this.data.dynSections.find(s => s.docId === docId);
    const f = sec.fields.find(f => f.key === key);
    const val = f.options[idx].value;
    const cur = Object.assign({}, this.data.dynValues[docId]);
    cur[key] = val;
    const curIdx = Object.assign({}, this.data.dynIndex[docId]);
    curIdx[key] = idx;
    this.setData({ ['dynValues.' + docId]: cur, ['dynIndex.' + docId]: curIdx });
  },

  // 整段保存：点「保存」按钮才把该 section 全部字段一次性写入
  async dynSaveSection(e) {
    const { docId } = e.currentTarget.dataset;
    const sec = this.data.dynSections.find(s => s.docId === docId);
    if (!sec) return;
    const vals = this.data.dynValues[docId] || {};
    const fields = {};
    for (const f of sec.fields) fields[f.key] = vals[f.key];
    await this.dynSave(docId, fields);
  },

  async dynSave(docId, fields) {
    try {
      const r = await this.call('adminGeneric', { action: 'genericUpsert', docId, fields, openid: this.data.openid });
      if (r && r.code === 200) wx.showToast({ title: '已保存', icon: 'success' });
      else this.showAlert('保存失败', (r && r.msg) || '未知错误');
    }     catch (e) { this.showAlert('保存失败', '调用 adminGeneric 失败'); }
  },

  // —— 账户 ——
  onTargetOpenid(e) { this.setData({ targetOpenid: (e.detail.value || '').trim() }); },
  async deleteTarget() {
    const id = this.data.targetOpenid;
    if (!/^[a-zA-Z0-9_-]{10,64}$/.test(id)) { wx.showToast({ title: 'openid 格式不对', icon: 'none' }); return; }
    const ok = await new Promise(r => wx.showModal({ title: '注销指定用户', content: '将删除该用户（' + id + '）的全部数据，不可恢复。确定？', confirmText: '注销', confirmColor: '#E8533E', success: r }));
    if (!ok.confirm) return;
    this.setData({ loading: true });
    try {
      const r = await this.call('deleteAccount', { action: 'deleteAccount', targetOpenid: id, openid: this.data.openid });
      if (r && r.code === 200) { this.setData({ targetOpenid: '' }); this.showAlert('注销成功', '已注销：' + id); }
      else this.showAlert('注销失败', (r && r.msg) || '未知错误');
    } catch (e) { this.showAlert('注销失败', '调用失败'); }
    finally { this.setData({ loading: false }); }
  }
});
