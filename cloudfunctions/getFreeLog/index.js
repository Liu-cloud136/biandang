const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 来源中文名（与写入 free_log 的 source 字段对应）
const SOURCE_NAME = {
  signin: '每日签到',
  ad: '领次数',
  bonus: '管理员赠送',
  recommend: '推荐决定',
  cook: '查看做法',
  cookguide: '查看做法',      // 旧值兜底（2026-07 曾用 cookguide 写入，2026-09-07 已统一为 cook）
  favorite: '云端收藏',
  backup: '数据备份',
  contrib: '贡献奖励',
  feedback: '反馈奖励',
  try: '尝鲜推荐',
  refund: '尝鲜生成失败',
  cook_refund: '做法生成失败退回',
  virtualpay: '虚拟支付购买',
  fridge: '冰箱反推',
  weekplan: '一周菜单',
  leftover: '剩菜改造',
  redeem: '兑换码'
};

// 把服务端返回的日期格式化为「月-日 时:分」（WXML 无法调用 JS，需提前格式化）
// 注意：云函数运行环境为 UTC，必须用 UTC+8（中国时区）计算，避免显示慢 8 小时
function fmt(ts) {
  let d = ts;
  if (ts && ts.$date) d = new Date(ts.$date);
  else if (typeof ts === 'string') d = new Date(ts);
  else if (!(ts instanceof Date)) d = new Date();
  // 转为中国时间
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${cn.getUTCMonth() + 1}-${p(cn.getUTCDate())} ${p(cn.getUTCHours())}:${p(cn.getUTCMinutes())}`;
}

// 构建指纹（2026-08-08 推广；2026-09-07 明细归一：amount 绝对值 + type 归 add/deduct + cookguide/cook_refund 中文）
const BUILD_TAG = '2026-09-07.log-normalize';
console.log('[build] getFreeLog BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] getFreeLog BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };
  try {
    const [logRes, prefsRes] = await Promise.all([
      db.collection('free_log').where({ _openid: OPENID }).orderBy('ts', 'desc').limit(50).get(),
      db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get()
    ]);
    const prefs = prefsRes.data[0];
    const bonusFree = (prefs && typeof prefs.bonusFree === 'number') ? prefs.bonusFree : 0;
    const base = (prefs && typeof prefs.baseFree === 'number') ? prefs.baseFree : 0;
    const list = (logRes.data || []).map(x => {
      const isAdd = x.type === 'add';
      // amount 取绝对值 + type 归一到 add/deduct：历史部分记录 amount 为负（-1），
      // 前端 WXML 按 type 显式拼 +/-，若负值原样透传会显示 --1（双负号）；正数由 type 决定符号。
      return {
        type: isAdd ? 'add' : 'deduct',
        // 优先用数据自带的 sourceName（写入时已含中文，如「冰箱反推」「一周菜单」），
        // 缺失时再查映射表兜底，仍缺则回退原始 source。
        sourceName: (x.sourceName && String(x.sourceName).trim()) || SOURCE_NAME[x.source] || x.source || '',
        amount: Math.abs(Number(x.amount) || 0),
        ts: fmt(x.ts)
      };
    });
    return { code: 200, data: { freeCount: base + bonusFree, bonusFree, list } };
  } catch (e) {
    console.error('getFreeLog error:', e);
    return { code: 500, msg: '读取明细失败' };
  }
};
