// cloudbase_auth · env2 资源方鉴权函数
// 作用：当 env1（wx0000000000000000）经环境共享调用 env2 时，
// 本函数返回 auth 对象，注入 env2 数据库/存储安全规则的 auth.custom 字段，
// 使 env1 能跨账号读 env2 dish_mirror / 写 env2 dish_lexicon。
const BUILD_TAG = '2026-08-22.env2-cloudbase-auth';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const ALLOWED_CALLER = 'wx0000000000000000'; // env1 小程序 AppID（调用方）

exports.main = async (event, context) => {
  console.log('[build] cloudbase_auth BUILD_TAG=' + BUILD_TAG);
  const wxContext = cloud.getWXContext();
  const caller = wxContext.FROM_APPID || (event && event.fromAppid);
  console.log('[cloudbase_auth] 调用方 AppID=' + caller);

  if (caller !== ALLOWED_CALLER) {
    return { errCode: 1, errMsg: 'forbidden caller: ' + caller };
  }

  return {
    errCode: 0,
    errMsg: '',
    auth: JSON.stringify({ fromAppid: ALLOWED_CALLER }),
  };
};