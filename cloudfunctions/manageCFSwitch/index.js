// manageCFSwitch —— 协同过滤(CF)影子模式·开关与就绪进度（管理员后台用，2026-08-07）
//
// 背景：方案B 协同过滤默认关（sys_config.cf_switch.cf_enabled=false），避免小样本失真。
//   是否生效由 getRecommendation 的「双判定」决定：① cf_enabled 总开关 ② cf_ready 数据就绪。
//   本函数让管理员后台能：① 读取开关状态 + 数据就绪进度（用于判断"何时该开"）
//                         ② 翻转总开关（手动开启/关闭影子模式）。
//
// 权限：仅管理员 OPENID 可调用（与 getAdminStats / manageUser 一致）。
// action：
//   get → { enabled, ready, users, pairs, items, threshold, computedAt, canEnable }
//   set → { enabled }  （data.enabled 布尔；翻转 cf_switch.cf_enabled）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));

async function readDoc(id) {
  try {
    const r = await db.collection('sys_config').doc(id).get();
    return (r && r.data) || null;
  } catch (e) {
    return null;
  }
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] manageCFSwitch BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] manageCFSwitch BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const action = (event && event.action) || 'get';

  if (action === 'get') {
    const sw = await readDoc('cf_switch');     // { _id, cf_enabled, note, updatedAt }
    const ready = await readDoc('cf_ready');   // { _id, users, pairs, items, ready, threshold, computedAt }
    const threshold = (ready && ready.threshold) || { users: 200, pairs: 800 };
    const users = (ready && ready.users) || 0;
    const pairs = (ready && ready.pairs) || 0;
    const items = (ready && ready.items) || 0;
    // canEnable：数据已达标（但开关仍关）→ 提示管理员"可以开了"
    const dataReady = !!(ready && ready.ready);
    return {
      code: 200,
      enabled: !!(sw && sw.cf_enabled),
      ready: dataReady,
      users,
      pairs,
      items,
      threshold,
      computedAt: (ready && ready.computedAt) || 0,
      canEnable: dataReady && !(sw && sw.cf_enabled),
      msg: 'ok'
    };
  }

  if (action === 'set') {
    const enabled = !!(event && event.enabled);
    const updatedAt = Date.now();
    try {
      await db.collection('sys_config').doc('cf_switch').get();
      await db.collection('sys_config').doc('cf_switch').update({ data: { cf_enabled: enabled, updatedAt } });
    } catch (e) {
      // 开关文档不存在则创建（computeCF 首次跑通常已建，这里兜底）
      try {
        await db.collection('sys_config').add({
          data: { _id: 'cf_switch', cf_enabled: enabled, note: 'CF影子模式总开关，默认关；达标后手动或自动置true', updatedAt }
        });
      } catch (e2) {
        return { code: 500, msg: '写入开关失败：' + ((e2 && e2.message) || e2) };
      }
    }
    return { code: 200, enabled, msg: enabled ? 'CF影子模式已开启' : 'CF影子模式已关闭' };
  }

  return { code: 400, msg: '未知 action' };
};
