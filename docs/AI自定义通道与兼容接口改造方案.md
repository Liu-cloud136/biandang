# AI 自定义通道 + 通用兼容接口 改造方案（梳理稿）

> 状态：待实施。本文档仅梳理"要改什么"，不含具体代码。
> 决策来源：2026-08-18 与用户多轮确认。
> 范围边界（用户已拍板）：
> - 加功能重发后端可接受（后端免审核）。
> - 通用接口只覆盖 A 类 + 简单 B 类单表；复杂 B 类仍独立写。
> - **本次新增"兼容接口"不重构现有 `adminCrud`，现有界面/接口保持不动。**
> - **前端 `dynamicTabs` 已补（2026-08-18 实施）**：`pages/admin` 新增"通用配置" tab（tab 14），按 `admin.js` 内 `dynSections` schema 动态渲染已登记（`adminGeneric` 白名单内）的字段，开关/枚举/文本三类控件，读写作 `adminGeneric.genericGet/genericUpsert`。新增已登记功能无需新增 tab、免发前端 UI。

---

## 一、背景与目标

当前 AI 出文（文本）写死用混元 `hy3` / `hy3-preview`，出图（图像）写死用混元 `hunyuan-image`。
用户目标：**免费模型到期/不稳时，能在管理侧一键切换/追加别的平台模型**，且以后加同类简单配置功能**不必每次发版**。

本期交付两件事：
1. **AI 自定义通道**：文本 + 图像都能在 `sys_config` 里配 baseUrl / model / key，开关控制是否启用。
2. **通用兼容接口（adminGeneric）**：在不动现有 `adminCrud` 的前提下，新增一个"集合+字段白名单"驱动的通用读写通道，以后加 A 类 / 简单 B 类功能只写一条配置文档、免发版。AI 配置即第一条用例。

---

## 二、配置数据模型（落 `sys_config`）

### 2.1 文本开关 `sys_config/ai_custom`
```json
{
  "enabled": false,
  "mode": "fallback",          // 默认 'fallback'（用户要求：免费期内新平台只当兜底）
  "baseUrl": "",               // OpenAI 兼容 chat 端点，如 https://api.xxx.com/v1
  "model": "",                 // 模型名，如 deepseek-xxx
  "keyRef": "CUSTOM_AI_KEY"    // 仅引用环境变量名，绝不落库明文
}
```
- `mode:'fallback'`：混元仍主，自定义排 hy3→preview 之后、SF 之前当兜底。
- `mode:'replace'`：自定义当主，混元退后（免费到期整体换平台用）。

### 2.2 图像开关 `sys_config/ai_custom_image`
```json
{
  "enabled": false,
  "mode": "fallback",
  "baseUrl": "",               // OpenAI 兼容图像端点 /v1/images/generations
  "model": "",
  "keyRef": "CUSTOM_IMAGE_KEY"
}
```
- 图像无 SF 兜底；`enabled=false` → 只用混元 hunyuan-image。
- 用户确认：图像自定义**只做 OpenAI 兼容 `/v1/images/generations` 协议**。

### 2.3 文本 / 图像两个独立开关（用户确认）
互不影响，关出文不影响出图。

---

## 三、降级链路（改造后）

### 文本（所有文本步统一走网关）
```
mode:'fallback' : hy3 → preview → [ai_custom.enabled? 你的平台] → [SF 仅贡献/过敏原 enableSF:true]
mode:'replace'  : [你的平台] → hy3 → preview → [SF 仅贡献/过敏原]
```
- 主出文 / 探索 / 理由润色 / 改名 / 校准：无 SF（`enableSF` 默认 false），自定义也失败即抛错。
- 贡献审核(`submitContribution.aiVerify`) / 过敏原(`validateAllergen`)：`enableSF:true`，自定义失败才烧 SF。
- **SF 保持原样不动**，只服务于贡献/过敏原，不进 `ai_custom` 开关管控。

### 图像（getDishImage）
```
enabled=false : hunyuan-image（现状，零影响）
enabled=true  : OpenAI 兼容图像端点（baseUrl/model 可配）
```

---

## 四、要改/要新建的文件清单

### A. 新建共享网关 `utils/aiGateway.js`（放各云函数副本）
> 遵守"共享模块各放副本 + 复制 + check_sync"铁律（参照 `sync_weights.js`）。

- `callUnifiedText(messages, opts)`：
  - 读 `sys_config/ai_custom`（enabled / mode / baseUrl / model）。
  - `enabled=false` → 走现有 hy3→preview（行为不变）。
  - `enabled=true` → 按 `mode` 决定插入位置（replace 前置 / fallback 后置）。
  - baseUrl/model 缺省回退代码默认值（保留原 `CUSTOM_AI_BASE`/`CUSTOM_AI_MODEL` 常量作 fallback）。
  - key 读 `process.env.CUSTOM_AI_KEY`，不持有明文。
- `callUnifiedImage(prompt, opts)`：
  - 读 `sys_config/ai_custom_image`，enabled 走 OpenAI 兼容 `/v1/images/generations`。
  - 返回 URL / base64 与现状 `generateImage` 对齐，供 `getDishImage` 复用。
- 内含 SF 调用（保留现有 `callSiliconFlow` 逻辑，收口到网关统一实现，三云函数不再各写副本）。

### B. 改造三个文本云函数接入网关
| 云函数 | 改造点 |
|---|---|
| `getRecommendation` | 主出文/探索/理由润色/改名/校准等 `genTextWithFallback` 改调 `callUnifiedText`；原 `callCustomAI` 逻辑并入网关；移除 `forceAll` 分支（由 `mode` 取代语义） |
| `validateAllergen` | `genTextWithFallback` 改调 `callUnifiedText` |
| `submitContribution` | `aiVerify` 改调 `callUnifiedText` |

### C. 改造 `getDishImage` 接入图像网关
- 改调 `callUnifiedImage`；`enabled=false` 时内部仍走原 `hunyuan-image`（零影响）。

### D. 新建通用兼容接口（不动现有 `adminCrud`）
> 形态待定：可在 `adminCrud` 内加 `action:'genericUpsert'/'genericGet'`，或独立云函数 `adminGeneric`。用户倾向"不重构现有、另加兼容接口"。

- `genericUpsert({collection, docId, fields})`：服务端**白名单校验**（集合+字段须登记，未登记拒绝），写 `sys_config`。
- `genericGet({collection, docId})`：读回配置。
- `updateSecret({key, value})`：把 key 写入云函数环境变量（如 `CUSTOM_AI_KEY` / `CUSTOM_IMAGE_KEY`），**不落库明文**；日志强制脱敏（不打印 value）。
- **白名单必须服务端校验**，不能前端传啥写啥（安全规则 R5）。
- AI 配置作为第一条用例：通过此接口写 `sys_config/ai_custom`、`ai_custom_image`。

### E. 前端（已补 2026-08-18）
- `dynamicTabs` 的"通用配置" tab **已落地**（`pages/admin` tab 14）：`admin.js` 内 `dynSections` schema（类型 boolean/enum/string）+ `admin.wxml` 动态渲染 + `adminGeneric.genericGet/genericUpsert` 读写。
- 新增已登记（`adminGeneric` 白名单内）功能：在 `adminGeneric` ALLOWED 追加 docId/字段 + 在 `admin.js` `dynSections` 追加 section 即出现，**无需新增独立 tab、免发前端 UI**；改已登记字段值更是零发版。
- 密钥（CUSTOM_AI_KEY / CUSTOM_IMAGE_KEY）仍不走通用写库，继续在 `adminGeneric` 环境变量配置。

---

## 五、安全要点（沿用项目安全规则）
1. API Key 只存环境变量引用，**绝不落库明文**（R5）。
2. 日志不打印 key / 完整 token（R12）。
3. 兼容接口必须服务端白名单，防任意写库（R5 / R1）。
4. OpenAI 兼容端点调用走 https，baseUrl 由配置提供，避免命令注入/SSRF（R2 / R4 意识）。

---

## 六、部署纪律（必做）
1. 每个改动云函数 bump `BUILD_TAG='2026-08-18.ai-custom-gateway'`（及兼容接口单独 tag）。
2. 部署后 `Start-Sleep -Seconds 60` + `manageFunctions(invokeFunction)` 验证 `BUILD_TAG=` 命中。
3. 共享模块 `aiGateway.js` 复制后跑 `check_sync`（参照 `scripts/check_sync_weights.js` 机制，新建对应校验）。
4. 改完即部署，禁止只改本地（部署纪律锁）。

---

## 七、实施状态（2026-08-18 已完成并部署）

确认项全部落地：
- [x] 开关只留 `enabled` + `mode`（取代原 `forceAll`）
- [x] `mode` 默认 `fallback`
- [x] 文本 `ai_custom` + 图像 `ai_custom_image` 两个独立开关
- [x] 所有文本步共用 `ai_custom`
- [x] SF 保持原样仅服务贡献/过敏原
- [x] 图像只做 OpenAI 兼容协议
- [x] 兼容接口独立云函数 `adminGeneric`，不重构现有 manage*（原无集中 adminCrud）
- [x] 前端"通用配置" tab 已补（dynamicTabs，2026-08-18）：`pages/admin` tab 14 动态渲染已登记字段
- [x] 兼容接口形态：**独立云函数 `adminGeneric`**
- [x] 白名单初始登记：`sys_config` 下 `ai_custom` / `ai_custom_image`（字段 enabled/mode/baseUrl/model）

### 已部署并验证 BUILD_TAG=2026-08-18.ai-custom-gateway
| 函数 | 改动 | 验证 |
|---|---|---|
| adminGeneric | 新建（genericGet/genericUpsert/updateSecret + 白名单） | BUILD_TAG 命中 ✓ |
| getRecommendation | genTextWithFallback 接入 callUnifiedText，删 callCustomAI/forceAll | BUILD_TAG 命中 ✓ |
| validateAllergen | genTextWithFallback 接入 callUnifiedText，删 callSiliconFlow | BUILD_TAG 命中 ✓ |
| submitContribution | genTextWithFallback 接入 callUnifiedText，删 callSiliconFlow | BUILD_TAG 命中 ✓ |
| getDishImage | 接入 callUnifiedImage（混元路径零影响，实测正常出图） | BUILD_TAG 命中 + 出图 200 ✓ |
| utils/aiGateway.js | 共享网关，四函数各放副本 | — |

### 使用方式（管理侧）
1. 填 AI 配置：调用 `adminGeneric` 的 `genericUpsert`（docId=`ai_custom` 或 `ai_custom_image`，fields=`{enabled,mode,baseUrl,model}`）。
2. 填密钥：在 `adminGeneric` 云函数**环境变量**配置 `CUSTOM_AI_KEY` / `CUSTOM_IMAGE_KEY`（不落库，updateSecret 仅做合法性校验+提示）。
3. 以后加新 A 类/简单 B 类功能：在 `adminGeneric` 的 `ALLOWED.sys_config` 追加一行 docId+字段即可，业务云函数读 `sys_config/<docId>` 生效，**前端不用发版**。

### 注意事项
- `adminGeneric` 当前 invoke 返回 403（非管理员 OPENID），属正常鉴权；管理员调用才放行。
- 密钥写入环境变量需通过控制台/部署脚本落地（运行时不能改自身 env），`updateSecret` action 不直写 env，只校验合法性。
- 共享模块副本一致性：四份 `aiGateway.js` 内容相同，后续改此模块须同步四份（参照 check_sync 机制，本次未建独立 check 脚本）。
