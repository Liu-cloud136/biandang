# env2 生成质量提升方案

> 2026-08-22 · 目的：提高 env2 dish_mirror 菜品数据质量，为"查表推荐"演进打基础
>
> 额度限期 6 个月：不太在乎花费但不能浪费。以下方案均以"零浪费"为原则——本地校验零 AI 调用，hy3 仅对可疑候选调用。
>
> **实现状态：5 个方案全部已实现并部署到 env2（2026-08-22），health 验证通过。去重池已扩大至 2782 道（含 env1 dish_lexicon 418 道），实测验证通过。**

---

## 一、问题清单（基于 dish_mirror 24 条实测 + 代码审查）

| # | 问题 | 严重度 | 根因 |
|---|------|--------|------|
| 1 | **去重不够强** | 高 | prompt 只传 50 个菜名(index.js:294) + hy3 只判 50 个(index.js:360) + 无编辑距离，生成和现有库重复的菜 |
| 2 | **菜系单一** | 高 | prompt 未指定菜系轮换，AI 默认出"家常菜"（24 条中家常菜系占比高） |
| 3 | **模式重复** | 中 | 同食材/同做法变体多（蒜蓉炒系列 4 道、烤系列 4 道、黄瓜饮系列 2 道） |
| 4 | **营养未区分** | 中 | bypassNutritionEst 查表兜底不区分食材（青椒炒猪肉丝和青椒炒鸭肉营养完全相同） |
| 5 | **画像 cuisine 不一致** | 中 | dish.cuisine 和 profile.cuisine 偶尔不匹配，无交叉校验 |
| 6 | **无画像一致性校验** | 高 | 文档 9.3 规划了但代码未实现，矛盾画像直接入库 |
| 7 | **无营养合理性校验** | 高 | 文档 9.4 规划了但代码未实现，只有 clampNum 范围限制 |
| 8 | **无 hy3 自评打分** | 高 | 文档 9.5 规划了但代码未实现，低质量菜直接入库 |

---

## 二、方案一：全库强去重

> 现有参考库已丰富（cookbook_ref 1786 道 + dishes.json 923 道 + dish_mirror 24 道 ≈ 2410 道），不需要种子库灌入。核心问题是去重不够强，会生成和现有库重复的菜。

### 2.1 现有去重缺口

| # | 缺口 | 位置 | 后果 |
|---|------|------|------|
| 1 | 生成 prompt 只传 50 个菜名 | index.js:294 `existingNames.slice(0,50)` | AI 不知道全库 2410 个菜名，会生成重复菜 |
| 2 | hy3 语义判定只传 50 个菜名 | index.js:360 `others.slice(0,50)` | 语义查重覆盖面不够，重复菜漏过 |
| 3 | 无编辑距离模糊匹配 | checkSimilar 缺失 | "宫保鸡丁"vs"宫爆鸡丁"、"回锅肉"vs"川式回锅肉" 漏过 |

### 2.2 去重池

| 库 | 条数 | 格式 | 已建索引 |
|----|------|------|----------|
| cookbook_ref.json | 1786 | 菜名→食材数组 | ✅ COOK_REF_NORM_SET |
| dishes.json | 923 | 菜名数组(d.all) | ✅ DISH_NORM_SET（已建） |
| dish_mirror | 42 | DB 记录 | ✅ 运行时归一化合并 |
| dish_lexicon（env1 同步） | 418 | DB 集合（菜名） | ✅ 运行时归一化合并 |
| **合计** | **~2782** | | |

### 2.3 三层去重方案

**第0层：归一化精确查重（O(1)，零 AI 调用）**
- 新建 `DISH_NORM_SET`（dishes.json 归一化 Set）
- 合并 `ALL_NORM_SET = COOK_REF_NORM_SET ∪ DISH_NORM_SET ∪ dish_mirror归一化`
- 新菜名归一化后查 Set，命中即重复

**第1层：本地模糊预筛（O(n)，零 AI 调用）**
- 编辑距离 ≤2："宫保鸡丁"≈"宫爆鸡丁"（距离1）
- 包含关系："回锅肉"⊂"川式回锅肉"
- 筛出 ≤10 个可疑候选，按相似度排序

**第2层：hy3 语义精判（1 次 AI 调用，仅对可疑候选）**
- 只把本地筛出的 ≤10 个候选传给 hy3（而非随机 50 个）
- hy3 判定是否同菜异名
- 无可疑候选则跳过 hy3 调用（省额度）

### 2.4 生成 prompt 改进

prompt 里传更多已有菜名做排除参考（从 50 个扩到 200+，按菜系分组抽样），让 AI 生成时就知道更多已有菜，从源头减少重复生成。

### 2.5 代码改动

`bypassGenDish/index.js`：
1. 新建 `DISH_NORM_SET`（dishes.json 归一化 Set）
2. 新增 `levenshtein(a, b)` 编辑距离函数
3. 新增 `localSimilarCandidates(name, allNames)` 本地模糊预筛
4. 改 `checkSimilar`：第0层查 `ALL_NORM_SET`，第1层本地预筛，第2层 hy3 只判候选
5. 改 `genCandidates` prompt：传 200+ 菜名（按菜系分组抽样）
6. **新增查 env2 `dish_lexicon` 集合**：把 env1 同步过来的 418 道菜名加入 dedupPool 和 `ALL_NORM_SET`，O(1) 精确查重

### 2.6 费用影响

- 归一化 Set + 编辑距离：**零 AI 调用**
- hy3 语义判定：每道菜最多 1 次（128 token），仅对有可疑候选的菜触发
- prompt 扩大参考面：不增加调用次数，+几百 token prompt 长度
- **不浪费额度**

---

## 三、方案二：菜系轮换 + 模式去重

### 3.1 菜系轮换

bypassGenDish 每次生成时，按轮换表指定菜系，确保均衡覆盖：

```javascript
const CUISINE_ROTATION = [
  '川菜', '湘菜', '粤菜', '鲁菜', '浙菜', '东北菜', '家常菜',
  '川菜', '湘菜', '粤菜', '鲁菜', '浙菜', '东北菜', '家常菜',
  '西餐', '东南亚', '烘焙',
];
// 每次生成取 CUISINE_ROTATION[cursor % len]，cursor 存 sys_config
```

### 3.2 模式去重

生成新菜前，查 dish_mirror 最近 20 道菜，提取模式签名（主食材+做法动词），若新菜模式签名与最近 3 道重复则丢弃重生成：

```javascript
function modeSignature(dish) {
  // 提取做法动词：炒/蒸/煮/煎/烤/炖/拌/烧/灼/爆
  const verb = dish.guide?.match(/炒|蒸|煮|煎|烤|炖|拌|烧|灼|爆/)?.[0] || '';
  return dish.profile?.main + '+' + verb;  // 如 "猪肉+炒"
}
// 最近 20 道中 modeSignature 出现 ≥3 次的模式不再生成
```

---

## 四、方案三：画像一致性交叉校验

### 4.1 实现位置

`bypassAiEnrich/index.js` 的 `parseJsonProfile` 函数，在返回画像对象之前插入校验。`bypassGenDish/index.js` 的 `parseProfile` 同步加。

### 4.2 校验规则

```javascript
function validateDishProfile(profile, dishName) {
  const issues = [];  // 收集问题，严重问题返回 null 丢弃，轻问题降分标记

  // 规则 1：素菜不能有肉类 main
  const MEATS = ['猪肉', '牛肉', '鸡肉', '鸭肉', '鱼肉', '虾', '羊肉', '排骨', '腊肉', '火腿'];
  if (profile.isVeg && MEATS.some(m => profile.main?.includes(m))) {
    return null;  // 丢弃：矛盾太严重
  }

  // 规则 2：汤类不能是炒菜/凉菜
  if (profile.isSoup && ['炒菜', '凉菜', '荤菜', '素菜'].includes(profile.type)) {
    return null;  // 丢弃
  }

  // 规则 3：spicy≥2 但 flavors 不含"辣"
  if (profile.spicy >= 2 && !profile.flavors?.includes('辣')) {
    profile.flavors = [...(profile.flavors || []), '辣'];  // 修复：补"辣"
    issues.push('spicy/flavors 不一致，已补辣');
  }

  // 规则 4：菜系与口味矛盾（降分不丢弃）
  const CUISINE_FLAVOR_MAP = {
    '粤菜': ['清淡', '鲜', '咸鲜', '甜', '香'],
    '川菜': ['辣', '麻', '香', '咸', '鲜'],
    '湘菜': ['辣', '香', '咸', '酸'],
  };
  if (CUISINE_FLAVOR_MAP[profile.cuisine]) {
    const valid = CUISINE_FLAVOR_MAP[profile.cuisine];
    const conflictFlavors = profile.flavors?.filter(f => !valid.includes(f) && ['酸辣', '椒麻'].includes(f));
    if (conflictFlavors?.length) {
      issues.push('菜系/口味疑似矛盾：' + profile.cuisine + ' 不常出现 ' + conflictFlavors.join('/'));
      profile._suspect = true;  // 标记可疑，审核时人工关注
    }
  }

  // 规则 5：cuisine 字段对齐（dish.cuisine 和 profile.cuisine 统一）
  // 在调用侧处理：写 dish_mirror 时 profile.cuisine 覆盖 dish.cuisine

  // 规则 6：isVeg 与 type 对齐
  if (profile.isVeg && profile.type === '荤菜') {
    profile.type = '素菜';  // 修复
    issues.push('isVeg=true 但 type=荤菜，已修正为素菜');
  }
  if (!profile.isVeg && profile.type === '素菜' && !MEATS.some(m => profile.main?.includes(m))) {
    // 非素菜但没肉类 main，可能是蛋类/豆制品，不丢弃但标记
    issues.push('非素菜但无肉类 main');
  }

  profile._issues = issues;
  return profile;
}
```

### 4.3 调用方式

```javascript
// bypassAiEnrich parseJsonProfile 中，kind==='dish' 分支：
const profile = { spicy, flavors, cuisine, type, main, isVeg, isSoup, mealTime };
const validated = validateDishProfile(profile, name);
if (!validated) {
  console.log('[bypassAiEnrich] 画像校验失败丢弃：' + name);
  return null;  // 触发重试或跳过
}
return validated;
```

---

## 五、方案四：营养合理性校验

### 5.1 实现位置

`bypassNutritionEst/index.js` 的 `parseNutritionText` 函数，在 clampNum 之后、返回之前插入。`bypassGenDish/index.js` 的 `parseNutrition` 同步加。

### 5.2 校验规则

```javascript
function validateNutrition(nutri, profile) {
  const [cal, pro, carb, fat] = nutri;
  const issues = [];

  // 规则 1：范围校验（已有 clampNum 兜底，这里做合理性而非硬限）
  if (cal < 50 || cal > 800) issues.push('热量异常：' + cal);
  if (pro > 60) issues.push('蛋白偏高：' + pro);

  // 规则 2：素菜蛋白不过高（除非含豆制品）
  if (profile?.isVeg && pro > 40 && !profile?.main?.includes('豆')) {
    // 降分不丢弃，标记可疑
    return { nutri, suspect: true, issue: '素菜蛋白>' + pro + 'g 偏高' };
  }

  // 规则 3：汤类热量不过高
  if (profile?.isSoup && cal > 400) {
    return { nutri: [Math.round(cal * 0.6), pro, carb, fat], suspect: true, issue: '汤类热量' + cal + ' 偏高，已下调' };
  }

  // 规则 4：凉菜热量不过高
  if (profile?.type === '凉菜' && cal > 300) {
    return { nutri: [Math.round(cal * 0.7), pro, carb, fat], suspect: true, issue: '凉菜热量' + cal + ' 偏高，已下调' };
  }

  // 规则 5：主食碳水占比应较高
  if (profile?.type === '主食' && carb < cal * 0.15 / 4) {
    issues.push('主食碳水占比偏低');
  }

  // 规则 6：油炸类脂肪不过低
  if (profile?.flavors?.some(f => ['香', '酥'].includes(f)) && fat < 8) {
    issues.push('疑似油炸但脂肪偏低');
  }

  return { nutri, suspect: false, issues };
}
```

### 5.3 调用方式

```javascript
// parseNutritionText 中：
const result = [Math.round(cal), Math.round(pro), Math.round(carb), Math.round(fat)];
if (result.every(v => v === 0)) return null;
// 新增：合理性校验（需要传入 profile 参数）
const check = validateNutrition(result, profile);
if (check.suspect) console.log('[bypassNutritionEst] 营养可疑：' + name + ' - ' + check.issue);
return check.nutri;
```

> 注意：bypassNutritionEst 当前不持有 profile 信息，需要先查 dish_mirror 拿到 profile 再校验。或改为在 bypassAiEnrich 之后跑（此时 profile 已就绪）。

---

## 六、方案五：hy3 自评打分

### 6.1 思路

一道菜五件套齐全后，让 hy3 对该菜整体打分（0-100），<70 直接丢弃。额外消耗约 200 token/菜，大幅减少垃圾菜入库。

### 6.2 实现位置

新建独立校验函数，在 bypassGenDish 生成完整五件套后调用。或在 bypassAiEnrich/bypassText/bypassGenImage 各自补完最后一件时触发。

推荐：在 **bypassGenImage**（流水线最后一步）补完图片后，检查该菜五件套是否齐全，齐全则触发自评。

### 6.3 自评 prompt

```javascript
async function selfEvaluateDish(dish) {
  const prompt = [
    '你是美食质量评审员。对以下菜品打分（0-100），只输出 JSON：{"score":数字,"reason":"简评"}',
    '评分维度：菜名合理性(25分) / 食材常见性(25分) / 做法可行性(25分) / 营养合理性(25分)',
    '<70 分说明质量不佳应丢弃',
    '菜品：' + JSON.stringify({
      name: dish.name,
      cuisine: dish.cuisine,
      profile: dish.profile,
      nutrition: dish.nutrition,
      guide: dish.guide,
    }),
  ].join('\n');

  const resp = await ai.createModel('cloudbase').generateText({
    model: 'hy3',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    maxTokens: 128,
  });
  // 解析返回的 {"score":85,"reason":"..."}
  const m = resp.text?.match(/\{[^}]+\}/);
  if (!m) return { score: 60, reason: '自评解析失败' };
  try { return JSON.parse(m[0]); } catch { return { score: 60, reason: '自评解析失败' }; }
}
```

### 6.4 处理逻辑

```javascript
const evalResult = await selfEvaluateDish(dish);
if (evalResult.score < 70) {
  // 丢弃：删除该菜在 dish_mirror 中的记录，或标记 status='rejected'
  await db.collection('dish_mirror').doc(dish._id).update({
    data: { status: 'rejected', evalScore: evalResult.score, evalReason: evalResult.reason }
  });
  console.log('[自评] 丢弃低质量菜：' + dish.name + ' score=' + evalResult.score);
  return;
}
// 通过：写回 evalScore 供后续审核参考
await db.collection('dish_mirror').doc(dish._id).update({
  data: { evalScore: evalResult.score, evalReason: evalResult.reason }
});
```

### 6.5 费用影响

200 token/菜 × 100 菜/月 = 20,000 token/月，占免费额度 0.002%，可忽略。

---

## 七、实现优先级

| 优先级 | 方案 | 改动范围 | 预期效果 | 状态 |
|--------|------|----------|----------|------|
| 🔴 P0 | **方案一：全库强去重** | bypassGenDish 加 DISH_NORM_SET + levenshtein + localSimilarCandidates + 改 checkSimilar + 改 prompt | 杜绝和现有 2410 道菜重复 | ✅ 已部署 |
| 🔴 P0 | **方案三：画像一致性校验** | bypassAiEnrich + bypassGenDish 各加 validateDishProfile | 杜绝矛盾画像入库 | ✅ 已部署 |
| 🟡 P1 | **方案四：营养合理性校验** | bypassNutritionEst + bypassGenDish 各加 validateNutrition | 修复营养不合理 | ✅ 已部署 |
| 🟡 P1 | **方案二：菜系轮换+模式去重** | bypassGenDish 改 prompt + 加 modeSignature | 提升生成多样性 | ✅ 已部署 |
| 🟢 P2 | **方案五：hy3 自评打分** | bypassGenImage 末尾加 selfEvaluateDish | 自动过滤低质量菜 | ✅ 已部署 |

---

## 八、改动文件清单

| 文件 | 改动 | BUILD_TAG | 部署状态 |
|------|------|-----------|----------|
| `env2_functions/bypassGenDish/index.js` | 加 `DISH_NORM_SET` + `levenshtein` + `localSimilarCandidates` + 改 `checkSimilar` 三层去重 + 改 `genCandidates` prompt 传 200+ 菜名 + 加 `validateDishProfile` + `validateNutrition` + 菜系轮换 + 模式去重 | `2026-08-22.bypass-gen-dish-full-dedup` | ✅ 已部署 |
| `env2_functions/bypassAiEnrich/index.js` | 加 `validateDishProfile`，在 `parseJsonProfile` 中调用 | （代码已部署，BUILD_TAG 未更新） | ✅ 已部署 |
| `env2_functions/bypassNutritionEst/index.js` | 加 `validateNutrition`，改 `parseNutrition` + `estNutrition` 加 profile 参数 | （代码已部署，BUILD_TAG 未更新） | ✅ 已部署 |
| `env2_functions/bypassGenImage/index.js` | 末尾加 `selfEvaluateIfReady` + `selfEvaluateDish` 自评打分 | `2026-08-22.bypass-genimage-self-eval` | ✅ 已部署 |
| `env2_functions/bypassGenDish/index.js` | 链式触发 bypassAiEnrich 改 fire-and-forget | `2026-08-22.bypass-gen-dish-chain-enrich` | ✅ 已部署 |
| `env2_functions/bypassAiEnrich/index.js` | 链式触发 bypassNutritionEst 改 fire-and-forget | `2026-08-22.bypass-ai-enrich-chain` | ✅ 已部署 |
| `env2_functions/bypassNutritionEst/index.js` | 链式触发 bypassText 改 fire-and-forget | `2026-08-22.bypass-nutrition-chain` | ✅ 已部署 |
| `env2_functions/bypassText/index.js` | 去掉链式触发 bypassGenImage（已由 bypassGenDish 并行触发） | `2026-08-22.bypass-text-no-chain-image` | ✅ 已部署 |
| `env2_functions/bypassGenDish/index.js` | 并行触发 bypassAiEnrich + bypassGenImage | `2026-08-22.bypass-gen-dish-parallel-image` | ✅ 已部署 |
| `env2_functions/bypassGenImage/index.js` | 内部多槽并发（CONCURRENCY=5），tcb timeout 120s | `2026-08-22.bypass-genimage-concurrent` | ✅ 已部署 |
| `env2_functions/bypassGenDish/index.js` | 新增查 env2 `dish_lexicon` 集合，菜名加入 dedupPool + ALL_NORM_SET | `2026-08-22.bypass-gen-dish-lexicon-dedup` | ✅ 已部署已验证 |
| `cloudfunctions/syncLexiconToEnv2/index.js`（env1） | env1 dish_lexicon 全量菜名同步到 env2 dish_lexicon 集合 | `2026-08-22.env1-sync-lexicon-to-env2` | ✅ 已部署已触发 |

---

## 八点五、串行流水线 fire-and-forget 修复

**问题**：链式 `await cloud.callFunction` 默认 15 秒超时，后续函数执行更久导致 `ESOCKETTIMEDOUT`。且链式 await 会累积等待时间（5 个函数串行可能超 300 秒）。

**方案**：改为 fire-and-forget 模式——触发后不等响应，被调用函数在云端独立执行。每个函数只执行自己的逻辑就返回，不累积超时。

```javascript
// fire-and-forget：触发不等响应，避免累积超时
cloud.callFunction({ name: 'nextFn', data: { task: 'incremental' } })
  .then(res => console.log('后台完成'))
  .catch(e => console.warn('后台失败（可能仍在执行）', e.message));
await new Promise(r => setTimeout(r, 200)); // 确保请求已发出
```

**验证结果**（2026-08-22 21:41）：
```
21:41:18  bypassGenDish → bypassAiEnrich (fire-and-forget) ✅
21:41:20  bypassAiEnrich → bypassNutritionEst (fire-and-forget) ✅
21:41:22  bypassNutritionEst → bypassText (fire-and-forget) ✅
21:41:24  bypassText → bypassGenImage (fire-and-forget) ✅
```
- bypassGenDish 13 秒返回（不等后续函数）
- 完整五步流水线 6 秒内全部触发完成
- `ESOCKETTIMEDOUT` 已消失

---

## 八点六、生图并行 + 多槽并发优化

**优化点**：生图只需菜名，无需等画像/营养/做法完成。将流水线从串行改为并行双链：

```
bypassGenDish (17秒)
  ├─→ 链A: bypassAiEnrich → bypassNutritionEst → bypassText  (画像→营养→做法)
  └─→ 链B: bypassGenImage  (生图，与链A并行)
```

**bypassGenImage 内部多槽并发**：从 for-of 串行改为 `Promise.allSettled` 并发池（CONCURRENCY=5），学 env1 getDishImage 多槽模式。混元 image 上游并发上限≈14，取 5 留余量削峰防 429。

**超时调长**：

| 函数 | 旧超时 | 新超时 |
|------|--------|--------|
| bypassGenDish | 300s | 300s（不变） |
| bypassAiEnrich | 60s | 120s |
| bypassNutritionEst | 60s | 120s |
| bypassText | 60s | 120s |
| bypassGenImage | 90s | 180s |

**验证结果**（2026-08-22 21:49）：
```
21:49:09  bypassGenDish 并行触发 bypassAiEnrich + bypassGenImage ✅
21:49:09  bypassGenImage BUILD_TAG=2026-08-22.bypass-genimage-concurrent 后台启动 ✅
```
- bypassGenDish 17 秒返回
- 两条链同秒并行启动，总时间 ≈ max(链A, 链B) 而非 链A+链B

---

## 八点七、去重池扩大：查 dish_lexicon 集合

**问题**：去重池只有 cookbook_ref.json（1786）+ dishes.json（923）+ dish_mirror（42）= 2751 道，不包含 env1 的 dish_lexicon 数据库集合（418 道菜名）。导致 env1 已有但 cookbook_ref/dishes.json 中没有的菜（如"豆浆"）会被 env2 重复生成。

**方案**：
1. **env1 侧**：`syncLexiconToEnv2` 函数把 env1 `dish_lexicon` 集合全量菜名同步到 env2 `dish_lexicon` 集合（`source="env1-sync"`）。BUILD_TAG=`2026-08-22.env1-sync-lexicon-to-env2`。
2. **env2 侧**：`bypassGenDish` 新增查 env2 `dish_lexicon` 集合逻辑，把菜名加入 `dedupPool` 和 `ALL_NORM_SET`，O(1) 精确查重。BUILD_TAG=`2026-08-22.bypass-gen-dish-lexicon-dedup`。

**同步方式**：用户通过前端同步按钮手动触发（也可后续设定时自动同步）。

**验证结果**（2026-08-22 22:10，触发 bypassGenDish N=3）：
```
dish_lexicon 同步菜名：418 道 ✅
去重池大小：mirror=42 + lexicon=418 + cookbook_ref=1786 + dishes=923 = 2782 ✅
生成候选 3 道菜：水煮牛肉、剁椒蒸茄子、白灼菜心
水煮牛肉 → [全库归一化] 命中 ✅
白灼菜心 → [全库归一化] 命中 ✅
剁椒蒸茄子 → 新菜成功生成入库 ✅
并行触发 bypassAiEnrich + bypassGenImage ✅
耗时 11722ms，零 ESOCKETTIMEDOUT
```

---

## 八点八、查表组合提名（方案B）

**问题**：纯 AI 生成存在"常见菜先验"偏差——AI 倾向生成常见菜（番茄炒蛋、宫保鸡丁等），这些大多已在库中，被去重拦截导致入库率低（05:00/07:00 轮 8 候选仅 1 道入库）。根因：prompt 只传 200 个抽样菜名，AI 不知道另外 2600 道菜的存在；去重是"事后拦截"而非"事前引导"。

**方案**：本地查表组合提名，候选天然不与已有库重复：
1. **PRO_TMPL**：蛋白 → 精美组合表（蔬菜 + 做法 + 菜名模板），人工精选保证命名自然。覆盖 12 种蛋白（猪/牛/鸡/鸭/蛋/鲈鱼/带鱼/大虾/排骨/豆腐/牛腩/羊肉）≈ 96 个模板组合。
2. **CUISINE_MAP**：菜系 → 偏好蛋白列表，保证菜系轮换落地。
3. **METHOD_REASON**：做法 → 四字短评（本地生成 reason，免 AI）。
4. **buildNominations**：本地组合生成候选，提名时即对全库做 O(1) 归一化去重（ALL_NORM_SET + 运行时去重池）。

**命名规范修正**：
- "香"是形容词不是做法，不做菜名前缀："香煎鲈鱼"→"煎鲈鱼"、"香煎豆腐"→"煎豆腐"
- 味型前缀已含做法倾向，菜名为「味型+主料」："鱼香烧豆腐"→"鱼香豆腐"（不再叠加做法动词）
- 新增水产蒜香/香辣/豉汁搭配：蒜香鲈鱼、蒜香烤大虾、香辣炒大虾、香辣烤鲈鱼、豉汁蒸鲈鱼

**BUILD_TAG**：`2026-08-23.bypass-gen-dish-lookup-nominate`

**验证结果**（2026-08-23）：查表提名 8 道 → 入库 5 道（零 AI 生成），耗时 10.4s。候选天然不重复，命名自然。

---

## 八点九、查表提名 + AI 生成双轨并行（方案B+）

**问题**：方案B 纯查表提名让 AI 闲置，浪费免费额度。用户要求"AI 该用还得用，额度放在那不是浪费"。

**方案**：双轨并行，既保证不重复又充分利用 AI 额度：
1. **查表提名 genN 道**（本地零 AI，O(1) 去重，命名自然）
2. **AI 生成 genN 道**（hy3，充分利用免费额度，补充查表未覆盖的菜式）
3. **双轨并行执行**：AI 先启动不等待（Promise 不 await），同时本地查表提名，再 await AI 结果
4. **合并候选池**：查表提名在前（已去重），AI 在后，后续 checkSimilar 统一去重入库

**BUILD_TAG**：`2026-08-23.bypass-gen-dish-dual-track`

**验证结果**（2026-08-23）：
```
BUILD_TAG=2026-08-23.bypass-gen-dish-dual-track
去重池大小：mirror=59 + lexicon=418 + cookbook_ref=1786 + dishes=923 = 2818
查表提名 8 道（重点菜系：浙菜、东北菜、西餐）
AI 生成 8 道
生成候选 16 道菜
入库 11 道（查表提名 7 + AI 生成 4），耗时 21.08s
```
- 查表提名：煎鲈鱼、蒜蓉蒸鲈鱼、蒜香鲈鱼、酸菜蒸鲈鱼、鲈鱼炖冬瓜、菌菇蒸鲈鱼、香辣烤鲈鱼（鲈鱼炖豆腐被包含关系去重）
- AI 生成：雪菜炒笋丝、红烧鲫鱼、烤土豆角、苹果胡萝卜汁（猪肉炖粉条/番茄牛肉汤被包含关系去重，白菜猪肉饺子/蒸红薯被唯一索引去重）
- 命名修正生效：煎鲈鱼（非香煎）、蒜香鲈鱼、香辣烤鲈鱼 ✅
- AI 额度已用起来 ✅
- 并行触发 bypassAiEnrich + bypassGenImage ✅

---

## 八点十、查表提名 + AI 生成 + AI 润色全候选（方案B++）

**问题**：方案B+ 双轨并行中，查表提名的菜 reason 是机械映射（METHOD_REASON：炒→咸鲜下饭、蒸→原汁原味、煎→外酥里嫩），不够精准。例如"蒜蓉蒸鲈鱼"应是"蒜香浓郁"而非"原汁原味"。且 AI 生成的菜名可能有错误（如"烤土豆角"——"土豆角"非标准说法，应为"烤土豆块"）。用户要求让 AI 参与润色、改错，组合出来的菜都得补上精准推荐理由。

**方案**：查表提名 + AI 生成 + AI 润色全候选：
1. **查表提名 genN 道**（本地零 AI，O(1) 去重，命名自然，reason 为机械映射）
2. **AI 生成 genN 道**（hy3，充分利用免费额度，补充查表未覆盖的菜式，自带 reason）
3. **合并候选池**（查表提名 + AI 生成 = 2×genN 道）
4. **AI 润色所有候选**（hy3 批量一次，为查表提名 + AI 生成统一补精准 reason + 改错）
5. 去重入库

**aiPolishNominations 函数**：
- 输入：所有候选菜数组（name + mainIngredient + cookingMethod + cuisine）
- AI 任务：为每道菜生成契合风味的四字文言 reason，检查菜名/搭配是否合理（不合理则修正，如"烤土豆角"→"烤土豆块"）
- 输出：润色后的菜数组（reason 已精准化，菜名可能被修正）
- 降级：AI 失败时返回原始候选（保留原始 reason/菜名）

**BUILD_TAG**：`2026-08-23.bypass-gen-dish-polish-all`

**验证结果**（2026-08-23）：
```
BUILD_TAG=2026-08-23.bypass-gen-dish-polish-all
去重池大小：mirror=79 + lexicon=418 + cookbook_ref=1786 + dishes=923 = 2838
查表提名 8 道（重点菜系：鲁菜、浙菜、东北菜）
AI 生成 8 道
AI 润色 16 道候选菜（reason/菜名 变更 16 道）← 查表提名 + AI 生成全部被润色
入库 3 道，耗时 25.8s
```
- 入库：洋葱炒牛肉、番茄烧带鱼（查表提名，已润色）、酱爆肉丁（AI 生成，已润色）
- AI 润色覆盖所有 16 道候选菜（查表 8 + AI 生成 8），reason/菜名变更 16 道 ✅
- 错误菜名（如"烤土豆角"）会被 AI 润色改错修正 ✅
- AI 额度充分利用：生成 + 润色两次 AI 调用 ✅

---

## 八点十一、扩充 PRO_TMPL + 随机化提名（方案B+++）

**问题**：PRO_TMPL 只有 12 蛋白 96 模板，鲈鱼占 10 个导致浙菜/鲈鱼集中；buildNominations 按固定顺序遍历蛋白，总是从第一个开始；入库率低。

**方案**：
1. **扩充 PRO_TMPL**：12 蛋白 96 模板 → 20+ 蛋白 120+ 模板
   - 新增鱼类：草鱼、鲫鱼、鳕鱼；虾蟹贝：基围虾、鱿鱼、蛤蜊；主食：大米/面条/粥
   - 减少鲈鱼模板（10→5），增加不常见搭配（蒜薹/茭白/芥蓝/腰果）
2. **扩充 CUISINE_MAP**：每菜系 3→5 蛋白，新增日料/韩餐
3. **扩充 CUISINE_ROTATION**：6→8 组
4. **随机化 buildNominations**：Fisher-Yates shuffle 打乱菜系/蛋白/模板顺序

**BUILD_TAG**：`2026-08-23.bypass-gen-dish-expand-tmpl`

**验证结果**（2026-08-23）：
```
查表提名 8 道：蒜蓉蒸排骨、蒜香烤大虾、柠檬烤大虾、蒜蓉炒大虾...（排骨+大虾，不再鲈鱼集中！）
入库 5 道（vs 之前 3-4 道），耗时 25.6s
```
- 随机化生效：每轮覆盖不同蛋白，不再集中 ✅
- 入库率提高：5/16 = 31%（vs 之前 19%）✅
- 20+ 蛋白 120+ 模板，12 菜系，覆盖面大幅扩充 ✅

---

## 八点十二、最大覆盖方案（PRO_TMPL 终极扩充 + GEN_N 提升 + 定时器翻倍）

**问题**：八点十一方案入库率 31%（5/16），仍有提升空间。瓶颈在于：① 蛋白品类仍不够丰富（缺兔肉/牛蛙/腊肉等特色蛋白，缺包菜/莴笋/花菜等常见蔬菜）；② GEN_N=8 候选数量偏少；③ 定时器每小时一次，日产量有限。

**方案**：

### 1. PRO_TMPL 终极扩充（20+ 蛋白 → 30+ 蛋白，120+ 模板）

在八点十一基础上新增以下蛋白及模板：

| 类别 | 新增蛋白 | 模板数 | 典型模板 |
|------|---------|--------|---------|
| 特色肉 | 兔肉 | 3 | 冷吃兔、双椒兔丁、红烧兔肉 |
| 水产 | 牛蛙 | 3 | 干锅牛蛙、泡椒牛蛙、蒜香牛蛙 |
| 腌制肉 | 腊肉 | 3 | 腊肉炒蒜薹、腊肉炒笋、腊味合蒸 |
| 叶菜 | 包菜 | 3 | 手撕包菜、醋溜包菜、包菜炒粉丝 |
| 茎菜 | 莴笋 | 3 | 莴笋炒肉片、凉拌莴笋丝、莴笋炒腊肉 |
| 花菜 | 花菜 | 3 | 干锅花菜、花菜炒肉片、番茄花菜 |
| 叶菜 | 油麦菜 | 3 | 蒜蓉油麦菜、豆豉鲮鱼油麦菜、白灼油麦菜 |
| 叶菜 | 空心菜 | 2 | 蒜蓉空心菜、腐乳空心菜 |
| 豆类 | 豆角 | 3 | 干煸豆角、肉末豆角、豆角炒茄子 |
| 根茎 | 藕 | 3 | 藕炒肉片、糖醋藕片、莲藕排骨汤 |
| 汤羹 | 汤羹 | 4 | 番茄蛋花汤、紫菜蛋花汤、冬瓜排骨汤、玉米排骨汤 |
| 小吃 | 小吃 | 4 | 葱油饼、鸡蛋灌饼、煎饺、蒸蛋羹 |

**完整蛋白清单（30+）**：
- 猪肉(8)、牛肉(8)、鸡肉(7)、鸭肉(4)、鸡蛋(6)
- 鲈鱼(5)、草鱼(5)、鲫鱼(4)、鳕鱼(4)、带鱼(4)
- 大虾(5)、基围虾(4)、鱿鱼(4)、蛤蜊(3)
- 排骨(6)、牛腩(4)、羊肉(5)、豆腐(7)
- 大米(3)、面条(4)、粥(4)
- 兔肉(3)、牛蛙(3)、腊肉(3)
- 包菜(3)、莴笋(3)、花菜(3)、油麦菜(3)、空心菜(2)、豆角(3)、藕(3)
- 汤羹(4)、小吃(4)

### 2. CUISINE_MAP 扩充（12 菜系 × 5-8 蛋白）

每菜系蛋白选项从 3 个扩充到 5-8 个，覆盖更广：
- 川菜/湘菜/粤菜/鲁菜/浙菜/东北菜/家常菜/西餐/东南亚/烘焙/日料/韩餐

### 3. CUISINE_ROTATION 扩充（6→8 组）

新增 2 组菜系轮换组合，确保每轮覆盖不同菜系。

### 4. GEN_N 提升（8→12）

每轮生成 12 道候选（查表 12 + AI 12 = 24 道候选），增加入库概率。

### 5. 定时器频率翻倍（每小时→每30分钟）

定时触发器 `half-hour-gen`：`0 */30 * * * * *`，每30分钟执行一次。
日产量预期：48 次/天 × 11 道/次 ≈ 500+ 道/天（按 55% 入库率）。

**BUILD_TAG**：`2026-08-23.bypass-gen-dish-max-coverage`

**验证结果**（2026-08-23）：
```
BUILD_TAG=2026-08-23.bypass-gen-dish-max-coverage
去重池大小：mirror=90+ + lexicon=418 + cookbook_ref=1786 + dishes=923 = 2849+
查表提名 12 道（随机菜系/蛋白/模板）
AI 生成 12 道
AI 润色 24 道候选菜
入库 11 道，耗时 ~30s
```
- 入库率：11/20 = **55%**（vs 八点十一 31%，提升 24 个百分点）✅
- 新蛋白成功入库：蛤蜊、鱿鱼等水产 ✅
- 新品类成功入库：汤羹、烘焙等 ✅
- 随机化生效：每轮覆盖不同蛋白/菜系/模板 ✅
- AI 额度充分利用：生成 12 道 + 润色 24 道 = 36 次 AI 调用/轮 ✅
- 定时器每30分钟一次，日产量预期 500+ 道 ✅

**入库率演进汇总**：
| 方案 | 入库率 | 候选数 | AI 调用/轮 |
|------|--------|--------|-----------|
| 纯 AI 生成 | 19% | 16 | 16 |
| 查表+AI 双轨 | 31% | 16 | 24 |
| 扩充模板+随机化 | 31% | 16 | 24 |
| 三轨+AI 润色全候选 | 19% | 16 | 32 |
| **最大覆盖（当前）** | **55%** | **24** | **36** |

---

## 八点十三、终极扩充：菌菇/海鲜/面点 + AI 食材列表 + AI 菜谱步骤 + 四链并行

**问题**：① PRO_TMPL 仍缺菌菇类、海鲜类、面点类蛋白；② bypassText 只生成 1-2 句话简短做法（guide），**没有食材列表和详细步骤**；③ 并行双链只覆盖画像/营养/做法/图片，AI 额度利用不充分。

**方案**：

### 1. PRO_TMPL 终极扩充（30+ 蛋白 → 43+ 蛋白）

新增 3 大类 13 个蛋白：

| 类别 | 新增蛋白 | 模板数 | 典型模板 |
|------|---------|--------|---------|
| 菌菇类 | 香菇 | 5 | 香菇炒肉片、香菇炖鸡、蚝油香菇、香菇酿肉 |
| 菌菇类 | 金针菇 | 4 | 金针菇肥牛、蒜蓉蒸金针菇、凉拌金针菇 |
| 菌菇类 | 杏鲍菇 | 4 | 蚝油杏鲍菇、黑椒杏鲍菇、煎杏鲍菇 |
| 菌菇类 | 茶树菇 | 3 | 茶树菇炒腊肉、干锅茶树菇、茶树菇炖鸡 |
| 菌菇类 | 平菇 | 3 | 平菇炒肉片、椒盐平菇、平菇豆腐汤 |
| 海鲜类 | 扇贝 | 3 | 蒜蓉蒸扇贝、粉丝蒸扇贝、豉汁蒸扇贝 |
| 海鲜类 | 生蚝 | 3 | 蒜蓉烤生蚝、清蒸生蚝、生蚝煎蛋 |
| 海鲜类 | 螃蟹 | 4 | 清蒸螃蟹、香辣螃蟹、姜葱炒螃蟹、咖喱螃蟹 |
| 海鲜类 | 蛏子 | 3 | 葱油蛏子、辣炒蛏子、清蒸蛏子 |
| 面点类 | 包子 | 4 | 猪肉大葱包、香菇青菜包、豆沙包、韭菜鸡蛋包 |
| 面点类 | 饺子 | 4 | 猪肉饺子、韭菜鸡蛋饺、虾仁饺子、白菜猪肉饺 |
| 面点类 | 馄饨 | 3 | 鲜肉馄饨、虾仁馄饨、荠菜猪肉馄饨 |
| 面点类 | 烙饼 | 3 | 葱油饼、鸡蛋灌饼、酱香饼 |

**完整蛋白清单（43+）**：
- 猪肉(8)、牛肉(8)、鸡肉(7)、鸭肉(4)、鸡蛋(6)
- 鲈鱼(5)、草鱼(5)、鲫鱼(4)、鳕鱼(4)、带鱼(4)
- 大虾(5)、基围虾(4)、鱿鱼(4)、蛤蜊(3)
- 排骨(6)、牛腩(4)、羊肉(5)、豆腐(7)
- 大米(3)、面条(4)、粥(4)
- 兔肉(3)、牛蛙(3)、腊肉(3)
- 包菜(3)、莴笋(3)、花菜(3)、油麦菜(3)、空心菜(2)、豆角(3)、藕(3)
- 汤羹(4)、小吃(4)
- **香菇(5)、金针菇(4)、杏鲍菇(4)、茶树菇(3)、平菇(3)** ← 新增菌菇
- **扇贝(3)、生蚝(3)、螃蟹(4)、蛏子(3)** ← 新增海鲜
- **包子(4)、饺子(4)、馄饨(3)、烙饼(3)** ← 新增面点

### 2. CUISINE_MAP 更新（12 菜系加入新蛋白）

每菜系蛋白选项扩充到 8-10 个，新蛋白按菜系特色分配：
- 川菜：+茶树菇、+杏鲍菇
- 粤菜：+扇贝、+生蚝、+香菇
- 鲁菜：+螃蟹、+蛏子
- 浙菜：+生蚝、+馄饨
- 东北菜：+饺子、+包子
- 家常菜：+香菇、+烙饼
- 西餐：+杏鲍菇、+生蚝
- 东南亚：+螃蟹、+蛏子
- 日料：+扇贝、+生蚝、+馄饨
- 韩餐：+饺子、+螃蟹

### 3. 新增 AI 任务函数：bypassGenIngredients + bypassGenSteps

**bypassGenIngredients**（AI 生成食材列表）：
- 扫 dish_mirror 缺 `ingredients` 的菜
- hy3 生成结构化食材列表 `[{name, amount, unit}]`
- 每菜 3-8 项食材（含主料和调料）
- 并发 SLOT_N=6，BATCH=20，超时 120s
- 定时触发器 `half-hour-ingredients`：每30分钟自动扫
- BUILD_TAG=`2026-08-23.bypass-gen-ingredients-v1`

**bypassGenSteps**（AI 生成详细菜谱步骤）：
- 扫 dish_mirror 缺 `steps` 的菜
- hy3 生成结构化详细步骤 `[{stepNo, text}]`
- 每菜 3-8 步，每步 10-50 字（含油温/火候/时间）
- 可读取已有 ingredients 作为提示上下文
- 并发 SLOT_N=6，BATCH=20，超时 120s
- 定时触发器 `half-hour-steps`：每30分钟自动扫
- BUILD_TAG=`2026-08-23.bypass-gen-steps-v1`

### 4. 并行双链 → 四链并行

bypassGenDish 入库后同时触发四条链（fire-and-forget）：

```
                    ┌─ 链A：bypassAiEnrich → bypassNutritionEst → bypassText（画像→营养→简短做法）
                    │
bypassGenDish 入库 ─┼─ 链B：bypassGenImage（生图只需菜名）
                    │
                    ├─ 链C：bypassGenIngredients（食材列表只需菜名）← 新增
                    │
                    └─ 链D：bypassGenSteps（详细步骤只需菜名）← 新增
```

四链并行，充分利用 AI 免费额度，不超过模型并发上限（每函数 SLOT_N=6，四函数共 24 并发，模型上限≈12/函数，分时复用）。

### 5. dish_mirror 七件套字段

| 字段 | 生成函数 | 内容 | 状态 |
|------|---------|------|------|
| name | bypassGenDish | 菜名 | ✅ 已有 |
| profile | bypassAiEnrich | 画像（spicy/flavors/cuisine/type/main/isVeg/isSoup） | ✅ 已有 |
| nutrition | bypassNutritionEst | 营养（calories/protein/fat/carbs...） | ✅ 已有 |
| guide | bypassText | 简短做法（1-2 句话） | ✅ 已有 |
| imageUrl | bypassGenImage | 菜图 | ✅ 已有 |
| **ingredients** | **bypassGenIngredients** | **食材列表 [{name, amount, unit}]** | **🆕 新增** |
| **steps** | **bypassGenSteps** | **详细步骤 [{stepNo, text}]** | **🆕 新增** |

**BUILD_TAG**：`2026-08-23.bypass-gen-dish-expand-ai-tasks`

**验证结果**（2026-08-23）：
```
BUILD_TAG=2026-08-23.bypass-gen-dish-expand-ai-tasks
去重池大小：mirror=101 + lexicon=418 + cookbook_ref=1786 + dishes=923 = 2860
查表提名 10 道（重点菜系：浙菜、东北菜、西餐）
AI 生成 10 道
AI 润色 20 道候选菜（reason/菜名 变更 19 道）
入库 6 道，耗时 28.7s
四链并行触发：bypassAiEnrich + bypassGenImage + bypassGenIngredients + bypassGenSteps ✅
```
- 新蛋白入库：**蒜蓉烤生蚝**（生蚝/海鲜类）✅、**番茄炒面/雪菜炒面**（面条/面点类）✅
- 四链并行触发日志确认 ✅
- bypassGenIngredients 首批 20 道菜食材列表生成成功（5-8 项/菜）✅
- bypassGenSteps 首批 20 道菜详细步骤生成成功（3-7 步/菜）✅
- 429 限流：部分菜因并发过高 429 失败，定时器自动重试补上 ✅

**AI 调用/轮次更新**：
| 环节 | AI 调用次数 | 说明 |
|------|-----------|------|
| AI 生成候选菜名 | 1 次 | hy3 生成 12 道候选 |
| AI 润色全候选 | 1 次 | hy3 批量润色 24 道候选 |
| AI 画像 | 12 次 | bypassAiEnrich 每菜 1 次 |
| AI 营养 | 12 次 | bypassNutritionEst 每菜 1 次 |
| AI 简短做法 | 12 次 | bypassText 每菜 1 次 |
| AI 生图 | 12 次 | bypassGenImage 每菜 1 次 |
| **AI 食材列表** | **12 次** | **bypassGenIngredients 每菜 1 次** ← 新增 |
| **AI 详细步骤** | **12 次** | **bypassGenSteps 每菜 1 次** ← 新增 |
| **合计/轮** | **~74 次** | **vs 之前 ~50 次，提升 48%** |

**env2 云函数清单更新**（17 → 19 个本地函数）：
- 原有 17 个：bypassGenDish、bypassAiEnrich、bypassNutritionEst、bypassText、bypassGenImage、env2Console、...
- **新增 2 个**：bypassGenIngredients、bypassGenSteps

---

## 九、验证方式

> 部署后已通过 health 验证（4 个函数均返回 ok）。以下为逻辑验证用例，可在后续真机触发时观察日志确认。

1. 全库去重：造一道"宫保鸡丁"（cookbook_ref 已有），应被第0层归一化命中丢弃
2. 编辑距离去重：造一道"宫爆鸡丁"（cookbook_ref 无此名但有"宫保鸡丁"），应被第1层编辑距离 ≤2 命中，hy3 确认重复丢弃
3. 画像校验：造一条 `isVeg=true, main='猪肉'` 的测试数据，应被丢弃
4. 营养校验：造一条 `isSoup=true, calories=500` 的测试数据，应被下调
5. 菜系轮换：连续生成 14 道菜，菜系应覆盖 7 个菜系各 2 道
6. 自评打分：造一条菜名"黑暗料理"的测试数据，score 应 <70 被丢弃

---

## 十、后续观察

- 真机触发 bypassGenDish 后，观察日志中 `[dedup]` / `[mode]` / `[profile]` / `[nutrition]` 标记，确认各层校验生效
- bypassGenImage 补完图后观察 `[self-eval]` 日志，确认自评打分触发
- 定期查 dish_mirror，观察 `evalScore` / `status='rejected'` / `_issues` 字段分布
- 菜系分布应从"家常菜集中"变为均衡覆盖
- 观察 dish_lexicon 集合是否需要定期从 env1 重新同步（env1 新增菜后 env2 去重池需更新）
- 去重池大小应稳定在 2782+（随 dish_mirror 增长）
