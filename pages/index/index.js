const cache = require('../../utils/cache');
const util = require('../../utils/util');
const { SERVER_BUSY_MSG, showServerBusy } = util;   // 服务异常统一文案/弹窗（见 utils/util.js）
const { drinkShowCook } = require('../../utils/drinks');
const { DEDUCT_PER_SCENE } = require('../../utils/config');
const { defaultSceneByHour } = require('../../utils/scene');
const weatherLoc = require('../../utils/location');
const clientLog = require('../../utils/clientLog');
const { decorateGuide } = require('../../utils/ingredient_group');
const { chooseType: repChooseType, submitReport: repSubmit } = require('../../utils/dishReport');
clientLog.hook(); // 自动收集 console.error/warn，反馈时随意见反馈一并上报

// 读取缓存的定位，组装成天气查询参数（仅 IP 定位带经纬度；无则空对象 → 后端回退节气）
function getWeatherLoc() {
  try {
    const loc = weatherLoc.getLocationForWeather();
    if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
      return { lat: loc.lat, lon: loc.lon, district: loc.district || '' };
    }
  } catch (e) {}
  return {};
}

// 决定中进度弹窗：3 步，每步都有真实起止信号（进度=真实耗时，不再假动画填充）
//   ① 读偏好+构思菜单：单次 getRecommendation/getPrefs 调用，前端只能感知"开始→返回"两个端点
//      → 用"不确定态脉冲"动画（indeterminate），真实返回即满格，不假装百分比。
//   ② 出美图：genImagesForGroup 真实按图递增（_imgDone/_imgTotal 驱动，已是真实信号）。
//   ③ 整理结果：commitRecommendation + 分享卡真实做完即满格。

// 场景按一天时间顺序固定排序（与用户勾选顺序无关）：早→午→下午茶→晚→夜宵→小吃（小吃为加餐归末）
const SCENE_TIME_ORDER = ['早餐', '午餐', '下午茶', '晚餐', '夜宵', '小吃'];
function sortScenesByTime(scenes) {
  if (!Array.isArray(scenes)) return scenes;
  return scenes.slice().sort((a, b) => {
    const ia = SCENE_TIME_ORDER.indexOf(a);
    const ib = SCENE_TIME_ORDER.indexOf(b);
    const ka = ia >= 0 ? ia : SCENE_TIME_ORDER.length;
    const kb = ib >= 0 ? ib : SCENE_TIME_ORDER.length;
    return ka - kb;
  });
}

// 使用说明内置默认文案：云端 guide_docs 有数据时覆盖（getGuide 拉取），失败/未发布时兜底展示。
// 每条 {h: 标题, body: 正文, important: 是否红色高亮}；h 不带编号，弹层按顺序自动编号。
const GUIDE_ITEMS = [
  { h: '帮我决定', body: '点「帮我决定」，按你的偏好 + 当前季节/天气搭配菜品与主食，每个场景各选一样；不满意点「换一批」刷新，选定后「就它了」存进历史。' },
  { h: '偏好与调校', body: '在「我的」填口味、菜系、忌口；还可进「推荐调校」微调探索度、健康、复杂度、重复度等，让搭配更懂你。定位可启用当地真实天气搭配（炎热推凉菜、雨天推汤）：首页顶部状态点绿=已定位、黄=未定位，点击状态点即可定位或重新定位。' },
  { h: '冰箱 / 周菜单 / 剩菜', body: '首页 🧊 冰箱（看看现有食材能做什么、剩菜怎么换新花样）、📅 安排一周菜单；选定后可一键加入购菜清单 📋。' },
  { h: '购菜清单', body: '从历史或上述场景把菜品/食材加入清单，按菜分组、点菜名看食材明细；支持勾选、手动添加与清空。数据存云端，多设备同步。在历史详情里点「去外卖」会复制该菜名，方便你直接去外卖平台搜索。' },
  { h: '尝鲜', body: '每道菜下方「想尝试一些其他的？」可跳出偏好，给你换一道平时不常点的菜（耗 1 次，失败自动退款）；满意可直接「就它了」采纳。' },
  { h: '看做法', body: '点菜名旁的「看做法」查看食材用量、步骤与点评（首次耗 1 次，复看不重复扣）。' },
  { h: '做过了 / 打分', body: '在历史详情点「做过了？」并评价：说好吃会优先再推，说不好吃会尽量避免——你的反馈会反哺搭配。' },
  { h: '收藏与反馈', body: '点 ☆ 收藏（本地免费，云端同步扣 1 次，取消不耗次数）。每条推荐旁 ⚠ 可反馈问题：分「菜名问题」（名称拼凑 / 搭配不合理 / 名字缩略不规范 / 系统误伤）与「个人偏好」（命中忌口 / 不合口味）两组，每组各选一项（可同时各选一个）；菜名问题类核实有效奖励 1 次并屏蔽该菜名，个人偏好类记入您的忌口并后续规避、不发放次数。' },
  { h: '免费次数', body: '次数永久保留、跨天不清零。消耗：每次「帮我决定 / 换一批」按所选场景数扣，每个场景各 1 次（先扣基础池，不足再扣赠送池）；「看做法」首次 1 次（复看免费）、「云端收藏」各扣 1 次；冰箱/剩菜/尝鲜各耗 1 次、一周菜单按天数扣。获取：每日签到 +2、点「领次数」直接送 25 次（终身上限 50 次）；仍需要可在「我的 → 意见反馈」提交数字 ID 与所需次数，管理员会发放。点首页次数可看明细。' },
  { h: '我的', body: '查看/修改偏好与调校、历史（近 3 天/近 7 天筛选）、收藏、购菜清单、反馈与注销；也可在此手动备份（耗 1 次）或恢复数据、用兑换码领次数、定位所在城市。' },
  { h: '社区贡献', body: '在「我的-贡献菜名或食材」提交，经核对与库内无重复、非刻意编造后进入备选库；当备选库中，菜名累计满 50 条有效、食材累计满 5 条有效，任一条件满足时自动合并入库；合并后按贡献发放次数——菜名每条 +2 次、食材每条 +1 次，自动计入你的赠送次数。', important: true }
];

// 尝鲜出图加载弹窗：轮播标语（替代系统 wx.showLoading 的「生成中」）
const TRY_SLOGANS = [
  '正在为你翻找合口味的选择…',
  '为你物色下一道惊喜…',
  '马上就好，稍等一下～',
  '正在掂量这道合不合你口味…'
];

// 出文失败文案映射（2026-08-06 立，2026-09-13 按用户口径收口）。
// 背景：此前不论云端返回什么错，前端一律弹「出文通道繁忙，请稍后重试」。代码缺陷(500 ReferenceError)
// 也被说成"繁忙"，用户白重试、我们排障时也被文案带偏。现按云端 errType 分档给话术：
//   BUSY/UPSTREAM/UNKNOWN/NETWORK → 统一「服务器算力已达上限，请稍后再试」（服务不可用类）
//   DB/BUG → 保留原差异化措辞，避免把"数据问题/我方代码缺陷"说成"算力达上限"而误导用户无意义重试
// 云端 errType 由 getRecommendation 的 failure() 统一下发，两端枚举必须保持一致。
const ERR_TOAST = {
  BUSY: SERVER_BUSY_MSG,
  UPSTREAM: SERVER_BUSY_MSG,
  DB: '数据读取失败，请稍后重试',
  BUG: '服务开小差了，我们已收到反馈',
  NETWORK: SERVER_BUSY_MSG,
  UNKNOWN: SERVER_BUSY_MSG
};
function errTypeToast(type, msg) {
  if (ERR_TOAST[type]) return ERR_TOAST[type];
  return msg || ERR_TOAST.UNKNOWN;
}

// 计算「菜品」「主食」区块的显示标签；小吃场景始终为 小吃/配饮。
function dishStapleLabels(group) {
  if (group && group.scene === '小吃') return { dish: '小吃', staple: '饮料' };
  return { dish: '菜品', staple: '饭' };
}

// 批内跨场景去重（方案 A 前端聚合版，2026-08-16 引入）
// 取代原先依赖「前端并发回传 usedStaples/usedDishes 给云端」的串行去重：
// 并发出文时各场景调用云端时累积名尚未形成（竞态），导致跨场景去重失效、出现「早午菜一模一样」。
// 改为「增量去重 + 增量出图」：每个场景文本一就绪，立即用全局 seen 集合做跨场景去重，
// 缺失道数用各场景自身第 3 道余量顶替，无任何第 3 道可顶时防空保留（绝不降为单道）；
// 去重后该场景立即出图，与后续场景出文重叠并行（出图与出文解耦，2026-08-16）。
// 仅改前端，云端保持无状态 + 历史去重（recentNames）不变。
const _trimName = s => (typeof s === 'string' ? s.trim() : '');

// 对单场景某一类（dishes / staples / drinks）做跨场景去重 + 第 3 道顶替 + 防空
// arr: 该场景该类数组（可能含下标 2 的第 3 道余量）；seen: 对应全局集合（跨场景累积、可变）；reserveIdx: 余量下标；maxKeep: 展示保留数
function dedupeKind(arr, seen, reserveIdx, maxKeep) {
  if (!Array.isArray(arr) || !arr.length) return arr;
  const keep = [];
  const localUsed = new Set();
  const tryAdd = (it) => {
    const k = _trimName(it && it.name);
    if (!k) { keep.push(it); return true; }            // 无名项直接保留（防空占位）
    if (seen.has(k) || localUsed.has(k)) return false; // 全局/本场景内已用 → 失败
    seen.add(k); localUsed.add(k); keep.push(it); return true;
  };
  const cap = Math.min(maxKeep, arr.length);
  for (let i = 0; i < cap; i++) {
    const it = arr[i];
    if (!tryAdd(it)) {
      // 展示位与全局冲突：用本场景第 3 道余量顶替（余量被占用则不出图）。
      // 注：AI 应保证给满 3 道（后端 dishCap=3），无余量说明后端出文不足，根因在后端，前端不在此兜底保重名项。
      const repl = arr[reserveIdx];
      if (repl && repl !== it && !tryAdd(repl)) {
        // 余量也冲突：保留原项（防空，避免塌成单道）——此为存量逻辑，非本次新增
        keep.push(it);
      }
    }
  }
  // 余量若未被选中且未冲突，保留作算法/扣次候选（前端 _frontDishes 只显前 2）
  const repl = arr[reserveIdx];
  if (repl && keep.indexOf(repl) < 0) {
    const k = _trimName(repl.name);
    if (k && !seen.has(k) && !localUsed.has(k)) { seen.add(k); keep.push(repl); }
  }
  return keep;
}

// 增量去重单个场景（用调用方持有的全局 seen 集合，跨场景累积）
// ⚠️ 方案 A（2026-08-17）：主食(staples)不做跨场景硬去重——主食池小(米/面/包/馒…)，
// 多场景一出文必然互相撞，跨场景去重会把后发场景主食全砍光(塌成 0 主食)。
// 主食只做「本场景内部」重复剔除(局部空集合，不登记全局 seenS)，跨场景撞车观感远弱于撞菜，
// 且近期已推去重已由云端 recommend_history/dish_exposure 前置处理，前端无需再跨场景去主食。
// 注：菜品(dishes)与饮品(drinks)仍参与跨场景去重（含早餐）——避免全天撞同菜(如早餐/午餐同出
// 「清炒空心菜」)；清淡菜/青菜类是早午晚共用池，撞名概率不低，豁免反而制造重复展示。
// 早餐"少一道"根因在云端出文未保底 3 道(AI 退化+校验重写掉到 2 道)，不应在前端放开去重掩盖。
function dedupeSceneInto(group, seenD, seenS, seenR) {
  if (!group || typeof group !== 'object') return group;
  group.dishes = dedupeKind(group.dishes, seenD, 2, 2);
  group.staples = dedupeKind(group.staples, new Set(), 2, 2); // 局部集合：仅去本场景内部重复，不跨场景
  group.drinks = dedupeKind(group.drinks, seenR, 2, 2);
  return group;
}

// 兼容保留：一次性全局去重（无外部 seen 时新建），当前 onDecide 已改用增量版，此函数仅备单元测试/兜底。
function dedupeCrossScene(recs) {
  const seenD = new Set(), seenS = new Set(), seenR = new Set();
  (recs || []).forEach(g => dedupeSceneInto(g, seenD, seenS, seenR));
  return recs;
}

Page({
  data: {
    loading: false,
    acting: false,       // 提交/换批进行中：结果页按钮置灰禁用，防重复点击
    serverStatus: 'ok',  // 服务器状态：'ok'=绿点(正常) / 'down'=红点(异常)
    hasLoc: false,       // 是否有可用 IP 定位缓存（带经纬度）：无→黄点「未定位·按节气近似」
    locating: false,     // 定位进行中：显示「定位中」弹窗，避免点击后无反馈像卡住
    result: null,     // { historyId, recommendations:[{scene, items:[{name,reason,calories,protein,carb,fat,imageUrl}]}], remainingFreeCount }
    selected: [],
    freeCount: null,     // 初始为 null，避免先闪一下「3」再显示正确数字
    freeCap: 50,         // 当前免费获取总次数上限（与云函数 FREE_CAP 对齐）
    totalFreeGranted: 0, // 已累计领取的免费次数（终身）
    freeClaimed: false,  // 免费领取已达上限（totalFreeGranted>=freeCap），按钮置灰禁用
    showClaim: false,    // 「免费次数用完」领取弹层（页面内自绘，规避 wx.showModal 被吞）
    showGrantTip: false,  // 点击「领 3 次」后提示：当前免费获取（广告未开通）
    showGuide: false,     // 使用说明弹层
    guideItems: GUIDE_ITEMS, // 使用说明条目：内置默认，getGuide 拉取后覆盖（本地缓存兜底）
    showLatencyTip: false, // 出文耗时说明弹窗（首次进首页弹一次，本地缓存记已读）
    showNewUserTip: false, // 新用户引导弹窗（无偏好首刷，时间弹窗后弹出，C+A 2026-09-07）
    showResultGuide: false, // 结果引导弹窗（无偏好出菜后，前 5 次）
    showCook: false,      // 做法弹窗
    guideDish: '',        // 做法弹窗菜名
    guideLoading: false,  // 做法加载中
    rep: { show: false, dish: '', type: '', text: '' },  // 反馈补充说明（自定义大输入框）
    tryLoading: false,     // 尝鲜「想尝试其他」自绘加载弹窗
    tryProgress: 0,        // 尝鲜加载进度（0-100，完成前封顶 90）
    trySlogan: '',         // 尝鲜加载轮播标语
    cookGuide: null,      // 做法内容
    cookFav: false,       // 当前做法菜品的收藏状态
    cookFavCount: null,   // 收藏数（null=未加载，避免闪烁）
    showFav: false,       // 收藏选择弹层
    favLocal: false,
    favCloud: false,
    favCurItem: null,
    showFeedback: false,  // 菜品问题反馈弹层
    feedbackDish: '',      // 当前反馈的菜品名
    feedback: { nameIssue: '', preference: '' },  // 双组单选：菜名问题组 + 个人偏好组，各选一项（可同时各选一个）
    feedbackNote: '',       // 补充说明

    selectedStaple: [],   // 每个场景选中的主食下标
    selectedDrink: [],   // 每个场景选中的配饮下标
    signedToday: false,    // 今日是否已签到
    announcement: null,    // 当前通知公告 {_id,content}（黄色栏内滚动展示，持久化）
    shareImage: '',        // 分享卡片封面：所选菜品缩略图宫格拼接的临时图片
    showFreeLog: false,    // 免费次数明细弹层
    freeLog: [],           // 流水明细列表
    bonusFree: 0,          // 赠送池剩余（用于明细弹窗拆解 基础+赠送）
    baseFree: 0,           // 基础池剩余（= max(0, freeCount - bonusFree)，避免赠送池超总可用时出现负数）
    shareBrandImage: '',   // 首页态分享封面：canvas 现场生成的品牌图（无菜品结果时使用）
    progress: { show: false, active: 0, steps: [] },  // 决定中进度弹窗：关键点列表（缓解等待焦虑）
  },

  onShow() {
    this.tryWarmup();   // 进首页静默预热 getRecommendation 实例，避免点「帮我决定」时冷启动（节流：每 10min 至多一次）
    if (getApp().enterGuard(true)) return;   // 封禁用户：只弹窗不跳转（首页是落脚页，避免 reLaunch 自己死循环）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0, hidden: false });
    }
    // 出文耗时说明弹窗：每次冷启动进程首次进首页弹一次（内存 flag 控制，关掉后本次进程内不重复弹；
    // 不写持久缓存，故清缓存/重开小程序会再弹，避免"永久只弹一次"导致用户误以为功能没生效）
    try {
      if (!this._latencyTipShown) {
        this.setData({ showLatencyTip: true });
        this.setTabBarHidden(true);
      }
    } catch (e) { /* 异常不阻断首页 */ }
    // 底部 Banner 广告骨架（配置驱动：占位符不创建，真实 ID 才显示）
    try { require('../../utils/ad.js').showBannerAd(require('../../utils/config.js').BANNER_AD_UNIT); } catch (e) { console.warn('[ad] banner show', e); }
    this.ensurePrefs();
    this.checkServerStatus();   // 刷新服务器状态（一次轻量只读调用）
    this.refreshLocStatus();    // 刷新定位状态（从「我的」页定位后返回首页立即变绿/黄）
    if (!this._brandImgReady) {
      this._brandImgReady = true;
      // 稍延迟确保 canvas 节点已渲染
      setTimeout(() => this._prepareBrandShareImage(), 300);
    }
    // 从其他页面返回：次数可能已变，标记流水缓存为脏，下次点开重刷
    if (this._wasHidden) {
      this._freeLogDirty = true;
      this._wasHidden = false;
      // 管理员后台发放次数后，用户从此页（admin）返回首页：强制联网拉取 getDailyStats，
      // 触发 pendingBonus 并入赠送池并返回 bonusNotice → 弹「管理员为您发放了 N 次」提示。
      // 仅返回时联网，避免首屏/切 tab 频繁请求。
      this.loadStats(true);
    }
  },

  // 首页静默预热（2026-08-16）：进首页即调一次 getRecommendation 的 warmup action，
  // 仅触达云端实例让其保活，避免用户点「帮我决定」时遭遇 SCF 冷启动（Init ~数百ms~1s）。
  // 节流：每 10min 至多一次（本地时间戳），不重复打扰；静默失败（网络/环境）直接吞掉，绝不影响首页。
  tryWarmup() {
    try {
      const ts = Number(cache.lsGet('bd_warmup_ts') || 0);
      if (Date.now() - ts < 10 * 60 * 1000) return;   // 10min 内已预热过
      cache.lsSet('bd_warmup_ts', Date.now());
      wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'warmup' } }).catch(() => {});
    } catch (e) { /* 预热失败无副作用，静默 */ }
  },

  onHide() {
    // 离开首页（navigateTo 其他页）时记下，返回后触发流水刷新
    this._wasHidden = true;
    try { require('../../utils/ad.js').hideBannerAd(); } catch (e) { /* ignore */ }
  },

  // 服务器状态指示 + 公告拉取（一次轻量只读调用，不耗次数、不新增函数）
  // 用 getAnnouncement 的成功/失败反映 env1 是否可达：调用成功→绿点；调用完全失败(网络/超时/环境不可达)→红点
  checkServerStatus() {
    const ver = ++this._srvVer || (this._srvVer = 1);
    // 先恢复本地持久化公告，保证刷新不闪、网络异常也照常显示
    try {
      const localAnn = cache.getLocalAnnouncement();
      if (localAnn) this.setData({ announcement: localAnn });
    } catch (e) {}
    wx.cloud.callFunction({ name: 'getAnnouncement' })
      .then(r => {
        if (this._srvVer !== ver) return;  // 竞态保护：非最新请求则丢弃
        this.setData({ serverStatus: 'ok' });
        if (r && r.result && r.result.code === 200 && r.result.data) {
          const a = r.result.data;
          this.setData({ announcement: a });
          cache.setLocalAnnouncement(a);
        }
      })
      .catch(() => {
        if (this._srvVer !== ver) return;
        this.setData({ serverStatus: 'down' });
      });
  },

  // 定位状态：有可用 IP 定位缓存（带经纬度）→ 真实天气（绿）；无 → 节气近似（黄）
  refreshLocStatus() {
    const has = !!weatherLoc.getLocationForWeather();
    if (this.data.hasLoc !== has) this.setData({ hasLoc: has });
  },

  // 点击服务器状态条：重新 IP 定位（无授权弹窗）。成功→绿点+真实天气；失败→黄点+节气近似提示
  async onStatusTap() {
    // 需求1：服务正常（绿点且已定位）时不可点击，避免无意义重定位
    if (this.data.serverStatus === 'ok' && this.data.hasLoc) return;
    if (this._locating) return;
    this._locating = true;
    this.setData({ locating: true });   // 立即弹「定位中」，给点击反馈（修复：原无加载态、像卡住）
    try {
      const r = await weatherLoc.locateByIp();
      const ok = !!(r && r.ok);
      this.refreshLocStatus();
      wx.showToast({ title: ok ? '定位成功' : '定位失败', icon: ok ? 'success' : 'none' });
    } catch (e) {
      this.refreshLocStatus();
      wx.showToast({ title: '定位失败', icon: 'none' });
    } finally {
      this._locating = false;
      this.setData({ locating: false });
    }
  },

  // 弹窗打开时隐藏自定义 tab bar，避免被导航栏遮挡（tab bar 由框架单独渲染，z-index 压不过）
  setTabBarHidden(hidden) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ hidden: !!hidden });
    }
  },

  // 首次使用若没填偏好，引导到设置页
  async ensurePrefs(retry = 0) {
    // 已确认存在偏好：每次回到首页都向云端刷新剩余次数（含并入管理员发放的 pendingBonus），
    // 加 5s 节流避免切 tab 频繁联网
    // 已确认存在偏好：仅以本地「已确认标记」为权威依据（注销/恢复时已清此标记）。
    // 注：历史上曾用「本地缓存的偏好对象」兜底复活标记，但会导致「注销后云端记录未删净时，
    // mine.js 写回 bd_prefs 又复活 setHasPrefs」从而跳过引导页。现改为仅认 getHasPrefs()===true，
    // 其余一律走云端真实判定（401 重试链已覆盖 OPENID 未就绪场景）。
    if (cache.getHasPrefs() === true) {
      // 若当前处于封禁态，必须实时联网重新判定（跳过节流），解封后立即恢复
      if (this.data.banned) { this.loadStats(true); return; }
      const now = Date.now();
      if (!this._statsTs || now - this._statsTs > 5000) {
        this._statsTs = now;
        this.loadStats(true);
      } else {
        this.loadStats(false);
      }
      return;
    }
    // 防重复：onShow 频繁触发时仅允许一条重试链在跑，避免叠加多个 setTimeout 反复调用云函数
    if (this._ensureBusy) return;
    this._ensureBusy = true;
    const release = () => { this._ensureBusy = false; };
    const MAX_RETRY = 10;
    const retryDelay = Math.min(8000, 1000 + retry * 600); // 1s 起、渐增、封顶 8s，覆盖清缓存后较长的登录窗口
    try {
      const res = await wx.cloud.callFunction({ name: 'getPrefs' });
      const code = (res.result && res.result.code) || 0;
      if (code === 200) {
        if (res.result.data && res.result.data.exists) {
          cache.setHasPrefs(true);
          this.loadStats();
        } else {
          // 云端明确「无偏好」且 OPENID 已就绪：确属新用户（C+A 2026-09-07）
          // 不再强制跳 setup——放行首页先出菜，并刷新次数（否则首页次数会一直「加载中」）。
          console.warn('[ensurePrefs] 未找到偏好（新用户），放行首页。返回：', JSON.stringify(res && res.result));
          cache.setHasPrefs(false);
          this.loadStats(true);
          this._showNewUserTipOnce();
        }
        release();
        return;
      }
      // 410（deleted:true，账号已注销 / 墓碑拦截）：云端 getPrefs 已改为「注销后再进自动重新开通」，
      // 墓碑命中即清并重发号，正常不再返 410。此分支仅防御旧版云函数热更窗口——收到则自动触发
      // reopen 清墓碑后重走流程（重新分配编号 → 按无偏好新用户放行 + 可选引导），绝不停留「已注销」。
      if (code === 410) {
        console.warn('[ensurePrefs] 收到 410（云函数旧版本/并发窗口），自动重新开通后重试：', JSON.stringify(res && res.result));
        cache.setHasPrefs(false);
        try {
          await wx.cloud.callFunction({ name: 'savePreferences', data: { action: 'reopen' } });
        } catch (e2) { /* reopen 失败继续走重试 */ }
        if (retry < 3) {
          setTimeout(() => { release(); this.ensurePrefs(retry + 1); }, 1500);
        } else {
          // 多次仍 410：置 0 消除「加载中」，放行首页 + 可选引导（不强制）
          this.setData({ freeCount: 0, freeCap: 50, totalFreeGranted: 0, freeClaimed: true, bonusFree: 0, baseFree: 0, signedToday: false, banned: false });
          this._showNewUserTipOnce();
          release();
        }
        return;
      }
      // 401（OPENID 未就绪，清缓存/删小程序后首次进入常见）或其它非 200：
      // 仅延迟重试，绝不在此跳转设置页——否则「加载中/已注销」期间会被反复踢去引导页形成死循环。
      if (retry < MAX_RETRY) {
        setTimeout(() => { release(); this.ensurePrefs(retry + 1); }, retryDelay);
      } else {
        release();
      }
    } catch (e) {
      console.error('[ensurePrefs] 查询偏好异常：', e);
      // 网络错误/超时：同样只重试，不跳转（拿不准时留在首页比误踢去引导页更稳妥）
      if (retry < MAX_RETRY) {
        setTimeout(() => { release(); this.ensurePrefs(retry + 1); }, retryDelay);
      } else {
        release();
      }
    }
  },

  // 新用户（无偏好 / 注销重注册）引导弹窗：整机只展示一次（cache 标记）。
  // 为不打断「时间弹窗（latency tip）」的首启讲解，引导弹窗排队到时间弹窗关闭后再弹出；
  // 若本次进程时间弹窗已看过（_latencyTipShown），则直接弹。不强制——「先随便吃」可关。
  _showNewUserTipOnce() {
    try {
      if (cache.getGuideTipSeen()) return;   // 整机仅展示一次
      cache.setGuideTipSeen();               // 先占位（无论最终是否在本次弹出，都只记一次）
      this._pendingNewUserTip = true;
      this._flushNewUserTip();
    } catch (e) { /* 异常不阻断首页 */ }
  },
  // 实际弹出：若时间弹窗仍在展示则等待其关闭（onLatencyTipClose 会再调用本方法）
  _flushNewUserTip() {
    if (!this._pendingNewUserTip) return;
    if (this.data.showLatencyTip) return;    // 时间弹窗展示中 → 等它关
    this._pendingNewUserTip = false;
    this.setData({ showNewUserTip: true, showResultGuide: false });
    this.setTabBarHidden(true);
  },
  _hideNewUserTip() {
    if (this.data.showNewUserTip) { this.setData({ showNewUserTip: false }); this.setTabBarHidden(false); }
  },
  // 引导弹窗 / 结果卡「去回答」：进入 quick 迷你引导（5 问）
  goQuickGuide() {
    this.setData({ showNewUserTip: false, showResultGuide: false });
    this.setTabBarHidden(false);
    wx.navigateTo({ url: '/pages/setup/setup?mode=quick' });
  },
  // 引导弹窗「先随便吃」/ 关闭：仅隐藏本次，不再强制引导
  closeNewUserTip() {
    this.setData({ showNewUserTip: false });
    this.setTabBarHidden(false);
  },
  // 结果引导弹窗「以后再说」/ 遮罩点击：仅跳过本次，不写永久屏蔽——
  // 用户设定为「前 5 次出菜提醒」，若一次「以后再说」就永久不再打扰，后续 2~5 次提醒就白设了；
  // 答完 5 问（hasPrefs=true）或满 5 次出菜后由 shouldShowResultGuide 自然停止。
  closeResultGuide() {
    this.setData({ showResultGuide: false });
    this.setTabBarHidden(false);
  },
  // 出菜成功后：无偏好用户弹结果引导（前 5 次出菜；未完成过 quick）。
  // 2026-09-07 改为弹窗形式：与其它弹窗互斥，若时间弹窗/新用户引导仍在展示则先关闭它们再弹。
  _maybeShowResultGuide() {
    try {
      if (!cache.shouldShowResultGuide()) return;
      cache.incResultCardShown();
      this.setData({ showResultGuide: true, showNewUserTip: false, showLatencyTip: false });
      this._latencyTipShown = true;
      this.setTabBarHidden(true);
    } catch (e) { /* 异常不阻断 */ }
  },

  async loadStats(force) {
    const c = cache.getStats();
    // 先用本地缓存秒显，避免闪烁；非强制（force=false）时缓存即可，不联网
    if (c) {
      this.setData({
        freeCount: c.freeCount,
        freeCap: c.freeCap || 50,
        totalFreeGranted: c.totalFreeGranted || 0,
        freeClaimed: (c.totalFreeGranted || 0) >= (c.freeCap || 50),
        bonusFree: (typeof c.bonusFree === 'number') ? c.bonusFree : 0,
        signedToday: !!c.signed
      });
      if (!force) return;
    }
    try {
      const sres = await wx.cloud.callFunction({ name: 'getDailyStats' });
      if (sres.result && sres.result.code === 403) {
        this.setData({ banned: true });
        getApp().showBannedModal();   // 统一封禁弹窗（与 enterGuard 共用，由 app.js 去重）
        return;
      }
      if (sres.result && sres.result.code === 200) {
        const d = sres.result.data;
        this._bannedWarned = false;
        this.setData({
          freeCount: d.freeCount,
          freeCap: d.freeCap || 50,
          totalFreeGranted: d.totalFreeGranted || 0,
          freeClaimed: (d.totalFreeGranted || 0) >= (d.freeCap || 50),
          bonusFree: (typeof d.bonusFree === 'number') ? d.bonusFree : 0,
          signedToday: !!d.signed,
          banned: false
        });
        cache.setStats(d);
      } else {
        console.warn('[loadStats] 返回非预期：', JSON.stringify(sres && sres.result));
      }
    } catch (e) {
      console.error('[loadStats] 获取每日统计失败：', e);
    }
    // 公告与服务器状态由 checkServerStatus() 统一拉取（onShow 调用），此处不再重复请求
  },

  // 首页顶部红点 = 云环境不可达（checkServerStatus 探测失败）：使用类按钮点击时先拦截提示，
  // 不发云调用，避免白等一轮、或被 catch 兜底误弹「次数不足/网络异常」。返回 true 表示已拦截。
  _serviceDown() {
    if (this.data.serverStatus !== 'down') return false;
    showServerBusy();
    this.setData({ loading: false, acting: false });
    return true;
  },

  // 帮我决定 / 换一批
  // 真实分步进度：① 读偏好（getPrefs）② AI 构思菜单（getRecommendation 纯文本）③ 逐图生成（getDishImage 逐张回传）④ 整理收尾
  async onDecide(isChangeBatch) {
    if (getApp().guard()) return;   // 封禁用户全局拒绝
    if (this.data.loading) return;
    this._textNoFree = false;   // 重置「次数不足」标记，避免上一轮残留误触发
    this.setData({ acting: true });   // 换一批期间置灰结果页按钮，防重复点击
    clientLog.log('index.onDecide', 'start changeBatch=' + !!isChangeBatch);
    if (this.data.banned) {
      getApp().showBannedModal();   // 统一封禁弹窗（与 enterGuard 共用，由 app.js 去重）
      this.setData({ acting: false });
      return;
    }
    if (this._serviceDown()) return;   // 服务异常（红点）：先拦截提示，不发云调用
    // ⚡ 点按钮立即出进度弹窗，消除「点了没反应」的空窗（预检/冷启动期间用户已有可见反馈）。
    // 进度弹窗是独立 prog-mask，不会吞掉后续 promptClaim 的 showClaim 弹窗（两套独立 state）。
    this.setData({ loading: true });
    this.startProgress(isChangeBatch);
    // 2026-09-07 优化：读偏好/首次 IP 定位与次数预检互不依赖 → 并行发起，隐藏「读偏好+定位」串行等待
    // （IP 定位 fire-and-forget：文本出文读不到就由云端回传 weatherCtx 再落地，不阻塞主流程）
    const prefsP = wx.cloud.callFunction({ name: 'getPrefs' }).catch(() => null);
    if (Object.keys(getWeatherLoc()).length === 0) weatherLoc.locateByIp().catch(() => {});
    // 权威预检：直接问云端真实剩余次数，不依赖缓存，彻底避免「该弹不弹」
    let freeCount = this.data.freeCount;
    try {
      const sres = await wx.cloud.callFunction({ name: 'getDailyStats' });
      if (sres.result && sres.result.code === 403) {
        this.setData({ banned: true, acting: false });
        this.stopProgress();   // 先收起进度弹窗，再弹封禁框，避免两层叠加
        getApp().showBannedModal();   // 统一封禁弹窗（与 enterGuard 共用，由 app.js 去重）
        return;
      }
      if (sres.result && sres.result.code === 200) {
        freeCount = sres.result.data.freeCount;
        this.setData({ freeCount, banned: false });
        cache.setStats(sres.result.data);
      } else {
        console.warn('[onDecide] 预检剩余次数返回非预期：', JSON.stringify(sres && sres.result));
      }
    } catch (e) {
      console.error('[onDecide] 预检剩余次数失败：', e);
      clientLog.log('index.onDecide', e);
      // 预检失败 = 服务不可达（并非次数问题）：弹统一「服务异常」文案，并复位决定中态避免卡死。
      // （旧逻辑在此兜底弹「免费次数用完啦」领次数层，是把服务故障说成次数不足，属明确误导）
      this.setData({ loading: false, acting: false });
      this.stopProgress();
      showServerBusy();
      return;
    }
    const need = this._neededDeduct();
    if (typeof freeCount === 'number' && freeCount < need) {
      console.log('[onDecide] 次数不足，弹领取弹窗');
      clientLog.log('index.onDecide', 'insufficient freeCount=' + freeCount + ' need=' + need);
      this.stopProgress();   // 次数不足：收起进度弹窗，再弹领取框（互不遮挡）
      this.promptClaim();   // 直接弹，必然可见
      return;
    }
    // 次数足够 → 正常生成（真实计数连续进度：读偏好+构思 / 出图 / 整理）
    const _tm = { t0: Date.now() };      // 2026-08-16 分段耗时埋点（仅诊断，不改逻辑）
    this._tmText = 0;   // 累计真实出文(纯文本)耗时（各场景求和，反映实际算力分布）
    this._tmImg = 0;    // 累计真实出图耗时（各场景求和）

    try {
      // ① 读偏好+构思（step0，不确定态脉冲）：真实读取偏好 + 文本生成，二者整段无中间信号，
      //    故 pulse 覆盖，真实完成（全部文本就绪）由下方 _finishStep(0) 统一灌满 100%。
      //    偏好/定位已在 getDailyStats 预检阶段并行发起，此处取结果（通常已就绪），不再串行等一次云调用。
      const prefsRes = await prefsP;
      _tm.t0b = Date.now();   // 读偏好+IP定位完成（与预检并行），进入阶段一出文
      // 方案 A 跨场景去重全局 seen 集合（每轮决定重置，跨场景累积）：增量去重时在 genTextForScene 内使用
      this._seenD = new Set();
      this._seenS = new Set();
      this._seenR = new Set();
      const prefs = (prefsRes && prefsRes.result && prefsRes.result.data) ? prefsRes.result.data.prefs : null;

      // ② 进度分母锁定：_imgTotal（进度条分母）须在出图前就固定为"最终总图数"，
      //    防止分母被陆续撑大、分子先按小分母涨过导致百分比回退/进度条回弹。
      //    实际并无独立"阶段二"——genTextForScene 内就 await genImagesForGroup 出图，
      //    多场景经 TEXT_CONC=3 worker 出文与出图天然重叠并行（见 567-569 注释），无额外串行阶段。
      //    场景取值：用户显式偏好 scene 优先；无偏好（新用户/未选场景）按当前时段默认单场景（C+A 2026-09-07）
      const scenes = (prefs && Array.isArray(prefs.scene) && prefs.scene.length) ? prefs.scene : [defaultSceneByHour()];
      // 场景按一天时间顺序固定排序（早→午→晚→下午茶→小吃），不随用户勾选顺序变动
      const sortedScenes = sortScenesByTime(scenes);
      // 伪流式：预填占位场景，使各场景卡片在出文期间即渲染（标题先出、菜品逐步填充）
      const recs = sortedScenes.map(s => ({ scene: s, dishes: [], staples: [], drinks: [], _placeholder: true }));
      this._recs = recs;   // 内存累积，供进度期间按"连续已就绪前缀"逐步渲染（文字先出、图片到位逐个填充）
      // 本次推荐「已出场景」主食/菜品名累积：传给后续单场景调用，使云端跨场景去重（dedupCrossScene）能感知本批已用名，
      // 避免「午晚都五常大米饭」这类跨场景同名（云函数无状态，单场景调用间不共享内存，必须前端累积回传）。
      this._usedStaples = [];
      this._usedDishes = [];
      this._commitResultRender();   // 伪流式：立即渲染占位场景标题，出文期间菜品逐步填充
      this._imgDone = 0;
      this._textDone = 0;   // 已就绪文本场景数（真实进度分子）
      this._totalScenes = sortedScenes.length;   // 场景总数（真实进度分母之一）
      // 改为"进度期间即渲染"——首个场景文本到位即把连续就绪前缀（recs[0..k)）渲染出来（图片用 🍱/🍚 占位），后续文本/图片到位逐个更新；不再等 commit 后整体渲染。
      this._imgTotal = 0;
      const TEXT_CONC = 3; // 方案 A（2026-08-16）：阶段一并发出全场景（hy3 主池真实上限≈12~13、闸门 TXT_SLOT_N=10，3 路远低于上限、零429），全部返回后由前端 dedupeCrossScene 统一跨场景去重（全局可见状态，100% 正确），缺失道数用各场景第 3 道余量顶替。相比串行（TEXT_CONC=1）省一半耗时且去重不失效。

      // 单场景出文已提取为页面方法 genTextForScene(scene, gi)（见下方），便于「换一批」空场景补救与单场景重试复用

      // 阶段一：并发出文（concurrency 2 探限流），先把所有场景文本拿全 → _imgTotal 锁定为最终总图数
      // （出文流式 stream_v2 已于 2026-08-16 彻底移除：一次性 callFunction 出全场景，SSE 仅装样子，
      //  且单场景失败即整体 reject + 回退重发引入一堆错误，统一走此稳定 Event 路径）
      {
      let cursor = 0;
      const textWorker = async () => {
        while (cursor < sortedScenes.length) {
          const gi = cursor++;
          await this.genTextForScene(sortedScenes[gi], gi);   // 出文（内部已渲染 + 累加分母）
          this._textDone++;
          this._updateGenProgress();   // 真实计数进度：文本场景 +1
        }
      };
      const trunners = [];
      for (let i = 0; i < Math.min(TEXT_CONC, sortedScenes.length); i++) trunners.push(textWorker());
      await Promise.all(trunners);
      }
      _tm.t1 = Date.now();   // 阶段一（出文）完成
      // 全部场景均空（多为出文通道繁忙 430）→ 不进图阶段/不扣次，直接提示，避免一直卡在构思菜单
      const _allEmpty = recs.every(g => {
        const c = (g && g.dishes ? g.dishes.length : 0) + (g && g.staples ? g.staples.length : 0) + (g && g.drinks ? g.drinks.length : 0);
        return !c;
      });
      if (_allEmpty) {
        this.stopProgress();
        if (this._textNoFree) {
          this._textNoFree = false;
          this.loadStats(true);   // 同步真实剩余次数
          this.promptClaim();     // 次数不足明确引导领取，而非误提示「通道繁忙」
        } else {
          // 按云端 errType 给差异化文案：BUG/DB 类让用户"稍后重试"是误导，且会掩盖真实故障
          wx.showModal({
            title: '没拿到结果',
            content: errTypeToast(this._lastErrType, this._lastErrMsg),
            showCancel: false,
            confirmText: '知道了'
          });
          this._lastErrType = ''; this._lastErrMsg = '';
        }
        return;
      }
      // 阶段一补强：多场景并发易触发云端出文信号量繁忙(430)，个别场景文本可能为空。
      // 并发退避仍拿不到时，对空场景做一轮「串行」重试（降低信号量竞争），救回空白场景；
      // 此处在 _imgTotal 锁定前执行，补救成功的场景仍能正确计入总图数。
      {
        const emptyIdx = [];
        recs.forEach((g, i) => {
          const c = (g && g.dishes ? g.dishes.length : 0) + (g && g.staples ? g.staples.length : 0) + (g && g.drinks ? g.drinks.length : 0);
          if (!c) emptyIdx.push(i);
        });
        for (const gi of emptyIdx) {
          if (recs[gi] && recs[gi]._err === 'noFree') continue; // 次数不足，重试无效，直接留空待下方统一提示
          for (let t = 0; t < 3 && !(recs[gi] && ((recs[gi].dishes || []).length + (recs[gi].staples || []).length + (recs[gi].drinks || []).length)); t++) {
            await this.genTextForScene(sortedScenes[gi], gi);
            await new Promise(r => setTimeout(r, 1500));
          }
        }
        // 仍为空 → 标记 __empty，WXML 显示「点击重试」兜底（用户可单场景自助重试）
        recs.forEach((g) => {
          const c = (g && g.dishes ? g.dishes.length : 0) + (g && g.staples ? g.staples.length : 0) + (g && g.drinks ? g.drinks.length : 0);
          if (!c) g.__empty = true; else delete g.__empty;
        });
      }
      // 方案 A 解耦版：跨场景去重 + 出图已随各场景 genTextForScene「增量」完成（去重→出图与后续场景出文重叠并行），
      // 此处不再做全局去重 / 阶段二出图循环。到达此处时所有场景文本与图片均已就绪（genTextForScene 内 await 出图，
      // 由 TEXT_CONC 个 textWorker 并发驱动，出图与出文天然重叠）。
      // 真实计数进度已随文本/图片就绪实时驱动，此处无需"激活下一步"步进；直接进入入库阶段。
      _tm.t1b = Date.now();  // 出图进入标记（实际已与出文重叠完成）
      _tm.t2 = Date.now();   // 文本+图片全部完成

      // ③ 统一入库 + 扣次（commitRecommendation 原子完成；失败按错误码兜底）
      // 方向1 UCB 闭环：汇总本轮各场景探索方向，回传供云端累计「被采纳」统计。
      const exploreDirs = [];
      recs.forEach(g => {
        if (g && g.exploreTarget) exploreDirs.push(g.exploreTarget);
        if (g && g.exploreCross) exploreDirs.push(g.exploreCross);
      });
      const commitData = { recommendations: recs };
      if (exploreDirs.length) commitData.exploreDirs = exploreDirs; // 去重由云端承担，前端只负责收集
      // 方案A 精确采纳：回传用户【实际选中】的菜名（selected[gi] 为该场景选中菜品下标，默认 0=第一道），
      // 供云端判定该轮探索方向是否被真实选入，避免「整轮接受即记采纳」虚高。
      const selectedDishes = recs.map((g, gi) => {
        const idx = Number(this.data.selected[gi]);
        const dish = g && Array.isArray(g.dishes) && g.dishes[idx];
        return dish ? dish.name : null;
      });
      if (selectedDishes.some(Boolean)) commitData.selectedDishes = selectedDishes;

      // ⚡ 2026-09-07 优化：结果就绪立即展示并收进度——commit 只负责落库/扣次/档案，
      //    不再挡在进度弹窗后面（单场景实测 commit 曾占 ~3.2s）。
      this.setData({
        'result.recommendations': this._frontDishes(recs),   // 前端只展示前 2 个，第 3 个保留给算法/扣次
        selected: recs.map(() => 0),
        selectedStaple: recs.map(() => 0),
        selectedDrink: recs.map(() => 0),
        freeCount: this.data.freeCount
      });
      this._finishStep();          // 生成全部完成，进度灌满 100%
      this._prepareShareImage();   // 异步生成分享卡片封面（此时图片已齐）
      this.stopProgress();         // 收起弹窗
      this._maybeShowResultGuide(); // C+A：无偏好用户出菜后弹结果引导（前 5 次）

      // ③ commit 后台补齐 historyId / 剩余次数 / 扣次（结果已可见，失败仅提示不回滚展示）
      const cres = await wx.cloud.callFunction({ name: 'commitRecommendation', data: commitData });
      _tm.t3 = Date.now();   // commit 完成
      // —— 出文分段耗时诊断（2026-08-17 加回前端控制台打印，便于直接看各阶段用时）——
      const ms = (a, b) => (b - a);
      console.log('[perf] 出文分段耗时(ms) | 总:' + ms(_tm.t0, _tm.t3)
        + ' | 读偏好+定位:' + ms(_tm.t0, _tm.t0b)
        + ' | 出文(纯文本+去重):' + ms(_tm.t0b, _tm.t1)
        + ' | 出图:' + ms(_tm.t1, _tm.t2)
        + ' | 入库commit:' + ms(_tm.t2, _tm.t3)
        + ' || 累计纯文本:' + this._tmText + ' 累计出图:' + this._tmImg);
      const cr = cres.result;
      if (cr && cr.code === 200) {
        this.setData({
          'result.historyId': cr.data.historyId,
          'result.remainingFreeCount': cr.data.remainingFreeCount,
          freeCount: cr.data.remainingFreeCount
        });
        cache.setFreeCount(cr.data.remainingFreeCount);
        cache.invalidateHistory();   // 新决定已生成历史记录，使历史页下次进入强制刷新（绕过节流）
        this._freeLogDirty = true;   // 决定消耗了次数，流水已变，标记缓存为脏
      } else if (cr && cr.code === 403) {
        // 兜底（预检与生成间并发导致的不一致）：同步真实次数，再弹窗
        this.loadStats(true);
        setTimeout(() => this.promptClaim(), 250);
        return;
      } else {
        // 非 403 的入库失败 = 服务侧异常：统一文案（码/文案已进 console + clientLog，便于排障）
        console.error('[commit] 返回错误：', cr && cr.code, cr && cr.msg);
        clientLog.log('index.commitRecommendation', 'code=' + (cr && cr.code) + ' msg=' + ((cr && cr.msg) || ''));
        showServerBusy('提交失败');
        return;
      }
    } catch (e) {
      this.stopProgress();
      console.error('[onDecide] 调用异常：', e);
      clientLog.log('index.onDecide', e);
      showServerBusy();
    } finally {
      this.setData({ loading: false, acting: false });
    }
  },

  // 决定中进度弹窗（方案 A：真实计数连续进度）。
  // 出文与出图在真实执行中天然并行（genTextForScene 内即 await 出图，TEXT_CONC 路并发），
  // 故不再用「读偏好→出图→整理」串行 3 步假模型，改为单一「生成中」态，由真实工作项驱动：
  //   总工作量 = 场景文本数(=场景数) + 总图数(_imgTotal)
  //   已完成   = 已就绪文本场景(_textDone) + 已到位图片(_imgDone)
  //   进度 pct = 已完成 / 总工作量 * 100（封顶 99，收尾置 100），单调递增、永不回弹（_imgTotal 在出图前锁定）。
  //   并行体现：文案「已构思 X/Y 个场景 · 配图 M/N 张」让用户看到两类工作在同步推进。

  startProgress(isChangeBatch) {
      this._clearStepTimers();   // 防御：新一轮开始前清掉上一轮可能残留的定时器
      this._realProgressStarted = false;   // 标记：真实计数是否已接管（首个 _updateGenProgress 置 true）
      this.setData({
        progress: {
          show: true,
          pct: 0,
          countText: '正在按你的口味搭配…',
          indeterminate: true,   // 起步不确定态：emoji 叙事剧场 + 进度条 CSS 流光（纯 CSS，无 JS 定时器）
          isChangeBatch: isChangeBatch === true,   // 严格相等：仅 onChangeBatch 显式传 true 才算；bindtap 自动传入的事件对象 !== true，避免污染
        }
      });
      this.setTabBarHidden(true);   // 弹窗期间隐藏底部自定义 tabBar
    },
    // 真实计数进度：由 _textDone/_imgDone（已就绪工作项）与 _totalScenes/_imgTotal（分母）实时计算。
    _updateGenProgress() {
      // 首个真实计数到达：接管进度，关掉起步阶段的不确定态（纯 CSS 流光/emoji 剧场切回真实计数条 + 文字）。
      if (!this._realProgressStarted) {
        this._realProgressStarted = true;
        this.setData({ 'progress.indeterminate': false });
      }
      const done = (this._textDone || 0) + (this._imgDone || 0);
      const total = (this._totalScenes || 0) + (this._imgTotal || 0);
      const pct = total > 0 ? Math.min(99, Math.round(done / total * 100)) : 0;
      let countText = '';
      if (this._totalScenes) {
        countText = '已构思 ' + (this._textDone || 0) + '/' + this._totalScenes + ' 个场景';
        if (this._imgTotal) countText += ' · 配图 ' + (this._imgDone || 0) + '/' + this._imgTotal + ' 张';
      }
      this.setData({ 'progress.pct': pct, 'progress.countText': countText });
    },
    // 前端只展示每个场景前 2 个菜品：AI 生成 3 个（第 3 个保留给算法/扣次用，不渲染）。
  _frontDishes(recs) {
    if (!Array.isArray(recs)) return recs;
    return recs.map(g => g && typeof g === 'object'
      ? Object.assign({}, g, { dishes: Array.isArray(g.dishes) ? g.dishes.slice(0, 2) : g.dishes })
      : g);
  },
  // 进度期间逐步渲染：把"连续已就绪前缀"recs[0..k) 渲染到 result.recommendations。
  // 仅渲染已拿到文本的场景（不含未就绪的 null），图片仍为空→WXML 显示 🍱/🍚 占位。
  _commitResultRender() {
    const recs = this._recs;
    if (!recs || !recs.length) return;
    let k = 0;
    while (k < recs.length && recs[k]) k++;
    if (k === 0) return;   // 还没任何文本，不渲染（避免空占位）
    const recommendations = this._frontDishes(recs.slice(0, k));   // 同对象引用，后续 imageUrl 改动会反映到已渲染项
    if (this.data.result && typeof this.data.result === 'object') {
      this.setData({ 'result.recommendations': recommendations });
    } else {
      this.setData({ result: { recommendations, historyId: '', remainingFreeCount: this.data.freeCount } });
    }
  },
  // 单图到位：若该场景已在 result 中渲染，则只更新这一格 imageUrl（不重建整列）；否则跳过，渲染时自然带图。
  _syncImage(gi, kind, ci, url) {
    const recs = this.data.result && this.data.result.recommendations;
    if (!recs || !recs[gi]) return;
    this.setData({ ['result.recommendations[' + gi + '].' + kind + '[' + ci + '].imageUrl']: url });
  },

  // 真机 <image> 加载 cloud:// 偶发失败时，不回退占位图（用户明确不要占位），而是对这张菜单独再拉一次真图。
  // 复用后端 getDishImage 的复用+重试机制；每张最多重拉 1 次（_imgRetried 防 binderror 死循环）。
  // 重拉成功 → 回填 imageUrl；仍失败 → 保持原样（空白），不污染占位逻辑。
  onImageError(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const gi = ds.gi, kind = ds.kind, ci = ds.ci, name = ds.name;
    if (gi == null || !kind || ci == null || !name) return;
    const key = gi + '|' + kind + '|' + ci;
    if (this._imgRetried && this._imgRetried.has(key)) return; // 已重拉过，避免死循环
    (this._imgRetried || (this._imgRetried = new Set())).add(key);
    console.warn('[onImageError] 图片加载失败，单张重拉 name=' + name + ' gi=' + gi + ' kind=' + kind + ' ci=' + ci);
    wx.cloud.callFunction({
      name: 'getDishImage',
      data: { name: name, cuisine: '' },
      timeout: 60000
    }).then(res => {
      if (res && res.result && res.result.code === 200 && res.result.data && res.result.data.imageUrl) {
        this._syncImage(gi, kind, ci, res.result.data.imageUrl);
        console.log('[onImageError][OK] 重拉成功 name=' + name);
      } else {
        console.warn('[onImageError][FAIL] 重拉未返回有效图（保留原空白） name=' + name);
      }
    }).catch(err => {
      console.error('[onImageError][ERR] 重拉异常（保留原空白） name=' + name, err);
    });
  },

  // 标记整体生成完成：进度置满 100%（真实计数已在收尾前逼近 99，此处灌满收口）。
  _finishStep() {
    this._clearStepTimers();
    this.setData({ 'progress.pct': 100, 'progress.countText': '已为你准备好' });
  },
  stopProgress() {
    const p = this.data.progress;
    if (!p.show) return;
    this._clearStepTimers();   // 兜底清理任何残留进度定时器，防页面卸载/异常时泄漏
    // 收尾：进度置满 100%（避免最后进度条不满就消失），再延时收起弹窗
    this.setData({ 'progress.pct': 100 });
    setTimeout(() => {
      if (this.data.progress.show) this.setData({ 'progress.show': false });
      this.setTabBarHidden(false);   // 弹窗收起后恢复底部 tabBar
    }, 450);
  },
  // 清理所有进度残留定时器（兜底防泄漏）
  _clearStepTimers() {
    if (!this._stepTimers) return;
    Object.keys(this._stepTimers).forEach(k => {
      if (this._stepTimers[k]) { clearInterval(this._stepTimers[k]); this._stepTimers[k] = null; }
    });
  },
  // 撞名兜底补菜（2026-08-19）：跨场景去重撞名且本场景无第 3 道余量时，
  // 向云端 topUp 分支要一道「避开本批已出 + 历史近期 + 忌口 + 黑名单」的库内菜。
  // 仅撞名场景触发（低频），额外一次轻量调用；失败返回 null，由调用方防空保留原项。
  async topUpDish(scene, existDishes) {
    try {
      const avoid = [];
      if (this._seenD && this._seenD.forEach) this._seenD.forEach(n => { if (n) avoid.push(n); });
      (existDishes || []).forEach(d => { const n = _trimName(d && d.name); if (n) avoid.push(n); });
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: { topUp: true, scene, avoid } });
      const r = res && res.result;
      if (r && r.code === 200 && r.data && r.data.name) {
        const nm = _trimName(r.data.name);
        if (nm && !(this._seenD || new Set()).has(nm)) {
          const nu = (r.data && r.data.nutri) || {};
          return { name: nm, cuisine: '', reason: (r.data.reason || ''), calories: nu.calories || '', protein: nu.protein || '', carb: nu.carb || '', fat: nu.fat || '' };
        }
      }
    } catch (e) {
      console.error('[topUpDish] 补菜失败', e);
    }
    return null;
  },
  // 单个场景的出图（在 onDecide 的并发=2 池内被调用，与另一 worker 的文本生成流水重叠）。
  // 进度由实例变量 this._imgDone / this._imgTotal 共享真实驱动（图到即 +1）。
  // 2026-08-16：worker 内部由"逐张串行"改为"并发 IMG_INNER_CONC 路"（mapLimit 池），
  // 单用户多图耗时从 图数×单图时长 降到 批次数×单图时长；外层 worker 已提至场景数（三场景=3 真并行），
  // 总并发峰 = 场景数 × IMG_INNER_CONC(2) ≤ 6 ≤ SLOT_N(10) 且 < 上游真实上限14，不触发集体 429 雪崩。单图失败仍走原退避重试。
  async genImagesForGroup(gi, group) {
    const _tImgEnter = Date.now();
    const items = [];
    (group.dishes || []).forEach((it, ci) => items.push({ gi, ci, kind: 'dishes', name: it.name, cuisine: it.cuisine }));
    (group.staples || []).forEach((it, ci) => items.push({ gi, ci, kind: 'staples', name: it.name, cuisine: it.cuisine }));
    (group.drinks || []).forEach((it, ci) => items.push({ gi, ci, kind: 'drinks', name: it.name, cuisine: it.cuisine }));
    const IMG_INNER_CONC = 4; // 单场景内并发出图路数；外层2worker×4=峰8≤SLOT_N(10)<上游14（2026-08-16 曾试内层2+外层3=峰6但单场景批次数增导致整体变慢18s，回退）
    const oneImg = async (t) => {
      let url = '';
      let lastCode = 0;
      // 已带图直接复用（查表/lookup 出文后端已联表返回 env1 fileID，见 getRecommendation lookup 分支）：
      // 跳过 getDishImage，避免"图已在手还逐张白调/可能触发生成"的 7s 级浪费（2026-09-03 真机实测定位）。
      // live(AI) 出文不带图 → 仍走下方出图。复用仅认「本环境(env1)的 cloud:// fileID」——
      // 2026-09-09：历史/跨环境记录可能带 env2 fileID（cloud://your-env-id-2…），前端加载不了，
      // 必须排除，改走 getDishImage（后端图库现存的 env1 fileID 会被直接复用，无需重新出图）。
      const existingUrl = (group[t.kind] && group[t.kind][t.ci] && group[t.kind][t.ci].imageUrl) || '';
      const _envId = getApp().globalData && getApp().globalData.envId;
      const _ownCloud = _envId && /^cloud:\/\/[^/]+\//.test(existingUrl) && existingUrl.indexOf('cloud://' + _envId + '.') === 0;
      if (_ownCloud) {
        url = existingUrl;
        console.log('[genImage] 复用后端已带图 name=' + t.name);
      } else {
        // 单图失败重试：限流/抖动多为瞬时，退避后重试可恢复。
        // 云端已做全局出图信号量（上限 N），通道繁忙返回 430 → 用更长退避重试，把队列压力分散到客户端、不占云端实例。
        for (let attempt = 0; attempt < 5 && !url; attempt++) {
          try {
            const res = await wx.cloud.callFunction({ name: 'getDishImage', data: { name: t.name, cuisine: t.cuisine || '' }, timeout: 60000 });
            if (res.result && res.result.code === 200 && res.result.data && res.result.data.imageUrl) {
              url = res.result.data.imageUrl;
            } else if (res.result && res.result.code === 430) {
              lastCode = 430; // 出图通道繁忙，长退避后重试
            }
          } catch (e) {
            console.error('[getDishImage] 失败(第' + (attempt + 1) + '次)：', t.name, e);
          }
          if (!url && attempt < 4) {
            const wait = lastCode === 430 ? 3000 * Math.pow(2, attempt) : 1200 * (attempt + 1);
            await new Promise(r => setTimeout(r, wait));
          }
        }
      }
      // 直接写内存 recs[gi]（genImagesForGroup 收到的 group 即 recs[gi] 引用）
      group[t.kind][t.ci].imageUrl = url;
      this._syncImage(gi, t.kind, t.ci, url);   // 图片到位立即更新该格（若该场景已渲染）；未渲染则渲染时自然带上
      // 出图真实进度：图到即 +1，由全局真实计数驱动（文本+图片并行，统一在 _updateGenProgress 计算 pct）。
      this._imgDone += 1;
      this._updateGenProgress();
    };
    // mapLimit：最多 IMG_INNER_CONC 路并发出图，单图完成即补位，避免一次性全发打爆上游槽。
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        await oneImg(items[idx]);
      }
    };
    const runners = [];
    for (let i = 0; i < Math.min(IMG_INNER_CONC, items.length); i++) runners.push(worker());
    await Promise.all(runners);
    this._tmImg += (Date.now() - _tImgEnter); // 累计真实出图耗时（各场景求和）
  },
  onUnload() {
    this._clearStepTimers();   // 页面卸载清理进度定时器，防泄漏
    try { require('../../utils/ad.js').destroyBannerAd(); } catch (e) { /* ignore */ }
  },

  onChangeBatch() {
    this.onDecide(true);
  },

  // 单场景出文（按场景流式模式调 getRecommendation，纯文本、不入库不扣次）。
  // 云端出文信号量繁忙时返回 430，此处退避重试（次数比旧版更多），把队列压力分散到客户端、不占云端实例。
  // 多场景并发易打满信号量，个别场景可能整批失败 → 调用方（onDecide 空场景补救 / onRetryScene）会串行补重试救回。
  async genTextForScene(scene, gi) {
    const _tEnter = Date.now();
    const recs = this._recs;
    let group = null;
    let lastCode = 0;
    // 记录最后一次失败的分类与文案：云端 failure() 返回的 errType（BUG/DB/UPSTREAM/BUSY/UNKNOWN）
    // 或本地 NETWORK。供下游给出差异化提示，不再一律说「出文通道繁忙」。
    let lastErrType = '';
    let lastErrMsg = '';
      // 430=出文通道繁忙：云端已重试(env1×5+env2×2)仍失败，此处仅做有限退避重试(2 次、
      // 2s/4s 封顶)扛偶发限流窗口；避免原 8 次指数退避(最长单次 384s)导致进度条一直卡 92%。
      // 持续限流则尽快失败，交由 onDecide 全空判定提示用户，不再无限挂起。
      for (let attempt = 0; attempt < 3 && !group; attempt++) {
        try {
          const locData = getWeatherLoc();
          // 本地天气缓存优先：命中则随 event.weatherCtx 带去云端直接复用（跳过和风）；未命中传 undefined，云端算完带回再落地
          const localWeather = cache.getWeatherCache(locData);
          const weatherArg = localWeather ? { weatherCtx: localWeather } : {};
          // 方案 A：批内跨场景去重已移至前端聚合（dedupeCrossScene，onDecide 空场景补强后统一做），
          // 云端不再需要前端回传 usedStaples/usedDishes 做批内去重（并发竞态下本就失效）；
          // 传空数组，云端仅保留其自身的「历史近期去重（recentNames）」，批内去重交给前端。
          const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: Object.assign({ scene, usedStaples: [], usedDishes: [] }, locData, weatherArg), timeout: 60000 });
          const r = res && res.result;
          if (r && r.code === 200 && Array.isArray(r.data.recommendations) && r.data.recommendations[0]) {
            group = r.data.recommendations[0];
            // 方向1 UCB 闭环：把出文侧本次探索方向暂存到该场景 group，
            // 供 onDecide 的 commitRecommendation 回传，以累计「探索方向→被采纳」统计。
            if (r.data.exploreTarget) group.exploreTarget = r.data.exploreTarget;
            if (r.data.exploreCross) group.exploreCross = r.data.exploreCross;
            // 天气落地本地（1 天）：云端算完/云端缓存带回的 weatherCtx 写本地，下次出文直接复用
            if (r.data.weatherCtx) cache.setWeatherCache(locData, r.data.weatherCtx);
            // （方案 A 废弃）批内跨场景去重已移至前端聚合 dedupeCrossScene，不再累积回传云端去重。
            // this._usedStaples/_usedDishes 保留初始化仅作占位，避免遗留引用报错。
          } else if (r && r.code === 430) {
            lastCode = 430; // 出文通道繁忙，有限退避后重试
            lastErrType = r.errType || 'BUSY';
          } else if (r && r.code === 403) {
            lastCode = 403; // 免费次数不足，重试无效，立即停止
            break;
          } else if (r) {
            lastCode = r.code || 500;
            lastErrType = r.errType || 'UNKNOWN';
            lastErrMsg = r.msg || '';
            // 云端明确判定为代码缺陷：重试 100% 还是失败，立即停止，避免白等 3 轮退避
            if (lastErrType === 'BUG') {
              console.error('[genTextForScene][BUG] 云端代码缺陷，停止重试：', scene, lastErrMsg);
              break;
            }
            console.warn('[genTextForScene][' + lastErrType + '] 云端失败(第' + (attempt + 1) + '次)：', scene, lastErrMsg);
          }
        } catch (e) {
          // 本地/网络层异常（callFunction 抛错），与云端返回的业务错误区分开
          lastErrType = 'NETWORK';
          console.error('[genTextForScene][NETWORK] 调用失败(第' + (attempt + 1) + '次)：', scene, e);
        }
        if (!group && attempt < 2) {
          const wait = lastCode === 430 ? 2000 * (attempt + 1) : 1200 * (attempt + 1);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    recs[gi] = group || { scene, dishes: [], staples: [], drinks: [] };
    if (lastCode === 403) {
      recs[gi]._err = 'noFree';
      this._textNoFree = true;   // 标记整次决定为「次数不足」，供 onDecide 弹出领取引导
    } else if (!group && lastErrType) {
      // 留痕失败分类，onDecide 汇总时据此选文案（BUG 类不该让用户"稍后重试"）
      recs[gi]._errType = lastErrType;
      recs[gi]._errMsg = lastErrMsg;
      this._lastErrType = lastErrType;
      this._lastErrMsg = lastErrMsg;
    }
    const lbl = dishStapleLabels(recs[gi]);
    recs[gi]._dishLabel = lbl.dish;
    recs[gi]._stapleLabel = lbl.staple;
    let drinks = Array.isArray(group && group.drinks) ? group.drinks.slice() : [];
    if (recs[gi].scene === '小吃' || recs[gi].scene === '下午茶') {
      const sta = (recs[gi].staples || []).slice();
      drinks = sta.length ? sta : drinks;
      recs[gi].staples = [];
    }
    recs[gi].drinks = drinks;
    (recs[gi].dishes || []).forEach(it => { if (it && !('_showCook' in it)) it._showCook = true; });
    (recs[gi].staples || []).forEach(it => { if (it && !('_showCook' in it)) it._showCook = true; });
    drinks.forEach(it => {
      if (it) {
        it._isDrink = true;
        it._showCook = drinkShowCook(it.name);
      }
    });
    // 增量跨场景去重（方案 A 解耦版）：本场景文本一就绪，立即用全局 seen 集合去重，
    // 与后续场景出文重叠并行；重复项被剔除后不再启动出图（省额度），缺失道数由第 3 道余量顶替。
    dedupeSceneInto(recs[gi], this._seenD, this._seenS, this._seenR);
    // 2026-08-19：撞名导致 dishes 塌到 <2 且无第 3 道余量（云端只给 2 道）时，
    // 向云端要一道「避开本批已出 + 历史近期 + 忌口」的库内菜顶替，杜绝午餐塌成 1 道。
    if ((recs[gi].dishes || []).length < 2) {
      const topUp = await this.topUpDish(recs[gi].scene, recs[gi].dishes);
      if (topUp) { recs[gi].dishes.push(topUp); this._seenD.add(topUp.name); }
    }
    this._tmText += (Date.now() - _tEnter); // 累计真实出文(纯文本+去重)耗时（不含出图）
    const cnt = (recs[gi].dishes || []).length + (recs[gi].staples || []).length + (recs[gi].drinks || []).length;
    if (cnt) {
      this._imgTotal += cnt;          // 总图数逐步累加（分母随场景就绪增长，进度条真实递增）
      await this.genImagesForGroup(gi, recs[gi]); // 出图与出文解耦：本场景文本就绪即出图，与后续场景出文并行
    }
    this._commitResultRender();
    return recs[gi];
  },

  // 单场景重试（针对「该场景暂未生成」的空态兜底）：重出文本 + 出图，更新该格。
  // 仅在结果已生成、用户点「点击重试」时触发；期间用 loading + showLoading 防重入并提供反馈。
  async onRetryScene(e) {
    const gi = Number(e.currentTarget.dataset.gi);
    if (this.data.loading) return;
    const groups = this.data.result && this.data.result.recommendations;
    if (!groups || !groups[gi]) return;
    const scene = groups[gi].scene;
    this.setData({ loading: true });
    wx.showLoading({ title: '重试中', mask: true });
    let loadingHidden = false;
    try {
      await this.genTextForScene(scene, gi);            // 重出文本（覆盖 this._recs[gi]）
      if (this._recs[gi] && this._recs[gi]._err === 'noFree') {
        this._textNoFree = false;
        this.loadStats(true);
        this.promptClaim();   // 次数不足明确引导领取，而非误提示「已重试」成功
        return;
      }
      await this.genImagesForGroup(gi, this._recs[gi]); // 重出图（逐张回填 imageUrl）
      // ⚠️ 真正检查本次重试是否补回了内容，而非无条件报成功（旧逻辑无论成败都弹「已重试」）
      const g = this._recs[gi] || {};
      const got = ((g.dishes || []).length + (g.staples || []).length + (g.drinks || []).length) > 0;
      this.setData({ 'result.recommendations': this._frontDishes(this._recs.slice()) });
      if (got) {
        this.setData({ ['result.recommendations[' + gi + '].__empty']: false }); // 清空态标记，隐藏「点击重试」
        wx.hideLoading(); loadingHidden = true;
        wx.showToast({ title: '已重试', icon: 'success' });
      } else {
        // 仍为空：按失败分类如实告知，保留「点击重试」按钮供再次自助
        wx.hideLoading(); loadingHidden = true;
        const et = (this._recs[gi] && this._recs[gi]._errType) || '';
        wx.showToast({ title: et ? errTypeToast(et, this._recs[gi]._errMsg) : '重试失败，请稍后再试', icon: 'none', duration: 2500 });
      }
    } catch (err) {
      console.error('[onRetryScene] 失败：', err);
      wx.hideLoading(); loadingHidden = true;
      wx.showToast({ title: '重试失败，请稍后', icon: 'none' });
    } finally {
      if (!loadingHidden) wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  // 本次决定预计需要的免费次数：每个场景各 1 次（N 场景 = N 次，2026-09-07 用户定：去阶梯）。
  // 仅用于前端预提示；真实扣次以云端 commitRecommendation 为准（同口径 DEDUCT=sceneN）。
  _neededDeduct() {
    const prefs = cache.getPrefs();
    const sc = prefs && Array.isArray(prefs.scene) && prefs.scene.length ? prefs.scene.length : 1;
    return sc * DEDUCT_PER_SCENE;
  },

  // 多场景：每个场景独立选中一道菜（selected[gi] = 该场景下选中的菜品下标）
  onSelectDish(e) {
    const { gi, ii } = e.currentTarget.dataset;
    const giN = Number(gi), iiN = Number(ii);
    const item = this._itemAt(giN, 'dishes', iiN);
    // 点「尝鲜」项（首次即弹）→ 已加入偏好的不再弹窗
    if (item && item.isTry) {
      if (item._addedTry) { wx.showToast({ title: '已加入尝鲜偏好', icon: 'none' }); return; }
      this._promptAddTry(item.name, giN, iiN, 'dishes');
      return;
    }
    const selected = this.data.selected.slice();
    selected[giN] = iiN;
    this.setData({ selected }, () => {
      if (this.data.result) this._scheduleShareImage();
    });
  },

  // 多场景：每个场景独立选中一个主食（selectedStaple[gi] = 该场景下选中的主食下标）
  onSelectStaple(e) {
    const { gi, si } = e.currentTarget.dataset;
    const giN = Number(gi), siN = Number(si);
    const item = this._itemAt(giN, 'staples', siN);
    if (item && item.isTry) {
      if (item._addedTry) { wx.showToast({ title: '已加入尝鲜偏好', icon: 'none' }); return; }
      this._promptAddTry(item.name, giN, siN, 'staples');
      return;
    }
    const selectedStaple = this.data.selectedStaple.slice();
    selectedStaple[giN] = siN;
    this.setData({ selectedStaple }, () => {
      if (this.data.result) this._scheduleShareImage();
    });
  },

  // 多场景：每个场景独立选中一个配饮（selectedDrink[gi] = 该场景下选中的配饮下标）
  onSelectDrink(e) {
    const { gi, di } = e.currentTarget.dataset;
    const giN = Number(gi), diN = Number(di);
    const item = this._itemAt(giN, 'drinks', diN);
    if (item && item.isTry) {
      if (item._addedTry) { wx.showToast({ title: '已加入尝鲜偏好', icon: 'none' }); return; }
      this._promptAddTry(item.name, giN, diN, 'drinks');
      return;
    }
    const selectedDrink = this.data.selectedDrink.slice();
    selectedDrink[giN] = diN;
    this.setData({ selectedDrink }, () => {
      if (this.data.result) this._scheduleShareImage();
    });
  },

  // 取某场景某品类下的某一项（供尝鲜项识别使用）
  _itemAt(gi, kind, idx) {
    try {
      const group = this.data.result.recommendations[gi];
      if (!group) return null;
      const arr = group[kind] || [];
      return arr[idx] || null;
    } catch (e) { return null; }
  },

  // 把「尝鲜」选中的菜加入独立偏好清单（prefs.tryLiked）
  _promptAddTry(name, gi, ii, field) {
    wx.showModal({
      title: '加入偏好？',
      content: '要把「' + name + '」加入你的尝鲜偏好吗？加入后可在「我的」页管理。',
      confirmText: '加入',
      cancelText: '不用了',
      success: (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '加入中' });
        wx.cloud.callFunction({ name: 'getRecommendation', data: { action: 'addTryLiked', name } })
          .then(res => {
            if (res.result && res.result.code === 200) {
              // 标记该项已加入偏好：整卡呈现选中态（.dish.sel）且不再重复弹窗
              // 选了「尝鲜」→ 仅同一类别内取消其它项的选中（置该尝鲜项下标），不动其它类别（主食/饮料保留）
              const selKey = field === 'dishes' ? 'selected' : field === 'staples' ? 'selectedStaple' : 'selectedDrink';
              const patch = { ['result.recommendations[' + gi + '].' + field + '[' + ii + ']._addedTry']: true };
              patch[selKey] = this.data[selKey].slice();
              patch[selKey][gi] = ii;
              this.setData(patch, () => {
                if (this.data.result) this._scheduleShareImage();
              });
              wx.hideLoading();
              wx.showToast({ title: '已加入偏好', icon: 'success' });
            } else {
              wx.hideLoading();
              wx.showToast({ title: (res.result && res.result.msg) || '加入失败', icon: 'none' });
            }
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '网络异常', icon: 'none' });
          });
      }
    });
  },

  // 「想尝试一些其他的？」：点击在对应品类区尾部原位生成第三项（偏好外随机抽取，符合品类与场景）
  // 每个点击消耗 1 点次数（云端先扣后生成、失败退款）；不重复不阻塞主出文。
  async onTrySomething(e) {
    if (getApp().guard()) return;   // 封禁用户全局拒绝
    if (this.data.loading || this._trying) return;
    if (this._serviceDown()) return;   // 服务异常（红点）：先拦截提示，不发云调用
    const { gi, kind } = e.currentTarget.dataset;
    const giN = Number(gi);
    const freeCount = this.data.freeCount;
    if (typeof freeCount === 'number' && freeCount < 1) {
      this.promptClaim();
      return;
    }
    // 扣次前确认，避免误扣免费次数
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '尝试新菜',
        content: '将消耗 1 次免费次数，是否继续？',
        confirmText: '继续',
        cancelText: '再想想',
        success: (r) => resolve(!!(r && r.confirm)),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;
    const group = this.data.result.recommendations[giN];
    if (!group) return;
    const scene = group.scene;
    const field = kind === 'dish' ? 'dishes' : kind === 'staple' ? 'staples' : 'drinks';
    const arr = group[field] || [];
    const exclude = arr.map(x => x.name).filter(Boolean);
    this._trying = true;
    this._startTryProgress();
    let cleared = false; // 是否已显式结束弹窗（避免 finally 重复收尾）
    try {
      clientLog.log('index.trySomething', 'scene=' + scene + ' kind=' + kind + ' exclude=' + exclude.length);
      const locData = getWeatherLoc();
      const localWeather = cache.getWeatherCache(locData);
      const weatherArg = localWeather ? { weatherCtx: localWeather } : {};
      const res = await wx.cloud.callFunction({ name: 'getRecommendation', data: Object.assign({ action: 'trySomething', scene, kind, exclude }, locData, weatherArg), timeout: 60000 });
      const r = res.result;
      if (r && r.code === 200) {
        if (r.data && r.data.weatherCtx) cache.setWeatherCache(locData, r.data.weatherCtx);
        const item = Object.assign({}, r.data.item, { isTry: true });
        // 尝鲜项也显示「做法」按钮（与正常推荐一致；饮品按 drinkShowCook 判定）
        item._showCook = kind === 'drink' ? drinkShowCook(item.name) : true;
        // 二次保险：若仍与当前区块撞名（理论不会），跳过本次、不消耗次数提示
        if (exclude.indexOf(item.name) !== -1) {
          this._stopTryProgress(false); cleared = true;
          wx.showToast({ title: '和当前推荐重复，再点一次换一个', icon: 'none' });
          return;
        }
        const key = 'result.recommendations[' + giN + '].' + field;
        this.setData({
          [key]: arr.concat([item]),
          ['result.recommendations[' + giN + ']._tried' + (kind.charAt(0).toUpperCase() + kind.slice(1))]: true,
          freeCount: r.data.remainingFreeCount
        });
        cache.setFreeCount(r.data.remainingFreeCount);
        // 出图已在后端 trySomething 内完成，item 自带 imageUrl，前端无需再调
        this._stopTryProgress(true); cleared = true;
      } else if (r && r.code === 403) {
        this._stopTryProgress(false); cleared = true;
        this.promptClaim();   // 次数不足：仍走领次数引导（业务态，非服务异常）
      } else {
        // 430 限流与其余服务侧错误统一文案（云端先扣后生成、失败退款，不会白扣次数）
        console.error('[onTrySomething] 返回错误：', r && r.code, r && r.msg);
        clientLog.log('index.trySomething', 'code=' + (r && r.code) + ' msg=' + ((r && r.msg) || ''));
        this._stopTryProgress(false); cleared = true;
        showServerBusy();
      }
    } catch (err) {
      console.error('[onTrySomething] 调用异常：', err);
      clientLog.log('index.trySomething', err);
      this._stopTryProgress(false); cleared = true;
      showServerBusy();
    } finally {
      if (!cleared) this._stopTryProgress(false);
      this._trying = false;
    }
  },

  // 尝鲜加载：自绘弹窗（替代系统 wx.showLoading「生成中」），含轮播标语。
  // trySomething 是后端单次调用（内部含出图），前端拿不到真实子进度，故进度条用平滑递增动画到 96% 封顶，
  // 真实完成由 _stopTryProgress(true) 置 100%（失败置 0 收起）。数字为动画值非真实子进度。
  _startTryProgress() {
    if (this._tryTimer) clearInterval(this._tryTimer);
    if (this._trySloganTimer) clearInterval(this._trySloganTimer);
    let p = 0;
    this.setData({ tryLoading: true, tryProgress: 0, trySlogan: TRY_SLOGANS[0] });
    this.setTabBarHidden(true); // 自绘加载弹窗期间隐藏底部导航栏
    const CAP = 96;
    this._tryTimer = setInterval(() => {
      const remain = CAP - p;
      p += Math.max(0.5, remain * 0.06);
      if (p >= CAP) { p = CAP; clearInterval(this._tryTimer); this._tryTimer = null; }
      this.setData({ tryProgress: Math.round(p) });
    }, 220);
    let si = 0;
    this._trySloganTimer = setInterval(() => {
      si = (si + 1) % TRY_SLOGANS.length;
      this.setData({ trySlogan: TRY_SLOGANS[si] });
    }, 1600);
  },
  _stopTryProgress(done) {
    if (this._tryTimer) { clearInterval(this._tryTimer); this._tryTimer = null; }
    if (this._trySloganTimer) { clearInterval(this._trySloganTimer); this._trySloganTimer = null; }
    if (done) {
      this.setData({ tryProgress: 100 });
      setTimeout(() => { this.setData({ tryLoading: false }); this.setTabBarHidden(false); }, 260);
    } else {
      this.setData({ tryLoading: false, tryProgress: 0 });
      this.setTabBarHidden(false);
    }
  },

  // 做法弹窗（复用历史详情页逻辑：先查缓存，未缓存则确认扣次后生成）
  onCook(e) {
    const { dish } = e.currentTarget.dataset;
    if (!dish || !dish.name) return;
    const name = dish.name;
    this._curCookItem = dish;  // 保存完整菜品上下文（含 imageUrl），供收藏使用
    // 已生成过（本地按菜名缓存）：直接展示，不再扣次
    const cached = cache.getCookGuide(name);
    if (cached) {
      this.setData({ showCook: true, guideLoading: false, cookGuide: decorateGuide(cached), guideDish: name, cookFavCount: null });
      this.setTabBarHidden(true);
      this._loadCookFavCount(name);
      return;
    }
    if (this._serviceDown()) return;   // 服务异常（红点）：先拦截提示（上方缓存命中的已直接展示，不在此拦截）
    wx.showModal({
      title: '查看做法',
      content: `「${name}」的做法仅首次查看消耗 1 次免费次数，已看过的不重复扣费。是否继续？`,
      confirmText: '继续',
      cancelText: '取消',
      success: (r) => {
        if (r.confirm) this._openGuide(name);
      }
    });
  },

  async _openGuide(name) {
    this.setData({ showCook: true, guideLoading: true, guideDish: name, cookGuide: null, cookFav: !!cache.isLocalFavorited(name), cookFavCount: null });
    this.setTabBarHidden(true);
    this._loadCookFavCount(name);
    try {
      const res = await wx.cloud.callFunction({ name: 'getCookGuide', data: { dish: name } });
      const result = res && res.result;
      if (result && result.code === 200) {
        const guide = { name, ingredients: result.data.ingredients || [], steps: result.data.steps || [], review: result.data.review || '', difficulty: result.data.difficulty || '', tips: result.data.tips || '' };
        cache.setCookGuide(name, guide);
        this.setData({ cookGuide: decorateGuide(guide), guideLoading: false });
      } else if (result && result.code === 403) {
        this.setData({ showCook: false, guideLoading: false });
        this.setTabBarHidden(false);
        wx.showModal({
          title: '免费次数不足',
          content: '查看做法需要消耗免费次数，但当前次数已用完。\n\n可去主页「领次数」按钮领取，或在「我的 → 兑换码」使用官方发放的兑换码补充。仍不足可在「我的 → 意见反馈」提交数字 ID 申请发放。',
          showCancel: false,
          confirmText: '知道了'
        });
      } else {
        console.error('[cook] 返回错误：', result && result.code, result && result.msg);
        clientLog.log('index.openGuide', 'code=' + (result && result.code) + ' msg=' + ((result && result.msg) || ''));
        this.setData({ showCook: false, guideLoading: false });
        this.setTabBarHidden(false);
        showServerBusy('没拿到做法');
      }
    } catch (e) {
      console.error('[cook] 调用异常：', e);
      clientLog.log('index.openGuide', e);
      this.setData({ showCook: false, guideLoading: false });
      this.setTabBarHidden(false);
      showServerBusy();
    }
  },

  _loadCookFavCount(dish) {
    const ver = ++this._cookFavVer || (this._cookFavVer = 1);
    wx.cloud.callFunction({ name: 'favorite', data: { action: 'count', item: { dish } } })
      .then(r => {
        if (this._cookFavVer !== ver) return;  // 竞态：不是最新的请求，丢弃
        if (r.result && r.result.code === 200) this.setData({ cookFavCount: r.result.data.count });
      })
      .catch(() => {
        if (this._cookFavVer !== ver) return;
        this.setData({ cookFavCount: 0 });
      });
  },

  onOpenCookFav() {
    if (this.data.guideLoading) return; // 生成中禁止收藏（按钮灰态纯静默拦截）
    const name = this.data.guideDish;
    const local = !!cache.isLocalFavorited(name);
    const cloudList = cache.getCloudFavorites() || [];
    const cloud = cloudList.some(f => f.dish === name);
    const cur = this._curCookItem || {};
    this.setData({ showFav: true, favLocal: local, favCloud: cloud, favCurItem: { dish: name, imageUrl: cur.imageUrl || '' } });
  },

  onFavLocal() {
    if (!this.data.favCurItem || !this.data.favCurItem.dish) return;
    const item = this.data.favCurItem;
    const on = cache.toggleLocalFavorite(item);
    let cloud = this.data.favCloud;
    if (!on && cloud) {
      cache.removeCloudFavorite(item.dish);
      cloud = false;
      wx.cloud.callFunction({ name: 'favorite', data: { action: 'remove', item: { dish: item.dish } } }).catch(() => {});
    }
    this.setData({ favLocal: on, favCloud: cloud, cookFav: on || cloud, showFav: false });
    wx.showToast({ title: on ? '已收藏到本地' : '已取消收藏', icon: 'none' });
    // 先同步再查计数，确保数据库已更新
    wx.cloud.callFunction({ name: 'favorite', data: { action: 'sync', item: { dish: item.dish, remove: !on } } })
      .then(() => this._loadCookFavCount(item.dish))
      .catch(() => this._loadCookFavCount(item.dish));
  },

  async onFavCloud() {
    if (!this.data.favCurItem || !this.data.favCurItem.dish) return;
    const item = this.data.favCurItem;
    const isAdd = !this.data.favCloud;
    wx.showLoading({ title: isAdd ? '收藏中' : '取消中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'favorite', data: isAdd ? { action: 'add', item: Object.assign({}, item, { guide: this.data.cookGuide }) } : { action: 'remove', item } });
      wx.hideLoading();
      if (res.result && res.result.code === 200) {
        const d = res.result.data || {};
        if (d.added) {
          cache.addCloudFavorite(Object.assign({}, item, { guide: this.data.cookGuide }));
          this.setData({ favCloud: true, cookFav: true, showFav: false });
          this._freeLogDirty = true;   // 云端收藏 -1，流水已变，标记缓存为脏
          wx.showToast({ title: '已收藏到云端', icon: 'success' });
        } else if (d.removed) {
          cache.removeCloudFavorite(item.dish);
          this.setData({ favCloud: false, cookFav: this.data.favLocal, showFav: false });
          wx.showToast({ title: '已取消收藏', icon: 'none' });
        }
        this._loadCookFavCount(item.dish);
        if (d.removed && this.data.favLocal) {
          cache.removeLocalFavorite(item.dish);
          this.setData({ favLocal: false, cookFav: false });
          wx.cloud.callFunction({ name: 'favorite', data: { action: 'sync', item: { dish: item.dish, remove: true } } })
            .then(() => this._loadCookFavCount(item.dish))
            .catch(() => {});
        }
      } else if (res.result && res.result.code === 403) {
        // 云端收藏耗 1 次免费次数，次数不足需引导领取（操作结果一律弹窗，禁 toast）
        wx.showModal({
          title: '免费次数不足',
          content: '收藏到云端需要消耗 1 次免费次数，但当前次数已用完。\n\n可去主页「领次数」按钮领取，或在「我的 → 兑换码」使用官方发放的兑换码补充。仍不足可在「我的 → 意见反馈」提交数字 ID 申请发放。',
          showCancel: false,
          confirmText: '知道了'
        });
      } else {
        // 非 200/403 = 服务侧异常：统一文案（码/文案进 console，clientLog.hook 会一并收集）
        console.error('[fav] 返回错误：', res.result && res.result.code, res.result && res.result.msg);
        showServerBusy('收藏失败');
      }
    } catch (e) {
      wx.hideLoading();
      console.error('[fav] 调用异常：', e);
      showServerBusy('收藏失败');
    }
  },

  onCloseFav() {
    this.setData({ showFav: false });
  },

  closeCook() {
    if (this.data.guideLoading) return; // 生成中禁止关闭（蒙层空白/关闭按钮皆拦截，纯静默）
    this.setData({ showCook: false, cookFavCount: null });
    this.setTabBarHidden(false);
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

  // 返回每个场景各自选中的「菜品 + 主食」（多场景分开选择）
  _getPicks() {
    const { result, selected, selectedStaple, selectedDrink } = this.data;
    if (!result) return [];
    const out = [];
    (result.recommendations || []).forEach((group, gi) => {
      const di = (selected[gi] != null) ? selected[gi] : 0;
      const si = (selectedStaple[gi] != null) ? selectedStaple[gi] : 0;
      const dki = (selectedDrink[gi] != null) ? selectedDrink[gi] : 0;
      const dish = group.dishes && group.dishes[di];
      const staple = group.staples && group.staples[si];
      const drink = group.drinks && group.drinks[dki];
      if (dish) out.push({ dish, staple: staple || null, drink: drink || null, scene: group.scene });
    });
    return out;
  },

  async onAccept() {
    const { result } = this.data;
    if (!result) return;
    if (this.data.acting) return;   // 记录进行中：置灰防重复点击
    const picks = this._getPicks();
    if (!picks.length) return;
    this.setData({ acting: true });
    wx.showLoading({ title: '记录中' });
    try {
      await wx.cloud.callFunction({
        name: 'recordFeedback',
        data: {
          historyId: result.historyId,
          selected: picks.map(p => ({ name: p.dish.name, staple: p.staple ? p.staple.name : '', drink: p.drink ? p.drink.name : '', scene: p.scene, cuisine: p.dish.cuisine || '' })),
          feedback: 'accept',
          // 回写已出图的 recommendations（含 imageUrl），修复历史记录图片不显示
          recommendations: result.recommendations
        }
      });
      wx.hideLoading();
      wx.showToast({ title: '已记录', icon: 'success' });
      cache.invalidateHistory();   // 已采纳并回写 selected/图片，使历史页下次进入强制刷新
      setTimeout(() => this.setData({ result: null, acting: false }), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '记录失败', icon: 'none' });
      this.setData({ acting: false });
    }
  },

  // 切换选中后防抖重生成分享封面，使分享图随用户选择更新（避免快速连点反复生成）
  _scheduleShareImage() {
    if (this._shareImgTimer) clearTimeout(this._shareImgTimer);
    this._shareImgTimer = setTimeout(() => {
      this._shareImgTimer = null;
      this._prepareShareImage();
    }, 300);
  },

  // 分享卡片封面：用所选菜品缩略图宫格拼接（最多 4 张），供 onShareAppMessage 的 imageUrl 使用
  async _prepareShareImage() {
    const picks = this._getPicks();
    const urls = [];
    picks.forEach(p => {
      if (p.dish && p.dish.imageUrl) urls.push(p.dish.imageUrl);
      if (p.staple && p.staple.imageUrl) urls.push(p.staple.imageUrl);
      if (p.drink && p.drink.imageUrl) urls.push(p.drink.imageUrl);
    });
    if (!urls.length) { this.setData({ shareImage: '' }); return; }
    const list = urls.slice(0, 4);
    try {
      const paths = await Promise.all(list.map(u => this._dlShareImg(u)));
      const canvas = await this._getShareCanvas();
      if (!canvas) { this.setData({ shareImage: '' }); return; }
      const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const dpr = sys.pixelRatio || 2;
      const W = 500, H = 400;            // 微信分享卡片建议 5:4
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const imgs = await Promise.all(paths.map(p => this._loadShareImg(canvas, p)));
      this._drawShareGrid(ctx, imgs, W, H, 12);
      const out = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width: W * dpr, height: H * dpr,
          destWidth: W, destHeight: H,
          fileType: 'png',
          success: resolve, fail: reject
        });
      });
      this.setData({ shareImage: out.tempFilePath });
    } catch (e) {
      console.warn('[shareImage] 生成失败，回退默认截图：', e);
      this.setData({ shareImage: '' });
    }
  },
  // 下载菜品缩略图（cloud:// fileID 或 http 链接均可）
  _dlShareImg(fileID) {
    return new Promise((resolve, reject) => {
      if (!fileID || fileID.indexOf('cloud://') !== 0) {
        wx.downloadFile({ url: fileID, success: r => resolve(r.tempFilePath), fail: reject });
        return;
      }
      wx.cloud.downloadFile({ fileID, success: r => resolve(r.tempFilePath), fail: reject });
    });
  },
  _getShareCanvas() {
    return new Promise(resolve => {
      wx.createSelectorQuery().in(this).select('#shareCanvas').fields({ node: true }).exec(res => {
        resolve(res && res[0] && res[0].node ? res[0].node : null);
      });
    });
  },
  _loadShareImg(canvas, src) {
    return new Promise((resolve, reject) => {
      const img = canvas.createImage();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('img load fail'));
      img.src = src;
    });
  },
  // 多图宫格拼接（最多 4 张）：单张 cover 铺满；≥2 张用 contain 完整显示。无背景色、无文案，纯图片（透明底导出 PNG）
  _drawShareGrid(ctx, imgs, W, H, pad) {
    const n = imgs.length;
    const draw = (img, x, y, w, h, mode) => {
      const iw = img.width, ih = img.height;
      const s = (mode === 'cover' ? Math.max : Math.min)(w / iw, h / ih);
      const dw = iw * s, dh = ih * s;
      ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    };
    if (n === 1) {
      draw(imgs[0], 0, 0, W, H, 'cover');   // 单张铺满，无背景露出
      return;
    }
    const cols = 2;
    const rows = Math.ceil(n / cols);
    const cw = (W - pad * (cols + 1)) / cols;
    const ch = (H - pad * (rows + 1)) / rows;
    imgs.forEach((im, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      draw(im, pad + c * (cw + pad), pad + r * (ch + pad), cw, ch, 'contain');
    });
  },

  // 首页态分享封面：canvas 现场画一张品牌图（暖色渐变底 + 大 emoji + 品牌名 + slogan）
  async _prepareBrandShareImage() {
    try {
      const canvas = await this._getShareCanvas();
      if (!canvas) return;
      const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const dpr = sys.pixelRatio || 2;
      const W = 500, H = 400;            // 5:4，微信分享卡片建议比例
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // 暖色渐变底（食欲橙黄）
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#FFD98A');
      g.addColorStop(1, '#FFB24C');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // 白色圆角卡片承载内容，边缘留渐变边框
      const roundRect = (x, y, w, h, r) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      };
      const m = 22;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      roundRect(m, m, W - m * 2, H - m * 2, 20);
      ctx.fill();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // 大 emoji（餐盒），部分安卓可能显示为黑白，可接受
      ctx.font = '110px sans-serif';
      ctx.fillText('🍱', W / 2, 150);

      // 品牌名
      ctx.fillStyle = '#7A4A17';
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText('诶呀妈呀 今天吃啥呀', W / 2, 258);

      // slogan
      ctx.fillStyle = '#B87325';
      ctx.font = '19px sans-serif';
      ctx.fillText('饭点不再头疼 · 一键帮你定菜单', W / 2, 302);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      const out = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width: W * dpr, height: H * dpr,
          destWidth: W, destHeight: H,
          fileType: 'jpg', quality: 0.9,
          success: resolve, fail: reject
        });
      });
      this.setData({ shareBrandImage: out.tempFilePath });
    } catch (e) {
      console.warn('[brandShareImage] 生成失败，回退默认截图：', e);
    }
  },

  onShare() {
    if (!this._getPicks().length) return;
    wx.showToast({ title: '点击右上角 ··· 分享给好友', icon: 'none' });
  },

  // 无次数时引导领取：改用页面内自绘弹层，彻底规避 wx.showModal 被 loading 遮罩吞掉的已知坑
  promptClaim() {
    this.setData({ showClaim: true });
    this.setTabBarHidden(true);
  },

  // 领取弹层：确认领取
  onClaimConfirm() {
    this.setData({ showClaim: false });
    this.setTabBarHidden(false);
    this.grantFree();
  },

  // 领取弹层：关闭
  onClaimCancel() {
    this.setData({ showClaim: false, loading: false, acting: false });
    this.setTabBarHidden(false);
  },

  // 「领次数」已达上限后点击：弹窗指引如何继续获取，避免静默 noop 让链路断掉
  onClaimExhausted() {
    wx.showModal({
      title: '免费次数已领完',
      content: '你已领取完当前免费次数（上限 ' + (this.data.freeCap || 50) + ' 次）。\n\n仍需要次数可走两条路：\n· 在「我的 → 意见反馈」提交你的数字 ID 与所需次数，管理员会发放；\n· 关注官方账号，使用发放的兑换码在「我的 → 兑换码」领取。\n\n其他方式产生的次数（签到、赠送等）不受此上限限制。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 阻止点击弹层内容时冒泡到遮罩（catchtap 需绑定真实方法，否则会报未定义）
  noop() {},

  // 关闭「当前免费获取」提示弹层
  onGrantTipClose() {
    this.setData({ showGrantTip: false });
    this.setTabBarHidden(false);
  },

  // 打开/关闭「使用说明」弹层
  onShowGuide() {
    if (getApp().guard()) return;   // 封禁用户拒绝
    // 先展示本地缓存/内置默认，再后台拉云端最新覆盖
    const cached = cache.getGuideItems();
    this.setData({ showGuide: true, guideItems: cached || GUIDE_ITEMS });
    this.setTabBarHidden(true);
    this._loadGuide();
  },
  // 拉取云端使用说明（失败静默，保留现有文案兜底）
  async _loadGuide() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getGuide', data: {} });
      const items = res && res.result && res.result.code === 200 && res.result.data
        ? res.result.data.items : null;
      if (Array.isArray(items) && items.length) {
        cache.setGuideItems(items);
        this.setData({ guideItems: items });
      }
    } catch (e) { /* 网络/云端异常：保留默认或缓存文案 */ }
  },
  onGuideClose() {
    this.setData({ showGuide: false });
    this.setTabBarHidden(false);
  },

  // 关闭「出文耗时说明」弹窗：置内存 flag，本次进程内不再弹（重开小程序/清缓存会再弹）
  onLatencyTipClose() {
    this._latencyTipShown = true;
    this.setData({ showLatencyTip: false });
    this.setTabBarHidden(false);
    this._flushNewUserTip();   // C+A：时间弹窗关闭后再弹新用户引导（若已排队且未展示）
  },

  // 主页 fab 跳转：冰箱/剩菜（合并页）、一周菜单、购菜清单
  // 封禁用户：点击直接弹提示、不跳转（与其他操作一致用 guard 拦截）
  goFridge() {
    if (getApp().guard()) return;
    wx.navigateTo({ url: '/pages/fridge/fridge' });
  },
  goWeek() {
    if (getApp().guard()) return;
    wx.navigateTo({ url: '/pages/week/week' });
  },
  goShop() {
    if (getApp().guard()) return;
    wx.navigateTo({ url: '/pages/shoplist/shoplist' });
  },

  // ===== 菜品问题反馈（对齐 name_blocklist 结构，便于后台导出导入） =====
  // 打开反馈弹层：记录当前菜品名
  onOpenFeedback(e) {
    const name = e.currentTarget.dataset.name || '';
    if (!name) return;
    this.setData({
      showFeedback: true,
      feedbackDish: name,
      feedback: { nameIssue: '', preference: '' },   // 双组单选：打开时清空上次选择
      feedbackNote: ''
    });
    this.setTabBarHidden(true);
  },

  // 双组单选切换理由：菜名问题组(nameIssue) / 个人偏好组(preference) 各自单选，
  // 可同时各选一个（来自不同组），但组内不叠加。再次点同一项取消选择。
  onFeedbackToggle(e) {
    const { type, group } = e.currentTarget.dataset;
    if (!type || !group) return;
    const key = 'feedback.' + group;
    this.setData({ [key]: this.data.feedback[group] === type ? '' : type });
  },

  onFeedbackNote(e) {
    this.setData({ feedbackNote: e.detail.value });
  },

  // 取消反馈
  onFeedbackCancel() {
    this.setData({ showFeedback: false });
    this.setTabBarHidden(false);
  },

  // 提交反馈 → 调 submitDishFeedback 云函数
  async onFeedbackSubmit() {
    const { feedbackDish, feedback, feedbackNote } = this.data;
    const { nameIssue, preference } = feedback;
    if (!nameIssue && !preference) {
      wx.showToast({ title: '请选择一项', icon: 'none' });
      return;
    }
    // 双组各取一个：菜名问题组 + 个人偏好组（可同时各选一个，来自不同组）
    const report = [nameIssue, preference].filter(Boolean);
    wx.showLoading({ title: '提交中', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'submitDishFeedback',
        data: { dish: feedbackDish, report, note: feedbackNote }
      });
      wx.hideLoading();
      if (res && res.result && res.result.code === 200) {
        this.setData({ showFeedback: false });
        this.setTabBarHidden(false);
        wx.showToast({ title: '反馈成功', icon: 'success' });
      } else {
        wx.showToast({ title: (res && res.result && res.result.msg) || '提交失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('submitDishFeedback error:', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },

  // 每日签到 +2（点击才发，每日限一次）
  async onSignIn() {
    if (getApp().guard()) return;   // 封禁用户拒绝
    if (this.data.signedToday) return;
    wx.showLoading({ title: '签到中' });
    try {
      const res = await wx.cloud.callFunction({ name: 'signIn' });
      wx.hideLoading();
      if (res.result && res.result.code === 200) {
        const already = !!res.result.data.already;
        this.setData({ freeCount: res.result.data.freeCount, signedToday: true });
        // ⚠️ 必须把 signed 同步写回本地缓存：否则离开首页再返回时，
        // loadStats 命中缓存里的旧 signed:false → 按钮重新可点 → 误以为能重复签到。
        // （服务端 signIn 已用 lastSignedDate 拦重，不会真重复发 +2，此处仅为修正 UI 状态）
        const st = cache.getStats();
        if (st) cache.setStats(Object.assign({}, st, { freeCount: res.result.data.freeCount, signed: true }));
        else cache.setFreeCount(res.result.data.freeCount);
        if (already) {
          // 已签到：服务端未重复发放，仅提示，不弹「签到成功」
          wx.showToast({ title: '今日已签到', icon: 'none' });
        } else {
          this._freeLogDirty = true;   // 签到 +2，流水已变，标记缓存为脏
          wx.showModal({
            title: '签到成功',
            showCancel: false,
            confirmText: '好的'
          });
        }
      } else {
        clientLog.log('index.onSignIn', 'code=' + (res.result && res.result.code) + ' msg=' + ((res.result && res.result.msg) || ''));
        wx.showToast({ title: (res.result && res.result.msg) || '签到失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      clientLog.log('index.onSignIn', e);
      wx.showToast({ title: '签到失败', icon: 'none' });
    }
  },

  // 点击「领次数」直接领取（广告位未开通，暂改为直接赠送）
  onGetMore() {
    if (getApp().guard()) return;   // 封禁用户全局拒绝
    this.grantFree();
  },

  // 发放免费机会（配置驱动：广告位已配真实 ID 时先看激励视频、看完才发；未配置则直发）
  async grantFree() {
    const config = require('../../utils/config.js');
    const ad = require('../../utils/ad.js');
    try {
      const watched = await ad.showRewardedAd(config.REWARD_AD_UNIT);
      if (!watched) {
        wx.showToast({ title: '看完广告才能领取哦', icon: 'none' });
        return;
      }
    } catch (e) {
      // 广告异常不阻断领取：兜底走直发（与未配置行为一致）
      console.warn('[ad] grantFree fallback', e);
    }
    wx.showLoading({ title: '发放中' });
    wx.cloud.callFunction({ name: 'consumeFreeCount' })
      .then(r => {
        wx.hideLoading();
        if (!(r.result && r.result.code === 200)) clientLog.log('index.claim', r && r.result ? ('code=' + r.result.code + ' msg=' + (r.result.msg || '')) : 'no-result');
        if (r.result && r.result.code === 200) {
          const tf = r.result.data.totalFreeGranted || this.data.totalFreeGranted;
          const fc = r.result.data.freeCap || this.data.freeCap;
          this.setData({
            freeCount: r.result.data.freeCount,
            totalFreeGranted: tf,
            freeCap: fc,
            freeClaimed: tf >= fc,
            bonusFree: (typeof r.result.data.bonusFree === 'number') ? r.result.data.bonusFree : this.data.bonusFree
          });
          cache.setFreeCount(r.result.data.freeCount);
          this._freeLogDirty = true;   // 领次数发放，流水已变，标记缓存为脏
          // 「当前免费获取」提示每日只显示一次
          const today = util.getToday();
          if (cache.getGrantTipDate() !== today) {
            this.setData({ showGrantTip: true });
            this.setTabBarHidden(true);
            cache.setGrantTipDate(today);
          }
          // 领次数成功：复位决定中/按钮态（领次数可能由 onDecide 链路触发，需收尾）
          this.setData({ loading: false, acting: false });
        } else if (r.result && r.result.code === 449) {
          // 已达当前免费上限：用弹窗展示完整指引（toast 会被截断）；同时复位决定中/按钮态
          this.setData({ showClaim: false, freeClaimed: true, loading: false, acting: false });
          this.setTabBarHidden(false);
          wx.showModal({
            title: '领取已到上限',
            content: '免费次数领取已到上限（当前共 ' + (this.data.freeCap || 50) + ' 次）。因服务器算力有限，为保证更多用户正常体验设此上限。\n\n如仍需要次数，可走两条路：\n· 在「我的 → 意见反馈」提交你的数字 ID 与所需次数，管理员会发放；\n· 关注官方账号，使用发放的兑换码在「我的 → 兑换码」领取。\n\n其他方式产生的次数（签到、赠送等）不受此上限限制。',
            showCancel: false,
            confirmText: '知道了'
          });
        } else if (r.result) {
          this.setData({ loading: false, acting: false });
          wx.showToast({ title: r.result.msg, icon: 'none' });
        } else {
          this.setData({ loading: false, acting: false });
          wx.showToast({ title: '操作失败', icon: 'none' });
        }
      })
      .catch(() => {
        wx.hideLoading();
        this.setData({ loading: false, acting: false });
        wx.showToast({ title: '操作失败，请重试', icon: 'none' });
      });
  },

  // 打开免费次数明细弹层：先用本地缓存秒开（消除点击卡顿），按需后台静默刷新
  onShowFreeLog() {
    if (getApp().guard()) return;   // 封禁用户拒绝
    // 立即展示弹层 + 隐藏 tab bar，内容直接用本地缓存（无缓存则为空，随后刷新填充）
    const cached = cache.getFreeLog();
    const list = (cached && Array.isArray(cached.list)) ? cached.list : [];
    const fcNow = (this.data.freeCount == null) ? 0 : this.data.freeCount;
    const bfNow = (typeof this.data.bonusFree === 'number') ? this.data.bonusFree : 0;
    // 基础池 = 总可用 - 赠送池；赠送池可能大于总可用（管理员发了大量赠送且基础池已耗尽），此时基础池应为 0，不能为负
    const baseNow = Math.max(0, fcNow - bfNow);
    this.setData({ showFreeLog: true, freeLog: list, baseFree: baseNow });
    this.setTabBarHidden(true);
    // 本地无缓存 / 本轮有变更 / 缓存超过 60s → 后台静默刷新并更新缓存（不阻塞弹层）
    const fresh = cached && (Date.now() - cached.ts < 60000);
    if (!this._freeLogDirty && fresh) return;
    this._freeLogDirty = false;
    wx.cloud.callFunction({ name: 'getFreeLog' })
      .then(res => {
        if (res.result && res.result.code === 200) {
          const d = res.result.data;
          cache.setFreeLog(d.list || []);
          // 明细弹窗复用首页已加载的次数快照，避免用云端可能偏差的值覆盖首页（防止弹窗后首页变 0）
          const fc2 = (this.data.freeCount == null && typeof d.freeCount === 'number') ? d.freeCount : this.data.freeCount;
          const bf2 = (typeof this.data.bonusFree !== 'number' && typeof d.bonusFree === 'number') ? d.bonusFree : this.data.bonusFree;
          this.setData({
            freeLog: d.list || [],
            freeCount: fc2,
            bonusFree: bf2,
            baseFree: Math.max(0, fc2 - bf2)
          });
        } else {
          wx.showToast({ title: '明细加载失败', icon: 'none' });
        }
      })
      .catch(() => wx.showToast({ title: '明细加载失败', icon: 'none' }));
  },
  // 关闭免费次数明细弹层
  onFreeLogClose() {
    this.setData({ showFreeLog: false });
    this.setTabBarHidden(false);
  },

  onShareAppMessage() {
    const { result, shareImage, shareBrandImage } = this.data;
    const first = result && result.recommendations && result.recommendations[0];
    const hasDish = !!(
      first && (
        (first.dishes && first.dishes[0]) ||
        (first.staples && first.staples[0]) ||
        (first.drinks && first.drinks[0])
      )
    );
    // 有结果：晒菜（菜品拼图 + 晒菜文案）；无结果：引流（品牌封面 + 召唤文案）
    return {
      title: hasDish
        ? '今个我吃这个~'
        : '今天吃啥别纠结，让它替你拍板',
      path: '/pages/index/index',
      imageUrl: hasDish ? shareImage : shareBrandImage
    };
  }
});
