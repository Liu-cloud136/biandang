// ============================================================================
// bypassConsistencyRepair · env2 整菜维度自洽修复引擎（2026-09-08 新增）
// BUILD_TAG: 2026-09-16c.consistency-repair-v6-numfmt
//
// 2026-09-12 修（丝瓜炒鸡肉 4 轮全败复盘）：hy3 偶发吐出畸形 JSON（实测 "amount"::"3瓣"
//       双冒号 glitch，temp 0.3 下 100% 复现）→ parseJsonObj 必炸 → 内部 3 次重试全废 →
//       上层 autofix 反复重跑同样失败。修法：①解析失败走三级修复梯（尾逗号→双冒号→
//       空串值后跟新值）；②重试时把上轮坏输出回喂模型令其自纠；③最终失败时把原始输出
//       头部打进日志，失败可自助诊断（r.Log 可查）。
//
// 背景：auto-fix 逐维重生成（ingredients/steps/tips/review 各自独立 hy3 调用）
//       生成结果互不参照 → 「步骤用量与食材清单不符」「贴士与步骤矛盾」等
//       跨维度问题反复出现、修 3 轮仍不过。
// 本函数一次性读取 dish_mirror 全维文本，在同一次 hy3 调用里重写整套
// 菜谱内容（食材/步骤/贴士/点评/难度），强制维度间自洽后写回 dish_mirror。
//
// 调用：review rework 任务 repair='consistency' 时调起（env1 基线先经
//       syncBaseToMirror 写入 mirror，mirror.fixNotes 带上轮 AI 复核问题）。
//       event = { dishName, issues?（[{dim,problem}] 或已并入 mirror.fixNotes） }
// 返回：{ ok, fields:{ingredients,steps,tips,review,difficulty}, summary }
// ============================================================================

const BUILD_TAG = '2026-09-16c.consistency-repair-v6-numfmt';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 90000 });
const ai = app.ai();

const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '抽烟', '饮酒', 'hei', '果子狸', '穿山甲', '蝙蝠'];
const DIFF_LEVELS = ['简单', '一般', '较难'];

exports.main = async (event = {}) => {
  console.log('[build] bypassConsistencyRepair BUILD_TAG=' + BUILD_TAG);
  const { task, dishName } = event || {};
  if (task === 'health') return { ok: true, build: BUILD_TAG, mode: 'consistency', env: TCB_ENV };
  if (!dishName) return { ok: false, err: 'dishName 缺失' };
  const r = await repairOne(dishName, event.issues);
  return Object.assign({ ok: true }, r);
};

async function repairOne(name, issues) {
  // 1) 读 mirror 当前工作副本（含 syncBaseToMirror 写好的 env1 基线与 fixNotes）
  let d = null;
  try {
    const res = await db.collection('dish_mirror').where({ name }).limit(1).get();
    d = (res.data && res.data[0]) || null;
  } catch (e) { console.warn('[consistencyRepair] 读 mirror 失败 ' + name + ' ' + (e && e.message)); }
  if (!d) return { skip: true, reason: 'mirror 无文档' };

  const prof = (d.profile && typeof d.profile === 'object') ? d.profile : {};
  const issueText = (Array.isArray(issues) && issues.length)
    ? issues.map(i => '[' + ((i && i.dim) || '其他') + '] ' + ((i && (i.problem || i.desc)) || '')).join('；').slice(0, 1600)
    : String(d.fixNotes || '').slice(0, 1600);

  const ingList = Array.isArray(d.ingredients) ? d.ingredients.map(x => {
    const s = (x && x.name) ? String(x.name).trim() : '';
    if (!s) return null;
    return s + (x.amount ? ' ' + String(x.amount) + ((x.unit && x.unit !== '适量' && x.unit !== '克') ? x.unit : (x.unit || '')) : '');
  }).filter(Boolean).join('、') : '';
  const stepsText = Array.isArray(d.steps) ? d.steps.map(x => (x.stepNo ? x.stepNo + '. ' : '') + String(x.text || '')).join('\n') : '';
  const tipsNow = String(d.tips || '').trim();
  const reviewNow = String(d.review || '').trim();
  const diffNow = String(d.difficulty || '').trim();

  const hints = [];
  if (d.cuisine) hints.push('菜系：' + d.cuisine);
  if (prof.main) hints.push('主料画像：' + JSON.stringify(prof));
  if (d.category) hints.push('类别：' + d.category);
  const hintStr = hints.length ? '（' + hints.join('，') + '）' : '';

  const content = '菜品：' + name + hintStr + '\n\n'
    + '【现有食材清单】' + (ingList || '（无）') + '\n'
    + '【现有步骤】\n' + (stepsText || '（无）') + '\n'
    + '【现有贴士】' + (tipsNow || '（无）') + '\n'
    + '【现有点评】' + (reviewNow || '（无）')
    + (diffNow ? '\n【现有难度】' + diffNow : '')
    + (issueText ? '\n\n【上轮复核指出的问题，必须逐条消解】\n' + issueText : '')
    + '\n\n【一致性铁律（全部必须满足）】\n'
    + '1. 食材清单 = 步骤实际用到的唯一依据：步骤用到的每样食材/调料（含盐糖生抽老抽蚝油料酒醋淀粉食用油等）都必须出现在清单；清单里的每项也必须在步骤中被实际使用（腌制/装盘点缀除外），避免"多列少用/步骤自造"。\n'
    + '2. 用量一致：步骤中写出的用量数值（克/毫升/勺/个/朵 等）必须与食材清单一致；清单给出明确量的，步骤不得用不同数字，只能用同量或"适量"。\n'
    + '3. 贴士严格对齐步骤：贴士里出现的动作/火候/时间/下料时机必须是步骤中真实存在或与其不矛盾的，不得说步骤没有的操作、不得与步骤相反。\n'
    + '4. 点评对齐做法：点评描述的口感/辣度/火候/成品形态与步骤做法一致（焖煮软烂就不能说"爽脆"，清淡就不能说麻辣）。\n'
    + '5. 步骤 4~7 步、每步一句话可操作、顺序正确；难度三选一：简单/一般/较难。\n'
    + '6. 以菜名与主料为纲，步骤必须完成菜名点名的核心操作。\n'
    // 2026-09-16【P0】：与 bypassGenIngredients 同步的口径修正 —— 基础项不再豁免，必须入清单
    + '7. 【基础项不得豁免】步骤用到的清水/开水/温水/食用油/盐/糖/生抽/料酒等**基础项也必须列入食材清单并给出可用量**（如"清水 200毫升""食用油 10毫升"），不得只写"少许"、更不得省略——复核会把"清单缺步骤所需的水/油"判为实质矛盾。\n'
    + '8. 用量表述必须完整可读：每项写成「名称 + 数值/分数 + 单位」（如"蚝油 半勺"、"草鱼 1条"、"清水 200毫升"），禁止出现"蚝油半"（缺量词）、"2斤斤"（单位重复）、amount 为空的项。\n'
    // 2026-09-16【P3】：与 bypassGenSteps 同步 —— **数量词一律阿拉伯数字**（判定侧会抓"步骤写「姜五十个」"与清单 50克 不一致）
    + '9. 【数字用阿拉伯数字】句子里的用量/时间/次数一律用阿拉伯数字："50克/10分钟/2瓣/6成热/点2次凉水"，**严禁**"五十克/十分钟/两瓣/六成热/点两次"；模糊表述可保留（"六七成热""适量""少许"）。';

  const messages = [
    {
      role: 'system',
      content: '你是家常菜谱校对专家。收到一道菜当前不完整的菜谱内容后，把它重写为一套**维度间完全自洽**的完整菜谱。'
        + '【严格输出格式】只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏、不要 ```json 标记。结构：'
        + '{"ingredients":[{"name":"食材名","amount":"200克 或 适量","unit":"克/毫升/勺 或 省略"}],'
        + '"steps":[{"stepNo":1,"text":"一句话操作"}],"tips":"一条贴士，20-40字",'
        + '"review":"一句点评 12-30 字，与做法一致","difficulty":"简单|一般|较难"}。'
        + '逐条落实复核指出的问题，没有指出的维度也应自查自洽。',
    },
    { role: 'user', content },
  ];

  let lastErr = '';
  let lastRaw = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      // 重试时把上轮坏输出回喂，令模型自纠格式（此前盲重试同 prompt，glitch 100% 复现）
      const msgs = (attempt > 0 && lastRaw) ? messages.concat([
        { role: 'assistant', content: lastRaw.slice(0, 3000) },
        { role: 'user', content: '你上一条输出不是合法 JSON（错误：' + lastErr + '）。请重新输出，只输出一个合法 JSON 对象，不要任何解释、不要 markdown 围栏、不要多余文字。' },
      ]) : messages;
      const resp = await textModel.generateText({
        model: 'hy3', messages: msgs, temperature: 0.3, maxTokens: 4000,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      if (!text || text.length < 40) throw new Error('输出过短');
      lastRaw = text;
      const obj = parseJsonObj(text);
      if (!obj) throw new Error('JSON 解析失败');
      const clean = normalizeDims(obj, name);
      if (!clean) throw new Error('内容自检未过');
      await writeBack(d, clean);
      console.log('[consistencyRepair] ✓ 自洽修复成功 name=' + name + ' ing=' + clean.ingredients.length + ' steps=' + clean.steps.length);
      return { ok: true, name, fields: { ingredients: clean.ingredients, steps: clean.steps, tips: clean.tips, review: clean.review, difficulty: clean.difficulty }, summary: 'ing' + clean.ingredients.length + '/step' + clean.steps.length };
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 150);
      // 解析失败时把原始输出头部打进日志（r.Log 可查），失败可自助诊断
      if (/JSON/.test(lastErr) && lastRaw) console.warn('[consistencyRepair] 原始输出头部: ' + JSON.stringify(lastRaw.slice(0, 240)));
      console.warn('[consistencyRepair] 第' + (attempt + 1) + '次失败 name=' + name + ' ' + lastErr);
      if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  await logTask('bypassConsistencyRepair', null, 'fail', 'dish [' + name + '] ' + lastErr).catch(() => {});
  return { ok: false, err: lastErr, name };
}

function parseJsonObj(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const st = s.indexOf('{');
  const en = s.lastIndexOf('}');
  if (st >= 0 && en > st) s = s.slice(st, en + 1);
  try { return JSON.parse(s); } catch (e) { /* 走修复梯 */ }
  // 2026-09-12 三级修复梯（针对 hy3 实测 glitch，仅当直解失败才改写，合法 JSON 不受影响）：
  // ① 收尾逗号 ,} / ,]
  let r = s.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  // ② 键值完成后多余冒号（实测 "amount"::"3瓣" → "amount":"3瓣"）
  r = r.replace(/"\s*:\s*:/g, '":');
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  // ③ 空串值后紧跟新值（"k":"" :"x" → "k":"x"）
  r = r.replace(/""\s*:\s*"/g, '"');
  try { return JSON.parse(r); } catch (e) { return null; }
}

// 规范化 + 内容自检（失败返回 null）
function normalizeDims(o, name) {
  if (!o || typeof o !== 'object') return null;
  // ingredients
  const ing = [];
  const seenIng = new Set();
  if (Array.isArray(o.ingredients)) {
    for (const x of o.ingredients) {
      const nm = String((x && x.name) || '').replace(/\s/g, '');
      // 2026-09-10 修（单字主料死循环）：此前 nm.length<2 一律丢弃 → 单字食材（梨/枣/梅…）被删，
      // 而复核仍要求「步骤用到的梨必须出现在清单」→ 修一次丢一次、无限返工。
      // 调料类单字有下方 CONDS 兜底，主料型单字无兜底，故必须放行。放行单个汉字，仍挡数字/字母/符号。
      const singleCJK = /^[\u4e00-\u9fa5]$/.test(nm);
      if (!nm || (!singleCJK && nm.length < 2) || nm.length > 12 || seenIng.has(nm)) continue;
      if (BAD_WORDS.some(w => nm.includes(w))) continue;
      seenIng.add(nm);
      let amount = String((x && (x.amount || x.qty)) || '').trim() || '适量';
      let unit = String((x && x.unit) || '').trim();
      // 2026-09-16 v2 amount 规范化（与 bypassGenIngredients.cleanItems 同口径，判定侧高频报"蚝油半/盐小半/生抽半"）
      amount = amount.replace(/(斤|克|毫升|升|勺|汤匙|茶匙|个|根|片|块|条|只|枚|粒|瓣|朵|把|杯|碗)\1+/g, '$1');
      if (/^(省略|省略用量|无|不写)$/.test(amount)) { amount = '适量'; unit = ''; }
      if (/^(适量|少许|少量|些许|适当)/.test(amount)) { amount = amount.match(/^(适量|少许|少量|些许|适当)/)[1]; unit = ''; }
      const NUMWORD = /^[大小]?[0-9０-９半一二三四五六七八九十两]+$/;
      if (!unit && NUMWORD.test(amount)) {
        const LIQ = /油|酱|醋|料酒|生抽|老抽|水|奶|汁|汤|酒$/;
        const POW = /粉|淀粉|盐|糖|胡椒|花椒|孜然|味精|鸡精|酵母|可可|抹茶|咖喱|五香/;
        const CNT = /蛋|蒜|姜|葱|辣椒|椒|枣|枸杞|香菇|木耳|八角|香叶|桂皮|番茄|土豆|豆腐/;
        const frac = /[半小]/.test(amount);
        unit = LIQ.test(nm) ? (frac ? '勺' : '毫升') : (POW.test(nm) ? (frac ? '勺' : '克') : (CNT.test(nm) ? '个' : '克'));
      }
      const item = { name: nm, amount };
      // 2026-09-08 修：amount 已带单位字（2勺/半勺/300克）时不另塞 unit，防复核读成"2勺勺"双单位
      const numericOnly = /^[0-9半一二三四五六七八九十两]+(\.\d+)?$/.test(amount);
      if (numericOnly && unit) item.unit = unit;
      else if (unit && !/勺|汤匙|茶匙|大勺|小勺|克|毫升|升|碗|杯|个|根|段|把|朵|瓣|片|只|条|枚|粒|张/.test(amount)) item.unit = unit;
      ing.push(item);
    }
  }
  if (!ing.length) return null;
  // 步骤文本里出现但清单漏列的常用调料自动补列（amount 适量），杜绝复核报"步骤用到 X 清单未列出"
  // 先规范化步骤文本，用其反查补料
  let rawStepsText = '';
  if (Array.isArray(o.steps)) {
    rawStepsText = o.steps.map(x => String((x && (x.text || x.step)) || '').trim()).join(' ');
  }
  // 2026-09-16【P0】原表**没有清水/开水/食用油** —— 而矛盾扫描恰恰把"清单缺步骤所需的清水/开水/食用油"
  //   判为实质矛盾（fail 最大类）。补齐基础项 + 常见调料；水类单独处理（见下），避免"水果"误命中。
  const CONDS = ['干辣椒', '八角', '香叶', '花椒', '胡椒粉', '白胡椒粉', '花椒粉', '豆瓣酱', '黄豆酱', '蚝油', '料酒', '生抽', '老抽', '淀粉', '玉米淀粉', '土豆淀粉', '香油', '酱油', '鸡精', '味精', '醋', '陈醋', '米醋', '姜', '蒜', '葱', '盐', '糖', '白糖', '冰糖', '食用油', '菜籽油', '花生油', '橄榄油', '辣椒油', '猪油', '小米椒', '青蒜', '香菜'];
  for (const cd of CONDS) {
    if (!rawStepsText.includes(cd)) continue;
    if (ing.some(x => x.name.includes(cd))) continue;
    if (ing.some(x => cd.includes(x.name) && x.name.length < cd.length)) continue;
    ing.push({ name: cd, amount: '适量' });
    if (ing.length > 40) break;
  }
  // 水类（清水/开水/温水/热水/凉水/冷水）：步骤提到水（且不是"水果/水饺/水淀粉"这类词）就补一项
  {
    const WATER_TYPES = ['清水', '开水', '温水', '热水', '凉水', '冷水'];
    const hit = WATER_TYPES.find(w => rawStepsText.includes(w));
    const genericWater = !hit && /水(?!果|饺|淀粉|面|晶)/.test(rawStepsText);
    const waterName = hit || (genericWater ? '清水' : '');
    if (waterName && !ing.some(x => WATER_TYPES.concat(['水']).some(w => x.name.includes(w)))) {
      ing.push({ name: waterName, amount: '适量' });
    }
  }
  // steps
  const steps = [];
  if (Array.isArray(o.steps)) {
    for (let i = 0; i < o.steps.length; i++) {
      const x = o.steps[i] || {};
      let t = String(x.text || x.step || '').trim();
      if (!t) continue;
      for (const w of BAD_WORDS) if (t.includes(w)) return null;
      steps.push({ stepNo: Number(x.stepNo) || (i + 1), text: t.slice(0, 100) });
    }
  }
  if (steps.length < 3) return null;
  // tips / review
  let tips = String(o.tips || '').trim().replace(/^["'「]|["'」]$/g, '').trim();
  let review = String(o.review || '').trim().replace(/^["'「]|["'」]$/g, '').trim();
  for (const w of BAD_WORDS) { if (tips.includes(w) || review.includes(w)) return null; }
  if (tips.length < 6 || review.length < 6) return null;
  tips = tips.slice(0, 60);
  // difficulty
  let difficulty = String(o.difficulty || '').trim();
  if (!DIFF_LEVELS.includes(difficulty)) difficulty = '一般';
  return { ingredients: ing, steps, tips, review, difficulty };
}

async function writeBack(doc, clean) {
  const guide = clean.steps.map(s => s.stepNo + '. ' + s.text).join(' ');
  const data = {
    ingredients: clean.ingredients,
    steps: clean.steps,
    guide,
    tips: clean.tips,
    review: clean.review,
    difficulty: clean.difficulty,
    consistencyRepairedAt: Date.now(),
  };
  if (doc._id) await db.collection('dish_mirror').doc(doc._id).update({ data });
  else await db.collection('dish_mirror').add({ data: Object.assign({ name }, data, { source: 'consistency-repair', genAt: Date.now() }) });
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({ data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() } });
  } catch (e) { /* */ }
}
