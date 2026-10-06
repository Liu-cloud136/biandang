const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { logErr } = require('./logErr');

// —— 构建指纹（2026-08-08 推广）——
const BUILD_TAG = '2026-08-14.feedback-logs';
console.log('[build] submitFeedback BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] submitFeedback BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

    const text = (event && event.text || '').trim();
    if (!text) return { code: 400, msg: '反馈内容为空' };

    // 客户端运行日志（最多保留 200 条，按行截断，避免文档过大）
    let logs = [];
    if (Array.isArray(event.logs)) {
      logs = event.logs.slice(0, 200).map(function (l) {
        return typeof l === 'string' && l.length > 1000 ? l.slice(0, 1000) + '…(truncated)' : String(l);
      });
    }

    await db.collection('feedback').add({
      data: {
        text,
        logs,
        logCount: logs.length,
        _openid: OPENID,
        createdAt: new Date()
      }
    });
    return { code: 200, msg: 'ok' };
  } catch (err) {
    console.error('[submitFeedback] error:', err);
    await logErr('submitFeedback', err);
    return { code: 500, msg: '反馈提交失败，请稍后重试' };
  }
};
