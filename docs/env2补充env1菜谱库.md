# env2 补充 env1 菜谱库

> 合并文档 · 2026-08-22 · 整合自《env2旁路服务env1规划》《env2免费AI额度辅助env1落地方案》《env1接入env2旁路功能指南》《env1-env2功能架构与下一步》四篇
> **2026-08-22 二次更新**：基于代码现状核查，更新函数数（env1 65→85 / env2 16→19）、dish_mirror（39→40）、同步通道（新增 syncFromEnv2）、环境变量状态（已配）、下一步章节。
> **核心定位**：env2 的唯一作用 = **补充 env1 菜谱库**。env2 用免费 AI 额度生成新菜五件套 → 同步到 env1 审核池 → 管理员审核入库 → 丰富 env1 菜谱库 → 推荐主链路消费。

---

## 一、核心闭环（一句话）

```
env2 定时器生成新菜五件套（菜名/画像/营养/做法/菜图）
  → 存 env2 dish_mirror
  → 同步到 env1 五个 _pending 审核池（两条通道并存）：
      通道一：env2Console sync-to-env1（env2→env1 主动写，真机触发）
      通道二：syncFromEnv2（env1→env2 主动拉，env1 侧触发，推荐）
  → 管理员 manageLexicon 审核通过 → 分流写 env1 正式库
  → getRecommendation 出文排序加画像增强分 + 新菜探索分
  → 用户反馈驱动曝光累计/淘汰
```

**全程红线**：env1 推荐主流程（出文+流式）零阻塞、零侵入、零依赖 env2。

---

## 二、环境概览

| 环境             | 目录                            | 小程序 AppID          | 云环境 ID                    | 函数数 | 定位                         |
| -------------- | ----------------------------- | ------------------ | ------------------------- | --- | -------------------------- |
| **env1**（主环境）  | `<repo>\cloudfunctions\` | wx0000000000000000 | your-env-id-1 | 85  | 面向用户主链路：推荐/出图/做法/审核/用户数据   |
| **env2**（补充环境） | `<repo>\env2_functions\` | wx1111111111111111 | your-env-id-2 | 19  | AI 生成新菜五件套，产物存 dish_mirror |

### 2.1 通信机制：环境共享（已开通）

- **env2 是资源方**：env2 后台开通环境共享，授权 env1 使用；env2 部署 `cloudbase_auth`（白名单 `['wx0000000000000000']`）。
- **env1 是调用方**：env1 云函数通过 `new cloud.Cloud({resourceAppid:'wx1111111111111111', resourceEnv:'your-env-id-2'})` 调 env2。
- **反向回写**：env2 用同款共享实例 `new cloud.Cloud({resourceAppid:'wx0000000000000000', resourceEnv:ENV1_ENV_ID})` 写 env1 库（需 env1 对称部署 `cloudbase_auth` + 安全规则放行 `auth.custom.fromAppid==='wx1111111111111111'`）。
- **跨账号限制**：真机小程序调用 ✅；MCP/开发者工具/timer 触发 ❌（`getCrossAccountToken:fail`）。同步必须真机链路触发。

### 2.2 额度独立

env2 成长计划免费额度：**10 亿 Token + 10 万张图**。环境共享是"资源授权"非"额度合并"——env2 烧自己的额度，env1 额度不增不减。env2 是"独立算力/额度缓冲池"，价值在于把 env1 主链路负载挪到 env2 独立额度上。

---

## 三、核心闭环详解

### 3.1 生成端：env2 定时器流水线

每 30 分钟一轮，错峰 5 分钟：

```
0/30 分  bypassGenDish     hy3 生成菜名 → 去重 → 写 dish_mirror 骨架（category/mealTime/cuisine...）
5/35 分  bypassAiEnrich    扫缺 profile 的骨架 → hy3 生成画像 → 写 dish_mirror.profile
10/40 分 bypassNutritionEst 扫缺 nutrition → hy3 估算四元组 → 写 dish_mirror.nutrition
15/45 分 bypassText        扫缺 guide → hy3 生成做法 → 写 dish_mirror.guide
20/50 分 bypassGenImage    扫缺 imageUrl → hy3 生图 → COS → 写 dish_mirror.imageUrl
```

| 函数                 | 触发器                  | cron（7 段）           | 职责        |
| ------------------ | -------------------- | ------------------- | --------- |
| bypassGenDish      | `gen-dish-every-30m` | `0 */30 * * * * *`  | 生成菜名写骨架   |
| bypassAiEnrich     | `timer-ai-enrich`    | `0 5,35 * * * * *`  | 补画像       |
| bypassNutritionEst | `timer-nutrition`    | `0 10,40 * * * * *` | 补营养       |
| bypassText         | `timer-text`         | `0 15,45 * * * * *` | 补做法       |
| bypassGenImage     | `timer-gen-image`    | `0 20,50 * * * * *` | 补图        |
| bypassDedup        | —                    | `15 */30 * * * * *` | 相似菜去重     |
| bypassRetry        | —                    | `5 */15 * * * * *`  | 失败重试+死信队列 |
| bypassHealthCheck  | —                    | `10 */10 * * * * *` | 旁路健康巡检    |

**dish_mirror 现状（2026-08-22）**：**40 道菜**，其中 39 道五件套（category/mealTime/cuisine/profile/nutrition/guide/imageUrl）全部齐全，1 道「牛肉馅饺子」为新生成骨架（缺 guide/nutrition/imageUrl，等下游 bypassText/bypassNutritionEst/bypassGenImage 补齐）。覆盖菜/主食/小吃/汤羹/饮品/甜品六大类——与「今天吃啥呀」推荐六大类完全对齐。

### 3.2 同步端：两条通道并存（均已实现）

#### 通道一：env2Console sync-to-env1（env2→env1 主动写）

**函数**：`env2Console`（`env2_functions/env2Console/index.js:178`，BUILD_TAG=`2026-08-22.console-sync-lexicon`）

**流程**：

1. 查 dish_mirror 四件套齐全的菜（`source='ai-generated'` + profile/nutrition/guide exists）
2. 跨账号 init env1（`new cloud.Cloud({resourceAppid, resourceEnv})`）
3. 逐菜：下载 env2 图片 → 上传 env1 云存储 → 跨账号写 env1 五个 `_pending` 审核池
4. 去重（按 name+source 查 exists）+ force 重试 + 图片缺失自动补

**触发方式**：env2 小程序真机点「同步」Tab → 「开始同步」按钮（需真机链路，MCP/开发者工具/timer 不行）。

#### 通道二：syncFromEnv2（env1→env2 主动拉，更可行）

**函数**：`syncFromEnv2`（`cloudfunctions/syncFromEnv2/index.js`，BUILD_TAG=`2026-08-22.env1-sync-from-env2.v2`）

**流程**：

1. env1 侧跨账号 init env2（`new cloud.Cloud({resourceAppid:'wx1111111111111111', resourceEnv:'your-env-id-2'})`）
2. 读 env2 dish_mirror 四件套齐全的菜
3. 逐菜：下载 env2 图片 → 上传 env1 云存储 → 写 env1 五个 `_pending` 审核池
4. 去重 + 增量扫描

**优势**：env1 侧调用，不依赖 env2 真机触发，可在 env1 管理后台或定时器触发，更可控。

#### env1 五个审核池（两通道共用）

| 集合                        | 内容                                                  |
| ------------------------- | --------------------------------------------------- |
| `dish_lexicon_pending`    | 菜名词条（source='env2-newdish'）                         |
| `dish_ai_profile_pending` | AI 画像（spicy/flavors/cuisine/type/main/isVeg/isSoup） |
| `dish_nutrition_pending`  | 营养 [热量,蛋白,碳水,脂肪]                                    |
| `dish_guide_pending`      | 做法文本                                                |
| `dish_image_pending`      | 图片 fileID                                           |

**环境变量状态（2026-08-22 核查）**：

| 函数                          | ENV1_ENV_ID                   | ENV1_WRITE_BACK | 状态         |
| --------------------------- | ----------------------------- | --------------- | ---------- |
| env2Console                 | ✅ `your-env-id-1` | ✅ `true`        | 已配，可真机触发   |
| bypassGenDish               | ✅ 同上                          | ✅ `true`        | 已配         |
| bypassNutritionEst          | ✅ 同上                          | ✅ `true`        | 已配         |
| bypassEnrich                | ✅ 同上                          | ✅ `true`        | 已配（残留回写开关） |
| bypassAiEnrich              | ❌ 仅 TCB_ENV                   | —               | 无需跨账号      |
| bypassText / bypassGenImage | ❌ 无                           | —               | 无需跨账号      |

### 3.3 入库端：manageLexicon 审核入库

**函数**：`manageLexicon`（BUILD_TAG=`2026-08-21.lexicon-split-review-v1`）

**action**：`listPending` / `approvePending` / `rejectPending` / `deletePending`，按 `collection` 参数分流审核。

**approvePending 分流写正式表**：

| 审核池                       | 正式库                                    |
| ------------------------- | -------------------------------------- |
| `dish_lexicon_pending`    | `dish_lexicon`（新菜本体）                   |
| `dish_ai_profile_pending` | `dish_lexicon.profile`（同名记录追加）         |
| `dish_nutrition_pending`  | `dish_nutrition`（_id=菜名, n=四元组）        |
| `dish_guide_pending`      | `dish_guide`（_id=菜名, guide=文本）         |
| `dish_image_pending`      | `dish_images`（_id=菜名, imageUrl=fileID） |

**前端 admin**：tab 13 探索菜库 / tab 15 画像 / tab 16 营养 / tab 17 做法 / tab 18 菜图，通用 `loadPendingReview`/`approvePendingReview` 按 tab 号映射集合名。

### 3.4 消费端：getRecommendation 出文增强

**接入位置**：`getRecommendation` 排序函数内，算完基础分后追加两项加成：

```javascript
score = baseScore                          // 原有基础分（偏好权重 × 历史反馈）
      + aiMatchBonus(profile)              // 画像增强分（env2 产物）
      + exploreBonus(dish)                 // 新菜探索分（env2 发明的菜）
```

**画像增强分 `aiMatchBonus`**：读 `dish_library.aiProfile`（由 sync 同步），命中：口味+2 / 菜系+3 / 分类+2 / 忌口-6 / 主食偏好+2 / 辣度落位±1~2；未命中 +0（走原逻辑兜底）。批量查优化：`where({ name: _.in(allCandidateNames) })`。

**新菜探索分 `exploreBonus`**：

```javascript
function exploreBonus(dish) {
  if (dish.source !== 'ai-generated') return 0;      // 非 AI 新菜不加
  if (!dish.isNew) return 0;                          // 已过探索期不加
  if (dish.aiExposure >= 3) return 0;                 // 曝光≥3次去掉 isNew
  return 5;                                           // 探索期加 5 分
}
```

**比例控制**：最终候选里 `source='ai-generated'` 的菜不超过 2 道，放在候选第 5-8 位（不占主位）。

**反馈衰减与淘汰**：

| 事件               | 操作                       |
| ---------------- | ------------------------ |
| 新菜被推荐            | `aiExposure += 1`        |
| 曝光 ≥3 次          | 去掉 `isNew` 标记，回归正常排序     |
| 曝光 ≥5 次且点击率 <10% | 降权或标记 `aiRejected`（不再推荐） |

---

## 四、核心原则（红线）

**「不影响 env1 推荐主流程」的 6 条红线**：

1. **出文不搬**：`getRecommendation` 主出文（hy3 文本 + 流式）永远留在 env1，不迁 env2。
2. **不 await**：env1 对 env2 的所有调用都是 fire-and-forget 单向投递——投递即返回，绝不 `await env2.callFunction` 等结果。
3. **不占并发**：禁止同步溢出（env2 的 `aiProxy`/`generateImage` await 模式占 env1 云函数实例+时长，一票否决）。
4. **有兜底**：env1 读取侧永远保留原逻辑兜底（补图未就绪前端退避、营养未补估用近似、缓存未命中走实时计算），env2 产物只是「事后更好」。
5. **失败静默**：env2 任务失败仅记 `bypass_log`，不影响 env1 任何路径。
6. **触发点最小化**：优先「env2 主动拉取」（env1 零改动）；确需 env1 加投递点的，必须是非关键路径 fire-and-forget（如出文后、430 时）。

**产物审核纪律**：env2 回写 env1 的 AI 产物一律过 `security.msgSecCheck` + 黑名单 + 审核池，禁止直写正式库。

---

## 五、env1 ↔ env2 关系现状

### 5.1 已断开（detach 完成）

| 通道                                                    | 状态                                     |
| ----------------------------------------------------- | -------------------------------------- |
| env1 getRecommendation → env2 bypassEnrich（营养补估投递）    | ✅ 已删                                   |
| env1 getRecommendation → env2 bypassCandidate（数据镜像投递） | ✅ 已删                                   |
| env2 bypassGenDish → env1（回写审核池）                      | ✅ 已删（改由 env2Console sync-to-env1 真机触发） |
| env2 bypassNutritionEst → env1（回写审核池）                 | ✅ 已删                                   |
| env2 bypassCandidate → env1 recommend_cache           | ✅ 已删                                   |
| env1 autoLexiconFix → env2 bypassLexiconFix           | ✅ 已清理（改回本地 AI）                         |
| env1 env2Client.js 孤儿文件                               | ✅ 已删                                   |
| env2 bypassLexiconFix → env1 dish_lexicon_pending     | ✅ 已清理（删 env1 回写代码 + 清 ENV1_WRITE_BACK） |
| env2 verifyWb → env1 recommend_cache                  | ✅ 已删                                   |

### 5.2 残留（默认关，风险可控）

| 通道                                            | 位置                                     | 现状                                                                                  |
| --------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| env2 bypassEnrich → env1 dish_lexicon_pending | `env2_functions\bypassEnrich\index.js` | ✅ 已关闭（2026-08-22：代码强制 `ENV1_WRITE_BACK=false` + 云函数环境变量改 false，改由 syncFromEnv2 主动拉） |
| env1 cloudbase_auth                           | `cloudfunctions\cloudbase_auth\`       | env2→env1 鉴权函数，通道一需要；通道二（syncFromEnv2）不需要                                           |

---

## 六、函数清单

### 6.1 env1（85 个，按职责分组）

**A. 主链路 / AI 出文出图**

| 函数                | 职责                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------- |
| getRecommendation | 推荐主入口（7076 行）：生成菜品/主食/配饮，探索臂 UCB、画像注入、去重、限流槽位、仅 hy3 单通道（hy3-preview 已于 2026-08-27 移除） |
| getCookGuide      | 查看菜品做法：cookbook.json 优先，未命中调 hy3 生成                                                   |
| getDishImage      | 菜品出图：混元 image 3.0，10 槽位并发限流，dish_images 缓存                                            |
| autoLexiconFix    | 出文后怪名 AI 规范化 → dish_lexicon_pending（已 detach env2）                                    |
| validateAllergen  | 过敏原/食材合法性 AI 校验                                                                       |
| cloudbase_auth    | env1 资源方鉴权：env2 跨账号调用时注入 auth.custom                                                  |

**B. 词典 / 审核池管理**

| 函数                 | 职责                                                         |
| ------------------ | ---------------------------------------------------------- |
| manageLexicon      | 管理员审核：list/approve/reject，按 source 分流写正式库，5 个 pending 集合中转 |
| recordFeedback     | 用户采纳菜沉淀进 dish_lexicon                                      |
| submitContribution | 贡献菜名/食材：去重+AI 审核+记 dish_contrib                            |
| mergeContributions | 贡献合并：通过审核的并入正式库                                            |

**C. 用户数据 / 偏好 / 历史**：getPrefs / savePreferences / rateDish / userAvoid / getHistory / getHistoryDetail / favorite / getInsight / getDecideStats / getWeightOverview / deleteAccount

**D. 免费次数 / 签到 / 兑换**：signIn / consumeFreeCount / getDailyStats / getFreeLog / grantBonus / redeemCode / manageRedeem

**E. 管理后台**：adminLogin / amIAdmin / adminGeneric / manageUser / manageFeedback / manageBlocklist / manageContrib / manageAnnouncement / manageGuide / manageShopping / manageCFSwitch / manageThompson / getAdminStats

**F. 离线模型 / 备份 / 运维**：computeBaseline / computeCF / autoBackup / backupData / mailNotify

**G. env2 同步通道（env1 侧主动拉/推）**

| 函数                    | 职责                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **syncFromEnv2**      | env1 主动从 env2 拉新菜产物到审核池：跨账号读 env2 dish_mirror → 下载 env2 图片上传 env1 云存储 → 写 env1 五个 _pending（BUILD_TAG=`2026-08-22.env1-sync-from-env2.v2`） |
| **syncLexiconToEnv2** | env1 把 dish_lexicon 同步到 env2 供 bypassGenDish 去重                                                                                           |

**H. 其他 / 临时 / 运维探针**：getGuide / getAnnouncement / getCommunityIngredients / getSysConfig / getMyOpenid / submitFeedback / submitDishFeedback / commitRecommendation / seedIngLib / seedIngPreset / chkIngCount / dedupDishLib / fixImageUrl / probeReason / probeStream / recProbe / streamProbe / txtConcProbe / batchFixReason / bulkCleanAdmin / cleanDishImages / cleanIngBad / cleanIngSeed / fixNutriTmp / imgProbe / loadTest / migrateSplitMaster / probeCompress / probeDishImages / probeHy3Preview / secTest / tempCleanRealUsers / tempClearBackups / tmpClassify / txtProbe / _fixNutri

### 6.2 env2（19 个，本地 17 + 云上遗留 2）

| 函数                       | 职责                                                                                       | 定时器         |
| ------------------------ | ---------------------------------------------------------------------------------------- | ----------- |
| **bypassGenDish**        | AI 生成菜名写骨架（核心）                                                                           | ✅ 每 30 分钟   |
| **bypassAiEnrich**       | 补画像 + 偏好解析                                                                               | ✅ 每 30 分钟错峰 |
| **bypassNutritionEst**   | 补营养四元组                                                                                   | ✅ 每 30 分钟错峰 |
| **bypassText**           | 补做法文本                                                                                    | ✅ 每 30 分钟错峰 |
| **bypassGenImage**       | 补菜图                                                                                      | ✅ 每 30 分钟错峰 |
| bypassCandidate          | 候菜 per-user 预计算（UCB+MMR）                                                                 | 无           |
| bypassEnrich             | 三库富集（营养查表+关键词兜底，ENV1_WRITE_BACK 已关闭）                                                     | 无           |
| bypassLexiconFix         | 菜名规范化                                                                                    | 有逻辑         |
| bypassDedup              | 相似菜去重                                                                                    | ✅ 每 30 分钟   |
| bypassRetry              | 失败重试+死信队列                                                                                | ✅ 每 15 分钟   |
| bypassHealthCheck        | 旁路健康巡检                                                                                   | ✅ 每 10 分钟   |
| bypassReviewContribution | 投稿 AI 初筛（骨架）                                                                             | 无           |
| **env2Console**          | 控制台数据聚合（overview/gen-progress/sync-to-env1/sync-lexicon-from-env1/fix-reason/log-rotate） | 无           |
| bypassScheduler          | 统一调度入口（触发器全删，空转）                                                                         | 无           |
| aiProbe                  | env2 cloud.ai() 探针                                                                       | 无           |
| cloudbase_auth           | env2 资源方鉴权                                                                               | 无           |
| **fixReasonInEnv2**      | 运维函数：补 dish_mirror 缺失的 reason 字段                                                         | 无           |
| aiProxy ⚠️               | 云上遗留旧函数（同步溢出模式，本地无目录，禁用）                                                                 | 无           |
| generateImage ⚠️         | 云上遗留旧函数（同步溢出模式，本地无目录，禁用）                                                                 | 无           |

---

## 七、数据库集合

### 7.1 env1（42 个，核心）

| 集合                                                                                                            | 用途               |
| ------------------------------------------------------------------------------------------------------------- | ---------------- |
| dish_lexicon / dish_lexicon_pending                                                                           | 菜名词典正式库 / 审核池    |
| dish_ai_profile_pending / dish_nutrition_pending / dish_guide_pending / dish_image_pending                    | 画像/营养/做法/图片审核池   |
| dish_nutrition / dish_guide / dish_images                                                                     | 营养/做法/图片正式库      |
| dish_library / dish_exposure / dish_feedback / dish_contrib / dish_name_fix                                   | 菜库/曝光/反馈/贡献/名修正  |
| user_preferences / user_no_map / recommend_history / favorites                                                | 用户数据             |
| free_log / counters / sys_config / cf_model / persona_baseline                                                | 次数/计数/配置/CF模型/基线 |
| 其余：deleted_users / data_backups / feedback / guide_docs / announcements / ingredient_library / redeem_codes 等 | 运维/内容/食材/兑换      |

### 7.2 env2（10 个）

| 集合                                                   | 用途                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| **dish_mirror**                                      | 核心：菜库镜像（name/category/mealTime/profile/nutrition/guide/imageUrl...） |
| prefs_mirror / exposure_mirror                       | 用户偏好镜像 / 曝光镜像                                                       |
| recommend_cache                                      | 推荐缓存（env2 本地，env1 不读）                                               |
| dish_lexicon_pending / dish_lexicon / dish_nutrition | 审核池副本 / 查重 / 营养副本                                                   |
| bypass_log / bypass_dead_letter / sys_config         | 任务日志 / 死信 / 降级配置                                                    |

---

## 八、演进路线：从"实时调 AI"到"查表推荐"

env2 用 AI 离线蒸馏出领域专用菜品库，env1 查表用，运行时不依赖 AI。本质是 RAG / 模型蒸馏——把 AI 能力"固化"到库里，蒸馏产物是结构化菜品库而非模型权重。

```
阶段 1（当前 · 库还薄）：
  env1：正常服务用户，主出文调 hy3 流式
  env2：闷头建库，bypassGenDish 大规模生成新菜 + 全量补数据
  → env1 不受影响，env2 用免费额度持续丰富库

阶段 2（库渐丰富 · 几百到几千菜）：
  env1：卸载异步 AI，主出文仍调 hy3；排序加画像增强 + 新菜探索分
  env2：继续建库 + 维护（季节菜/口味趋势）
  → 推荐质量提升，env1 槽位释放给主出文

阶段 3（库足够丰富 · 几千菜全量数据）：
  env1：出文走查表 + 算法排序 + 模板拼装，零 AI 调用
  env1：零延迟/零额度消耗/高并发
  env2：只在需要时维护（新菜/季节变化/口味趋势），日常不跑
  → 完全脱离 AI，纯查表推荐
```

**为什么现在建库最划算**：额度是总量的（用完没了不过期），建几千道菜消耗不到 1%；没人用=没压力，env2 全力建库不受并发/延迟约束；库就是核心壁垒；用户来了直接用零延迟体验。

---

## 九、生成质量控制

### 9.1 种子驱动而非凭空发明

先把 env1 `dish_library` 已有真实菜名灌进 env2 `dish_mirror` 作为种子，hy3 基于种子生成变体（同食材换做法 / 同菜系换食材），而非凭空发明。真实菜谱变体质量远高于 AI 凭空造菜。

### 9.2 分步生成 + 每步校验丢弃

```
生成菜名 → 校验（2-12字 / 纯中文 / 黑名单 / 去重）      不通过→丢弃
生成食材 → 校验（食材白名单内 / 数量合理）              不通过→丢弃
生成画像 → 校验（一致性交叉校验）                        不通过→丢弃
生成营养 → 校验（素菜不高蛋白 / 汤类低热量等）           不通过→丢弃
生成做法 → 校验（≥18字 / BAD_WORDS 黑名单 / 步骤通顺）   不通过→丢弃
生图     → 校验（文件 >10KB）                             不通过→丢弃
hy3 自评 → 校验（菜名合理性/食材常见性/做法可行性 <70分） 不通过→丢弃
```

每步不通过直接丢弃，不进审核池，省管理员负担。

### 9.3 画像一致性交叉校验

| 矛盾                                       | 判定  |
| ---------------------------------------- | --- |
| `isVeg=true` 但 `main=猪肉/牛肉/鸡肉`           | 丢弃  |
| `isSoup=true` 但 `type=炒菜/凉菜`             | 丢弃  |
| `spicy=3` 但 `flavors` 不含"辣"              | 丢弃  |
| `cuisine=粤菜` 但 `flavors=酸辣`（酸辣属川湘）       | 降分  |
| `isVeg=true` 但 `flavors` 含"蒜香"且 main 不含蒜 | 降分  |

### 9.4 营养合理性校验

| 规则                                          | 判定    |
| ------------------------------------------- | ----- |
| 热量 20-2000 / 蛋白 0-100 / 碳水 0-200 / 脂肪 0-150 | 超范围丢弃 |
| `isVeg=true` 但蛋白 >40g（除非 main 含豆制品）         | 降分    |
| `isSoup=true` 但热量 >400                      | 降分    |
| `type=凉菜` 但热量 >300                          | 降分    |

### 9.5 hy3 自评打分

生成完整菜品后，让 hy3 对该菜打分（菜名合理性/食材常见性/做法可行性/营养合理性，0-100），<70 分直接丢弃。额外消耗约 200 token/菜，大幅减少垃圾菜入库。

### 9.6 人工审核兜底

自动筛选后只剩高质量候选 → 管理员 tab 13-18 确认 → 落库。自动筛选越严，人工审核量越少。

---

## 十、费用预算

**免费额度**：10 亿 Token + 10 万张图（env2 成长计划）。

| 任务          | 函数                 | 单次消耗           | 月度估算（月增 100 菜 + 50 活跃用户）      | 占免费额度                     |
| ----------- | ------------------ | -------------- | ----------------------------- | ------------------------- |
| 菜品画像 AI-1   | bypassAiEnrich     | hy3 ≈456 token | 45,600 token                  | 0.005%                    |
| 偏好画像 AI-2   | bypassAiEnrich     | hy3 ≈456 token | 22,800 token                  | 0.002%                    |
| 候菜打分 AI-3   | bypassCandidate    | 0 token（纯本地）   | 0                             | 0%                        |
| 补图          | bypassGenImage     | 1 张图           | 100 张                         | 0.1%                      |
| 营养补估        | bypassNutritionEst | hy3 ≈328 token | 32,800 token                  | 0.003%                    |
| 非实时文本 guide | bypassText         | hy3 ≈328 token | 32,800 token                  | 0.003%                    |
| 菜名规范化       | bypassLexiconFix   | hy3 ≈264 token | 26,400 token                  | 0.003%                    |
| **合计**      | —                  | —              | **≈193,688 token + 100 张图/月** | **token 0.019% / 图 0.1%** |

**结论**：月度消耗远在免费额度内。即使月增 1000 菜，token 消耗 ≈194 万（占 0.19%），仍极充裕。真正需要监控的是上游 429 并发（SLOT_N=6 已限流），而非额度总量。

---

## 十一、兜底口径固化清单

> 原则：env2 任何产物未就绪时，env1 必须能回退原逻辑、不报错、不阻塞。

| 产物                   | env2 来源                            | env1 读取侧                                        | 未就绪时 env1 回退               | 回退条件                   |
| -------------------- | ---------------------------------- | ----------------------------------------------- | -------------------------- | ---------------------- |
| 候选缓存 recommend_cache | bypassCandidate 回写                 | `where({_openid, sceneMode}).gt(expireAt, now)` | 走原 getRecommendation 全量计算  | 缓存不存在/过期/candidates=[] |
| 营养 dish_nutrition    | bypassNutritionEst → 审核池 → approve | `doc(菜名).get()` → `rec.n`                       | 走原 estimateNutrition 本地查表  | doc 不存在 / n 字段缺失       |
| 菜图 imageUrl          | bypassGenImage 回写 env1 COS         | getDishImage 读 fileID                           | 走原实时生图 / 430 占位图           | fileID 不存在 / 加载失败      |
| 做法 dish_guide        | bypassText → 审核池 → approve         | `doc(菜名).get()` → `guide`                       | 空 guide / 实时生成             | doc 不存在 / guide 为空     |
| 菜名规范化 dish_name_fix  | bypassLexiconFix → 审核池 → approve   | `doc(原名).get()` → `fixedName`                   | 用原名                        | doc 不存在                |
| 菜品画像 profile         | bypassAiEnrich AI-1                | bypassCandidate aiMatchBonus                    | 走原 baseScore 排序（无 AI-3 加分） | profile 字段缺失           |
| 偏好画像 profile         | bypassAiEnrich AI-2                | bypassCandidate aiMatchBonus                    | 走原排序（无 AI-3 加分）            | profile 字段缺失           |
| 审核池待审                | 各 bypass → dish_lexicon_pending    | manageLexicon tab13-18                          | 正式库无该条目，env1 走原逻辑          | status='pending' 未审核   |
| 调度降级跳过               | bypassScheduler 错峰/熔断              | —                                               | 下个非高峰窗口自动补跑                | 饭点高峰 / 额度剩<3%          |
| 重试超限死信               | bypassRetry → 死信集合                 | env2Console 可查                                  | 不影响 env1（env1 有兜底）         | retryCount ≥ 3         |

---

## 十二、运行机制增强（已落地）

| 机制        | 说明                                                        | 状态  |
| --------- | --------------------------------------------------------- | --- |
| 幂等与断点续跑   | 每道菜/每用户加 processedAt 标记，增量扫描只挑未处理项                        | ✅   |
| 画像过期重算    | 菜品/偏好画像加 aiUpdatedAt，30 天重算（RECALC_MS=30天）                | ✅   |
| 时令/过期下架   | 按季节档/节气给候选菜打 expireAt/seasonTag，反季降权 -3                   | ✅   |
| 相似菜去重     | bypassDedup v1，hy3 比对 + dedupChecked 标记                   | ✅   |
| 额度熔断与降级阶梯 | sys_config.degradeLevel：0 正常→1 停生图→2 停文本补估→3 只保留候菜画像      | ✅   |
| 产物体检      | 各 bypass v2：全零营养/文本黑名单/图<10KB/规范化无变化跳过                    | ✅   |
| 失败重试与死信队列 | bypassRetry v1，MAX_RETRY=3，死信 bypass_dead_letter          | ✅   |
| 旁路健康巡检    | bypassHealthCheck v1，9 函数+3 集合+fail1h>10 告警，每 10 分钟       | ✅   |
| 任务错峰      | bypassScheduler isPeakHour，11-13/17-19 跳过，4 timer 错峰 5 分钟 | ✅   |
| 候选包一致性校验  | validateCacheDoc，空候选/黑名单/数量≤20 校验                         | ✅   |

---

## 十三、下一步

### ✅ 已完成

- ✅ **ENV1_ENV_ID 环境变量配置**：env2Console / bypassGenDish / bypassNutritionEst 均已配 `ENV1_ENV_ID=your-env-id-1`；bypassEnrich 的 `ENV1_WRITE_BACK` 已关闭（改由 syncFromEnv2 主动拉）
- ✅ **bypassEnrich 回写已关闭**：代码 `ENV1_WRITE_BACK=false` + 云函数环境变量改 false
- ✅ **syncFromEnv2 已建**：env1 侧主动从 env2 拉新菜通道已实现（BUILD_TAG=`2026-08-22.env1-sync-from-env2.v2`），无需 env2 真机触发
- ✅ **syncLexiconToEnv2 已建**：env1 把菜名同步到 env2 供去重
- ✅ **env2Console 新增 task**：fix-reason（补 reason 字段）/ log-rotate（日志轮转）
- ✅ **autoLexiconFix 已 detach env2**：改回本地 AI，BUILD_TAG=`2026-08-22.auto-lexicon-fix-detach-env2`
- ✅ **dish_mirror 40 道菜**：39 道五件套齐全 + 1 道骨架待补

### 🔴 优先级高（待真机验证）

1. **触发同步试跑（二选一）**
   
   - **方案 A（env2 真机）**：env2 小程序真机点「同步」Tab → 「开始同步」→ 验证 40 道菜投到 env1 五个 _pending
   - **方案 B（env1 侧，推荐）**：env1 管理后台或定时器调 `syncFromEnv2` → 验证 env1 五个 _pending 有新菜（不依赖 env2 真机）

2. **env1 审核入库**
   
   - 管理员 tab 13-18 审核 sync 投递的新菜
   - manageLexicon.approvePending 分流写正式库
   - 验证 dish_lexicon/dish_nutrition/dish_guide/dish_images 有新菜

3. **env1 出文消费新菜**
   
   - getRecommendation 排序加 aiMatchBonus + exploreBonus
   - 验证候选含 AI 新菜（≤2 道，第 5-8 位）
   - submitDishFeedback 新菜曝光累计 + 淘汰

### 🟡 优先级中

4. **env1 侧对称 cloudbase_auth + 安全规则**
   
   - env1 部署 cloudbase_auth（白名单 `['wx1111111111111111']`）
   - env1 五个 _pending 集合安全规则放行 `auth.custom.fromAppid==='wx1111111111111111'`
   - 通道一（sync-to-env1）需要；通道二（syncFromEnv2）env1 自己写自己库，不需要

5. **getDishImage 优先查 env2 补图**
   
   - 出图逻辑最前面插缓存查：先查 dish_library.env2ImageUrl，有则直接返回
   - fileID 跨环境可读（同主体），无需跨账号下载

6. **卸载 env1 异步 AI 调用**
   
   - autoLexiconFix / submitContribution verify / getDishImage 430 改投递 env2
   - 释放 env1 hy3 额度/实例/并发槽位给主出文

### 🟢 优先级低

7. **bypassScheduler 清理**：TRIGGER_MAP 代码还在但触发器全删，可删或改造成纯手动调度入口

8. **菜肴反馈闭环**（bypassFeedbackLoop 新建）：定时扫 env1 反馈/收藏/采纳记录，聚合到候菜画像 prefs_mirror，让 AI-3 匹配打分随真实采纳不断自愈

9. **图片缓存/硬链**：生图后同时落 env2 本地桶缓存 + env1 桶 fileID，前端先走 env1 桶，env2 桶仅作备份

10. **权重体系对齐**：AI-3 打分在 env1 侧消费时对齐 sync_weights.js 权重口径

11. **清理云上遗留函数**：env2 云上的 aiProxy / generateImage（同步溢出模式，已禁用），确认无引用后从云上删除

---

## 十四、纪律与坑

1. **推荐主流程红线**：出文+流式不搬、不 await、不占并发；任何 env2 相关改动不得让 getRecommendation 变慢或失败。
2. **禁同步溢出**：永不 `await env2.callFunction` 等结果；env2 不充当 env1 主链路同步代理。
3. **投递点纪律**：确需 env1 加投递点的，只在非关键路径且 fire-and-forget；失败仅记日志，绝不影响主流程返回。
4. **AI 产物审核**：env2 回写 env1 的 AI 文本一律过 security.msgSecCheck + 黑名单 + 审核池，禁止直写正式库。
5. **跨账号 openid 不通**：不透传 env1 openid 查对方库；回写 _openid 由 env1 自带、env2 原样透传。
6. **失败静默降级**：env2 任务失败仅记 bypass_log，env1 有兜底逻辑（未命中走原逻辑）。
7. **hy3-preview 已于 2026-08-27 移除**：env2 所有文本调用直接配 hy3（env1 同步回退 hy3 单通道，见 `docs/hy3-preview下线迁移设计.md`）。
8. **部署纪律**：env2 函数改完即部署并验证 BUILD_TAG，禁止只改本地不部署。
9. **内容安全**：AI-4 探索新菜/文本过黑名单 + msgSecCheck；狗肉/蛇肉/猫肉不收录。
10. **改动范围**：只做「env2 异步补充菜谱库」，不重构 env1 主链路、不加新业务功能。

---

## 附：合并来源

本文档整合自以下四篇（内容有大量重叠，合并后以"补充菜谱库"为主线去重重组）：

| 原文档                     | 定位    | 合并贡献                               |
| ----------------------- | ----- | ---------------------------------- |
| env2旁路服务env1规划.md       | 最早规划稿 | 环境共享机制、四大任务拆解、落地步骤                 |
| env2免费AI额度辅助env1落地方案.md | 综合方案  | 6 条红线、辅助任务全景、实施阶段、费用预算、运行机制增强、兜底清单 |
| env1接入env2旁路功能指南.md     | 接入指南  | 8 个接入点、出文排序增强、新菜探索分、演进路线、生成质量控制    |
| env1-env2功能架构与下一步.md    | 最新现状  | 函数清单、数据库集合、关系现状、下一步                |