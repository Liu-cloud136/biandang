// fixReasonInEnv2 · env2 侧用 AI 补全 env1 菜品 reason 并跨账号写回
// 跨账号读 env1 dish_lexicon → 调 env2 AI 生成 4 字文言 → 跨账号写回 env1
// 真机链路才能跨账号（手动触发 / env2Console 调用）
const BUILD_TAG = '2026-08-22.env2-fix-reason.v2';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');

const ENV1_APPID = 'wx0000000000000000';
const ENV1_ENV_ID = process.env.ENV1_ENV_ID || '';

// 2026-09-12：hy3 偶发吐畸形 JSON（实锤 "amount"::"3瓣" 双冒号）→ 解析失败走三级修复梯
function jsonParseRepair(s) {
  try { return JSON.parse(s); } catch (e) { /* 修复梯 */ }
  let r = String(s).replace(/,(\s*[}\]])/g, '$1');   // ① 收尾逗号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/"\s*:\s*:/g, '":');                 // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/""\s*:\s*"/g, '"');                 // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e) { return null; }
}

function capReason4(s) {
  s = (s == null ? '' : String(s)).trim();
  if (!s) return '';
  let cn = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 19968 && c <= 40959) cn++;
  }
  if (cn < 4) return '';
  if (cn === 4) return s;
  let count = 0, res = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isCn = (code >= 19968 && code <= 40959);
    if (isCn) count++;
    res += s.charAt(i);
    if (count >= 4) break;
  }
  return res;
}

const POOL_REASONS = new Set(['鲜香味美', '肥而不腻', '入口即化', '嫩滑鲜香', '清鲜爽口', '温润甘淡', '开胃解腻', '喷香诱人', '清香怡人', '粒粒喷香', '温润软糯', '筋道爽滑', '入口绵柔', '清香软糯', '热气腾腾', '晶莹剔透', '软糯弹牙']);

function isOldReason(doc) {
  if (!doc || typeof doc !== 'object') return true;
  if (doc.reasonFixed === true) return false;
  const reason = doc.reason;
  if (!reason || typeof reason !== 'string') return true;
  const r = reason.trim();
  if (!r) return true;
  if (r.startsWith('env2 AI 新菜')) return true;
  if (POOL_REASONS.has(r)) return true;
  let cn = 0;
  for (let i = 0; i < r.length; i++) {
    const c = r.charCodeAt(i);
    if (c >= 19968 && c <= 40959) cn++;
  }
  if (cn !== 4) return true;
  return false;
}

exports.main = async (event, context) => {
  console.log('[build] fixReasonInEnv2 BUILD_TAG=' + BUILD_TAG);
  if (!ENV1_ENV_ID) return { ok: false, err: 'ENV1_ENV_ID 未配置' };

  let inst1, c1;
  try {
    inst1 = new cloud.Cloud({ resourceAppid: ENV1_APPID, resourceEnv: ENV1_ENV_ID });
    await inst1.init();
    c1 = inst1.database();
  } catch (e) { return { ok: false, err: '跨账号 init 失败：' + ((e && e.message) || e) }; }

  let dishes = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    try {
      const r = await c1.collection('dish_lexicon').field({ name: true, reason: true, reasonFixed: true }).skip(offset).limit(PAGE).get();
      const batch = r.data || [];
      dishes.push(...batch);
      if (batch.length < PAGE) break;
    } catch (e) { return { ok: false, err: '读 env1 dish_lexicon 失败：' + ((e && e.message) || e) }; }
  }

  const needFix = dishes.filter(d => isOldReason(d));
  const inPool = dishes.filter(d => d && typeof d.reason === 'string' && POOL_REASONS.has(d.reason.trim())).map(d => ({ name: d.name, reason: d.reason, reasonFixed: !!d.reasonFixed }));
  const fixedmarked = dishes.filter(d => d && d.reasonFixed === true).length;
  console.log('[fixReason] 总 ' + dishes.length + ' 道，需补全 ' + needFix.length + ' 道，池中 ' + inPool.length + ' 道，已标记 ' + fixedmarked + ' 道');

  if (!needFix.length) return { ok: true, build: BUILD_TAG, total: dishes.length, needFix: 0, fixed: 0, inPoolCount: inPool.length, fixedMarked: fixedmarked, inPoolSample: inPool.slice(0, 30) };

  let fixed = 0, failed = 0;
  const details = [];
  const BATCH = 20;
  for (let i = 0; i < needFix.length; i += BATCH) {
    const batch = needFix.slice(i, i + BATCH);
    const arr = batch.map((d, idx) => ({ idx, name: d.name }));
    const prompt = '以下是菜品列表。请为每道菜用【文言文体】写一句推荐短评（严格恰好 4 个中文字符，只数汉字、不含标点，须写满 4 字）。\n'
      + '要求：文言语气凝练典雅（如「鲜香味美」「肥而不腻」「清鲜爽口」「温润甘淡」），不复述菜名、不得写现代套话；须契合该菜自身风味，从口感/做法/营养/场景/下饭程度任一角度切入。\n'
      + '菜品列表：' + JSON.stringify(arr) + '\n'
      + '只输出 JSON，不要额外说明，格式：{"reasons":[{"idx":0,"reason":"四字文言短评"}]}';

    try {
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1200,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      let parsed = jsonParseRepair(text);
      if (!parsed) {
        const m = String(text).match(/\{[\s\S]*\}/);
        if (m) parsed = jsonParseRepair(m[0]);
      }
      if (parsed && Array.isArray(parsed.reasons)) {
        for (const x of parsed.reasons) {
          if (x && typeof x.idx === 'number' && batch[x.idx] && x.reason) {
            const reason = capReason4(String(x.reason).trim());
            if (reason) {
              try {
                await c1.collection('dish_lexicon').where({ name: batch[x.idx].name }).update({ data: { reason, reasonFixed: true } });
                fixed++;
                if (details.length < 50) details.push({ name: batch[x.idx].name, reason, status: 'ok' });
              } catch (e) {
                failed++;
                if (details.length < 50) details.push({ name: batch[x.idx].name, status: 'fail', err: 'write: ' + ((e && e.message) || e) });
              }
            } else {
              failed++;
            }
          }
        }
      }
    } catch (e) {
      failed += batch.length;
      console.warn('[fixReason] AI 调用失败：' + ((e && e.message) || e));
    }
  }

  return { ok: true, build: BUILD_TAG, total: dishes.length, needFix: needFix.length, fixed, failed, details };
};