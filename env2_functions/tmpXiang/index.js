const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 临时删除/查询工具：按精确菜名删除或列出多集合中的条目。
// 用法：
//   { mode:'list',  term:'湘辣腊肉炒饭', collections?:[...] }            -> 列出命中
//   { mode:'deleteFrom', collections:'dish_mirror', term:'湘辣腊肉炒饭' }  -> 删除单集合命中
// 默认扫描集合：dish_mirror / dish_lexicon / dish_lexicon_pending / rejected_names
exports.main = async (event) => {
  const { mode, term = '湘辣腊肉炒饭', collections } = event || {};
  const cols = collections || ['dish_mirror', 'dish_lexicon', 'dish_lexicon_pending', 'rejected_names'];
  if (mode === 'list') {
    const out = {};
    for (const c of cols) {
      const r = await db.collection(c).where({ name: term }).limit(100).get();
      const b = (r && r.data) || [];
      out[c] = b.map(d => ({ _id: d._id, name: d.name, source: d.source || '' }));
    }
    return { ok: true, term, out };
  }
  if (mode === 'deleteFrom') {
    const c = collections;
    const r = await db.collection(c).where({ name: term }).limit(100).get();
    const b = (r && r.data) || [];
    const ids = b.map(d => d._id);
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      if (!chunk.length) break;
      const res = await db.collection(c).where({ _id: _.in(chunk) }).remove();
      deleted += (res && res.stats && res.stats.removed) || 0;
    }
    return { ok: true, collection: c, term, requested: ids.length, deleted };
  }
  if (mode === 'deleteName') {
    // 多集合批量删除同名条目（供 env1 审核页驳回时联动删除 env2 真库）
    const cols = collections || ['dish_mirror', 'dish_lexicon', 'dish_lexicon_pending'];
    const summary = {};
    for (const c of cols) {
      const r = await db.collection(c).where({ name: term }).limit(100).get();
      const b = (r && r.data) || [];
      const ids = b.map(d => d._id);
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        if (!chunk.length) break;
        const res = await db.collection(c).where({ _id: _.in(chunk) }).remove();
        deleted += (res && res.stats && res.stats.removed) || 0;
      }
      summary[c] = { requested: ids.length, deleted };
    }
    const total = Object.values(summary).reduce((s, o) => s + o.deleted, 0);
    return { ok: true, term, total, summary };
  }
  if (mode === 'scanPrefix') {
    const c = collections || ['dish_mirror', 'dish_lexicon', 'dish_lexicon_pending', 'rejected_names'];
    const out = await doScanPrefix(c);
    const fuseTotal = Object.values(out.fuse).reduce((s, a) => s + a.length, 0);
    const prefixTotal = Object.values(out.prefix).reduce((s, a) => s + a.length, 0);
    return { ok: true, fuseTotal, prefixTotal, total: fuseTotal + prefixTotal, out };
  }
  if (mode === 'deletePrefix') {
    // 仅删除"融合错误"类（地域字+食材名词），保留合法菜系前缀（鲁式/湘菜等）
    const c = collections || ['dish_mirror', 'dish_lexicon', 'dish_lexicon_pending', 'rejected_names'];
    const summary = {};
    for (const col of c) {
      let deleted = 0;
      for (let off = 0; ; off += 100) {
        const r = await db.collection(col).skip(off).limit(100).get();
        const b = (r && r.data) || [];
        if (!b.length) break;
        const ids = b.filter(d => FUSE_RE.test(d.name || '')).map(d => d._id);
        for (let i = 0; i < ids.length; i += 100) {
          const chunk = ids.slice(i, i + 100);
          if (!chunk.length) break;
          const res = await db.collection(col).where({ _id: _.in(chunk) }).remove();
          deleted += (res && res.stats && res.stats.removed) || 0;
        }
        if (b.length < 100) break;
      }
      summary[col] = deleted;
    }
    const total = Object.values(summary).reduce((s, n) => s + n, 0);
    return { ok: true, total, summary };
  }
  return { ok: false, error: 'unknown mode' };
};

// 扫描模式：列出所有以地域/菜系字开头的菜名，并按两类分类
//  - fuse（融合错误）：地域字 + 食材名词，如 鲁葱/湘笋/鲁骨/湘辣 → 应删
//  - prefix（合法菜系前缀）：地域字 + 式/菜/味/系 + 菜名，如 鲁式酱焖鱼/粤式叉烧饭 → 保留
// 用法：{ mode:'scanPrefix', collections?:[...] }
const REGION_PREFIX = /^[鲁川粤湘苏浙闽徽黔滇秦京沪]/;
// 融合错误：地域字后紧跟食材名词，且地域字后 NOT 紧跟 式/菜/味/系/风味（后者是合法菜系前缀，如 鲁菜萝卜/湘菜剁椒）
const PREFIX_OK_RE = /^[鲁川粤湘苏浙闽徽黔滇秦京沪](式|菜|味|系|风味)/;
const FUSE_RE = /[鲁川粤湘苏浙闽徽黔滇秦京沪](?!式|菜|味|系|风味)(葱|蒜|姜|椒|茄|豆|瓜|菇|笋|萝卜|肉|鱼|鸡|鸭|牛|猪|羊|虾|蟹|面|饭|饼|粥|汤|蛋|豆腐|骨|辣)/;
async function doScanPrefix(cols) {
  const out = { fuse: {}, prefix: {} };
  for (const c of cols) {
    out.fuse[c] = []; out.prefix[c] = [];
    for (let off = 0; ; off += 200) {
      const r = await db.collection(c).field({ name: true, source: true }).skip(off).limit(200).get();
      const b = (r && r.data) || [];
      for (const d of b) {
        if (!REGION_PREFIX.test(d.name || '')) continue;
        const item = { name: d.name, source: d.source || '' };
        if (FUSE_RE.test(d.name)) out.fuse[c].push(item);
        else if (PREFIX_OK_RE.test(d.name)) out.prefix[c].push(item);
        else out.prefix[c].push(item); // 其他地域开头但非融合的，保守归为保留
      }
      if (b.length < 200) break;
    }
  }
  return out;
}

