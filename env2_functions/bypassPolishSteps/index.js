// ============================================================================
// bypassPolishSteps · env2 AI 步骤润色（2026-08-30 cookbook 补库专用）
// BUILD_TAG: 2026-08-30.bypass-polish-steps-v1
//
// 职责：扫 dish_mirror 中 source='cookbook' 且步骤"脏"（段数>=7 的碎步骤 /
//      含「成品图」/ 含网址链接）的菜，hy3 逐道把碎步骤合并润色为 4-8 步
//      规范步骤（删口语寒暄/广告/链接/「成品图」），写回 dish_mirror.steps
//      并标 stepsPolished:true（干净菜标 'clean' 跳过，防止每轮重扫）。
//      同步链路：scripts/sync_mirror_enrich_to_pending.js 检测 stepsPolished
//      后覆盖 env1 待审池 guide_pending.steps。
// 纪律：自限 170s/轮（函数 Timeout 300s）；无任务即快速退出；失败记 bypass_log。
// ============================================================================

const BUILD_TAG = '2026-08-30.bypass-polish-steps-v2';
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

const SLOT_N = 5;
const BATCH = 40;
const MAX_MS = 170000;
const URL_RE = /https?:\/\/|www\.|b23\.tv|bilibili|\.com\/|\.cn\/|\[.*\]\(/;
const { RateLimiter } = require('./rateLimiter');
// 自适应速率控制器（文）：初始 4、上限 8、60s 窗硬上限 160、429 退避 2/4/8s
const limiter = new RateLimiter({ rateInit: 4, rateMax: 8, rateMin: 0.5, burst: 8, windowCap: 160, successK: 10, backoffBase: 2000, backoffMax: 8000 });

// 步骤文本数组统一读取（兼容 [{stepNo,text}] 与 string[]）
function stepTexts(s) {
  if (!Array.isArray(s)) return [];
  return s.map(x => (x && typeof x === 'object') ? String(x.text || '') : String(x || '')).filter(t => t.trim());
}

// 脏判定：碎（>=7 段）/ 含成品图 / 含网址 —— 命中任一才丢给 AI 润色
function isDirty(texts) {
  if (!texts.length) return false;
  if (texts.length >= 7) return true;
  return texts.some(t => /成品图/.test(t) || URL_RE.test(t));
}

exports.main = async (event) => {
  console.log('[build] bypassPolishSteps BUILD_TAG=' + BUILD_TAG);
  const { task } = event || {};
  if (task === 'health') return { ok: true, build: BUILD_TAG, mode: 'polish-steps', env: process.env.TCB_ENV };

  const startedAt = Date.now();
  let totalDone = 0, totalClean = 0, totalFail = 0, rounds = 0, lastId = '';

  while (true) {
    // stepsPolished 不存在 = 未处理过（成功→true / 干净→'clean' / URL 残留→'failed' 都不再扫）
    // 08-30 v2：去掉 source 限制——正式库旧碎步骤（mirror 对应文档，任意来源）也要润色；
    // 干/脏判定在内存做，干净菜标 'clean' 不重扫
    const cond = { steps: _.exists(true), stepsPolished: _.exists(false) };
    if (lastId) cond._id = _.gt(lastId);
    let list = [];
    try { const res = await db.collection('dish_mirror').where(cond).orderBy('_id', 'asc').limit(BATCH).get(); list = res.data || []; } catch (e) { break; }
    if (!list.length) break;

    let done = 0, clean = 0, fail = 0;
    await pool(list, SLOT_N, async (d) => {
      const name = d.name || '';
      const texts = stepTexts(d.steps);
      if (!name || !texts.length) {
        await db.collection('dish_mirror').doc(d._id).update({ data: { stepsPolished: 'clean' } }).catch(() => {});
        return;
      }
      if (!isDirty(texts)) {
        clean++;
        await db.collection('dish_mirror').doc(d._id).update({ data: { stepsPolished: 'clean' } }).catch(() => {});
        return;
      }
      try {
        const polished = await polishSteps(name, texts);
        if (polished) {
          await db.collection('dish_mirror').doc(d._id).update({ data: { steps: polished, stepsPolished: true, stepsPolishedAt: Date.now() } });
          done++;
          lastId = d._id;
        } else {
          // hy3 反复失败/结果含 URL：标 failed 跳过防死循环，保留原步骤
          fail++;
          await db.collection('dish_mirror').doc(d._id).update({ data: { stepsPolished: 'failed' } }).catch(() => {});
          await logTask('bypassPolishSteps', 'fail', 'polish_empty name=' + name).catch(() => {});
        }
      } catch (e) {
        await logTask('bypassPolishSteps', 'fail', 'dish [' + name + '] ' + (e && e.message)).catch(() => {});
        if (/429|限流|rate\s*limit|too many/i.test((e && e.message) || '')) throw e;
      }
    }, limiter);

    totalDone += done; totalClean += clean; totalFail += fail;
    rounds++;
    console.log('[bypassPolishSteps] 轮 ' + rounds + ' done=' + done + ' clean=' + clean + ' fail=' + fail);
    if (Date.now() - startedAt > MAX_MS || list.length < BATCH) break;
  }

  await logTask('rateLimiter', 'info', limiter.monitorMsg()).catch(() => {});
  return { ok: true, polished: totalDone, clean: totalClean, failed: totalFail, rounds };
};

async function polishSteps(name, texts) {
  const lines = texts.map((t, i) => (i + 1) + '. ' + t).join('\n');
  const messages = [
    { role: 'system', content: '你是菜谱编辑。只输出 JSON，不要任何解释。格式：{"steps":["步骤一","步骤二"]}' },
    { role: 'user', content: '菜名【' + name + '】。下面是原始制作步骤，零碎、口语化、可能夹带寒暄/经验闲聊/广告/链接：\n' + lines + '\n\n要求：\n'
      + '1. 合并整理为 4-8 步，每步一个连贯的操作动作，保留该步的关键用料数量、火候、时间数字\n'
      + '2. 删除口语寒暄、闲聊、广告、网址链接、参考资料、「成品图」等一切与操作无关的内容\n'
      + '3. 每步 15-60 字，简洁通顺，步骤序号隐去（只给文本数组）' }
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.3, maxTokens: 1500 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const obj = parseJsonObject(text);
      let arr = obj && Array.isArray(obj.steps) ? obj.steps : null;
      // 兜底：纯文本按行拆（hy3 对结构化输出偶发不包 JSON）
      if (!arr && text.trim()) {
        const rows = text.trim().split(/\r?\n/).map(s => s.replace(/^\s*\d+[.、)]?\s*/, '').trim()).filter(s => s.length >= 6);
        if (rows.length >= 3) arr = rows;
      }
      if (!arr) { if (attempt < 2) await new Promise(r => setTimeout(r, 800)); continue; }
      // 清洗 + 校验：去成品图残留、去 URL 段、空段过滤、步号重排
      const cleaned = [];
      for (const raw of arr) {
        const t0 = (raw && typeof raw === 'object') ? String(raw.text || '') : String(raw || '');
        let t = t0.replace(/成品图/g, '').replace(/https?:\/\/\S+|www\.\S+/g, '').trim();
        if (!t || t.length < 5) continue;
        cleaned.push(t);
      }
      if (cleaned.length < 3 || cleaned.length > 10) { if (attempt < 2) await new Promise(r => setTimeout(r, 800)); continue; }
      if (cleaned.some(t => URL_RE.test(t))) { if (attempt < 2) await new Promise(r => setTimeout(r, 800)); continue; }
      return cleaned.map((t, i) => ({ stepNo: i + 1, text: t }));
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[polishSteps] hy3 失败 name=' + name + '：', e && e.message);
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

async function pool(items, concurrency, worker, limiter) {
  let idx = 0;
  const runners = [];
  for (let i = 0; i < concurrency && i < items.length; i++) {
    runners.push((async () => {
      while (idx < items.length) {
        const pos = idx++;
        if (limiter) await limiter.acquire();
        try {
          await worker(items[pos], pos);
          if (limiter) limiter.onSuccess();
        } catch (e) {
          if (limiter) limiter.onLimit();
          else throw e;
        }
      }
    })());
  }
  await Promise.all(runners);
}
