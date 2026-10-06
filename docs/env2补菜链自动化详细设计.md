# env2 补菜链自动化 · 详细设计

> 状态：详细设计（未动代码）
> 目标：把「候选菜名 → 查重 → 全维生成写 mirror → 复核 → 入 env1」这条手工补菜链（dishadd_from_md.js 那套），在 env2 侧做成定时自动化的消费端。
> 范围：本文只设计 **env2 侧新增/改动** + 与 常驻审核服务 漏斗的对接约定。env1 侧的食材核对/AI 一致性/波动复扫等最终闸门已全自动，不在本次改动范围。
> 日期：2026-09-09

---

## 1. 背景与现状盘点（锚定代码事实）

### 1.1 当前手工链（每天 189~455 道那套）

```
候选 md 清单（- 选项 | 菜名 | 类别）            ← 本地生成，人工检查
   │  scripts/dishadd_from_md.js（本机驱动）
   ▼
env2 逐维直调（每道串行、菜间并发 ≤4）：
   bypassGenReason → bypassAiEnrich(profile) → bypassGenIngredients
   → bypassGenSteps → bypassGenTips → bypassText(review·difficulty)
   → bypassNutritionEst → bypassGenImage
   │  每维调用 = cloud 函数 { dishName } 直调，函数内部自带 429 rateLimiter
   ▼
读回 dish_mirror → 缺维定点补 ≤2 轮 → 全维闸门（缺一不入库）
   ▼
env1 九张分表直写（doc id=菜名，set 幂等）   ← 手工链直接写 env1，绕过漏斗
```

**痛点**：候选要人工整理成 md、生成要本机守着跑、env1 直写 bypass 了漏斗的 AI 查重（复核问题靠事后 3883 全量 QA 补）。

### 1.2 已经存在的自动化件（直接复用，不再重造）

| 件 | 位置 | 能力 |
|---|---|---|
| env2 维度生成函数 | `env2_functions/bypassGenReason|bypassAiEnrich|bypassGenIngredients|bypassGenSteps|bypassGenTips|bypassText|bypassNutritionEst|bypassGenImage|bypassGenGuide` | 均支持 `{dishName}` 同步直调，写回 `dish_mirror` 对应字段；增量模式 = 扫 mirror 缺维自愈补齐 |
| env2 统一调度 | `env2_functions/bypassScheduler` | 5 个 10min 定时触发器 → TRIGGER_MAP 分发 + degradeLevel 熔断 + bypass_log |
| env2 镜像台 | `dish_mirror` | doc 内直接承载全维（name/category/kind/cuisine/profile/nutrition/guide/ingredients/steps/tips/review/reason/difficulty/imageUrl…） |
| 常驻审核服务 漏斗 | `scripts/review-web/server.js`（审核服务器 常驻） | AI 查重（step/wxai 双通道）→ `mirrorAutoApproveOne`：AI 判不重即走 approveInternal 写 env1 分表（pendingCheck:true）→ 触发 env1 食材核对 → **删 env2 mirror 同名源**；驳回 → 写 `rejected_names` + 删 mirror |
| env1 最终闸门 | env1 侧（食材核对/AI 一致性/波动复扫/gapSweep） | 已全自动：approve 后 pendingCheck → 核对通过翻 valid |

### 1.3 缺口（本次要补的）

1. **候选池没有落库**：候选活在 md 文件里，只能人工驱动。
2. **没有定时消费端**：谁把候选变成 mirror 骨架并逐维生成？目前只有 dishadd_from_md.js 本机脚本。
3. **没有消费状态机**：生成到一半、失败、被漏斗吃掉之后，候选状态无人跟踪 → 防重基线缺失（同一候选可能重复生成/重复入库）。
4. **查重基线在 env2 不可用**：候选查重需要 env1 词库名单，env2 目前只有跨账号点查通道（bypassGenDish.getEnv1 模式），没有本地快照。

---

## 2. 目标架构（一句话版）

> 候选从「文件」变成「DB 状态机」：`dish_candidates(status=new)` 由新增的 **bypassAutoAdd**（10min 定时）认领 → 建 `dish_mirror` 骨架（source=`candidate-auto`）→ 逐维直调生成（断点续传跨 tick）→ 全维闸门通过置 `ready` → 审核服务器 漏斗 AI 查重后自动入 env1 → mirror 被删 = 消费成功 → 候选回标 `done`。**候选侧只做生成，入库决定权仍在漏斗（AI 查重）+ env1 闸门。**

```
写入端（人工/脚本/后续可扩展）
   │ 写 dish_candidates（status=new）
   ▼
┌─────────────────────── env2（新增 bypassAutoAdd，10min tick）──────────────┐
│ ① 巡检对齐：mirror 同名已消失 → 查 rejected_names → 候选回标 done/rejected  │
│ ② 查重(规则级)：快照/rejected_names/mirror/done历史 → 命中即 rejected(dupOf)│
│ ③ 认领：new→doing（条件更新+租约，防双跑）                                  │
│ ④ 逐维直调：reason→profile→ingredients→steps→tips→text→nutrition→guide→image│
│    时间盒内串行；盒尽未齐 → 保持 doing 下轮续跑（断点续传）                  │
│ ⑤ 全维闸门（缺一不入 ready）→ 置 ready                                      │
└──────────────────────────────────────────────────────────────────────────────┘
   ▼ mirror 全维齐（source='candidate-auto'）
常驻审核服务 漏斗（已存在，零改动可跑）：
   AI 查重(终审) → 不重 → approveInternal 写 env1 九表(pendingCheck:true)
                → 重   → 写 rejected_names + 删 mirror
   ▼
env1 最终闸门（已存在）：食材核对/AI 一致性 → valid
   ▼
候选回标：mirror 消失 → done（推荐再加漏斗侧 1 行回标，见 §7）
```

**两级查重分工（避免重复造 AI）**：
- 生成前 = **规则级**（bypassAutoAdd 内）：精确/归一/包含/黑名单，拦掉"白生成"。
- 入库前 = **AI 级终审**（review-web 漏斗已有）：相似菜判定，撞库自动驳回。
- 即便规则级漏了，AI 级兜底；即便 AI 级漏了，env1 食材核对闸门兜底。三级冗余。

---

## 3. 集合结构

### 3.1 新增 `dish_candidates`（env2 候选池，唯一状态源）

```
{
  _id: 自动,                    // 建议建 {name} 唯一索引
  name: '芹菜炒香干',            // 归一化后的菜名（录入端负责归一）
  category: '荤菜',              // 荤菜|素菜|汤羹|小吃|甜品|主食|饮品（必填）
  kind: 'dish',                 // 由 category 映射（KIND_BY_CAT），可显式覆盖
  cuisine: '家常',               // 提示（可空 → 生成兜底家常）
  main: '香干',                  // 主食材提示（可空；给生成器做约束，防止乱拼）
  mealTime: null,               // 可空 → 生成器推断；枚举见 dish_mirror 惯例
  season: null,                 // 可空
  source: 'md-import'|'console'|'funnel-feedback'|'invent'|...,  // 候选来源
  status: 'new',                // 见下方状态机
  dupOf: '',                    // 查重命中已存在菜名（status=rejected 时）
  progress: {                   // 生成进度（断点续传依据）
    doneDims: [],               // 已完成的维度名
    lastDim: '',
    rounds: 0,                  // 已跑 tick 数
  },
  fail: {
    count: 0,                   // 确定性失败累计（空结果/字段缺失类）
    dims: {},                   // { 维度名: 连续失败次数 }
    lastErr: '',
  },
  lease: { until: 0, by: '' },  // doing 租约（防双 tick 并发）
  createdAt: Date.now(),
  updatedAt: Date.now(),
  readyAt: 0,                   // 置 ready 时间
  doneAt: 0,                    // 终态时间
  note: '',                     // 失败/驳回原因（给人工台看）
}
```

**状态机**（迁移一律条件更新，见 §6 幂等）：

```
new ──认领──▶ doing ──全维闸门过──▶ ready ──漏斗消费(mirror消失)──▶ done
 │              │  ▲                    │
 │              │  └── 时间盒尽/429 → 下轮续跑（仍是 doing）          │
 │              ▼                                                  │
 │           fail.count≥3 或 doing 超龄(48h) ──▶ failed ──人工台──▶ new/删除
 └──查重命中──▶ rejected (dupOf=已存在菜名，立即终态，防重基线)
```

- `done`：最终态 = 该菜已入 env1 或已被漏斗处理完，**后续候选查重排除它**。
- `failed`：确定性失败死磕满 3 次（沿用 env1Fix 纪律：EMPTY 类不无限重试）或生成超龄；转人工台裁决（修正提示/改名后重置 new，或删除）。
- 429/超时类**不算**确定性失败，只让出本轮，下轮自动续（自愈）。

### 3.2 新增 `dish_lexicon_snapshot`（env2 词库快照，查重基线）

```
{
  _id: 自动 或 norm_id,          // 建 {name} 唯一索引
  name: '番茄炒蛋',              // 原始名
  norm_id: '番茄炒蛋',           // normLexName 归一
  category: '素菜'|'', kind: 'dish'|'', cuisine: '家常'|'',
  ts: Date.now(),               // 快照写入时间
}
```

- 数据源：env1 `dish_lexicon` 全量（约 4000 内），经 bypassGenDish 同款跨账号通道（`new cloud.Cloud({resourceAppid, resourceEnv})` → c1）拉取。
- 同步策略：**整表替换式增量**（每 6h 一次；逐页拉 env1 → 本地先清空再批量写，或按 ts 增量 upsert。推荐增量 upsert：先 `remove where {ts: {$lt: 本次基准}}`，再逐页 upsert 新快照）。env1 新增的菜 6h 内查不到 → 由两级查重中的漏斗 AI 终审兜底，无风险。
- 新鲜度检查：AutoAdd 每轮开头读 `sys_config.key='lexiconSnapshotAt'`，超 6h 触发同步（同步失败不阻塞生成，降级为点查，见 §6 失败处理）。

### 3.3 复用现有集合（不改结构）

| 集合 | 用途 | 约定 |
|---|---|---|
| `dish_mirror` | 生成台 + 漏斗消费台 | 骨架字段约定见 3.4；漏斗消费后删同名 doc |
| `rejected_names` | 黑名单/驳回记录 | 判定候选被驳回的归属依据（review-web 写 doc(id=name)） |
| `bypass_log` | 全量操作日志 | task 统一用 `bypassAutoAdd`/`bypassAutoAdd-dim` |
| `sys_config` | 配置中心 | 新增 key：`autoAddQuotaDaily`(默认 30)、`lexiconSnapshotAt`、`autoAddSwitch`(1/0) |
| `scheduler_control` | 软停止 | 已存在，不动 |

### 3.4 `dish_mirror` 骨架约定（source=`candidate-auto`）

建骨架用 `doc(name).set()`（幂等，与 dishadd 一致；本地 sdk/云函数内均可）：

```
{
  _id: name,                    // doc id = 菜名（候选链统一此约定，便于漏斗按名删）
  name, norm_id,
  source: 'candidate-auto',
  category, kind, cuisine, main, mealTime, season,   // 从候选透传（生成器提示）
  reason: '', profile: null, ingredients: [], steps: [], tips: '',
  review: '', difficulty: '', nutrition: [], guide: '', imageUrl: '',
  genAt: Date.now(), updatedAt: Date.now(),
}
```

**全维闸门字段口径**（与 dishadd 对齐，比漏斗 SEVEN 更严——漏斗只管 `profile/nutrition/guide/ingredients/steps/imageUrl` 六键，闸门要 8 项全过才放 ready，保证 approveInternal 落库时各分表都有货）：

| # | mirror 键 | 生成函数（{dishName} 直调） | 落 env1 去向 |
|---|---|---|---|
| 1 | reason | bypassGenReason | dish_lexicon.reason + dish_recommend |
| 2 | profile | bypassAiEnrich | dish_profile |
| 3 | ingredients（数组非空） | bypassGenIngredients | dish_ingredients |
| 4 | steps（≥3 条） | bypassGenSteps | dish_steps（顺带写 guide） |
| 5 | tips（非空） | bypassGenTips | dish_tips |
| 6 | review + difficulty | bypassText | dish_review |
| 7 | nutrition（数组非空） | bypassNutritionEst | dish_nutrition_v2 |
| 8 | imageUrl（非空） | bypassGenImage | dish_image_v2（env2 fileID 转存 env1） |
| 9* | guide（漏斗 SEVEN 含此键，建议生成） | bypassGenGuide | dish_tips.guide / getCookGuide |

生成顺序 = 表序，image 压最后（最贵、最易 429）。reason/profile 在最前（给后续维度当提示上下文）。

---

## 4. 云函数设计（函数签名）

### 4.1 新增 `env2_functions/bypassAutoAdd/index.js`（核心编排）

```js
// 职责：候选池定时消费 + 全维生成编排 + 状态机推进 + 快照同步
// 触发器：定时 10min（经 bypassScheduler 分发，见 §5）
// 超时配置：300s（时间盒 240s + 收尾余量）
// 环境变量：GEN_DISABLED 语义与其他 bypass 函数一致（默认关，显式 'false' 才开）
// 跨账号：复用 bypassGenDish.getEnv1 模式（ENV1_APPID / ENV1_ENV_ID）

exports.main = async (event) => {
  // event: { task?: 'incremental' | 'health', dry?: boolean, roundN?: number }
  // 返回：
  // {
  //   ok: true,
  //   tick: '<tickId>',
  //   quota: { used: number, total: number },        // 今日已 ready+done / 日配额
  //   aligned: { done: number, rejected: number },    // 巡检对齐结果
  //   dup: number,                                    // 本轮查重拦截
  //   claimed: number,                                // 本轮新认领
  //   resumed: number,                                // 本轮续跑 doing
  //   ready: number,                                  // 本轮达全维闸门
  //   failed: number,                                 // 本轮判死
  //   synced: number,                                 // 快照本次同步条数(0=未到期)
  // }
};
```

内部结构（伪码级签名，实现时按此拆）：

```js
// 一轮 tick 主流程
async function tickOnce(opts) {
  await syncLexiconIfStale(6h);          // ① 快照新鲜度（失败降级，不阻塞）
  const aligned = await alignConsumed(); // ② 巡检：ready 且 mirror 同名消失 → 终态回标
  const quota = await quotaUsedToday();  // ③ 配额统计
  const { claimed, resumed } = await runGeneration(quota); // ④ 认领+续跑（时间盒）
  return report;
}

// ① env1 词库 → dish_lexicon_snapshot（增量整表刷新）
async function syncLexiconIfStale(maxAgeMs)
  -> { synced, count } | { synced: 0, err }

// ② 消费对账：ready 候选若 mirror 同名不存在 →
//    name ∈ rejected_names → status='rejected'(note=黑名单/驳回)
//    否则 → status='done'(note='mirror_consumed'，即漏斗已 approve 入 env1)
async function alignConsumed() -> { done, rejected }

// ③ 当日配额：count dish_candidates where {status in [ready,done], createdAt>=今日0点}
//    （readyAt/doneAt 口径更准，实现时取 createdAt 与 readyAt 的并集保守口径）
async function quotaUsedToday() -> { used, total }

// ④ 主生成段（时间盒内）
async function runGeneration({ used, total }) {
  // 4a 续跑：status='doing' 且租约过期(>2×tick 周期) 或 progress.rounds<上限 → 抢租约
  // 4b 认领：quotaLeft>0 时，取 status='new' 按 createdAt asc，最多 roundN(=2) 条，
  //    条件更新 new→doing（租约 20min）→ 建/合并 mirror 骨架
  // 4c 每道菜：while(时间盒未尽 && 闸门未过) {
  //      读 mirror → 缺维清单 → 依表序取下一个缺失维 → genDim 直调
  //      成功→progress.doneDims 记；空结果/字段缺失→该维 fail.dims[n]++
  //      }（429/超时让出，下轮续）
  // 4d 闸门过 → doing→ready（若期间 mirror 已被漏斗删 → 直接 done）
  //     fail.count≥3 或 rounds>40 → doing→failed(note)
}

// 单个维度的直调包装（429 退避、超时、结果判空）
async function genDim(name, fnName, timeoutMs)
  -> { ok, errType: 'empty'|'timeout'|'429'|'error'|null }
  // 实现：cloud.callFunction({ name: fnName, data: { dishName: name } })
  //       内部对 429/超时做 1 次短退避重试；仍败 → 返回 errType，本轮让出

// 全维闸门（口径 = §3.4 表 9 键；guide 缺失可放行但记 note，避免卡死）
function fullGate(mirrorDoc) -> { ok, lack: string[] }

// 规则级查重（生成前拦截，零 AI 成本）
async function checkDupLocal(name, ctx) -> { dup, of, level }
  // 顺序：
  //  0 黑名单/违规前缀（rejected_names + 名称黑名单表）→ dup
  //  1 精确：snapshot.norm_id 集合命中 → dup
  //  2 归一：SYNONYMS 归一后相等（番茄炒蛋≈西红柿炒蛋）→ dup
  //  3 包含：双向包含(≥2字) → dup
  //  4 mirror 现网同名 + done/rejected 历史同名 → dup（防重入）
```

### 4.2 改动 `bypassScheduler`（小改：加一行映射 + 降级档）

```js
TRIGGER_MAP['sched-auto-add'] = 'bypassAutoAdd';
DEGRADE_STOPS.bypassAutoAdd = 2;   // degradeLevel≥2（停文本档）时连新菜生成一起停
```

无需改 dispatch 逻辑（它已按 TriggerName 通用分发）。部署时给 bypassScheduler 超时上调到 600s（AutoAdd 时间盒 240s，留足 await 余量）；或 AutoAdd 改成"调度确认即返回、内部分阶段推进"——**首版采用前者**（简单，10min 周期内单 tick 串行无叠加）。

### 4.3 可选增强（列入实施清单，非首版必须）

```js
// env2Console 增加人工台 action（处理 failed/巡检，复用现有跨账号 console 函数）
//   action='candList'  { status?, limit }   → 候选列表（含 note/fail.dims）
//   action='candRetry' { name }             → failed→new（人工修正提示后放回）
//   action='candRemove'{ name }             → 物理删除（慎用，走确认）
//   action='candAdd'   { names:[{name,category,cuisine?,main?}] } → 批量入池(new)
```

```js
// bypassDedup 增加 task='checkOne' { name } → { isDup, similar }
// （可选：把规则级查重升级为 AI 级拦截，减少白生成；首版不依赖它，漏斗 AI 终审已兜底）
```

### 4.4 候选写入端（首版）

本地新增一次性导入脚本 `scripts/cand_import.js`（替代 `_tmp_gen_cand_md*.js` + `dishadd_from_md.js` 的头半段）：
读补菜清单 md → 逐条 `checkDupLocal`（直连 env1 点查兜底）→ 未重则写 `dish_candidates`(new) → 完。后续自动化消费端已就位，脚本可反复灌。

---

## 5. 定时编排

### 5.1 触发器表（腾讯云开发控制台）

| TriggerName | cron | 目标（bypassScheduler 分发） | 说明 |
|---|---|---|---|
| sched-ai-enrich | 每 10min（现有） | bypassAiEnrich | 现有，顺带补 profile |
| sched-text | 每 10min（现有） | bypassText | 现有，顺带补 review |
| sched-nutrition | 每 10min（现有） | bypassNutritionEst | 现有 |
| sched-gen-image | 每 10min（现有） | bypassGenImage | 现有 |
| sched-gen-dish | 每 10min（现有） | bypassGenDish | **建议停用发明模式**（GEN_DISABLED 或控制台暂停），避免与候选源双轨乱入 mirror；后续若要 AI 发明，改造为"只产候选写 dish_candidates(new)" |
| **sched-auto-add** | **每 10min（新增，秒位错开，如 :30s）** | **bypassAutoAdd** | 本次新增；cron 秒位与上述错开 30s，避开齐发 |

### 5.2 单 tick 时序（bypassAutoAdd）

```
T+0s    健康/开关检查（sys_config.autoAddSwitch）→ 关则空转
T+0~5s  快照新鲜度检查（>6h → 同步 env1 词库；失败降级点查）
T+5~15s 巡检对齐（ready 候选 vs mirror 存在性 → done/rejected）
T+15s   配额统计（today ready+done vs sys_config.autoAddQuotaDaily=30）
T+15s   认领 ≤roundN=2 条 new → doing（租约 20min）+ 建 mirror 骨架
T+15~T+240s  时间盒：对 doing 候选逐道逐维直调（串行，菜内串行、菜间串行）
             每完成一道且闸门过 → ready；时间盒尽 → 保留 doing 下轮续
T+240s  收尾：写 bypass_log 汇总 + sys_config 刷新快照时间戳
```

节奏推算：单道 8 维 × 平均 10~30s/维 ≈ 2~4min → 每 tick 完整产出 1~2 道；10min 周期下 **24~30 道/天** 与配额一致。doing 菜跨 2~3 个 tick 完成属正常（断点续传），ready 后 1 个轮询周期内被漏斗吃走。

### 5.3 错峰与限流原则

1. 生成类全部走维度函数内部 `_shared/rateLimiter.js`（429 退避/windowCap），AutoAdd 不另起并发（**并发=1**，菜内串行）。
2. 新触发器 cron 秒位错开（现有齐发 5 个已共存，AutoAdd 再错 30s 即可）。
3. 配额不足/降级档位≥2 → tick 空转（只做巡检对齐，不认领新菜），0 AI 消耗。
4. 候选枯竭 → tick 空转成本 = 1 次 20 行内 scan，可忽略。

---

## 6. 失败处理矩阵

| # | 环节 | 失败形态 | 处置 | 自愈 |
|---|---|---|---|---|
| 1 | tick 双触发/重入 | 两个 10min 实例重叠 | doing 带租约（lease.until=20min）；认领用条件更新 `where{_id,status:'new'}` 判 `stats.updated` | ✅ 天然单写者；崩溃残留的 doing 由租约过期后被抢占 |
| 2 | 单维直调 429/超时 | AI 限流/慢 | genDim 内退避重试 1 次 → 仍败返回 errType，**本轮让出该维**，progress 不记成功 | ✅ 下轮 tick 缺维续跑；图像维连续 3 轮 429 → fail.dims.image 计数但**不判死**（延长至 24h 观察） |
| 3 | 单维确定性空结果 | hy3 返回空/字段缺失（EMPTY 类） | 该维同轮重试 ≤2 次 → 仍空 → `fail.dims[dim]++` | ⚠️ 每轮最多 +1；累计 ≥3 → 候选 `failed`（不无限死磕，沿用 env1Fix 纪律） |
| 4 | 跨账号 env1 拉词库失败 | getEnv1 通道抖动/超时 | 快照同步失败不阻塞生成：查重降级 = 只比对本地 snapshot(旧)+mirror+rejected_names；快照 >24h 过期时**本轮不认领新菜**（保守），只续 doing | ✅ 下轮重试同步 |
| 5 | 全维闸门缺维卡死 | 某维反复失败/生成器吞字段 | doing 超 40 rounds（≈6.7h）→ `failed`(note=缺维清单)，转人工台 | 人工修正提示后 candRetry → new |
| 6 | 漏斗消费竞态 | ready 候选生成收尾时 mirror 已被漏斗删（AI 查重→approve 很快） | 置 ready 前重查 mirror 存在性：已消失 → 直接 done | ✅ |
| 7 | 漏斗 approve/reject 后回标丢失 | 跨账号回标是"尽力而为" | AutoAdd 巡检对齐兜底（mirror 消失 + rejected_names 归属） | ✅ 每 10min 自动对账一次 |
| 8 | 函数级崩溃（tick 中段被杀） | 云函数超时/容器回收 | 状态只写两种：mirror 维字段（幂等 set/update）、候选 progress（每维成功后更新）；中段崩溃最多丢一个维的"进行中"，下轮按 mirror 缺维重扫续跑 | ✅ mirror 是真相源，progress 只是加速 |
| 9 | 全链路观测 | — | 每 tick `bypass_log` 一条汇总 + 每菜状态迁移一条；env2Console candList 可查 failed/doing | — |

**幂等原则**：mirror 骨架 `doc(name).set`；维度写回由各维度函数自身保证（按名查 doc update 同字段）；候选状态迁移全部条件更新（带 status 前置）；`dish_candidates` 建 `{name}` 唯一索引防重复入池。

---

## 7. 常驻审核服务 对接（小改清单）

漏斗本身**零改动可跑**（它不管 source，只看七件套 + AI 查重 + env1 查重）。推荐加 1 处回标（让候选状态即时收敛，不等巡检）：

| 位置 | 改动 | 效果 |
|---|---|---|
| `server.js` approveInternal 写 env1 成功后（删 mirror 前后） | `db2.collection('dish_candidates').where({name}).update({data:{status:'done', doneAt:ts, note:'funnel_approved'}})` | 候选即时 done |
| `server.js` `/api/reject` 写 rejected_names 后 | 同位置 update `status:'rejected', note:reason` | 候选即时 rejected |
| `server.js` autoReject（AI 判重自动驳回路，若有） | 同上 | 同上 |

> 注意：这两处 update 是**尽力而为**（失败只 console.warn，不影响主流程）；即使一直没加，§5.2 的巡检对齐也会在 10min 内把状态收敛（rejected 靠 rejected_names 归属判定）。

---

## 8. 上线步骤（实施顺序）

1. **建集合与索引**（env2 控制台/脚本）：`dish_candidates`（name 唯一）、`dish_lexicon_snapshot`（name 唯一）。
2. **写 `bypassAutoAdd/index.js`**（按 §4.1 拆函数，优先复用 `_shared/rateLimiter.js` 与 bypassGenDish 的 getEnv1 跨账号代码段）。
3. **改 `bypassScheduler`**：TRIGGER_MAP + DEGRADE_STOPS 各加一行。
4. **部署**：参照 `scripts/_tmp_deploy_env2_fix.js` 模式（CloudBase manager-node `updateFunctionCode`，functionRootPath=<repo>/env2_functions）；bypassAutoAdd timeout=300s；bypassScheduler timeout 调 600s。部署后 invoke `{task:'health'}` 验 BUILD_TAG。
5. **控制台加定时触发器** `sched-auto-add`（cron 每 10min、秒位错开），绑定 bypassScheduler。
6. **停 bypassGenDish 发明模式**（GEN_DISABLED=true 或暂停 sched-gen-dish 触发器）——候选驱动取代 AI 乱发明；rejected_names 持续生效。
7. **写 `scripts/cand_import.js`** 灌首批候选（比如 30 条，直接抄最近 md 清单验证）。
8. **灰度验证**：跑 2~3 个 tick → 查 bypass_log + dish_candidates（应有 claimed/doing/ready）→ 审核服务器 漏斗应自动吃 ready → env1 出现 pendingCheck 新菜 → 食材核对自动跑。
9. **盯 24h**：日配额、failed 原因分布、429 频率；调 roundN/时间盒/配额。
10. （可选）env2Console 人工台 + review-web 回标 + bypassDedup checkOne，按 §4.3/§7 排期。

---

## 9. 风险与未决项

| 项 | 说明 | 建议 |
|---|---|---|
| bypassGenDish 与 bypassAutoAdd 双轨 | 前者仍会向 mirror 发明新菜（source=ai-generated），污染漏斗队列 | 上线即停（步骤 6）；后续若要 AI 发明，改造成只写 dish_candidates(new) 走同一消费端 |
| 各维度函数增量模式会顺带补 candidate-auto 的缺维 | 现有 10min 定时器（text/enrich/nutrition/image）扫 mirror 缺维时会一起补——**这是好事**（额外自愈），但需确认无 source 白名单排斥（bypassGenReason 只扫 cookbook/env1-backfill 源 → 不影响） | 上线后查 bypass_log 观察是否有重复生成同维（同字段幂等写，无害） |
| 快照 6h 滞后窗口 | env1 刚入库的菜 6h 内被当新候选重复生成 | 漏斗 AI 终审 + env1 食材核对会拦；可接受；介意则把漏斗 AI 查重结果回写 candidate.note 形成负反馈 |
| guide 维 | 漏斗 SEVEN 含 guide 但 dishadd 手工链没生成它也入库了（说明漏斗 autoApprove 未强制查七件套）；本设计把 guide 列入闸门但**允许缺失放行记 note** | 首版观察：若 guide 缺失导致漏斗队列判 missingDim 卡住，则把 bypassGenGuide 提为必生成 |
| 配额口径 | "每日 ≤30" 按 readyAt 归属自然日还是 createdAt？ | 默认按 createdAt（录入日），超配额当天不认领新菜只续 doing；参数可调 |
| 候选 category/kind 质量 | 类别错了 → env1 查表候选池分槽错（今天 dishadd 骨架已固化 KIND_BY_CAT） | 录入端必填 category；AutoAdd 建骨架时同款映射兜底 |

---

## 10. 文件改动清单（汇总）

| 路径 | 动作 |
|---|---|
| `env2_functions/bypassAutoAdd/index.js` | **新增**（核心编排，§4.1） |
| `env2_functions/bypassScheduler/index.js` | 改：TRIGGER_MAP/DEGRADE_STOPS 各 1 行 |
| `scripts/cand_import.js` | 新增：md 清单 → dish_candidates 导入 |
| `env2_functions/bypassGenDish/index.js` 或控制台 | 停用发明模式（部署动作，非代码） |
| `scripts/review-web/server.js`（审核服务器 侧） | 可选：approve/reject 回标 2 处 update |
| `env2_functions/env2Console/index.js` | 可选：candList/candRetry/candRemove/candAdd |
| 腾讯云开发控制台 | 建 2 集合 + 唯一索引 + sched-auto-add 触发器 + 超时调整 |
