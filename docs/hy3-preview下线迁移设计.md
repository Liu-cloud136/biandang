# hy3-preview 下线迁移 · 实施步骤（2026-08-27 定稿）

> 目标：2026-08-31 `hy3-preview` 下线前，把 env1 全部文本生成从 preview 拆除，只留 hy3。
> 定稿决策：走方案 A；hy3 限流退避**只重试 1 次**（不因重试拖慢主出文流程）；main 链路**不启用** SF 兜底（SF 仅贡献审核 + 过敏原校验两处保留）。
> 硬截止：2026-08-31 当日 0 点前完成部署；建议 **08-29 前**完成。
>
> **执行状态（2026-08-27 19:00）**：§一/§三~§十一 已完成并部署验证生效（BUILD_TAG=`2026-08-27.env1-hy3-preview-removed`，4 函数 invoke 日志均命中）。§二 探针复测、§十二.3 探针删除已完成（env1 实测 n=10/16/24 全成功、0 个 429，探针已删）；§十三 晚高峰观察为**待办**（硬截止 08-31 前）。

---

## 〇、步骤总览

| # | 动作 | 文件 | 核心内容 | 状态 |
|---|------|------|----------|------|
| 1 | 备份 | 4 个 index.js + 5 份 aiGateway.js | 改码前备份 | ✅ 已完成（`备份/hy3-preview-migration-2026-08-27/`） |
| 2 | env1 hy3 上限复测 | 探针临时函数 | 定 `TXT_SLOT_N` | ⏳ 待办（08-31 前，TXT_SLOT_N 暂维持 10/5） |
| 3 | 改网关 | `getRecommendation/utils/aiGateway.js` | 删 preview 分支，hy3 限流只重试 1 次，bump 版本号 | ✅ 已完成（`2026-08-27.hy3-only-single-retry`） |
| 4 | 同步网关 | 其余 4 份 aiGateway.js + `scripts/check_ai_gateway.js` | 副本一致 | ✅ 已完成（check 脚本哈希+版本一致通过） |
| 5 | 改主函数 | `getRecommendation/index.js` | 删 preview 资产；改 5 处调用点；bump | ✅ 已完成 |
| 6 | 改轻函数 | `autoLexiconFix/index.js` | 删 preview 常量/闭包；primary 改 hy3 | ✅ 已完成 |
| 7 | 改贡献 | `submitContribution/index.js` | 删 `callPreview` | ✅ 已完成 |
| 8 | 改过敏原 | `validateAllergen/index.js` | 删 `callPreview` | ✅ 已完成 |
| 9 | 注释清理 | `getDishImage/index.js`（可选） | 仅注释 | ➖ 评估后未改（现有注释「hy3-preview 是文本模型无法替图」为正确说明，保留） |
| 10 | 本地自检 | 命令行 | node --check × 4；check_ai_gateway；grep 无残留 | ✅ 已完成（9 文件 check 全过；代码层 preview 残留 0） |
| 11 | 部署 env1 | MCP manageFunctions | 部署 4 个函数 | ✅ 已完成（updateFunctionCode + 60s 冷启动 + invoke 验证 BUILD_TAG 命中） |
| 12 | 部署后验证 | CloudBase 日志 / 小程序 | 无 `hy3-preview`、BUILD_TAG 生效、实测出文 | 🔶 日志已验（BUILD_TAG 命中，无 preview 字样）；小程序实测待用户真机确认 |
| 13 | 晚高峰观察 | 日志 | 429/430 率，必要时再调 `TXT_SLOT_N` | ⏳ 待办（上线后 1~2 天） |

**完成标准**：全库 grep（排除 node_modules / .bak / 备份目录）无 `hy3-preview` 与 `PREVIEW_` 引用；4 函数已部署生效。

---

## 一、备份改动文件

项目未用 git，先备份：

```
mkdir 备份\hy3-preview-migration-2026-08-27
copy cloudfunctions\getRecommendation\index.js  备份\hy3-preview-migration-2026-08-27\
copy cloudfunctions\autoLexiconFix\index.js     备份\hy3-preview-migration-2026-08-27\
copy cloudfunctions\submitContribution\index.js 备份\hy3-preview-migration-2026-08-27\
copy cloudfunctions\validateAllergen\index.js   备份\hy3-preview-migration-2026-08-27\
copy cloudfunctions\getRecommendation\utils\aiGateway.js      备份\hy3-preview-migration-2026-08-27\aiGateway.getRecommendation.js
copy cloudfunctions\autoLexiconFix\utils\aiGateway.js         备份\hy3-preview-migration-2026-08-27\aiGateway.autoLexiconFix.js
copy cloudfunctions\submitContribution\utils\aiGateway.js     备份\hy3-preview-migration-2026-08-27\aiGateway.submitContribution.js
copy cloudfunctions\validateAllergen\utils\aiGateway.js       备份\hy3-preview-migration-2026-08-27\aiGateway.validateAllergen.js
copy cloudfunctions\getDishImage\utils\aiGateway.js           备份\hy3-preview-migration-2026-08-27\aiGateway.getDishImage.js
```

---

## 二、env1 hy3 上限复测（定 TXT_SLOT_N） ✅ 已完成（2026-08-27 19:00）

> **状态（2026-08-27 19:00 实测完成）**：已执行。env1 临时探针 `probeTextEnv1`（复制 env2 `probeText`，`TCB_ENV`=env1）并发 n=10/16/24 三轮，**okCount 全满、failCount=0、errors={}（0 个 429）**：
> - n=10 → avg=1724ms p95=1909 max=1909
> - n=16 → avg=1326ms p95=1533 max=1533
> - n=24 → avg=1904ms p95=2184 max=2203
>
> **结论**：env1 hy3 拐点 ≥24（远高于设计稿旧值 12~13），上游余量充足，印证"env1 与 env2 配额不同、勿照搬"的判断。
> **决策**：`TXT_SLOT_N` **维持现状**（getRecommendation=10 / submitContribution=5）。理由：拐点宽松说明余量大，但单用户一次出文会并发多路 AI（润色3 + 营养补估 + 哨兵兜底），维持 10 为稳妥值；上调 12~13 非必须，故**不改 `aiGateway.js` 常量、不重部署 4 函数**。探针 `probeTextEnv1` 已删除（云端+本地）。

> 背景：设计稿基于 07-28 探针「env1 hy3 上限 12~13」；但 08-23 env2 压测 hy3 上限 >40。**env1 与 env2 供应商侧配额不同，必须 env1 实测，勿照搬 env2 数值。**

1. 临时复制 env2 已部署的 `probeText`（env2_functions 下）到 `cloudfunctions/probeTextEnv1`，把 `TCB_ENV` 指到 env1（your-env-id-1），部署到 env1。
2. 并发 n=10 / 16 / 24 各打一轮（对齐 env2 压测口径），统计 avgMs / fail=429 拐点。
3. 依结果定 `TXT_SLOT_N`：
   - getRecommendation 现 10（index.js:92）——拐点≥12 可提到 12~13；
   - submitContribution 现 5（index.js:33）——一并评估是否上调。
4. 测完删除 env1 临时探针函数；env2 的探针保留供后续复测。

---

## 三、改网关 `aiGateway.js`（先改 1 份标准版，再同步 5 份）

> 5 份副本位置（当前内容一致）：
> getRecommendation / validateAllergen / submitContribution / getDishImage / autoLexiconFix 各自的 `utils\aiGateway.js`

1. **删** `callPreviewRetry` 闭包（现 156-159 行）整段。
2. **加** sleep 工具（放 `httpsPostJson` 之后、配置读取之前）：
   ```js
   const sleep = (ms) => new Promise(r => setTimeout(r, ms));
   ```
3. **重写** `runHunyuan`（现 178-209 行）为下方版本——删 preview 分流与降级，hy3 限流只退避重试 1 次：
   ```js
   // 2026-08-27：hy3-preview 8-31 下线，移除 preview 链路。
   // hy3 限流(SlotBusyError/429) 退避重试 1 次（sleep 1500）→ 再失败走 custom → [SF] → throw。
   // 只试 1 次：不因重试拖慢主出文流程（定稿决策）。
   const runHunyuan = async () => {
     let lastErr;
     for (let attempt = 0; attempt < 2; attempt++) {
       try { return await callHy3(); }
       catch (e) {
         lastErr = e;
         const isBusy = e instanceof Error && /429|Too Many|rate limit|EXCEED|busy/i.test(String(e.message || ''));
         if (isBusy && attempt === 0) {
           console.warn('[aiGateway](' + label + ') hy3 限流, 退避重试 1 次');
           await sleep(1500);
           continue;
         }
         if (useCustom) { try { return await tryCustom(); } catch (e3) { console.warn('[aiGateway](' + label + ') 自定义兜底失败: ' + ((e3 && e3.message) || e3)); } }
         if (enableSF) return await trySF();
         throw e;
       }
     }
     throw lastErr;
   };
   ```
4. **bump 版本号**（现第 15 行）：
   ```js
   const AI_GATEWAY_VERSION = '2026-08-27.hy3-only-single-retry';
   ```
5. **同步 5 份**：把改好的标准版覆盖复制到其余 4 个函数目录的 `utils\aiGateway.js`。
6. **校验**：`node scripts/check_ai_gateway.js` 应输出「哈希一致 + 版本号一致」。

---

## 四、改 `getRecommendation/index.js`

1. **删除 preview 资产**（分两段删，中间 **100-141 行 hy3 主信号量必须保留**：`txtSlotsReady`/`ensureTxtSlotDoc`/`SLOT_ACQUIRE_DB_ERROR`/`acquireTxtSlot`/`releaseTxtSlot`/`withTextSlot`）：
   - **95-99 行**：降级池注释 + `PREVIEW_SLOT_N` / `PREVIEW_SLOT_TIMEOUT`
   - **143-193 行**：`PREVIEW_MODEL`、`PREVIEW_SLOT_COL` / `PREVIEW_SLOT_PREFIX`、`previewSlotsReady`、`ensurePreviewSlotDoc` / `acquirePreviewSlot` / `releasePreviewSlot` / `withPreviewSlot`、`genPreviewText`（连同整段注释）
   - 另清理 **136 行** `withTextSlot` 内注释「走 430 / 降级 preview」→ 去掉「/ 降级 preview」字样
2. **重写** `genTextWithFallback`（现 205-251 行）为：
   ```js
   // 健壮文本生成：单一 hy3 通道（走信号量）。限流/429 的退避重试由 aiGateway 统一处理（只试 1 次）。
   // primary 保留读取以兼容旧调用；hy3-preview 2026-08-31 已下线，不再区分 preview 链路。
   // 返回结构统一为 { text }，调用方用 pickText / r.text 读取。
   async function genTextWithFallback(messages, opts) {
     const temperature = (opts && opts.temperature != null) ? opts.temperature : 0.9;
     const topP = (opts && opts.topP != null) ? opts.topP : 0.9;
     const primary = (opts && opts.primary) || 'hy3';
     const enableSF = !!(opts && opts.enableSF);
     const maxTokens = (opts && opts.maxTokens != null) ? opts.maxTokens : 1200;
     const label = (opts && opts.label) || 'gen';
     const callHy3 = async () => withTextSlot(() => textModel.generateText({ model: TEXT_MODEL, messages, temperature, topP, maxTokens }));
     const calls = { callHy3 };
     const gwOpts = { temperature, topP, primary, maxTokens, label, enableSF, sfOpts: { maxTokens: 32 } };
     return await aiGateway.callUnifiedText(messages, gwOpts, calls, db);
   }
   ```
   注意：删除原 `previewRetries` 参数、`callPreview` 闭包及其内部 `sleep`；`withTimeout` 在 `withTextSlot`（139 行）仍在用，**不可删**。若想最小化 diff，可保留原有 `try { return await ... } catch (e) { throw e; }` 透传结构（行为等价，网关内已处理全降级链）。
3. **5 处调用点改 primary、删 previewRetries**：

   | 行（现状） | label | 改法 |
   |-----------|-------|------|
   | 3177 | regen-names | `primary:'preview'` → `primary:'hy3'` |
   | 3234 | calibrate | `primary:'preview', previewRetries: 0` → `primary:'hy3'`，删 `previewRetries` |
   | 3600 | nutri-est | `primary:'preview', previewRetries: 0` → `primary:'hy3'`，删 `previewRetries` |
   | 6969 | regen | `primary:'preview', previewRetries: 3` → `primary:'hy3'`，删 `previewRetries` |
   | 7052 | rice-retry | `primary:'preview', previewRetries: 2` → `primary:'hy3'`，删 `previewRetries` |

4. **清理注释**（提到 preview / hy3-preview 的，改写为「仅 hy3」）：
   - 函数头部注释块：195-203（含 199-201 双链路描述）、216-217（网关 mode 注释「hy3/preview → 自定义」）、248（「hy3/preview/自定义/SF 全链」）、254（pickText「实测 hy3/hy3-preview」）
   - 各调用点上方注释：3173（regen-names「走 preview 优先」）、3230（calibrate「走 preview 优先」）、3584（aiEstimateNutrition「优先走 preview」）、3594-3597（nutri-est 注释块：previewRetries:0 的旧理由需改写成「hy3 限流由网关统一退避(只试 1 次)」）、3633（「已含 previewRetries:0」）、6966（regen「预览优先(不占 hy3 槽)」）。
   - 业务侧注释：3758、4280、5580、5587、5595、6602、6972、6979、7002
5. **bump BUILD_TAG**（现 340 行）：
   ```js
   const BUILD_TAG = '2026-08-27.env1-hy3-preview-removed';
   ```

---

## 五、改 `autoLexiconFix/index.js`

1. **删除**：
   - 37 行 `const PREVIEW_MODEL = 'hy3-preview';`
   - 39 行 `const PREVIEW_RETRIES = 2;`
   - 70-92 行 `callPreview` 闭包（连同 61 行「preview 优先」注释块）；`sleep` 如无其他引用一并删
   - `withTimeout`（55-59 行）：若删除闭包后无引用则一并删；`pickText` 被 `aiNormalize` 使用，保留
2. **重写** `genTextWithFallback`（现 62-96 行）为：
   ```js
   // ── 文本生成（hy3 单一通道）：涉及限流/429 的退避重试由 aiGateway 统一处理（只试 1 次）──
   async function genTextWithFallback(messages, opts) {
     const temperature = (opts && opts.temperature != null) ? opts.temperature : 0.3;
     const topP = (opts && opts.topP != null) ? opts.topP : 0.9;
     const maxTokens = (opts && opts.maxTokens != null) ? opts.maxTokens : 300;
     const label = (opts && opts.label) || 'lexicon-fix';
     const callHy3 = async () => textModel.generateText({ model: TEXT_MODEL, messages, temperature, topP, maxTokens });
     const calls = { callHy3 };
     const gwOpts = { temperature, topP, primary: 'hy3', maxTokens, label, enableSF: false };
     return await aiGateway.callUnifiedText(messages, gwOpts, calls, db);
   }
   ```
3. **清理注释**：11-17 行「模型路由（preview 优先…）」改写为 hy3 单一通道；16-17 行「⚠️ hy3-preview 将于 2026-08-31 下线…」注释删除。
4. **bump BUILD_TAG**（现 27 行）→ `'2026-08-27.env1-hy3-preview-removed'`。

---

## 六、改 `submitContribution/index.js`

1. **删除**：
   - 66-68 行「hy3-preview 降级」注释块
   - 386 行 `const callPreview = ...`（连同注释）
   - 372-373 / 413 行注释里 preview 描述改写
2. **重写** `genTextWithFallback`（现 379-390 行）为：
   ```js
   // 统一文本生成（2026-08-18 改为走 aiGateway.callUnifiedText）。
   // 网关读 sys_config/ai_custom，按 mode 编排降级链；贡献审核 enableSF:true，hy3+自定义均失败时借 SF 兜底。
   async function genTextWithFallback(messages, opts) {
     const temperature = (opts && opts.temperature != null) ? opts.temperature : 0.9;
     const topP = (opts && opts.topP != null) ? opts.topP : 0.9;
     const primary = (opts && opts.primary) || 'hy3';
     const enableSF = !!(opts && opts.enableSF);
     const label = (opts && opts.label) || 'gen';
     const callHy3 = async () => withTextSlot(() => textModel.generateText({ model: TEXT_MODEL, messages, temperature, topP }));
     const calls = { callHy3 };
     const gwOpts = { temperature, topP, primary, maxTokens: 1200, label, enableSF, sfOpts: { maxTokens: 800 } };
     return await aiGateway.callUnifiedText(messages, gwOpts, calls, db);
   }
   ```
   注意：`withTimeout` 在 `withTextSlot`（63 行）仍在用，**不可删**。
3. **bump BUILD_TAG**（现 488 行）→ `'2026-08-27.env1-hy3-preview-removed'`（与全局统一，未追加语义后缀）。

---

## 七、改 `validateAllergen/index.js`

1. **删除** 29 行 `callPreview` 闭包，`calls` 改为 `{ callHy3 }`；清理 13-21 行 / 47 行注释里 preview 描述。
2. **重写** `genTextWithFallback`（现 22-33 行）为：
   ```js
   // 统一文本生成 + 多后端降级封装（2026-08-18 改为走 aiGateway.callUnifiedText）。
   // 网关读 sys_config/ai_custom，按 mode 编排降级链；过敏原校验 enableSF:true，混元+自定义均失败时借 SF 兜底。
   async function genTextWithFallback(messages, opts) {
     const temperature = (opts && opts.temperature != null) ? opts.temperature : 0;
     const topP = (opts && opts.topP != null) ? opts.topP : 0.9;
     const enableSF = !!(opts && opts.enableSF);
     const label = (opts && opts.label) || 'gen';
     const maxTokens = (opts && opts.maxTokens) || 4;
     const callHy3 = async () => model.generateText({ model: TEXT_MODEL, messages, temperature, topP, maxTokens });
     const calls = { callHy3 };
     const gwOpts = { temperature, topP, primary: 'hy3', maxTokens, label, enableSF, sfOpts: { maxTokens: 32 } };
     return await aiGateway.callUnifiedText(messages, gwOpts, calls, db);
   }
   ```
3. **bump BUILD_TAG**（现 37 行）→ `'2026-08-27.env1-hy3-preview-removed'`。

---

## 八、`getDishImage/index.js`（可选，仅注释）

19 行、244 行注释里「hy3-preview 是文本模型无法替代图片生成……」的描述改为历史备注（如「历史上 hy3-preview 为文本模型，无法用于图片生成；现已下线」）。逻辑不动，**无需重新部署**；其 `utils/aiGateway.js` 副本随 §三 同步即可。

---

## 九、`scripts/check_ai_gateway.js` 补 target

`targets` 数组（20-25 行）追加一行（与现有 4 行风格一致）：
```js
path.join(root, 'cloudfunctions', 'autoLexiconFix', 'utils', 'aiGateway.js'),
```

---

## 十、本地自检（必须全过）

```powershell
node --check cloudfunctions\getRecommendation\index.js
node --check cloudfunctions\autoLexiconFix\index.js
node --check cloudfunctions\submitContribution\index.js
node --check cloudfunctions\validateAllergen\index.js
node scripts\check_ai_gateway.js
```

残留扫描（期望 0 命中；`.bak_corrupt` / node_modules / 备份目录除外）：
```powershell
grep -rn "hy3-preview\|PREVIEW_" cloudfunctions --include=*.js --glob "!node_modules/**" --glob "!*.bak*"
```
> 若命中 `getRecommendation/index.js.bak_corrupt` 一类属历史备份文件，可删除或保留，均不影响部署。

---

## 十一、部署 env1（必须部署 4 个函数）

> 工具：`%APPDATA%\npm\tcb.ps1`；也可用 CloudBase MCP `manageFunctions`。
> **环境切换必须重新授权**（AGENTS.md 坑）：`set_env` 只改环境 ID 不刷新凭证，直接部署会 env not found。

1. **切到 env1 并授权**：
   ```
   tcb auth logout
   tcb auth start_auth        # web 或 device，浏览器授权到 env1 账号
   tcb set_env                # 选择 your-env-id-1（env1）
   ```
2. **部署 4 个函数**（`utils\aiGateway.js` 在各函数子目录内，会一并打包）：
   ```
   tcb functions deploy getRecommendation
   tcb functions deploy autoLexiconFix
   tcb functions deploy submitContribution
   tcb functions deploy validateAllergen
   ```
   getDishImage 无需部署（无逻辑改动）。
3. **切回 env2**：
   ```
   tcb auth logout
   tcb auth start_auth
   tcb set_env                # 恢复 your-env-id-2（env2）
   ```
4. ⚠️ `_shared/` 坑：MCP `updateFunctionCode` 只打包函数子目录、不含 `cloudfunctions/_shared/`。本次未改动 `_shared/normLexName` 等文件，若此前 getRecommendation 已按「复制副本入函数目录(require './normLexName')」部署过则无需处理；仅需确认云端当前实例正常。

---

## 十二、部署后验证

1. 等 60s，直读 CloudBase 日志（MCP queryLogs 或 invokeFunction 返回 Log）：4 函数 build 行打出 `BUILD_TAG=2026-08-27.env1-hy3-preview-removed`；后续日志无 `hy3-preview` 字样。**2026-08-27 实测：4 函数 invoke 日志均命中该 BUILD_TAG（getRecommendation 含 `coldstart=true`），确认部署生效。**
2. 小程序实测：主出文（main 链路）返回 200；再走一次重出/校准路径，不报 430、不被拖慢。
3. env1 探针复测一轮确认拐点匹配 `TXT_SLOT_N`，然后删除 env1 临时探针。

---

## 十三、晚高峰观察（上线后 1~2 天）

- 日志搜 `429|Too Many|text channel busy|hy3 限流`。
- 若 430 明显增多：
  1. 先确认 `TXT_SLOT_N` 是否按 §二 探针结果设置（getRecommendation:92、submitContribution:33）；
  2. 仍不够再评估升标准版走方案 B（另起设计），**不默认扩新模型**。

---

## 十四、回退预案

- 上线后若问题严重：用 §一 备份的 4 个 index.js + 5 份 aiGateway.js 覆盖回去，按 §十一 流程重新部署，可恢复到 preview 版本（**仅在 8-31 前有效**，用于争取修复时间）。
- 8-31 之后 preview 已下线，任何回退无效，只能立即修复并重发。

---

## 十五、env2 rateLimiter 复用边界（2026-08-27 记录，本次不实施）

> 查询背景：评估 env1 的并发/重试能否复用 env2 的「自适应令牌桶」。

### env2 rateLimiter 现状

- 位置：**真源 `env2_functions/_shared/rateLimiter.js`**（BUILD_TAG `2026-08-24.rate-limiter-v1`），部署时复制到各函数目录（bypassGenImage/bypassAiEnrich/bypassGenGuide 等副本）。
- 机制：① 令牌桶：按动态 rate（令牌/秒）限速，burst=rateMax；② 自适应调速：遇 429 `rate*=0.6`（降速40%），连续成功 K 次 `rate*=1.1`（提速10%，上限 rateMax）；③ 60s 时间窗硬上限 windowCap；④ 429 指数退避（backoffBase 起，backoffMax 封顶）。
- 接入：`await limiter.acquire()`（前置限速）→ 请求成功 `onSuccess()` / 遇 429 `onLimit()`。

### 结论（关键：作用域非跨实例）

**rateLimiter 是单实例（进程）内存状态**（`_tokens`/`_windowCount`/`_backoffUntil` 全在进程内），**无跨实例协调**。而 env1 getRecommendation 的用户请求被分发到多个云函数实例，各实例独立 limiter 互不知情，总并发 = 实例数 × 各自 rate，**照样击穿 env1 上游硬限**。这正是 env1 当初用数据库信号量（counters `txt_slot_*`）做**跨实例全局互斥**的原因。

### 分场景判断

| 用途 | 能否复用 | 说明 |
|---|---|---|
| 跨实例并发闸门 | ❌ **不能替代** | env1 全部文本调用必须继续用 DB 信号量（`TXT_SLOT_N`），getRecommendation=10 / submitContribution=5 保持现状，复测后即使上调也仍走 DB 信号量 |
| 429 重试/退避 | ⚠️ **与定稿冲突，不接入主链路** | `onLimit` 退避最长 `backoffMax=8000ms`（一次 429 后 acquaren 等待最长 8s），与定稿「hy3 限流只重试 1 次、sleep 1500、不拖慢主出文」矛盾；env2 是批处理可久等，env1 主出文是用户实时请求 |
| 实例内软控速 | ✅ 可选轻量增强（**本次不实施**） | 只取 `rate*=0.6` 降速记忆（不启用 backoffUntil 阻塞），即「本实例被 429 后下次放慢」，对跨实例仅缓解作用 |
| 后台/批量低价值步 | ✅ 适合整份复用（**本次不实施**） | env1 fire-and-forget 步（autoLexiconFix 怪名规范化、nutri-est 后台补写）用户不等结果，可承受退避 |

### 落地约定

- 本次 preview 迁移**不引入** rateLimiter；保持「DB 信号量 + 网关 1500ms 单次重试」不变。
- rateLimiter 复用（实例内降速记忆 / 后台步整份接入）列为后续可选优化项，另起记录，不进本迁移改动。若后续实施，需复制 rateLimiter.js 到 env1 函数目录，且**不得**用它替代 counters 信号量。

---

## 附：本次不动清单（防误改）

- **env2_functions 全部不动**：env2 无 preview 调用（仅 bypassNutritionEst:16 / bypassAiEnrich:15 / **bypassLexiconFix:12** 共 3 处注释提及；bypassLexiconFix 实际 `model:'hy3'` 直配；aiProbe 的 `preview:` 是探针 debug 字段名，无关）。
- **env1 AI 调用函数已全量核实，以下均直配 `'hy3'`、无 preview、无需改动**：manageShopping（manageShopping/index.js:52）、backfillNutrition（:54）、probeStream（:17）、probeReason（:40）、txtConcProbe（:63），以及 getRecommendation/autoLexiconFix/submitContribution/validateAllergen 的 `TEXT_MODEL='hy3'`。
- **getDishImage 逻辑不动**：仅可选注释清理；副本 aiGateway.js 随网关同步。
- **TXT_SLOT_N 默认维持现状**（getRecommendation=10 / submitContribution=5），按 §二 env1 探针复测结果再调。
- **SF 链路不动**：submitContribution / validateAllergen 两处 `enableSF:true` 保留；main 链路不启用；`SF_KEY` 不改。

## 附２：非部署残留与 grep 排除清单（2026-08-27 全站核查）

以下含 `hy3-preview`/`PREVIEW_` 字样，但**不会被部署/加载**，请勿误改，grep 自检时排除：

| 文件 | 性质 | 处置 |
|---|---|---|
| `cloudfunctions/getRecommendation/index.js.bak_corrupt` | 损坏后缀的历史副本（.bak 不被 require） | 保留或删除，不影响 |
| `_tmp_refactor_backup/getRec_index_PRE_REFACTOR_2026-08-16.js` | 重构前备份（33 处 preview） | 保留存档 |
| `scripts/.tmp_rr/index.js` | 实验沙箱旧副本（genTextRobust 更老架构） | 保留或删除 |
| `*.bak*` / `备份\*` / 各 node_modules | 备份与依赖库 | grep 排除 |
| scripts/node_modules（playwright 等 pr、env2/node_modules 的 `preview` | 三方库内部 API 名称，无关 | grep 排除 |

**数据层（可选清理，删除 preview 代码后成孤儿，无功能影响）**：
- `counters` 集合中 `preview_slot_0` ~ `preview_slot_21`（PREVIEW_SLOT_PREFIX，共 22 个槽文档）——可在云开发控制台手动清理；`txt_slot_*`（hy3 主信号量）**保留**。

## 附３：规则/规格文档文字引用（非代码，迁移完成后建议同步措辞）

以下含 `hy3-preview` 时效/迁移描述，**不影响运行**，但迁移落地后应更新措辞（把 preview 时效置「已废弃/仅 hy3」）：
- `PROJECT_RULES.md:68`（R-AI-04）**`[已完成 2026-08-27]`**：已改「2026-08-31 下线」→「已于 2026-08-27 移除，免费仅余 hy3」，并递增规则版本 v2.0.2→v2.0.3（顶部版本行 + 变更记录表追加 v2.0.3 行）。
- `.codeartsdoer/specs/project_rules_doc/`（spec.md / design.md / tasks.md / 覆盖矩阵.md，多处 hy3-preview 时效行）—— 存档文档，建议同步但非阻塞。
- `docs/env2补充env1菜谱库.md:221/501`（getRecommendation 描述含 "hy3-preview 降级"）—— 描述性文档，建议改写为「仅 hy3」。
- `.codebuddy/memory/*`（历史记忆，存档性质，可不改）

---

## 十六、执行记录（2026-08-27 实测）

- **备份**：`备份/hy3-preview-migration-2026-08-27/` 含 4 个 index.js + 5 份 aiGateway.js（用 `cmd copy` 二进制拷贝，规避 powershell 乱码）。
- **网关**：标准版 `getRecommendation/utils/aiGateway.js` 删 `callPreviewRetry`、加 `sleep`、重写 `runHunyuan`（hy3 限流 sleep 1500 退避重试 1 次 → custom → [SF] → throw）；版本 `2026-08-27.hy3-only-single-retry`。用 `cmd copy` 同步至其余 4 份。
- **4 个 index.js**：删 preview 信号量资产/`callPreview` 闭包/`PREVIEW_*` 常量；getRecommendation 5 处 `primary:'preview'`→`'hy3'`（regen-names / calibrate / nutri-est / regen / rice-retry）；BUILD_TAG 统一 `2026-08-27.env1-hy3-preview-removed`。
- **check_ai_gateway.js**：追加 autoLexiconFix target（现 5 个 target）；`node scripts/check_ai_gateway.js` 通过（哈希+版本一致）。
- **自检**：`node --check` ×9 全过（4 index + 5 aiGateway）；grep 代码层 `hy3-preview|callPreview|PREVIEW_|withPreviewSlot` 残留 = 0（`getDishImage/index.js` 注释中 "hy3-preview 是文本模型" 为正确说明，保留）。
- **部署**：MCP `manageFunctions.updateFunctionCode` 4 函数 → 等 60s 冷启动 → `invokeFunction`，4 个日志均命中 `BUILD_TAG=2026-08-27.env1-hy3-preview-removed`（getRecommendation 含 `coldstart=true`），确认生效。业务响应为预期鉴权/参数缺失（401/400），不影响部署验证。
- **探针复测（§二 / §十二.3）**：2026-08-27 19:00 已完成。env1 临时探针 `probeTextEnv1`（复制 env2 `probeText`，TCB_ENV=env1）并发 n=10/16/24 三轮全成功、0 个 429（avg 1724/1326/1904ms，p95 1909/1533/2184ms）；`TXT_SLOT_N` 维持现状（10/5，不重部署）；探针已删（云端+本地）。
- **未做**：§十三 晚高峰观察（08-31 前待办）；§八 getDishImage 注释经评估无需改（保留正确说明）。
- **范围**：仅 env1；env2 bypassGenDish 走独立混元，不在本次范围。