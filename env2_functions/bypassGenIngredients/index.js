// ============================================================================
// bypassGenIngredients · env2 AI 生成食材列表（阶段4，方案 §5 / §7 阶段4）
// BUILD_TAG: 2026-09-16b.ingredients-unitfix
//
// 职责：
//   - 扫 env2 本地 dish_mirror 缺 ingredients 的菜；
//   - hy3 生成结构化食材列表 [{name, amount, unit}]；
//   - 写 env2 本地 dish_mirror.ingredients。
//
// 纪律：
//   - 与 bypassAiEnrich/bypassNutritionEst/bypassText/bypassGenImage 并行执行；
//   - hy3 直配 'hy3'；并发 SLOT_N=6；
//   - 内容自检：食材列表 ≥2 项才收，BAD_WORDS 黑名单命中则丢弃；
//   - 失败静默记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-09-16b.ingredients-unitfix';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';

const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();

const SLOT_N = 5;
const BATCH = 24;
const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '抽烟', '饮酒', 'hei', '果子狸', '穿山甲', '蝙蝠'];
const { RateLimiter } = require('./rateLimiter');
const parseKit = require('./parseKit');
// 自适应速率控制器（文）：初始 5、上限 8、60s 窗硬上限 200、429 退避 2/4/8s
const limiter = new RateLimiter({ rateInit: 5, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 200, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassGenIngredients BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'ingredients', env: TCB_ENV };
  }

  // 2026-09-02：单菜用量补全（清洗追加的"适量"项按 1-2 人份补量）。不写库，返回 items 由调用方合并写 env1
  if (task === 'qtyFill') {
    const b = event || {};
    if (!b.dishName || !Array.isArray(b.names) || !b.names.length) return { ok: false, reason: '缺参数' };
    const cleaned = await genIngredientsQty(b.dishName, b.category || '', b.names);
    return { ok: !!cleaned, items: cleaned || [] };
  }

  // 2026-09-02：解除 GEN_DISABLED——env1-backfill/清洗重生成需要本函数补/重建食材
  // 生菜停用仍由 bypassGenDish 自身开关控制，本补齐函数不再受全局开关限制
  // if (process.env.GEN_DISABLED !== 'false') {
  //   console.log('[bypassGenIngredients] GEN_DISABLED 已开启，跳过执行');
  //   return { ok: false, disabled: true, reason: 'gen_disabled' };
  // }

  await ensureCollections();

  if (dishName) {
    const r = await genOne(dishName);
    return Object.assign({ ok: true }, r);
  }

  // ── cookbook 用量补全（2026-08-29）：source='cookbook' 的文档食材名单已由参考谱解析产出，
  // 但约 18% 条目缺 amount/unit。AI 按「现有名单 + 1-2 人份」补量，name 原样保留不增删；
  // 处理完打 ingQtyAi=true 标记防重扫。先于原缺料扫描执行（本批文档都有 ingredients，原扫不命中）。
  {
    const QTY_MAX_MS = 170000;
    const startedAt = Date.now();
    let qtyComputed = 0, qtyLast = '', qtyRounds = 0;
    while (true) {
      const cond = { source: 'cookbook', ingQtyAi: _.neq(true) };
      if (qtyLast) cond._id = _.gt(qtyLast);
      let list = [];
      try { const res = await db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(BATCH).get(); list = res.data || []; } catch (e) { break; }
      if (!list.length) break;

      let computed = 0;
      await pool(list, SLOT_N, async (d) => {
        const name = d.name || d.dishName;
        if (!name) { await db.collection('dish_mirror').doc(d._id).update({ data: { ingQtyAi: true } }).catch(() => {}); return; }
        const ings = Array.isArray(d.ingredients) ? d.ingredients : [];
        const need = ings.some(x => x && (!x.amount && !x.unit));
        if (!need) { await db.collection('dish_mirror').doc(d._id).update({ data: { ingQtyAi: true } }).catch(() => {}); return; }
        try {
          const names = ings.map(x => (x && x.name) || '').filter(Boolean);
          const filled = await genIngredientsQty(name, d.category, names);
          if (filled && filled.length) {
            const byName = new Map(filled.map(x => [x.name, x]));
            const merged = ings.map(x => {
              if (x && x.amount) return x;                       // 已有量/单位 → 保留解析结果
              const hit = byName.get(x && x.name) || byName.get(String(x).trim());
              return hit ? { name: x.name, amount: hit.amount, unit: hit.unit } : (x || x);
            });
            await db.collection('dish_mirror').doc(d._id).update({ data: { ingredients: merged, ingQtyAi: true, ingredientsUpdatedAt: Date.now() } });
            computed++;
            qtyLast = d._id;
            console.log('[bypassGenIngredients] 用量补全成功 name=' + name);
          } else {
            console.warn('[bypassGenIngredients] 用量补全空 name=' + name);
            await logTask('bypassGenIngredients', null, 'fail', 'qty_fill_empty name=' + name);
          }
        } catch (e) {
          console.warn('[bypassGenIngredients] 用量补全失败 name=' + name + '：', e && e.message);
          await logTask('bypassGenIngredients', null, 'fail', 'qty [' + name + '] ' + (e && e.message));
          if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e;
        }
      }, limiter);

      qtyComputed += computed;
      qtyRounds++;
      if (!list.length || Date.now() - startedAt > QTY_MAX_MS) break;
      // 注意：该轮若全部处理完（ingQtyAi 全 true），下轮扫描自然为空退出
    }
    console.log('[bypassGenIngredients] cookbook 用量补全 computed=' + qtyComputed + ' rounds=' + qtyRounds);
    // 用量补全吃掉大部分时间预算时，跳过原缺料扫描（原流程面向 env2 自产菜，本批不受影响）
    if (Date.now() - startedAt > 200000) {
      await logTask('rateLimiter', null, 'info', limiter.monitorMsg()).catch(() => {});
      return { ok: true, qtyComputed, rounds: qtyRounds, note: 'qty-fill consumed budget' };
    }
  }

  // 循环补齐：一次调用内翻页扫描所有缺 ingredients 的菜，直到补齐或逼近函数超时（留 15s 余量）。
  const MAX_MS = 105000;
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    const cond = { ingredients: _.exists(false) };
    if (lastId) cond._id = _.gt(lastId);
    let q = db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize);
    let list = [];
    try { const res = await q.get(); list = res.data || []; } catch (e) { list = []; }
    if (!list.length) break;

    let computed = 0;
    await pool(list, SLOT_N, async (d) => {
      const name = d.name || d.dishName;
      if (!name) return;
      for (const w of BAD_WORDS) { if (name.includes(w)) return; }
      try {
        const ingredients = await genIngredients(name, d.cuisine, d.mainIngredient);
        if (ingredients && ingredients.length >= 2) {
          await db.collection('dish_mirror').doc(d._id).update({
            data: { ingredients, ingredientsUpdatedAt: Date.now() },
          });
          computed++;
          lastId = d._id;
          console.log('[bypassGenIngredients] 生成成功 name=' + name + ' count=' + ingredients.length);
        } else {
          console.warn('[bypassGenIngredients] 生成过少/空 name=' + name);
          await logTask('bypassGenIngredients', null, 'fail', 'ingredients_too_few name=' + name);
        }
      } catch (e) {
        console.warn('[bypassGenIngredients] 生成失败 name=' + name + '：', e && e.message);
        await logTask('bypassGenIngredients', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e; // 限流类错误上抛，触发自适应降速
      }
    }, limiter);

    totalComputed += computed;
    rounds++;
    if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
  }

  await logTask('rateLimiter', null, 'info', limiter.monitorMsg()).catch(() => {});
  return { ok: true, computed: totalComputed, rounds, hasMore: false, lastId };
};

async function genOne(name) {
  if (!name) return { skip: true, reason: '空菜名' };
  // 读取 mirror 上下文（现有清单/修正要求/步骤/菜系主料），修订时对齐修正（2026-09-04）
  let ctx = {};
  try {
    const r = await db.collection('dish_mirror').where({ name }).limit(1).get();
    const d = (r.data && r.data[0]) || null;
    if (d) {
      const prof = (d.profile && typeof d.profile === 'object') ? d.profile : {};
      const stepsArr = Array.isArray(d.steps) ? d.steps : [];
      const ingArr = Array.isArray(d.ingredients) ? d.ingredients : [];
      ctx = {
        cuisine: d.cuisine || prof.cuisine || '',
        mainIng: prof.main || d.mainIngredient || '',
        stepsText: stepsArr.map(s => String((s && (s.text || s)) || '')).filter(Boolean).join('\n'),
        fixNotes: d.fixNotes ? String(d.fixNotes).trim() : '',
        existing: ingArr.length ? ingArr : null,   // 现有食材清单 → 走"增删改修订"而非整份重写
      };
    }
  } catch (e) {}
  const ingredients = await genIngredients(name, ctx.cuisine, ctx.mainIng, ctx);
  if (!ingredients || ingredients.length < 2) return { skip: true, reason: 'ingredients 过少' };
  // 2026-09-02：单菜模式同时写回 mirror（清洗"菜名与食材不符"重生成用）
  try {
    const r = await db.collection('dish_mirror').where({ name }).limit(1).get();
    const d = (r.data && r.data[0]) || null;
    if (d && d._id) {
      await db.collection('dish_mirror').doc(d._id).update({ data: { ingredients, ingredientsUpdatedAt: Date.now() } });
    } else {
      await db.collection('dish_mirror').add({ data: { name, ingredients, source: 'regen-ing', genAt: Date.now(), ingredientsUpdatedAt: Date.now() } });
    }
  } catch (e) { console.warn('[bypassGenIngredients] genOne 写 mirror 失败 name=' + name + ' ' + (e && e.message)); }
  return { ok: true, ingredients };
}

async function genIngredients(name, cuisine, mainIngredient, ctx) {
  const hints = [];
  if (cuisine) hints.push('菜系：' + cuisine);
  if (mainIngredient) hints.push('主料：' + mainIngredient);
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';
  const c = ctx || {};
  // 2026-09-04：返工重生成带「步骤参考 + 修正要求」，食材清单须对齐步骤用料并修正上轮问题
  let extra = '';
  // 2026-09-16【P0 口径修正】：原提示词把"清水/水/盐/食用油等介质与基础调料"**排除**在清单之外，
  //   而矛盾扫描（dimScan）却把"清单缺步骤所需的清水/开水/食用油"判为实质矛盾 ⇒ 生成与判定口径打架，
  //   返工怎么修都会被判 fail（占 fail 最大类）。现改为：**基础项也必须逐项列入并给可用量**。
  if (c.stepsText) extra += '\n\n【该菜步骤参考】食材清单必须完整覆盖步骤里用到的**所有**物料 —— 包括清水/开水/温水/食用油/盐/糖/生抽/料酒等基础项，'
    + '每项都要给出可用量（如"清水 200毫升""食用油 10毫升"），不得只写"少许"或干脆不列；用量必须与步骤实际使用量一致（不得少于步骤用量）：\n'
    + String(c.stepsText).slice(0, 1400);
  if (c.fixNotes) extra += '\n\n【修正要求（上轮问题，务必逐条修正，不得遗漏或再犯）】\n' + String(c.fixNotes).slice(0, 1000);

  // 2026-09-04：有现有清单 → 在现有基础上「增删改修订」（保留对的/补缺的/改点名的），
  // 不再整份从零重写（整份重写会丢原本正确的项，一轮补不干净）
  const existing = Array.isArray(c.existing)
    ? c.existing
        .map(x => ({ name: String((x && x.name) || '').trim(), amount: String((x && x.amount) || '').trim(), unit: String((x && x.unit) || '').trim() }))
        .filter(x => x.name)
    : [];
  if (existing.length >= 1) return await genIngredientsRevision(name, hintStr, existing, extra, c.fixNotes);
  return await genIngredientsFresh(name, hintStr, extra);
}

// 无现有清单：从零生成整份
async function genIngredientsFresh(name, hintStr, extra) {
  const messages = [
    {
      role: 'system',
      content: '你是家常菜烹饪助手。根据菜名生成完整的食材列表（含主料和调料）。【严格输出格式】只输出一个 JSON 数组，不要任何解释、不要加 markdown 代码围栏、不要加 ```json 标记，直接以 [ 开头、] 结尾。数组每个元素为对象：{"name":"食材名","amount":"用量","unit":"单位"}，键名必须是英文。'
    },
    {
      role: 'user',
      content: '菜品：' + name + hintStr + (extra || '') + '\n\n请生成 3-8 项食材，包含主料和常用调料。amount 用中文数字（如"200"、"1"），unit 用中文单位（如"克"、"毫升"、"个"）。当用量为模糊量词时，amount 填"适量"或"少许"，unit 留空字符串。严禁 amount 和 unit 都填模糊量词（如"适量"+"适量"），严禁 amount 填模糊量词时 unit 填具体单位（如"少许"+"克"）。只返回 JSON 数组。'
    }
  ];
  return await askLoop(name, messages, 'ingredients_parse_failed');
}

// 有现有清单：修订模式——原样保留对的、只补步骤缺的、只改点名错的（最小改动）
async function genIngredientsRevision(name, hintStr, existing, extra, fixNotesRaw) {
  const listStr = existing
    .map((x, i) => (i + 1) + '. ' + [x.name, x.amount, x.unit].filter(v => String(v || '').trim()).join(' '))
    .join('\n');
  const unitRule = 'amount 用中文数字（如"200"），unit 用中文单位（如"克"、"毫升"、"个"）。当用量为模糊量词时 amount 填"适量"或"少许"、unit 留空字符串；严禁 amount 和 unit 都填模糊量词（如"适量"+"适量"），严禁 amount 填模糊量词时 unit 填具体单位（如"少许"+"克"）。';
  const content = '菜品：' + name + hintStr
    + '\n\n【现有食材清单（修订底色，请逐项核对）】\n' + listStr
    + (extra || '')
    + '\n\n【修订纪律】\n'
    + '1. 【原样保留】现有清单里与菜名/做法相符、或步骤会用到的项（没被点名要求删除的），必须原样保留：名称、用量、单位照抄；严禁整份重写、严禁丢掉仍需要的项；\n'
    + '2. 【只改点名的】只有与菜名不符、与步骤用量明显矛盾、或【修正要求】点名的项才修改（改名/改量/删错项）；点名要求删除的项才删除；\n'
    + '3. 【只补缺失】步骤里用到但现有清单没有的物料**必须补入 —— 包括清水/开水/温水/食用油/盐/糖/生抽等基础项**（基础项同样要给可用量，如"清水 200毫升"），按步骤实际用量补；\n'
    + '4. 输出修订后的【完整清单】（含全部保留项与增改项），共 3-8 项，顺序尽量沿用现有顺序。'
    + '\n\n请输出修订后的完整食材清单。' + unitRule
    + ' 只返回一个 JSON 数组（[ 开头、] 结尾），元素为 {"name":"食材名","amount":"用量","unit":"单位"}，键名用英文，不要解释、不要 markdown 围栏。';
  const messages = [
    { role: 'system', content: '你是家常菜食材清单修订助手，擅长在既有清单上做最小改动。只输出 JSON 数组，不要任何解释或 markdown 围栏，直接以 [ 开头、] 结尾。' },
    { role: 'user', content },
  ];
  let result = await askLoop(name, messages, 'ingredients_revision_failed');
  if (!result || !result.length) return null;
  // 保留率兜底：现有应保留项大比例漏抄（疑似又整份重写）→ 点名列出漏项，提醒保留后再问一次（最多 1 轮）
  const keepRate = rateKept(existing, result, fixNotesRaw);
  if (keepRate < 0.6) {
    const missNames = keptNames(existing, result, fixNotesRaw);
    if (missNames.length) {
      const retry = await askLoop(name, messages.concat([{
        role: 'user',
        content: '【保留提醒】上一版输出漏掉了现有食材清单中以下仍需要的项，请将它们按原名称、用量、单位原样补进最终清单，再重新输出完整 JSON 数组：\n' + missNames.join('\n'),
      }]), 'ingredients_revision_retry_failed');
      if (retry && retry.length >= 2 && rateKept(existing, retry, fixNotesRaw) > keepRate) result = retry;
    }
  }
  return result;
}

// —— 修订模式辅助：应保留项判定 / 保留率 ——
function hitName(a, b) { return !!a && !!b && (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0); }
// 从修正要求里挑"点名删除 XX"的 XX（该删的不计入应保留）
function dropList(fixNotesRaw) {
  const s = String(fixNotesRaw || '').replace(/\s+/g, '');
  const out = new Set();
  if (!s) return out;
  const del = /(?:去掉|删除|去除|移除|删掉|排除|不要|不需要|不用|多余)\s*[、，,：:]?\s*([^\s；;，,、]+)/;
  for (const seg of s.split(/[；;\n]/)) {
    const dm = seg.match(del);
    if (dm && dm[1]) out.add(dm[1]);
  }
  return out;
}
function keptNames(existing, now, fixNotesRaw) {
  const drops = dropList(fixNotesRaw);
  return existing
    .map(x => x.name)
    .filter(on => !drops.has(on))
    .filter(on => !now.some(f => hitName(f.name, on)));
}
function rateKept(existing, now, fixNotesRaw) {
  const names = existing.map(x => x.name).filter(on => !dropList(fixNotesRaw).has(on));
  if (!names.length) return 1;
  return names.filter(on => now.some(f => hitName(f.name, on))).length / names.length;
}

// —— 公共 hy3 食材调用 + 解析 + 清洗 ——
async function askItemsOnce(name, messages, maxTokens) {
  try {
    const textModel = ai.createModel('cloudbase');
    const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.5, maxTokens: maxTokens || 600 });
    const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
    const { items, source } = parseKit.extractListItems(text, 'ingredient');
    if (!items || !items.length) throw new Error('空数组');
    const cleaned = cleanItems(items, name);
    if (!cleaned || cleaned.length < 2) throw new Error('食材过少');
    if (source === 'heuristic') {
      console.warn('[bypassGenIngredients] 启发式兜底切分 name=' + name + ' count=' + cleaned.length + ' raw=' + text.slice(0, 200));
      await logTask('bypassGenIngredients', null, 'warn', 'heuristic_fallback name=' + name + ' raw=' + text.slice(0, 200)).catch(() => {});
    }
    return cleaned;
  } catch (e) { return null; }
}

async function askLoop(name, messages, errTag) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cleaned = await askItemsOnce(name, messages, 600);
    if (cleaned && cleaned.length) return cleaned;
    if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    else {
      console.warn('[genIngredients] hy3 失败 name=' + name + ' tag=' + errTag);
      await logTask('bypassGenIngredients', null, 'fail', errTag + ' name=' + name).catch(() => {});
    }
  }
  return null;
}

// 黑名单 + 用量/单位清洗（沿用原规则）
function cleanItems(items, name) {
  for (const w of BAD_WORDS) {
    for (const item of items) {
      if (item && item.name && String(item.name).includes(w)) {
        console.warn('[bypassGenIngredients] 黑名单命中 name=' + name + ' word=' + w);
        return null;
      }
    }
  }
  const VAGUE = ['适量', '少许', '少量', '些许', '适当'];
  return items
    .filter(item => item && item.name && typeof item.name === 'string')
    .map(item => {
      let amount = String(item.amount || '').trim().slice(0, 10);
      let unit = String(item.unit || '').trim().slice(0, 10);
      const va = VAGUE.find(v => amount.includes(v));
      if (va) { amount = va; unit = ''; }
      const vu = VAGUE.find(v => unit.includes(v));
      if (vu) { if (!amount) amount = vu; unit = ''; }
      if (amount && !/^\d+(\.\d+)?$/.test(amount)) unit = '';
      if (!amount && !unit) amount = '适量';
      return { name: String(item.name).trim().slice(0, 20), amount, unit };
    })
    // 2026-09-16 v2：amount 规范化（治判定侧报的"缺量词/单位/单位重复/适量混单位"）——
    //   · "省略" → 适量；· 重复单位（"2斤斤"）→ 折叠；· "适量"/"少许" 与单位混用 → 去单位；
    //   · 裸数字/半/小半（无量词）→ **按材料类型补单位**（液体→毫升或勺 / 粉粒→克 / 计数类→个）。
    //   实测判定侧高频报："蚝油半"、"盐小半"、"生抽半"、"蒜末一"、"面粉 2"（缺单位）。
    .map(item => {
      let amount = String(item.amount || '').trim();
      let unit = String(item.unit || '').trim();
      if (/^(省略|省略用量|无|不写)$/.test(amount)) { amount = '适量'; unit = ''; }
      amount = amount.replace(/(斤|克|毫升|升|勺|汤匙|茶匙|个|根|片|块|条|只|枚|粒|瓣|朵|把|杯|碗)\1+/g, '$1');
      // "适量勺"/"少许克" 这类混用：保留模糊量词、丢掉单位
      if (/^(适量|少许|少量|些许|适当)/.test(amount)) { amount = amount.match(/^(适量|少许|少量|些许|适当)/)[1]; unit = ''; }
      const NUMWORD = /^[大小]?[0-9０-９半一二三四五六七八九十两]+$/;
      if (!unit && NUMWORD.test(amount)) {
        const nm = String(item.name || '');
        const LIQ = /油|酱|醋|料酒|生抽|老抽|水|奶|汁|汤|酒$/;
        const POW = /粉|淀粉|盐|糖|胡椒|花椒|孜然|味精|鸡精|酵母|可可|抹茶|咖喱|五香/;
        const CNT = /蛋|蒜|姜|葱|辣椒|椒|枣|枸杞|香菇|木耳|八角|香叶|桂皮|番茄|土豆|豆腐/;
        const frac = /[半小]/.test(amount);
        unit = LIQ.test(nm) ? (frac ? '勺' : '毫升') : (POW.test(nm) ? (frac ? '勺' : '克') : (CNT.test(nm) ? '个' : '克'));
      }
      return Object.assign({}, item, { amount, unit });
    });
}

function parseJsonArray(text) {
  return parseKit.extractJsonArray(text);
}

// cookbook 用量补全：给定现有食材名单（name 原样），AI 补每项的 amount/unit（1-2 人份）
async function genIngredientsQty(name, category, names) {
  const hintStr = category ? '（类别：' + category + '）' : '';
  const listStr = names.map((n, i) => (i + 1) + '. ' + n).join('\n');
  const messages = [
    { role: 'system', content: '你是家常菜烹饪助手。只输出一个 JSON 数组，不要任何解释、不要 markdown 围栏，直接以 [ 开头、] 结尾。元素格式：{"name":"食材名","amount":"用量","unit":"单位"}。' },
    { role: 'user', content: '菜品：' + name + hintStr + '\n以下是这道菜的食材名单：\n' + listStr + '\n\n请按 1-2 人份为【每一项】补上合理的用量：\n1. name 必须原样照抄名单，不得增删食材、不得改写名称\n2. 输出顺序与名单一致\n3. 具体量：amount 填数字（如"200"），unit 填中文单位（如"克"、"毫升"、"个"）\n4. 模糊量：amount 填"适量"或"少许"，unit 填空字符串\n5. 严禁 amount 和 unit 同时为空' }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.3, maxTokens: 600 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const arr = parseKit.extractJsonArray(text);
      if (!arr || !arr.length) throw new Error('空数组');
      const VAGUE = ['适量', '少许', '少量', '些许', '适当'];
      const cleaned = arr
        .filter(item => item && item.name)
        .map(item => {
          let amount = String(item.amount || '').trim().slice(0, 10);
          let unit = String(item.unit || '').trim().slice(0, 10);
          const va = VAGUE.find(v => amount.includes(v));
          if (va) { amount = va; unit = ''; }
          if (amount && !/^\d+(\.\d+)?$/.test(amount)) unit = '';
          if (!amount && !unit) amount = '适量';
          return { name: String(item.name).trim().slice(0, 20), amount, unit };
        });
      // 覆盖校验：AI 输出需覆盖名单的大多数项
      const hitCount = names.filter(n => cleaned.some(c => c.name === n || n.indexOf(c.name) >= 0)).length;
      if (hitCount < Math.max(1, Math.ceil(names.length * 0.6))) throw new Error('覆盖不足 ' + hitCount + '/' + names.length);
      return cleaned;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else {
        console.warn('[genIngredientsQty] hy3 失败 name=' + name + '：', e && e.message);
        await logTask('bypassGenIngredients', null, 'fail', 'qty_parse_failed name=' + name + ' ' + (e && e.message || '')).catch(() => {});
      }
    }
  }
  return null;
}

async function ensureCollections() {
  await Promise.allSettled([db.createCollection('dish_mirror')]);
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* */ }
}

async function pool(items, concurrency, worker, limiter) {
  let idx = 0;
  const runners = [];
  for (let i = 0; i < concurrency && i < items.length; i++) {
    runners.push((async () => {
      while (idx < items.length) {
        const pos = idx++;
        if (limiter) await limiter.acquire();
        try {
          await worker(items[pos], pos);
          if (limiter) limiter.onSuccess();
        } catch (e) {
          if (limiter) limiter.onLimit();
          else throw e;
        }
      }
    })());
  }
  await Promise.all(runners);
}