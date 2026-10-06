// 流式首字探针 v2 —— 真 AI 流式（混元 hy3 streamText + SSE）
// 验证 wx.cloud.callHTTPFunction + enableChunked + SSE 在免费环境真能分块收到 AI 生成的首字。
// 链路已验证通过（v1 模拟分块），本版替换为真实 streamText 输出。
const http = require('http');
const tcb = require('@cloudbase/node-sdk');

const PORT = 9000;
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const model = ai.createModel('cloudbase');

const DEFAULT_PROMPT = '请用一句话给一个正在纠结「今天吃啥」的朋友，推荐一道家常菜，并附一句随口的推荐理由（不超过20字）。';

// 单个查询参数解码：畸形转义（例如 ?a=%）会让 decodeURIComponent 抛 URIError。
// 逐项兜住 —— 坏的那一项退化为原串，其余参数照常解析。
// 比在调用处整体 try/catch 更好：后者会因为一个坏参数丢掉整个 query。
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return String(s); }
}

function parseQuery(url) {
  const raw = (url || '').split('?')[1] || '';
  // 无原型对象：查询串的键完全来自外部，不给 Object.prototype 任何可乘之机
  const params = Object.create(null);
  raw.split('&').forEach(p => {
    if (!p) return;
    const i = p.indexOf('=');
    if (i < 0) params[safeDecode(p)] = '';
    else params[safeDecode(p.slice(0, i))] = safeDecode(p.slice(i + 1));
  });
  return params;
}

const server = http.createServer(async (req, res) => {
  if (req.url && req.url.indexOf('/stream') === 0) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'X-Accel-Buffering': 'no'  // 关掉代理缓冲，保证分块即时下发（关键！否则被缓冲成一次返回）
    });
    const params = parseQuery(req.url);
    const prompt = (params.q && params.q.trim()) || DEFAULT_PROMPT;
    // 上游 cloudbase 分组免费额度并发限额低，瞬时抖动会报「超出并发限制」(429 类)。
    // 仅对限流类错误做短退避重试，吸收抖动；逻辑错误直接放弃。
    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await model.streamText({
          model: 'hy3',
          messages: [{ role: 'user', content: prompt }],
          temperature: 1.0,
          topP: 0.9
        });
        break; // 拿到可迭代对象即建立成功，跳出重试
      } catch (e) {
        lastErr = e;
        const msg = (e && e.message) || '';
        const overloaded = /并发限制|429|rate.?limit|too many requests|quota/i.test(msg);
        console.warn('[streamProbe] streamText failed(第' + (attempt + 1) + '次):', msg, 'overloaded=', overloaded);
        if (!overloaded) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (!result) {
      console.error('[streamProbe] 重试后仍失败:', lastErr && lastErr.message);
      res.write('event: error\ndata: ' + JSON.stringify({ message: (lastErr && lastErr.message) || 'stream failed' }) + '\n\n');
      res.end();
      return;
    }
    try {
      for await (const text of result.textStream) {
        // SSE data 行不允许裸换行，把文本内换行压成空格
        const safe = String(text).replace(/\r?\n/g, ' ');
        res.write('data: ' + safe + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.error('[streamProbe] stream error:', e && e.message);
      res.write('event: error\ndata: ' + JSON.stringify({ message: e && e.message }) + '\n\n');
      res.end();
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('streamProbe v2 (AI stream) ok');
});

server.listen(PORT, () => {
  console.log('[streamProbe] listening on', PORT);
});
