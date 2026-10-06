# env1 管理后台「env2 菜审核」一键入库 / 一键同步 / 驳回重生成 规划

> 版本：v0.2（规划稿·已确认决策，未改动代码）
> 状态：待评审
> 关联文档：`env2补充env1菜谱库.md`、`AGENTS.md`

## 1. 背景与目标

env1 管理后台（`pages/admin`）目前通过多个 tab 审核 env2 同步来的新菜：

| Tab | 审核集合 | 现有能力 |
|-----|---------|---------|
| 13 探索菜库审核 | dish_lexicon_pending | 通过 / 驳回 / 删除 |
| 15 画像审核 | dish_ai_profile_pending | 通过 / 驳回 / 删除 |
| 16 营养审核 | dish_nutrition_pending | 通过 / 驳回 / 删除 |
| 17 做法审核 | dish_guide_pending | 通过 / 驳回 / 删除 |
| 18 菜图审核 | dish_image_pending | 通过 / 驳回 / 删除 |

工作痛点：
1. 每道菜都要在多个 tab 逐个点"通过"，操作量大（env2 已有 236 道菜入库待检）；
2. 审核前需手动等待/触发 `syncFromEnv2`，缺少"一键同步"入口；
3. 驳回只是置 status，不记录原因、不反馈 env 重新生成，菜被白白丢弃；
4. 无法对单道菜定向调用 env2 的某个生成函数（如"这里做法不好，重生成做法"）。

本方案在管理后台增加三个能力：
1. **一键入库**：env2 来源已就绪的菜批量审核通过，写入正式库；
2. **一键同步**：手动触发 `syncFromEnv2` 将 env2 dish_mirror 新菜同步为待审；
3. **驳回重生成**：驳回时记录原因；点按钮把菜名送回 env2，按需调 env env 对应的单菜生成函数重新生成；完成后"同步"回待审列表。

## 2. 功能需求（用户视角）

### 2.1 一键同步（列表顶部按钮）
- 点击「一键同步」→ 调 `syncFromEnv2`，
- 同步结果返回：`synced/同步、skipped/跳过, imgSynced/张图同步、remaining/剩余`，用 toast 展示并刷新列表。

### 2.2 一键入库（列表顶部按钮，先预览差异再提交）
- 点击「一键入库」→ 先**预览差异**（不实际入库）：
  - 后端 `batchPreview` 扫描 dish_lexicon_pending 中 `status=pending` 且 `source=env2-newdish` 的记录，分类输出：
    - `can_approve`（可入库：name 非空、dish_lexicon 无同名冲突）
    - `dup_lexicon`（正式库已有同名，跳过滤镜）
    - `missing_name`（缺 name，忽略）
- 前端并列展示各分类数量 + 可入库清单（name 列表），管理员**确认后**再调 `batchApprove` 提交。
- `batchApprove`：单次云函数内循环，复用现有 `manageLexicon approve` 的落库逻辑（写 `dish_lexicon` + 各独立库），返回 `{ approved, failed, details }`。

### 2.3 驳回 + 记录原因
- 原「驳回」改为「驳回」；点击后弹出原因选择/输入：
  - 常见预设：菜名不当 / 画像偏 / 营养不符 / 做法乱 / 图不符 / 食材错 / 其它
  - 可填写像文字说明
- 驳回时：
  1. 将该记录 status 置为 rejected；
  2. 写一条 `dish_env2_regen`（重生成请求）记录：
     - `name`（菜名）
     - `rejectReason`（原因+说明）
     - `env1By`(openid) / `env1At`(ts)
     - `target`（待选维度，初始全选）
     - `status`: `pending`(待重生成) / `applied`(已提交生成) / `done`(env回写完成) / `failed`
     - `genResult`（AI函数返回摘要）

### 2.4 单维度重新生成（驳回后操作）
- 在驳回后的某菜上展示维度按钮（勾选）：画像 / 食材 / 步骤 / 做法+点评+难度贴士 / 营养 / 图片。
- 后端将该菜在 env 数据库 dish_mirror「对应字段清空」并写入 `dish_regenerate_request（dishName + 目标」。
- env2 定时扫描器（新函数 `bypassRegen`，支持 dishName）按请求清单对每个维度的调用对应生成函数：
  | 维度 | env2 函数（均支持 dishName 单菜入口） | 后端清空/标记字段 |
  |------|--------------------------------------|-----------------|
  | 画像 | `bypassAiEnrich` | profile（置空） |
  | 食材 | `bypassGenIngredients` | ingredients（置空） |
  | 步骤 | `bypassGenSteps` | steps（置空） |
  | 做法/点评 | `bypassText` | review / difficulty / tips |
  | 营养 | `bypassNutritionEst` | nutrition |
  | 图片 | `bypassGenImage` | imageUrl（置空） |
- 单个维度重生成完成后写回 dish_mirror 并更新 regen 记录 status=`done`。

> 备注：多数 env2 生成函数已有 `event.dishName` 单菜入口；`bypassAiEnrich` 及 `bypassGenImage` 目前**仅**增量扫，需补 dishName 入口分支（改动点见 §4.2）。

### 3.5 重新同步回待审
- 对 `dish_env2_regen` 记录展示「重新同步」按钮：
  - 调 `syncFromEnv2`（跳过已驳回保护），把该菜（env 侧已重新生成完毕）重新以 `pending` 状态写回各 `_pending` 集合，重新进入人工审核；
  - 同时删除/归档旧的 regen 记录（status=resynced）。

## 3. 关键架构决策：跨账号调用 env2 函数

现状：跨账号写 env db 是可行的（`new cloud.Cloud({ resourceAppid, resourceEnv })`，且必须从小程序端触发才有微信上下文）。但**跨账号直接调用对方环境的云函数不可行**（历史踩坑：定时器/API 触发无微信上下文 → getCrossAccountToken 失败）。`syncFromEnv2` 也已因该原因删除定时触发器。

因此「送回 env2 重新生成」必须采用**「env1 写入请求 → env2 定时扫描执行」**的方式，而不是 env1 同步 invoke env2。

方案判定（已确认）：

- **✅ 方案 A（已采用）**：新增 env2 函数 `dishRegenPoll`，定时**每 2 分钟**扫 `dish_regenerate_req` status=pending，执行后写回；后续以增量生成补充，与现有 `bypassGenDish` 链式任务兼容。
- 方案 B（HTTP 网关 + 鉴权）：改造量大，暂不采用。

**本文档按方案 A 深化。**

## 4. 具体设计

### 4.1 数据集合

**env1 侧（管理后台）**
- `dish_env2_regen`（新），结构：
  ```json
  {
    "_id": "...",           // 或复用 pendingId
    "name": "菜名",
    "sourceDocId": "dish_lexicon_pending.docId",
    "rejectReason": "做法不符实际",
    "reasonCode": "guide_bad",
    "openid": "管理员",
    "rejectedAt": 12345,
    "dims": ["guide","ingredients"],   // 用户勾选的重新生成维度
    "status": "pending" | "done" | "resynced" | "failed",
    "reqId": "发给 env2 的请求记录 _id" (写入时 donor)
  }
  ```
- 复用已有 `dish_lexicon_pending / dish_ai_mirror... dish_guide_pending / dish_image_pending` 做待审资源。

**env2 集合**
- `dish_regenerate_req`（新），env1 侧通过跨账号 db 写入：
  ```json
  {
    "_id": "<uuid>",
    "name",
    "targets": ["profile","ingredients","steps","text","nutrition","image"],
    "status": "pending"|"done"|"failed",
    "createdAt", "finishedAt",
    "result": { }   // 各 target 生成结果
  }
  ```
- 若该菜尚未在 dish_mirror（极端情况），扫描器先根据 name 兜底建立骨架。

### 4.2 后端改动

**env1 云函数（部署在 env1）**

`cloudfunctions/manageLexicon/index.js` 增/改：
- `action='batchPreview'`：只读扫描，分类汇总可入库/重复/缺 name 清单，**不落库**。
- `action='batchApprove'`：对指定清单（或全量 can_approve）批量 approve（入 dish_lexicon + 各落库），返回 `{ approved, failed, details }`。
- `action='rejectWithReason'`：以原因设置 rejected 并写 `dish_env2_regen`。
- `action='regenDish'`：写 env2 `dish_regenerate_req`（跨账号），并回写 regen 记录状态。
- `action='resyncRegen'`：将完成生成的菜重新置 pending。

**新增桥接云函数 `manageEnv2Regen`（推荐，独立职责）**
- 若担心 manageLexicon 膨胀，可将 regenDish / resyncRegen / batchPreview / batchApprove 单独放入 `cloudfunctions/manageEnv2Regen`。倾向独立函数，便于权限与维护。

**env2 云函数（部署在 env2）**
- 新增 `dishRegenPoll`：
  - **每 2 分钟**（cron `0 */2 * * * * *`）扫 `dish_regenerate_req` status=pending；
  - 顺序执行各 target → 调对应 env2 函数（优先 dishName 单菜入口）→ 全部成功置 done，单维度失败记 failed 不阻塞整体；
  - 完成后置 `finishedAt`，供 env1 端「重新同步」读取判断。
- 修改 `bypassAiEnrich`、`bypassGenImage`：为现有单菜生成逻辑暴露 `event.dishName` 分支（与 `genOne` 类似）。

### 4.3 前端改动（pages/admin）

- **新增 tab「env2 菜审核」**（独立 tab，或其 table 顶部来源筛选 env2）+ 顶部工具栏：
  ```
  [一键同步] [一键入库(预览)]    (顶部)
  状态筛选: 待审/已驳回/已完成     来源: env2
  ┌──────────────────────────────┐
  │ 菜名  标签  来源  状态  操作   │
  │ [驳回(原因)] [重新生成] [重新同步] │
  └──────────────────────────────┘
  [重生成记录列表：引用 dish_env2_regen]
  ```
- `admin.js` 新增：
  - `runSync()` → `call('syncFromEnv2', { batchSize: 15 })`
  - `previewApprove()` → `call('manageEnv2Regen', { action: 'batchPreview' })` → 弹层展示差异清单
  - `submitApprove()` → `call('manageEnv2Regen', { action: 'batchApprove' })`（在预览确认后）
  - `rejectWithReason(e)`：弹窗收集理由 → `call(... rejectWithReason)`
  - `regenDish(e)`：勾选维度 → `call(... regenDish)` → toast「已提交生成，约2min后回同步」
  - `resyncRegen(e)` → `call(... resyncRegen)` → 刷新列表
- admin.wxml / wxss 对应增加 UI（顶部按钮、预览弹层、驳回原因弹层、维度勾选弹层、regen 列表）。

### 4.4 主要 UI 交互
- **一键入库**：点「一键入库」→ 弹出预览弹层（可分：可入库 N 条 [菜品名列表] / 已存在同名 M 条 / 缺 name K 条）→ 确认「确认入库」才实际落库 → toast「已入库 N 条」→ 刷新。
- **驳回**：列表项「驳回」→ 弹层（预设原因 chips + textarea + 确认）→ 提交。
- **重新生成**：弹维度多选表（画像/食材/步骤/做法点评/营养/图片）→ 确认 → toast「「已提交 env 生成」；该菜 regen 记录状态回显 pending。
- **重新同步**：对 regen 记录「重新同步」→ 调 syncFromEnv2 重新读回 → toast「已回待审」→ 列表刷新。

## 5. 端到端链路示例（做法重生成）

1. 管理员在详情点击「驳回」，填"做法末步不细"，确认。
2. `rejectWithReason`：pending 置 rejected + 写 `dish_env2_regen(name=xx, reason, status=pending)`。
3. `regenDish` 勾选维度 text：跨账号写 env2 `dish_regenerate_req(name=xx, targets=[text])`。
4. env2 `dishRegenPoll`（每 2 分钟）发现 pending → 调 `bypassText`（dishName 单菜入口）→ 置 `finishedAt`。
5. 管理员点「重新同步」→ `resyncRegen`：读回 dish_mirror 最新产物 → 重新写各 _pending 集合（清理旧同名记录避免重复，status=pending，source=env2-newdish）。
6. 回到待审列表，管理员可「一键入库（预览→确认）」或继续逐条审核。

## 6. 涉及文件清单

### 后端
- `cloudfunctions/manageEnv2Regen/index.js`（新建，env1 侧，含 batchPreview/batchApprove/rejectWithReason/regenDish/resyncRegen）
- `env2_functions/dishRegenPoll/index.js`（新建，env2 侧，配 2 分钟定时触发器）
- `env2_functions/bypassAiEnrich/index.js`、`bypassGenImage/index.js`（补 dishName 分支）

### 前端
- `pages/admin/admin.js`
- `pages/admin/admin.wxml`
- `pages/admin/admin.wxss`（弹层样式）

## 7. 实施步骤（建议顺序）

1. 后端 env2：`dishRegenPoll`（2min 定时器）+ dishName 分支（bypassAiEnrich / bypassGenImage）部署；
2. 后端 env1：新建 `manageEnv2Regen` 部署；
3. 前端：新增「env2 菜审核」tab + 顶部工具栏（一键同步/一键入库预览）+ 驳回/重生成/重新同步弹层，联调；
4. 打通「驳回 → 重生成（约 2min）→ 预览入库」链路，全量验证；
5. 收尾：更新 AGENTS.md 与文档。

## 8. 决策记录（已确认）

- ✅ 采用方案 A（env1 写请求表 + env2 `dishRegenPoll` 定时扫描）
- ✅ 「一键入库」：先预览差异（可入库/重复/缺 name），确认后提交
- ✅ 重生成完成后**保持人工一步再审核**（不自动入正式库）
- ✅ env2 扫描轮询频率 **2 分钟**
- ✅ 维度独立：做法/点评独立于图片等，支持单维度重生成
- ✅ 驳回原因写入 `dish_env2_regen` 记录（含 reasonCode + 文本），并回传 env2 重新生成

## 9. 补充默认闭环（无异议按此实施）

- **驳回原因选择**：预设 chips **单选**（默认足够，UI 简单）；如需多选可后续升级
- **一键同步进度**：toast 展示「已同步 N / 跳过 M / 剩余 K」（沿用现有 toast 风格）
- **重新生成后自动回到待审**：已确认（人工一步再审核）
- **请求表写入失败兜底**：`dish_env2_regen` 记 `status=failed` + errMsg，前端展示可排障；无 name 在前端直接阻断
- **多账号隔离**：env2 侧新增 `dishRegenPoll` 函数的环境 ID 通过 `TCB_ENV` 环境变量读取（沿用 bypass 系列现有约定）；云函数名唯一不与 env1 冲突
- **权限**：沿用现有 admin openid 校验，不新增角色表
- **重试**：env2 扫描处理失败的 target 记失败原因，单个失败不阻塞其他 target；整菜完成才置 done
- **清理策略**：`dish_env2_regen` 与 `dish_regenerate_req` 保留最近 30 天，超期由 env2 `dishRegenPoll` 一并归档（避免无限膨胀）

## 附录：现有接口速查
- env2 单菜入口：`genOne(dishName)` / `event.dishName` 已存在：bypassText、bypassGenIngredients、bypassGenSteps、bypassNutritionEst。
- 需新增：bypassAiEnrich、bypassGenImage。
- 同步：`syncFromEnv2`（新菜 & 图片）、`syncLexiconToEnv2`（菜名去重）。