// tagSeason · env1 时令打标（阶段 2.3）：hy3 批量判每道菜的最佳食用月份，写 dish_profile.bestMonths
// 游标分批：每次 invoke 处理 BATCH 道（无 bestMonths 的），打完自停；定时器每 30 分钟扫一轮，也可手动 invoke。
// BUILD_TAG: 2026-09-06.tag-season-v1
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = require('@cloudbase/node-sdk').init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');

const BUILD_TAG = '2026-09-06.tag-season-v1';
const BATCH = 60;
const VALID_MONTHS = new Set([1,2,3,4,5,6,7,8,9,10,11,12]);

console.log('[build] tagSeason BUILD_TAG=' + BUILD_TAG);

async function bestMonths(name, main, category) {
  const messages = [
    { role: 'system', content: '你是中餐时令顾问。只输出 JSON，不要解释。' },
    { role: 'user', content: '菜品《' + name + '》' + (main ? '主料=' + main + '；' : '') + (category ? '类别=' + category : '') + '。按食材时令与菜品属性判断最适合食用的月份（火锅炖菜宜冬、凉拌冰饮宜夏、螃蟹宜秋、清补汤品宜春秋）。只输出 JSON：{"months":[1,2,12]}（数字 1-12，取 2-6 个月；四季皆宜给全部 12 个月）' },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await textModel.generateText({ model: 'hy3', messages, temperature: 0.2, maxTokens: 1000 });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const m = text.match(/\{[\s\S]*?\}/);
      if (!m) continue;
      const arr = JSON.parse(m[0]).months;
      const ok = [...new Set((arr || []).map(Number).filter(n => VALID_MONTHS.has(n)))];
      if (ok.length) return ok;
    } catch (e) {
      if (attempt === 1) console.warn('[tagSeason] ' + name + ' 失败：', e && e.message);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  return null;
}

exports.main = async (event) => {
  console.log('[build] tagSeason BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  try {
    const db = cloud.database();
    const _ = db.command;
    const BATCH_N = Math.min(Number(event && event.batch) || BATCH, 200);
    // 游标：取无 bestMonths 的前 BATCH_N 道（按 _id 升序稳定推进）
    let lastId = (event && event.cursor) || '';
    const cond = lastId ? { bestMonths: _.exists(false), _id: _.gt(lastId) } : { bestMonths: _.exists(false) };
    let rows = [];
    try {
      const r = await db.collection('dish_ingredients').where(cond).orderBy('_id', 'asc').limit(BATCH_N).get();
      rows = r.data || [];
    } catch (e) { return { ok: false, err: '读取失败: ' + e.message }; }
    if (!rows.length) return { ok: true, done: true, processed: 0, msg: '全库时令打标已完成' };

    let okCount = 0, missCount = 0;
    for (const row of rows) {
      const name = row.name || row._id;
      let main = '', category = '';
      try {
        const pr = await db.collection('dish_profile').doc(name).get();
        const pf = ((pr.data || [])[0] || {}).profile || {};
        main = pf.main || ''; category = pf.category || '';
      } catch (e) {}
      const bm = await bestMonths(name, main, category);
      if (bm) {
        try {
          const pr = await db.collection('dish_profile').doc(name).get();
          const doc = (pr.data || [])[0];
          const prof = Object.assign({}, (doc && doc.profile) || {}, { bestMonths: bm });
          await db.collection('dish_profile').doc(name).set({ name, profile: prof, ts: Date.now() });
          okCount++;
        } catch (e) { missCount++; }
      } else {
        // 两次都没判出 → 写空数组占位避免死循环重扫
        try {
          const pr = await db.collection('dish_profile').doc(name).get();
          const doc = (pr.data || [])[0];
          const prof = Object.assign({}, (doc && doc.profile) || {}, { bestMonths: [] });
          await db.collection('dish_profile').doc(name).set({ name, profile: prof, ts: Date.now() });
        } catch (e) {}
        missCount++;
      }
    }
    const nextCursor = rows[rows.length - 1]._id;
    return { ok: true, done: false, processed: rows.length, okCount, missCount, nextCursor };
  } catch (e) {
    console.error('[tagSeason] 异常：', e);
    return { ok: false, err: (e && e.message) || '异常' };
  }
};
