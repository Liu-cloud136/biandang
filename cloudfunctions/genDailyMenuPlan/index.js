// genDailyMenuPlan — 每日菜单剧本（阶段 2.2，AI 离线落库、白天请求路径零 AI）
// 每日 02:30（timer）：读 dish_profile.bestMonths（当月时令）+ profile.mealTime（场景分桶），
// hy3 编排 2~3 套今日菜单写 daily_menu（_id=CN 日期 YYYY-MM-DD）。
// 菜名必须校验在库（dish_lexicon 有效行 name 集合），无效菜名剔除、不达标的整套丢弃；
// 单轮生成失败自动重试（首轮 + 2 次重试，退避 4s/12s）；3 次全败写 daily_menu_fail 告警
// （_id=CN 日期）供巡检发现，仍不写剧本——出菜路径退普通查表红线不变（getRecommendation 读不到就退）。
// 写库铁律：wx-server-sdk doc(id).set({data}) 且 data 禁带 _id（-501007）；错误必须打日志。
//
// BUILD_TAG 约定：每次部署 bump 两处（本注释 + 下方 const），部署后 invoke 搜日志验证生效。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');
// BUILD_TAG: 2026-09-09.daily-menu-v2-retry
const BUILD_TAG = '2026-09-09.daily-menu-v2-retry';

const TEXT_MODEL = 'hy3';
let normLexName;
try { ({ normLexName } = require('./normLexName')); }
catch (e) { normLexName = (n) => String(n || '').trim().replace(/\s+/g, ' '); }

// 候选分桶上限（控制提示词规模；桶内随机抽，天然逐日变化）
const CAP = { breakfast: 40, dishes: 60, staples: 40, night: 25 };
// 每套剧本最低合格线（校验剔除无效菜名后的下限，不达标整套丢弃）
const PLAN_MIN = { breakfast: 1, dishes: 2, staples: 1, night: 1 };

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

async function fetchAll(col) {
  const out = [];
  for (let off = 0, g = 0; g < 40; g++) {
    const r = await db.collection(col).skip(off).limit(1000).get();
    out.push(...(r.data || []));
    if ((r.data || []).length < 1000) break;
    off += 1000;
  }
  return out;
}

// 时令候选按场景分桶。mealTime 取值口径与引擎一致：profile.mealTime 数组（早餐/午餐/晚餐/夜宵/…）。
function buildBuckets(rows, month) {
  const seasonal = rows.filter(r => Array.isArray(r.profile.bestMonths) && r.profile.bestMonths.indexOf(month) >= 0);
  // 时令池过小（当月标注缺失）时退全量池，保证剧本永远出得来
  const pool = seasonal.length >= 80 ? seasonal : rows;
  const mealOf = (r) => (Array.isArray(r.profile.mealTime) && r.profile.mealTime.length) ? r.profile.mealTime : [];
  const isStaple = (r) => r.kind === 'staple' || r.category === '主食';
  const isDrink = (r) => r.kind === 'drink' || r.category === '饮品';
  const b = {
    breakfast: pool.filter(r => mealOf(r).indexOf('早餐') >= 0 || isDrink(r)),
    dishes: pool.filter(r => !isStaple(r) && !isDrink(r) && (mealOf(r).indexOf('午餐') >= 0 || mealOf(r).indexOf('晚餐') >= 0)),
    staples: pool.filter(r => isStaple(r) && (mealOf(r).indexOf('午餐') >= 0 || mealOf(r).indexOf('晚餐') >= 0 || mealOf(r).indexOf('早餐') >= 0)),
    night: pool.filter(r => !isDrink(r) && mealOf(r).indexOf('夜宵') >= 0)
  };
  // 桶兜底：某桶为空则从池里放宽条件补位（宁可放宽也不给 AI 空桶）
  if (!b.dishes.length) b.dishes = pool.filter(r => !isStaple(r) && !isDrink(r));
  if (!b.staples.length) b.staples = pool.filter(isStaple);
  if (!b.breakfast.length) b.breakfast = pool.filter(r => isDrink(r) || isStaple(r));
  if (!b.night.length) b.night = pool.filter(r => isStaple(r) || r.category === '汤羹');
  return b;
}

function bucketPrompt(b) {
  const line = (r) => r.name + '｜' + (r.profile.main || '主料未标') + '｜' + (r.category || r.kind || '');
  return [
    '【早餐适用】\n' + shuffle(b.breakfast).slice(0, CAP.breakfast).map(line).join('\n'),
    '【正餐菜品（午/晚餐主菜）】\n' + shuffle(b.dishes).slice(0, CAP.dishes).map(line).join('\n'),
    '【主食】\n' + shuffle(b.staples).slice(0, CAP.staples).map(line).join('\n'),
    '【夜宵适用】\n' + shuffle(b.night).slice(0, CAP.night).map(line).join('\n')
  ].join('\n\n');
}

function buildPrompt(b) {
  return '今天是普通的一天，请从下面候选清单中编排 3 套「今日菜单」。每套含早餐/正餐/夜宵三餐：'
    + '早餐=1-2 道（饮品或主食为主）；正餐=2 道菜 + 1-2 道主食；夜宵=1-2 道。\n'
    + '硬性要求：①只能用候选清单里的菜名原文，一字不差，禁止自创菜名；②三套之间菜不重复，同套内菜品口味/主料不撞（如两道都是红烧、两道都含鸡蛋）；③荤素搭配、干稀搭配；④菜名按场景归属（早餐候选配早餐、正餐候选配正餐、夜宵候选配夜宵）。\n'
    + '只输出 JSON：{"plans":[{"title":"四字以内","items":[{"scene":"早餐","name":"…"},{"scene":"正餐","name":"…"},{"scene":"夜宵","name":"…"}]}]}\n\n'
    + bucketPrompt(b);
}

function parsePlans(txt, nameSet, stapleNameSet) {
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  let o;
  try { o = JSON.parse(m[0]); } catch (e) { return []; }
  const plans = Array.isArray(o.plans) ? o.plans : [];
  const out = [];
  plans.forEach(p => {
    if (!p || !Array.isArray(p.items)) return;
    const kept = [];
    p.items.forEach(it => {
      const name = String((it && it.name) || '').trim();
      const scene = String((it && it.scene) || '').trim();
      if (name && scene && nameSet.has(name)) kept.push({ scene: scene, name: name });
      else if (name) console.warn('[daily-plan] 剔除不在库菜名：' + scene + '/' + name);
    });
    const cnt = (s) => kept.filter(x => x.scene === s).length;
    // 正餐里主食条数：名字命中主食集合即算（AI 偶尔把主食归错场景时不至于整套丢弃）
    const stapleCnt = kept.filter(x => x.scene === '正餐' && stapleNameSet.has(x.name)).length;
    if (cnt('早餐') >= PLAN_MIN.breakfast && cnt('正餐') >= PLAN_MIN.dishes
      && stapleCnt >= PLAN_MIN.staples && cnt('夜宵') >= PLAN_MIN.night) {
      out.push({ title: String(p.title || '').slice(0, 8), items: kept });
    } else {
      console.warn('[daily-plan] 整套丢弃（有效菜不足）：title=' + (p.title || '?') + ' 早餐' + cnt('早餐') + ' 正餐' + cnt('正餐') + ' 主食' + stapleCnt + ' 夜宵' + cnt('夜宵'));
    }
  });
  return out.slice(0, 3);
}

async function genText(messages) {
  const r = await textModel.generateText({ model: TEXT_MODEL, messages: messages, temperature: 0.8, maxTokens: 2500 });
  const t = r && r.text;
  if (!t) throw new Error('AI 空返回');
  return t;
}

// 单轮完整生成（读库→分桶→hy3→校验→写库）。成功返回套数；任一环节失败 throw，交由 main 重试。
async function runOnce(dateStr, month) {
  const [lex, prof] = await Promise.all([fetchAll('dish_lexicon'), fetchAll('dish_profile')]);
  const profMap = {};
  prof.forEach(p => { profMap[p.name || p._id] = p.profile || {}; });
  const nameSet = new Set();
  const rows = [];
  lex.forEach(d => {
    if (!d || !d.name || d.valid === false) return;
    nameSet.add(d.name);
    rows.push({ name: d.name, kind: d.kind || '', category: d.category || '', profile: profMap[d.name] || {} });
  });
  if (rows.length < 100) throw new Error('在库菜过少 rows=' + rows.length);

  const b = buildBuckets(rows, month);
  const sizes = { breakfast: b.breakfast.length, dishes: b.dishes.length, staples: b.staples.length, night: b.night.length };
  console.log('[daily-plan] day=' + dateStr + ' month=' + month + ' buckets=' + JSON.stringify(sizes));
  const stapleNameSet = new Set(b.staples.map(r => r.name));

  const txt = await genText([
    { role: 'system', content: '你是中餐菜单编排师，只输出 JSON，不输出任何解释。' },
    { role: 'user', content: buildPrompt(b) }
  ]);
  const plans = parsePlans(txt, nameSet, stapleNameSet);
  if (!plans.length) throw new Error('AI 返回无合格剧本');
  console.log('[daily-plan] 合格剧本 ' + plans.length + ' 套：' + plans.map(p => p.title).join(' / '));

  // 写库：doc id=CN 日期；data 禁带 _id；同日重跑覆盖（幂等）
  await db.collection('daily_menu').doc(dateStr).set({
    data: { date: dateStr, month: month, plans: plans, source: 'hy3', model: TEXT_MODEL, poolSizes: sizes, generatedAt: Date.now() }
  });
  console.log('[daily-plan] ✅ daily_menu/' + dateStr + ' 已写入');
  return plans.length;
}

// 多次重试仍失败 → 写 daily_menu_fail 告警（_id=CN 日期，幂等覆盖），供 Armbian 巡检发现补跑
async function writeFailAlert(dateStr, lastErr, attempts) {
  try {
    await db.collection('daily_menu_fail').doc(dateStr).set({
      data: { date: dateStr, err: String(lastErr || '').slice(0, 300), attempts: attempts, failedAt: Date.now() }
    });
    console.error('[daily-plan] ⚠ 已写 daily_menu_fail/' + dateStr + ' err=' + String(lastErr || '').slice(0, 120));
  } catch (e) {
    console.error('[daily-plan] 写 daily_menu_fail 告警失败（非致命）：', (e && e.message) || e);
  }
}

exports.main = async (event) => {
  console.log('[build] genDailyMenuPlan BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'timer'));
  if (event && event.action === 'buildInfo') return { code: 200, build: BUILD_TAG };
  const cn = new Date(Date.now() + 8 * 3600 * 1000);
  const dateStr = cn.toISOString().slice(0, 10);
  const month = Number(dateStr.slice(5, 7));

  // 首轮 + 最多 2 次重试（退避 4s / 12s）；仍失败 → 写告警 + 退普通查表（红线：绝不阻塞出菜）
  const MAX_ATTEMPTS = 3;
  const WAIT_MS = [4000, 12000];
  let lastErr = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const n = await runOnce(dateStr, month);
      return { code: 200, date: dateStr, plans: n, attempts: attempt, build: BUILD_TAG };
    } catch (e) {
      lastErr = String((e && e.message) || e);
      console.error('[daily-plan] 第 ' + attempt + '/' + MAX_ATTEMPTS + ' 次失败：' + lastErr);
      if (attempt < MAX_ATTEMPTS) {
        const wait = WAIT_MS[attempt - 1] || 5000;
        console.log('[daily-plan] ' + wait + 'ms 后重试...');
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  await writeFailAlert(dateStr, lastErr, MAX_ATTEMPTS);
  return { code: 500, date: dateStr, msg: lastErr, attempts: MAX_ATTEMPTS, build: BUILD_TAG };
};
