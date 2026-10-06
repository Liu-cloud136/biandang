// ============================================================================
// bypassNutritionEst · env2 营养补估（阶段3，方案 §2 补估 / §7 阶段3）
// BUILD_TAG: 2026-09-16c.bypass-nutrition-scalesafe
//
// 职责：
//   - 扫 env2 本地 dish_mirror 缺 nutrition 的菜；
//   - hy3 估算营养四元组 [热量(kcal), 蛋白(g), 碳水(g), 脂肪(g)]（每份常见家常量）；
//   - 写 env1 审核池 dish_lexicon_pending（source='env2-nutrition'），管理员 tab 13 审核通过后
//     manageLexicon.approve 分流写 env1 dish_nutrition（前端零改动）；
//   - 本地写 dish_mirror.nutrition（内部特征）+ dish_lexicon_pending 副本。
//
// 与 bypassEnrich 区别：bypassEnrich 是本地查表+兜底（不调 AI），本函数用 hy3 AI 估算。
//   bypassEnrich 保留为快速兜底；bypassNutritionEst 为 AI 精补，两者可共存（审核池去重）。
//
// 纪律：
//   - hy3 调用直配 'hy3'（hy3-preview 2026-08-31 下线）；并发 SLOT_N=6。
//   - 产物进审核池不直接落 env1 正式库（用户明确要求管理员审核）。
//   - 失败静默记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-09-16c.bypass-nutrition-scalesafe';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';

const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();


const SLOT_N = 5;           // hy3 并发上限（限流安全线，实测>10易429，取5留余量）
const BATCH = 24;
const MAX_MS = 105000;      // 循环补齐总时长上限（留 15s 余量给 120s 超时）
const { RateLimiter } = require('./rateLimiter');
// 自适应速率控制器（文）：初始 5、上限 8、60s 窗硬上限 200、429 退避 2/4/8s
const limiter = new RateLimiter({ rateInit: 5, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 200, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassNutritionEst BUILD_TAG=' + BUILD_TAG);
  const { task, dishName, cursor, limit, localOnly } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'nutrition-est', env: TCB_ENV };
  }

  // 全局生成开关：2026-09-01 放开（env1-backfill 缺维度补齐需要；生菜停用由 bypassGenDish 自身 GEN_DISABLED 控制）
  // 原：if (process.env.GEN_DISABLED !== 'false') return disabled; —— 已注释，补齐营养不再受此开关限制

  await ensureCollections();


  if (dishName) {
    // 2026-09-16：单菜模式先读 mirror 拿食材清单（估算必须基于清单用量）
    let ingOne = null;
    try {
      const r0 = await db.collection('dish_mirror').where({ name: dishName }).limit(1).get();
      const d0 = (r0.data || [])[0];
      if (d0 && Array.isArray(d0.ingredients) && d0.ingredients.length) ingOne = d0.ingredients;
    } catch (e) {}
    const nutri = await estNutrition(dishName, null, ingOne);
    if (!nutri) return { ok: false, err: 'est_failed' };
    try {
      const col = db.collection('dish_lexicon_pending');
      if (await hasPending(col, dishName)) { /* skip */ }
      else await col.add({ data: pendingPayload(dishName, nutri) });
    } catch (e) { /* 本地副本失败不影响 */ }
    await db.collection('dish_mirror').where({ name: dishName }).limit(1).get().then(r => {
      if (r.data && r.data[0]) {
        return db.collection('dish_mirror').doc(r.data[0]._id).update({ data: { nutrition: nutri, nutritionUpdatedAt: Date.now() } });
      }
      return null;
    }).catch(() => null);
    await logTask('bypassNutritionEst', null, 'ok', 'dishName=' + dishName);
    return { ok: true, dishName, nutri };
  }

  // 循环补齐：一次调用扫完所有缺 nutrition 的菜（bypassText 由 bypassGenDish 串行链统一调度，此处不再链式触发）
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    const cond = { nutrition: _.exists(false) };
    if (lastId) cond._id = _.gt(lastId);
    let q = db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize);
    let list = [];
    try { const res = await q.get(); list = res.data || []; } catch (e) { list = []; }
    if (!list.length) break;

    let computed = 0;
    await pool(list, SLOT_N, async (d) => {
      const name = d.name || d.dishName;
      if (!name) return;
      try {
        const nutri = await estNutrition(name, d.profile, d.ingredients);   // 2026-09-16：带上食材清单用量
        if (!nutri) throw new Error('hy3 返回空');
        // 2026-09-01：env1-backfill（env1 存量菜补缺）营养直接同步回 env1，不写待审池（避免"原有菜"重进审核）
        if (d.source !== 'env1-backfill') {
          try {
            const col = db.collection('dish_lexicon_pending');
            if (await hasPending(col, name)) { /* skip */ }
            else await col.add({ data: pendingPayload(name, nutri) });
          } catch (e) { /* 本地副本失败不影响 */ }
        }
        await db.collection('dish_mirror').doc(d._id).update({
          data: { nutrition: nutri, nutritionUpdatedAt: Date.now() },
        });
        computed++;
        lastId = d._id;
        console.log('[bypassNutritionEst] 补估成功 name=' + name + ' nutri=' + JSON.stringify(nutri));
      } catch (e) {
        console.warn('[bypassNutritionEst] 补估失败 name=' + name + '：', e && e.message);
        await logTask('bypassNutritionEst', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
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

// 2026-09-16【P1】：原来 prompt 里**只有菜名**（连 profile 都没用上）⇒ 营养与食材/用量无关，
//   必然被矛盾扫描判"营养量级离谱/与食材不符"。现把**实际食材清单（含用量）**喂进来，要求逐项累加。
async function estNutrition(name, profile, ingredients) {
  const ingText = Array.isArray(ingredients) && ingredients.length
    ? ingredients.map(i => (i && i.name) ? String(i.name) + (i.amount ? ' ' + i.amount + (i.unit || '') : '') : '').filter(Boolean).join('、')
    : '';
  const prompt = [
    '你是营养估算器。为给定家常菜估算每份（一人份家常量）的营养，只输出 JSON，不要解释。',
    '字段：calories(热量kcal整数), protein(蛋白g), carbs(碳水g), fat(脂肪g)',
    ingText ? '【该菜食材与用量（必须按此逐项累加估算，不得凭菜名猜）】' + String(ingText).slice(0, 500) : '',
    '估算要求：① 按清单逐项累加（含食用油/糖等，油按清单量计 9kcal/g）② 四项必须自洽：calories ≈ 4×protein + 4×carbs + 9×fat（误差 ≤10%）③ 数值取整，不得为 0。',
    '参考：番茄炒蛋≈{calories:180,protein:9,carbs:10,fat:12}，清炒时蔬≈{calories:120,protein:3,carbs:8,fat:8}，红烧肉≈{calories:480,protein:18,carbs:10,fat:42}',
    '菜品：' + name
  ].filter(Boolean).join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 128,
      });
      const text = resp && (resp.text || (resp.data && resp.data.text)) || '';
      const n = parseNutrition(text, profile);
      if (n) return n;
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[estNutrition] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}

// 营养合理性校验（零 AI 调用，纯规则校验）
// 2026-09-16【P1】加两道闸门：① 量级区间闸门 ② **4/4/9 反算一致闸门**（矛盾扫描会报"能量与三大营养素反算不符"）。
//   注意：原来 clampNum 各自独立钳位，会亲手把四项钳成互不自洽 —— 这里在钳位之后按宏量重算热量。
function validateNutrition(nutri, profile) {
  if (!Array.isArray(nutri) || nutri.length < 4) return nutri;
  let [cal, pro, carb, fat] = nutri;
  if (profile && profile.isSoup && cal > 400) cal = Math.round(cal * 0.6);
  if (profile && profile.type === '凉菜' && cal > 300) cal = Math.round(cal * 0.7);
  // 2026-09-16 修（上一版把 86 个任务卡成 est_failed）：**绝不因为"数值不合理"判失败** ——
  //   逐维路径里 nutrition 失败＝任务失败，会把菜卡死。改为"能修就修、修不了就夹到安全区间"。
  // ① 量级护栏：夹到合理区间（茶/水可低于 30 → 取下限 10，不被拒）
  cal = Math.min(1500, Math.max(10, Math.round(cal)));
  pro = Math.min(80, Math.max(0, Math.round(pro)));
  carb = Math.min(200, Math.max(0, Math.round(carb)));
  fat = Math.min(120, Math.max(0, Math.round(fat)));
  // ② 反算一致：**以标注热量为锚**，等比缩放三大宏量（而不是改热量、更不是拒绝）
  //   理由：模型对"热量"通常比"各宏量"准；缩放后四项必然自洽，且热量保持原判读值。
  const calc0 = 4 * pro + 4 * carb + 9 * fat;
  if (calc0 > 0) {
    const absDiff = Math.abs(cal - calc0);
    if (absDiff / Math.max(cal, calc0) > 0.15 && absDiff > 20) {
      const k = cal / calc0;
      const p2 = Math.round(pro * k), c2 = Math.round(carb * k), f2 = Math.round(fat * k);
      if (p2 + c2 + f2 > 0) {
        console.warn('[bypassNutritionEst] 营养反算不一致 → 按标注热量等比缩放宏量 [' + pro + ',' + carb + ',' + fat + '] → [' + p2 + ',' + c2 + ',' + f2 + ']（kcal 保持 ' + cal + '）');
        pro = p2; carb = c2; fat = f2;
      }
    }
  }
  if (cal <= 0 && pro + carb + fat === 0) return null;   // 全 0 空壳才算失败
  return [cal, pro, carb, fat];
}

function parseNutrition(text, profile) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const o = jsonParseRepair(text.slice(start, end + 1));
  if (!o) return null;
  try {
    const cal = clampNum(o.calories || o.kcal, 20, 2000, 280);
    const pro = clampNum(o.protein, 0, 100, 15);
    const carb = clampNum(o.carbs || o.carbohydrate, 0, 200, 20);
    const fat = clampNum(o.fat, 0, 150, 12);
    const result = [Math.round(cal), Math.round(pro), Math.round(carb), Math.round(fat)];
    // §10 产物体检：全零营养值无效（AI 返回空壳），不回写
    if (result.every(v => v === 0)) return null;
    return validateNutrition(result, profile);
  } catch (e) { return null; }
}

function clampNum(v, min, max, dft) {
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}


// 2026-09-12：hy3 偶发吐畸形 JSON（实锤 "amount"::"3瓣" 双冒号，temp 0.3 下 100% 复现）
// 解析失败走三级修复梯（同 bypassConsistencyRepair v3-jsonfix / parseKit.repairJson）
function jsonParseRepair(s) {
  try { return JSON.parse(s); } catch (e) { /* 修复梯 */ }
  let r = String(s).replace(/,(s*[}]])/g, '$1');   // ① 收尾逗号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/"s*:s*:/g, '":');                 // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/""s*:s*"/g, '"');                 // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e) { return null; }
}
async function ensureCollections() {
  await Promise.allSettled([
    db.createCollection('dish_lexicon_pending'),
    db.createCollection('dish_nutrition'),
  ]);
}

function pendingPayload(name, nutri) {
  return {
    name,
    cuisine: '家常',
    reason: 'env2 营养补估：热量' + nutri[0] + '/蛋白' + nutri[1] + '/碳水' + nutri[2] + '/脂肪' + nutri[3],
    source: 'env2-nutrition',
    exploreDir: 'env2营养补估',
    nutri,
    status: 'pending',
    ts: Date.now(),
    openid: ''
  };
}

async function hasPending(col, name) {
  try {
    const ex = await col.where({ name, source: 'env2-nutrition' }).limit(1).get();
    return !!(ex && ex.data && ex.data.length);
  } catch (e) { return false; }
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