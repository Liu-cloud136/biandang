// ============================================================================
// bypassReviewContribution · env2 投稿 AI 初筛（阶段5，§10 增强方向）
// BUILD_TAG: 2026-08-21.bypass-review-v1（骨架）
//
// 职责：
//   - env1 submitContribution 的 AI 初筛旁路：投稿数据投递到本函数
//   - hy3 初筛：合法性/内容质量/菜品真实性 → 打分 + pass/fail
//   - 初筛通过 → 写 env1 审核池（source='env2-review'）；不通过 → 记 bypass_log 供参考
//   - 当前为骨架：env1 投稿数据源（submitContribution 投递点）就位前只提供 task='review' 接口
//
// 纪律：
//   - hy3 直配 'hy3'；初筛不替代人工审核，只做前置过滤
//   - 黑名单（狗肉/蛇肉等）直接判不通过，不调 AI
// ============================================================================
const BUILD_TAG = '2026-08-21.bypass-review-v1';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();

const BAD_WORDS = ['狗肉', '蛇肉', '猫肉', '果子狸', '蝙蝠', '穿山甲', '烟', '酒', '毒品'];

exports.main = async (event) => {
  console.log('[build] bypassReviewContribution BUILD_TAG=' + BUILD_TAG);
  const { task, contribution } = event || {};

  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, mode: 'review', env: TCB_ENV, status: 'skeleton' };
  }

  if (task === 'review') {
    if (!contribution) return { ok: false, err: 'missing_contribution' };
    return await reviewContribution(contribution);
  }

  return { ok: true, build: BUILD_TAG, msg: 'pass task=review with contribution data' };
};

async function reviewContribution(c) {
  const title = String(c.title || c.dishName || '').trim();
  const content = String(c.content || '').trim();

  if (!title || !content) {
    return { ok: true, pass: false, score: 0, reason: '标题或内容为空' };
  }

  // 黑名单硬判
  for (const w of BAD_WORDS) {
    if (title.indexOf(w) >= 0 || content.indexOf(w) >= 0) {
      await logTask('bypassReviewContribution', null, 'ok', 'blocked:' + w + ' title=' + title);
      return { ok: true, pass: false, score: 0, reason: '黑名单命中: ' + w };
    }
  }

  // hy3 初筛
  const prompt = [
    '你是菜谱投稿初审员。对给定投稿做质量评估，只输出 JSON，不要解释。',
    '字段：score(0-100整数), pass(true/false), reason(一句话)',
    '评判标准：菜品真实存在+30，做法合理+20，内容完整+20，无错别字+10，适合收录+20',
    '投稿标题：' + title,
    '投稿内容：' + content.slice(0, 500),
  ].join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const textModel = ai.createModel('cloudbase');
      const resp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 128,
      });
      const text = (resp && (resp.text || (resp.data && resp.data.text))) || '';
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) throw new Error('非 JSON');
      const obj = jsonParseRepair(m[0]);
      if (!obj) throw new Error('JSON 解析失败');
      const score = Math.min(100, Math.max(0, parseInt(obj.score, 10) || 0));
      const pass = obj.pass === true || score >= 60;
      const reason = String(obj.reason || '').slice(0, 100);

      await logTask('bypassReviewContribution', null, 'ok',
        (pass ? 'pass' : 'reject') + ' score=' + score + ' title=' + title);

      return { ok: true, pass, score, reason };
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      else console.warn('[reviewContribution] hy3 失败 title=' + title + '：', e && e.message);
    }
  }

  // AI 初筛失败 → 放行让人工审（不阻塞投稿）
  await logTask('bypassReviewContribution', null, 'fail', 'ai_review_failed title=' + title);
  return { ok: true, pass: true, score: -1, reason: 'AI 初筛失败，转人工审核' };
}


// 2026-09-12：hy3 偶发吐畸形 JSON（实锤 "amount"::"3瓣" 双冒号，temp 0.3 下 100% 复现）
// 解析失败走三级修复梯（同 bypassConsistencyRepair v3-jsonfix / parseKit.repairJson）
function jsonParseRepair(s) {
  try { return JSON.parse(s); } catch (e) { /* 修复梯 */ }
  let r = String(s).replace(/,(s*[}]])/g, '$1');   // ① 收尾逗号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/"s*:s*:/g, '":');                 // ② 键值完成后多余冒号
  try { return JSON.parse(r); } catch (e) { /* 下一级 */ }
  r = r.replace(/""s*:s*"/g, '"');                 // ③ 空串值后紧跟新值
  try { return JSON.parse(r); } catch (e) { return null; }
}
async function logTask(task, openid, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: openid || null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* */ }
}