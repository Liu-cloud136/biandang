// manageShopping —— 买菜清单（B1，2026-08-04）
// 独立集合 shopping_lists，每用户一条文档：{ _openid, items:[{group?, items?, text?, checked, from, ts}], updatedAt }
// 清单项两种形态：
//   分组项（来自历史导入）：{ group:'菜名', items:['食材1','食材2'], checked, from:'history', ts }
//   扁平项（手动添加）：    { text:'西红柿 2个', checked, from:'manual', ts }
// 动作：get / add / toggle / remove / clearAll / importFromHistory
// 鉴权：仅本人可操作自己的清单（_openid 强制来自云函数上下文，不可由前端伪造）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// —— 构建指纹（2026-08-08 推广）——
const BUILD_TAG = '2026-08-21.shopping-dishlib-ingredients';
console.log('[build] manageShopping BUILD_TAG=' + BUILD_TAG);

// AI 能力（与 getRecommendation 同源）：用于未命中本地菜谱库的菜，调用混元生成食材清单
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');

// 通用超时包裹（次要 AI 步，超时即回退，不阻塞主流程）
function withTimeout(p, ms, label) {
  let timer;
  const to = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error((label || 'op') + ' timeout ' + ms + 'ms')), ms); });
  return Promise.race([p, to]).finally(() => { if (timer) clearTimeout(timer); });
}
// 从模型返回取正文：兼容 {text} 与 OpenAI 兼容 {data.choices[0].message.content}
function pickText(resp) {
  if (resp && typeof resp.text === 'string' && resp.text.trim()) return resp.text;
  if (resp && resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message && typeof resp.data.choices[0].message.content === 'string') {
    return resp.data.choices[0].message.content;
  }
  return '';
}
// 未命中本地菜谱库的菜，批量调用 AI 生成食材清单。
// 入参 dishes:[菜名]，返回 { 菜名: [食材...] }（仅含成功解析的项）。失败/超时返回 {}（调用方回退菜名）。
async function aiIngredientsForDishes(dishes) {
  if (!Array.isArray(dishes) || !dishes.length) return {};
  const dishList = dishes.map((d, i) => ({ i, name: d }));
  const prompt = '你是厨房食材助手。下面是一组菜品名，请为每道菜列出【在家制作这道菜需要采购的主要食材】。\n'
    + '要求：\n'
    + '1. 只列「需要买的原材料/主料/关键配料」，不要列盐、糖、油、酱油、料酒等家家都有的基础调味料（除非该菜对某种调料有特殊要求）；\n'
    + '2. 每项写具体可购买的名称，【必须带合适的具体数量，不要写「适量」「少许」「若干」「一点」这类模糊词】——按 1~2 人份估算，如「鸡腿 2只」「西红柿 2个」「干辣椒 8根」「葱 1根」「生抽 1瓶（可选）」，控制在 14 字内；\n'
    + '3. 不要列步骤、不要列做法；\n'
    + '4. 若某道菜你确实无法判断，给一个空数组。\n'
    + '只输出 JSON，格式严格为：{"<菜名>":["食材1","食材2"], ...}\n'
    + '菜品列表：' + JSON.stringify(dishList.map(d => d.name));
  try {
    const resp = await withTimeout(textModel.generateText({ model: 'hy3', messages: [{ role: 'user', content: prompt }] }), 12000, 'aiIngredients');
    const txt = pickText(resp);
    if (!txt) return {};
    // 去 ``` 围栏 + 裁剪花括号 + 清尾逗号
    let s = txt.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    s = s.replace(/,(\s*[}\]])/g, '$1');
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {};
      for (const k of Object.keys(obj)) {
        const arr = obj[k];
        if (Array.isArray(arr)) out[k] = arr.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
      }
      return out;
    }
  } catch (e) {
    console.warn('[aiIngredientsForDishes] 失败，回退菜名: ' + (e && e.message));
  }
  return {};
}

const COLL = 'shopping_lists';

// 防注入：清单文本必须是非空字符串，截断到合理长度
function normText(t) {
  if (typeof t !== 'string') return '';
  const s = t.trim().slice(0, 60);
  return s;
}

// —— 菜名 → 食材采购清单映射（与 getRecommendation/cookbook_ref.json 同源，本地维护）——
// 用途：从决定导入买菜清单时，把所选「菜名」展开成做这道菜需要的「食材」，而非把菜名本身加进去。
const COOK_REF = require('./cookbook_ref.json');
// 菜名归一化（与 getRecommendation 同源）：番茄→西红柿、鸡蛋→蛋 等，让 AI 菜名变体能命中库
const SYNONYMS = [
  [/番茄/g, '西红柿'],
  [/蕃茄/g, '西红柿'],
  [/马铃薯/g, '土豆'],
  [/洋芋/g, '土豆'],
  [/柿子椒/g, '青椒'],
  [/红萝卜/g, '胡萝卜'],
  [/胡罗卜/g, '胡萝卜'],
  [/大葱/g, '葱'],
  [/小葱/g, '葱'],
  [/香葱/g, '葱'],
  [/虾仁/g, '虾'],
  [/鸡蛋/g, '蛋']
];
function normalizeDishName(name) {
  let n = String(name || '');
  n = n.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
  n = n.replace(/\s+/g, '');
  for (const [re, rep] of SYNONYMS) n = n.replace(re, rep);
  return n;
}
const COOK_REF_INDEX = (() => {
  const m = {};
  for (const k of Object.keys(COOK_REF)) {
    const nk = normalizeDishName(k);
    if (nk && !m[nk]) m[nk] = k;
  }
  return m;
})();
// 查表：先精确匹配，再走归一化回退；命中返回参考食材数组，未命中返回 null
function lookupCookRef(dish) {
  if (!dish) return null;
  if (COOK_REF[dish]) return COOK_REF[dish];
  const nk = normalizeDishName(dish);
  if (nk && COOK_REF_INDEX[nk]) return COOK_REF[COOK_REF_INDEX[nk]];
  return null;
}

// 查 dish_library 集合的 ingredients 字段（env2 新菜审核通过后入库的食材）
// 命中返回食材数组，未命中返回 null
async function lookupDishLibIngredients(dish) {
  if (!dish) return null;
  try {
    const r = await db.collection('dish_library').where({ name: dish, valid: true }).limit(1).get();
    if (r && r.data && r.data.length && Array.isArray(r.data[0].ingredients) && r.data[0].ingredients.length) {
      return r.data[0].ingredients;
    }
    // 归一化回退
    const nk = normalizeDishName(dish);
    if (nk && nk !== dish) {
      const r2 = await db.collection('dish_library').where({ name: nk, valid: true }).limit(1).get();
      if (r2 && r2.data && r2.data.length && Array.isArray(r2.data[0].ingredients) && r2.data[0].ingredients.length) {
        return r2.data[0].ingredients;
      }
    }
  } catch (e) { /* dish_library 不存在或查询失败，回退 null */ }
  return null;
}

async function getOrCreate(OPENID) {
  const res = await db.collection(COLL).where({ _openid: OPENID }).limit(1).get();
  if (res.data && res.data.length) return res.data[0];
  // 不存在则建空清单
  const doc = { _openid: OPENID, items: [], updatedAt: new Date() };
  const add = await db.collection(COLL).add({ data: doc });
  return Object.assign({}, doc, { _id: add._id });
}

// 直接购买的成品饮料（无需再加工的现成饮品），这类配饮不展开食材，保留原名。
function isReadyDrink(name) {
  const t = normText(name);
  if (!t) return false;
  const list = ['雪碧', '可乐', '矿泉水', '纯净水', '苏打水', '气泡水', '绿茶', '红茶', '乌龙茶', '咖啡', '美式', '拿铁', '啤酒', '橙汁', '苹果汁', '牛奶', '酸奶', '豆奶', '椰汁', '王老吉', '加多宝', '红牛', '脉动', '农夫山泉', '百岁山', '怡宝'];
  if (list.includes(t)) return true;
  // 含「饮料/饮品/瓶装/罐装」等字样的现成品
  return /(饮料|饮品|瓶装|罐装|听装)/.test(t);
}

// 从一条历史记录的 selected 抽取食材，按【菜】分组。
// 返回数组，每项：{ group: 菜名, items:[食材文本...], from:'history', checked:false, ts }
// - 菜品：本地菜谱库命中 → 直接展开食材；未命中库 → 批量调 AI 生成食材；AI 也失败 → 回退只放菜名。
// - 主食：展开成做它所需主要食材（米/面等）；AI 也失败 → 保留原名。
// - 配饮：直接购买的成品饮料（雪碧/可乐等）→ 保留原名；需现做的（柠檬水/豆浆等）→ 展开主要食材。
async function extractFromSelected(histDoc) {
  const out = [];
  const seenGroup = new Set();
  const norm = (n) => normText(n);
  const pushGroup = (group, ings) => {
    const g = norm(group);
    if (!g) return;
    const arr = (Array.isArray(ings) ? ings : []).map(norm).filter(Boolean);
    if (!arr.length) return;
    if (seenGroup.has(g)) return;     // 同一个名只导入一次
    seenGroup.add(g);
    out.push({ group: g, items: arr, checked: false, from: 'history', ts: Date.now() });
  };
  // 收集所有需要 AI 展开的「非成品」名称（菜/主食/需现做配饮）
  const sel = histDoc && histDoc.selected;
  if (!Array.isArray(sel)) return out;
  const missNames = [];
  const pushIfMiss = (name) => { if (name && typeof name === 'string') missNames.push(name); };
  // 查表：先查 cookbook_ref 静态库，未命中再查 dish_library 集合（env2 新菜食材）
  async function lookupIngredients(name) {
    const cached = lookupCookRef(name);
    if (Array.isArray(cached) && cached.length) return cached;
    const libIngs = await lookupDishLibIngredients(name);
    if (Array.isArray(libIngs) && libIngs.length) return libIngs;
    return null;
  }
  for (const s of sel) {
    if (!s) continue;
    const ings = await lookupIngredients(s.name);
    if (ings) pushGroup(s.name, ings);
    else pushIfMiss(s.name);
    // 主食：展开成主要食材
    if (s.staple) {
      const si = await lookupIngredients(s.staple);
      if (si) pushGroup(s.staple, si);
      else pushIfMiss(s.staple);
    }
    // 配饮：成品饮料保留原名，否则展开
    if (s.drink) {
      if (isReadyDrink(s.drink)) pushGroup(s.drink, [s.drink]);
      else {
        const di = await lookupIngredients(s.drink);
        if (di) pushGroup(s.drink, di);
        else pushIfMiss(s.drink);
      }
    }
  }
  // 未命中库的，批量调 AI 生成食材（失败则回退原名作为唯一食材）
  if (missNames.length) {
    const aiMap = await aiIngredientsForDishes(missNames);
    missNames.forEach(name => {
      const ings = aiMap[name];
      pushGroup(name, Array.isArray(ings) && ings.length ? ings : [name]);
    });
  }
  return out;
}

exports.main = async (event, context) => {
  console.log('[build] manageShopping BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { code: 401, msg: '未获取到用户身份' };
    const action = event && event.action;
    if (!action) return { code: 400, msg: '缺少 action' };

    if (action === 'get') {
      const doc = await getOrCreate(OPENID);
      return { code: 200, data: { items: doc.items || [] } };
    }

    if (action === 'add') {
      // 兼容旧前端传 texts:[字符串...] 与新前端传 items:[{group,items}|{text}]
      let list = Array.isArray(event.items) ? event.items : [];
      if (list.length === 0 && Array.isArray(event.texts)) {
        list = event.texts.map(t => ({ group: t, items: [] }));
      }
      const adds = [];
      const seen = new Set();
      // 收集需要 AI 展开的 group（items 为空的项）
      const missGroups = [];
      const pushGroup = (g, arr, from) => {
        if (!g || !arr.length || seen.has('g:' + g)) return;
        seen.add('g:' + g);
        adds.push({ group: g, items: arr, checked: false, from, ts: Date.now() });
      };
      list.forEach(it => {
        const from = (it && typeof it === 'object' && it.from) ? String(it.from).slice(0, 20) : 'manual';
        if (it && typeof it === 'object' && it.group !== undefined && it.group !== null) {
          const g = normText(it.group);
          if (!g) return;
          const arr = (Array.isArray(it.items) ? it.items : []).map(x => normText(x)).filter(Boolean);
          if (arr.length) { pushGroup(g, arr, from); return; }
          // group 名存在但无食材 → 待 AI 展开
          missGroups.push({ g, from });
          return;
        }
        const raw = (it && typeof it === 'object') ? it.text : it;
        const t = normText(raw);
        if (t && !seen.has('t:' + t)) { seen.add('t:' + t); adds.push({ text: t, checked: false, from, ts: Date.now() }); }
      });
      // 未带食材的菜名，批量调 AI 展开（库命中优先）
      if (missGroups.length) {
        const names = missGroups.map(x => x.g);
        const aiMap = await aiIngredientsForDishes(names);
        names.forEach((name, i) => {
          const ings = aiMap[name];
          const arr = Array.isArray(ings) && ings.length ? ings : [name];   // 失败回退菜名本身
          pushGroup(name, arr, missGroups[i].from);
        });
      }
      if (!adds.length) return { code: 400, msg: '没有可添加的内容' };
      // 去重：跳过已存在的同名项 / 同菜名（group）
      const doc = await getOrCreate(OPENID);
      const existText = new Set((doc.items || []).filter(x => x && !x.group).map(x => x.text));
      const existGroup = new Set((doc.items || []).filter(x => x && x.group).map(x => x.group));
      const fresh = adds.filter(x => x.group ? !existGroup.has(x.group) : !existText.has(x.text));
      if (!fresh.length) return { code: 200, data: { items: doc.items, added: 0, dup: adds.length } };
      const newItems = (doc.items || []).concat(fresh);
      await db.collection(COLL).doc(doc._id).update({ data: { items: newItems, updatedAt: new Date() } });
      return { code: 200, data: { items: newItems, added: fresh.length, dup: adds.length - fresh.length } };
    }

    if (action === 'toggle') {
      const idx = event.index;
      if (typeof idx !== 'number' || idx < 0) return { code: 400, msg: '缺少 index' };
      const doc = await getOrCreate(OPENID);
      const items = doc.items || [];
      if (idx >= items.length) return { code: 404, msg: '清单项不存在' };
      items[idx] = Object.assign({}, items[idx], { checked: !items[idx].checked });
      await db.collection(COLL).doc(doc._id).update({ data: { items, updatedAt: new Date() } });
      return { code: 200, data: { items } };
    }

    if (action === 'remove') {
      const idx = event.index;
      if (typeof idx !== 'number' || idx < 0) return { code: 400, msg: '缺少 index' };
      const doc = await getOrCreate(OPENID);
      const items = (doc.items || []).filter((_, i) => i !== idx);
      await db.collection(COLL).doc(doc._id).update({ data: { items, updatedAt: new Date() } });
      return { code: 200, data: { items } };
    }

    if (action === 'clearAll') {
      const doc = await getOrCreate(OPENID);
      await db.collection(COLL).doc(doc._id).update({ data: { items: [], updatedAt: new Date() } });
      return { code: 200, data: { items: [] } };
    }

    if (action === 'importFromHistory') {
      const histId = event.historyId;
      if (!histId) return { code: 400, msg: '缺少 historyId' };
      // historyId 必须是合法字符串，防止注入到查询
      if (typeof histId !== 'string' || histId.length > 64) return { code: 400, msg: 'historyId 非法' };
      // ⚠️ doc(id).get() 返回单个文档对象（不是数组）；查不到会抛异常，需安全处理
      let histDoc = null;
      try {
        const hres = await db.collection('recommend_history').doc(histId).get();
        histDoc = hres && hres.data;
      } catch (e) {
        histDoc = null;
      }
      if (!histDoc) return { code: 404, msg: '历史记录不存在' };
      // ⚠️ 只能导入自己的历史（防越权读取他人记录）
      if (histDoc._openid !== OPENID) return { code: 403, msg: '无权访问该历史' };
      const adds = await extractFromSelected(histDoc);
      if (!adds.length) return { code: 400, msg: '该记录没有可导入的菜品' };
      const doc = await getOrCreate(OPENID);
      // 去重按 group（菜名）；无 group 的扁平项按 text 去重
      const existGroup = new Set((doc.items || []).filter(x => x && x.group).map(x => x.group));
      const existText = new Set((doc.items || []).filter(x => x && !x.group).map(x => x.text));
      const fresh = adds.filter(x => {
        if (x && x.group) return !existGroup.has(x.group);
        return !existText.has(x.text);
      });
      if (!fresh.length) return { code: 200, data: { items: doc.items, added: 0, dup: adds.length } };
      const newItems = (doc.items || []).concat(fresh);
      await db.collection(COLL).doc(doc._id).update({ data: { items: newItems, updatedAt: new Date() } });
      return { code: 200, data: { items: newItems, added: fresh.length, dup: adds.length - fresh.length } };
    }

    return { code: 400, msg: '未知 action: ' + action };
  } catch (err) {
    console.error('[manageShopping] error:', err);
    return { code: 500, msg: (err && err.message) || '服务异常，请稍后重试' };
  }
};
