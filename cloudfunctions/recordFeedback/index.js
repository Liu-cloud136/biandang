const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-17.lexiconGairiceNormalize';
console.log('[build] recordFeedback BUILD_TAG=' + BUILD_TAG);

// 2026-08-17：用户采纳（落 selected）的菜/主食/饮品，沉淀进 dish_lexicon（valid:true, source:'commit'），
// 供 finalMinTwoSentinel 兜底反哺。按 name+kind 去重（已存在则跳过，避免多用户/多次采纳重复写）。
// 2026-08-17：命名归一化——形如「XX米饭」（菜+米饭合成主食）统一改为「XX盖浇饭」。
// 纯米种主食（白米饭/糙米饭/杂粮米饭…）不在改写范围，用白名单跳过。
const PLAIN_RICE_SET = new Set([
  '米饭', '白米饭', '糙米饭', '杂粮米饭', '小米米饭', '糯米米饭', '黑米米饭', '高粱米米饭',
  '藜麦米饭', '藜麦小米饭', '金银米饭', '大米饭', '糯米饭', '高粱米饭', '玉米米饭',
  '红薯米饭', '紫薯米饭', '五常大米米饭', '玉米胡萝卜米饭', '杂粮饭', '小米饭', '玉米饭'
]);
function normalizeLexiconName(name) {
  const n = String(name || '').trim();
  if (!n.endsWith('米饭')) return n;
  if (PLAIN_RICE_SET.has(n)) return n;        // 纯米种主食，不改
  return n.slice(0, -2) + '盖浇饭';           // 「XX米饭」→「XX盖浇饭」
}
async function sinkSelectedToLexicon(selected) {
  if (!Array.isArray(selected) || !selected.length) return;
  const want = []; // {name, kind}
  selected.forEach(s => {
    if (!s) return;
    if (s.name) want.push({ name: normalizeLexiconName(s.name), kind: 'dish' });
    if (s.staple) want.push({ name: normalizeLexiconName(s.staple), kind: 'staple' });
    if (s.drink) want.push({ name: normalizeLexiconName(s.drink), kind: 'drink' });
  });
  const uniq = [];
  const seen = new Set();
  want.forEach(w => {
    const k = w.kind + '::' + w.name;
    if (!w.name || seen.has(k)) return;
    seen.add(k);
    uniq.push(w);
  });
  if (!uniq.length) return;
  // 查已存在的 name+kind，过滤掉避免重复 add
  const names = uniq.map(w => w.name);
  try {
    const existRes = await db.collection('dish_lexicon').where({
      name: db.command.in(names)
    }).field({ name: true, kind: true }).limit(1000).get();
    const existSet = new Set((existRes && existRes.data || []).map(d => (d.kind || 'dish') + '::' + (d.name || '')));
    const toAdd = uniq.filter(w => !existSet.has(w.kind + '::' + w.name)).map(w => ({
      name: w.name, kind: w.kind, source: 'commit', valid: true, createdAt: Date.now()
    }));
    if (toAdd.length) {
      await db.collection('dish_lexicon').add({
        data: toAdd.map(d => Object.assign({}, d, { _createTime: db.serverDate() }))
      });
      console.warn('[lexicon] 沉淀采纳菜 ' + toAdd.length + ' 条: ' + JSON.stringify(toAdd.map(d => d.kind + ':' + d.name)));
    }
  } catch (e) {
    console.warn('[lexicon] 沉淀失败（不影响主流程）: ' + ((e && e.message) || e));
  }
}

exports.main = async (event) => {
  console.log('[build] recordFeedback BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const { historyId, selected, feedback, recommendations } = event;
  if (!historyId) return { code: 400, msg: '缺少 historyId' };

  // 仅更新传入的字段：selected / feedback 必带；recommendations 为出图后回填了 imageUrl 的副本，
  // 用于修复「历史记录图片不显示」——出图只改了前端内存，需回写数据库才能让历史页读到图。
  const updateData = {};
  if (selected !== undefined) updateData.selected = selected || null;
  if (feedback !== undefined) updateData.feedback = feedback || null;
  if (recommendations !== undefined && Array.isArray(recommendations)) {
    updateData.recommendations = recommendations;
  }

  try {
    // 越权防护：先校验历史记录归属当前用户，避免任意登录用户篡改他人推荐历史
    const histRes = await db.collection('recommend_history').doc(historyId).get();
    const hist = histRes && histRes.data;
    if (!hist) return { code: 404, msg: '记录不存在' };
    if (hist._openid !== OPENID) return { code: 403, msg: '无权操作他人记录' };
    await db.collection('recommend_history').doc(historyId).update({ data: updateData });
    // 2026-08-17：采纳落库后异步沉淀到 dish_lexicon（不阻塞主返回）
    if (selected && Array.isArray(selected) && selected.length) {
      await sinkSelectedToLexicon(selected);
    }
    return { code: 200, msg: 'ok' };
  } catch (e) {
    console.error('recordFeedback error:', e);
    return { code: 500, msg: (e && e.message) || '记录失败' };
  }
};
