const tcb = require('@cloudbase/node-sdk');
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const textModel = ai.createModel('cloudbase');

exports.main = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const t0 = Date.now();
  const log = [];
  try {
    const messages = [
      { role: 'system', content: '你是一个餐饮助手，用中文简短回答。' },
      { role: 'user', content: '推荐一道简单的家常菜，并一句话说明理由。' },
    ];

    const res = await textModel.streamText({ model: 'hy3', messages });

    log.push('resType=' + (res && typeof res));
    log.push('hasTextStream=' + (res && typeof res.textStream));
    log.push('hasDataStream=' + (res && typeof res.dataStream));

    // 按官方 Node SDK 文档：for await (const text of res.textStream)
    let full = '';
    let chunkCount = 0;
    const sample = [];
    if (res && res.textStream && typeof res.textStream[Symbol.asyncIterator] === 'function') {
      for await (const text of res.textStream) {
        chunkCount++;
        if (typeof text === 'string') {
          if (sample.length < 5) sample.push(text);
          full += text;
        }
      }
      log.push('streamPath=textStream');
    } else if (res && res.dataStream && typeof res.dataStream[Symbol.asyncIterator] === 'function') {
      for await (const data of res.dataStream) {
        chunkCount++;
        const piece = data && data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
        if (piece && typeof piece === 'string') {
          if (sample.length < 5) sample.push(piece);
          full += piece;
        }
      }
      log.push('streamPath=dataStream');
    } else {
      log.push('streamPath=NONE');
    }

    log.push('chunkCount=' + chunkCount);
    log.push('fullLength=' + full.length);
    log.push('elapsed=' + (Date.now() - t0) + 'ms');

    // 同时尝试取 usage / messages（官方文档示例）
    try { const u = await res.usage; log.push('usage=' + JSON.stringify(u)); } catch (e) { log.push('usageErr=' + e.message); }

    return {
      code: 200,
      mode: 'stream-ok',
      log,
      fullText: full,
      firstChunks: sample,
    };
  } catch (e) {
    log.push('ERROR=' + (e && e.message));
    log.push('stack=' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : 'n/a'));
    return { code: 500, mode: 'stream-failed', log };
  }
};
