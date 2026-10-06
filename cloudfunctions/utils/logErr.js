// 共享错误日志 helper：把函数运行错误写入 function_errors 集合（供每日报告汇总）。
// 各云函数通过本地副本 require 使用（云函数不能跨目录 require）。
const cloud = require('wx-server-sdk');

async function logErr(fn, e) {
  try {
    const db = cloud.database();
    await db.collection('function_errors').add({
      data: { fn, msg: (e && e.message) || String(e), ts: db.serverDate() }
    });
  } catch (_) { /* 写入失败不阻塞主流程 */ }
}

module.exports = { logErr };
