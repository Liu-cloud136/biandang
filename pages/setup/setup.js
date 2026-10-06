const cache = require('../../utils/cache');
const { SCENE, sceneListSel } = require('../../utils/scene');
const clientLog = require('../../utils/clientLog');
clientLog.hook();

const BASE = {
  // 口味：风味维度（辣度已独立为「辣度」一问，这里保留辣味风格词）
  taste: ['麻辣', '香辣', '清淡', '酸甜', '咸鲜', '酱香', '蒜香', '葱香', '姜香', '咖喱', '奶香', '甜口', '黑椒', '藤椒', '泡椒', '孜然', '烟熏', '五香', '芥末', '鲜辣', '酸辣', '苦鲜'],
  // 辣度：独立一问（单选，描述吃辣程度）
  spicy: ['不辣', '微辣', '中辣', '重辣'],
  // 菜系：更细粒度（按地域/流派拆分；去掉过泛的大类与重复项）
  // 注：潮汕菜/客家菜/本帮菜 已下挂到对应大类，见下方 HIER
  cuisine: ['川菜', '湘菜', '粤菜', '鲁菜', '闽菜', '徽菜', '江浙菜', '楚菜(湖北)', '滇菜(云南)', '黔菜(贵州)', '东北菜', '西北菜', '新疆菜', '西藏菜', '家常菜', '日料', '韩餐', '泰餐', '越南菜', '印度菜', '意大利菜', '法餐', '墨西哥菜', '希腊菜', '土耳其菜'],
  // 主食：可展开大类（米饭/面条/炒饭/饺子/馄饨/包子/馅饼/盖浇饭，小类见 config.HIER.type）+ 其余无子类的独立主食
  // · 米饭大类的小类=米的种类；面条大类的小类=打卤面/热汤面等做法形态
  // · 炒饭/有馅主食的馅料配料由 AI 依用户肉类/菜类偏好搭配（见后端提示词）
  type: ['米饭', '面条', '炒饭', '盖浇饭', '饺子', '馄饨', '包子', '馅饼', '煲仔饭', '粥品', '米线', '米粉', '意面', '乌冬面', '螺蛳粉', '馒头', '烧麦', '三明治', '寿司', '披萨', '汉堡', '卷饼', '肉夹馍', '凉皮', '饭团', '煎饼', '面包甜点', '沙拉'],
  // 肉类：常见肉/蛋白来源。丸子已删除；各肉类下挂「部位」子类（见下方 HIER），鸡蛋保留为单独大类
  meat: ['猪肉', '牛肉', '羊肉', '鸡肉', '鸭肉', '兔肉', '牛蛙', '田鸡', '鹅', '鸽肉', '黄鳝', '驴肉', '甲鱼', '泥鳅', '淡水鱼', '鹌鹑', '海鲜', '鸡蛋', '鸽子蛋', '鹌鹑蛋', '特色禽类'],
  // 配饮：与小吃场景强相关（如豆浆/酸梅汤/奶茶），AI 生成小吃配饮时优先采用；普通场景不强制
  drink: ['豆浆', '酸梅汤', '奶茶', '柠檬水', '可乐', '雪碧', '啤酒', '果汁', '咖啡', '清茶', '绿豆汤', '酸奶', '水'],
  // 菜类：按词料库（dishes.json 标签 + 菜谱库食材）对齐重构为「大类+细分品种」。
  // 每个大类下挂词料库真实出现的菜名；选大类即可（AI 在该大类下自由选用），点箭头展开可进一步挑具体品种。
  // 小料回归菜类：香菜→绿叶菜，葱/蒜/姜→葱蒜类，小米辣→其他时蔬；海带作为单独一类归入「其他时蔬」。
  veg: ['绿叶菜', '白菜类', '瓜茄类', '根茎类', '花菜类', '菌菇类', '豆制品', '葱蒜类', '其他时蔬'],
  avoid: ['不吃香菜', '不吃葱', '不吃姜', '不吃蒜', '素食', '过敏原'],
  // 菜品做法：更细粒度（按烹饪方式拆分）
  cookMethod: ['炒', '炖', '蒸', '煮', '煎', '炸', '凉拌', '烤', '煲', '焖', '烩', '生食']
};
// 两级联动：大类 ⊃ 小类（小类为「可选细化项」——选大类后不会自动弹出小类，需点右侧箭头才展开；
// 选小类即隐含带大类，便于后端侧重判断：大类=基础偏好，小类=在该大类内更偏好的细分）
const { HIER, ALLERGEN, ING_CATEGORIES, VEG_ALIAS } = require('../../utils/config');
const MASTER = require('../../utils/ingredient_master'); // 主库具体食材（并入 4/5/6 分类页弹窗，勾选写 masterIngredients，与社区贡献 communityIngredients 分离）
const norm = s => String(s).trim().toLowerCase(); // 归一化用于去重比较

// 同物异名别名反查表：通用名 → 别名数组（复用 config.VEG_ALIAS，与后端四副本同源）。
// 用于偏好选择时给食材标注常用别名，如「千张（干豆腐/豆腐皮/百叶）」，方便用户识别。
const ALIAS_OF = (() => {
  const m = {};
  Object.keys(VEG_ALIAS || {}).forEach(k => {
    const std = VEG_ALIAS[k];
    if (!m[std]) m[std] = [];
    if (m[std].indexOf(k) === -1) m[std].push(k);
  });
  // 仅保留确实有别名项的条目
  Object.keys(m).forEach(k => { if (!m[k].length) delete m[k]; });
  return m;
})();
// 给弹窗 chip 列表注入 alias 提示（不改变 label 值，不破坏已存偏好与后端匹配）
function decorateAlias(list) {
  if (!Array.isArray(list)) return list;
  return list.map(it => {
    const tip = it && it.label && ALIAS_OF[it.label];
    return tip ? Object.assign({}, it, { alias: tip.join('/') }) : it;
  });
}

// 社区食材（ingredient_library）：仅在第 7 步独立展示
// 选中项存 communityIngredients（后端「优先包含」，不改推荐语义）
// 说明：历史上曾按 ING_CATEGORY 并入 4/5/6 分类页，现改为「只在第 7 步显示，避免与分类页重复」

// 两级联动字段展示：小类渲染为「大类（小类）」，如 酸甜（偏酸）、猪肉（里脊肉）
function formatHier(field, arr) {
  if (!Array.isArray(arr) || !arr.length) return '还没选哦';
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
      else if (!used.has(item)) parts.push(item);
    } else {
      parts.push(item);
    }
  });
  return parts.length ? parts.join('、') : '还没选哦';
}

// 社区食材（第 7 步）分类汇总文本：「分类（食材1、食材2）」，选小类必显示大类
function formatCommunityCats(cats) {
  const parts = [];
  let count = 0;
  (cats || []).forEach(c => {
    if (!c.selCount) return;
    const names = c.children.filter(x => x.sel).map(x => x.label);
    if (!names.length) return;
    parts.push(c.label + '（' + names.join('、') + '）');
    count += names.length;
  });
  return { text: parts.length ? parts.join('、') : '还没选哦', count };
}

const STEP_FIELD = { 1: 'taste', 2: 'spicy', 3: 'cuisine', 4: 'type', 5: 'meat', 6: 'veg', 7: 'communityIngredients', 8: 'cookMethod', 9: 'avoid', 10: 'scene', 11: 'drink' };
const TOTAL_STEP = 11;  // 1口味/2辣度/3菜系/4主食/5肉类/6菜类/7社区贡献食材/8做法/9忌口/10场景/11配饮
// 注：社区食材只在第 7 步独立展示，不并入 4/5/6 分类页（避免重复），选中存 communityIngredients
// 原生分组字段 → 中文名（底部弹层标题 / picker 形态入口文案）
const FIELD_LABEL = { cuisine: '菜系', type: '主食', meat: '肉类', veg: '蔬菜/菜类', drink: '饮料' };

// 每个步骤底部的引导提示（针对性文案）
const STEP_TIP = {
  1: '💡 口味风格可多选；「酸甜」点开还能选「偏酸 / 偏甜」表达侧重。',
  2: '💡 按平时吃辣程度选一个即可，也可不选。',
  3: '💡 偏爱的菜系可多选；粤菜、江浙菜等点开还能挑更细的流派（如潮汕菜、本帮菜）。',
  4: '💡 常吃的主食可多选；点开「米饭」选米的种类、点开「面条」选做法；饺子、炒饭等有馅主食的配料会按你的肉 / 菜偏好搭配。',
  5: '💡 常吃的肉类可多选；点开大类还能挑具体部位（如猪肉 → 里脊肉、五花肉）。',
  6: '💡 喜欢的蔬菜 / 菜类可多选；已按词料库细分大类，点开可进一步挑具体品种。',
  7: '🌟 这里列出大家贡献并经审核的食材，挑出你想吃的，之后搭配时会优先包含。',
  8: '💡 偏好的烹饪做法可多选；会自动规避不搭的组合。',
  9: '💡 有忌口就勾上，可多选；点「过敏原」可自定义填写，之后搭配时自动规避。',
  10: '💡 每个场景都会配好菜品图片，场景越多图片越多、准备越久；服务端繁忙（请求被限流）时可能超时，导致部分场景无图，可稍后重试。',
  11: '💡 喜欢的饮料可多选；选了「小吃」或「下午茶」场景时都会出现，可按你的饮料偏好推荐解腻饮品。'
};

function join(arr) {
  return Array.isArray(arr) && arr.length ? arr.join('、') : '还没选哦';
}

Page({
  data: {
    step: 1,
    quick: false,          // C+A quick 轻引导模式：仅 5 问（忌口/口味/肉类/菜类/主食）
    totalStep: TOTAL_STEP,
    multiOptions: [],   // 当前步骤的多选项 [{label, sel, allergen?}]
    sceneOptions: SCENE,
    selText: '还没选哦',
    selCount: 0,
    stepTip: STEP_TIP[1],
    sceneHint: '',
    taste: [],
    spicy: '',          // 辣度（单选）
    cuisine: [],
    type: [],
    meat: [],
    veg: [],
    cookMethod: [],
    drink: [],          // 配饮偏好（多选，与小吃场景强相关）
    avoid: [],
    communityIngredients: [],   // 社区贡献食材（仅 ingredient_library 勾选，AI 优先包含）
    masterIngredients: [],      // 主库具体食材勾选（来自 MASTER，4/5/6 步弹窗选，与 communityIngredients 彻底分离）
    communityIngList: [],       // 从 getCommunityIngredients 拉取的全部社区食材名(含分类)
    ingSelMap: { veg: {}, meat: {}, type: {} },  // 主库具体食材勾选态 {field:{parent:{ing:true}}}
    ingCount: { veg: {}, meat: {}, type: {} },  // 主库各小类已选具体食材数 {field:{parent:count}}（chip 角标）
    communityCats: [],          // 第7步按分类分组后的数据 [{label, children:[{label,sel}], selCount, sel}]
    communityMode: false,       // 第7步是否处于「分类弹窗」模式（替代通用多选网格）
    showCommunitySheet: false,  // 社区食材分类弹窗
    communitySheetParent: '',   // 当前弹窗所属分类
    communitySheetChildren: [], // 当前弹窗内该分类的食材列表(含 sel)
    communitySheetChildrenShown: [], // 弹窗渲染列表（搜索过滤后）
    communityKeyword: '',       // 社区弹窗内搜索关键词
    allergens: [],      // 过敏原列表（每个独立词条，提交时拼成「过敏原：X」并入 avoid）
    scene: [],
    spicyOptions: [],   // 辣度候选（预计算）
    multiMode: true,    // 当前步骤是否为多选模式（决定渲染多选网格还是单选）
    hierMode: false,    // 当前步骤是否为两级联动（菜系/肉类）
    hierNative: false,  // 两级联动是否用原生 checkbox-group 分组（taste 用旧展开时为 false）
    hierField: '',      // 当前原生分组对应的字段名（用于 onHierChange 识别）
    hierFieldLabel: '', // 当前原生分组字段的中文名（保留备用）
    hierGroups: [],     // 大类平铺数据：[{label,sel,hasChild?,children?:[{label,sel}]}]
    sheetParent: '',       // 当前打开的「大类专属弹窗」所属大类
    sheetParentSel: false, // 该大类自身是否被勾选
    sheetChildren: [],     // 该大类的小类列表（含 sel 状态，全量，作为搜索过滤的源）
    sheetChildrenShown: [],// 弹窗内实际渲染的小类列表（按 sheetKeyword 过滤）
    sheetKeyword: '',      // 弹窗内搜索关键词
    showHierSheet: false, // 是否弹出「大类专属弹窗」
    expanded: {},       // 两级联动展开状态：{ field: { 大类label: true } }（仅 taste 步骤使用）
    submitting: false,
    steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    sceneSelText: '还没选哦',
    sceneSelCount: 0,
    drinkWarn: '',           // 配饮步选中偏早餐饮品时的不搭提示
    allergenWarn: '',         // 过敏原冲突提示（阻止下一步）
    allergenDialog: false,    // 过敏原冲突自绘弹窗
    allergenDialogList: []    // 冲突项列表
    ,
    privacyAuthorized: false,   // 隐私协议是否已授权（拒绝则 false：不退出，禁用保存）
    statusBarHeight: 20,
    showBack: false
  },

  onLoad(options) {
    if (getApp().enterGuard()) return;   // 封禁用户进不去
    const opt = options || {};
    // C+A quick 模式（2026-09-07）：首页新用户轻引导，仅 5 步：忌口→口味→肉类→菜类→主食，每步可跳过
    const quick = opt.mode === 'quick';
    // 场景直改模式（来自「我的」→ 修改场景）：跳到第 10 步场景；若选「小吃/下午茶」仍展示配饮步（第 11 步）
    const sceneOnly = opt.sceneOnly === '1' || opt.sceneOnly === 'true';
    // 首次引导（无 mode=edit）隐藏返回键；从「我的」修改偏好 / 场景直改 / quick 轻引导时显示返回
    let statusBarHeight = 20;
    try {
      const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
      if (info && info.statusBarHeight) statusBarHeight = info.statusBarHeight;
    } catch (e) {}
    // 支持从「我的」直接跳到指定步骤（如 修改场景 → 第 10 步）
    let initialStep = quick ? 9 : 1;   // quick 从忌口步开始
    // 单步编辑：从「我的」点某条偏好进入（mode=edit 且带了 step）→ 只编辑该条，底部直接「保存」而非「下一步」
    const singleStep = opt.mode === 'edit' && !!opt.step;
    if (opt.step) {
      const s = parseInt(opt.step, 10);
      if (!isNaN(s) && s >= 1 && s <= TOTAL_STEP) initialStep = s;
    }
    this.setData({ quick, showBack: opt.mode === 'edit' || sceneOnly || quick, isEdit: opt.mode === 'edit', singleStep, statusBarHeight, sceneOnly, step: initialStep });
    // 复用缓存中的偏好，便于「修改偏好」时回填
    const c = cache.getPrefs();
    if (c) {
      const rawAvoid = (c.avoid || []).filter(x => x !== '过敏原');
      const allergens = rawAvoid
        .filter(x => /^过敏原：(.*)$/.test(x))
        .map(x => x.replace(/^过敏原：/, ''));
      const avoid = rawAvoid.filter(x => !/^过敏原：/.test(x));
      // 旧数据兼容：历史 communityIngredients 混入了主库具体食材（MASTER），此处按主库全集拆分，
      // 主库项归 masterIngredients、其余保留为纯社区贡献；新数据本就分离，此处分空操作。
      const split = this._splitMasterFromCommunity(c.communityIngredients || [], c.masterIngredients || []);
      this.setData({
        taste: c.taste || [],
        spicy: c.spicy || '',
        cuisine: c.cuisine || [],
        type: c.type || [],
        meat: c.meat || [],
        veg: c.veg || [],
        cookMethod: c.cookMethod || [],
        drink: c.drink || [],
        avoid,
        allergens,
        communityIngredients: split.community,
        masterIngredients: split.master,
        scene: c.scene || []
      }, () => { this.refreshMulti(); this._buildIngSelMap(); this.applyStepFlags(); });
    } else {
      this.refreshMulti();
      this._buildIngSelMap();
      this.applyStepFlags();
    }
    this.loadCommunityIngredients();  // 拉取社区贡献食材库（ingredient_library），仅第 7 步展示
    this.ensurePrivacy();   // 进入偏好收集页即检查并弹出隐私授权（用户尚未授权时）
  },

  // 拉取社区贡献食材库（ingredient_library），仅第 7 步展示。
  // 本地缓存优先即时渲染（避免每次进入闪空/加载），超过节流窗口再后台静默刷新云端。
  loadCommunityIngredients() {
    const refresh = (list) => {
      if (!Array.isArray(list) || !list.length) return;
      this.setData({ communityIngList: list }, () => {
        this._buildCommunityCats();
        if (this.data.step === 7) this.refreshMulti();
      });
    };
    // 1) 本地缓存命中 → 立即渲染分类，不再闪空
    const cached = cache.getCommunityIngredients();
    if (cached && Array.isArray(cached.list) && cached.list.length) refresh(cached.list);
    // 2) 节流：距上次成功拉取 < 6h 则跳过云端（食材库低频变更，半天粒度足够）
    const ts = cache.getCommunityIngredientsTs();
    if (ts && Date.now() - ts < 6 * 3600 * 1000) return;
    wx.cloud.callFunction({ name: 'getCommunityIngredients' }).then(res => {
      const list = (res.result && res.result.code === 200 && Array.isArray(res.result.list)) ? res.result.list : [];
      if (!list.length) return;
      cache.setCommunityIngredients(list);
      refresh(list);
    }).catch(() => { clientLog.log('setup.loadCommunityIngredients', 'load failed'); });
  },

  // 把扁平的社区食材列表(含分类)按分类分组，供第 7 步分类弹窗展示；分类顺序以 ING_CATEGORIES 为准
  _buildCommunityCats() {
    // 仅展示未并入主库（HIER）的社区食材；已进主库的由 4/5/6 分类页作为内置项呈现，第 7 步不再重复
    const list = (this.data.communityIngList || []);
    const sel = new Set(this.data.communityIngredients || []);
    const map = {};
    // 调味干货仅作贡献提交时的内部归类，不在偏好选择页（第7步）渲染（用户不可当食材偏好勾选）
    const order = ING_CATEGORIES.slice().filter(c => c !== '调味干货');
    list.forEach(it => {
      const cat = (it.category && String(it.category).trim()) || '其他';
      if (!map[cat]) { map[cat] = []; if (order.indexOf(cat) < 0) order.push(cat); }
      map[cat].push(it);
    });
    return order.filter(c => map[c] && map[c].length).map(cat => {
      const children = decorateAlias(map[cat].map(it => ({ label: it.value, sel: sel.has(it.value) })));
      const sc = children.filter(c => c.sel).length;
      return { label: cat, children, selCount: sc, sel: sc > 0 };
    });
  },

  // 将食材数组按「是否属主库(MASTER)」拆分为 主库勾选 / 纯社区贡献 两组（去重）
  _splitMasterFromCommunity(community, master) {
    const masterAll = Object.values(MASTER).reduce((acc, group) => acc.concat(Object.values(group).reduce((a, g) => a.concat(g), [])), []);
    const masterNorm = new Set(masterAll.map(norm));
    const comm = (Array.isArray(community) ? community : []).filter(x => !masterNorm.has(norm(x)));
    const mas = new Set((Array.isArray(master) ? master : []).map(norm));
    (Array.isArray(community) ? community : []).forEach(x => { if (masterNorm.has(norm(x))) mas.add(norm(x)); });
    // masterNorm 为归一化集合，需还原回原始食材名（取 MASTER 首次出现的原名）
    const normToRaw = {};
    masterAll.forEach(x => { if (!normToRaw[norm(x)]) normToRaw[norm(x)] = x; });
    const masterOut = Array.from(mas).map(n => normToRaw[n]).filter(Boolean);
    // 去重并保序
    const commOut = comm.filter((x, i) => comm.indexOf(x) === i);
    return { master: masterOut, community: commOut };
  },

  // 由 masterIngredients 反推主库具体食材勾选态 {field:{parent:{ing:true}}} 与角标 {field:{parent:count}}
  _buildIngSelMap() {
    const ci = this.data.masterIngredients || [];
    const map = { veg: {}, meat: {}, type: {} };
    const ingCount = { veg: {}, meat: {}, type: {} };
    for (const field of ['veg', 'meat', 'type']) {
      const mf = MASTER[field] || {};
      for (const parent of Object.keys(mf)) {
        for (const ing of mf[parent]) {
          if (ci.indexOf(ing) > -1) {
            if (!map[field][parent]) map[field][parent] = {};
            map[field][parent][ing] = true;
          }
        }
      }
    }
    for (const field of ['veg', 'meat', 'type']) {
      for (const parent of Object.keys(map[field])) {
        const c = Object.keys(map[field][parent]).length;
        if (c) ingCount[field][parent] = c;
      }
    }
    this.setData({ ingSelMap: map, ingCount });
  },

  refreshMulti() {
    const step = this.data.step;
    this.setData({ stepTip: STEP_TIP[step] || '', communityMode: false });
    // 辣度（单选，第 2 步）
    if (step === 2) {
      const opts = BASE.spicy.map(label => ({ label, sel: this.data.spicy === label }));
      const arr = this.data.spicy ? [this.data.spicy] : [];
      this.setData({ spicyOptions: opts, multiMode: false, hierMode: false, selText: join(arr), selCount: this.data.spicy ? 1 : 0 });
      this.syncScene();
      return;
    }
    // 用餐场景（第 10 步）由各自 block（sceneList）自行渲染
    if (step === 10) {
      this.setData({ multiMode: false, hierMode: false });
      this.syncScene();
      return;
    }
    // 忌口（第 9 步）：含过敏原独立词条，不污染固定 avoid 数组
    if (step === 9) {
      const sel = this.data.avoid;
      const allergens = this.data.allergens;
      const fixedAvoid = BASE.avoid.filter(x => x !== '过敏原');
      const opts = [
        ...fixedAvoid.map(label => ({ label, sel: sel.indexOf(label) > -1, act: 'toggle' })),
        ...allergens.map(a => ({ label: '过敏原：' + a, sel: false, allergen: true, act: 'del-allergen', val: a })),
        { label: '➕ 添加过敏原', sel: false, act: 'add-allergen' }
      ];
      const selCount9 = sel.length + allergens.length;
      const selText9 = join(sel.concat(allergens.map(a => '过敏原：' + a)));
      this.setData({ multiOptions: opts, multiMode: true, hierMode: false, selText: selText9, selCount: selCount9 });
      this.syncScene();
      return;
    }
    // 社区贡献食材（第 7 步）：独立展示（供后续新提交露出），点分类弹窗多选；
    // 与 4/5/6 分类页的主库具体食材勾选（masterIngredients）相互独立、不互通。
    if (step === 7) {
      const cats = this._buildCommunityCats();
      // 仅统计社区贡献库(ingredient_library)内的勾选项；主库食材(MASTER)由 4/5/6 步呈现，不应串入本步汇总
      // 汇总文本带分类：选小类即显示「分类（食材）」大类
      const fmt = formatCommunityCats(cats);
      this.setData({ communityCats: cats, communityMode: true, multiMode: false, hierMode: false, selText: fmt.text, selCount: fmt.count });
      this.syncScene();
      return;
    }
  // 两级联动（口味=1 / 菜系=3 / 主食=4 / 肉类=5 / 菜类=6 / 配饮=11）
  // · 口味(1) 保留原「手风琴展开」组件（酸甜的偏酸/偏甜为互斥单选，checkbox 不便表达）
  // · 其余拥有小类的大类 → 改用微信原生 checkbox-group 分组多选（外层 scroll-view 限高，可滚动拓展）
  // · 两级联动大类：口味/菜系/主食/肉类/菜类/配饮（社区食材只在第 7 步，不并入此处）
  if (step === 1 || step === 3 || step === 4 || step === 5 || step === 6 || step === 11) {
    const field = STEP_FIELD[step];
    const sel = this.data[field];
    if (step === 1) {
      // 旧展开（手风琴）：仅口味步骤使用
      // effective 仅取用户「手动点击箭头」展开的大类；选大类不再自动弹出小类——
      // 小类是可选项，仅用于「在已选大类中进一步表达更偏好的细分」，点右侧箭头才展开
      const effective = (this.data.expanded && this.data.expanded[field]) || '';
      const opts = BASE[field].map(label => {
        const children = HIER[field] && HIER[field][label];
        if (children && children.length) {
          return {
            label,
            sel: sel.indexOf(label) > -1,
            expandable: true,
            expanded: label === effective,
            children: children.map(c => ({ label: c, sel: sel.indexOf(c) > -1 }))
          };
        }
        return { label, sel: sel.indexOf(label) > -1 };
      });
      this.setData({ multiOptions: opts, multiMode: true, hierMode: true, hierNative: false, selText: formatHier(field, sel), selCount: sel.length });
      this.syncScene();
      return;
    }
    // 原生分组：构造 hierGroups（页面平铺「大类」chip；有子类的大类点开其专属弹窗）
    const groups = BASE[field].filter((label, i, a) => a.indexOf(label) === i).map(label => {
      const children = HIER[field] && HIER[field][label];
      const masterList = (MASTER[field] && MASTER[field][label]) || [];
      const hasComm = masterList.length > 0;
      if (children && children.length) {
        return {
          label,
          // 大类自身或其任一子类被选中都应高亮
          sel: sel.indexOf(label) > -1 || children.some(c => sel.indexOf(c) > -1),
          hasChild: true,
          hasComm,
          children: children.map(c => ({ label: c, sel: sel.indexOf(c) > -1 }))
        };
      }
      return { label, sel: sel.indexOf(label) > -1, hasComm };
    });
    // 社区食材只在第 7 步独立展示，不并入 4/5/6 分类页汇总（避免重复，见第 104 行注释）
    const finalText = formatHier(field, sel);
    this.setData({ hierField: field, hierFieldLabel: FIELD_LABEL[field] || field, hierGroups: groups, multiOptions: [], multiMode: true, hierMode: true, hierNative: true, communityMode: false, selText: finalText, selCount: sel.length });
    this.syncScene();
    return;
  }
    // 其余多选步骤（做法=8）：普通平铺
    const field = STEP_FIELD[step];
    const sel = this.data[field];
    const opts = BASE[field].map(label => ({ label, sel: sel.indexOf(label) > -1 }));
    this.setData({ multiOptions: opts, multiMode: true, hierMode: false, selText: join(sel), selCount: sel.length });
    this.syncScene();
  },

  // 场景选中态与多场景提示预计算（WXML 不支持方法调用，预计算到 sceneList / sceneSelText）
  syncScene() {
    const sceneList = sceneListSel(this.data.scene);
    const sceneSelText = join(this.data.scene);
    const sceneSelCount = this.data.scene.length;
    // 多场景提示：每个场景固定扣 1 次，N 个场景共扣 N 次（2026-09-07 用户定：去阶梯，与云端 commitRecommendation 一致）
    const n = this.data.scene.length;
    const sceneHint = n > 0 ? `已选 ${n} 个场景：预计消耗 ${n} 次免费次数` : '';
    const hasSnack = this.data.scene.indexOf('小吃') > -1
      || this.data.scene.indexOf('下午茶') > -1;
    // 步骤生成逻辑：
    // · quick 轻引导(C+A)：仅 5 问 忌口→口味→肉类→菜类→主食（avoid/taste/meat/veg/type），每步可跳过
    // · 修改场景(sceneOnly)：仅场景步(10)；选「小吃/下午茶」追加配饮步(11)
    // · 修改偏好(mode=edit 且非 sceneOnly)：到忌口(9)结束，不含场景步/配饮步（场景改动走「修改场景」入口）
    // · 首次设置：完整流程到场景步(10)，选「小吃/下午茶」追加配饮步(11)
    let stepList;
    if (this.data.quick) {
      stepList = [9, 1, 5, 6, 4];   // 忌口→口味→肉类→菜类→主食
    } else if (this.data.sceneOnly) {
      stepList = [10];
      if (hasSnack) stepList.push(11);
    } else if (this.data.isEdit) {
      // 单步编辑（从「我的」点某条进入）：steps 仅含当前步，底部直接「保存」而非一路走到忌口
      stepList = this.data.singleStep ? [this.data.step] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
    } else {
      stepList = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      if (hasSnack) stepList.push(11);
    }
    const totalStep = stepList.length;
    const steps = stepList;
    this.setData({ sceneList, sceneSelText, sceneSelCount, sceneHint, steps, totalStep });
    // 配饮（第 11 步）：若选中偏早餐的饮品，提示可能和小吃/下午茶不搭
    const breakfast = ['豆浆', '绿豆汤', '酸奶'];
    const hits = this.data.drink.filter(d => breakfast.indexOf(d) > -1);
    const hasSnackOrTea = this.data.scene.indexOf('小吃') > -1 || this.data.scene.indexOf('下午茶') > -1;
    this.setData({
      drinkWarn: hasSnackOrTea && hits.length
        ? `「${hits.join('、')}」偏早餐，可能和生成的小吃/下午茶不太搭，可改选奶茶、汽水、酸梅汤、咖啡、花茶等。`
        : ''
    });
  },



  toggleMulti(e) {
    const { label, act, val } = e.currentTarget.dataset;
    // 过敏原：点击「➕ 添加过敏原」弹窗新增；点击已有过敏原词条则移除
    if (act === 'add-allergen') { this.addAllergan(); return; }
    if (act === 'del-allergen') { this.removeAllergan(val); return; }
    const field = STEP_FIELD[this.data.step];
    const arr = this.data[field].slice();
    const i = arr.indexOf(label);
    if (i === -1) {
      arr.push(label);
    } else {
      arr.splice(i, 1);
      // 取消某大类时，连带取消其展开的小类（如 酸甜 → 偏酸/偏甜）
      const children = HIER[field] && HIER[field][label];
      if (children && children.length) children.forEach(k => { const j = arr.indexOf(k); if (j > -1) arr.splice(j, 1); });
    }
    if (field === 'meat' || field === 'veg') this.setData({ allergenWarn: '' });
    this.setData({ [field]: arr }, () => this.refreshMulti());
  },

  // 两级联动：点大类 chip 本体 → 切换该大类选中态（不影响展开）
  toggleParent(e) {
    const label = e.currentTarget.dataset.label;
    const field = STEP_FIELD[this.data.step];
    // 大类已有已选小类：点大类本体不取消大类，改为展开小类供修改（避免小类脱离大类）
    const children = HIER[field] && HIER[field][label];
    if (children && children.length && children.some(k => (this.data[field] || []).indexOf(k) > -1)) {
      this.toggleExpand(e);
      return;
    }
    const arr = this.data[field].slice();
    const i = arr.indexOf(label);
    const isOn = i === -1;
    if (isOn) {
      arr.push(label);
    } else {
      arr.splice(i, 1);
      // 取消某大类时，连带取消其展开的小类（如 酸甜 → 偏酸/偏甜）
      const children = HIER[field] && HIER[field][label];
      if (children && children.length) children.forEach(k => { const j = arr.indexOf(k); if (j > -1) arr.splice(j, 1); });
    }
    // 第 5/6 步：父类与过敏原冲突提醒
    if ((this.data.step === 5 || this.data.step === 6) && (field === 'meat' || field === 'veg') && isOn) {
      const hit = this.checkAllergenConflict(field, label);
      if (hit) { this.setData({ allergenWarn: `「${label}」与过敏原「${hit}」冲突，请处理后再继续` }); }
    } else if (field === 'meat' || field === 'veg') {
      this.setData({ allergenWarn: '' });
    }
    this.setData({ [field]: arr }, () => this.refreshMulti());
  },

  // 两级联动：点大类右侧箭头 → 切换展开/收起（手风琴：同一时间只展开一个大类）
  toggleExpand(e) {
    const label = e.currentTarget.dataset.label;
    const field = STEP_FIELD[this.data.step];
    const expanded = Object.assign({}, this.data.expanded);
    // 单值记录当前展开的大类；再次点击当前项则收起，点其它项则切换（自动收起原来的）
    expanded[field] = expanded[field] === label ? '' : label;
    this.setData({ expanded }, () => this.refreshMulti());
  },

  // 点击空白区域关闭所有展开的小类
  closeSubgrid() {
    this.setData({ expanded: {} });
  },

  // 两级联动：点小类 → 切换小类选中态；选中时隐含带上其大类（触发后端侧重判断）
  toggleChild(e) {
    const { parent, label } = e.currentTarget.dataset;
    const field = STEP_FIELD[this.data.step];
    const arr = this.data[field].slice();
    const i = arr.indexOf(label);
    if (i === -1) {
      // 酸甜子类冲突：「偏酸」「偏甜」互斥，先检测再决定是否添加
      if (parent === '酸甜') {
        const sibling = label === '偏酸' ? '偏甜' : '偏酸';
        if (arr.indexOf(sibling) > -1) {
          wx.showToast({ title: '「偏酸」和「偏甜」不能同时选，请先取消另一个', icon: 'none', duration: 2000 });
          return;
        }
      }
      arr.push(label);
      if (arr.indexOf(parent) === -1) arr.push(parent);   // 选小类即隐含带大类
      // 第 5/6 步肉类/菜类：小类与过敏原冲突时提醒
      if ((this.data.step === 5 || this.data.step === 6) && (field === 'meat' || field === 'veg')) {
        const hit = this.checkAllergenConflict(field, label);
        if (hit) { this.setData({ allergenWarn: `「${label}」与过敏原「${hit}」冲突，请处理后再继续` }); }
      }
      // 酸甜的子类（偏酸/偏甜）互斥，选完即收起展开，避免多选项常驻
      if (parent === '酸甜') {
        const expanded = Object.assign({}, this.data.expanded);
        expanded[field] = '';
        this.setData({ [field]: arr, expanded }, () => this.refreshMulti());
        return;
      }
    } else {
      arr.splice(i, 1);
    }
    // 小类支持多选，不自动收起
    this.setData({ [field]: arr }, () => this.refreshMulti());
  },

  // 大类专属弹窗内 checkbox-group 变更：value = 该大类小类的勾选集合
  // 大类自身在外面 chip 选（不在弹窗内），此处只重建其小类部分
  // 内置小类写 field；主库具体食材（来自 md 主库）写 masterIngredients
  onHierChildChange(e) {
    const field = e.currentTarget.dataset.field;
    const parent = e.currentTarget.dataset.parent;
    const hier = HIER[field] || {};
    const builtinChildren = hier[parent] || [];
    const builtinNorm = builtinChildren.map(norm);
    const masterList = ((MASTER[field] && MASTER[field][parent]) || []).filter(ing => builtinNorm.indexOf(norm(ing)) === -1);
    // 搜索过滤后，隐藏项的勾选态需保留：合并「隐藏且已选」与「当前可见勾选」
    const checkedVisible = e.detail.value || [];
    const fullList = this.data.sheetChildren || [];
    const shownSet = new Set((this.data.sheetChildrenShown || []).map(c => c.label));
    const hiddenSel = fullList.filter(it => !shownSet.has(it.label) && it.sel).map(it => it.label);
    const checked = hiddenSel.concat(checkedVisible);
    const builtinChecked = checked.filter(v => builtinChildren.indexOf(v) > -1);
    const commChecked = checked.filter(v => masterList.indexOf(v) > -1);
    // 内置小类 → 写 field
    const arr = this.data[field].slice();
    let filtered = arr.filter(x => builtinChildren.indexOf(x) === -1);
    builtinChecked.forEach(v => { if (filtered.indexOf(v) === -1) filtered.push(v); });
    // 肉类/菜类：选中项与过敏原冲突提醒（仅 field 内置项）
    if (field === 'meat' || field === 'veg') {
      let warn = '';
      for (const item of filtered) {
        const hit = this.checkAllergenConflict(field, item);
        if (hit) { warn = `「${item}」与过敏原「${hit}」冲突，请处理后再继续`; break; }
      }
      this.setData({ allergenWarn: warn });
    }
    // 主库具体食材 → 写 masterIngredients（与主库勾选同源，与社区贡献 communityIngredients 彻底分离）
    const ci = (this.data.masterIngredients || [])
      .filter(x => masterList.indexOf(x) === -1)
      .concat(commChecked);
    // 同步刷新弹窗内勾选态，避免原生 checkbox 不跟随
    const sheetChildren = decorateAlias(builtinChildren
      .map(c => ({ label: c, sel: checked.indexOf(c) > -1 }))
      .concat(masterList.map(c => ({ label: c, sel: checked.indexOf(c) > -1, comm: true }))));
    // 按当前搜索词回写渲染列表（隐藏项仍保留在全量 sheetChildren 中）
    const kw = (this.data.sheetKeyword || '').trim();
    const sheetChildrenShown = kw ? sheetChildren.filter(c => c.label.indexOf(kw) > -1) : sheetChildren;
    this.setData({ [field]: filtered, masterIngredients: ci, sheetChildren, sheetChildrenShown }, () => {
      this._buildIngSelMap();
      this.refreshMulti();
    });
  },

  // 社区食材分类弹窗：打开某一分类的多选弹窗
  openCommunitySheet(e) {
    const label = e.currentTarget.dataset.label;
    const cat = (this.data.communityCats || []).find(c => c.label === label);
    if (!cat) return;
    const children = cat.children.map(c => ({ label: c.label, sel: c.sel }));
    this.setData({ communitySheetParent: label, communitySheetChildren: children, communitySheetChildrenShown: children, communityKeyword: '', showCommunitySheet: true });
    this.setTabBarHidden(true);
  },
  closeCommunitySheet() {
    this.setData({ showCommunitySheet: false });
    this.setTabBarHidden(false);
  },
  // 隐藏自定义 tab bar，避免被弹层遮挡
  setTabBarHidden(hidden) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ hidden: !!hidden });
    }
  },
  // 分类弹窗内 checkbox-group 变更：value = 该分类下选中的食材名集合
  onCommunityChildChange(e) {
    const parent = this.data.communitySheetParent;
    const cats = this.data.communityCats || [];
    const cat = cats.find(c => c.label === parent);
    const catVals = cat ? cat.children.map(c => c.label) : [];
    // 搜索过滤后，隐藏项的勾选态需保留：合并「隐藏且已选」与「当前可见勾选」
    const checkedVisible = e.detail.value || [];
    const fullList = this.data.communitySheetChildren || [];
    const shownSet = new Set((this.data.communitySheetChildrenShown || []).map(c => c.label));
    const hiddenSel = fullList.filter(it => !shownSet.has(it.label) && it.sel).map(it => it.label);
    const vals = hiddenSel.concat(checkedVisible);
    const sel = this.data.communityIngredients || [];
    // 移除该分类全部食材，再并入当前勾选项
    const next = sel.filter(v => catVals.indexOf(v) === -1).concat(vals);
    const nextCats = cats.map(c => {
      if (c.label !== parent) return c;
      const children = c.children.map(ch => ({ label: ch.label, sel: vals.indexOf(ch.label) > -1 }));
      const sc = children.filter(x => x.sel).length;
      return { label: c.label, children, selCount: sc, sel: sc > 0 };
    });
    // 同步弹窗内勾选态，并按搜索词回写渲染列表（隐藏项仍保留在全量 communitySheetChildren 中）
    const sheetChildren = decorateAlias(catVals.map(c => ({ label: c, sel: vals.indexOf(c) > -1 })));
    const kw = (this.data.communityKeyword || '').trim();
    const sheetChildrenShown = kw ? sheetChildren.filter(c => c.label.indexOf(kw) > -1) : sheetChildren;
    // 汇总文本带分类：选小类即显示「分类（食材）」大类
    const fmt = formatCommunityCats(nextCats);
    this.setData({ communityIngredients: next, communityCats: nextCats, communitySheetChildren: sheetChildren, communitySheetChildrenShown: sheetChildrenShown, selText: fmt.text, selCount: fmt.count }, () => this._buildIngSelMap());
  },
  // 社区弹窗内搜索：按关键词过滤渲染列表（全量 communitySheetChildren 保留，仅隐藏不匹配项）
  onCommunitySearch(e) {
    const kw = (e.detail.value || '').trim();
    const all = this.data.communitySheetChildren || [];
    const shown = kw ? all.filter(c => c.label.indexOf(kw) > -1) : all;
    this.setData({ communityKeyword: e.detail.value, communitySheetChildrenShown: shown });
  },
  onCommunitySearchClear() {
    this.setData({ communityKeyword: '', communitySheetChildrenShown: this.data.communitySheetChildren || [] });
  },

  noop() {},

  // 底部「大类专属弹窗」：关闭
  closeHierSheet() {
    this.setData({ showHierSheet: false });
  },

  // 两级联动大类 chip：点框直接切换「大类自身」（与无小类的大类一致）
  onHierParentTap(e) {
    const label = e.currentTarget.dataset.label;
    const field = this.data.hierField;
    // 大类已有已选小类：点大类本体不取消大类，改为打开专属弹窗供修改（避免小类脱离大类）
    const children = HIER[field] && HIER[field][label];
    if (children && children.length && children.some(k => (this.data[field] || []).indexOf(k) > -1)) {
      this.openHierChildSheet(e);
      return;
    }
    const arr = this.data[field].slice();
    const i = arr.indexOf(label);
    if (i === -1) arr.push(label); else arr.splice(i, 1);
    // 肉类/菜类：重算过敏原冲突提醒
    if (field === 'meat' || field === 'veg') {
      let warn = '';
      for (const item of arr) {
        const hit = this.checkAllergenConflict(field, item);
        if (hit) { warn = `「${item}」与过敏原「${hit}」冲突，请处理后再继续`; break; }
      }
      this.setData({ allergenWarn: warn });
    }
    this.setData({ [field]: arr }, () => this.refreshMulti());
  },

  // 大类专属弹窗内容：内置小类（写 field）+ 主库具体食材（写 masterIngredients）合并展示
  // 内置小类与主库食材同名时去重（优先内置）
  _buildSheetChildren(field, parent) {
    const hier = HIER[field] || {};
    const builtinChildren = hier[parent] || [];
    const builtinNorm = builtinChildren.map(norm);
    const masterList = ((MASTER[field] && MASTER[field][parent]) || []).filter(ing => builtinNorm.indexOf(norm(ing)) === -1);
    const arr = this.data[field] || [];
    const ci = this.data.masterIngredients || [];
    const builtin = builtinChildren.map(c => ({ label: c, sel: arr.indexOf(c) > -1 }));
    const comm = masterList.map(ing => ({ label: ing, sel: ci.indexOf(ing) > -1, comm: true }));
    return decorateAlias(builtin.concat(comm));
  },
  // 点大类右侧「▸」：打开该大类专属弹窗（弹窗内选小类/具体食材，大类自身在外面 chip 选）
  openHierChildSheet(e) {
    const label = e.currentTarget.dataset.label;
    const field = this.data.hierField;
    const sheetChildren = this._buildSheetChildren(field, label);
    this.setData({
      sheetParent: label,
      sheetChildren,
      sheetChildrenShown: sheetChildren,
      sheetKeyword: '',
      showHierSheet: true
    });
  },
  // 弹窗内搜索：按关键词过滤渲染列表（全量 sheetChildren 保留，仅隐藏不匹配项）
  onSheetSearch(e) {
    const kw = (e.detail.value || '').trim();
    const all = this.data.sheetChildren || [];
    const shown = kw ? all.filter(c => c.label.indexOf(kw) > -1) : all;
    this.setData({ sheetKeyword: e.detail.value, sheetChildrenShown: shown });
  },
  onSheetSearchClear() {
    this.setData({ sheetKeyword: '', sheetChildrenShown: this.data.sheetChildren || [] });
  },

  // 过敏原：点击「➕ 添加过敏原」弹窗新增一条
  async addAllergan() {
    wx.showModal({
      title: '添加过敏原',
      editable: true,
      placeholderText: '如：虾、蟹、花生、芒果',
      content: '',
      success: async (r) => {
        if (!r.confirm) return;
        const text = (r.content || '').trim();
        if (!text) return;
        const arr = this.data.allergens.slice();
        // 先本地快速拦截明显无效的输入
        const INVALID = ALLERGEN.INVALID;
        if (INVALID.indexOf(text) > -1) {
          wx.showToast({ title: `「${text}」不是有效过敏原`, icon: 'none' }); return;
        }
        // 常见有效过敏原白名单（常规20项 + 大类，直接放行不调 AI）
        const WHITE = ALLERGEN.WHITE;
        // 拆分拼接输入：如「虾蟹」→「虾」「蟹」，「鸡蛋牛奶」→「鸡蛋」「牛奶」
        const parts = [];
        let remaining = text;
        for (const w of [...WHITE].sort((a, b) => b.length - a.length)) {
          if (remaining.indexOf(w) > -1) {
            parts.push(w);
            remaining = remaining.replace(w, '');
          }
        }
        if (parts.length > 1) {
          let addedCount = 0;
          parts.forEach(p => { if (arr.indexOf(p) === -1) { arr.push(p); addedCount++; } });
          this.commitAllergens(arr, `已拆分添加 ${addedCount} 项`);
          return;
        }
        if (WHITE.indexOf(text) > -1) {
          if (arr.indexOf(text) === -1) arr.push(text);
          this.commitAllergens(arr, '已添加');
          return;
        }
        // AI 二次校验，通过后才添加
        wx.showLoading({ title: '校验中', mask: true });
        try {
          const check = await wx.cloud.callFunction({ name: 'validateAllergen', data: { text } });
          wx.hideLoading();
          if (check.result && check.result.code === 200 && check.result.data.valid) {
            if (arr.indexOf(text) === -1) arr.push(text);
            this.commitAllergens(arr, '已添加');
          } else {
            wx.showToast({ title: `「${text}」不是有效过敏原`, icon: 'none', duration: 2000 });
            return;
          }
        } catch (e) {
          wx.hideLoading();
          clientLog.log('setup.validateAllergen', e);
          // 网络异常不再兜底放行：校验失败（不通过），不添加过敏原
          wx.showToast({ title: '校验失败，请重试', icon: 'none', duration: 2000 });
        }
      }
    });
  },

  // 过敏原添加落地：更新列表 + 即时扫描冲突（有冲突立即弹冲突窗，替代「添加成功」提示）
  commitAllergens(arr, msg) {
    this.setData({ allergens: arr }, () => {
      this.refreshMulti();
      const conflicts = this.scanAllergenConflicts();
      if (conflicts.length) {
        this.setData({ allergenDialog: true, allergenDialogList: conflicts });
      } else if (msg) {
        wx.showToast({ title: msg, icon: 'success', duration: 800 });
      }
    });
  },

  // 过敏原：点击已有词条 → 确认后移除
  removeAllergan(val) {
    wx.showModal({
      title: '移除过敏原',
      content: '确定移除「' + (val || '') + '」？',
      confirmText: '移除',
      confirmColor: '#E8533E',
      success: (r) => {
        if (!r.confirm) return;
        const arr = this.data.allergens.filter(x => x !== val);
        this.setData({ allergens: arr, allergenWarn: '' }, () => this.refreshMulti());
      }
    });
  },

  // 辣度单选：已选中则再次点击取消
  selectSpicy(e) {
    const label = e.currentTarget.dataset.label;
    const newSpicy = this.data.spicy === label ? '' : label;
    this.setData({ spicy: newSpicy }, () => this.refreshMulti());
  },

  // 用餐场景：支持多选
  toggleScene(e) {
    const label = e.currentTarget.dataset.label;
    const arr = this.data.scene.slice();
    const i = arr.indexOf(label);
    if (i === -1) {
      // 互斥拦截：小吃 与 下午茶 不能同时选（双向，选任一侧再选另一侧即提示且不加入）
      // 注：小吃与夜宵的互斥已取消，二者可同时选（深夜吃小吃）
      const SCENE_MUTEX = { '小吃': ['下午茶'], '下午茶': ['小吃'] };
      const conflict = (SCENE_MUTEX[label] || []).filter(x => arr.indexOf(x) > -1);
      if (conflict.length) {
        wx.showToast({ title: `「${label}」与「${conflict.join('、')}」不能同时选`, icon: 'none' });
        return;
      }
      arr.push(label);
    } else {
      arr.splice(i, 1);
    }
    this.setData({ scene: arr }, () => { this.refreshMulti(); this.applyStepFlags(); });
  },

  next() {
    const { step } = this.data;
    // 扫描所有过敏原冲突
    const conflicts = this.scanAllergenConflicts();
    if (conflicts.length) {
      this.setData({ allergenDialog: true, allergenDialogList: conflicts });
      return;
    }
    // 用餐场景（第 10 步）不再必选（2026-09-07 C+A）：未选则出菜按时段默认，可跳过
    this.proceedNext();
  },

  // 真正推进到下一步或提交（冲突校验通过后调用）
  // 基于 steps 数组索引推进：step 为绝对步号（场景步是 10），totalStep 是列表长度（sceneOnly 下为 2），
  // 二者坐标系不同，故用 steps.indexOf(step) 判断是否为最后一步，避免「点下一步直接提交」
  proceedNext() {
    const steps = this.data.steps;
    const idx = steps.indexOf(this.data.step);
    if (idx >= 0 && idx < steps.length - 1) {
      this.setData({ step: steps[idx + 1], showHierSheet: false }, () => {
        this.refreshMulti();
        this.applyStepFlags();
      });
    } else {
      this.submit();
    }
  },

  prev() {
    const steps = this.data.steps;
    const idx = steps.indexOf(this.data.step);
    if (idx > 0) {
      this.setData({ step: steps[idx - 1], showHierSheet: false }, () => {
        this.refreshMulti();
        this.applyStepFlags();
      });
    }
  },
  // 预计算首尾步标志（step 为绝对步号，不能用 step===totalStep 判断）
  applyStepFlags() {
    const steps = this.data.steps || [];
    const idx = steps.indexOf(this.data.step);
    this.setData({ isFirstStep: idx <= 0, isLastStep: idx === steps.length - 1 });
  },

  // 保存完成后返回来源页（我的 / 决定）。reLaunch 进入时无上一页则用 switchTab 回决定页
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  closeAllergenDialog() {
    this.setData({ allergenDialog: false, allergenDialogList: [] });
  },

  // 过敏原冲突提示（仅 toast 提醒，不拦截）
  // 匹配方式：双向子串包含（用户过敏原 a 含于所选 label，或 label 含于 a 即命中）。
  // 注意：若用户把某大类名（如「海鲜」）本身填为过敏原，选到该类下食材时会按子串命中而提示冲突——
  // 这是当前子串匹配的已知边界，不展开成全子类比对（避免大类下「虾」误伤整类禁选）。
  checkAllergenConflict(field, label) {
    for (const a of this.data.allergens) {
      if (a && (a.indexOf(label) > -1 || label.indexOf(a) > -1)) return a;
    }
    return null;
  },

  // 扫描所有已选食材与过敏原的冲突（用于 next/submit 拦截）
  scanAllergenConflicts() {
    const list = [];
    for (const field of ['meat', 'veg']) {
      for (const label of this.data[field]) {
        const hit = this.checkAllergenConflict(field, label);
        if (hit) list.push(`已选「${label}」↔ 过敏原「${hit}」`);
      }
    }
    return list;
  },

  // 微信隐私合规：进入偏好收集页即弹授权窗；拒绝不退出，记录未授权并禁用保存
  ensurePrivacy() {
    return new Promise((resolve) => {
      if (typeof wx.requirePrivacyAuthorize !== 'function') {
        this.setData({ privacyAuthorized: true });
        resolve(true); return;
      }
      wx.getPrivacySetting({
        success: (res) => {
          if (res && res.needAuthorization) {
            wx.requirePrivacyAuthorize({
              success: () => { this.setData({ privacyAuthorized: true }); resolve(true); },
              fail: () => { this.setData({ privacyAuthorized: false }); resolve(false); }
            });
          } else {
            this.setData({ privacyAuthorized: true });
            resolve(true);
          }
        },
        fail: () => { this.setData({ privacyAuthorized: true }); resolve(true); }
      });
    });
  },

  // 拒绝后再次发起授权（点击提示条「阅读并同意」）
  reAuthorize() {
    this.ensurePrivacy().then(ok => {
      if (!ok) wx.showToast({ title: '需同意后才能保存', icon: 'none' });
    });
  },

  async submit() {
    // 扫描所有过敏原冲突
    const conflicts = this.scanAllergenConflicts();
    if (conflicts.length) {
      this.setData({ allergenDialog: true, allergenDialogList: conflicts });
      return;
    }
    if (this.data.submitting) return;
    // 场景不再必选（2026-09-07 C+A：未选则出菜按时段默认），跳过原 needScene 强制校验
    await this.ensurePrivacy();   // 保存（收集偏好）前确保已弹过隐私授权
    if (!this.data.privacyAuthorized) {
      wx.showToast({ title: '需同意隐私协议后才能保存', icon: 'none' });
      return;   // 不退出小程序，停留本页，提示条提供「重新授权」
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '保存中...' });
    const payload = {
      taste: this.data.taste,
      spicy: this.data.spicy,
      cuisine: this.data.cuisine,
      type: this.data.type,
      meat: this.data.meat,
      veg: this.data.veg,
      cookMethod: this.data.cookMethod,
      drink: this.data.drink,
      avoid: (() => {
        const list = (this.data.avoid || [])
          .filter(x => x !== '过敏原')
          .concat(this.data.allergens.map(a => '过敏原：' + a));
        return list.filter((x, i) => list.indexOf(x) === i);
      })(),
      scene: this.data.scene,
      communityIngredients: this.data.communityIngredients,
      masterIngredients: this.data.masterIngredients
    };
    const isQuick = !!this.data.quick;
    try {
      // 乐观落地本地：先把偏好写入本地缓存并标记「已设偏好」，再请求云端。
      // 这样即便保存过程被打断（如保存中重新进入小程序杀进程），本地仍有记录，
      // 重新进入不会因云端记录暂时缺失而被误弹设置页。云端返回 200 才提示成功并退回。
      cache.setPrefs(payload);
      cache.setHasPrefs(true);
      const res = await wx.cloud.callFunction({
        name: 'savePreferences',
        data: isQuick ? Object.assign({}, payload, { quick: true }) : payload
      });
      wx.hideLoading();
      if (res.result && res.result.code === 200) {
        const rewarded = !!(res.result.data && res.result.data.rewarded);
        if (isQuick) {
          // quick 引导完成：回到首页；奖励到账提示（1 次）
          if (rewarded) {
            wx.showModal({
              title: '引导完成 🎉',
              content: '已保存你的偏好，并获得 1 次额外免费次数奖励（查看首页「免费次数」明细可见）。',
              showCancel: false,
              confirmText: '开始推荐',
              success: () => this.goBack()
            });
          } else {
            wx.showToast({ title: '设置完成', icon: 'success' });
            setTimeout(() => this.goBack(), 600);
          }
        } else {
          wx.showToast({ title: '设置完成', icon: 'success' });
          setTimeout(() => this.goBack(), 600);
        }
      } else {
        // 云端保存失败：本地已兜底（重新进入不会弹设置页），提示用户可重试
        wx.showToast({ title: (res.result && res.result.msg) || '保存失败，请重试', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      console.error('[setup.submit] 保存偏好异常：', e);
      clientLog.log('setup.submit', e);
      wx.showToast({ title: '保存失败：' + (e && e.errMsg ? e.errMsg : '请重试'), icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  }
});
