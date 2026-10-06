// getMyOpenid —— 返回当前调用者的 OPENID，供前端在直连 HTTP 流式函数(getRecSSE)时作为身份参数。
// OPENID 非机密（本项目 amIAdmin 等已内置同值兜底），用于 SSE 场景级流式出文的身份透传。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  return { code: 200, openid: OPENID || '' };
};
