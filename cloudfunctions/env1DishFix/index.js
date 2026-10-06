// ============================================================================
// env1DishFix · env1 侧点状小修救援（2026-09-09，规划一期 v1）
// BUILD_TAG: 2026-09-09.env1-dishfix-patch-v2
//
// 定位：env1 自己的 hy3 出文做「最小补丁」直修（点状：单位/用量/漏调料/贴士单句/
//       点评用词/单步文本），结构性多维矛盾仍走 env2 一致性引擎（bypassConsistencyRepair）。
// 调度在 Armbian review-web（pumpEnv1Fix）；本函数是"出文 + 受管写"的原子执行单元：
//   event = { dishName, issues:[{dim,problem}] }
//   1) 读 env1 分表现状 → 拼问题
//   2) hy3 一次出"最小 patch JSON"（带原数组索引，仅改有问题处）
//   3) 白名单自检（双单位防护/BAD_WORDS/长度/结构）→ 备份原值到 dish_patch_backup → 直写 env1
//   4) 返回 { ok, fields:{changed:{...}}, summary }
// ============================================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 90000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');

const BUILD_TAG = '2026-09-13.env1-dishfix-profile-main';
const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '抽烟', '饮酒', 'hei', '果子狸', '穿山甲', '蝙蝠'];
// 量词工具（模块级，2026-09-09）：
// amount 内双写单位归一：'2勺勺'→'2勺'、'50克克'→'50克'（只去重保留原单位字，绝不改成'个'）
const normAmount = (v) => String(v == null ? '' : v).trim().replace(/(勺|汤匙|茶匙|克|毫升|升|碗|杯|个|根|段|把|朵|瓣|片|只|条|枚|粒|张)\1+/g, '$1');
// 量词体系类别：1=液态/酱/粉（勺克毫升碗杯），2=可数固体（个根片…），0=无/适量
const catOf = (v) => { const s = String(v || ''); return /勺|克|千克|毫升|升|汤匙|茶匙|碗|杯/.test(s) ? 1 : (/个|根|段|把|朵|瓣|片|只|条|枚|粒|张/.test(s) ? 2 : 0); };
const DIFF_LEVELS = ['简单', '一般', '较难'];
// 步骤文本出现而清单漏列的常用调料（仅当本次问题涉食材维度时自动补列）
const CONDS = ['干辣椒', '八角', '香叶', '花椒', '胡椒粉', '白胡椒粉', '豆瓣酱', '黄豆酱', '蚝油', '料酒', '生抽', '老抽', '淀粉', '香油', '酱油', '鸡精', '味精', '醋', '姜', '蒜', '葱', '盐', '糖'];

function normName(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
async function getByWhere(col, name) {
  try { const r = await db.collection(col).where({ name }).limit(1).get(); return (r.data && r.data[0]) || null; } catch (e) { return null; }
}
async function saveDoc(col, doc, data) {
  // env1 云函数 wx-server-sdk：doc(id).set 必须 { data: {...} }（裸对象会报 parameter.data 缺失）
  if (doc && doc._id) await db.collection(col).doc(doc._id).set({ data: Object.assign({}, data) });
  else await db.collection(col).add({ data });
}
function fmtIng(x) { return String(x && x.name || '') + (x.amount ? ' ' + x.amount + (x.unit || '') : ''); }
function ingText(list) { return (Array.isArray(list) ? list : []).map((x, i) => (i + 1) + '.' + fmtIng(x)).join('，'); }
function stepText(list) { return (Array.isArray(list) ? list : []).map(x => (x.stepNo || '') + '. ' + String(x.text || '')).join('\n'); }
function escIngField(x, i) { return { index: i, name: String(x.name || ''), amount: String(x.amount || '适量').trim(), unit: String(x.unit || '').trim() }; }

exports.main = async (event) => {
  console.log('[build] env1DishFix BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { task, dishName, issues } = event || {};
  if (task === 'health') return { ok: true, build: BUILD_TAG, mode: 'patch', env: TCB_ENV };
  if (task === 'selftest') {
    // 量词归一/保护逻辑自测（不碰库），2026-09-09：香油 2勺勺 必须归为 2勺，绝不能变成 2个
    const cs = ['2勺勺', '50克克', '1汤匙汤匙', '2个', '3片', '适量'];
    const exp = ['2勺', '50克', '1汤匙', '2个', '3片', '适量'];
    const cases = cs.map((a, i) => ({ in: a, out: normAmount(a), expect: exp[i], ok: normAmount(a) === exp[i] }));
    const protect = { liq2cnt: catOf('2勺') === 1 && catOf('2个') === 2, none: catOf('适量') === 0 };
    return { ok: cases.every(x => x.ok) && protect.liq2cnt && protect.none, build: BUILD_TAG, cases, protect };
  }
  if (!dishName) return { ok: false, err: 'dishName 缺失' };
  const name = normName(dishName);
  return await patchOne(name, issues);
};

async function patchOne(name, issues) {
  const issueText = (Array.isArray(issues) && issues.length)
    ? issues.map(i => '[' + ((i && i.dim) || '其他') + '] ' + ((i && (i.problem || i.desc)) || '')).join('；').slice(0, 1400)
    : '';
  if (!issueText) return { ok: false, err: '无问题描述' };

  // 读现状
  const lex = await getByWhere('dish_lexicon', name);
  const ingD = await getByWhere('dish_ingredients', name);
  const stpD = await getByWhere('dish_steps', name);
  const tipD = await getByWhere('dish_tips', name);
  const revD = await getByWhere('dish_review', name);
  const ings = Array.isArray(ingD && ingD.ingredients) ? ingD.ingredients : [];
  const steps = Array.isArray(stpD && stpD.steps) ? stpD.steps : [];
  const tips = String(tipD && tipD.tips || '');
  const review = String(revD && revD.review || '');
  const diff = String(revD && revD.difficulty || '');
  const cat = String((lex && lex.category) || '');

  // ── 确定性预修：画像主料名实不符（2026-09-13，酱爆螺蛳教训）──
  // hy3 点状补丁 schema 不含 profile 键 → 画像维病灶永远修不到、复扫反复 fail。
  // 规则：问题涉画像/主料（dim=profile 或文案命中）时，主料直接取食材清单前 1~2 个
  // 非调料条目名（与 approve 侧主料口径一致），与现值不同即受管写 + 备份。
  const profileIssue = (Array.isArray(issues) ? issues : []).some(i => i && ((String(i.dim || '') === 'profile') || /画像|主料/.test(String((i && (i.problem || i.desc)) || ''))));
  if (profileIssue && ings.length) {
    try {
      const profD = await getByWhere('dish_profile', name);
      const prof = profD && profD.profile;
      if (prof && typeof prof === 'object') {
        const SEASON = CONDS.concat(['水淀粉', '高汤', '清水', '温水', '开水', '食用油', '花生油', '色拉油', '植物油', '猪油', '葱姜水', '蛋液']);
        const isSeason = (nm) => SEASON.some(t => nm === t || nm.includes(t));
        const mains = [];
        for (const x of ings) {
          const nm = String(x && x.name || '').replace(/\s/g, '');
          if (!nm || nm.length < 2 || isSeason(nm)) continue;
          mains.push(nm);
          if (mains.length >= 2) break;
        }
        const newMain = mains.join('、');
        if (newMain && newMain !== String(prof.main || '')) {
          await db.collection('dish_patch_backup').add({ data: { name, at: Date.now(), profileMainOld: prof.main } });
          await saveDoc('dish_profile', profD, { name, profile: Object.assign({}, prof, { main: newMain }), ts: Date.now() });
          console.log('[env1DishFix] ✓ profile.main 确定性修正 ' + name + ': ' + prof.main + ' → ' + newMain);
          return { ok: true, name, changed: ['profile.main'], summary: 'profile.main ' + prof.main + '→' + newMain };
        }
        // 主料已一致 → 画像问题已消，继续走正常 AI patch 修其他维度
      }
    } catch (e) { console.warn('[env1DishFix] profile 预修异常 ' + name + ' ' + ((e && e.message) || e)); }
  }

  const content = '菜品：' + name + (cat ? '（类别：' + cat + '）' : '') + '\n'
    + '【当前食材清单（含下标）】' + (ings.length ? ings.map((x, i) => '[' + i + '] ' + fmtIng(x)).join('、') : '（无）') + '\n'
    + '【当前步骤】\n' + (steps.length ? stepText(steps) : '（无）') + '\n'
    + '【当前贴士】' + (tips || '（无）') + '\n'
    + '【当点评语】' + (review || '（无）') + (diff ? '（难度：' + diff + '）' : '')
    + '\n\n【上轮复核指出问题，只修这些，做最小改动】\n' + issueText
    + '\n\n【最小补丁要求】\n'
    + '1. 只输出一个 JSON 对象，只包含需要修改的键；没问题的维度一律不要输出。\n'
    + '2. 结构：{"ingredients":[{"index":下标,"name":"","amount":"","unit":""}],"steps":[{"stepNo":N,"text":"该步新文本"}],"tips":"整句新贴士","review":"整句新点评","difficulty":"简单|一般|较难"}。\n'
    + '3. ingredients 用原数组下标(index)指向被改条目；只修问题点（如 1勺→改 amount，单位问题 amount 已含"勺"就不要 unit）；如需补漏调料可新增条目 index=新。\n'
    + '4. steps 用 stepNo 指向要改的步骤只改文本；贴士/点评问题则整句替换，须与步骤一致（下料时机/火候/口感/辣度）。\n'
    + '5. 改后不得引入新问题：amount 含单位字(勺/克/毫升/个等)就不要再写 unit（防"1勺勺"）；量词保留原体系——香油/料酒/酱油/醋/淀粉等仍用勺/克/毫升/碗计，不得改成「个」，「个」仅限可数固体(蛋/土豆/西红柿)。\n'
    + '6. 难度/点评/贴士风格保持原味；不要添加本菜没有的操作。\n'
    + '只返回 JSON，不要解释与代码围栏。';

  const messages = [
    { role: 'system', content: '你是家常菜谱校对专家，负责对菜谱做**最小补丁**修改。严格只输出一个 JSON 对象，不要 markdown 代码围栏、不要 ```json 标记。' },
    { role: 'user', content },
  ];

  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.3, maxTokens: 2000 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      if (!text) throw new Error('GEN:空输出');
      const obj = parseObj(text);
      if (!obj) throw new Error('PARSE:JSON 解析失败');
      const merged = await applyPatch(name, ingD, stpD, tipD, revD, ings, steps, tips, review, diff, obj);
      if (!merged) throw new Error('EMPTY:补丁自检未过（无有效改动）');
      console.log('[env1DishFix] ✓ patch 成功 ' + name + ' changed=' + JSON.stringify(merged.changed));
      return { ok: true, name, changed: merged.changed, summary: merged.changed.join('/') };
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 150);
      console.warn('[env1DishFix] 第' + (attempt + 1) + '次失败 ' + name + ' ' + lastErr + ' stack=' + String((e && e.stack) || e).slice(0, 300));
      if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  console.warn('[env1DishFix] 最终失败 ' + name + ' ' + lastErr);
  return { ok: false, err: lastErr, name };
}

function parseObj(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const st = s.indexOf('{'); const en = s.lastIndexOf('}');
  if (st >= 0 && en > st) s = s.slice(st, en + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

async function applyPatch(name, ingDoc, stpDoc, tipDoc, revDoc, ingOld, stepsOld, tipsOld, reviewOld, diffOld, patch) {
  const changed = [];
  const writes = [];
  const backup = { name, at: Date.now() };
  const unitDup = (amount) => /勺|克|毫升|升|汤匙|茶匙|碗|杯|个|根|段|把|朵|瓣|片|只|条|枚|粒|张/.test(String(amount || ''));
  const stepsTextAll = (Array.isArray(stepsOld) ? stepsOld : []).map(x => String(x.text || '')).join(' ');

  // 食材（补丁带原下标 → 最小合并）
  if (patch && Array.isArray(patch.ingredients) && patch.ingredients.length) {
    const arr = (Array.isArray(ingOld) ? ingOld : []).map(x => Object.assign({}, x));
    for (const it of patch.ingredients) {
      if (!it) continue;
      if (typeof it.index === 'number' && arr[it.index]) {
        const t = arr[it.index];
        if (it.name !== undefined) t.name = normName(String(it.name));
        if (it.amount !== undefined) {
          const na = normAmount(it.amount) || '适量';
          const oldA = String(t.amount || '').trim();
          // 量词体系保护：勺/克/毫升/碗等液态酱粉类不得被改成「X个」（香油 2勺勺 → 2勺 ✓ 而非 2个，2026-09-09）
          if (oldA && oldA !== '适量' && catOf(oldA) === 1 && catOf(na) === 2) {
            changed.push('ingredients#' + it.index + '量词保护(仍' + oldA + ')');
          } else {
            t.amount = na;
            if (it.unit !== undefined) { if (it.unit) t.unit = String(it.unit).trim(); else delete t.unit; }
          }
        } else if (it.unit !== undefined) { if (it.unit) t.unit = String(it.unit).trim(); else delete t.unit; }
        if (t.unit && unitDup(t.amount)) delete t.unit;   // 双单位防护
      } else if (it.name && String(it.name).trim().length >= 2) {
        const nm = normName(String(it.name)).slice(0, 12);
        if (nm.length >= 2) {
          const amount = String(it.amount || '').trim() || '适量';
          const item = { name: nm, amount };
          if (it.unit && !unitDup(amount)) item.unit = String(it.unit).trim();
          arr.push(item);
        }
      }
    }
    const clean = [];
    const seen = new Set();
    for (const x of arr) {
      const nm = String(x && x.name || '').replace(/\s/g, '');
      if (!nm || nm.length < 2 || nm.length > 12 || seen.has(nm)) continue;
      if (BAD_WORDS.some(w => nm.includes(w))) continue;
      seen.add(nm);
      const amount = normAmount(x.amount) || '适量';
      const item = { name: nm, amount };
      if (x.unit && !unitDup(amount)) item.unit = String(x.unit).trim();
      clean.push(item);
    }
    // 步骤文本出现而清单漏列的常用调料自动补列
    if (stepsTextAll) {
      for (const cd of CONDS) {
        if (!stepsTextAll.includes(cd)) continue;
        if (clean.some(x => x.name.includes(cd) || (cd.includes(x.name) && x.name.length < cd.length))) continue;
        clean.push({ name: cd, amount: '适量' });
        if (clean.length > 40) break;
      }
    }
    if (JSON.stringify(clean) !== JSON.stringify(ingOld)) {
      backup.ingredientsOld = ingOld;
      writes.push(() => saveDoc('dish_ingredients', ingDoc, { name, ingredients: clean, ts: Date.now() }));
      changed.push('ingredients');
    }
  }

  // 步骤：仅按 stepNo 改文本后整字段写回
  if (patch && Array.isArray(patch.steps) && patch.steps.length) {
    const arr = (Array.isArray(stepsOld) ? stepsOld : []).map(x => Object.assign({}, x));
    for (const it of patch.steps) {
      const t = (it && it.text !== undefined && String(it.text).trim()) ? String(it.text).trim().slice(0, 100) : '';
      if (!t || BAD_WORDS.some(w => t.includes(w))) continue;
      const idx = arr.findIndex(x => Number(x.stepNo) === Number(it.stepNo));
      if (idx >= 0) arr[idx].text = t;
    }
    const clean = arr.filter(x => x && String(x.text || '').trim()).map((x, i) => ({ stepNo: Number(x.stepNo) || (i + 1), text: String(x.text).trim() }));
    if (clean.length >= 3 && JSON.stringify(clean) !== JSON.stringify(stepsOld)) {
      backup.stepsOld = stepsOld;
      writes.push(() => saveDoc('dish_steps', stpDoc, { name, steps: clean, ts: Date.now() }));
      changed.push('steps');
    }
  }

  // tips
  if (patch && patch.tips !== undefined) {
    const t = String(patch.tips).trim().replace(/^["'「]|["'」]$/g, '').slice(0, 60);
    if (t && t.length >= 6 && !BAD_WORDS.some(w => t.includes(w)) && t !== tipsOld) {
      backup.tipsOld = tipsOld;
      writes.push(() => saveDoc('dish_tips', tipDoc, { name, tips: t, ts: Date.now() }));
      changed.push('tips');
    }
  }
  // review + difficulty
  if (patch && patch.review !== undefined) {
    const rv = String(patch.review).trim().replace(/^["'「]|["'」]$/g, '').slice(0, 80);
    if (rv && rv.length >= 6 && !BAD_WORDS.some(w => rv.includes(w)) && rv !== reviewOld) {
      backup.reviewOld = reviewOld;
      const data = { name, review: rv, ts: Date.now() };
      const d2 = patch.difficulty !== undefined && DIFF_LEVELS.includes(String(patch.difficulty).trim()) ? String(patch.difficulty).trim() : diffOld;
      if (d2) data.difficulty = d2;
      writes.push(() => saveDoc('dish_review', revDoc, data));
      changed.push('review' + (d2 !== diffOld ? '+difficulty' : ''));
    }
  }

  if (!writes.length || !changed.length) return null;
  try { await db.collection('dish_patch_backup').add({ data: backup }); } catch (e) { console.warn('[env1DishFix] 备份失败 ' + name + ' ' + (e && e.message)); }
  for (const w of writes) await w();
  return { changed };
}
