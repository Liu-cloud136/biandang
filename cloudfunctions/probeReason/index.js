const tcb = require('@cloudbase/node-sdk');
const app = tcb.init({ env: process.env.TCB_ENV || 'your-env-id-1', timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');

function cnCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 19968 && c <= 40959) n++;
  }
  return n;
}

// 精简 prompt：聚焦「主出文内联 reason」是否天然恰 4 中文字（B 探针核心）
function buildMini(scene) {
  return '你是家常菜推荐助手。请为场景「' + scene + '」推荐 3 道菜（dishes）、2 个主食（staples）、1 个配饮（drinks）。\n' +
    '硬性要求：\n' +
    '1. 每道菜品必须含字段 name、cuisine、reason；主食 staples 含 name、reason；配饮 drinks 含 name、reason、cat。\n' +
    '2. reason 用文言文体写一句推荐短评，严格恰好 4 个中文字符，文言语气凝练典雅，严禁风味方向词作主语，须契合自身风味，禁止复述菜名、禁止现代口语套话、禁止提及其他具体菜品。\n' +
    '3. dishes 每道带 cuisine（如川菜），staples 与 drinks 不带 cuisine。\n' +
    '4. 只输出 JSON，格式 {"groups":[{"scene":"' + scene + '","dishes":[{"name":"菜名","cuisine":"川菜","reason":"四字文言"}],"staples":[{"name":"主食名","reason":"四字文言"}],"drinks":[{"name":"配饮名","reason":"四字文言","cat":""}]}]}，不要任何额外说明。';
}

function pickText(resp) {
  if (resp && resp.text) return resp.text;
  try { return resp.data.choices[0].message.content; } catch (e) { return ''; }
}

function parse(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) { return null; }
}

async function runOnce(scene) {
  const messages = [{ role: 'user', content: buildMini(scene) }];
  const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 1.0, topP: 0.9 });
  const text = pickText(resp);
  const obj = parse(text);
  const reasons = [];
  if (obj && Array.isArray(obj.groups)) {
    for (const g of obj.groups) {
      (g.dishes || []).forEach(d => reasons.push(d.reason || ''));
      (g.staples || []).forEach(s => reasons.push(s.reason || ''));
      (g.drinks || []).forEach(d => reasons.push(d.reason || ''));
    }
  }
  return reasons;
}

exports.main = async (event) => {
  const scene = (event && event.scene) || '午餐';
  // 直调有 3s 工具超时，单次出文 ~1-2s，故每次只跑 1 轮，由调用方多次直调凑样本
  try {
    const rs = await runOnce(scene);
    const dist = {};
    let ok = 0;
    for (const r of rs) {
      const c = cnCount(r);
      dist[c] = (dist[c] || 0) + 1;
      if (c === 4) ok++;
    }
    return { scene, totalReasons: rs.length, exact4: ok, rate4: rs.length ? (ok / rs.length).toFixed(3) : '0', dist, reasons: rs };
  } catch (e) {
    return { scene, error: String(e && e.message || e) };
  }
};
