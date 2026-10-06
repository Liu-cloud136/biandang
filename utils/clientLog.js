// 前端轻量日志收集（2026-08-14）
// 目的：用户提交「意见反馈」时，把近期运行日志一并上报，便于维护定位问题。
// 设计约束：
//  - 纯内存环形缓冲，最多 MAX 条，避免无限占用。
//  - 自动劫持 console.error / console.warn 收集异常（保留原始输出）。
//  - 仅收集时间戳、tag、消息字符串；不收集任何用户输入明文、不收集 OPENID（云端已有）。
//  - 只在本模块内维护状态，其它页面通过 log() 显式埋点。

const MAX = 200;

let buf = [];
let hooked = false;

function stamp() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function push(tag, msg) {
  let s;
  try {
    if (msg instanceof Error) s = (msg.stack || msg.message || String(msg));
    else if (typeof msg === 'object') s = JSON.stringify(msg);
    else s = String(msg);
  } catch (e) {
    s = '[unserializable]';
  }
  // 防御：单行过长截断，避免单条日志撑爆文档
  if (s.length > 1000) s = s.slice(0, 1000) + '…(truncated)';
  buf.push('[' + stamp() + '][' + tag + '] ' + s);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

// 显式埋点
function log(tag, msg) {
  push(tag, msg === undefined ? '' : msg);
}

// 自动收集 error / warn（保留原生输出，只加一份到缓冲）
function hook() {
  if (hooked) return;
  hooked = true;
  const origErr = console.error;
  const origWarn = console.warn;
  if (typeof origErr === 'function') {
    console.error = function () {
      try { push('console.error', Array.prototype.join.call(arguments, ' ')); } catch (e) {}
      return origErr.apply(console, arguments);
    };
  }
  if (typeof origWarn === 'function') {
    console.warn = function () {
      try { push('console.warn', Array.prototype.join.call(arguments, ' ')); } catch (e) {}
      return origWarn.apply(console, arguments);
    };
  }
}

// 取回当前缓冲（数组，每行一个字符串）
function getLogs() {
  return buf.slice();
}

// 清空（提交成功后调用，避免重复上报）
function clear() {
  buf = [];
}

module.exports = { log, getLogs, clear, hook };
