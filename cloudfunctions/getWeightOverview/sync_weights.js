// 权重算法共享模块（2026-08-06）
// 目的：消除 getRecommendation 与 getWeightOverview 两套「偏好权重」口径不一致，
// 并把标签匹配 / 伪命中过滤 / 漂移口径集中到一处维护。
// ⚠️ 本模块【不依赖】wx-server-sdk / @cloudbase/node-sdk，纯 JS，可被两个云函数安全 require。
// ⚠️ DISH_TAGS 由调用方传入（dishes.json 体积大，避免在多处重复 require 同一大对象造成内存浪费），
//    不在此处 require。若无传入则自动回退子串匹配。

// 版本号（2026-08-06 优化#6 运行时/脚本双重校验用）：
// 每次改动本模块逻辑后【必须 bump 此常量】并同步复制到两个云函数目录，
// scripts/check_sync_weights.js 会校验三处版本号一致，杜绝「改了 utils 却忘复制副本」。
const SYNC_WEIGHTS_VERSION = '2026-08-11.neutral-events-ts';

// ── 子串误命中过滤表 ──────────────────────────────────────────────
// 单字/短词偏好项做 indexOf 匹配时会被无关菜名误命中，导致学习权重系统性偏移。
// 命中前先判定：菜名中该关键词若出现在下列「伪命中词」内，则本次不计分。
const FALSE_HIT = {
  '猪': ['猪油渣', '猪油'],
  '牛': ['牛奶糖', '牛油果', '牛轧糖', '牛肉味', '牛奶', '牛蒡', '牛油'],
  '羊': ['羊栖菜', '羊角蜜', '羊奶'],
  '鸡': ['鸡蛋羹', '鸡蛋饼', '鸡毛菜', '鸡油菌', '鸡尾酒', '鸡精', '鸡蛋', '鸡枞'],
  '鸭': ['鸭梨', '鸭跖草'],
  '肉': ['肉桂', '肉蔻', '肉松面包', '果肉', '椰肉'],
  '蛋': ['蛋黄酱', '皮蛋豆腐', '松花蛋粥', '蛋挞皮', '鹌鹑蛋'],
  '鱼': ['鱼香肉丝', '鱼皮花生', '鱼子酱', '鱼腥草', '木鱼花', '鲍鱼汁', '鱼露', '鱼丸味'],
  '虾': ['虾饼干', '虾片', '虾米', '虾皮', '虾酱', '虾油'],
  '蟹': ['蟹味菇', '赛螃蟹', '蟹黄酱'],
  '贝': ['贝母', '贝果'],
  '海': ['海苔碎', '海鲜酱', '海带结'],
  '豆': ['豆瓣酱', '绿豆汤', '红豆沙', '豆豉酱', '咖啡豆', '豆浆', '豆奶', '豆花', '豆蔻', '豆沙'],
  '菜': ['菜籽油', '梅菜扣肉', '榨菜丝', '菜谱'],
  '茄': ['番茄酱', '圣女果', '番茄'],
  '椒': ['花椒油', '胡椒粉', '花椒', '胡椒', '椒盐'],
  '葱': ['葱油饼', '葱油', '洋葱圈'],
  '姜': ['姜汁汽水', '姜糖', '姜汁', '生姜末'],
  '蒜': ['蒜蓉酱', '蒜香粉', '蒜苔'],
  '瓜': ['瓜子', '西瓜汁', '哈密瓜', '木瓜'],
  '笋': ['笋干丝'],
  '菌': ['菌菇酱'],
  '米': ['米酒', '米醋', '玉米', '虾米', '花生米', '米线'],
  '面': ['面包', '面粉', '面筋', '芝麻面包', '面膜'],
  '粉': ['粉丝汤', '藕粉', '淀粉', '奶粉', '胡椒粉', '咖喱粉'],
  '薯': ['薯片', '薯条'],
  '芋': ['芋圆'],
  '藕': ['藕粉'],
  '果': ['果汁', '果醋', '牛油果', '腰果', '开心果', '白果', '果酱'],
  '花': ['花椒', '花生油', '桂花酱', '花生酱', '菜花']
};

// 预编译 FALSE_HIT：每个关键词 kw 的伪命中词按长度降序排好，并拼成正则，
// 供 isRealHit 一次性剔除（避免每次调用都 slice().sort().split().join() 重建字符串）。
const FALSE_HIT_RE = {};
Object.keys(FALSE_HIT).forEach(kw => {
  const bads = FALSE_HIT[kw];
  if (!bads || !bads.length) return;
  const sorted = bads.slice().sort((a, b) => b.length - a.length);
  FALSE_HIT_RE[kw] = new RegExp(sorted.map(escRe).join('|'), 'g');
});

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 判断关键词 kw 在菜名 s 中是否为「真命中」：剔除所有伪命中词后仍能找到 kw 才算数。
function isRealHit(s, kw) {
  if (s.indexOf(kw) < 0) return false;
  const re = FALSE_HIT_RE[kw];
  if (!re) return true;
  re.lastIndex = 0;
  const rest = s.replace(re, '');
  return rest.indexOf(kw) >= 0;
}

// ── 统一 DRIFT_MEAT（两套算法共用，杜绝口径漂移）────────────────────
// 维度对齐 getWeightOverview（较全版），getRecommendation 也引用此表，保证漂移口径一致。
const DRIFT_MEAT = [
  { kw: ['猪', '排骨', '五花', '肘', '猪蹄'], label: '猪肉' },
  { kw: ['牛', '牛腩', '牛柳', '肥牛'], label: '牛肉' },
  { kw: ['羊', '羊肉', '羊排'], label: '羊肉' },
  { kw: ['鸡', '鸡腿', '鸡翅', '鸡胸'], label: '鸡肉' },
  { kw: ['鸭', '烤鸭', '鸭腿'], label: '鸭肉' },
  { kw: ['鱼', '鲈', '鲫', '带鱼', '鳕', '鲑', '虾', '蟹', '海鲜', '鱿', '贝'], label: '鱼虾海鲜' },
  { kw: ['蛋'], label: '蛋类' },
  { kw: ['豆腐', '豆干', '素', '蔬', '青菜', '白菜', '土豆', '番茄', '黄瓜', '冬瓜', '南瓜', '萝卜', '蘑菇', '香菇', '芦笋', '豆芽', '藕', '山药'], label: '素菜/豆制品' }
];

// 标签匹配：给定菜名 name 与目标小类关键词 kw（如 '猪肉'/'牛肉'/'豆腐'/'青菜'），优先用 DISH_TAGS 结构化标签判定。
// 职责清晰：标签回答「这道菜是什么」，命中即真命中（不再退回子串 isRealHit，避免二者互相打架，#4）；
// 标签未覆盖该小类时回退 isRealHit 子串匹配作为补充（#5），而不是「有标签就垄断判定」。
// ⚠️ DRIFT_MEAT 的 kw 同时跨 meat/veg（如「猪」=肉类、「豆腐」「青菜」=素菜），故对 tag.meat 与 tag.veg 两个数组都查，
//    任一命中即算真命中，避免「豆腐」只归在 veg 标签却被错判不命中。
function matchKeyword(name, kw, DISH_TAGS) {
  const s = String(name);
  if (DISH_TAGS && DISH_TAGS[s]) {
    const tag = DISH_TAGS[s];
    const meatArr = Array.isArray(tag.meat) ? tag.meat : [];
    const vegArr = Array.isArray(tag.veg) ? tag.veg : [];
    const hit = meatArr.concat(vegArr).some(t => String(t).indexOf(kw) >= 0);
    if (hit) return true; // 标签命中即真命中，不再过子串 isRealHit
    // 标签里确实没有该小类关键字，仍回退子串 + 伪命中过滤（补充标签未覆盖的维度，如「辣」）
    return isRealHit(s, kw);
  }
  // 兜底：无结构化标签时沿用子串 + 伪命中过滤
  return isRealHit(s, kw);
}

// ── 软差评（softDislike）读取 helper（2026-08-06 优化#2：差评时间衰减）────
// softDislike 由 rateDish 写入为 {dish, ts} 对象数组（兼容旧纯字符串数组）。
// 读取端统一经这两个 helper，避免每处手写兼容逻辑、口径漂移。
function _asDish(x) {
  if (typeof x === 'string') return { dish: x, ts: 0 };
  if (x && typeof x === 'object') return { dish: String(x.dish || ''), ts: _asTs(x.ts) };
  return null;
}
// 仅取菜名（保持旧行为：所有「禁出名单/硬剔除」用纯名即可）
function extractDislikeNames(prefs) {
  const arr = (prefs && Array.isArray(prefs.softDislike)) ? prefs.softDislike : [];
  const out = [];
  arr.forEach(x => { const d = _asDish(x); if (d && d.dish) out.push(d.dish); });
  return out;
}
// 带衰减权重的差评展开：返回 [{label, w}]（w 由 halfLifeDays 衰减，默认 15 天，比正向更短）
function extractDislikeTimed(prefs, probe, field, DISH_TAGS, now, halfLifeDays) {
  const arr = (prefs && Array.isArray(prefs.softDislike)) ? prefs.softDislike : [];
  const base = now || Date.now();
  const hl = (typeof halfLifeDays === 'number' && halfLifeDays > 0) ? halfLifeDays : 15;
  const dec = {};
  arr.forEach(x => {
    const d = _asDish(x);
    if (!d || !d.dish) return;
    // 无时间戳的旧差评（纯字符串数组）视为「近期全权重」(ts=now)，既不丢失也不永久霸凌，
    // 会被新带时间戳的差评逐渐稀释（符合用户"旧数据不丢失、被新数据稀释"预期）。
    const w = (d.ts) ? timeDecayFn(d.ts, base, hl) : timeDecayFn(Date.now(), base, hl);
    let labels = [];
    if (field === 'cuisine') {
      const kws = (DISH_TAGS && DISH_TAGS[d.dish] && DISH_TAGS[d.dish].cuisine) || [];
      labels = kws.slice();
    } else {
      // 用 probe 同套匹配规则把差评菜映射到类目 label
      const s = d.dish;
      if (DISH_TAGS && DISH_TAGS[s]) {
        const tag = DISH_TAGS[s];
        (Array.isArray(tag.meat) ? tag.meat : []).concat(Array.isArray(tag.veg) ? tag.veg : []).forEach(l => labels.push(l));
      }
    }
    if (!labels.length) {
      // 兜底：用 probe 关键词反查
      (probe || []).forEach(kw => { if (matchKeyword(d.dish, kw, DISH_TAGS)) labels.push(kw); });
    }
    labels.forEach(l => { dec[l] = (dec[l] || 0) + w; });
  });
  return dec;
}

// ── 中性反馈（全局标量稀释）读取 helper（2026-08-10 接入 / 2026-08-11 升级带 ts 时间衰减）────
// rateDish 中性反馈（v===0）语义：「用户整体无感倾向」的标量，不记录具体菜名——
// 我们没法知道用户对哪道菜无感，只知「他一共给了多少次无感」。
// 这个总量表达对「偶发好评过度放大」的抑制——频繁给无感的用户，其单条好评更可能是偶然。
// 故中性权重按「全局标量」作用于所有类目（轻量稀释），与 softDislike（有明细、按类目定向降权）互补：
//   softDislike = 明确「这方向我不喜欢」（强、定向）
//   neutral    = 模糊「我对推荐整体无感」（弱、全局，仅防好评被过度放大）
// 2026-08-11 升级：rateDish 现已把每次无感事件写入 neutralEvents（[{ts},...]，仅带时间戳、不带菜名）。
//   算法端据此按时间衰减加权——近期无感权重高、久远无感缓慢消退，比旧「纯整数计数」更准。
//   halfLifeDays 默认 60（比差评 15 天长=弱信号慢消退）。所有带 ts 事件衰减权重求和后，
//   以饱和函数 1-e^(-sum/SCALE) 压成 0~1 标量（SCALE=8 约 8 次有效无感达 ~63%）。
// 兼容回退：旧用户无 neutralEvents 时，回退 neutralCount 整数标量（不衰减，保持上线初行为）。
// 返回 { weight }：所有类目共享同一个中性标量权重。
function extractNeutralTimed(prefs, halfLifeDays) {
  const hl = (typeof halfLifeDays === 'number' && halfLifeDays > 0) ? halfLifeDays : 60;
  const now = Date.now();
  const events = (prefs && Array.isArray(prefs.neutralEvents)) ? prefs.neutralEvents : [];
  if (events.length) {
    // 新数据：遍历带 ts 的中性事件，按 60 天半衰期衰减后求和
    let sum = 0;
    events.forEach(e => {
      const t = _asTs(e && e.ts);
      // 无 ts 的事件（理论上不会发生，rateDish 都带 ts）按「近期全权重」处理
      sum += t ? timeDecayFn(t, now, hl) : 1;
    });
    const SCALE = 8;
    const weight = 1 - Math.exp(-sum / SCALE);
    return { weight: Math.max(0, Math.min(1, weight)) };
  }
  // 回退：兼容无 neutralEvents 的旧用户（neutralCount 仍是整数标量）
  const cnt = (prefs && typeof prefs.neutralCount === 'number') ? prefs.neutralCount : 0;
  if (cnt <= 0) return { weight: 0 };
  const SCALE = 8;
  const weight = 1 - Math.exp(-cnt / SCALE);
  return { weight: Math.max(0, Math.min(1, weight)) };
}

// ── 小样本平滑（2026-08-06 优化#5：替代 cnt<3 硬降档）─────────────────
// 采用「对数折扣」而非贝叶斯收缩：无需维护全局大盘先验，数学透明且量纲一致。
//   adjusted = wRaw * cnt / (cnt + K)，K=3
// - cnt=0 → 0（无数据，不强行给先验，避免新用户被错误赋强偏好）
// - cnt=2 → wRaw*0.4（保留 40% 强信号，不再被砍档）
// - cnt 大 → 趋近 wRaw（由命中主导，无过拟合）
// 比"向用户自身均值收缩"更稳健：纯新用户 prior=0 会导致收缩无效、与硬降档无区别的旧问题。
function bayesShrink(wRaw, cnt, prior, K) {
  const c = (typeof cnt === 'number' && cnt > 0) ? cnt : 0;
  const k = (typeof K === 'number' && K > 0) ? K : 3;
  const w = (typeof wRaw === 'number') ? wRaw : 0;
  if (c === 0) return 0; // 无数据返回 0（cnt=0 时 wRaw 预期也为 0，未命中项无分数）
  return w * (c / (c + k));
}

// ── 探索失败短期黑名单（2026-08-06 优化#1：探索-利用记忆）──────────────
// 探索方向（exploreTarget/exploreCross）一旦被 softDislike 命中，说明用户不买账，
// 在 TTL 天内把它移出探索池，避免反复骚扰。返回「被封禁的探索大类 label 集合」。
const EXPLORE_PENALTY_TTL_DAYS = 7;
function explorePenalty(prefs, now) {
  const arr = (prefs && Array.isArray(prefs.softDislike)) ? prefs.softDislike : [];
  const base = now || Date.now();
  const ttl = EXPLORE_PENALTY_TTL_DAYS * 86400000;
  const banned = new Set();
  arr.forEach(x => {
    const d = _asDish(x);
    if (!d || !d.dish) return;
    const ts = d.ts || Date.now(); // 无 ts 的旧差评按当前时间视为近期全权重（与 7.2 extractDislikeTimed 旧数据兼容策略一致）
    if (base - ts > ttl) return; // 超出 TTL 解封
    // 把差评菜映射到 DRIFT_MEAT 大类 label，作为被封禁的探索池项
    matchDriftLabels(d.dish, null).forEach(l => banned.add(l));
  });
  return banned;
}

// ── cuisine 漂移软化（2026-08-06 优化#7：硬约束-行为矛盾反向利用）──────
// 检测 p.cuisine（显选菜系）与历史实际高频菜系冲突时，产出 tasteShift 提示：
// 适度放宽硬约束，允许少量非偏好菜系，软化「硬约束崩坏」风险。
// 返回 tasteShift 文本行（空串=无冲突）。
const CUISINE_DRIFT_WINDOW_DAYS = 30;
function cuisineTasteShift(prefs, sample, DISH_TAGS, now) {
  const sel = (prefs && Array.isArray(prefs.cuisine)) ? prefs.cuisine.map(String) : [];
  if (!sel.length) return '';
  const base = now || Date.now();
  const pairs = _pairify(sample);
  const { recent } = splitByRecency(pairs, base, CUISINE_DRIFT_WINDOW_DAYS);
  if (recent.length < 5) return '';
  // 统计近段实际菜系 Top
  const actual = {};
  recent.forEach(p => {
    const kws = (DISH_TAGS && DISH_TAGS[p.name] && DISH_TAGS[p.name].cuisine) || [];
    kws.forEach(c => { actual[c] = (actual[c] || 0) + 1; });
  });
  const topActual = Object.keys(actual).sort((a, b) => actual[b] - actual[a])[0];
  if (!topActual) return '';
  // 实际高频菜系既非用户显选，又达到一定占比 → 触发 tasteShift
  if (sel.indexOf(topActual) < 0 && actual[topActual] >= Math.ceil(recent.length * 0.4)) {
    return topActual;
  }
  return '';
}

// ===== 时间衰减 / 冷启动 / 漂移增强（2026-08-06 优化 #1/#2/#3/#7）=====
// 统一用「真实时间间隔」而非「序列位置」做衰减（文献：RUC 时变偏好、Cao 兴趣漂移均按时间窗）。

// 解析多种形态的时间戳（与 getRecommendation.analyzeRepeat 同源）
function _asTs(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
  if (v && typeof v.$date === 'number') return v.$date;       // 云数据库 {$date: ms}
  if (v && typeof v.$date === 'string') { const t = Date.parse(v.$date); return isNaN(t) ? 0 : t; }
  return 0;
}

// 真实时间间隔衰减：以 halfLifeDays 为半衰期，ageDays 越大衰减越多。
// ts=0（无时间信息）按「最旧」保守处理，避免无时间记录被当成最新。
// halfLifeDays 可外部传入（由 tuning.recency 调节：念旧→长半衰期 / 喜新→短半衰期），默认 30 天保持旧行为。
function timeDecayFn(ts, now, halfLifeDays) {
  const HALF_LIFE_DAYS = (typeof halfLifeDays === 'number' && halfLifeDays > 0) ? halfLifeDays : 30;
  const t = _asTs(ts);
  const base = now || Date.now();
  if (!t) return Math.pow(0.5, 365 / HALF_LIFE_DAYS); // 无时间 → 极弱
  const ageDays = Math.max(0, (base - t) / 86400000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

// 把 sample（支持 string[] 或 {name,ts}[]）统一成 {name, ts} 数组
function _pairify(sample) {
  if (!Array.isArray(sample)) return [];
  return sample.map(s => {
    if (typeof s === 'string') return { name: s, ts: 0 };
    if (s && typeof s === 'object') return { name: String(s.name || ''), ts: _asTs(s.ts) };
    return { name: String(s), ts: 0 };
  }).filter(x => x.name);
}

// 构造「按真实时间戳衰减」的 decayFn，供 countHits(decayFn(i,n,item)) 使用。
// item 为 sample 中的元素（string 或 {name,ts}）。ts 缺失时退化为 0.96^i 兜底，避免老链路突变。
// halfLifeDays：半衰期（天），由 tuning.recency 映射传入；默认 30 天保持旧行为。
function makeTimeDecayFn(now, halfLifeDays) {
  const base = now || Date.now();
  const hl = (typeof halfLifeDays === 'number' && halfLifeDays > 0) ? halfLifeDays : 30;
  return function (i, n, item) {
    const ts = _asTs(item && (typeof item === 'object' ? item.ts : 0));
    if (ts) return timeDecayFn(ts, base, hl);
    return Math.pow(0.96, i);
  };
}

// 按真实时间戳把样本切成近段 / 早段（用于漂移检测的差值法）
// thresholdDays：近段窗口（默认 30 天）。返回 { recent:[labels], earlier:[labels] }
function splitByRecency(pairs, now, thresholdDays) {
  const base = now || Date.now();
  const thr = (thresholdDays || 30) * 86400000;
  const recent = [], earlier = [];
  (Array.isArray(pairs) ? pairs : []).forEach(p => {
    const t = _asTs(p && p.ts);
    const target = (p && typeof p.name === 'string') ? p : { name: String(p) };
    if (t && (base - t) <= thr) recent.push(target);
    else earlier.push(target);
  });
  return { recent, earlier };
}

// 冷启动季节基线：新用户无历史时，按当前季节给一个弱先验（避免纯靠混元默认）
// 返回 { label: weight }，weight ∈ (0, 弱档上限)。season 由调用方 currentSeason() 给。
function coldStartBaseline(season) {
  const SEASON_TOP = {
    spring: ['春笋', '荠菜', '菠菜', '韭菜', '河鲜', '鱼虾'],
    summer: ['冬瓜', '苦瓜', '丝瓜', '黄瓜', '鸭肉', '凉拌', '清蒸'],
    autumn: ['蟹', '莲藕', '南瓜', '栗子', '羊肉', '炖'],
    winter: ['萝卜', '牛肉', '羊肉', '火锅', '炖', '根茎']
  };
  const list = SEASON_TOP[season] || [];
  const out = {};
  list.forEach((l, i) => { out[l] = 20 - i * 0.5; }); // 弱先验，最高 20（弱档）
  return out;
}

// 列出 name 命中的 DRIFT_MEAT 大类 label（一道菜对同 label 只计一次）
// 加同菜名结果缓存：全量统计时千级历史里大量重复菜名，避免反复遍历 8 大类 × 多 kw（#8）。
const _driftCache = new Map();
const _driftCacheMax = 2000;
function matchDriftLabels(name, DISH_TAGS) {
  const s = String(name);
  if (_driftCache.has(s)) return _driftCache.get(s);
  const hit = [];
  const seen = new Set();
  DRIFT_MEAT.forEach(m => {
    if (seen.has(m.label)) return;
    const ok = m.kw.some(k => matchKeyword(s, k, DISH_TAGS));
    if (ok) { hit.push(m.label); seen.add(m.label); }
  });
  if (_driftCache.size < _driftCacheMax) _driftCache.set(s, hit);
  return hit;
}

module.exports = {
  FALSE_HIT,
  isRealHit,
  DRIFT_MEAT,
  matchKeyword,
  matchDriftLabels,
  _asTs,
  timeDecayFn,
  _pairify,
  makeTimeDecayFn,
  splitByRecency,
  coldStartBaseline,
  extractDislikeNames,
  extractDislikeTimed,
  extractNeutralTimed,
  bayesShrink,
  explorePenalty,
  cuisineTasteShift,
  SYNC_WEIGHTS_VERSION
};
