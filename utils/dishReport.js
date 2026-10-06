// dishReport.js —— 菜详情「不喜欢/举报」快速入口（阶段5 ② 2026-09-07）
// 复用 submitDishFeedback 云函数（reason 白名单对齐其 REPORT_TYPES）：
//   菜名问题类（拼凑/搭配不合理/名字缩略）→ dish_feedback(pending) → review-web 轮询接返工闭环
//   系统误伤类 → dish_name_fix（自动触发截断补全，不进黑名单）
//   个人忌口/不合口味 → 记入本人 avoidDishes（不影响他人）
// 补充说明不用系统 wx.showModal(editable)（输入框过小），由各页弹自定义 textarea 覆盖层（见页面 rep.*）。
// 结果反馈一律 wx.showModal（R-Code-02，禁 toast）。

const REPORT_ITEMS = [
  { t: '拼凑', label: '菜名拼凑/不通顺' },
  { t: '搭配不合理', label: '食材搭配不合理' },
  { t: '名字缩略', label: '菜名缩略不规范' },
  { t: '系统误伤', label: '菜名被误写/截断' },
  { t: '命中忌口', label: '食材命中我的忌口' },
  { t: '不合口味', label: '味道/做法不合口味' },
];

// 弹 ActionSheet 选反馈类型；取消返回 null
function chooseType() {
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList: REPORT_ITEMS.map(i => i.label),
      success: (r) => {
        const item = REPORT_ITEMS[r.tapIndex];
        resolve(item ? item : null);
      },
      fail: () => resolve(null),
    });
  });
}

// 提交反馈（页面收集好类型与补充说明后调用）
async function submitReport(dish, reportArr, note) {
  const name = String(dish || '').trim();
  if (!name) return { ok: false, msg: '缺少菜名' };
  wx.showLoading({ title: '提交中', mask: true });
  try {
    const res = await wx.cloud.callFunction({
      name: 'submitDishFeedback',
      data: { dish: name, report: reportArr || [], note: note || '' },
    });
    wx.hideLoading();
    const result = res && res.result;
    if (result && result.code === 200) return { ok: true, msg: result.msg || '已收到反馈' };
    return { ok: false, msg: (result && result.msg) || '提交失败，请稍后重试' };
  } catch (e) {
    wx.hideLoading();
    return { ok: false, msg: '网络异常，提交失败' };
  }
}

module.exports = { REPORT_ITEMS, chooseType, submitReport };
