// getSysConfig —— 前端只读灰度/运行配置。独立 Event 函数，不触碰 getRecommendation 核心逻辑。
// 仅返回白名单字段，避免泄露 sys_config 其他内部配置。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 允许前端读取的字段白名单（在 sys_config 集合里以 _id 为键的文档）
// 出文流式 stream_v2 已于 2026-08-16 彻底移除，白名单清空。
const ALLOWED = {};

exports.main = async () => {
  const out = {};
  for (const key of Object.keys(ALLOWED)) {
    try {
      const doc = await db.collection('sys_config').doc(key).get();
      out[key] = doc && doc.data ? doc.data.enabled : ALLOWED[key];
    } catch (e) {
      out[key] = ALLOWED[key]; // 缺失则取默认
    }
  }
  return { ok: true, config: out };
};
