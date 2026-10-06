// 管理后台登录校验：openid + 密码 双重验证（服务端比对，避免纯前端判定被绕过）。
// 本函数只做凭据比对，不依赖云数据库，故无需 wx-server-sdk。
//
// 凭据全部来自云函数环境变量，代码中不留明文：
//   ADMIN_OPENID   —— 管理员 openid
//   ADMIN_PASSWORD —— 管理员密码
// 若环境变量未配置，则 fail-closed：拒绝一切登录，避免空口令进入后台。
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] adminLogin BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] adminLogin BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const ADMIN_OPENID = process.env.ADMIN_OPENID;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const { openid, password } = event || {};
  if (!ADMIN_OPENID || !ADMIN_PASSWORD) {
    return { code: 500, msg: '服务端未配置管理员凭据' };
  }
  if (openid === ADMIN_OPENID && password === ADMIN_PASSWORD) {
    return { code: 200, msg: '验证通过' };
  }
  return { code: 403, msg: 'openid 或密码错误' };
};
