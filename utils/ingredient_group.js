// ingredient_group.js —— 做法弹层食材清单展示分组（阶段3：清单分组展示）
// 数据源 utils/seasoning_library.js（与云端 seasoning_library 集合同源，勿单改）
// 规则：命中白名单 name/alias 且「非 dual、非 酱类（复合酱料）」→ 调料组（不显量、顿号平铺）；
//       其余一律进食材组（保留原串即带量）。宁少勿错：可作主料的 dual（虾皮/芝麻/花生/椰浆…）
//       与复合酱料（豆瓣酱/甜面酱/沙茶酱…）不隐藏用量；姜/蒜/葱/香菜等小料本就不在白名单，留在食材组。
// 用法：decorateGuide(guide) 返回新对象（不改原字段），新增 ingMain=主料带量数组 / seasonLine=调料顿号平铺串。
const { SEASONING_LIBRARY } = require('./seasoning_library');

// name/alias → 元信息（含 canonical 标准名 + dual/group 标志），供运行时精确判定
const SEASON_META = (() => {
  const m = new Map();
  for (const it of SEASONING_LIBRARY) {
    const meta = { std: it.name, dual: !!it.dual, group: it.group || '' };
    m.set(it.name, meta);
    for (const a of (it.alias || [])) if (!m.has(a)) m.set(a, meta);
  }
  return m;
})();

// 判定一条食材显示串是否属于「应隐藏用量的纯调料」。显示串形如「名 量 单位」或只有「名」，取首 token 作名称。
function isSeasoningStr(ing) {
  const s = String(ing || '').trim();
  if (!s) return false;
  const first = s.split(/\s+/)[0];
  const meta = SEASON_META.get(first);
  return !!(meta && !meta.dual && meta.group !== '酱类');
}

// 展示装饰：主料保留原串（带量逐行），调料收敛为标准名（去量、顿号平铺成一行）。
// 幂等、不改入参原字段；guide 缺 ingredients（加载态/防御）时安全返回空分组。
function decorateGuide(g) {
  const src = g || {};
  const list = Array.isArray(src.ingredients) ? src.ingredients : [];
  const mains = [];
  const seasons = [];
  list.forEach(ing => {
    if (typeof ing !== 'string' || !String(ing).trim()) { mains.push(ing); return; }
    const first = String(ing).trim().split(/\s+/)[0];
    const meta = SEASON_META.get(first);
    if (meta && !meta.dual && meta.group !== '酱类') seasons.push(meta.std);
    else mains.push(ing);
  });
  return Object.assign({}, src, { ingMain: mains, seasonLine: seasons.join('、') });
}

module.exports = { decorateGuide, isSeasoningStr, SEASON_META };
