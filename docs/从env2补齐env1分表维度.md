# 从 env2 补齐 env1 分表维度（本地脚本双环境直连方法论）

> 状态：已实操验证（2026-08-26 补齐 74 条；2026-08-27 修复 approveDish 写废弃表 bug + 全库补齐 profile/recommend 缺口）
> 关联：`docs\菜品库分表规范化执行方案.md`、`PROJECT_RULES.md` R-Env-02 / R-Sync-02 / R-DB-01
> 目的：当 env1 某批菜的维度分表（profile/recommend/nutrition 等）缺失，而 env2 `dish_mirror` 有完整数据时，用本地脚本**一次性补齐**，无需 AI 重新生成。

---

## 一、适用场景

env1 正式库的分表（`dish_profile`/`dish_recommend`/`dish_nutrition_v2`/`dish_image_v2` 等）某维度缺失，但对应菜名在 **env2 `dish_mirror`** 里有完整数据（profile / reason / nutrition 已生成）。典型如：

- env2 新同步菜只落了内容类分表（steps/ingredients/review/tips），却**缺画像/推荐理由/营养**维度分表；
- 需要把这些菜补成"全维度齐"，再补图片进 `dish_image_v2`，达到"全维度齐才入分表"的口径。

**判定前提（先核查）**：用脚本确认 env2 `dish_mirror` 确实含这些菜的三维度，否则无从补起（需走 AI 重生成，是另一条路）。

---

## 二、核心方法：本地脚本双环境直连（无需切 MCP 环境）

**关键认知**：`@cloudbase/node-sdk` 在**一个脚本里同时 `cloud.init` 两个环境**，一个进程内完成"读 env2 → 写 env1"，**不需要走 MCP 的环境切换 / 重新授权**（R-Env-02 的 `auth` 重授权流程只适用于 MCP，本地脚本不受限）。

> ⚠️ **env1 / env2 是不同账号凭证（2026-08-27 修正）**：实测 env1 和 env2 分属**不同腾讯云账号**，SecretId/Key **不能共用**。脚本须**分别 `cloud.init` 两环境、各自传对应凭证**，否则会报 `INVALID_ENV`（100003）。原来"同一组凭证 init 两个环境"的认知是错的，已在此更正。

```js
const cloud = require('@cloudbase/node-sdk');
// env1（目标写入环境）—— 用 env1 凭证
const app1 = cloud.init({ env: ENV1, secretId: SID1, secretKey: SK1 });
// env2（数据源读取环境）—— 用 env2 凭证（不同账号，不能复用 SID1）
const app2 = cloud.init({ env: ENV2, secretId: SID2, secretKey: SK2 });
const db1 = app1.database();
const db2 = app2.database();
```

> 注意：本地脚本用 SecretId/Key 直连可**读 env2 + 写 env1**（env1 是本环境，自身权限内）。这不受 R-Sync-02 的"跨账号写入"限制——R-Sync-02 限制的是**跨账号写 env2**（需云函数 + `cloudbase_auth`），本地脚本从 env2 只读不写，完全可行。

### 环境变量（`.env` 五变量，`scripts/.env`）

| 变量 | 含义 |
|------|------|
| `TCB_ENV` | env1 环境 ID = `your-env-id-1` |
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | **env1 账号**凭证 |
| `TCB_ENV2` | env2 环境 ID = `your-env-id-2` |
| `TCB_ENV2_SECRET_ID` / `TCB_ENV2_SECRET_KEY` | **env2 账号**凭证（区别于 env1，勿混用） |

> ⚠️ **凭证轮换**：秘钥会过期/轮换，过期后本地脚本报 `INVALID_ENV`（100003）。`execute_command` 子进程**不继承** MCP 的 connect_cloud_service 凭证（仅在 MCP 层有效），本地脚本**必须依赖 `.env` 文件**。轮换后让用户提供新秘钥更新 `.env` 即可（env1/env2 各一组）。

---

## 三、脚本清单（`scripts/` 目录）

| 脚本 | 职责 | 复用点 |
|------|------|--------|
| `check-env2-mirror-dims.js` | 核查 env2 `dish_mirror` 对这 74 条菜的维度覆盖（profile/reason/nutrition 是否齐） | **前提核查**：确认可补 |
| `check-approved-completeness.js` | 核查 env1 待补菜在各分表的齐全度（哪些维齐/哪些缺） | 定位缺口 |
| `backfill-env1-dims.js` | **补数主脚本**：读 env2 mirror → 写 env1 分表 + 补图（幂等） | 核心执行（74 条批次） |
| `clean-image-pending-overlap.js` | 清理 `dish_image_pending` 中图片已入 v2 的 approved 影子记录 | 补完后清冗余 |
| `peek-env2-mirror.js` | 抽样看 env2 mirror 单条字段结构 | 字段探测 |
| `check-profile-gap.js` | **大范围缺口核查**：对比 `dish_lexicon` 全量 vs `dish_profile`/`dish_recommend` 已有 set，输出缺口清单 + env2 可补范围（**只连 env1**，避开大批量跨环境拉取） | 全库缺口定位（448 缺口批次） |
| `backfill-profile-gap.js` | **大范围补齐**：读 env1 缺口 + 读 env2 mirror（双凭证）→ 仅补"缺且 env2 有数据"的 `dish_profile`/`dish_recommend`（幂等，`--dry` 预演） | 全库 profile/recommend 补齐（448 缺口批次） |

---

## 四、字段映射（env2 dish_mirror → env1 分表）

| env2 `dish_mirror` 字段 | env1 目标分表 | 落库字段 | 处理 |
|------------------------|--------------|---------|------|
| `profile`（对象） | `dish_profile`（_id=norm_id） | `profile` | **剔除 `_issues` 内部标记**，保留 `{spicy,flavors,type,main,isVeg,isSoup,cuisine,mealTime}` |
| `reason`（字符串） | `dish_recommend`（_id=norm_id） | `reason` | 直接写入 |
| `nutrition`（number[4]） | `dish_nutrition_v2`（_id=norm_id） | `nutrition` | 数组 `[热量,蛋白,碳水,脂肪]` |
| env1 `dish_image_pending.imageUrl` | `dish_image_v2`（_id=norm_id） | `imageUrl` | 补图，图片数据源在本环境 pending，非 env2 |

> **`_issues` 字段**：env2 mirror 的 `profile` 自带 `_issues: []`（内部标记），**绝不能写进 env1**。补数前用 `cleanProfile()` 剔除，否则 env1 分表混入脏字段。

---

## 五、执行流程（标准操作）

```
1) 前提核查   node check-env2-mirror-dims.js
     确认 env2 dish_mirror 命中目标菜数、三维度齐备（不齐则不可补）
2) 缺口定位   node check-approved-completeness.js
     确认 env1 各分表缺哪些维（profile/recommend/nutrition）
3) 预演       node backfill-env1-dims.js --dry
     确认补数分布（如 profile+74 / recommend+74 / nutrition+16 / image+74）
4) 执行       node backfill-env1-dims.js
5) 复核       node check-approved-completeness.js   # 应"全齐 N 条 / 0 有缺"
6) 清冗余     node clean-image-pending-overlap.js --dry → 执行
     图片已入 v2 的 approved 影子记录删除（dry 确认待删数后执行）
```

### 幂等原则（重要）

`backfill-env1-dims.js` 逐维判断目标分表 `doc(nid)` **已存在则跳过**（`hasProfile.has(nid)` 等），不覆盖真值；**仅补缺失**。符合"库有则不写、库无才写、AI 最后辅助"的既定原则。

---

## 六、注意事项与踩坑（必读）

1. **分表 `_id` = norm_id**：env1 分表 `_id` 是归一化菜名（`normLexName`），env2 mirror 菜名在 `name`/`_id` 字段，比对/写入前统一 `normLexName()` 归一，避免空格/变体 miss。
2. **`.add()` 禁带 `_id`**：补写用 `doc(nid).set({...})`（doc 已指定 _id），**data 里不能再含 `_id`**（报 `不能更新_id`）。这是云开发硬规则（R-DB-01）。
3. **删除用逐条 `doc(_id).remove()`**：node-sdk v2 的 `remove()` 不支持 limit，`where({}).remove()` 可能触发 Windows AMSI 拦截崩 shell；逐条删最稳。
4. **集合 >1000 用 _id 游标分页**：`dish_mirror`(1090)/`dish_lexicon`(1425) 等超 1000，`skip` 有上限，必须 `orderBy('_id','asc').where(_id>lastId)` 游标。
5. **绝不用 PowerShell 读写源文件**：powershell 会 UTF-16 毁中文（历史事故），脚本/文档一律用 write_to_file（UTF-8）。
6. **删除同类记录不能按去重键只删一条**：曾因按菜名去重只删一条，漏删同菜名多记录（42 条残留）；应**逐条判断**目标键命中即删。
7. **破坏性操作先 `--dry`**：所有写/删脚本带 `--dry` 预演，统计数字无误再执行（用户原则）。
8. **清理待审池影子记录前先确认补齐**：先补维度+图，确认菜已在 v2，再清 `_pending` 影子，避免误删数据源。
9. **⚠️ 双凭证铁律（2026-08-27）**：env1 与 env2 是**不同账号**，脚本必须分别 `cloud.init` 并传 `TCB_SECRET_ID/SK1` 与 `TCB_ENV2_SECRET_ID/SK2` 两组凭证。**同一组凭证 init 两环境会 `INVALID_ENV`**。凭证轮换后 `execute_command` 子进程不继承 MCP 凭证，必须让用户提供新秘钥更新 `.env`（env1/env2 各一组）。

---

## 七、关联与边界

- **读 env2 + 写 env1**：本方法适用（env1 是本环境）。**反向（写 env2）** 受 R-Sync-02 限制，走云函数 + `cloudbase_auth`，非本方法。
- **env2 `dish_mirror` 保持宽档生成态**：本方法**只读** env2，不拆不改 env2（D5）。
- **AI 重新生成**：若 env2 也无该维度，则需 AI 生成（env2 bypass 链或 env1 补算），超出本"数据搬运"方法范围。

---

## 八、案例：2026-08-27 全库 profile/recommend 缺口补齐

### 背景：approveDish 写废弃表 bug（缺口根因）

`manageLexicon.approveDish` 曾写**已废弃删除的旧表** `dish_ai_profile`（画像旧表）和 `dish_guide`（做法旧表），且**从不写 `dish_recommend`**。结果：
- `Promise.all(writes)` 里写废弃表抛 `Db or Table not exist` → 整条 `approveDish` 标记 `fail`（**假失败**，主库 `dish_lexicon` 和其他规范化分表已并发写成功，菜实际入库）。
- 规范化分表 `dish_profile`（画像）从未被写（写错到废弃表），`dish_recommend`（推荐理由）从未被写 → **历史所有一键入库的菜都缺这俩维度**。

**已修复**（manageLexicon BUILD_TAG `2026-08-26.v23-fix-abandoned-tables`）：approveDish 改写为写 `dish_profile`（非废弃 `dish_ai_profile`）+ 补写 `dish_recommend`，删除废弃 `dish_guide` 整表写入。后续一键入库正常写这俩分表，不再产生新缺口。

### 剩余缺口核查（凭证恢复后）

env1/env2 凭证轮换后本地脚本失效，用户提供新秘钥（env1/env2 各一组）恢复 `.env`。核查结果（`check-profile-gap.js`，只连 env1）：
- `dish_lexicon` = 1466 条
- `dish_profile` 已有 1020 → **缺 448**
- `dish_recommend` 已有 1020 → **缺 448**

`backfill-profile-gap.js`（双凭证：env1 读缺口 + env2 读 mirror）执行结果：
- env2 `dish_mirror` = 1094 条
- 缺 profile 448 中：**env2 有数据可补 35 条**，剩余 413 条 env2 无源
- 缺 recommend 448 中：**env2 有数据可补 29 条**，剩余 419 条 env2 无源
- 执行：补 profile 35 + recommend 29，**0 错误**
- 复核：`dish_profile` 1020→**1055**、`dish_recommend` 1020→**1049**

### 关键结论

- **缺口来自"写错表/漏写表"的 bug，不是数据丢失**；env2 有源的已补齐。
- **剩余 413（profile）/419（recommend）条在 env2 `dish_mirror` 里根本没有**——它们是 env1 本地产生的菜（`history`/`explore`/`ai-gen` 源），env2 从未生成过画像/推荐理由，**无法从 env2 补**（走数据搬运无解）。
- 若这些菜确需画像/推荐理由，只能走 **AI 重新生成**（env2 生成链或 env1 补算），属另一条路（见上方"AI 重新生成"边界）。读侧已有兜底，不强制补齐。

---

## 实操批次归档

- **2026-08-26**：补齐 74 条菜（profile/recommend +16 营养 + 补图），随后清理 74 条 approved 影子，`dish_image_pending` 净化至仅剩 29 条 pending。
- **2026-08-27**：修复 approveDish 写废弃表 bug（v23）；凭证轮换后用双凭证补齐全库 profile/recommend 缺口，env2 有源可补的 35(profile)+29(recommend) 条已补，`dish_profile`→1055、`dish_recommend`→1049；剩余 413/419 条 env2 无源、无法用本方法补。
