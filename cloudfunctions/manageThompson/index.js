// manageThompson —— B② Thompson 采样·开关与就绪进度（管理员后台用，2026-08-08）
//
// 背景：B② Thompson 采样（细门槛门控）默认关（sys_config.thompson_switch.enabled=false），
//   避免小样本失真。仅在 enabled 且单臂 accept>=minSuccess 且 cnt>=minTotal 时，
//   getRecommendation 才把该臂的探索选向从 UCB 切换为 Beta 抽样（见 thompsonPick）。
//   本函数让管理员后台能：① 读取开关状态 + 探索臂达标进度（判断"开了之后能真正用上多少"）
//                         ② 翻转总开关（手动开启/关闭）。
//
// 权限：仅管理员 OPENID 可调用。
// action：
//   get → { enabled, minSuccess, minTotal, arms, armsQualified, armsPct,
//           totalCnt, totalAccept, acceptRate, computedAt,
//           armsList:[{dir,cnt,accept,qualified}] }
//   set → { enabled }  （data.enabled 布尔；翻转 thompson_switch.enabled）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));

// 默认门槛（与 getRecommendation.thompsonPick 一致；文档缺省时使用）
const DEF_MIN_SUCCESS = 15;
const DEF_MIN_TOTAL = 30;

async function readDoc(id) {
  try {
    const r = await db.collection('sys_config').doc(id).get();
    return (r && r.data) || null;
  } catch (e) {
    return null;
  }
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-14.fix-explore-query';
console.log('[build] manageThompson BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] manageThompson BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const action = (event && event.action) || 'get';

  if (action === 'get') {
    const sw = await readDoc('thompson_switch'); // { _id, enabled, minSuccess, minTotal, updatedAt }
    const enabled = !!(sw && sw.enabled);
    const minSuccess = (sw && typeof sw.minSuccess === 'number') ? sw.minSuccess : DEF_MIN_SUCCESS;
    const minTotal = (sw && typeof sw.minTotal === 'number') ? sw.minTotal : DEF_MIN_TOTAL;
    // 进度：扫描 dish_exposure 中 EXPLORE::* 文档，统计探索臂总数与达标臂数。
    // 达标 = cnt>=minTotal 且 accept>=minSuccess。进度直观反映"开了之后能真正走 Thompson 的臂有多少"。
    let arms = 0, armsQualified = 0, totalCnt = 0, totalAccept = 0;
    const armsList = [];
    try {
      // ⚠️ 精确查 EXPLORE::* 探索臂文档，不要用 limit(1000) 盲拉整个集合再过滤——
      // dish_exposure 绝大多数是普通菜名曝光文档（全局软降权维护，持续增长），
      // 盲拉前 1000 条会把 EXPLORE::* 挤出，导致进度永远停在早期数据、不随真实探索增长刷新。
      const res = await db.collection('dish_exposure').where({ _id: db.RegExp({ regexp: '^EXPLORE::' }) }).limit(1000).get();
      (res && res.data ? res.data : []).forEach(d => {
        if (!d || String(d._id || '').indexOf('EXPLORE::') !== 0) return; // 只统计探索方向文档
        const dir = String(d._id).replace('EXPLORE::', '');
        const cnt = d.cnt || 0;
        const accept = d.accept || 0;
        const qualified = (cnt >= minTotal && accept >= minSuccess);
        arms += 1;
        totalCnt += cnt;
        totalAccept += accept;
        if (qualified) armsQualified += 1;
        armsList.push({ dir, cnt, accept, qualified });
      });
    } catch (e) {
      // 读取失败：进度归零，开关状态仍正常返回
      console.warn('[thompson] 读探索臂进度失败：', e && e.message);
    }
    // 明细按 cnt 降序（推得最多的排前面，管理员最关心的高频臂置顶）
    armsList.sort((a, b) => (b.cnt - a.cnt) || (b.accept - a.accept));
    const armsPct = arms > 0 ? Math.min(Math.round(armsQualified / arms * 100), 100) : 0;
    const acceptRate = totalCnt > 0 ? totalAccept / totalCnt : 0;
    return {
      code: 200,
      enabled,
      minSuccess,
      minTotal,
      arms,
      armsQualified,
      armsPct,
      totalCnt,
      totalAccept,
      acceptRate,
      computedAt: (sw && sw.updatedAt) || 0,
      armsList, // 逐臂明细，供后台可展开列表展示
      msg: 'ok'
    };
  }

  if (action === 'set') {
    const enabled = !!(event && event.enabled);
    const updatedAt = Date.now();
    try {
      await db.collection('sys_config').doc('thompson_switch').get();
      await db.collection('sys_config').doc('thompson_switch').update({
        data: { enabled, updatedAt }
      });
    } catch (e) {
      // 开关文档不存在则创建（兜底）
      try {
        await db.collection('sys_config').add({
          data: {
            _id: 'thompson_switch',
            enabled,
            minSuccess: DEF_MIN_SUCCESS,
            minTotal: DEF_MIN_TOTAL,
            note: 'B② Thompson采样总开关，默认关；单臂达标(accept>=minSuccess且cnt>=minTotal)才启用Beta抽样',
            updatedAt
          }
        });
      } catch (e2) {
        return { code: 500, msg: '写入开关失败：' + ((e2 && e2.message) || e2) };
      }
    }
    return { code: 200, enabled, msg: enabled ? 'B② Thompson采样已开启' : 'B② Thompson采样已关闭' };
  }

  return { code: 400, msg: '未知 action' };
};
