const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const W = require('./sync_weights');
// 优化#6 运行时校验（方案A轻量版）：打印共享模块版本，便于线上日志排查「副本不同步」口径漂移。
console.log('[sync_weights] getWeightOverview version=' + (W.SYNC_WEIGHTS_VERSION || '?'));
const BUILD_TAG = '2026-08-17.getweightoverview-401-diag';
console.log('[build] getWeightOverview BUILD_TAG=' + BUILD_TAG);
const { DRIFT_MEAT, matchKeyword } = W;

// 当前季节（内联，避免依赖 getRecommendation 的 currentSeason）
function currentSeason() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}
// 结构化菜名标签（与 getRecommendation 同源的 dishes.json），用于消除子串误命中
const DISH_TAGS = (require('./dishes.json').tags) || {};

// 全局算法理解总览（2026-08-06）：基于用户「就它了」历史 + 偏好设置，
// 产出一份算法对你的整体理解：肉类/菜类权重强度、探索方向、降档方向、一句话总结。
// 零扣次、纯读（recommend_history + gen_records + user_preferences）。
// 2026-08-06 扩展：冰箱/周表/剩菜(gen_records)的实际选择也已并进取像，让「算法眼里的你」
// 反映用户在冰箱反推、一周菜单、剩菜改造里的真实偏好（与主算法 getRecommendation 同源口径）。
// 供「我的」页「算法理解总览」卡片调用。
// 与 getRecommendation 的主权重算法（computePrefWeights）同源：相同的 0.96^i 时间衰减、DRIFT_MEAT 漂移口径。
// 注意：画像侧用「相对自身最大值归一化」后的档位口径（>=70 强 / >=45 中 / 其余弱，见 computeFieldWeights），
// 与出文侧绝对分的档位（>=85 强 / >=60 中）展示维度不同，但底层同源、归一化逻辑一致，不会口径漂移。
// DRIFT_MEAT：统一引用 sync_weights（与 getRecommendation 同源），不再本地重复定义，杜绝口径漂移。
// 纯蔬菜维度（用于「蔬菜」结论维）：剔除豆制品/菌类/根茎淀粉，避免与「素菜/豆制品」维度重叠
const VEG_PURE = ['上海青', '小白菜', '菠菜', '油麦菜', '空心菜', '芥蓝', '苋菜', '生菜', '西兰花', '韭菜', '芹菜', '莴笋', '黄瓜', '番茄', '西红柿', '茄子', '胡萝卜', '白萝卜', '萝卜', '冬瓜', '南瓜', '洋葱', '青椒', '彩椒', '白菜', '蒜薹', '蒜苗', '菜心', '包菜', '卷心菜', '豇豆', '四季豆', '黄花菜', '芥菜', '雪里蕻', '大白菜', '娃娃菜'];

// 口味/做法细分维度（用于人格细分）：与食材维度正交，独立计分
const FLAVOR_HOT = [{ kw: ['辣', '麻', '川', '湘', '渝', '黔', '赣', '火锅', '麻辣', '爆辣', '微辣', '泡椒', '剁椒', '干锅', '麻辣烫', '酸辣', '辣子', '花椒', '藤椒'], label: '辣味' }];
const FLAVOR_WARM = [{ kw: ['汤', '煲', '炖', '砂锅', '羹', '糊', '锅', '焖', '烩'], label: '暖食汤品' }];
const FLAVOR_PORRIDGE = [{ kw: ['粥'], label: '粥品' }];
const FLAVOR_ROAST = [{ kw: ['烤', '炸', '煎', '铁板', '孜然', '炭', '串', '油'], label: '烧烤炸物' }];
const FLAVOR_COLD = [{ kw: ['凉拌', '沙拉', '刺身', '生', '冷', '冰', '渍'], label: '凉拌生鲜' }];

// 主食子类维度（路线A：不做"吃不吃主食"，做"吃什么主食"——避免全员命中无区分度）。
// 复用 computeFieldWeights（useTag=false 纯子串匹配，因 DISH_TAGS 无主食子类标签）。
// 关键词设计：每道菜对所有维度并行试匹配，靠子串互斥避免跨维度误命中。
// 排除：纯蛋/纯肉/纯菜噪点（如羊排、鸡翅、火锅底料、素蟹粉、蒸芹菜叶）不命中任何维度。
const STAPLE_TYPE = [
  { kw: ['饭', '丼', '粥', '燕麦', '玉米', '汤圆', '糍粑', '年糕', '马拉糕', '杂粮蒸糕', '一只鸡蛋糕'], label: '米面粥燕麦' },
  { kw: ['面', '粉', '饼', '饺', '馄饨', '包子', '烧卖', '馒头', '馍', '河粉', '凉皮', '盒子', '面卷', '粗卷', '卷饼'], label: '面食粉类' },
  { kw: ['面包', '吐司', '三明治', '披萨', '蛋糕', '薯条', '薯饼'], label: '面包西式' }
];

// 近 N 天窗口（按中国时区近似）
function sinceDate(days) {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600 * 1000);
  utc8.setDate(utc8.getDate() - days);
  return new Date(utc8.getTime() - 8 * 3600 * 1000);
}

// 统计 name 命中的大方向标签（返回 [{label, kw}]，kw=命中的食材关键词，一道菜对同一 label 只计一次）
// useTag=true 时（DRIFT_MEAT 肉类/海鲜维度）走 DISH_TAGS 结构化标签优先 + isRealHit 兜底，消除子串误命中；
// useTag=false 时（口味/做法 FLAVOR_* 维度）沿用裸 indexOf（做法词无伪命中问题）。
function matchLabels(name, table, useTag) {
  const s = String(name);
  const hit = [];
  const seen = new Set();
  table.forEach(m => {
    if (seen.has(m.label)) return;
    let k = null;
    if (useTag) {
      // 复用 sync_weights 的 matchKeyword：标签优先，无标签时 isRealHit 兜底（#4/#3 修复口径不一致）
      const ok = m.kw.some(kk => matchKeyword(s, kk, DISH_TAGS));
      if (ok) k = m.kw.find(kk => matchKeyword(s, kk, DISH_TAGS));
    } else {
      k = m.kw.find(kk => s.indexOf(kk) >= 0);
    }
    if (k) { hit.push({ label: m.label, kw: k }); seen.add(m.label); }
  });
  return hit;
}

// 维度级命中条数：统计 names 里有多少个 name 至少命中该维度一个子类（与 baseline 同口径）。
// 用于 TGI 双保险：abs_dim = dimHit / total（维度整体投入占比），而非只看 top 子类。
function dimHitCount(names, table, useTag) {
  let hit = 0;
  W._pairify(names).forEach(p => {
    if (matchLabels(p.name, table, useTag).length) hit++;
  });
  return hit;
}

// 8 个画像维度的统一定义（key 与 baseline 集合键对齐，computeBaseline 复用同一套）。
// FLAVOR_DIMS 标记做法类（flavor 暖橙），其余为食材类（ingredient 绿）。
const DIM_DEFS = {
  hotW:     { table: FLAVOR_HOT, useTag: false },
  warmW:    { table: FLAVOR_WARM, useTag: false },
  porridgeW:{ table: FLAVOR_PORRIDGE, useTag: false },
  roastW:   { table: FLAVOR_ROAST, useTag: false },
  coldW:    { table: FLAVOR_COLD, useTag: false },
  meatW:    { table: DRIFT_MEAT, useTag: true },
  vegW:     { table: [{ kw: VEG_PURE, label: '蔬菜' }], useTag: true },
  stapleW:  { table: STAPLE_TYPE, useTag: false }
};
const FLAVOR_DIM_KEYS = new Set(['hotW', 'warmW', 'porridgeW', 'roastW', 'coldW']);

// 计算某维度的权重：返回 [{label, score, level, pct, samples, cnt}]，按 score 降序
// useTag 透传给 matchLabels（见上）。样本不足（<3）时 level 降级并标记 lowSample，避免误导。
// names 支持 string[] 或 {name, ts}[]（ts=选中时间）。2026-08-06 #1/#2：改用真实时间间隔衰减
// （makeTimeDecayFn），半衰期 30 天；ts 缺失时退化为 0.96^i 兜底，保证老链路不变。
function computeFieldWeights(names, table, useTag, now) {
  const pairs = W._pairify(names);
  const decayFn = W.makeTimeDecayFn(now);
  const raw = {};
  const rawCnt = {};
  const rawSamples = {};
  pairs.forEach((p, i) => {
    const dec = decayFn(i, pairs.length, p);
    matchLabels(p.name, table, useTag).forEach(l => {
      raw[l.label] = (raw[l.label] || 0) + dec;
      rawCnt[l.label] = (rawCnt[l.label] || 0) + 1;
      if (!rawSamples[l.label]) rawSamples[l.label] = [];
      // samples 收集命中的食材关键词（如"豆腐""茄子"），去重保序
      if (rawSamples[l.label].indexOf(l.kw) < 0) rawSamples[l.label].push(l.kw);
    });
  });
  const max = Math.max(1, ...Object.values(raw));
  const list = Object.keys(raw).map(l => {
    const score = raw[l];
    const cnt = rawCnt[l] || 0;
    // 归一化到 0~100 的展示进度条（相对该用户自身最大值，避免绝对量误导）
    const pct = Math.round((score / max) * 100);
    // 2026-08-06 优化#5：取消「cnt<3 整体降一档」的硬降档，与出文侧 computePrefWeights 对齐
    // （出文侧改用对数折扣 wRaw*cnt/(cnt+3)）。画像侧仅保留 lowSample 标记作为前端「数据较少，仅供参考」
    // 角标，不再修改 level——保证两端归一化逻辑完全一致，杜绝「推荐说爱 A、画像说爱 B」的口径漂移。
    let level = pct >= 70 ? '强' : (pct >= 45 ? '中' : '弱');
    let lvClass = pct >= 70 ? 'strong' : (pct >= 45 ? 'mid' : 'weak');
    const lowSample = cnt < 3;
    return { label: l, score: Math.round(score * 10) / 10, level, lvClass, pct, cnt, lowSample, samples: (rawSamples[l] || []).slice(0, 3) };
  });
  list.sort((a, b) => b.score - a.score);
  return list;
}

// 漂移方向：历史命中但该维度 prefs 未勾选的标签
// #9 修复：原仅 ">=2 次" 易误触发（如 40 道里 2 道含鱼即判漂移）。现加【占比】双条件：
//   原始次数 >=3 且 占比 > 15%，避免极低占比的偶发方向被当成"常吃但未勾选"。
// 2026-08-06 #3 增强：改用「近段 vs 早段」差值法——仅全量占比会把"三个月前爱吃、现在不吃了"
//   的方向误判为漂移。现要求：近段(≤30天)占比 - 早段占比 > 0.1 且 近段原始次数 >=3，才算上升漂移。
function computeDrift(names, table, selSet, now) {
  const pairs = W._pairify(names);
  const { recent, earlier } = W.splitByRecency(pairs, now, 30);
  const cntR = {}, cntE = {};
  recent.forEach(p => matchLabels(p.name, table, true).forEach(l => { if (!selSet || !selSet.has(l.label)) cntR[l.label] = (cntR[l.label] || 0) + 1; }));
  earlier.forEach(p => matchLabels(p.name, table, true).forEach(l => { if (!selSet || !selSet.has(l.label)) cntE[l.label] = (cntE[l.label] || 0) + 1; }));
  const totR = recent.length || 1, totE = earlier.length || 1;
  const out = {};
  Object.keys(cntR).forEach(k => {
    const r = cntR[k] / totR, e = (cntE[k] || 0) / totE;
    if (cntR[k] >= 3 && r > 0.15 && (r - e) > 0.1) out[k] = cntR[k];
  });
  return Object.keys(out).sort((a, b) => out[b] - out[a]).slice(0, 3);
}

// 降档方向：softDislike（偶发差评）命中的标签。
// 2026-08-06 优化#2：输入 disks 已是「带时间衰减权重」的 {label:w}（由 extractDislikeTimed 产出），
// 这里只做阈值过滤与排序；衰减口径与出文侧一致。
function computeDown(disks) {
  const cnt = {};
  Object.keys(disks || {}).forEach(k => {
    const w = disks[k];
    if (w >= 1) cnt[k] = w; // 衰减后权重≥1 才计入（旧差评自然归零）
  });
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 3);
}

// 一句话总结（从你点过的菜出发，列举食材而非菜名，口语化；三维度共享标签池需去重防矛盾）
function buildSummary(meatW, vegW, hotW, warmW, porridgeW, roastW, coldW, stapleW, drift, down, meatWRecent, meatWEarlier, vegWRecent, vegWEarlier, sampleLen, names, baseline) {
  // 人格标题：根据各维度强度（level/score）细化推断一个好懂且有辨识度的标签
  // 取某 label 的维度对象，便于判断强弱
  const dim = (arr, label) => arr.find(x => x.label === label);
  const lvl = (arr, label) => { const d = dim(arr, label); return d ? d.level : '无'; };

  const cPork = dim(meatW, '猪肉');
  const cBeef = lvl(meatW, '牛肉') === '强' || lvl(meatW, '羊肉') === '强';
  const cPoultry = lvl(meatW, '鸡肉') !== '弱' || lvl(meatW, '鸭肉') !== '弱';
  const cSeafood = lvl(meatW, '鱼虾海鲜') !== '弱';
  const cEgg = lvl(meatW, '蛋类') !== '弱';
  const cVegMeat = lvl(meatW, '素菜/豆制品') !== '弱';   // 豆制品/薯类维度
  const cVegPure = vegW.length ? vegW[0].level !== '弱' : false;  // 纯蔬菜维度
  const anyMeat = cPork || cBeef || cPoultry || cSeafood || cEgg;
  const vegStrong = cVegPure && (lvl(vegW, '蔬菜') === '强');

  // 口味/做法后缀：基于正交维度强度，作为人格修饰
  const hotLvl = lvl(hotW, '辣味');
  const warmLvl = lvl(warmW, '暖食汤品');
  const roastLvl = lvl(roastW, '烧烤炸物');
  const coldLvl = lvl(coldW, '凉拌生鲜');
  const suffix = [];
  if (hotLvl === '强') suffix.push('无辣不欢');
  else if (hotLvl === '中') suffix.push('微辣党');
  if (warmLvl === '强') suffix.push('爱喝汤粥');
  else if (warmLvl === '中') suffix.push('暖食派');
  if (roastLvl === '强') suffix.push('烧烤炸物控');
  else if (roastLvl === '中') suffix.push('偶尔重口');
  if (coldLvl === '强') suffix.push('爱凉拌生鲜');

  let base = '';
  if (!anyMeat && !cVegMeat && !cVegPure) {
    base = '随性探索家';
  } else if (cSeafood && !cPork && !cBeef && !cPoultry && !cEgg) {
    base = cVegPure ? '鲜味控·偶尔素' : '鲜味控';
  } else if (cSeafood && anyMeat) {
    base = '海陆双拼党';
  } else if (cBeef && !cVegPure) {
    base = '硬核肉食派';
  } else if (cBeef && cVegPure) {
    base = '硬核肉食·也啃草';
  } else if (cPork && vegStrong) {
    base = '下饭家常派';
  } else if (cPork && cVegMeat && !cVegPure) {
    base = '豆制品爱好者';
  } else if (cPoultry && cVegPure) {
    base = '清淡养生派';
  } else if (cPoultry && !cVegPure) {
    base = '禽肉轻食派';
  } else if (cEgg && !cPork && !cBeef && !cSeafood && !cPoultry) {
    base = '蛋料理爱好者';
  } else if (!anyMeat && (cVegPure || cVegMeat)) {
    base = vegStrong ? '清爽素食派' : '清爽素心型';
  } else if (anyMeat && !cVegPure && !cVegMeat) {
    base = '无肉不欢型';
  } else {
    base = '家常百搭型';
  }

  // 维度短名映射（用于状态词口语化）
  const SHORT = { '猪肉': '猪肉', '牛肉': '牛肉', '羊肉': '羊肉', '鸡肉': '鸡肉', '鸭肉': '鸭肉', '鱼虾海鲜': '海鲜', '蛋类': '蛋', '素菜/豆制品': '豆制品', '蔬菜': '蔬菜' };
  const MEAT_LABELS = ['猪肉', '牛肉', '羊肉', '鸡肉', '鸭肉', '鱼虾海鲜', '蛋类'];
  const isStrong = (arr, label) => lvl(arr, label) === '强';
  const anyMeatStrong = (arr) => MEAT_LABELS.some(l => isStrong(arr, l));
  const anyVegStrong = (arr) => isStrong(arr, '蔬菜') || isStrong(arr, '素菜/豆制品');

  // 动态词：B 转型感优先；其次 A 探索/踩雷。同一时刻只取一条，避免太长
  let dynamic = '';
  if (sampleLen >= 20) {
    const rMeat = anyMeatStrong(meatWRecent), rVeg = anyVegStrong(vegWRecent);
    const eMeat = anyMeatStrong(meatWEarlier), eVeg = anyVegStrong(vegWEarlier);
    if (!eVeg && rVeg && !rMeat) dynamic = '新晋素心';
    else if (eVeg && !rVeg && rMeat) dynamic = '渐离素心';
    else if (!eMeat && rMeat && !rVeg) dynamic = '新晋肉欲';
    else if (eMeat && !rMeat && rVeg) dynamic = '渐离肉欲';
  }
  if (!dynamic && (drift || []).length) dynamic = '迷上' + (SHORT[drift[0]] || drift[0]);
  if (!dynamic && (down || []).length) dynamic = '有点腻' + (SHORT[down[0]] || down[0]);

  // 拼接：基础人格 + 口味后缀 + 动态词（三部分信息维度不同，最多各一段）
  const parts = [base];
  if (suffix.length) parts.push(suffix.join('·'));
  if (dynamic) parts.push(dynamic);
  const persona = parts.join('·');

  // personaTags：把「口味人格」按正交维度劈成可独立阅读的结构化短词（前端词云按 dim 分色，不再猜拆）。
  // 维度来源：① 基础人格(core，可能含·，如「鲜味控·偶尔素」)；② 口味做法四维(flavor：辣/汤粥/烧烤/凉拌，与食材正交，非食材)；
  // ③ 动态词(trend：转型/探索/腻)。刻意排除 drift/down（它们是肉类食材标签，属食材维度，前端不要）。
  // flavor 按强度分 4 级，配有人温度/人格感的口语词（参考：L1 浅喜 / L2 中意 / L3 深爱 / L4 极致如「无辣不欢」），
  // 用 pct（相对用户自身最大值归一化）细分，弱档(<45)不显示，避免无偏好也硬塞标签。
  const FLAVOR_WORDS = {
    '辣味':     { 4: '无辣不欢',   3: '挺能吃辣',   2: '中辣刚好', 1: '微辣也行' },
    '烧烤炸物': { 4: '热爱烧烤',   3: '挺爱吃烤',   2: '爱点烧烤', 1: '有烤串就吃' },
    '凉拌生鲜': { 4: '爱吃凉拌',   3: '挺爱凉拌',   2: '常点凉拌', 1: '凉拌能来两口' },
    '暖食汤品': { 4: '爱喝热汤',   3: '挺爱喝汤',   2: '常点汤品', 1: '有汤就顺一口' },
    '粥品':     { 4: '爱喝粥',     3: '挺爱喝粥',   2: '常点粥',  1: '有粥就喝一碗' },
    '猪肉':     { 4: '无肉不欢',   3: '挺爱吃肉',   2: '爱加个肉菜', 1: '有肉就吃' },
    '牛肉':     { 4: '无肉不欢',   3: '挺爱吃肉',   2: '爱加个肉菜', 1: '有肉就吃' },
    '羊肉':     { 4: '无肉不欢',   3: '挺爱吃肉',   2: '爱加个肉菜', 1: '有肉就吃' },
    '鸡肉':     { 4: '无肉不欢',   3: '挺爱吃肉',   2: '爱加个肉菜', 1: '有肉就吃' },
    '鸭肉':     { 4: '无肉不欢',   3: '挺爱吃肉',   2: '爱加个肉菜', 1: '有肉就吃' },
    '鱼虾海鲜': { 4: '无肉不欢',   3: '挺爱吃肉',   2: '爱加个肉菜', 1: '有肉就吃' },
    '蛋类':     { 4: '无肉不欢',   3: '挺爱吃肉',   2: '爱加个肉菜', 1: '有肉就吃' },
    '素菜/豆制品': { 4: '爱吃蔬菜', 3: '挺爱青菜', 2: '爱加个青菜', 1: '有菜就夹一筷' },
    '蔬菜':     { 4: '爱吃蔬菜',   3: '挺爱青菜',   2: '爱加个青菜', 1: '有菜就夹一筷' },
    '米面粥燕麦': { 4: '离不开米饭', 3: '挺爱吃饭', 2: '常点米饭', 1: '偶尔扒两口饭' },
    '面食粉类':   { 4: '离不开面食', 3: '挺爱吃面', 2: '常点面食', 1: '偶尔来碗面' },
    '面包西式':   { 4: '爱吃面包',   3: '挺爱面包', 2: '常点面包', 1: '偶尔啃片面包' }
  };
  const personaTags = [];
  const tset = new Set();
  const tadd = (s, dim) => { s = (s || '').trim(); if (s && !tset.has(s)) { tset.add(s); personaTags.push({ text: s, dim }); } };
  // ① 基础人格（内部含·的复合段也拆开，保持可读）
  base.split('·').forEach(t => tadd(t, 'core'));
  // ② 口味做法 + 食材维度（computeFieldWeights 已按 score 降序，取首位标签）
  //    维度组：辣味/烧烤/凉拌/汤品/粥品（做法，flavor 暖橙）；猪肉/牛肉/.../蔬菜（食材，ingredient 绿）
  // 维度判定（2026-08-07 重构·方案 A）：彻底去掉方案 A（abs 门槛 + TopN 排位封顶），只跑纯 TGI。
  // 维度是否显示纯看 TGI=absUser/大盘abs 是否 ≥ tgiShow；档位按 TGI 映射。
  // 大盘不可信（样本<MIN_BASELINE_N）时无 TGI 可依，persona 词全部不显示（锁定态由 exports.main 统一处理）。
  const MIN_BASELINE_N = 500;                    // 大盘样本门槛（与解锁条件一致；提至置信水位，保准确）
  const baselineN = (baseline && baseline.totalRecords) || 0;
  const baselineUsable = !!(baseline && baseline.abs && baselineN >= MIN_BASELINE_N);
  const tgiShow = 1.15;                          // 显示门槛：占比比普通人高 15% 以上才算"突出"
  const total = Math.max(1, sampleLen);
  // ① 收集候选（仅收集有 TGI 的维度；大盘不可信则无候选）
  const cands = [];
  if (baselineUsable) {
    [['hotW', hotW], ['warmW', warmW], ['porridgeW', porridgeW], ['roastW', roastW], ['coldW', coldW], ['meatW', meatW], ['vegW', vegW], ['stapleW', stapleW]].forEach(([key, arr]) => {
      if (!arr || !arr.length) return;
      const top = arr[0];
      if (!FLAVOR_WORDS[top.label]) return;
      const def = DIM_DEFS[key];
      const absUser = dimHitCount(names, def.table, def.useTag) / total;
      const baseAbs = baseline.abs[key];
      if (typeof baseAbs !== 'number' || baseAbs <= 0) return;
      const tgi = absUser / baseAbs;
      cands.push({ key, label: top.label, absUser, tgi, type: FLAVOR_DIM_KEYS.has(key) ? 'flavor' : 'ingredient' });
    });
  }
  // ② 纯 TGI 判定：tgi<tgiShow 不显示；否则按 TGI 映射档位（不依赖自身 abs 排位）
  cands.forEach(c => {
    let lvl = 0;
    if (c.tgi >= tgiShow) {
      if (c.tgi >= 2.5) lvl = 4;
      else if (c.tgi >= 1.8) lvl = 3;
      else if (c.tgi >= 1.4) lvl = 2;
      else lvl = 1;
    }
    c._lvl = lvl;
  });
  // ③ 总词数软上限：最多显示 MAX_TAGS(=6) 个词，超出时按 TGI 从低到高剔除 L1，保留更突出的。
  const MAX_TAGS = 6;
  if (cands.filter(c => c._lvl > 0).length > MAX_TAGS) {
    const asc = cands.filter(c => c._lvl === 1).sort((a, b) => a.tgi - b.tgi);
    for (const c of asc) { if (cands.filter(x => x._lvl > 0).length <= MAX_TAGS) break; c._lvl = 0; }
  }
  cands.forEach(c => {
    if (c._lvl > 0) tadd(FLAVOR_WORDS[c.label][c._lvl], c.type);
  });
  // ③ 动态词（迷上X / 有点腻X / 新晋素心 等，已是完整可读短词）
  if (dynamic) tadd(dynamic, 'trend');

  console.log(`[getWeightOverview][tgi] baselineUsable=${baselineUsable} baselineN=${baselineN} tgiShow=${tgiShow} sampleLen=${sampleLen} tags=${(personaTags || []).map(t => t.text).join('|')}`);
  return { persona, personaTags };
}

exports.main = async (event) => {
  console.log('[build] getWeightOverview BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const ctx = cloud.getWXContext();
  const OPENID = ctx.OPENID;
  // 2026-08-17 诊断：mine 页冷启动首次进页时偶发 401（OPENID 未就绪）。
  // 打全上下文以定位根因——到底是 OPENID 字段名变了、还是整个 ctx 为空、还是 appid/env 异常。
  if (!OPENID) {
    console.warn('[getWeightOverview][401-diag] OPENID 未就绪 ctx=', JSON.stringify({
      hasCtx: !!ctx,
      keys: ctx ? Object.keys(ctx) : [],
      OPENID: ctx && ctx.OPENID,
      APPID: ctx && ctx.APPID,
      ENV: ctx && ctx.ENV,
      FROM_OPENID: ctx && ctx.FROM_OPENID,
      UNIONID: ctx && ctx.UNIONID
    }), 'event=', JSON.stringify(event || {}));
    return { code: 401, msg: '未登录' };
  }

  const windowDays = Math.min(90, Math.max(14, parseInt(event && event.days, 10) || 60));
  const since = sinceDate(windowDays);

  // 并行取历史 + 偏好 + 冰箱/周表/剩菜(gen_records)
  let records = [];
  let prefs = null;
  let genRecords = [];
  try {
    const [histRes, prefRes, genRes] = await Promise.all([
      db.collection('recommend_history').where({ _openid: OPENID, timestamp: _.gte(since) }).limit(1000).get(),
      db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get(),
      // 与主算法 getRecommendation 同源：读近 50 条 gen_records（冰箱/周表/剩菜的实际选择）
      db.collection('gen_records').where({ _openid: OPENID }).orderBy('createdAt', 'desc').limit(50).get().catch(() => ({ data: [] }))
    ]);
    records = (histRes && histRes.data) || [];
    prefs = (prefRes && prefRes.data && prefRes.data[0]) || null;
    genRecords = (genRes && genRes.data) || [];
  } catch (e) {
    return { code: 200, data: { empty: true, reason: 'load_fail' } };
  }

  // 收集近 40 道「就它了」的菜名（带选中时间 ts，供真实间隔衰减）
  const pairs = [];
  records.forEach(r => {
    const sel = r.selected;
    if (Array.isArray(sel) && sel.length) {
      sel.forEach(it => { const n = it && it.name; if (n && typeof n === 'string') pairs.push({ name: n, ts: (r.timestamp || r.createdAt || 0) }); });
    }
  });
  // 2026-08-06：把冰箱/周表/剩菜(gen_records)的实际选择也并进取像，让「算法眼里的你」
  // 反映用户在冰箱反推、一周菜单、剩菜改造里的真实偏好（此前只认 recommend_history）。
  // items 两种形态：① 冰箱/剩菜 = [{name}] 或 [{dishes:[{name}]}]；② 一周菜单 = {days:[{dishes:[{name}]}]}。
  // 非字符串兜底（修复 AG 口径）：数字/异常 name 统一过滤，避免脏数据绕过去重与时间衰减。
  let genRecordCount = 0;
  genRecords.forEach(d => {
    const items = d && d.items;
    let names = [];
    if (Array.isArray(items)) {
      items.forEach(it => {
        if (it && it.name != null) names.push(String(it.name));
        if (it && Array.isArray(it.dishes)) it.dishes.forEach(x => { if (x && x.name != null) names.push(String(x.name)); });
      });
    } else if (items && Array.isArray(items.days)) {
      items.days.forEach(day => { if (day && Array.isArray(day.dishes)) day.dishes.forEach(x => { if (x && x.name != null) names.push(String(x.name)); }); });
    }
    names = Array.from(new Set(names.filter(n => typeof n === 'string' && n)));
    if (names.length) genRecordCount++;
    const ts = (d.createdAt instanceof Date) ? d.createdAt.getTime() : (typeof d.createdAt === 'number' ? d.createdAt : 0);
    names.forEach(n => pairs.push({ name: n, ts }));
  });
  // 带真实时间戳降序后取近 40 道（与主算法口径一致：旧记录不误判为最新选择）
  pairs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const sample = pairs.slice(0, 40);
  const now = Date.now();

  if (!sample.length) {
    // #7 冷启动：新用户无历史时，用当前季节基线做弱先验，避免纯靠混元默认。
    // 2026-08-07：冷启动即 selfCount=0，命中锁定态（自身未达标），统一走 locked 进度 UI。
    const baseline = W.coldStartBaseline(currentSeason());
    const meatW = Object.keys(baseline).map(l => ({ label: l, score: baseline[l], level: '弱', lvClass: 'weak', pct: Math.round(baseline[l]), cnt: 0, lowSample: true, samples: [] }));
    return {
      code: 200,
      data: {
        empty: true,
        coldStart: true,
        locked: true,
        days: windowDays,
        selfCount: 0,
        selfNeed: 20,
        selfThreshold: 20,
        baselineN: 0,
        baselineNeed: 150,
        baselineThreshold: 150,
        decidedCount: 0,
        genRecordCount: 0,
        personaSources: { decided: 0, genRecords: 0 },
        meat: meatW,
        veg: [],
        drift: [],
        down: [],
        prefMeatSet: Array.from(new Set((prefs && Array.isArray(prefs.meat) ? prefs.meat : []))),
        prefVegSet: Array.from(new Set((prefs && Array.isArray(prefs.veg) ? prefs.veg : []))),
        meatSelNotSeen: (prefs && Array.isArray(prefs.meat) ? prefs.meat : []).slice(0, 6),
        persona: '',
        personaTags: [],
        generatedAt: now
      }
    };
  }

  const prefMeat = new Set((prefs && Array.isArray(prefs.meat) ? prefs.meat : []));
  const prefVeg = new Set((prefs && Array.isArray(prefs.veg) ? prefs.veg : []));
  // 2026-08-06 优化#2：差评(softDislike)改走时间衰减（半衰期15天），与出文侧口径一致，
  // 避免画像侧把"三个月前偶发差评"永久展示为降档方向。extractDislikeTimed 兼容旧纯字符串数组。
  const softDislikeProbe = DRIFT_MEAT.map(m => m.kw);
  const softDislikeTimed = W.extractDislikeTimed(prefs, softDislikeProbe, 'meat', DISH_TAGS, now, 15);

  const meatW = computeFieldWeights(sample, DRIFT_MEAT, true, now);
  const vegW = computeFieldWeights(sample, [{ kw: VEG_PURE, label: '蔬菜' }], true, now);
  const hotW = computeFieldWeights(sample, FLAVOR_HOT, false, now);
  const warmW = computeFieldWeights(sample, FLAVOR_WARM, false, now);
  const porridgeW = computeFieldWeights(sample, FLAVOR_PORRIDGE, false, now);
  const stapleW = computeFieldWeights(sample, STAPLE_TYPE, false, now);
  const roastW = computeFieldWeights(sample, FLAVOR_ROAST, false, now);
  const coldW = computeFieldWeights(sample, FLAVOR_COLD, false, now);
  const drift = computeDrift(sample, DRIFT_MEAT, prefMeat, now);
  const down = computeDown(softDislikeTimed);
  // 近段（头部 20 道，最近）/ 中段（其后 20 道），用于转型感 B
  const recent = sample.slice(0, 20);
  const earlier = sample.slice(20);
  const meatWRecent = computeFieldWeights(recent, DRIFT_MEAT, true, now);
  const meatWEarlier = computeFieldWeights(earlier, DRIFT_MEAT, true, now);
  const vegWRecent = computeFieldWeights(recent, [{ kw: VEG_PURE, label: '蔬菜' }], true, now);
  const vegWEarlier = computeFieldWeights(earlier, [{ kw: VEG_PURE, label: '蔬菜' }], true, now);
  // 读取大盘 baseline（computeBaseline 后台全量统计产出），TGI 判定与解锁条件使用；缺失不阻断。
  let personaBaseline = null;
  try {
    const bres = await db.collection('persona_baseline').doc('global').get();
    personaBaseline = (bres && bres.data) || null;
  } catch (e) { personaBaseline = null; }

  // 2026-08-07 锁定机制（方案 A）：解锁需「自身样本达标 且 大盘样本达标」两者都要。
  // 未解锁时返回 locked + 进度缺口，前端显示进度条+提示，不展示任何 persona 词（纯 TGI 无退路）。
  const SELF_UNLOCK_N = 50;                        // 自身「就它了」+gen_records 样本解锁阈值（提至置信水位，保准确）
  const BASELINE_UNLOCK_N = 500;                   // 大盘样本解锁阈值（与 buildSummary 的 MIN_BASELINE_N 一致）
  const selfCount = sample.length;
  const baselineN = (personaBaseline && personaBaseline.totalRecords) || 0;
  const selfNeed = Math.max(0, SELF_UNLOCK_N - selfCount);
  const baselineNeed = Math.max(0, BASELINE_UNLOCK_N - baselineN);
  const unlocked = selfNeed === 0 && baselineNeed === 0;

  if (!unlocked) {
    return {
      code: 200,
      data: {
        empty: false,
        locked: true,
        days: windowDays,
        selfCount,
        selfNeed,
        selfThreshold: SELF_UNLOCK_N,
        baselineN,
        baselineNeed,
        baselineThreshold: BASELINE_UNLOCK_N,
        decidedCount: records.filter(r => Array.isArray(r.selected) && r.selected.length).length,
        genRecordCount,
        personaSources: { decided: records.filter(r => Array.isArray(r.selected) && r.selected.length).length, genRecords: genRecordCount },
        meat: meatW,
        veg: vegW,
        drift,
        down,
        prefMeatSet: Array.from(prefMeat),
        prefVegSet: Array.from(prefVeg),
        meatSelNotSeen: Array.from(prefMeat).filter(x => !meatW.some(w => w.label === x)).slice(0, 6),
        persona: '',
        personaTags: [],
        generatedAt: Date.now()
      }
    };
  }

  const built = buildSummary(meatW, vegW, hotW, warmW, porridgeW, roastW, coldW, stapleW, drift, down, meatWRecent, meatWEarlier, vegWRecent, vegWEarlier, sample.length, sample, personaBaseline);

  // 偏好页已勾选但未在历史高频出现的，也标记出来（说明是「设置但还没验证」）
  const meatSelShown = Array.from(prefMeat).filter(x => !meatW.some(w => w.label === x)).slice(0, 6);

  return {
    code: 200,
    data: {
      empty: false,
      days: windowDays,
      decidedCount: records.filter(r => Array.isArray(r.selected) && r.selected.length).length,
      genRecordCount,          // 冰箱/周表/剩菜(gen_records)纳入画像的信号来源条数（2026-08-06 新增）
      personaSources: { decided: records.filter(r => Array.isArray(r.selected) && r.selected.length).length, genRecords: genRecordCount },
      meat: meatW,                 // [{label,score,level,pct}]
      veg: vegW,                   // [{label,score,level,pct}]
      drift,                      // [label,...] 探索方向
      down,                       // [label,...] 降档方向
      prefMeatSet: Array.from(prefMeat),
      prefVegSet: Array.from(prefVeg),
      meatSelNotSeen: meatSelShown,
      persona: built.persona,
      personaTags: built.personaTags,   // 按正交维度劈好的可读短词（前端词云用）
      generatedAt: Date.now()
    }
  };
};
