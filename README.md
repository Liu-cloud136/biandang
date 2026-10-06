# 诶呀妈呀 今天吃啥呀

<img src="assets/miniprogram-qrcode.jpg" width="200" alt="小程序码" />

扫码体验线上版（演示环境）

> AI 驱动的个性化美食决策助手 · 微信小程序 + 腾讯云开发（CloudBase）
> 
> 不只是随机转盘，而是一个「懂你口味」的 AI 美食决策助手。

> [!IMPORTANT]
> **演示服务器到期时间：2027 年 1 月。** 到期后扫码线上体验将不可用；本仓库源码与数据集不受影响，可按[快速开始](#快速开始)自建环境继续使用。

「今天吃什么」是每天都要重复消耗决策精力的问题。本项目通过结构化饮食偏好 + AI 生成，
按用餐场景直接给出带配图、菜系标签、推荐理由和营养估算的菜品方案，
并用「已选项回流」让推荐越用越贴合用户口味。

---

## 目录

- [核心特性](#核心特性)
- [技术架构](#技术架构)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [云函数总览](#云函数总览)
- [数据模型](#数据模型)
- [安全设计](#安全设计)
- [数据集来源说明](#数据集来源说明)
- [许可证](#许可证)

---

## 核心特性

### 偏好设置（11 步引导）

分步收集口味、辣度、菜系、肉类（可细化到部位）、青菜、菜类、忌口、过敏原、用餐场景、配饮等偏好。
其中肉类 / 菜类 / 主食 / 配饮支持「大类 ⊃ 小类」两级联动，
并内置食材同物异名归一化表（如 `西红柿 → 番茄`、`马铃薯 → 土豆`），避免别名导致匹配失配。

### AI 推荐

按每个用餐场景分别生成「菜品（2 道）+ 主食（1~2 个）」，每项包含：

- 菜系分类与一句话推荐理由
- 热量 / 蛋白质 / 碳水 / 脂肪估算
- 文生图生成的写实风配图（并发生成 + 持久化到云存储）

生成文本经内容安全校验（`security.msgSecCheck`）后才返回。

### 结果页交互

| 操作  | 行为                  |
| --- | ------------------- |
| 就它了 | 记录所选菜品，回流偏好权重       |
| 换一批 | 重新生成，按场景数扣减免费额度     |
| 看做法 | 生成/读取该菜的食材、步骤、评价、技巧 |
| 分享  | 前端 canvas 拼图生成转发卡片  |

### 次数与增长

激励视频广告与 Banner 广告；签到、兑换码、赠送池与基础池分离；
虚拟支付（微信「虚拟支付」能力）支持购买次数。

### 其他

收藏、历史、冰箱库存、购物清单、周计划、社区贡献食材、后台管理控制台。

---

## 技术架构

```text
┌──────────────────────────────────────────────┐
│              微信小程序（原生）                │
│  pages/ · utils/ · custom-tab-bar/ · app.*    │
└───────────────────┬──────────────────────────┘
                    │ wx.cloud.callFunction
        ┌───────────▼────────────┐
        │   env1 云环境（主环境）  │
        │   cloudfunctions/       │
        │  用户偏好 / 推荐 / 历史  │
        │  支付 / 后台 / 词料库    │
        └───────────┬────────────┘
                    │ 环境共享（cloudbase_auth 白名单校验）
        ┌───────────▼────────────┐
        │  env2 云环境（内容工厂）  │
        │  env2_functions/        │
        │  bypass* 批量生成：      │
        │  菜名/食材/步骤/营养/    │
        │  图片/技巧/评价          │
        └────────────────────────┘
```

> **云平台说明**：后端云函数、数据库与云存储均部署在**腾讯云开发（CloudBase）**上，**不是「微信云开发」**。小程序端用 `wx.cloud` 发起调用，但函数的运行、数据库与计费都在腾讯云 CloudBase 环境内。

采用**双云环境**分离「用户业务」与「AI 内容生产」：

- **env1（主环境）**：小程序直接调用的业务后端。承载用户偏好、推荐、历史、收藏、
  购物清单、支付、后台管理与词料库读写。
- **env2（内容工厂）**：批量内容生产线。`bypass*` 系列云函数借助定时触发器
  持续生成菜品各维度数据，经去重、一致性修复、质量闸门后进入镜像库。
- **跨环境通信**：通过 CloudBase 环境共享调用，入口函数用白名单校验调用方 AppID。
- **同步链路**：env2 镜像库 → 同步函数 → env1 审核池 → 管理员审核 →
  写入 env1 各维度分表。

### 关键设计约定

- **双凭证**：两个环境属于不同账号，各自持有独立密钥，复用一个会报
  `INVALID_ENV`。
- **分表唯一真源**：菜名/营养/图片/步骤/评价/技巧/食材各自独立集合，
  以菜名为主键；已废弃的旧表不再写入。
- **查重优先**：入库前先查重，已存在则跳过，不覆盖不更新。

---

## 目录结构

```text
.
├── app.js                     # 小程序入口：云环境初始化、登录态预热、封禁拦截
├── app.json                   # 页面注册 / tabBar / 窗口样式
├── app.wxss                   # 全局样式
├── sitemap.json               # 小程序索引配置
├── project.config.json        # 微信开发者工具项目配置（AppID 为占位符）
├── name_blocklist.json        # 怪菜名与通用小料黑名单（词表）
│
├── pages/                     # 页面（13 个）
│   ├── index/                 # 首页：帮我决定
│   ├── setup/                 # 11 步偏好设置
│   ├── history/               # 历史与详情
│   ├── mine/                  # 我的
│   ├── favorites/             # 收藏
│   ├── admin/                 # 后台管理控制台
│   ├── tuning/                # 推荐调参
│   ├── shoplist/              # 购物清单
│   ├── fridge/                # 冰箱库存
│   ├── week/                  # 周计划
│   ├── genDetail/             # 生成详情
│   ├── paycenter/             # 虚拟支付
│   └── author/                # 关于作者
│
├── utils/                     # 工具模块
│   ├── config.js              # 全局配置：环境 ID、层级词表、别名归一、过敏原校验
│   ├── cache.js               # 缓存与云存储 fileID 处理
│   ├── ingredient_master.js   # 食材主数据
│   ├── ingredient_group.js    # 食材分组
│   ├── seasoning_library.js   # 调味料库
│   ├── dishReport.js          # 菜品反馈上报
│   ├── sync_weights.js        # 权重同步
│   ├── location.js            # 定位与天气
│   ├── scene.js               # 场景判定
│   ├── drinks.js / ad.js      # 配饮 / 广告
│   ├── clientLog.js           # 客户端日志（不采集用户输入与 OpenID）
│   └── util.js
│
├── custom-tab-bar/            # 自定义 tabBar
│
├── cloudfunctions/            # env1 云函数（主环境，约 80 个）
├── env2_functions/            # env2 云函数（内容工厂，约 30 个）
├── env1_functions/            # env1 补充函数
└── webapp/                    # Web 版静态页（经 webApi 云函数对外）
```

---

## 快速开始

### 环境要求

- 微信开发者工具（稳定版）
- 已开通的微信小程序账号
- **腾讯云开发（CloudBase）** 账号，并在其中创建**两个**环境（本项目不使用「微信云开发」）
- Node.js 18+（仅用于安装云函数依赖）

### 步骤

1. **克隆仓库并导入项目**
   
   ```bash
   git clone <your-repo-url>
   ```
   
   用微信开发者工具「导入项目」，选择仓库根目录。

2. **配置 AppID**
   
   `project.config.json` 中的 `appid` 为占位符 `wx0000000000000000`，
   请替换为你自己的小程序 AppID。

3. **配置云环境 ID**
   
   以下位置的环境 ID 均为占位符，需替换为真实值：
   
   | 文件                           | 字段                          |
   | ---------------------------- | --------------------------- |
   | `app.js`                     | `globalData.envId`          |
   | `utils/config.js`            | `ENV_ID`                    |
   | `cloudfunctions/**/index.js` | `process.env.TCB_ENV` 或字面兜底 |
   | `env2_functions/**/index.js` | `process.env.TCB_ENV` 或字面兜底 |
   | `webapp/app.js`              | Web API 地址                  |
   
   建议改为**通过环境变量注入**，而不要写死在代码里。

4. **配置云函数环境变量**
   
   参考 [`.env.example`](.env.example)，在**腾讯云开发（CloudBase）控制台**为各云函数配置环境变量
   （尤其是 `ADMIN_OPENIDS`、`MERGE_SYS_SECRET`、`WEB_SALT`、`CUSTOM_AI_KEY`）。

5. **安装云函数依赖并上传**
   
   在微信开发者工具中对 `cloudfunctions/` 下各函数右键「上传并部署：云端安装依赖」。

6. **初始化数据库集合**
   
   按下方[数据模型](#数据模型)创建集合并设置索引；词料库可通过
   `manageLexicon` 等函数或后台控制台导入。

> **注意**：本仓库中的环境 ID、AppID、密钥均为占位符，无法开箱即用，
> 必须先完成上述配置。

---

## 环境变量

完整清单见 [`.env.example`](.env.example)。核心变量：

| 变量                                              | 用途                         |
| ----------------------------------------------- | -------------------------- |
| `TCB_ENV` / `ENV1_ENV_ID`                       | env1 云环境 ID                |
| `TCB_ENV2` / `ENV2_ENV_ID`                      | env2 云环境 ID                |
| `ADMIN_OPENIDS`                                 | 管理员 OpenID 白名单（逗号分隔）       |
| `ADMIN_PASSWORD`                                | 后台管理页登录口令                  |
| `MERGE_SYS_SECRET`                              | 云函数间内部调用鉴权密钥（**必须设为长随机值**） |
| `WEB_SALT`                                      | Web 版游客身份哈希盐（**必须设为长随机值**） |
| `CUSTOM_AI_KEY` / `CUSTOM_IMAGE_KEY`            | 自定义文本 / 图片模型通道密钥           |
| `SF_KEY`                                        | 备用 AI 通道密钥                 |
| `VP_APP_KEY` / `VP_APP_SECRET` / `VP_MSG_TOKEN` | 虚拟支付与消息推送                  |
| `GEN_DISABLED`                                  | 批量生成熔断开关                   |
| `TCB_SECRET_ID` / `TCB_SECRET_KEY`              | 腾讯云 API 密钥（仅本地运维脚本使用）      |

---

## 云函数总览

> 以下云函数均运行在**腾讯云开发（CloudBase）**环境中：`cloudfunctions/` 对应 env1，
> `env2_functions/` 对应 env2。**不使用「微信云开发」。**

### env1 — 主环境（`cloudfunctions/`）

| 领域     | 函数                                                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户与偏好  | `getPrefs` `savePreferences` `getMyOpenid` `deleteAccount` `manageUser` `userAvoid` `signIn` `grantBonus`                                                                                       |
| 推荐与出文  | `getRecommendation` `commitRecommendation` `genDailyMenuPlan` `getGuide` `getCookGuide` `getDishImage` `rateDish`                                                                               |
| 历史与收藏  | `getHistory` `getHistoryDetail` `favorite` `getInsight` `getWeightOverview`                                                                                                                     |
| 次数与支付  | `consumeFreeCount` `getFreeLog` `grantBonus` `redeemCode` `manageRedeem` `payGoodsList` `virtualPayCreateOrder` `virtualPayNotify` `virtualPayQueryCron`                                        |
| 词料库与数据 | `manageLexicon` `computeBaseline` `computeCF` `backfillNutrition` `checkSevenPiece` `tagSeason` `validateAllergen` `seedIngLib` `seedIngPreset` `chkIngCount`                                   |
| 贡献与反馈  | `submitContribution` `mergeContributions` `manageContrib` `getCommunityIngredients` `submitFeedback` `manageFeedback` `submitDishFeedback` `recordFeedback`                                     |
| 跨环境同步  | `syncFromEnv2` `syncImagesFromEnv2` `syncLexiconToEnv2` `manageEnv2Regen` `cloudbase_auth`                                                                                                      |
| 购物与库存  | `manageShopping`                                                                                                                                                                                |
| 后台管理   | `adminLogin` `adminGeneric` `amIAdmin` `getAdminStats` `getDailyStats` `getDecideStats` `manageBlocklist` `manageGuide` `manageAnnouncement` `manageCFSwitch` `manageThompson` `manageShopping` |
| 备份与告警  | `backupData` `autoBackup` `tempClearBackups` `mailNotify`                                                                                                                                       |
| Web 版  | `webApi`                                                                                                                                                                                        |
| 探针与工具  | `probeReason` `probeStream` `streamProbe` `txtConcProbe` `recProbe` `fixImageUrl` `env1DishFix` `autoLexiconFix` `batchFixReason`                                                               |

### env2 — 内容工厂（`env2_functions/`）

| 领域    | 函数                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内容生成  | `bypassGenDish` `bypassGenIngredients` `bypassGenSteps` `bypassGenReason` `bypassGenTips` `bypassGenCuisine` `bypassGenGuide` `bypassGenImage` `bypassNutritionEst` `bypassText` |
| 富化与修复 | `bypassAiEnrich` `bypassEnrich` `bypassConsistencyRepair` `bypassGapFix` `bypassLexiconFix` `bypassPolishSteps` `fixReasonInEnv2` `fixCuisinePrefix`                             |
| 入库与去重 | `bypassAutoAdd` `bypassAutoInvent` `bypassCandidate` `bypassDedup` `bypassReviewContribution`                                                                                    |
| 调度与运维 | `bypassScheduler` `bypassRetry` `bypassHealthCheck` `bypassLogClean` `env2Console`                                                                                               |
| 探针    | `probeText` `probeImage` `aiProbe`                                                                                                                                               |
| 跨环境   | `cloudbase_auth`                                                                                                                                                                 |

---

## 数据模型

以菜名为主键的分表体系，各维度独立集合：

| 集合                  | 说明                               |
| ------------------- | -------------------------------- |
| `dish_lexicon`      | 菜名主库，须带 `norm_id`（规范化名，唯一索引）     |
| `dish_nutrition_v2` | 营养：`nutrition: [热量, 蛋白, 碳水, 脂肪]` |
| `dish_image_v2`     | 图片：`imageUrl`                    |
| `dish_steps`        | 做法步骤 `steps[]`                   |
| `dish_review`       | 做法评价 `review` + `difficulty`     |
| `dish_tips`         | 做法技巧 `tips`                      |
| `dish_ingredients`  | 食材 `ingredients[]`               |
| `dish_mirror`       | env2 生成中间产物镜像                    |
| `*_pending`         | 各维度待审核池                          |

其他业务集合：用户偏好、历史记录、收藏、购物清单、反馈、公告、系统配置、
兑换码、订单等。

> **写入约定**：`.add()` 不允许携带 `_id`；需指定主键时用 `doc(id).set()`，
> 且 `data` 中不可再含 `_id`。

---

## 安全设计

- **密钥零硬编码**：所有凭证（云 API 密钥、AI 通道密钥、支付密钥、口令、盐）
  一律通过 `process.env` 注入。仓库内**不含任何真实密钥或默认密钥**。
- **fail-closed**：内部调用鉴权与游客身份签发在缺少密钥时**一律拒绝**，
  不存在可预测的兜底常量。
- **管理员白名单**：通过 `ADMIN_OPENIDS` 环境变量配置，代码内无硬编码管理员。
- **内容安全**：AI 生成文本经微信内容安全接口校验。
- **隐私**：客户端日志不采集用户输入与 OpenID；用户偏好仅用于推荐用途。

> 发布前请再次确认：`project.config.json` 的 AppID、各云函数的环境 ID
> 与全部环境变量都已替换为你自己的值。

---

## 数据集来源说明

仓库中随云函数内置了两个菜谱数据集，由本项目作者**自行收集、清洗与结构化整理**，
作为 AI 生成与查表推荐的参考语料：

| 文件 | 规模 | 内容 |
| --- | --- | --- |
| `cloudfunctions/getRecommendation/cookbook_ref.json` | 6351 道 | 菜名 → 食材清单（`名称 用量` 字符串数组），另有 3 份同源副本 |
| `cloudfunctions/getRecommendation/dishes.json` | 6402 菜名 | 菜名总表；其中 923 条带肉类 / 菜类 / 辣度 / 菜系标签 |

两者的分工：`cookbook_ref.json` 供推荐校准、采购清单与生成侧食材查表；`dishes.json` 的
`all`（菜名总表）供生成侧去重，`tags` 是本地维护的结构化标注，供软偏好打分与荤素均衡使用。

原始素材来自公开渠道，而**字段清洗、同物异名归一化、标签体系设计、营养估算与结构化整理**
均为本项目自己的工作量，最终数据集是整理后的成果。

### 使用须知

> **使用本仓库（含其数据集）时，请标明来源本仓库。**

数据集随仓库以 MIT 许可发布，可自由使用与再分发；但整理工作本身投入了大量精力，
**恳请在使用、引用或二次整理时注明来源**，例如：

```text
菜谱数据集来源：biandang（诶呀妈呀 今天吃啥呀）
https://github.com/<你的用户名>/<仓库名>
```

---

## 许可证

[MIT](LICENSE) © 2026 biandang contributors

随仓库内置的菜谱数据集由本项目作者自行整理，使用或再分发时请标明来源本仓库
（详见[数据集来源说明](#数据集来源说明)）。
