// lookupScoring.js（E5，阶段三查表推荐 · 排序纯函数模块）
// ─────────────────────────────────────────────────────────────────────────────
// 职责：hotPool 候选行的硬过滤（hardFilterLookup）与打分排序（scoreLookupRows）、
//       §4.4 各加分/降权项、抽样池（pickTopKSampled）。全部纯函数、零 SDK 依赖：
//       仅 require ./sync_weights（纯 JS 共享模块，只 require 不改，R-Code-03）与
//       ./normLexName（纯 JS 主键归一）；DISH_TAGS 由调用方传入（同 sync_weights 约定）。
// 口径来源：《阶段三查表推荐执行规划》§4.2②③、§4.4（原表《env2补充env1菜谱库》§3.4，量纲 ×5 并入 0~100 底座）。
// 系数集中文件顶部：影子期（E9）按「live 出文菜反算分布」定标，bonus 占比 ≤25%，超标整体减半重跑。
// 时间字段纪律：dish_lexicon 时间实测 ts / createdAt 互补分裂（08-29 全量实测 1230/383、无一俱全），
//               一切时间判断必须 row.ts || row.createdAt 双读。
// 本模块 E5 阶段 inert：index.js 仅接线数据层（getHotPool / fetchExposureForIds），
// 排序入口 scoreLookupRows 在 E6/E7 接主流程；此前仅被 scripts/test_e5_lookup.js 本地单测。

const { matchKeyword, DRIFT_MEAT, timeDecayFn, extractDislikeTimed, extractNeutralTimed, _asTs } = require('./sync_weights');
const { normLexName } = require('./normLexName');

const LOOKUP_SCORING_VERSION = 'e6-2026-09-10.bestmonths-season';

// ── 偏好叶子词 → 同义目标词（2026-09-04 补菜同名专菜命中）────────
// 用户勾选这些 HIER 叶子（如「三黄鸡」）时，库里没有菜名/主料含该词的专菜，
// 但存在以它为原料的既有专菜（白切鸡即三黄鸡做法）。打分时把显选词展开成
// 该别名表的目标词，让既有的专菜能吃到偏好加分（不吃香则保持原词直接匹配）。
// 设计约束：目标词尽量贴「菜名词根」，不放大到整类（如用「白切鸡」而非「鸡」），
// 避免把三黄鸡偏好错当成所有鸡菜偏好。改此表请同步 update 补菜建议 md「十、B」附录。
const PREF_LEAF_ALIAS = {
  '三黄鸡': ['白切鸡', '白斩鸡'],
  '仔鹅': ['烧鹅'],
  '胖头鱼': ['剁椒鱼头', '鱼头'],
  '鳝背': ['响油鳝丝', '鳝糊'],
  '咖喱鸡丁': ['咖喱鸡肉', '咖喱鸡'],
  'biangbiang面': ['油泼面', '扯面'],
  '贝类': ['蛤蜊', '花蛤', '扇贝', '青口', '牡蛎', '蛏子', '蚬'],
  '鸡毛菜': ['上海青']
};

// ── 权重底座（镜像 index.js computePrefWeights 档位语义，输出数值 map）────────
// live 的 computePrefWeights 只回显「标签[强/中/弱]」档位文本，数值分被丢弃；
// 此处按同套语义数值化：显选 70 基线 / 未选 30 基线，命中 ×10 封顶、差评 ×10、
// 小样本按 bayesShrink 折扣（只折「学习增量」，显选基线保留——与 live「显选恒进提示词」一致）。

const PREF_SEL_BASE = 70, PREF_SEL_CAP = 30, PREF_SEL_FLOOR = 40;        // 显选小类
const PREF_UNSEL_BASE = 30, PREF_UNSEL_CAP = 25, PREF_UNSEL_FLOOR = 20;  // 未选小类 / 学习方向
const PREF_HIT_COEF = 10, PREF_BAD_COEF = 10;                            // 命中/差评 每次分值
const PREF_BAYES_K = 3;                                                  // 小样本折扣 K（对数折扣）
const PREF_NEUTRAL_COEF = 3;                                             // 中性反馈全局稀释（弱）
const PREF_LEARN_HALF_LIFE_DAYS = 30;                                    // 正向命中时间衰减半衰期
const PREF_BAD_HALF_LIFE_DAYS = 15;                                      // 差评衰减更快（同 live）
const PREF_SAMPLE_SIZE = 40;                                             // 学习窗口：最近 40 道就它了
const BASE_MAX = 100;                                                    // 底座封顶（0~100 分制）

// ── aiMatchBonus（§4.4 表，×5 量纲）────────────────────────────────────────

const BONUS_FLAVOR = 10;             // 口味档命中（prefs.taste ∩ profile.flavors），命中即 +10 不叠加
const CUISINE_STRONG_W = 85, BONUS_CUISINE_STRONG = 15;  // 菜系强档（底座分 ≥85）
const CUISINE_MID_W = 60, BONUS_CUISINE_MID = 8;         // 菜系中档（底座分 ≥60）
const BONUS_TYPE = 10;               // 分类 type / category 命中 prefs.veg 类目
const BONUS_STAPLE = 10;             // kind='staple' 命中 prefs.type 主食偏好
const BONUS_PLAN = 15;               // 命中当日菜单剧本（阶段 2.2，daily_menu 剧本菜加分）
const SPICY_ALIGN_BONUS = 5;             // 辣度同档（偏淡+淡菜 / 同为微辣）
const SPICY_STRONG_ALIGN_BONUS = 10;     // 偏好重辣 + 高辣菜
const SPICY_MISMATCH_PENALTY = 10;       // 偏好清淡 + 高辣菜（重罚）
const SPICY_MISMATCH_SOFT_PENALTY = 5;   // 偏好淡 + 微辣一级落差的软罚

// ── exploreBonus / exposurePenalty ─────────────────────────────────────────

const EXPLORE_BONUS = 8;             // 新菜探索加成（量纲低于菜系强档 15，§4.4）
const EXPLORE_AGE_DAYS = 30;         // 入库 ≤30 天
const EXPLORE_MAX_EXPOSURE = 3;      // 曝光 <3（严格小于）
const EXPOSURE_PENALTY_COEF = 0.5;   // 全局曝光每 1 次扣分
const EXPOSURE_PENALTY_MAX = 10;     // 曝光降权封顶
const EXPOSURE_ZERO_ACCEPT_MIN_CNT = 5;    // cnt≥5 且 accept/cnt<10% → 高曝光零采纳
const EXPOSURE_ZERO_ACCEPT_RATIO = 0.1;
const EXPOSURE_ZERO_ACCEPT_PENALTY = 4;    // 替代 aiRejected 标记，动态计算不落字段（§4.2③）

// ── 时令调权（确定性节气/气温规则；规则表为代码常量，换季随版本更新，§4.4）──

const SEASON_WINTER_MONTHS = [12, 1, 2];
const SEASON_WINTER_COLD_PENALTY = -6;   // 冬季凉菜/冷食
const SEASON_WINTER_SOUP_BONUS = 4;      // 冬季汤羹
const SEASON_HOT_TEMP = 30;              // 气温 ≥30℃
const SEASON_HOT_COLD_BONUS = 5;         // 高温凉饮/凉菜
const SEASON_COLD_WORDS = ['凉拌', '凉菜', '冷盘', '冰镇', '沙冰', '冰粉'];

// ── bestMonths 时令打标调权（2026-09-10 接入：时令打标此前只服务每日菜单剧本，未进推荐打分）──
// dish_profile.bestMonths（season.html AI 打标，2~6 个月；四季皆宜=全 12 个月）：
//   命中当月 → 应季加分；明显反季（非全年菜且不含当月）→ 降权；「四季皆宜/未打标」→ 中性不动，
//   避免全年菜被系统性抬分（否则每月都+分反而盖过真正应季菜）。
// 量纲与既有 season ±6/4/5 同档，绝不压过底座（0~100）与硬约束。
const SEASON_MONTH_HIT_BONUS = 6;        // 真正时令命中当月（bestMonths 含当月且非全年）
const SEASON_MONTH_MISS_PENALTY = 5;     // 明显反季（bestMonths 定义且非全年、不含当月）
const SEASON_MONTH_ALL_YEAR_MIN = 9;     // bestMonths 长度 ≥ 此值视为「四季皆宜」，中性不调权

// ── tuning 旋钮风格调权（2026-09-07，查表侧落实「推荐参数调整」软旋钮）────────────────
// 与出文提示词 renderTuning 口径对齐，但做成确定性数值：不改硬偏好/忌口，只在打分上小幅加减。
// 仅作用于正餐类场景 dishes 槽（小吃/下午茶不适用，避免误伤糕点甜品/小吃炸物）；
// 默认档全部为 0 → 老用户体验零变化。量纲：≤6，绝不压过底座/硬约束。
const STYLE_HEALTH_HEAVY_PENALTY = 5;   // light/lowcal：重油大菜（油炸/红烧/糖醋/干锅等）降权
const STYLE_HEALTH_LIGHT_BONUS = 4;     // light/lowcal：清淡做法（清蒸/白灼/凉拌/清炒/上汤）加成
const STYLE_MUSCLE_PROTEIN_BONUS = 5;   // nutrition=muscle：高蛋白主料（鸡/牛/羊/鱼/虾/蛋/豆）加成
const STYLE_LOWSUGAR_SUGAR_PENALTY = 4; // nutrition=lowsugar：高糖做法（糖醋/拔丝/蜜汁等）降权
const STYLE_QUICK_SLOW_PENALTY = 4;     // complexity=quick：慢炖/卤/腌等费时菜降权（硬核档不做正加分）
const STYLE_HEAVY_WORDS = ['油炸', '红烧', '糖醋', '干锅', '干煸', '水煮', '麻辣', '回锅', '辣子', '红焖', '椒盐', '铁板', '酥炸', '爆炒'];
const STYLE_LIGHT_WORDS = ['清蒸', '白灼', '凉拌', '清炒', '上汤', '温拌'];
const STYLE_SUGAR_WORDS = ['糖醋', '拔丝', '冰糖', '蜜汁', '红糖', '糖渍'];
const STYLE_SLOW_WORDS = ['炖', '焖', '煨', '卤', '腊', '熏', '腌', '风干'];
const STYLE_HIGH_PROTEIN_MAIN = ['鸡', '牛', '羊', '鱼', '虾', '蛋', '豆腐', '豆干', '瘦肉'];
// 早餐主食严禁米饭类（出文提示词「米饭/杂粮饭/盖浇饭/炒饭等一律不得作为早餐 staples」，2026-09-07 补查表）
const BREAKFAST_RICE_BAN = ['米饭', '杂粮饭', '盖浇饭', '炒饭', '糯米饭', '煲仔饭', '石锅饭', '手抓饭'];

// 小吃/下午茶 dishes 槽负向校验（2026-09-07，对齐 AI 提示词「小吃/下午茶不得出正餐炒菜/炖汤/
// 盖浇饭/面条/饺子/包子等」）：type=主食（主食形态混菜品位）、正餐热菜做法词、主食形态全词，三类命中即剔。
// 真正的小吃/轻食（煎饼/冷面/炸货/甜点/凉拌沙拉等）不含上述词，不受影响。
const DRINK_DISH_TYPE_BAN = ['主食'];
const DRINK_DISH_HOT_MARKERS = ['清蒸', '红烧', '糖醋', '爆炒', '干锅', '回锅', '辣炒', '酱烧', '葱烧', '油焖', '麻辣香锅', '水煮鱼', '水煮肉片', '红焖'];
const DRINK_DISH_TAIL_BAN = ['盖饭', '米饭', '面条', '米线', '河粉', '饺子', '水饺', '煎饺', '蒸饺', '包子', '馒头', '花卷', '烧麦'];

function hasAnyWord(name, words) {
  const n = String(name || '');
  if (!n || !words || !words.length) return false;
  return words.some(w => n.indexOf(w) >= 0);
}

// 风格调权：正餐 dishes 槽专用。返回 { bonus, parts }；parts 供 E9 反算/定位。
function calcStyleBonus(row, ctx) {
  const c = ctx || {};
  const p = { health: 0, nutrition: 0, complexity: 0 };
  if (!row || c.slot !== 'dishes' || (DRINK_SCENES.indexOf(String(c.scene || '')) >= 0)) return { bonus: 0, parts: p };
  const name = String(row.name || '');
  const prof = (row.profile && typeof row.profile === 'object') ? row.profile : {};
  const main = prof.main ? String(prof.main) : '';
  // 健康倾向：light/lowcal 重油降权 + 清淡加成
  const health = String(c.health || 'casual');
  if (health === 'light' || health === 'lowcal') {
    if (hasAnyWord(name, STYLE_HEAVY_WORDS)) p.health = -STYLE_HEALTH_HEAVY_PENALTY;
    else if (hasAnyWord(name, STYLE_LIGHT_WORDS)) p.health = STYLE_HEALTH_LIGHT_BONUS;
  }
  // 营养目标
  const nutrition = String(c.nutrition || 'none');
  if (nutrition === 'muscle' && main && hasAnyWord(main, STYLE_HIGH_PROTEIN_MAIN)) p.nutrition = STYLE_MUSCLE_PROTEIN_BONUS;
  else if (nutrition === 'lowsugar' && hasAnyWord(name, STYLE_SUGAR_WORDS)) p.nutrition = -STYLE_LOWSUGAR_SUGAR_PENALTY;
  else if (nutrition === 'fatloss' && hasAnyWord(name, STYLE_HEAVY_WORDS)) p.nutrition = -STYLE_HEALTH_HEAVY_PENALTY;  // 减脂≈低油，复用重油降权
  // 下厨复杂度：quick 费时菜降权（mid/hard 不干预）
  if (String(c.complexity || 'mid') === 'quick' && hasAnyWord(name, STYLE_SLOW_WORDS)) p.complexity = -STYLE_QUICK_SLOW_PENALTY;
  const bonus = p.health + p.nutrition + p.complexity;
  return { bonus, parts: p };
}

// ── 场景 / 餐次 ────────────────────────────────────────────────────────────

const DRINK_SCENES = ['小吃', '下午茶'];   // 对齐 index.js DRINK_SCENES：staples 槽在此场景取 kind='drink'
// profile.mealTime 实测取值：午餐/晚餐/早餐/小吃/下午茶/夜宵（08-29 全量统计）
const SCENE_MEAL_MAP = {
  '正餐': ['午餐', '晚餐'],
  '早餐': ['早餐'], '午餐': ['午餐'], '晚餐': ['晚餐'],
  '夜宵': ['夜宵'], '小吃': ['小吃'], '下午茶': ['下午茶']
};
const MEALTIME_MISS_PENALTY = 1;   // 缺 mealTime 不排除、只降 1 分（容忍维度缺失，§4.2②/§4.6）

// ── 抽样池（§4.2③：多样性第一道护栏）──────────────────────────────────────

const SAMPLE_POOL_K = 40;          // 打分前 K 进抽样池
const SAMPLE_PICK_N = 2;           // 池内加权随机抽 2
const SAMPLE_WEIGHT_BASE = 1;      // 线性权重底数：w = score − 池内最低分 + 1

// ═══════════════════════════════════════════════════════════════════════════

// mulberry32：可复现 PRNG（同 seed 同序列，单测「抽样可复现」用）
function mulberry32(seed) {
  let a = (typeof seed === 'number' && isFinite(seed)) ? (seed >>> 0) : 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// prefs.spicy 字符串档 → 0~3 数值档（不限制/未知 → null 不参与）
function spicyPrefLevel(str) {
  const s = String(str || '');
  if (!s || /不限制|不限|无所谓/.test(s)) return null;
  if (/重辣|特辣/.test(s)) return 3;
  if (/中辣/.test(s)) return 2;
  if (/不辣|不吃辣|清淡/.test(s)) return 0;
  if (/微辣/.test(s)) return 1;
  if (/辣/.test(s)) return 2;
  return null;
}

// ── 权重底座：数值化偏好 map ───────────────────────────────────────────────
// 返回 { meat:{label:score}, veg:{...}, cuisine:{...} }。调用方（E6/E7 接线时）用
// prefs + chosenPairs 一次构建，整个请求内复用；本模块内 weightBaseScore 只读它。
// probes 口径：显选项原样 + 学习方向（meat 取 DRIFT_MEAT 大类；veg 取素菜条目关键词），
// 与 live computePrefWeights 的 probe 构造同源（expandPrefs 的大类展开在 matchKeyword
// 逐标签判定时天然覆盖——用户勾大类时其小类菜名同样命中该标签）。

function buildPrefScoreMaps(prefs, chosenPairs, DISH_TAGS, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const hl = (typeof o.halfLifeDays === 'number' && o.halfLifeDays > 0) ? o.halfLifeDays : PREF_LEARN_HALF_LIFE_DAYS;
  const biasMap = (prefs && prefs.weightBias && typeof prefs.weightBias === 'object') ? prefs.weightBias : {};
  const neutralScalar = extractNeutralTimed(prefs, 60).weight;

  // 学习样本：最近 40 道（带 ts 降序），与 live 口径一致
  const sample = (Array.isArray(chosenPairs) ? chosenPairs.slice() : [])
    .map(x => (typeof x === 'string') ? { name: x, ts: 0 } : { name: String((x && x.name) || ''), ts: _asTs(x && x.ts) })
    .filter(x => x.name)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, PREF_SAMPLE_SIZE);

  function scoreOf(field, label, isSel, hit, rawCnt, bad) {
    const base = isSel ? PREF_SEL_BASE : PREF_UNSEL_BASE;
    const cap = isSel ? PREF_SEL_CAP : PREF_UNSEL_CAP;
    const floor = isSel ? PREF_SEL_FLOOR : PREF_UNSEL_FLOOR;
    const learned = Math.min(cap, (hit[label] || 0) * PREF_HIT_COEF) - (bad[label] || 0) * PREF_BAD_COEF - neutralScalar * PREF_NEUTRAL_COEF;
    const c = rawCnt[label] || 0;
    // 只折学习增量、保留显选基线（c=0 → 分数=基线，与 live「显选恒进提示词」语义一致）
    const shrunk = learned * (c > 0 ? (c / (c + PREF_BAYES_K)) : 0);
    let s = base + Math.max(-base, shrunk);
    // weightBias 软微调（cuisine 不参与，与 live 口径一致）
    if (field !== 'cuisine') {
      const b = (typeof biasMap[field] === 'number') ? Math.max(-0.5, Math.min(0.5, biasMap[field])) : 0;
      s += b * 10;
    }
    return Math.max(floor, Math.min(BASE_MAX, s));
  }

  function buildField(field) {
    const sel = (prefs && Array.isArray(prefs[field])) ? prefs[field].map(String).filter(Boolean) : [];
    const probes = sel.slice();
    // matcher：label → kw 列表。DRIFT 大类 label 用 kw.some 聚合判定（与 live 漂移口径一致）；
    // 其余标签（用户显选小类、veg 关键词）直接 matchKeyword(label)。
    const matchers = {};
    if (field === 'meat') {
      DRIFT_MEAT_ENTRIES.forEach(m => {
        if (probes.indexOf(m.label) < 0) probes.push(m.label);
        matchers[m.label] = m.kw;
      });
    } else if (field === 'veg') {
      DRIFT_VEG_KEYWORDS.forEach(k => {
        if (probes.indexOf(k) < 0) probes.push(k);
      });
    }
    // 2026-09-04：显选叶子若在「同义目标词」表中，为其注入 kw 列表（命中既有专菜）
    Object.keys(PREF_LEAF_ALIAS).forEach(w => {
      if (probes.indexOf(w) >= 0 && !matchers[w]) matchers[w] = PREF_LEAF_ALIAS[w];
    });
    if (!probes.length) return { scores: {}, matchers: {} };

    const hitOf = (name, label) => {
      const kws = matchers[label];
      if (kws) return kws.some(k => matchKeyword(name, k, DISH_TAGS));
      return matchKeyword(name, label, DISH_TAGS);
    };

    const hit = {}, rawCnt = {};
    sample.forEach(p => {
      probes.forEach(l => {
        if (hitOf(p.name, l)) {
          hit[l] = (hit[l] || 0) + (p.ts ? timeDecayFn(p.ts, now, hl) : 1);
          rawCnt[l] = (rawCnt[l] || 0) + 1;
        }
      });
    });
    const bad = extractDislikeTimed(prefs, probes, field, DISH_TAGS, now, PREF_BAD_HALF_LIFE_DAYS);

    const scores = {};
    probes.forEach(l => {
      const isSel = sel.indexOf(l) >= 0;
      if (!isSel && !(rawCnt[l] || 0)) return;  // 未选且无学习信号 → 不进 map（打分时按 0 处理）
      scores[l] = scoreOf(field, l, isSel, hit, rawCnt, bad);
    });
    return { scores, matchers };
  }

  const meat = buildField('meat'), veg = buildField('veg'), cuisine = buildField('cuisine');
  return {
    meat: meat.scores, veg: veg.scores, cuisine: cuisine.scores,
    matchers: { meat: meat.matchers, veg: veg.matchers }
  };
}

//veg 打分 probe 用关键词：派生自 sync_weights.DRIFT_MEAT「素菜/豆制品」条目 kw（剔除单字防过匹配）
const DRIFT_VEG_ENTRY = DRIFT_MEAT.find(m => m.label === '素菜/豆制品') || { kw: [] };
const DRIFT_VEG_KEYWORDS = DRIFT_VEG_ENTRY.kw.filter(k => String(k).length >= 2);
// meat 打分 probe 用大类条目（label + kw 列表；label 不能直接当匹配词——「鱼虾海鲜」「蛋类」不会出现在菜名里，
// live 漂移口径是 kw.some(matchKeyword) 聚合到 label，此处对齐）
const DRIFT_MEAT_ENTRIES = DRIFT_MEAT.filter(m => m.label !== '素菜/豆制品');

// ── ① 硬过滤（§4.2②，微秒级，内存）────────────────────────────────────────
// rows：hotPool 行 {norm_id, name, kind, category, cuisine, mealTime, source, ts, createdAt, profile}
// opts：{ scene, slot('dishes'|'staples'), avoidWords[], blacklist[], dislikeNames[],
//         recentNames[], chosenNames[] }
// ── 菜品 vs 主食形态判定（与出文提示词口径一致，2026-09-07）──────────────
// 规则：菜品位不得含主食形态词（饭/面/粉/粥/饺/包/馒…）；形态词归主食位。
// 复用 index.js STAPLE_SHAPE 清单，但匹配改成「高精度」：
//   · 多字形态词（炒饭/盖饭/米线/馄饨/包子…）按【名字结尾】匹配
//   · 单字（饭/面/粉/粥/饼/饺/包…）只按【末位】匹配（卷/糕 易误伤白菜肉卷、萝卜糕类真菜，不收）
// 避免老式任意子串把「粉蒸肉/粉丝蒸扇贝/梭子蟹炒年糕」这类真菜误伤。
const STAPLE_SUFFIX = ['盖饭', '炒饭', '杂粮饭', '米饭', '大米饭', '糯米饭', '面条', '米线', '河粉',
  '馄饨', '云吞', '抄手', '饺子', '水饺', '煎饺', '蒸饺', '锅贴', '包子', '馒头', '花卷',
  '烧麦', '烧卖', '馅饼', '盒子', '春卷', '面包', '吐司', '三明治'];
const STAPLE_TAIL = ['饭', '面', '粉', '粥', '饼', '饺', '包'];
function stapleShapeHit(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (STAPLE_SUFFIX.some(s => n.endsWith(s))) return true;
  return STAPLE_TAIL.indexOf(n[n.length - 1]) >= 0;
}

// 过滤链（每个落选行只记第一个命中的原因，供日志/看板归因）：
//   kind 场景语义（+ 形态双保险：菜位禁主食形态、主食位兼容形态名）→ 黑名单
//   → 忌口/过敏原（词汇匹配 name+profile.main+profile.flavors）
//   → 差评/忌口菜名（精确）→ 近窗/已选（近 7 天窗口由调用方截取，口径与 prompt 现状一致）
//   → 餐次（profile.mealTime 含当前场景；缺失不排除、只降 1 分）
// 返回 { kept, dropped, droppedCounts, mealtimeMissSet }；mealtimeMissSet 中的行打分时 −1。

function hardFilterLookup(rows, opts) {
  const o = opts || {};
  const scene = String(o.scene || '');
  const slot = (o.slot === 'staples') ? 'staples' : 'dishes';
  const wantKind = (slot === 'staples')
    ? (DRINK_SCENES.indexOf(scene) >= 0 ? 'drink' : 'staple')
    : 'dish';
  const mealLabels = SCENE_MEAL_MAP[scene] || null;

  const mkSet = (arr) => {
    const s = new Set();
    (Array.isArray(arr) ? arr : []).forEach(x => {
      const v = String(x || '').trim(); if (!v) return;
      s.add(v); s.add(normLexName(v));
    });
    return s;
  };
  const blacklistSet = mkSet(o.blacklist);
  const dislikeSet = mkSet(o.dislikeNames);
  const recentSet = mkSet(o.recentNames);
  const chosenSet = mkSet(o.chosenNames);
  const avoidWords = (Array.isArray(o.avoidWords) ? o.avoidWords : []).map(x => String(x || '').trim()).filter(Boolean);

  const kept = [], dropped = [];
  const droppedCounts = { kind: 0, blacklist: 0, taboo: 0, dislike: 0, recent: 0, chosen: 0, mealtime: 0, noname: 0, breakfastRice: 0, drinkDishBan: 0 };
  const mealtimeMissSet = new Set();   // 缺 mealTime 的保留行（打分时 −1）；用 Set 回传，不改写共享池行对象
  const DROPPED_SAMPLE_MAX = 50;

  (Array.isArray(rows) ? rows : []).forEach(row => {
    if (!row || !row.name) { droppedCounts.noname++; return; }
    const name = String(row.name);
    const nid = String(row.norm_id || normLexName(name));
    const drop = (reason, extra) => {
      droppedCounts[reason]++;
      if (dropped.length < DROPPED_SAMPLE_MAX) dropped.push(Object.assign({ name, reason }, extra || {}));
    };

    // 场景语义：kind 映射（dishes←dish；staples←staple；小吃/下午茶 staples←drink）
    // 形态双保险（2026-09-07，对齐出文提示词「菜名不得含饭/面/粉/粥等主食形态词」）：
    //   dishes 位：kind=dish 且名字不带主食形态；staples 位：kind=staple/drink，或非配饮场景下
    //   kind=dish 但名字命中主食形态（如「田鸡汤面」「白菜猪肉饺」这类库内 kind 标错的）→ 归主食位。
    const isDrinkScene = DRINK_SCENES.indexOf(scene) >= 0;
    if (slot === 'dishes') {
      if (row.kind !== 'dish') { drop('kind'); return; }
      // 仅「正餐类场景」禁主食形态进菜位；小吃/下午茶场景放行（煎饼/冷面/酥饼/虾饺等本就是小吃菜）
      if (!isDrinkScene && stapleShapeHit(name)) { drop('kind', { note: 'stapleShape' }); return; }
    } else if (isDrinkScene) {
      if (row.kind !== 'drink') { drop('kind'); return; }
    } else {
      const kindOk = row.kind === 'staple' || (row.kind === 'dish' && stapleShapeHit(name));
      if (!kindOk) { drop('kind'); return; }
    }

    // 早餐主食严禁米饭类（2026-09-07 对齐出文提示词「米饭/杂粮饭/盖浇饭/炒饭等一律不得作为早餐 staples」）：
    // 仅早餐 staples 槽排除。命中即硬剔，宁可扣空早餐主食也不破例（出不来由上层 autoFallback 转 live）。
    if (scene === '早餐' && slot === 'staples' && hasAnyWord(name, BREAKFAST_RICE_BAN)) { drop('breakfastRice'); return; }

    // 小吃/下午茶 dishes 槽负向校验（2026-09-07，对齐 AI 提示词「不得出现正餐炒菜/炖汤/盖浇饭/
    // 面条/饺子/包子等」）：正餐热菜做法词、主食形态词、type=主食 三类命中即硬剔；
    // 真小吃（煎饼/冷面/炸货/甜点/凉拌轻食）不含这些词，放行不受影响。配饮槽（staples=drink）不适用。
    if (isDrinkScene && slot === 'dishes') {
      const _pt = (row.profile && typeof row.profile === 'object' && row.profile.type) ? String(row.profile.type) : '';
      // 下午茶=糕点甜品+饮品搭配（提示词不得热菜/主食）：type 荤菜型也剔（如日式炸鸡块）；
      // 小吃场景保留荤菜型（卤味/炸物/熟食是合法小吃）；type=主食两类场景都禁（饺子/包子/米面饭）。
      const _typeBan = DRINK_DISH_TYPE_BAN.indexOf(_pt) >= 0 || (scene === '下午茶' && _pt === '荤菜');
      const _why = _typeBan ? 'type'
        : hasAnyWord(name, DRINK_DISH_HOT_MARKERS) ? 'hot'
        : hasAnyWord(name, DRINK_DISH_TAIL_BAN) ? 'tail' : '';
      if (_why) { drop('drinkDishBan', { note: _why }); return; }
    }

    // 黑名单：管理拉黑/怪名（黑名单优先归因——既是黑名单又近窗时只记 blacklist）
    if (blacklistSet.has(name) || blacklistSet.has(nid)) { drop('blacklist'); return; }

    // 忌口/过敏原：词汇匹配 name + profile.main + profile.flavors
    const prof = row.profile || null;
    const main = (prof && prof.main) ? String(prof.main) : '';
    const flavors = (prof && Array.isArray(prof.flavors)) ? prof.flavors.map(String) : [];
    for (const w of avoidWords) {
      let tabooHit = name.indexOf(w) >= 0;
      if (!tabooHit && main && (main.indexOf(w) >= 0 || (w.length >= 2 && w.indexOf(main) >= 0))) tabooHit = true;
      if (!tabooHit) {
        for (const f of flavors) {
          if (f.indexOf(w) >= 0 || (w.length >= 2 && w.indexOf(f) >= 0)) { tabooHit = true; break; }
        }
      }
      if (tabooHit) { drop('taboo', { word: w }); return; }
    }

    // 用户差评/忌口登记菜名（精确，live 靠 prompt 软约束，lookup 硬过滤）
    if (dislikeSet.has(name) || dislikeSet.has(nid)) { drop('dislike'); return; }

    // 近窗去重（近期已推过 / 用户长期已选）
    if (recentSet.has(name) || recentSet.has(nid)) { drop('recent'); return; }
    if (chosenSet.has(name) || chosenSet.has(nid)) { drop('chosen'); return; }

    // 餐次过滤：profile.mealTime（退化用 lexicon 行 mealTime）含当前场景；缺失 → 保留并标记降 1 分
    const mt = (prof && Array.isArray(prof.mealTime) && prof.mealTime.length) ? prof.mealTime
      : (Array.isArray(row.mealTime) && row.mealTime.length) ? row.mealTime : null;
    if (mealLabels) {
      if (mt) {
        const ok = mt.some(m => mealLabels.indexOf(String(m)) >= 0);
        if (!ok) { drop('mealtime'); return; }
      } else {
        mealtimeMissSet.add(nid);
      }
    }

    kept.push(row);
  });

  return { kept, dropped, droppedCounts, mealtimeMissSet };
}

// ── ③-1 权重底座分 ────────────────────────────────────────────────────────
// prefWeights：buildPrefScoreMaps 的产物。菜侧标签判定复用 matchKeyword（与 live 同源），
// 匹配面 = 菜名 + profile.main；cuisine 用精确串（菜系为受控词表）。

function dishCuisineScore(row, prefWeights) {
  const cw = (prefWeights && prefWeights.cuisine) || {};
  const cands = [row.cuisine, row.profile && row.profile.cuisine].map(x => String(x || '').trim()).filter(Boolean);
  let best = 0;
  Object.keys(cw).forEach(k => { if (cands.indexOf(k) >= 0 && cw[k] > best) best = cw[k]; });
  return best;
}

function dishMeatVegScore(row, field, prefWeights, DISH_TAGS) {
  const w = (prefWeights && prefWeights[field]) || {};
  const matchers = (prefWeights && prefWeights.matchers && prefWeights.matchers[field]) || {};
  const keys = Object.keys(w);
  if (!keys.length) return 0;
  const name = String(row.name || '');
  const main = (row.profile && row.profile.main) ? String(row.profile.main) : '';
  let best = 0;
  keys.forEach(l => {
    if (w[l] <= best) return;
    const kws = matchers[l];
    const hitName = name && (kws ? kws.some(k => matchKeyword(name, k, DISH_TAGS)) : matchKeyword(name, l, DISH_TAGS));
    const hitMain = main && (kws ? kws.some(k => matchKeyword(main, k, DISH_TAGS)) : matchKeyword(main, l, DISH_TAGS));
    if (hitName || hitMain) best = w[l];
  });
  return best;
}

function weightBaseScore(row, prefWeights, DISH_TAGS) {
  const meat = dishMeatVegScore(row, 'meat', prefWeights, DISH_TAGS);
  const veg = dishMeatVegScore(row, 'veg', prefWeights, DISH_TAGS);
  const cuisine = dishCuisineScore(row, prefWeights);
  return { base: Math.min(BASE_MAX, meat + veg + cuisine), parts: { meat, veg, cuisine } };
}

// ── ③-2 aiMatchBonus（§4.4 表）────────────────────────────────────────────
// 返回 { bonus, parts:{flavor, cuisine, type, staple, spicy} }，各项均 ≤ 表值、可为负（辣度）。

function aiMatchBonus(row, prefs, prefWeights, DISH_TAGS, opts) {
  const prof = row.profile || {};
  const parts = { flavor: 0, cuisine: 0, type: 0, staple: 0, spicy: 0 };

  // 口味档：prefs.taste ∩ profile.flavors（每命中一档取最高 → 命中即 +10，不叠加）
  const taste = (prefs && Array.isArray(prefs.taste)) ? prefs.taste.map(String) : [];
  const flavors = Array.isArray(prof.flavors) ? prof.flavors.map(String) : [];
  if (taste.length && flavors.length && taste.some(t => flavors.indexOf(t) >= 0)) parts.flavor = BONUS_FLAVOR;

  // 菜系档：底座 cuisine 分落位（强 ≥85 → +15；中 ≥60 → +8）
  const cScore = dishCuisineScore(row, prefWeights);
  if (cScore >= CUISINE_STRONG_W) parts.cuisine = BONUS_CUISINE_STRONG;
  else if (cScore >= CUISINE_MID_W) parts.cuisine = BONUS_CUISINE_MID;

  // 分类/类目命中 prefs.veg：profile.type（退化 lexicon category）；
  // 「素菜/蔬菜」视为 veg 大类总称——用户勾了任意 veg 类目即命中
  const typeStr = String(prof.type || row.category || '').trim();
  const vegSel = (prefs && Array.isArray(prefs.veg)) ? prefs.veg.map(String) : [];
  if (typeStr && vegSel.length) {
    const hit = (typeStr === '素菜' || typeStr === '蔬菜')
      ? true
      : vegSel.some(l => typeStr.indexOf(l) >= 0 || (l.length >= 2 && l.indexOf(typeStr) >= 0));
    if (hit) parts.type = BONUS_TYPE;
  }

  // 主食偏好：主食形态（kind=staple，或 kind=dish 但名字命中主食形态词）且菜名/主食材命中 prefs.type
  const stapleSel = (prefs && Array.isArray(prefs.type)) ? prefs.type.map(String) : [];
  const stapleKind = (row.kind === 'staple') || (row.kind === 'dish' && stapleShapeHit(row.name));
  if (stapleKind && stapleSel.length) {
    const name = String(row.name || '');
    const main = prof.main ? String(prof.main) : '';
    const hit = stapleSel.some(l => {
      const kws = (PREF_LEAF_ALIAS[l] && PREF_LEAF_ALIAS[l].length) ? PREF_LEAF_ALIAS[l] : [l];
      return kws.some(k => (name.indexOf(k) >= 0) || (main && (main.indexOf(k) >= 0 || (k.length >= 2 && k.indexOf(main) >= 0))));
    });
    if (hit) parts.staple = BONUS_STAPLE;
  }

  // 辣度落位：prefs.spicy 字符串档 vs profile.spicy 数值档（缺失按 0）
  // tuning.tasteShift（口味强度微调 -2~+2）：把用户所选辣度整体平移后比对——偏淡=下调档位，
  // 使原档位的菜相对变「偏辣」被轻微降权，对应 AI 提示词「偏淡/偏重一级」。
  let prefLvl = spicyPrefLevel(prefs && prefs.spicy);
  const _ts = (opts && typeof opts.spicyShift === 'number') ? Math.max(-2, Math.min(2, opts.spicyShift)) : 0;
  if (prefLvl !== null && _ts !== 0) prefLvl = Math.max(0, Math.min(3, prefLvl + _ts));
  if (prefLvl !== null) {
    let dLvl = (typeof prof.spicy === 'number') ? Math.max(0, Math.min(3, Math.round(prof.spicy))) : 0;
    const diff = dLvl - prefLvl;
    if (diff >= 0 && prefLvl >= 2) parts.spicy = SPICY_STRONG_ALIGN_BONUS;
    else if (diff === 0) parts.spicy = SPICY_ALIGN_BONUS;
    else if (diff >= 2) parts.spicy = -SPICY_MISMATCH_PENALTY;
    else if (diff === 1 && prefLvl <= 1) parts.spicy = -SPICY_MISMATCH_SOFT_PENALTY;
  }

  const bonus = parts.flavor + parts.cuisine + parts.type + parts.staple + parts.spicy;
  return { bonus, parts };
}

// ── ③-3 exploreBonus（新菜探索加成，§4.4）─────────────────────────────────
// 入库 ≤30 天 且 全局曝光 <3 → +8。时间字段 row.ts || row.createdAt 双读（实测互补分裂）。
// 无曝光记录（新菜未推过）按 0 计 → 天然 eligible。

function exploreBonus(row, exposureCnt, now) {
  const t = _asTs(row && (row.ts || row.createdAt));
  if (!t) return 0;
  const base = (typeof now === 'number' && now) || Date.now();
  const ageDays = (base - t) / 86400000;
  if (ageDays < 0 || ageDays > EXPLORE_AGE_DAYS) return 0;
  const cnt = (typeof exposureCnt === 'number') ? exposureCnt : 0;
  if (cnt >= EXPLORE_MAX_EXPOSURE) return 0;
  return EXPLORE_BONUS;
}

// ── 时令调权（calcSeasonBonus，§4.4 最后一行）─────────────────────────────
// ctx = { month: 1~12, temp: ℃|null }。冬季（12~2 月）凉菜/冷食 −6、汤羹 +4；
// 气温 ≥30℃ 凉饮/凉菜 +5。规则确定性、无随机。

function isColdish(row) {
  const name = String((row && row.name) || '');
  const prof = (row && row.profile) || {};
  const flavors = Array.isArray(prof.flavors) ? prof.flavors.map(String) : [];
  if (String(prof.type || '') === '凉菜') return true;
  if (SEASON_COLD_WORDS.some(w => name.indexOf(w) >= 0)) return true;
  return flavors.some(f => SEASON_COLD_WORDS.some(w => f.indexOf(w) >= 0));
}

function isSoupish(row) {
  const prof = (row && row.profile) || {};
  if (prof.isSoup === true) return true;
  return /[汤羹]$/.test(String((row && row.name) || ''));
}

function calcSeasonBonus(row, ctx) {
  const c = ctx || {};
  const month = (typeof c.month === 'number') ? c.month : null;
  const temp = (typeof c.temp === 'number') ? c.temp : null;
  let bonus = 0;
  if (month !== null && SEASON_WINTER_MONTHS.indexOf(month) >= 0) {
    if (isColdish(row)) bonus += SEASON_WINTER_COLD_PENALTY;
    if (isSoupish(row)) bonus += SEASON_WINTER_SOUP_BONUS;
  }
  if (temp !== null && temp >= SEASON_HOT_TEMP) {
    const coldDrink = row && row.kind === 'drink' && /凉|冰/.test(String(row.name || ''));
    if (isColdish(row) || coldDrink) bonus += SEASON_HOT_COLD_BONUS;
  }
  // bestMonths 时令打标（2026-09-10）：命中当月加分 / 明显反季降权；四季皆宜(≥9月)与未打标中性不动
  if (month !== null) {
    const prof = (row && row.profile) || {};
    const bm = Array.isArray(prof.bestMonths) ? prof.bestMonths.filter(n => typeof n === 'number') : null;
    if (bm && bm.length && bm.length < SEASON_MONTH_ALL_YEAR_MIN) {
      if (bm.indexOf(month) >= 0) bonus += SEASON_MONTH_HIT_BONUS;
      else bonus += -SEASON_MONTH_MISS_PENALTY;
    }
  }
  return bonus;
}

// ── ③-4 exposurePenalty（全局曝光降权 + 高曝光零采纳降权）────────────────
// exposure：dish_exposure 行形态 {cnt, accept}（读数按候选 norm_id 定向 _.in，§10.2#1）。
// 返回 { penalty, zeroAccept }。曝光 cnt≤0 / 无记录 → 0。

function exposurePenalty(exposure) {
  const cnt = (exposure && typeof exposure === 'object') ? (exposure.cnt || 0) : (typeof exposure === 'number' ? exposure : 0);
  if (cnt <= 0) return { penalty: 0, zeroAccept: false };
  const accept = (exposure && typeof exposure === 'object') ? (exposure.accept || 0) : 0;
  const p = Math.min(EXPOSURE_PENALTY_MAX, cnt * EXPOSURE_PENALTY_COEF);
  const zeroAccept = cnt >= EXPOSURE_ZERO_ACCEPT_MIN_CNT && (accept / cnt) < EXPOSURE_ZERO_ACCEPT_RATIO;
  return { penalty: p + (zeroAccept ? EXPOSURE_ZERO_ACCEPT_PENALTY : 0), zeroAccept };
}

// ── ②+③ 主入口：过滤 + 打分 + 排序 ───────────────────────────────────────
// ctx = { scene, slot, prefs, prefWeights, DISH_TAGS, exposureMap:{norm_id:{cnt,accept}},
//         blacklist, avoidWords, dislikeNames, recentNames, chosenNames,
//         month, temp, now, planNames, blankPrefs }（planNames=当日菜单剧本该场景菜名数组，阶段 2.2）
// blankPrefs=true（2026-09-07）：无任何偏好字段的新用户/注销重开号——关闭 explore 新菜加成，
//   避免「近 30 天集中入库的同类新词（曾整批补录番茄系）」借 +8 探索分系统性霸榜抽样池；
//   曝光/时令/剧本照旧，老用户不受影响。
// 返回 { items:[{norm_id, name, kind, score, parts}], stats }。
// parts 逐项透出（影子期 E9 反算 bonus 占比、定标系数用）；排序同分按 norm_id 升序保证确定性。

function scoreLookupRows(rows, ctx) {
  const c = ctx || {};
  const now = (typeof c.now === 'number' && c.now) || Date.now();
  const filt = hardFilterLookup(rows, {
    scene: c.scene, slot: c.slot,
    avoidWords: c.avoidWords, blacklist: c.blacklist, dislikeNames: c.dislikeNames,
    recentNames: c.recentNames, chosenNames: c.chosenNames, DISH_TAGS: c.DISH_TAGS
  });

  const prefs = c.prefs || {};
  const prefWeights = c.prefWeights || { meat: {}, veg: {}, cuisine: {} };
  const season = { month: c.month, temp: c.temp };
  // 每日菜单剧本命中（阶段 2.2）：planNames=当日剧本该场景菜名原文清单；命中加 BONUS_PLAN。
  // 剧本只负责把「今天该吃谁」调高，个人偏好硬过滤 / 底座分 / 曝光降权照旧——AI 编排、查表执行。
  const planSet = (Array.isArray(c.planNames) && c.planNames.length) ? new Set(c.planNames) : null;

  const items = filt.kept.map(row => {
    const nid = String(row.norm_id || normLexName(row.name));
    const baseR = weightBaseScore(row, prefWeights, c.DISH_TAGS);
    const amR = aiMatchBonus(row, prefs, prefWeights, c.DISH_TAGS, { spicyShift: (typeof c.tasteShift === 'number') ? c.tasteShift : 0 });
    const styleR = calcStyleBonus(row, { scene: c.scene, slot: c.slot, health: c.health, nutrition: c.nutrition, complexity: c.complexity });
    // blankPrefs（无偏好新用户）：关闭 explore 新菜加成——探索加分是为「已了解的老用户」找新意设计，
    // 空偏好没有任何偏好信号可分流，若保留 +8 会让近 30 天集中入库的同质新词（曾整批补番茄系）霸榜抽样池
    const exp = (c.blankPrefs === true) ? 0 : exploreBonus(row, c.exposureMap && c.exposureMap[nid] ? c.exposureMap[nid].cnt : 0, now);
    const seasonB = calcSeasonBonus(row, season);
    const epR = exposurePenalty(c.exposureMap && c.exposureMap[nid]);
    const mealMiss = filt.mealtimeMissSet.has(nid) ? -MEALTIME_MISS_PENALTY : 0;
    const planB = (planSet && (planSet.has(nid) || planSet.has(row.name))) ? BONUS_PLAN : 0;
    const score = baseR.base + amR.bonus + styleR.bonus + exp + seasonB - epR.penalty + mealMiss + planB;
    return {
      norm_id: nid, name: row.name, kind: row.kind, category: row.category || '', profile: row.profile || null,
      ts: row.ts || 0, createdAt: row.createdAt || 0,   // E6 探索筛选用（ts||createdAt 双读，实测互补分裂）
      score: Math.round(score * 1000) / 1000,
      parts: {
        base: baseR.base, baseDetail: baseR.parts,
        flavor: amR.parts.flavor, cuisineBonus: amR.parts.cuisine, type: amR.parts.type,
        staple: amR.parts.staple, spicy: amR.parts.spicy,
        explore: exp, season: seasonB, exposure: -epR.penalty, zeroAccept: epR.zeroAccept,
        mealtimeMiss: mealMiss, planBonus: planB,
        style: styleR.bonus, styleDetail: styleR.parts
      }
    };
  });

  items.sort((a, b) => (b.score - a.score) || (a.norm_id < b.norm_id ? -1 : (a.norm_id > b.norm_id ? 1 : 0)));

  // bonus 占比（E9 定标口径）：正向加分合计 /（底座合计 + 正向加分合计），≤25% 为不主导
  let baseSum = 0, bonusSum = 0;
  items.forEach(it => {
    baseSum += Math.max(0, it.parts.base);
    const b = (it.parts.flavor + it.parts.cuisineBonus + it.parts.type + it.parts.staple + Math.max(0, it.parts.spicy)
      + Math.max(0, it.parts.explore) + Math.max(0, it.parts.season) + Math.max(0, it.parts.planBonus)
      + Math.max(0, it.parts.style || 0));
    bonusSum += b;
  });
  const bonusShare = (baseSum + bonusSum) > 0 ? Math.round((bonusSum / (baseSum + bonusSum)) * 1000) / 1000 : 0;

  return {
    items,
    stats: {
      pool: (Array.isArray(rows) ? rows.length : 0),
      kept: filt.kept.length,
      droppedCounts: filt.droppedCounts,
      droppedSample: filt.dropped.slice(0, 10),
      bonusShare
    }
  };
}

// ── ③-5 抽样池：前 K 加权随机抽 n（§4.2③ 多样性第一道护栏）────────────────
// sortedItems：scoreLookupRows 输出的 items（已降序）。同 seed 同结果（单测可复现）；
// 权重线性：w = score − 池内最低分 + 1（同分菜不固定同序，高分菜概率更高但不垄断）。

function pickTopKSampled(sortedItems, opts) {
  const o = opts || {};
  const K = (typeof o.K === 'number' && o.K > 0) ? o.K : SAMPLE_POOL_K;
  const n = (typeof o.n === 'number' && o.n > 0) ? o.n : SAMPLE_PICK_N;
  const rng = (typeof o.rng === 'function') ? o.rng : mulberry32(o.seed);
  const pool = (Array.isArray(sortedItems) ? sortedItems.slice(0, K) : []).filter(Boolean);
  if (!pool.length) return [];
  const minScore = pool.reduce((m, it) => Math.min(m, it.score), Infinity);
  const cand = pool.map(it => ({ it, w: Math.max(0, it.score - minScore) + SAMPLE_WEIGHT_BASE }));
  const picked = [];
  for (let k = 0; k < n && cand.length; k++) {
    let total = 0;
    cand.forEach(x => { total += x.w; });
    let r = rng() * total, idx = cand.length - 1;
    for (let i = 0; i < cand.length; i++) {
      r -= cand[i].w;
      if (r <= 0) { idx = i; break; }
    }
    picked.push(cand[idx].it);
    cand.splice(idx, 1);
  }
  return picked;
}

// ── ③-5b 空偏好多样抽取（2026-09-07）：────────────────────────────────────
// 无偏好新用户打分几乎全同分，普通抽样可能在同一个槽里抽出两道高度同质菜
// （如两碗都是「番茄…面」，main 全=面条；或两道都是番茄炖/烧）。
// 这里抽 2 时按 row.profile.main（主料）错开：第一道正常抽，第二道从「main 与第一道不同」
// 的候选中抽；main 为空（无主料标签）的行不参与碰撞判定（视为通用）。候选不足自动放宽回全池。
// 仅 blankPrefs 路径使用；老用户不受影响。返回数组可能 1~2 项。
function pickTop2Diverse(sortedItems, opts) {
  const o = opts || {};
  const K = (typeof o.K === 'number' && o.K > 0) ? o.K : SAMPLE_POOL_K;
  const rng = (typeof o.rng === 'function') ? o.rng : mulberry32(o.seed || (Date.now() ^ (Math.random() * 0xFFFFFFFF)));
  const base = (Array.isArray(sortedItems) ? sortedItems : []).filter(Boolean);
  if (!base.length) return [];
  const mainKey = (row) => {
    const m = String((row && row.profile && row.profile.main) || '').trim();
    return m;
  };
  const first = pickTopKSampled(base, { K, n: 1, rng });
  if (!first.length) return [];
  const a = first[0];
  const ak = mainKey(a);
  let pool2 = base;
  if (ak) {
    const diff = base.filter(x => x !== a && mainKey(x) !== ak);
    if (diff.length) pool2 = diff;
  } else {
    pool2 = base.filter(x => x !== a);
  }
  const second = pickTopKSampled(pool2, { K, n: 1, rng });
  return second.length ? [a, second[0]] : [a];
}

// ═══════════════════════════════════════════════════════════════════════════
// ── E6：探索位查表化（§4.2④，D10 只推被排序埋没的新菜）────────────────────
// 从 scoreLookupRows 的全量 items（已降序）中筛「未进前 K（=被埋没）且 命中探索方向词
// 且 曝光<3 且 入库≤30 天」的候选，均匀随机抽 1 道；候选不足返回 null（不硬凑）。
// dirKws 由调用方解析（index.js resolveExploreDirKws：DRIFT_MEAT kw 聚合 / HIERARCHY
// 大类展开 / 原词直配）；匹配面 = 菜名 + profile.main。excludeLabels 实现探索菜与
// 保留位主蛋白质错开（§4.2④「探索菜参与 MMR」的最小实现：同大类不与 top[0] 撞车）。

function pickExploreLookup(scoredItems, opts) {
  const o = opts || {};
  const poolK = (typeof o.poolK === 'number' && o.poolK >= 0) ? o.poolK : SAMPLE_POOL_K;
  const now = (typeof o.now === 'number' && o.now) || Date.now();
  const exposureMap = o.exposureMap || {};
  // 方向词自解析：调用方直接传 DRIFT 大类 label（如「鱼虾海鲜」）时，聚合为其 kw 列表再匹配
  // （live 漂移口径是 kw.some 聚合，label 本身不会出现在菜名里）；其余原词直配。
  const dirKws = [];
  (Array.isArray(o.dirKws) ? o.dirKws : []).forEach(x => {
    const kw = String(x || '').trim();
    if (!kw) return;
    const m = DRIFT_MEAT.find(e => e.label === kw);
    if (m && Array.isArray(m.kw)) m.kw.forEach(k => { if (dirKws.indexOf(k) < 0) dirKws.push(k); });
    else if (dirKws.indexOf(kw) < 0) dirKws.push(kw);
  });
  if (!dirKws.length) return null;
  const excludeIds = new Set((Array.isArray(o.excludeIds) ? o.excludeIds : []).map(x => String(x)));
  const excludeLabels = new Set(Array.isArray(o.excludeLabels) ? o.excludeLabels : []);
  const rng = (typeof o.rng === 'function') ? o.rng : mulberry32(o.seed);

  const items = (Array.isArray(scoredItems) ? scoredItems : []).slice(poolK);   // D10：只看被埋没段
  const cands = items.filter(it => {
    if (!it || excludeIds.has(String(it.norm_id))) return false;
    // 方向词命中：菜名 或 profile.main
    const name = String(it.name || '');
    const main = (it.profile && it.profile.main) ? String(it.profile.main) : '';
    const dirHit = dirKws.some(kw => (name && matchKeyword(name, kw, o.DISH_TAGS)) || (main && matchKeyword(main, kw, o.DISH_TAGS)));
    if (!dirHit) return false;
    // 曝光 <3（无曝光记录按 0 = 天然 eligible）
    const ex = exposureMap[it.norm_id];
    if (ex && (ex.cnt || 0) >= EXPLORE_MAX_EXPOSURE) return false;
    // 入库 ≤30 天（ts||createdAt 双读）
    const t = _asTs(it.ts || it.createdAt);
    if (!t) return false;
    const ageDays = (now - t) / 86400000;
    if (ageDays < 0 || ageDays > EXPLORE_AGE_DAYS) return false;
    // MMR 最小实现：与保留位主蛋白质同大类的不选
    if (excludeLabels.size) {
      const labs = dishDriftLabels(name, o.DISH_TAGS);
      if (labs.some(l => excludeLabels.has(l))) return false;
    }
    return true;
  });
  if (!cands.length) return null;
  return cands[Math.floor(rng() * cands.length) % cands.length];
}

// 菜名 → DRIFT 大类 label 列表（kw.some 聚合，与 live matchDriftLabels 口径一致；
// 此处独立实现以保持本模块「DISH_TAGS 由参数传入」的纯度）
function dishDriftLabels(name, DISH_TAGS) {
  const s = String(name || '');
  const out = [];
  DRIFT_MEAT.forEach(m => {
    if (m.kw.some(k => matchKeyword(s, k, DISH_TAGS))) out.push(m.label);
  });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── E7：完整句 reason 校验 + category 兜底池（§4.2⑤/§4.5/§4.6）────────────
// dish_recommend.reason 实测混有 env2 生成过程的非完整句（如「env2 AI 新菜：食材 / 步骤…」，
// 08-29 抽样实锤）——拼装前过合法句校验，不合法按 [lookup-reason-miss] 走 category 兜底池。
// 兜底池为完整句口径（决策 3），按桶（素菜/荤菜/汤羹/主食/饮品/通用）分池防错配；
// 确定性抽取：hash(norm_id) 定位池内下标，同菜恒同句、可复现。

const LOOKUP_REASON_BUCKET_WORDS = {
  veg: ['素菜', '蔬菜', '青菜'],
  soup: ['汤', '羹'],
  drink: ['饮品', '饮料', '茶', '果汁'],
  staple: ['主食', '米饭', '面食', '粥']
};

// 完整句兜底池（≤14 字为宜——列表 14 字单行截断，D8；句式自然完整、按桶防错配）
const LOOKUP_REASON_POOLS = {
  veg: ['清爽不油腻，纤维满满很舒服', '清淡少油，蔬菜的鲜甜都在', '素得有滋有味，下饭不将就', '脆嫩爽口，解腻刚刚好', '家常素菜，清淡也能很香'],
  meat: ['荤香十足，解馋又顶饱', '肉质软嫩入味，越吃越香', '经典家常味，配饭一绝', '香而不腻，蛋白质管够', '火候刚好，嫩滑多汁'],
  soup: ['热汤下肚，暖胃又舒服', '汤鲜味浓，喝完浑身舒坦', '一锅好汤，滋润不油腻', '清润滋补，全家都合适', '汤底醇厚，料也很实在'],
  drink: ['解腻又解渴，正餐好搭档', '清爽顺口，饭后来一杯正好', '生津解暑，比饮料更舒心', '温润好入口，暖胃不刺激'],
  staple: ['管饱主食，配什么都合适', '软硬适中，越嚼越香', '扎实顶饱，简单却离不开', '热乎松软，吃着踏实', '主食担当，分量刚刚好'],
  general: ['家常好味，放心不会出错', '咸淡适中，下饭正合适', '老少皆宜的家常选择', '做法简单，味道却很正', '今天就来点踏实的家常味']
};

function isValidReasonSentence(r) {
  const s = String(r == null ? '' : r).trim();
  if (s.length < 4 || s.length > 60) return false;              // 完整句口径：过短（4字池混入除外）/过长异常
  if (/^env2/i.test(s)) return false;                           // 生成管线泄漏（08-29 实测形态）
  if (/新菜[:：]|食材[:：]|步骤[:：]|做法[:：]/.test(s)) return false;
  if (/ \/ |；|\n/.test(s)) return false;                       // 步骤分隔符形态
  let cn = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 19968 && c <= 40959) cn++; }
  return cn >= 4;                                               // 至少 4 个中文字符（兼容存量 4 字评语）
}

// 桶判定：profile.type / isSoup / kind → 兜底池 key（kind 优先——「酸梅汤」等饮品名带「汤」不误入汤桶）
function reasonBucket(row) {
  const prof = (row && row.profile) || {};
  if ((row && row.kind) === 'drink') return 'drink';
  if (prof.isSoup === true || /[汤羹]$/.test(String((row && row.name) || ''))) return 'soup';
  const type = String(prof.type || (row && row.category) || '');
  for (const key of Object.keys(LOOKUP_REASON_BUCKET_WORDS)) {
    if (LOOKUP_REASON_BUCKET_WORDS[key].some(w => type.indexOf(w) >= 0)) return key;
  }
  if ((row && row.kind) === 'staple') return 'staple';
  return 'general';
}

function buildFallbackReason(normId, row) {
  const bucket = reasonBucket(row);
  const pool = LOOKUP_REASON_POOLS[bucket] || LOOKUP_REASON_POOLS.general;
  let h = 5381;
  const s = String(normId || '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

// ── E7：条目拼装（与 live normItem 字段逐一对齐 + imageUrl）────────────────
// live item = {name, cuisine, reason, calories, protein, carb, fat}（normItem 输出）；
// lookup 增加 imageUrl（前端已按 item.imageUrl 消费、缺省走 getDishImage 实时生图，§4.6）。
// nutrition 格式与 estimateNutrition 完全一致：'约X千卡' / 'Xg' 四件套。
// helpers = { normalizeCuisine }（index.js 注入，复用 CUISINE_ALIAS，避免双份口径）。

function buildLookupItem(row, cold, helpers) {
  const h = helpers || {};
  const nid = String(row.norm_id || normLexName(row.name));
  const coldObj = cold || {};
  const reasonMiss = !isValidReasonSentence(coldObj.reason);
  const reason = reasonMiss ? buildFallbackReason(nid, row) : String(coldObj.reason).trim();
  const cuisine = (h.normalizeCuisine || (x => x))(row.cuisine || (row.profile && row.profile.cuisine) || '');
  const arr = coldObj.nutrition;
  const nutri = (arr && arr.length === 4 && arr.every(x => isFinite(x))) ? arr.map(Number) : null;
  if (!nutri && typeof h.lookupNutrition === 'function') {
    // 本地零 AI 兜底（DISH_NUTRITION 代码表 → fallbackDishNutrition），由 index.js 注入
    const f = h.lookupNutrition(row.name, row.kind);
    return {
      item: Object.assign({ name: row.name, cuisine, reason, imageUrl: coldObj.imageUrl || '' }, f),
      reasonMiss, nutriSource: 'local'
    };
  }
  const v = nutri || [0, 0, 0, 0];
  return {
    item: {
      name: row.name, cuisine, reason, imageUrl: coldObj.imageUrl || '',
      calories: '约' + v[0] + '千卡', protein: v[1] + 'g', carb: v[2] + 'g', fat: v[3] + 'g'
    },
    reasonMiss,
    nutriSource: nutri ? 'cold' : 'local'
  };
}

module.exports = {
  LOOKUP_SCORING_VERSION,
  // 系数（单测断言 / E9 定标 / 管理后台展示用）
  C: {
    PREF_SEL_BASE, PREF_SEL_CAP, PREF_SEL_FLOOR, PREF_UNSEL_BASE, PREF_UNSEL_CAP, PREF_UNSEL_FLOOR,
    PREF_HIT_COEF, PREF_BAD_COEF, PREF_BAYES_K, PREF_NEUTRAL_COEF, BASE_MAX,
    BONUS_FLAVOR, CUISINE_STRONG_W, BONUS_CUISINE_STRONG, CUISINE_MID_W, BONUS_CUISINE_MID,
    BONUS_TYPE, BONUS_STAPLE, SPICY_ALIGN_BONUS, SPICY_STRONG_ALIGN_BONUS,
    SPICY_MISMATCH_PENALTY, SPICY_MISMATCH_SOFT_PENALTY,
    EXPLORE_BONUS, EXPLORE_AGE_DAYS, EXPLORE_MAX_EXPOSURE,
    EXPOSURE_PENALTY_COEF, EXPOSURE_PENALTY_MAX, EXPOSURE_ZERO_ACCEPT_MIN_CNT,
    EXPOSURE_ZERO_ACCEPT_RATIO, EXPOSURE_ZERO_ACCEPT_PENALTY,
    SEASON_WINTER_MONTHS, SEASON_WINTER_COLD_PENALTY, SEASON_WINTER_SOUP_BONUS,
    SEASON_HOT_TEMP, SEASON_HOT_COLD_BONUS,
    DRINK_SCENES, SCENE_MEAL_MAP, MEALTIME_MISS_PENALTY,
    SAMPLE_POOL_K, SAMPLE_PICK_N
  },
  mulberry32,
  spicyPrefLevel,
  buildPrefScoreMaps,
  hardFilterLookup,
  weightBaseScore,
  aiMatchBonus,
  exploreBonus,
  calcSeasonBonus,
  isColdish,
  isSoupish,
  exposurePenalty,
  scoreLookupRows,
  pickTopKSampled,
  pickTop2Diverse,
  pickExploreLookup,
  dishDriftLabels,
  isValidReasonSentence,
  buildFallbackReason,
  reasonBucket,
  buildLookupItem,
  LOOKUP_REASON_POOLS
};
