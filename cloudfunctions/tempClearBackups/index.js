const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 一次性清理：删除改版前（旧版 autoBackup）产生的「逐用户定时快照」。
// 判定条件（fail-safe，绝不误删）：
//   - label 以 "定时 " 开头（旧版 label 格式 "定时 YYYY-MM-DD HH:MM"）
//   - 且 desc 不存在或为空（新版定时全量 desc='定时全量备份'、手动全量 desc='全量备份（全部用户）'、手动用户备份 desc='用户数据备份' 均被排除）
// 管理员权限校验：仅 ADMIN_OPENID 可调用。

const ADMIN_OPENID = process.env.ADMIN_OPENID || '';

function isAdmin(OPENID) {
  return !!(OPENID && OPENID === ADMIN_OPENID);
}

// 构建指纹
const BUILD_TAG = '2026-08-10.temp-clear';
console.log('[build] tempClearBackups BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] tempClearBackups BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'preview'));
  const ctx = cloud.getWXContext ? cloud.getWXContext() : {};
  const OPENID = (ctx && ctx.OPENID) || (event && event.OPENID) || '';
  if (!isAdmin(OPENID)) return { code: 403, msg: '无权限' };

  const action = (event && event.action) || 'preview';

  // 拉取所有疑似旧定时记录：label 以 "定时 " 开头
  let all = [];
  try {
    let last = null;
    while (true) {
      let q = db.collection('data_backups').where({ label: db.RegExp({ regexp: '^定时 ', options: '' }) });
      if (last) q = q.where({ _id: _.gt(last) });
      const r = await q.limit(1000).get();
      if (!r.data.length) break;
      all = all.concat(r.data);
      last = r.data[r.data.length - 1]._id;
      if (r.data.length < 1000) break;
    }
  } catch (e) {
    return { code: 500, msg: '查询失败: ' + (e && e.message) };
  }

  // 二次过滤：desc 必须为空/不存在（排除新版定时全量、手动全量、手动用户备份）
  const targets = all.filter(b => !(b.desc && String(b.desc).trim()));
  const protectedHit = all.length - targets.length;

  // 按 label 分组统计（用于 preview 展示）
  const byLabel = {};
  targets.forEach(b => { const k = b.label || '(无label)'; byLabel[k] = (byLabel[k] || 0) + 1; });

  if (action === 'preview') {
    return {
      code: 200,
      data: {
        candidate: all.length,        // 命中 label 前缀的
        protectedExcluded: protectedHit, // 因 desc 非空被排除（不该删的）
        toDelete: targets.length,     // 实际将删除
        byLabel
      }
    };
  }

  if (action === 'clean') {
    // 分批删除：单次最多删 BATCH 条，避免同步 invoke 3s 超时；外部循环调用直到 toDelete 为 0
    const BATCH = (event && event.batchSize) || 20;
    const slice = targets.slice(0, BATCH);
    let removed = 0, failed = 0;
    for (const b of slice) {
      try {
        await db.collection('data_backups').doc(b._id).remove();
        removed++;
      } catch (e) { failed++; console.warn('[tempClearBackups] remove failed', b._id, e && e.message); }
    }
    return { code: 200, data: { removed, failed, batch: slice.length, remaining: targets.length - slice.length } };
  }

  return { code: 400, msg: '未知 action' };
};
