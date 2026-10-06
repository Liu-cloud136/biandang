# env2 菜谱审核网页 · 全维度展示 + 一键入库 env1 分表（功能方案）

> 状态：**决策已确认（2026-08-27）**，按下方 §六 阶段 0~5 直接实施（不走 spec agents 流程）
> 决策记录：①直接用本方案分阶段写码 ②后端 `express` ③审核状态存本地文件 `scripts/review-web/data/review_state.json` ④驳回默认写 env2 `rejected_names` 黑名单 + 联动删除 env2 `dish_mirror` 同名源 ⑤「差异预览」并入一期 ⑥列表默认视角=仅待入库 ⑦通过入库后联动清理 env1 `_pending` 同名记录（与 approveDish 一致） ⑧只做整菜通过/整菜驳回，不做局部编辑 ⑨端口用 `3025`
> 关联：`docs\从env2补齐env1分表维度.md`、`docs\env2一键入库同步与驳回重生成规划.md`、`docs\菜品库分表规范化执行方案.md`、`PROJECT_RULES.md`（R-DB-01 / R-Sync-02 / R-Env-02）
> 目的：在本地浏览器打开一个「审核网页」，逐菜查看 env2 `dish_mirror` 的全维度产物（画像/食材/步骤/点评/贴士/营养/图/推荐理由），审核通过后**一键写入 env1 各分表**（幂等，env1 已有则跳过不覆盖）。
> 数据源利用：完全复用 `从env2补齐env1分表维度.md` 的**本地脚本双环境直连**方法论（`@cloudbase/node-sdk` 同进程双 `init`，env2 只读、env1 写），不依赖微信小程序 / MCP 环境切换。

---

## 一、背景与目标

### 1.1 现状痛点

env2 `dish_mirror` 每道菜已生成完整维度（七件套 + 点评/难度 + 推荐理由，字段实测见 §三），但进入 env1 正式库要走一条较重的链路：

```
env2 dish_mirror → syncFromEnv2/manageEnv2Regen → env1 各 _pending 审核池
                → 小程序 admin 多 tab 逐项审核 → batchApprove 批量入分表
```

痛点：

1. **审核依赖微信小程序**：管理员必须在小程序 `pages/admin` 里多 tab 点「通过」，无法在电脑浏览器大屏逐菜细看各维度内容；
2. **中间池冗余**：env2 已有完整产物，却要先落 `_pending` 池再二次搬运，数据搬运链路长；
3. **无法逐菜细审**：现有列表只显示菜名/图像/标签，画像、食材、步骤、点评等**具体内容不可见**，审核缺乏依据；
4. **查重/幂等在网页侧不可见**：哪些菜 env1 已有、哪些将跳过，审核时无直观提示。

### 1.2 目标

本地起一个 Web 服务（浏览器访问 `http://localhost:xxxx`），提供：

1. **列表页**：拉取 env2 `dish_mirror` 全量（或按状态/搜索过滤），每行显示菜名、类别、七件套齐全徽标、env1 是否已入库标记；
2. **详情页**：逐维度分卡片展示一道菜的全部产物（画像/营养/食材/步骤/点评/贴士/图/推荐理由）；
3. **审核操作**：单菜「通过」→ 一键写 env1 全部分表（幂等，`doc(norm_id).set`，env1 已有跳过）；「驳回」→ 可选写入 env2 `rejected_names` 黑名单防再次生成；
4. **统计与复核**：顶部展示 待审/已入库/已驳回 计数，操作后列表实时刷新。

### 1.3 与现有功能边界

- 本方案提供**与小程序多 tab 审核并行的替代路径**：小程序链路仍保留，二者不冲突、数据不重复（主库 `_id`/分表 `_id` 幂等，重复入库自动跳过）；
- 本方案**不修改** env2 `dish_mirror`（只读）；
- 本方案**不引入** `_pending` 中间池，直接 env2 展示 → env1 分表（等价于把 backfill 方法论做成可视化网页）。

---

## 二、架构决策（重要）

| 维度 | 结论 | 理由 |
|------|------|------|
| 运行形态 | **本地 Node Web 服务**（`node server.js` 起 http，浏览器访问） | 浏览器网页**无微信上下文**，云函数跨账号鉴权（R-Sync-02）只认真机 WECHAT 链，网页调云函数必 403；本地脚本用 `.env` 双凭证直连不受限（参考 doc 已验证） |
| 数据通道 | `@cloudbase/node-sdk` **同时 `cloud.init` 两个环境**（env1 凭证 + env2 凭证） | 一个进程内完成「读 env2 → 写 env1」，复用 `scripts\backfill-profile-gap.js` 已验证的双凭证模式 |
| 界面技术 | 后端 **`express`** + 前端单页静态 HTML/CSS/JS（不引入构建链） | 路由/静态托管简单，`scripts/package.json` 加 `express` 依赖（决策②）；前端用 fetch 调本地 API |
| 写库规范 | 完全对齐 `manageLexicon.approveDish` 的落库逻辑 | 保证与现有写入端口径一致：主库 `dish_lexicon` 用 `doc(name).set`（_id=菜名原文 + data 带 `norm_id`），分表一律 `doc(norm_id).set`（data 内不再含 `_id`） |
| 幂等 | 逐分表 `doc(norm_id).get()` 已存在 → 跳过 | 库有则不写、库无才写（项目铁律，R-DB-01 / AGENTS.md 查重原则） |

> ⚠️ **双凭证铁律（复用参考 doc 修正认知）**：env1 与 env2 是**不同腾讯云账号**，`.env` 需两组凭证
> （`TCB_SECRET_ID/KEY` 为 env1、`TCB_ENV2_SECRET_ID/KEY` 为 env2），**同一组凭证 init 两个环境会 `INVALID_ENV`（100003）**。
> 凭证路径：`scripts\.env`（本地脚本统一入口，网页服务复用同一份 `.env`）。

---

## 三、数据契约（env2 `dish_mirror` → env1 分表）

### 3.1 env2 `dish_mirror` 读取字段（实测命名，均驼峰历史沿用）

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 菜名（展示用，归一用 `normLexName`） |
| `category` | string | 菜/主食/小吃/汤羹/饮品/甜品 |
| `mealTime` | string[] | 餐段（顶层） |
| `cuisine` | string | 菜系 |
| `reason` | string | 推荐理由（用于 `dish_recommend`） |
| `season` | string[] | 季节 tags |
| `profile` | object | 画像：`{ spicy, flavors[], type, main, isVeg, isSoup, cuisine, mealTime[] }`，**含内部标记 `_issues:[]` 须剔除** |
| `nutrition` | number[4] | `[热量, 蛋白, 碳水, 脂肪]` |
| `ingredients` | array | `[{ name, amount, unit }]`（遵循 amount/unit 格式铁律 R-Lex-02） |
| `steps` | array | 结构化步骤 `[{ step_no, text }]` 或 `[{ text }]` |
| `review` | string | AI 点评 |
| `difficulty` | string | 简单/中等/较难 |
| `tips` | string | 小贴士 |
| `guide` | string | 做法文本（备用，env1 已废弃 `dish_guide` 表，**不落库**，仅展示） |
| `imageUrl` | string | COS fileID（env1 展示时转可访问 URL 或直接透传 `<image>` 组件） |
| `source` | string | `ai-generated` / `regenerate`（拉取过滤条件） |

### 3.2 env1 写入目标（分表归属，对齐 AGENTS.md「菜品库写入规范」）

| 维度 | 目标集合 | `_id` | 落库字段 | 来源字段 |
|------|----------|------|---------|---------|
| 主库 | `dish_lexicon` | `doc(name).set`（**_id=菜名原文**，与现有 `approveDish` 一致；data 内**必须带 `norm_id`**） | `{ name, norm_id, cuisine, category, mealTime, season, reason, valid:true, ts, source }` | name/cuisine/category/mealTime/season/reason |
| 画像 | `dish_profile` | `norm_id` | `{ name, profile, ts }`（profile 须 `cleanProfile()` 剔 `_issues`） | profile |
| 推荐理由 | `dish_recommend` | `norm_id` | `{ name, reason, ts }` | reason |
| 营养 | `dish_nutrition_v2` | `norm_id` | `{ name, nutrition, ts }` | nutrition |
| 食材 | `dish_ingredients` | `norm_id` | `{ name, ingredients, ts }` | ingredients |
| 步骤 | `dish_steps` | `norm_id` | `{ name, steps, ts }` | steps |
| 点评 | `dish_review` | `norm_id` | `{ name, review, difficulty, ts }` | review + difficulty |
| 贴士 | `dish_tips` | `norm_id` | `{ name, tips, ts }` | tips |
| 图片 | `dish_image_v2` | `doc(name).set`（**_id=菜名原文**，与现有 `approveDish` 及 AGENTS.md「`dish_image_v2` `_id=菜名`」口径一致） | `{ name, imageUrl, ts }` | imageUrl |

> 注：`guide` 文本**不写 env1**（`dish_guide` 已废弃，阶段 6.5 判废），网页仅作展示参考。

### 3.3 查重/已经在库判断

- env1 主库已存在同名：用 `dish_lexicon` 里 `_id`（=菜名原文，历史写法）或 `norm_id` 比对 → 列表标「env1 已有」；
- 各分表已存在：`doc(norm_id).get()` 成功即跳过（幂等）；
- ⚠️ `dish_image_v2` 写键口径隐患：现有 `approveDish` 用 `doc(name)`、`backfill-env1-dims.js` 用 `doc(nid)` 混用；常规无空格菜名 name≈norm_id 无差异，但**网页读写统一按 §3.2 的 `doc(name)`** 写，查重时对两种键都 `get()` 兜底（name 与 norm_id），避免 miss。

---

## 四、网页功能设计

### 4.1 页面布局（单页，三段式）

```
┌─────────────────────────────────────────────────────────────┐
│ 顶部工具栏： [状态筛选: 全部/待入库/已入库/已驳回] [搜索框] [刷新]     │
│             统计：待入库 N · 已入库 M · 已驳回 K               │
│             [一键预览差异]（阶段4 并入）                         │
├──────────────────────────────┬──────────────────────────────┤
│ 左侧：菜列表（每行）          │ 右侧：详情卡片（逐维度展示）    │
│   ☑ 菜名  类别  七件套徽标    │  ┌ 主信息 ──────────────┐     │
│    [七/七齐] [env1: 已有/无]  │  │ 类别/餐段/菜系/推荐语  │     │
│    [→ 查看详情]               │  └─────────────────────┘     │
│  - 点击行加载右侧详情          │  ┌ 画像 ────────────────┐     │
│  - 支持翻页（_id 游标）        │  │ 辣度/口味/型/主料/    │     │
│                              │  │ 是否素/汤/菜系/餐段    │     │
│                              │  ├ 营养 ────────────────┤     │
│                              │  │ 热量/蛋白/碳水/脂肪    │     │
│                              │  ├ 食材 ────────────────┤     │
│                              │  │ name + amount + unit  │     │
│                              │  ├ 步骤 ────────────────┤     │
│                              │  │ 1.… 2.…              │     │
│                              │  ├ 点评/难度 ───────────┤     │
│                              │  ├ 贴士 ────────────────┤     │
│                              │  └ 图片 ────────────────┘     │
│                              │  [✓ 通过入库] [✗ 驳回]       │
└──────────────────────────────┴──────────────────────────────┘
```

### 4.2 列表行字段

> 初始视角：**仅待入库**（决策⑥）。已入库/已驳回菜默认折叠，通过顶部状态筛选展开查看。

| 字段 | 来源 | 展示 |
|------|------|------|
| 菜名 | env2 name | 文本；点击加载详情 |
| 类别 | env2 category | 文本 |
| 维度齐全徽标 | 服务端汇总 | 七件套口径（profile/nutrition/guide/ingredients/steps/tips/imageUrl）「7/7 齐」或列出缺失维（如 `缺imageUrl`）+ review 单枚徽标（有/无） |
| env1 状态徽标 | 服务端查 env1 主库 | 「env1 已有」灰标 / 「待入库」绿标 |

### 4.3 详情卡展示要求（逐维度）

- **主信息卡**：category、mealTime.join('、')、cuisine、reason 全文；
- **画像卡**：spicy(0-3)、flavors 数组、type、main、isVeg/isSoup 布尔、cuisine、mealTime；
- **营养卡**：热量/蛋白/碳水/脂肪 四项数字 + 单位标注（kcal/g）；
- **食材卡**：表格 name / amount / unit（amount 模糊量词时 unit 为空属正常，不标错）；
- **步骤卡**：有序列表，step_no 渲染序号；无编号则按数组序；
- **点评/难度卡**：review 全文 + difficulty 标签；
- **贴士卡**：tips 全文；
- **图片卡**：大图 preview（fileID 若为 `cloud://` 需服务端换临时 URL，或 env1 COS 已回写的直接可访问 URL）；
- **做法文本（guide）**：折叠展示，标注「不写入 env1（已废弃表）」。

### 4.4 审核操作

> 操作语义（决策⑧）：只做**整菜通过 / 整菜驳回**，不做局部维度编辑。

- **通过入库**：点「通过入库」→ 调 `POST /api/approve` → 服务端执行全分表幂等写入 + 联动清理 env1 `_pending` 同名记录（决策⑦）→ 返回各分表写/跳统计 → 前端 toast + 列表刷新（该菜移入「已入库」区）；
- **驳回**：点「驳回」→ 弹原因输入（预设：菜名不当/画像偏/营养不对/做法乱/图不符/食材错/其他）→ 调 `POST /api/reject` → 服务端**默认**：①写 env2 `rejected_names` 黑名单（防 env2 后续再生成同名）②联动删除 env2 `dish_mirror` 同名源（对齐现有链路 R-Sync-04 整菜丢弃语义）③写本地驳回审计 → 前端刷新（移入「已驳回」区）；弹窗内提供「跳过删除源」勾选项供例外场景使用（决策④）；
- **差异预览（一期，决策⑤）**：顶部「一键预览差异」→ 调 `POST /api/diffPreview` → 统计 待入库可写 / 已存在跳过 / 缺 name 忽略 → 弹窗展示清单与数量 → 确认后调 `POST /api/approveBatch` 批量执行；
- **批量/单菜差异预览**：`GET /api/dish` 详情右侧同步展示该菜各维「env1 已有/将写」标记，供逐菜审阅。

---

## 五、后端接口设计（本地 HTTP API）

> 服务：`scripts/review-web/server.js`（目录/文件名遵循 kebab-case 命名规范）；默认监听 `127.0.0.1:3025`（决策⑨，`--port` 可覆盖）。
> 前端静态页：`scripts/review-web/index.html` + `review-web-app.js` + `review-web.css`。

### 5.1 `GET /api/dishes`

- 参数：`status`(all|todo|approved|rejected，**默认 todo=仅待入库，决策⑥**)、`kw`(菜名模糊)、`cursor`(游标)、`limit`(默认 50，≤200)
- 逻辑：读 env2 `dish_mirror`（`source in ['ai-generated','regenerate']`，可选 status=ready 过滤）+ 本地审核状态表；汇总维度齐全度（七件套口径 = profile/nutrition/guide/ingredients/steps/tips/imageUrl，review/difficulty 单列）；查 env1 主库已入集合标注
- 返回：
  ```json
  {
    "total": 1094, "list": [
      { "name": "红烧肉", "category": "菜",
        "seven": { "done": ["profile","nutrition","ingredients","steps","imageUrl","tips"], "miss": ["guide"] },
        "review": true, "env1Has": true, "status": "todo" }
    ]
  }
  ```

### 5.2 `GET /api/dish?name=红烧肉`

- 逻辑：读 env2 `dish_mirror` 单条全字段 + env1 全分表已存在情况（`dish_profile`/`dish_recommend`/`dish_nutrition_v2`/`dish_ingredients`/`dish_steps`/`dish_review`/`dish_tips` 各自 `doc(norm_id)`；`dish_image_v2` 与主库按 §3.3 双键兜底）
- 返回：字段全量 + `env1Dims: { profile: true, ... }`（true=env1已有，仅作展示「已入」标记）

### 5.3 `POST /api/approve`

- 入参：`{ name }`（支持 `{ names: [] }` 批量）
- 逻辑（核心，复用 approveDish 写库规范）：
  1. `norm_id = normLexName(name)`；
  2. 读 env2 `dish_mirror` 对应记录；
  3. 逐分表判断已存在（`doc(norm_id).get()` 成功 → 跳）后写入：
     - `dish_lexicon.doc(name).set({data:...})`（**_id=菜名原文**，与现有 `approveDish` 一致；data 内必须带 `norm_id`，靠 uniq_norm_id 唯一索引防并发撞键；重复名捕获 E11000 → 标记已存在）
     - `dish_profile.doc(nid).set({data:{name, profile: cleanProfile(profile), ts}})`
     - `dish_recommend.doc(nid).set({data:{name, reason, ts}})`（reason 非空才写）
     - `dish_nutrition_v2.doc(nid).set({data:{name, nutrition, ts}})`
     - `dish_ingredients.doc(nid).set({data:{name, ingredients, ts}})`（非空才写）
     - `dish_steps.doc(nid).set({data:{name, steps, ts}})`（非空才写）
     - `dish_review.doc(nid).set({data:{name, review, difficulty, ts}})`（非空才写）
     - `dish_tips.doc(nid).set({data:{name, tips, ts}})`（非空才写）
     - `dish_image_v2.doc(name).set({data:{name, imageUrl, ts}})`（imageUrl 非空才写；**_id=菜名原文，与现有 approveDish 一致**）
  4. **联动清理 env1 `_pending` 同名记录（决策⑦）**：写本地审核状态表 `status=approved` 前，用 `where({ name })` 清理 `dish_lexicon_pending` / `dish_ai_profile_pending` / `dish_nutrition_pending` / `dish_guide_pending` / `dish_image_pending` 五张审核池同名记录（与现有 `approveDish` 收尾行为一致），避免网页入库后小程序审核池残留重复；
  5. 返回 `{ name, norm_id, written: {profile:1, nutrition:0(已存在), ...}, errors: [] }`
- 重要坑（写码必须遵守，见 §八）：`doc(id).set({ data })` 的 data 内**不能再含 `_id`**；`dish_lexicon` 写入 **data 必须带 `norm_id`**（uniq_norm_id 唯一索引，漏写整批撞键）且 `_id`=菜名原文（与 approveDish 对齐）。

### 5.4 `POST /api/reject`

- 入参：`{ name, reasonCode, reasonText, skipDeleteSource? }`
- 逻辑（**默认行为决策④**）：
  1. 写本地审核状态表 `status=rejected` + 审计日志（`review_state.json` 追加）；
  2. 写 env2 `rejected_names` 黑名单（`{ _id: norm_id, name, reason, ts }`，幂等 `doc().set`，防 env2 重新生成）——默认执行；
  3. 联动删除 env2 `dish_mirror` 同名源（`where({name}).remove()`，对齐 R-Sync-04 整菜丢弃语义）——默认执行；弹窗勾选 `skipDeleteSource=true` 时跳过第 3 步；
  4. 若 env2 操作失败，记录审计日志并返回 `env2Error`，**不静默吞错**（R-Code-04）。
- 返回 `{ ok: true, env2Blacklisted: true|false, env2Deleted: 0|n, env2Error?: string }`

### 5.5 `GET /api/stats`

- 返回待审/已入库/已驳回计数（本地状态表 + env1 主库比对）

### 5.6 `POST /api/diffPreview`（一期，决策⑤）

- 入参：`{ status: 'todo', limit }`（默认全量待入库，可分页）
- 逻辑：扫 env2 `dish_mirror`（待入库态）→ 分类输出：
  - `can_approve`（env1 主库无同名 + name 非空 → 可写）
  - `dup_lexicon`（env1 主库已有同名 → 将跳）
  - `missing_dim`（env2 缺关键维度如 profile/ingredients/steps → 提示缺什么）
  - `missing_name`（空 name → 忽略）
- 返回：`{ canApprove: n, dup: n, missingDim: n, missingName: n, list: [...] }`（**只读，不落库**）

### 5.7 `POST /api/approveBatch`（一期，决策⑤）

- 入参：`{ names?: string[] }`（缺省=对 `diffPreview.can_approve` 清单批量执行）
- 逻辑：循环调 §5.3 approve 单菜逻辑（幂等），汇总 `{ approved, skipped, failed, details }`；逐条 `await`，控制单批条数防超时；中途失败不中断，collect 到 `details`。

### 5.8 本地审核状态表（`scripts/review-web/data/review_state.json`，决策③固定本地文件）

- 结构（snake_case 字段）：
  ```json
  { "name": "红烧肉", "status": "approved|rejected", "note": "", "ts": 1780000000000 }
  ```
- 作用：记住已处理菜，网页重启不清空；env2 若有新菜则自动出现在「待入库」；
- 并发写：JSON 文件写入用一次性 `fs.writeFileSync` 全量覆写 + 启动时读入内存 Map，避免并发读写损坏。

---

## 六、实施步骤（分阶段，可执行）

> 每阶段产出可运行的最小验证；阶段按序推进，执行前按项目惯例逐阶段确认。

### 阶段 0 · 环境准备（1 次性）

1. 确认 `scripts/.env` 含六变量：`TCB_ENV`(env1)、`TCB_SECRET_ID`、`TCB_SECRET_KEY`、`TCB_ENV2`、`TCB_ENV2_SECRET_ID`、`TCB_ENV2_SECRET_KEY`；
2. `scripts/package.json` 加依赖：`@cloudbase/node-sdk`（已有）+ **`express`**（决策②）；`npm install` 安装；
3. 新建目录 `scripts/review-web/`，前端三件套 + 后端 `server.js`；
4. 实现 `normLexName`（折叠空白+去首尾）与 `cleanProfile`（剔 `_issues`）两个纯函数（copy 自 `backfill-env1-dims.js`）。

### 阶段 1 · 读侧打通（先能看）

1. `server.js` 实现 `cloud.init` 双环境 + `fetchAll(db2,'dish_mirror', null)`（游标分页，>1000 用 `_id>lastId`）；
2. 实现 `GET /api/dishes`（先只返回 env2 基础字段 + 七件套齐全度）；
3. 终端 `node scripts/review-web/server.js` → 浏览器访问 `http://127.0.0.1:3025`（决策⑨）验证列表能出数据；
4. 手动抽样 3 条，核对 `peek-env2-mirror.js` 输出一致。

### 阶段 2 · 详情展示（能细看）

1. 实现 `GET /api/dish?name=`：env2 全字段 + env1 各分表 `doc(norm_id)` 存在标记；
2. 前端右侧详情卡片逐维度渲染（画像/营养/食材/步骤/点评/贴士/图片）；
3. 图片 URL 处理：`cloud://` fileID 需走 COS 临时下载链接（`getTempFileURL`），或直接 `<img src="https://...">`（如有外链）；本地环境暂可显示占位 + fileID 原串；
4. 验证：点击列表任意菜，右侧完整展示所有维度，缺维度卡显示「缺失」。

### 阶段 3 · 写入打通（能一键入）

1. 实现 `POST /api/approve`（严格按 §5.3 分表归属 + 幂等判断）；
2. 先加 `?dry=1` 模式：只统计「将写各分表 N 条 / 已存在跳过 M 条」，不真实写入；
3. 选 1 条 env1 肯定没有的菜，`dry` 预演 → 核对统计 → 关闭 dry 真实写入；
4. 验证：env1 控制台/脚本确认该菜出现在主库 + 8 张分表中（共 9 张表）；再调一次 approve 确认全部跳过（幂等）且 `_pending` 五表同名记录已被联动清理（决策⑦）。

### 阶段 4 · 审核闭环 + 差异预览（能用，决策⑤并入一期）

1. 实现 `POST /api/reject`（默认写 env2 `rejected_names` 黑名单 + 联动删除 env2 `dish_mirror` 同名源，`skipDeleteSource` 可跳过，决策④）；
2. 实现 `GET /api/stats` + 前端顶部统计；
3. 列表按 `status` 过滤（默认 `todo`）+ 搜索 + 游标翻页；
4. 前端 toasts 与操作确认弹层（驳回原因弹窗含「跳过删除源」勾选框）；
5. 实现 `POST /api/diffPreview` + `POST /api/approveBatch` + 顶部「一键预览差异」弹窗（可入库 N / 已存在跳过 M / 缺维度 K / 缺名 L → 确认后批量执行）。

### 阶段 5 · 验证与收尾

1. **幂等回归**：对已入库菜重复 approve → 统计全为跳过，env1 零变更；
2. **对账**：选中 20 道菜入库后，用 `scripts/check-approved-completeness.js` 或 `schema-check.js` 复核分表条数与 `_id=norm_id`；
3. **驳回回归**：`POST /api/reject` 后——本地状态进「已驳回」、env2 `rejected_names` 新增、env2 `dish_mirror` 同名源被删（或 `skipDeleteSource` 跳过）；env2 后续不再生成同名；
4. **差异预览回归**：`diffPreview` 统计与实际入库结果一致（可入库=新入、已存在=跳过、缺维度=不全不写）；
5. 写 `docs` 更新 + 沉淀进 `AGENTS.md`（记录网页服务启动方式 `node scripts/review-web/server.js`）。

---

## 七、注意事项与踩坑（必读，复用参考 doc + 项目规范）

1. **主键口径一表说清**：主库 `dish_lexicon` / `dish_image_v2` 用 `doc(name).set`（**_id=菜名原文**，与现有 `approveDish` 一致；主库 data 内**必须带 `norm_id`**，有唯一索引 uniq_norm_id，漏写会 E11000）；其余分表一律 `doc(nid).set`（**_id=norm_id**），data 内**不能再含 `_id`**（报「不能更新_id」）。写前统一 `normLexName()` 归一防空格/变体 miss。
2. **禁用 `.add()` 带 `_id` / `doc(id).set` 带 `_id`**：云开发硬规则（R-DB-01），上述两种写法都不允许 data 内出现 `_id` 字段。
3. **`dish_lexicon` 写入必带 `norm_id`**：主库唯一索引撞键会整批失败（AGENTS.md 菜品库写入规范明确）。
4. **`profile` 必须剔 `_issues`**：env2 mirror 的 profile 自带内部标记 `_issues:[]`，直接写入会污染 env1（`cleanProfile()`）。
5. **删除/更新用逐条操作**：node-sdk v2 `remove()` 不支持 limit；`where({}).remove()` 可能触发 Windows AMSI 拦截；写操作全部 `doc(id)` 精细控制。
6. **集合 >1000 游标分页**：`dish_mirror`(1090+) 等，`skip` 有上限，读全量必须 `orderBy('_id','asc').where(_id>lastId)` 游标；网页列表翻页同样用游标。
7. **绝不用 PowerShell 读写源文件**：UTF-16 毁中文；一律用 write_to_file / Node fs utf8。
8. **破坏性操作先 dry**：approve/reject 接口带 `dry` 预演参数，统计无误再执行（用户铁律）。
9. **双凭证铁律**：env1/env2 不同账号，`cloud.init` 各传各凭证，不能复用一组（`INVALID_ENV` 100003）；凭证轮换后更新 `scripts/.env`，网页服务重启生效。
10. **端口/本地安全**：服务仅 `127.0.0.1:3025` 监听（决策⑨，不暴露公网），浏览器访问同源无跨域。
11. **`guide` 不落库**：`dish_guide` 已废弃，网页展示 guide 仅为人工参考，写入分表清单不含 guide（§3.2）。
12. **驳回默认联动删 env2 源（决策④）**：与 `manageEnv2Regen.rejectWithReason` 语义一致（对齐 R-Sync-04 整菜丢弃）——默认写 `rejected_names` 黑名单 + 删 `dish_mirror` 同名源；弹窗勾选「跳过删除源」时仅黑名单不删源。env2 操作失败**显式记录 `env2Error` 返回**，不静默吞（R-Code-04）。

---

## 八、验收标准

1. 浏览器打开 `http://127.0.0.1:3025`（决策⑨），**默认仅显示待入库菜**（决策⑥），列表显示各菜维度齐全徽标与 env1 已入标记；切换状态筛选可查看已入库（灰标）/已驳回；
2. 点击任意菜，右侧完整逐维度展示（缺失维标红）；
3. 单菜「通过入库」后：env1 主库 `dish_lexicon` 出现该记录（_id=菜名原文、data 带 `norm_id`），8 张分表各出现对应记录（`_id=norm_id`）；重复点击全为「已存在跳过」，零覆盖；
4. 驳回菜进入「已驳回」，env2 `rejected_names` 新增同名且 env2 `dish_mirror` 同名源被删（勾选跳过删源则保留），env2 不再生成同名；
5. 对账：入库 N 道后 `dish_lexicon` 增加 N 条（`norm_id` 不重复撞键），各分表条数对齐；
6. 服务重启后已处理状态保留（`review_state.json` 持久化）；
7. 顶部「一键预览差异」统计与实际入库结果一致（可入库=新入 / 已存在=跳过 / 缺维度=不全不写），确认执行后无重复入库。

---

## 九、遗留与二期

- **批量勾选操作**：列表多选行批量通过/驳回/Batch（`approveBatch` 已支持 `names[]`，缺 UI 勾选）；
- **图片直显**：`cloud://` fileID 临时 URL 换取补充；
- **局部编辑**：决策⑧ 明确本期**不做**局部维度编辑（只整菜通过/驳回）；若未来需要可在此扩「单维修正后入库」；
- **与小程序链路去重（已闭环）**：本网页通过入库会**联动清理 env1 `_pending` 同名记录**（决策⑦），与 `manageEnv2Regen` 同步的 `name` 去重逻辑双保险，不产生重复待审。