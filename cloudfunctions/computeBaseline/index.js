const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const W = require('./sync_weights');
const { DRIFT_MEAT, matchKeyword } = W;

// 全量画像 baseline 统计（方案 B：TGI 第二关数据来源）
// 扫全量 recommend_history + gen_records，按 8 个画像维度统计「大盘平均绝对占比」abs，
// 写入 persona_baseline._id='global'。getWeightOverview 读取此 baseline 计算 TGI。
// 触发方式：手动 invoke（也可接定时器周期跑）。数据量大时分页（limit 1000）。
// 维度表（与 getWeightOverview 完全同源，避免口径漂移）
const DISH_TAGS = (require('./dishes.json').tags) || {};
const VEG_PURE = ['上海青', '小白菜', '菠菜', '油麦菜', '空心菜', '芥蓝', '苋菜', '生菜', '西兰花', '韭菜', '芹菜', '莴笋', '黄瓜', '番茄', '西红柿', '茄子', '胡萝卜', '白萝卜', '萝卜', '冬瓜', '南瓜', '洋葱', '青椒', '彩椒', '白菜', '蒜薹', '蒜苗', '菜心', '包菜', '卷心菜', '豇豆', '四季豆', '黄花菜', '芥菜', '雪里蕻', '大白菜', '娃娃菜'];
const FLAVOR_HOT = [{ kw: ['辣', '麻', '川', '湘', '渝', '黔', '赣', '火锅', '麻辣', '爆辣', '微辣', '泡椒', '剁椒', '干锅', '麻辣烫', '酸辣', '辣子', '花椒', '藤椒'], label: '辣味' }];
const FLAVOR_WARM = [{ kw: ['汤', '煲', '炖', '砂锅', '羹', '糊', '锅', '焖', '烩'], label: '暖食汤品' }];
const FLAVOR_PORRIDGE = [{ kw: ['粥'], label: '粥品' }];
const FLAVOR_ROAST = [{ kw: ['烤', '炸', '煎', '铁板', '孜然', '炭', '串', '油'], label: '烧烤炸物' }];
const FLAVOR_COLD = [{ kw: ['凉拌', '沙拉', '刺身', '生', '冷', '冰', '渍'], label: '凉拌生鲜' }];
const STAPLE_TYPE = [
  { kw: ['饭', '丼', '粥', '燕麦', '玉米', '汤圆', '糍粑', '年糕', '马拉糕', '杂粮蒸糕', '一只鸡蛋糕'], label: '米面粥燕麦' },
  { kw: ['面', '粉', '饼', '饺', '馄饨', '包子', '烧卖', '馒头', '馍', '河粉', '凉皮', '盒子', '面卷', '粗卷', '卷饼'], label: '面食粉类' },
  { kw: ['面包', '吐司', '三明治', '披萨', '蛋糕', '薯条', '薯饼'], label: '面包西式' }
];
// DIM_DEFS 键与 getWeightOverview 对齐
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

function matchLabels(name, table, useTag) {
  const s = String(name);
  const hit = [];
  const seen = new Set();
  table.forEach(m => {
    if (seen.has(m.label)) return;
    let k = null;
    if (useTag) {
      const ok = m.kw.some(kk => matchKeyword(s, kk, DISH_TAGS));
      if (ok) k = m.kw.find(kk => matchKeyword(s, kk, DISH_TAGS));
    } else {
      k = m.kw.find(kk => s.indexOf(kk) >= 0);
    }
    if (k) { hit.push({ label: m.label, kw: k }); seen.add(m.label); }
  });
  return hit;
}

// 提取一条记录里的所有菜名（与 getWeightOverview 同源：recommend_history.selected / gen_records.items 两形态）
function extractNames(doc) {
  const out = [];
  if (doc && Array.isArray(doc.selected) && doc.selected.length) {
    doc.selected.forEach(it => { const n = it && it.name; if (n && typeof n === 'string') out.push(n); });
  }
  const items = doc && doc.items;
  if (Array.isArray(items)) {
    items.forEach(it => {
      if (it && it.name != null) out.push(String(it.name));
      if (it && Array.isArray(it.dishes)) it.dishes.forEach(x => { if (x && x.name != null) out.push(String(x.name)); });
    });
  } else if (items && Array.isArray(items.days)) {
    items.days.forEach(day => { if (day && Array.isArray(day.dishes)) day.dishes.forEach(x => { if (x && x.name != null) out.push(String(x.name)); }); });
  }
  return out.filter(n => typeof n === 'string' && n);
}

async function scanAll(collection, acc) {
  let skip = 0;
  const BATCH = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await db.collection(collection).limit(BATCH).skip(skip).get();
    const list = (res && res.data) || [];
    if (!list.length) break;
    list.forEach(d => {
      const names = extractNames(d);
      if (!names.length) return;
      acc.total += names.length;
      // 每条记录：对其每个菜名判维度命中（记录级去重——一道菜同维度只算一次）
      const perRecord = {};
      Object.keys(DIM_DEFS).forEach(key => {
        perRecord[key] = new Set();
        names.forEach(n => {
          if (matchLabels(n, DIM_DEFS[key].table, DIM_DEFS[key].useTag).length) perRecord[key].add(n);
        });
      });
      Object.keys(DIM_DEFS).forEach(key => { acc.hit[key] += perRecord[key].size; });
    });
    if (list.length < BATCH) break;
    skip += BATCH;
  }
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] computeBaseline BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] computeBaseline BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const acc = { total: 0, hit: {} };
  Object.keys(DIM_DEFS).forEach(k => acc.hit[k] = 0);
  await scanAll('recommend_history', acc);
  await scanAll('gen_records', acc);

  const abs = {};
  Object.keys(DIM_DEFS).forEach(k => { abs[k] = acc.total ? acc.hit[k] / acc.total : 0; });

  const docData = {
    _id: 'global',
    abs,
    totalRecords: acc.total,
    computedAt: Date.now()
  };
  try {
    // upsert：先查再 insert/update（wx-server-sdk 无原生 upsert）
    await db.collection('persona_baseline').doc('global').get();
    await db.collection('persona_baseline').doc('global').update({ data: { abs, totalRecords: acc.total, computedAt: Date.now() } });
  } catch (e) {
    await db.collection('persona_baseline').add({ data: docData });
  }

  return { code: 200, totalRecords: acc.total, abs, msg: 'baseline computed' };
};
