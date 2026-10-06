// 通用工具函数

function formatDate(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function getToday() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 服务异常统一文案与弹窗（2026-09-13 用户确认口径）。
// 适用范围：云端限流/算力达上限(430)、上游异常、服务未归类异常，以及云调用完全失败（env 不可达/网络超时）。
// 这些场景下前端所有「使用按钮」一律弹同一条，避免各页各说各话（「出文通道繁忙」/「哎呀，出错了」/「请稍后重试」）。
// 保留差异化：403(次数不足→引导领次数)、449(领取上限)、BUG(我方代码缺陷，需排查)。
const SERVER_BUSY_MSG = '服务器算力已达上限，请稍后再试';
function showServerBusy(title) {
  wx.showModal({
    title: title || '服务异常',
    content: SERVER_BUSY_MSG,
    showCancel: false,
    confirmText: '知道了'
  });
}

module.exports = { formatDate, getToday, SERVER_BUSY_MSG, showServerBusy };
