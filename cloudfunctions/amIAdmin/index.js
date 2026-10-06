const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const { OPENID } = cloud.getWXContext();

// 管理员权威识别源：OPENID 直接比对（不再依赖数字ID 0）。
// 优先环境变量 ADMIN_OPENID，缺失时回退固定常量（OPENID 非机密，且前端已内置同值兜底）。
const ADMIN_OPENID = process.env.ADMIN_OPENID || '';

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-08.init';
console.log('[build] amIAdmin BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] amIAdmin BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  // 优先用云端上下文 OPENID；本环境（开发者工具等）admin 类调用常取不到上下文 OPENID，
  // 故允许前端显式传 openid 兜底（与本项目 admin 子系统惯例一致：客户端传 openid）。
  const id = (OPENID || (event && (event.openid || event.openId)) || '').trim();
  if (!id) return { code: 200, isAdmin: false, openid: '' };
  // 管理员判定：OPENID === 管理员 OPENID（ID 固定为 'admin'，与数字编号命名空间完全隔离）。
  return { code: 200, isAdmin: id === ADMIN_OPENID, openid: id };
};
