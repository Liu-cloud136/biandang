// ============================================================================
// bypassGenCuisine · env2 AI 批量判菜系（2026-08-29 cookbook 补库专用）
// BUILD_TAG: 2026-09-06.cuisine-source-batchb
//
// 职责：扫 dish_mirror 中 source∈{cookbook,batchB} 且缺 cuisine 的菜，hy3 批量判菜系
//      （一次调用判 20 道，受控词表），写回 dish_mirror.cuisine。
// 纪律：自限 170s/轮（函数 Timeout 300s）；无任务即快速退出；失败静默记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-09-06.cuisine-source-batchb';

const BATCH = 20;          // 每次 hy3 调用判 20 道
const CUISINES = ['家常', '川菜', '湘菜', '粤菜', '东北菜', '西北菜', '浙菜', '鲁菜', '闽菜', '徽菜', '苏菜', '云贵菜', '西餐', '日料', '韩餐', '东南亚'];
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;


const app = tcbInit();
function tcbInit() {
  const tcb = require('@cloudbase/node-sdk');
  return tcb.init({ env: process.env.TCB_ENV || 'your-env-id-2', timeout: 60000 });
}
const ai = app.ai();

exports.main = async (event) => {
  console.log('[build] bypassGenCuisine BUILD_TAG=' + BUILD_TAG);
  const { task } = event || {};
  if (task === 'health') return { ok: true, build: BUILD_TAG, mode: 'gen-cuisine', env: process.env.TCB_ENV };

  const MAX_MS = 170000;
  const startedAt = Date.now();
  let totalComputed = 0, rounds = 0, lastId = '';

  while (true) {
    // cuisineScanned=true 表示已判过（无论是否判出流派），不再重扫
    const cond = { source: _.in(['cookbook', 'batchB']), cuisineScanned: _.neq(true) };
    if (lastId) cond._id = _.gt(lastId);
    let list = [];
    try { const res = await db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(BATCH).get(); list = res.data || []; } catch (e) { break; }
    if (!list.length) break;

    try {
      const result = await classifyBatch(list.map(d => d.name));
      const byName = new Map((result || []).map(x => [x.name, x.cuisine]));
      for (const d of list) {
        const c = byName.get(d.name);
        const upd = { cuisineScanned: true };
        if (c && CUISINES.indexOf(c) >= 0) upd.cuisine = c;
        await db.collection('dish_mirror').doc(d._id).update({ data: upd });
        if (c && CUISINES.indexOf(c) >= 0) totalComputed++;
      }
      lastId = list[list.length - 1]._id;
    } catch (e) {
      console.warn('[bypassGenCuisine] 批次失败：', e && e.message);
      await logTask('bypassGenCuisine', 'fail', 'batch ' + (e && e.message)).catch(() => {});
      lastId = list[list.length - 1]._id; // 跳过该批继续
    }
    rounds++;
    if (Date.now() - startedAt > MAX_MS) break;
  }

  return { ok: true, computed: totalComputed, rounds };
};

async function classifyBatch(names) {
  const lines = names.map((n, i) => (i + 1) + '. ' + n).join('\n');
  const messages = [
    { role: 'system', content: '你是菜系分类器。只输出 JSON，不要任何解释。格式：{"items":[{"i":1,"cuisine":"家常"}]}' },
    { role: 'user', content: '请判断以下家常菜谱的菜系，只能从这些词里选：' + CUISINES.join('、') + '。\n'
      + '判定依据是菜品名称本身的风味流派（如 麻婆豆腐→川菜、糖醋里脊→鲁菜、锅包肉→东北菜、白灼虾→粤菜、寿司→日料）；'
      + '无法明确判断流派的家常菜谱一律判「家常」。\n' + lines }
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.2, maxTokens: 800 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const obj = parseJsonObject(text);
      if (!obj || !Array.isArray(obj.items)) throw new Error('空结果');
      return obj.items
        .filter(x => x && names[x.i - 1])
        .map(x => ({ name: names[x.i - 1], cuisine: String(x.cuisine || '').trim() }));
    } catch (e) {
      if (attempt < 1) await new Promise(r => setTimeout(r, 1200));
      else console.warn('[classifyBatch] hy3 失败：', e && e.message);
    }
  }
  return null;
}

function parseJsonObject(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/`{3}(?:json)?\s*([\s\S]*?)`{3}/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (e2) { /* 走修复梯 */ }
  // 2026-09-12 三级修复梯（hy3 glitch 实锤："amount"::"3瓣" 双冒号 100% 复现）
  let r = t.replace(/,(s*[}]])/g, '$1');            // ① 收尾逗号
  try { return JSON.parse(r); } catch (e2) { /* 下一级 */ }
  r = r.replace(/"s*:s*:/g, '":');                  // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e2) { /* 下一级 */ }
  r = r.replace(/""s*:s*"/g, '"');                  // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e2) { return null; }
}

async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({ data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() } });
  } catch (e) {}
}
