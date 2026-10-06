// ============================================================================
// bypassEnrich · env2 三库富集（菜名 / 食材 / 营养）异步补充
// BUILD_TAG: 2026-08-21.bypass-enrich-pending-review
//
// 职责（详见 env2旁路服务env1规划.md §2 任务① / §9 T1 / T3）：
//   - 营养补估：菜库缺营养的菜品，补算热量/蛋白/碳水/脂肪。
//   - 菜名/食材富集：怪名规范化、食材别名补全（待实现，将来同走审核池，source='env2-lexicon'）。
//
// 入库审核（2026-08-21 用户明确）：env2 产物一律不直接落 env1 正式库，
//   先进 env1 审核池 dish_lexicon_pending（source='env2-nutrition'），
//   管理员在管理后台 tab 13「探索菜库审核」通过后，manageLexicon.approve
//   按 source 分流写入正式库 dish_nutrition / dish_lexicon。前端零改动。
//
// 当前阶段（回写已接通 2026-08-21）：
//   - 营养补估走【本地查表 + 关键词兜底】，不调 AI（AI 调用待 env1 切账号后评估，
//     严禁用 env2 同步 aiProxy 溢出模式，见 §1.5 纪律）。
//   - 读 env2 本地 dish_mirror（env1 菜库镜像）；回写 env1 由 ENV1_WRITE_BACK 开关控制，
//     经共享实例写 env1 审核池 dish_lexicon_pending（schema 对齐 env1 现有 pending 记录）。
//   - 查表数据从 env1 getRecommendation DISH_NUTRITION/DRINK_NUTRITION 迁移精简版（TODO 完整迁）。
// ============================================================================

const BUILD_TAG = '2026-08-21.bypass-enrich-pending-review';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ENV1_ID = process.env.ENV1_ENV_ID || '';
const ENV1_APPID = 'wx0000000000000000'; // env1 小程序（资源方）AppID
const ENV1_WRITE_BACK = false; // 已禁用 2026-08-22：bypassEnrich 回写 env1 关闭，改由 syncFromEnv2 主动拉

// 营养查表（精简骨架，TODO 完整迁移 env1 getRecommendation DISH_NUTRITION@3260）
const DISH_NUTRITION = {
  '番茄炒蛋': [180, 9, 10, 12], '青椒炒肉': [240, 18, 8, 16], '红烧肉': [480, 18, 10, 42],
  '清蒸鲈鱼': [200, 30, 2, 8], '麻婆豆腐': [250, 14, 12, 16], '米饭': [200, 4, 44, 1],
  '西红柿鸡蛋汤': [90, 6, 8, 5], '紫菜蛋花汤': [70, 5, 6, 3],
};
const DRINK_NUTRITION = {
  '水': [5, 0, 0, 0], '豆浆': [80, 4, 9, 3.5], '牛奶': [120, 6, 9, 6], '可乐': [40, 0, 10, 0],
};
const FALLBACK = [280, 18, 18, 14];

// 本地审核池副本集合 ensure（env2 本地自测用；env1 侧由 manageLexicon 已 ensure）
async function ensureCollections() {
  await Promise.allSettled([
    db.createCollection('dish_lexicon_pending'),
    db.createCollection('dish_nutrition')
  ]);
}

exports.main = async (event) => {
  console.log('[build] bypassEnrich BUILD_TAG=' + BUILD_TAG);
  const { task, dishName, cursor, limit } = event || {};
  await ensureCollections();

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, env1WriteBack: ENV1_WRITE_BACK, env1Id: ENV1_ID };
  }

  // 单菜补估（env1 投递单条）→ 结果进审核池，不直接落正式库
  if (dishName) {
    const nutri = estimateNutrition(dishName);
    if (ENV1_WRITE_BACK && ENV1_ID) {
      // 经共享实例写 env1 审核池 dish_lexicon_pending（对称 cloudbase_auth + auth.custom，§8.1）
      await writePendingEnv1(dishName, nutri);
    } else {
      await writePendingLocal(dishName, nutri);
    }
    await logTask('bypassEnrich', null, 'ok', 'dishName=' + dishName);
    return { ok: true, dishName, nutri };
  }

  // 批量补估：扫 dish_mirror 中缺营养的菜 → 全部进审核池
  const batchSize = Math.min(Number(limit) || 200, 500);
  let query = db.collection('dish_mirror').orderBy('_id', 'asc').limit(batchSize);
  if (cursor) query = query.where(_.gt('_id', cursor));
  const res = await query.get();
  const dishes = res.data || [];
  if (!dishes.length) return { ok: true, done: true, computed: 0 };

  let computed = 0, lastCursor = cursor;
  for (const d of dishes) {
    const name = d.name || d.dishName;
    if (!name) continue;
    const nutri = estimateNutrition(name);
    if (ENV1_WRITE_BACK && ENV1_ID) {
      await writePendingEnv1(name, nutri);
    } else {
      await writePendingLocal(name, nutri);
    }
    computed++; lastCursor = d._id;
  }
  await logTask('bypassEnrich', null, 'ok', 'batch computed=' + computed);
  return { ok: true, computed, hasMore: dishes.length === batchSize, nextCursor: lastCursor };
};

// ── 审核池记录构造（env1 dish_lexicon_pending schema 对齐）────────────
// 字段：name/cuisine/reason/source/exploreDir/status/ts/openid，另带 nutri 数值供 approve 分流。
// reason 带营养摘要，供管理员在 tab 13 直接判断后点「通过」。
function pendingPayload(name, nutri) {
  return {
    name,
    cuisine: '家常',
    reason: 'env2 营养补估：热量' + (nutri[0] != null ? nutri[0] : '?') +
      '/蛋白' + (nutri[1] != null ? nutri[1] : '?') +
      '/碳水' + (nutri[2] != null ? nutri[2] : '?') +
      '/脂肪' + (nutri[3] != null ? nutri[3] : '?'),
    source: 'env2-nutrition',
    exploreDir: 'env2营养补估',
    nutri,
    status: 'pending',
    ts: Date.now(),
    openid: ''
  };
}

// 去重：同菜名同 source 已有 pending/approved 记录则跳过，避免审核池刷屏
async function hasPending(col, name) {
  try {
    const ex = await col.where({ name, source: 'env2-nutrition' }).limit(1).get();
    return !!(ex && ex.data && ex.data.length);
  } catch (e) {
    console.warn('[bypassEnrich] 查审核池去重失败，放行写入：', (e && e.message) || e);
    return false;
  }
}

// 写 env1 审核池（真实回写路径）
async function writePendingEnv1(name, nutri) {
  try {
    const c1 = await getEnv1();
    const col = c1.database().collection('dish_lexicon_pending');
    if (await hasPending(col, name)) {
      console.log('[bypassEnrich] env1 审核池已存在同名待审，跳过 name=' + name);
      return;
    }
    await col.add({ data: pendingPayload(name, nutri) });
    console.log('[bypassEnrich] 写 env1 审核池 dish_lexicon_pending 成功 name=' + name);
  } catch (e) {
    console.error('[bypassEnrich] 写 env1 审核池失败 name=' + name + '：', e && e.message);
    throw e;
  }
}

// 写 env2 本地审核池副本（ENV1_WRITE_BACK 关闭时自测用，语义与 env1 一致）
async function writePendingLocal(name, nutri) {
  try {
    const col = db.collection('dish_lexicon_pending');
    if (await hasPending(col, name)) {
      console.log('[bypassEnrich] 本地审核池已存在同名待审，跳过 name=' + name);
      return;
    }
    await col.add({ data: pendingPayload(name, nutri) });
  } catch (e) {
    console.error('[bypassEnrich] 写本地审核池失败 name=' + name + '：', e && e.message);
    throw e;
  }
}

// 营养估算：查表优先，未命中走兜底（骨架，不调 AI）
function estimateNutrition(name) {
  if (DRINK_NUTRITION[name]) return DRINK_NUTRITION[name];
  if (DISH_NUTRITION[name]) return DISH_NUTRITION[name];
  // TODO: 关键词兜底（env1 fallbackDishNutrition@3423）+ AI 补估（待 env1 就绪）
  return FALLBACK;
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* 日志失败不影响主流程 */ }
}

// ── env2→env1 跨账号回写（§8.1：对称 cloudbase_auth + auth.custom 安全规则）──────────
// 模块级缓存共享实例，避免逐条重复 init 换 token。
let env1Inst = null;
async function getEnv1() {
  if (!env1Inst) {
    env1Inst = new cloud.Cloud({ resourceAppid: ENV1_APPID, resourceEnv: ENV1_ID });
    await env1Inst.init(); // 跨账号鉴权：仅真机小程序端调用链能换到 token
  }
  return env1Inst;
}

// 注：旧 writeBackEnv1（直接写 env1 dish_nutrition）已于 2026-08-21 移除，
//   改为 writePendingEnv1 先进审核池，管理员审核通过后才入库（见文件头说明）。
