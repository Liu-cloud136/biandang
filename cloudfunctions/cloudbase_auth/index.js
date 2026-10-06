// cloudbase_auth · env1 资源方鉴权函数（对称部署）
// 作用：当 env2（wx1111111111111111）经环境共享调用 env1 时，
// 本函数返回 auth 对象，注入 env1 数据库/存储安全规则的 auth.custom 字段，
// 使 env2 能反向写回 env1 的 recommend_cache / dish_nutrition 等集合（§5.1 / §8.1）。
const BUILD_TAG = '2026-08-21.env1-cloudbase-auth';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 资源方鉴权函数（官方协议，详见腾讯云开发 CloudBase「环境共享」文档）：
// 调用方（env2）cloud.Cloud.init() 时平台会先执行本函数，
// 返回的 auth 字符串会注入 env1 安全规则的 auth.custom 字段。
// 注意：auth 必须是「字符串」（JSON.stringify），且必须带 errCode:0，否则 getCrossAccountToken 失败。
const ALLOWED_CALLER = 'wx1111111111111111'; // env2 小程序 AppID（调用方）

exports.main = async (event, context) => {
  console.log('[build] cloudbase_auth BUILD_TAG=' + BUILD_TAG);
  const wxContext = cloud.getWXContext();
  const caller = wxContext.FROM_APPID || (event && event.fromAppid);
  console.log('[cloudbase_auth] 调用方 AppID=' + caller);

  // 仅放行 env2 小程序发起的跨账号调用；其它来源拒绝
  if (caller !== ALLOWED_CALLER) {
    return { errCode: 1, errMsg: 'forbidden caller: ' + caller };
  }

  return {
    errCode: 0,
    errMsg: '',
    auth: JSON.stringify({ fromAppid: ALLOWED_CALLER }), // 必须为字符串
  };
};
