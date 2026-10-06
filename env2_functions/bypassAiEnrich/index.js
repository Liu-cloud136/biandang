// ============================================================================
// bypassAiEnrich · env2 候菜 AI 增强（阶段1，方案 §7 阶段1）
// BUILD_TAG: 2026-09-16.bypass-ai-enrich-mainalign
//
// 职责（方案 v3 §2 候菜 AI 增强 / AI-1 菜品画像 + AI-2 偏好解析）：
//   AI-1 菜品画像：扫 env2 本地 dish_mirror，为缺 profile 的菜用 hy3 生成结构化画像
//          （spicy/flavors/cuisine/type/main/isVeg/isSoup），写回 dish_mirror.profile。
//   AI-2 偏好解析：扫 env2 本地 prefs_mirror，为用户偏好快照用 hy3 解析结构化偏好画像
//          （spicy/likeFlavors/likeCuisines/likeTypes/avoid/likeMeat/likeStaple），写回 prefs_mirror.profile。
//   AI-3 匹配打分：在 bypassCandidate.rankCandidates 消费两份画像叠加偏好命中（另一函数内做）。
//
// 纪律：
//   - 画像仅存 env2 本地镜像集合（dish_mirror/prefs_mirror 的 profile 字段），
//     是内部排序特征、不直接展示给用户；最终候选列表才回写 env1 recommend_cache。
//   - hy3 调用直配 'hy3'（hy3-preview 2026-08-31 下线）；并发限 SLOT_N=6（上游≈12，留余量）。
// ============================================================================

const BUILD_TAG = '2026-09-16.bypass-ai-enrich-mainalign';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';

const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();

const SLOT_N = 5;           // hy3 并发上限（限流安全线，实测>10易429，取5留余量）
const BATCH = 24;           // 每批处理条数
const MAX_MS = 105000;      // 循环补齐总时长上限（留 15s 余量给 120s 超时）
const RECALC_MS = 30 * 24 * 3600 * 1000;  // §7.2 画像过期重算阈值：30 天
const { RateLimiter } = require('./rateLimiter');
const parseKit = require('./parseKit');
// 自适应速率控制器（文）：初始 5、上限 8、60s 窗硬上限 200、429 退避 2/4/8s
const limiter = new RateLimiter({ rateInit: 5, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 200, successK: 10, backoffBase: 2000, backoffMax: 8000 });

exports.main = async (event) => {
  console.log('[build] bypassAiEnrich BUILD_TAG=' + BUILD_TAG);
  const { task, cursor, limit, dishName } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'ai-enrich', env: TCB_ENV };
  }

  // 全局生成开关：2026-09-01 放开（env1-backfill 缺维度补齐需要；生菜停用由 bypassGenDish 自身 GEN_DISABLED 控制）
  // 原：if (process.env.GEN_DISABLED !== 'false') return disabled; —— 已注释，补齐画像不再受此开关限制

  // 单菜画像重算（dishRegenPoll 驳回重生成专用，env2 本地调用）
  if (dishName) {
    try {
      // 2026-09-16【P2】：把食材清单喂给画像生成 → main 必须取自清单（原来只看菜名猜，常与清单不符被判定侧打回）
      const r0 = await db.collection('dish_mirror').where({ name: dishName }).limit(1).get();
      const d0 = (r0 && r0.data && r0.data[0]) || null;
      const ingOne = d0 && Array.isArray(d0.ingredients)
        ? d0.ingredients.map(i => (i && i.name) ? String(i.name) : '').filter(Boolean).join('、') : '';
      const profile = await genDishProfile(dishName, ingOne);
      if (!profile) return { ok: false, err: 'dish_profile_empty', dishName };
      const res = await db.collection('dish_mirror').where({ name: dishName }).limit(1).get();
      const d = (res && res.data && res.data[0]);
      const updateData = { profile, aiUpdatedAt: Date.now() };
      if (d && d.mealTime && Array.isArray(d.mealTime) && d.mealTime.length) {
        profile.mealTime = d.mealTime;
        updateData.mealTime = d.mealTime;
      } else if (profile.mealTime && profile.mealTime.length) {
        if (profile.type === '小吃') profile.mealTime = ['小吃'];
        else if (profile.type === '饮品') profile.mealTime = ['小吃', '下午茶'];
        updateData.mealTime = profile.mealTime;
      }
      if (d && d._id) {
        await db.collection('dish_mirror').doc(d._id).update({ data: updateData });
      } else {
        await db.collection('dish_mirror').add({ data: Object.assign({ name: dishName, source: 'regenerate', genAt: Date.now() }, updateData) });
      }
      return { ok: true, dishName, profile };
    } catch (e) {
      console.warn('[bypassAiEnrich] 单菜重算失败 name=' + dishName + '：', e && e.message);
      return { ok: false, err: (e && e.message) || 'regenerate_failed', dishName };
    }
  }

  // 增量 AI-1 菜品画像
  if (task === 'profile-dish') {
    return await enrichDishProfiles(cursor, limit);
  }

  // 增量 AI-2 偏好解析
  if (task === 'profile-prefs') {
    return await enrichPrefsProfiles(cursor, limit);
  }

  // 默认：两个都跑（先菜后天，增量）。bypassNutritionEst 由 bypassGenDish 串行链统一调度，此处不再链式触发。
  const r1 = await enrichDishProfiles(cursor, limit);
  const r2 = await enrichPrefsProfiles(cursor, limit);
  await logTask('rateLimiter', null, 'info', limiter.monitorMsg()).catch(() => {});
  return { ok: true, dish: r1, prefs: r2 };
};

// ── AI-1 菜品画像（循环补齐：一次调用扫完所有缺 profile / 过期的菜）─────────────
async function enrichDishProfiles(cursor, limit) {
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    // §7.2 画像过期重算：profile 缺失 OR aiUpdatedAt 超 30 天 → 重算（只重算过期项，不重复已完成）
    const baseCond = _.or([{ profile: _.exists(false) }, { aiUpdatedAt: _.lt(Date.now() - RECALC_MS) }]);
    const cond = lastId ? _.and([baseCond, { _id: _.gt(lastId) }]) : baseCond;
    let q = db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize);
    let list = [];
    try { const res = await q.get(); list = res.data || []; } catch (e) { list = []; }
    if (!list.length) break;

    let computed = 0;
    await pool(list, SLOT_N, async (d) => {
      const name = d.name || d.dishName;
      if (!name) return;
      try {
        // 2026-09-16【P2】：带上该菜食材清单，main 必须取自清单
        const ingText = Array.isArray(d.ingredients)
          ? d.ingredients.map(i => (i && i.name) ? String(i.name) : '').filter(Boolean).join('、') : '';
        const profile = await genDishProfile(name, ingText);
        if (profile) {
          const updateData = { profile, aiUpdatedAt: Date.now() };
          if (d.mealTime && Array.isArray(d.mealTime) && d.mealTime.length) {
            profile.mealTime = d.mealTime;
          } else if (profile.mealTime && profile.mealTime.length) {
            if (profile.type === '小吃') profile.mealTime = ['小吃'];
            else if (profile.type === '饮品') profile.mealTime = ['小吃', '下午茶'];
            updateData.mealTime = profile.mealTime;
          }
          await db.collection('dish_mirror').doc(d._id).update({
            data: updateData,
          });
          computed++;
          lastId = d._id;
        } else {
          console.warn('[AI-1] dish profile 解析失败 name=' + name);
          await logTask('bypassAiEnrich', null, 'fail', 'dish_profile_parse_failed name=' + name);
        }
      } catch (e) {
        console.warn('[AI-1] dish profile 失败 name=' + name + '：', e && e.message);
        await logTask('bypassAiEnrich', null, 'fail', 'dish [' + name + '] ' + (e && e.message));
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e; // 限流类错误上抛，触发自适应降速
      }
    }, limiter);

    totalComputed += computed;
    rounds++;
    if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
  }

  return { ok: true, computed: totalComputed, rounds, hasMore: false, lastId };
}

async function genDishProfile(name, ingText) {
  const prompt = [
    '你是美食特征分析器。为给定菜品输出结构化画像 JSON。',
    // 2026-09-16【P2】：原来只给菜名 → main 靠猜，与食材清单不符（判定侧报"画像主料与清单不一致"）
    (ingText ? '【该菜食材清单（main 必须取自这里）】' + String(ingText).slice(0, 300) : ''),
    (ingText ? '【主料硬约束】main 必须是上方清单中**真实存在**的食材名（可作同义简写，如"猪里脊"→"里脊"）；清单里没有的食材严禁写入 main；若菜名点名的主料不在清单中，以清单为准。' : ''),
    '【严格输出格式】只输出一个 JSON 对象，不要输出任何解释、不要加 markdown 代码围栏、不要加 ```json 标记，直接以 { 开头、} 结尾。',
    '字段（键名必须是英文，禁止中文键名）：spicy(0=不辣 1=微辣 2=中辣 3=特辣 数字)，flavors(1~4个字符串数组：咸/甜/酸/辣/麻/鲜/香/清淡/浓郁/酱香/蒜香/椒麻/酸甜/咸鲜)，cuisine(1个字符串，川菜/湘菜/粤菜/鲁菜/东北菜/家常菜/甜点/汤羹…没有则"家常")，type(荤菜/素菜/汤/主食/小吃/甜品/饮品)，main(主要食材/主料字符串：荤菜填蛋白质如"鸡肉"，素菜填主要蔬菜/豆制品如"豆腐"，饮品填主要原料如"椰汁"，甜品填主要食材如"红豆"，必须非空。**若确有多个并列主料，必须用顿号「、」分隔**，如"紫罗兰、枣"、"香菇、油菜"、"雪梨、南瓜"；禁止把它们拼成一个词（✗"紫罗兰枣"、"洋甘菊梨"），也禁止用逗号/空格/加号分隔；只有一个主料时照常写一个词。**花类食材（桂花/樱花/桃花/玫瑰/洋甘菊/茉莉/金银花/荷花/百合花/洛神花等）算并列主料：只要菜名点到且食材确实用到，就必须在 main 里列出**，如"桃花、雪梨"、"桂花、糯米"、"樱花、红枣")，isVeg(布尔 true/false)，isSoup(布尔 true/false)，mealTime(字符串数组：早餐/午餐/晚餐/夜宵，一道菜可多餐次)',
    'type-mealTime 搭配规则：小吃类→mealTime标["小吃"]；饮品类→mealTime标["小吃","下午茶"]（饮品是配饮，只在小吃/下午茶场景）；其余按实际餐次标早餐/午餐/晚餐/夜宵',
    '示例：{"spicy":2,"flavors":["香","麻","辣"],"cuisine":"川菜","type":"荤菜","main":"鸡肉","isVeg":false,"isSoup":false,"mealTime":["午餐","晚餐"]}',
    '示例2：{"spicy":0,"flavors":["甜","香"],"cuisine":"家常","type":"饮品","main":"椰汁","isVeg":true,"isSoup":false,"mealTime":["小吃","下午茶"]}',
    '菜品：' + name
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 256,
      });
      const text = resp && (resp.text || (resp.data && resp.data.text)) || '';
      const o = parseKit.extractJsonObject(text);
      if (o) {
        const p = parseJsonProfile(o, 'dish');
        if (p) return p;
      }
      // 解析失败：记原始 hy3 返回，便于诊断根因（不幻觉补全，留待重生成）
      if (attempt === 2) {
        console.warn('[genDishProfile] 解析失败 name=' + name + ' raw=' + text.slice(0, 400));
        await logTask('bypassAiEnrich', null, 'fail', 'dish_profile_parse_failed name=' + name + ' raw=' + text.slice(0, 400)).catch(() => {});
      }
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genDishProfile] hy3 失败 name=' + name + '：', e && e.message);
    }
  }
  return null;
}

// ── AI-2 偏好解析（循环补齐）───────────────────────────────────────────────
async function enrichPrefsProfiles(cursor, limit) {
  const startedAt = Date.now();
  let totalComputed = 0;
  let lastId = cursor && cursor.lastId;
  let rounds = 0;

  while (true) {
    const batchSize = Math.min(Number(limit) || BATCH, BATCH);
    // §7.2 画像过期重算：profile 缺失 OR profileUpdatedAt 超 30 天 → 重算
    const baseCond = _.or([{ profile: _.exists(false) }, { profileUpdatedAt: _.lt(Date.now() - RECALC_MS) }]);
    const cond = lastId ? _.and([baseCond, { _id: _.gt(lastId) }]) : baseCond;
    let q = db.collection('prefs_mirror').where(cond).orderBy('_id', 'asc').limit(batchSize);
    let list = [];
    try { const res = await q.get(); list = res.data || []; } catch (e) { list = []; }
    if (!list.length) break;

    let computed = 0;
    await pool(list, SLOT_N, async (u) => {
      try {
        const profile = await genPrefsProfile(u);
        if (profile) {
          await db.collection('prefs_mirror').doc(u._id).update({
            data: { profile, profileUpdatedAt: Date.now() },
          });
          computed++;
          lastId = u._id;
        } else {
          console.warn('[AI-2] prefs profile 解析失败 _openid=' + u._openid);
          await logTask('bypassAiEnrich', null, 'fail', 'prefs_parse_failed _openid=' + u._openid);
        }
      } catch (e) {
        console.warn('[AI-2] prefs profile 失败 _openid=' + u._openid + '：', e && e.message);
        await logTask('bypassAiEnrich', null, 'fail', 'prefs [' + u._openid + '] ' + (e && e.message));
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e; // 限流类错误上抛，触发自适应降速
      }
    }, limiter);

    totalComputed += computed;
    rounds++;
    if (Date.now() - startedAt > MAX_MS || list.length < batchSize) break;
  }

  return { ok: true, computed: totalComputed, rounds, hasMore: false, lastId };
}

async function genPrefsProfile(u) {
  const p = (u && u.prefs) || {};
  const prompt = [
    '你是用户口味画像解析器。基于用户的偏好配置，输出结构化 JSON。',
    '【严格输出格式】只输出一个 JSON 对象，不要输出任何解释、不要加 markdown 代码围栏，直接以 { 开头、} 结尾。键名必须是英文。',
    '偏好配置：' + JSON.stringify({
      taste: p.taste || [], spicy: p.spicy || '', cuisine: p.cuisine || [],
      type: p.type || [], meat: p.meat || [], veg: p.veg || [],
      cookMethod: p.cookMethod || [], avoid: p.avoid || [], softDislike: p.softDislike || [],
    }),
    '字段说明（英文键名）：spicy=0不辣 1微辣 2中辣 3特辣 数字；likeFlavors=1~4个口味字符串数组(咸/甜/酸/辣/麻/香/酱香/蒜香/鲜香)；likeCuisines=1~3个菜系字符串数组；likeTypes=1~3个分类字符串数组(荤菜/素菜/汤/主食/甜品/饮品)；avoid=明确忌口/不喜欢的口味字符串数组；likeMeat=布尔；likeStaple=布尔',
    '示例：{"spicy":1,"likeFlavors":["鲜","咸"],"likeCuisines":["粤菜","家常"],"likeTypes":["汤","素菜"],"avoid":["辣"],"likeMeat":false,"likeStaple":true}'
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 256,
      });
      const text = resp && (resp.text || (resp.data && resp.data.text)) || '';
      const o = parseKit.extractJsonObject(text);
      if (o) {
        const p2 = parseJsonProfile(o, 'prefs');
        if (p2) return p2;
      }
      if (attempt === 2) {
        console.warn('[genPrefsProfile] 解析失败 _openid=' + u._openid + ' raw=' + text.slice(0, 400));
        await logTask('bypassAiEnrich', null, 'fail', 'prefs_parse_failed _openid=' + u._openid + ' raw=' + text.slice(0, 400)).catch(() => {});
      }
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[genPrefsProfile] hy3 失败 _openid=' + u._openid + '：', e && e.message);
    }
  }
  return null;
}

// ── 画像一致性校验（零 AI 调用，纯规则校验）─────────────────────────────────
function validateDishProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const issues = [];
  const MEATS = ['猪肉', '牛肉', '鸡肉', '鸭肉', '鱼肉', '虾', '羊肉', '排骨', '腊肉', '火腿'];

  // 规则1：素菜不能有肉类 main → 修正 isVeg=false 而非拒绝
  if (profile.isVeg && MEATS.some(m => profile.main && profile.main.includes(m))) {
    profile.isVeg = false;
    issues.push('isVeg=true但main含肉类已修正为false');
  }
  // 规则2：汤类 type 不能是炒菜/凉菜/荤菜/素菜 → 修正 type='汤' 而非拒绝
  if (profile.isSoup && ['炒菜', '凉菜', '荤菜', '素菜'].includes(profile.type)) {
    profile.type = '汤';
    issues.push('isSoup=true但type=' + profile.type + '已修正为汤');
  }
  // 规则3：spicy≥2 但 flavors 不含"辣"→补辣
  if (profile.spicy >= 2 && !(profile.flavors || []).includes('辣')) {
    profile.flavors = [...(profile.flavors || []), '辣'];
    issues.push('spicy/flavors不一致已补辣');
  }
  // 规则4：菜系与口味矛盾标记可疑
  const CUISINE_FLAVOR_MAP = {
    '粤菜': ['清淡', '鲜', '咸鲜', '甜', '香'],
    '川菜': ['辣', '麻', '香', '咸', '鲜'],
    '湘菜': ['辣', '香', '咸', '酸'],
  };
  if (CUISINE_FLAVOR_MAP[profile.cuisine]) {
    const valid = CUISINE_FLAVOR_MAP[profile.cuisine];
    const conflict = (profile.flavors || []).filter(f => !valid.includes(f) && ['酸辣', '椒麻'].includes(f));
    if (conflict.length) {
      issues.push('菜系/口味疑似矛盾：' + profile.cuisine + ' 不常出现 ' + conflict.join('/'));
      profile._suspect = true;
    }
  }
  // 规则5：isVeg 与 type 对齐
  if (profile.isVeg && profile.type === '荤菜') {
    profile.type = '素菜';
    issues.push('isVeg=true但type=荤菜已修正');
  }
  profile._issues = issues;
  return profile;
}

// ── 工具 ─────────────────────────────────────────────────────────────────────
function parseJsonProfile(input, kind) {
  // 兼容：input 可以是已解析对象，或原始文本（兜底再抽一次）
  let o = input;
  if (typeof input === 'string') o = parseKit.extractJsonObject(input);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  try {
    if (kind === 'dish') {
      const profile = {
        spicy: clampInt(o.spicy, 0, 3, 0),
        flavors: toArr(o.flavors), cuisine: pickStr(o.cuisine, 8),
        type: pickStr(o.type, 8), main: normMain(o.main),
        isVeg: !!o.isVeg, isSoup: !!o.isSoup,
        mealTime: toArr(o.mealTime),
      };
      const validated = validateDishProfile(profile);
      if (!validated) return null;
      return validated;
    }
    return {
      spicy: clampInt(o.spicy, 0, 3, 1),
      likeFlavors: toArr(o.likeFlavors),
      likeCuisines: toArr(o.likeCuisines),
      likeTypes: toArr(o.likeTypes),
      avoid: toArr(o.avoid),
      likeMeat: !!o.likeMeat,
      likeStaple: !!o.likeStaple,
    };
  } catch (e) { return null; }
}

function clampInt(v, min, max, dft) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dft;
  return Math.min(max, Math.max(min, n));
}
function pickStr(v, maxLen) {
  return typeof v === 'string' ? v.slice(0, maxLen) : '';
}
// 2026-09-10 主料口径统一（多主料用顿号「、」分隔）：
// 去空格/全角空格 → 半角逗号/全角逗号/分号/斜杠/加号/中点等分隔符统一为「、」→ 折叠多余顿号 → 去首尾顿号 → 限长 12
// 例："猕猴桃,苹果" → "猕猴桃、苹果"；"紫罗兰枣" 这类拼接无法自动拆，靠生成侧 prompt 约束不再产生
function normMain(v) {
  return String(v == null ? '' : v)
    .replace(/[\s\u3000\u00a0]+/g, '')
    .replace(/[,，;；、/\\|+＋·・]+/g, '、')
    .replace(/^、+|、+$/g, '')
    .replace(/、{2,}/g, '、')
    .slice(0, 12);
}
function toArr(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).slice(0, 6);
  if (typeof v === 'string' && v.trim()) return [v.trim().slice(0, 16)];
  return [];
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* 日志失败不影响主流程 */ }
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
