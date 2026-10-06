// ============================================================================
// parseKit · env2 统一 AI 文本解析工具（共享真源，部署时复制进各函数目录）
// BUILD_TAG: 2026-08-25.parsekit-v1
//
// 职责（统一"解析层"，消除各函数各自为战的脆弱解析）：
//   1. extractJsonObject(text)  —— 从 hy3 可能夹带的解释/代码块中稳健抽取 JSON 对象
//   2. extractJsonArray(text)   —— 同上，针对数组
//   3. extractListItems(text)   —— 步骤/食材类「列表」兜底切分：
//        优先按 JSON 数组解析；失败则按「编号行 / 分段 / 换行」切出条目，
//        每条尝试再解析为 {stepNo,text} / {name,amount,unit}，尽力不丢。
//   4. hitBadWords(text, list)  —— 黑名单命中校验（返回命中的词或 null）
//   5. 所有解析失败时，调用方应把 rawText 写入 bypass_log（可观测，不幻觉补全）。
//
// 设计纪律（遵循 R-Doc-01 修复纪律锁）：
//   - 本模块只做「提取 + 结构化 + 校验」，绝不臆造缺失字段、不补默认值掩盖问题；
//   - 解析失败一律返回 null，并把原始 hy3 文本交回调用方落库诊断。
// ============================================================================

// ── 1. JSON 对象提取 ────────────────────────────────────────────────────────
function extractJsonObject(text) {
  if (!text) return null;
  let t = String(text).trim();

  // 去 markdown 代码围栏 ```json ... ``` 或 ``` ... ```
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // 找首个 { 到最后一个 } 的外壳
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = t.slice(start, end + 1);

  try {
    const o = JSON.parse(candidate);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch (e) { /* 尝试下面更宽松的修复 */ }

  // 宽松修复：常见于 hy3 在 key/字符串值上加了中文引号或单引号、尾随逗号
  const repaired = repairJson(candidate);
  if (repaired) {
    try {
      const o = JSON.parse(repaired);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (e2) { /* fallthrough */ }
  }
  return null;
}

// ── 2. JSON 数组提取 ────────────────────────────────────────────────────────
function extractJsonArray(text) {
  if (!text) return null;
  let t = String(text).trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const candidate = t.slice(start, end + 1);

  try {
    const arr = JSON.parse(candidate);
    if (Array.isArray(arr)) return arr;
  } catch (e) { /* 尝试修复 */ }

  const repaired = repairJson(candidate);
  if (repaired) {
    try {
      const arr = JSON.parse(repaired);
      if (Array.isArray(arr)) return arr;
    } catch (e2) { /* fallthrough */ }
  }
  return null;
}

// ── 3. 列表项兜底切分（步骤/食材通用）──────────────────────────────────────
// 目标：即使 hy3 没严格返回 JSON 数组，也能从「编号列表 / 分段 / 换行」里
//       尽力切出条目，每条归一为 {stepNo, text}（步骤）或 {name, amount, unit}（食材）。
// 返回 { items, source }：source='json' | 'heuristic'，调用方可据以判断是否需要重生成。
function extractListItems(text, kind) {
  if (!text) return { items: null, source: 'empty' };
  const arr = extractJsonArray(text);
  if (Array.isArray(arr) && arr.length) {
    const items = normalizeItems(arr, kind);
    if (items && items.length) return { items, source: 'json' };
  }

  // 启发式兜底：从自由文本切分
  const items = heuristicSplit(text, kind);
  if (items && items.length) return { items, source: 'heuristic' };
  return { items: null, source: 'none' };
}

// 把 hy3 返回的任意数组项归一为统一结构
function normalizeItems(arr, kind) {
  if (kind === 'ingredient') {
    const out = [];
    for (const item of arr) {
      if (!item) continue;
      const name = String(item.name || item.食材 || item.名称 || '').trim();
      if (!name) continue;
      let amount = String(item.amount || item.用量 || item.数量 || '').trim().slice(0, 10);
      let unit = String(item.unit || item.单位 || '').trim().slice(0, 10);
      out.push({ name: name.slice(0, 20), amount, unit });
    }
    return out.length ? out : null;
  }
  // 默认按步骤归一
  const out = [];
  arr.forEach((item, i) => {
    if (!item) return;
    let text = item.text || item.步骤 || item.desc || item.description || '';
    if (typeof text !== 'string') text = String(text || '');
    text = text.trim();
    if (!text) return;
    const stepNo = Number(item.stepNo || item.步号 || item.no) || (i + 1);
    out.push({ stepNo, text: text.slice(0, 100) });
  });
  return out.length ? out : null;
}

// 启发式切分：识别「1. / 1、/ 1） / 一、 / 第一步 / 换行分段」等
function heuristicSplit(text, kind) {
  let t = String(text).trim();
  // 去代码围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // 行级切分：按编号前缀
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const numbered = lines.filter(l => /^(\d+[.、)）]|[一二三四五六七八九十]+[.、、]?|[第]?\s*[一二三四五六七八九十\d]+\s*[步、.、])/.test(l));

  let rawItems;
  if (numbered.length >= 2) {
    rawItems = numbered;
  } else if (lines.length >= 2) {
    rawItems = lines; // 退化为逐行
  } else {
    // 单段：按句号/分号切
    rawItems = t.split(/[。；;]/).map(s => s.trim()).filter(s => s.length > 2);
  }

  const out = [];
  rawItems.forEach((line, i) => {
    // 剥掉行首编号
    const cleaned = line.replace(/^(\d+[.、)）\s]*|[一二三四五六七八九十]+[.、、\s]*|[第]?\s*[一二三四五六七八九十\d]+\s*[步、.、\s]*)/, '').trim();
    if (!cleaned) return;
    if (kind === 'ingredient') {
      // 食材行形如「鸡肉 200克」或「盐 适量」
      const m = cleaned.match(/^(.{1,20})[\s:：]+([^]*)?$/);
      const name = m ? m[1].trim() : cleaned.slice(0, 20);
      const rest = m ? m[2].trim() : '';
      let amount = '', unit = '';
      const um = rest.match(/([\d.]+|[适量少许少量些许适当]+)\s*(克|毫升|个|勺|汤匙|茶匙|片|根|瓣|把|份|杯)?/);
      if (um) { amount = um[1]; unit = um[2] || ''; }
      out.push({ name: name.slice(0, 20), amount: amount.slice(0, 10), unit: unit.slice(0, 10) });
    } else {
      out.push({ stepNo: i + 1, text: cleaned.slice(0, 100) });
    }
  });
  return out.length ? out : null;
}

// ── 4. 黑名单校验 ──────────────────────────────────────────────────────────
function hitBadWords(text, list) {
  if (!text || !Array.isArray(list)) return null;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  for (const w of list) {
    if (w && s.includes(w)) return w;
  }
  return null;
}

// ── 5. JSON 宽松修复（中文引号/单引号/尾逗号/hy3 双冒号 glitch）──────────────
// 2026-09-12 补两级（丝瓜炒鸡肉实锤：hy3 在 temp 0.3 下 100% 吐 "amount"::"3瓣"）：
//   ④ 键值完成后多余冒号  "k"::"v" → "k":"v"
//   ⑤ 空串值后紧跟新值    "k":"" :"v" → "k":"v"
function repairJson(str) {
  if (!str) return null;
  let s = str;
  // 中文引号 → 双引号
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // 单引号键/值 → 双引号（粗略：仅处理键名与字符串值）
  s = s.replace(/(\s*['"]?)(\w+)(['"]?\s*):/g, '"$2":');
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  // 去尾部逗号（对象/数组内）
  s = s.replace(/,(\s*[}\]])/g, '$1');
  // 键值完成后多余冒号（hy3 glitch ④）
  s = s.replace(/"\s*:\s*:/g, '":');
  // 空串值后紧跟新值（hy3 glitch ⑤）
  s = s.replace(/""\s*:\s*"/g, '"');
  // 去 BOM / 零宽
  s = s.replace(/﻿/g, '');
  return s;
}

module.exports = {
  extractJsonObject,
  extractJsonArray,
  extractListItems,
  normalizeItems,
  hitBadWords,
  repairJson,
};
