// aiGateway.js —— AI 自定义通道 + 统一降级网关（共享模块，各云函数放副本）
// 设计原则：
//   1) 本模块不持有任何混元/AI 实例，所有混元调用通过「闭包参数」注入（callHy3 / callHunyuanImage），
//      以适配各云函数不同的信号量/单例实现（副本铁律：各函数放自己的副本，不跨函数 require）。
//   2) 自定义端点（文本/图像）走 OpenAI 兼容协议；key 只从 process.env 读取，绝不落库明文、绝不硬编码。
//   3) 配置来自 sys_config/ai_custom（文本）与 sys_config/ai_custom_image（图像），
//      结构 {enabled, mode:'fallback'|'replace', baseUrl, model, keyRef}。
//      mode:'fallback' → 混元主、自定义兜底；mode:'replace' → 自定义主、混元退后。
//   4) 文本降级链末端保留硅基流动 SF（仅 enableSF 的校验步启用），SF 在此收口统一实现。
//   5) 所有外部 https 调用带超时 + 错误脱敏（不打印 key/完整 token）。
//
// BUILD_TAG 由引入方主文件统一记录；本模块仅做逻辑，不打印 BUILD_TAG。

// 副本同步版本号：每次修改本模块后须 bump 此常量，并把副本同步到其余三个云函数目录，再跑 scripts/check_ai_gateway.js 校验。
const AI_GATEWAY_VERSION = '2026-08-27.hy3-only-single-retry';

const https = require('https');

function httpsPostJson(urlStr, headers, payloadObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('非法 URL: ' + urlStr)); }
    const payload = JSON.stringify(payloadObj);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers)
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { resolve(body); });
    });
    const timer = setTimeout(() => { req.destroy(new Error('请求超时')); }, timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.on('timeout', () => { clearTimeout(timer); req.destroy(new Error('请求超时')); });
    req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 配置读取（缺省安全）────────────────────────────────────────────
async function loadAiCustomConfig(db) {
  try {
    const d = await db.collection('sys_config').doc('ai_custom').get();
    const data = (d && d.data) || {};
    return {
      enabled: !!data.enabled,
      mode: data.mode === 'replace' ? 'replace' : 'fallback',
      baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl.trim() : '',
      model: typeof data.model === 'string' ? data.model.trim() : ''
    };
  } catch (e) { return { enabled: false, mode: 'fallback', baseUrl: '', model: '' }; }
}

async function loadAiImageConfig(db) {
  try {
    const d = await db.collection('sys_config').doc('ai_custom_image').get();
    const data = (d && d.data) || {};
    return {
      enabled: !!data.enabled,
      mode: data.mode === 'replace' ? 'replace' : 'fallback',
      baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl.trim() : '',
      model: typeof data.model === 'string' ? data.model.trim() : ''
    };
  } catch (e) { return { enabled: false, mode: 'fallback', baseUrl: '', model: '' }; }
}

// ── 自定义文本端点（OpenAI 兼容 /chat/completions）──────────────────
// 缺省 baseUrl/model 回退代码常量（保留原 qnaigc 测试通道作默认兜底值）。
const DEFAULT_CUSTOM_BASE = 'https://api.qnaigc.com/v1';
const DEFAULT_CUSTOM_MODEL = 'deepseek/deepseek-v4-flash-20260731';

async function callCustomText(messages, cfg, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  const key = process.env.CUSTOM_AI_KEY;
  if (!key) throw new Error('CUSTOM_AI_KEY 未配置');
  const baseUrl = cfg.baseUrl || DEFAULT_CUSTOM_BASE;
  const model = cfg.model || DEFAULT_CUSTOM_MODEL;
  const body = await httpsPostJson(
    baseUrl.replace(/\/$/, '') + '/chat/completions',
    { 'Authorization': 'Bearer ' + key },
    { model, messages, stream: false, max_tokens: 1500, temperature: 0.9, top_p: 0.9 },
    timeoutMs
  );
  let j;
  try { j = JSON.parse(body); } catch (err) { throw new Error('CUSTOM_AI 响应非 JSON: ' + body.slice(0, 120)); }
  if (j && j.error) throw new Error('CUSTOM_AI 错误 ' + (j.error.code || '') + ' ' + (j.error.message || ''));
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (text == null) throw new Error('CUSTOM_AI 返回无 content');
  return String(text);
}

// ── 自定义图像端点（OpenAI 兼容 /images/generations）────────────────
// 返回 { url }（也兼容 b64_json，转成 data URL）。
async function callCustomImage(prompt, cfg, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 30000;
  const key = process.env.CUSTOM_IMAGE_KEY;
  if (!key) throw new Error('CUSTOM_IMAGE_KEY 未配置');
  const baseUrl = cfg.baseUrl || '';
  if (!baseUrl) throw new Error('CUSTOM_IMAGE baseUrl 未配置');
  const model = cfg.model || '';
  const body = await httpsPostJson(
    baseUrl.replace(/\/$/, '') + '/images/generations',
    { 'Authorization': 'Bearer ' + key },
    { model: model || undefined, prompt, n: 1, size: '768x768', response_format: 'url' },
    timeoutMs
  );
  let j;
  try { j = JSON.parse(body); } catch (err) { throw new Error('CUSTOM_IMAGE 响应非 JSON: ' + body.slice(0, 120)); }
  if (j && j.error) throw new Error('CUSTOM_IMAGE 错误 ' + (j.error.code || '') + ' ' + (j.error.message || ''));
  const item = j && j.data && j.data[0];
  if (!item) throw new Error('CUSTOM_IMAGE 返回无数据');
  return { url: item.url || (item.b64_json ? 'data:image/png;base64,' + item.b64_json : '') };
}

// ── 硅基流动 SF 兜底（在此收口，参数化 maxTokens 以适配各调用点）─────
async function callSiliconFlow(messages, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 12000;
  const sfModel = (opts && opts.sfModel) || 'deepseek-ai/DeepSeek-V3';
  const maxTokens = (opts && opts.maxTokens) != null ? opts.maxTokens : 800;
  const key = process.env.SF_KEY;
  if (!key) throw new Error('SF_KEY 未配置');
  const body = await httpsPostJson(
    'https://api.siliconflow.cn/v1/chat/completions',
    { 'Authorization': 'Bearer ' + key },
    { model: sfModel, messages, stream: false, max_tokens: maxTokens },
    timeoutMs
  );
  let j;
  try { j = JSON.parse(body); } catch (err) { throw new Error('SF 响应非 JSON: ' + body.slice(0, 120)); }
  if (j && j.code) throw new Error('SF 错误 ' + j.code + ' ' + (j.message || ''));
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (text == null) throw new Error('SF 返回无 content');
  return String(text);
}

// ── 统一文本降级网关 ──────────────────────────────────────────────
// 参数：
//   messages, opts{temperature,topP,primary,maxTokens,label,enableSF,sfOpts}
//   calls: { callHy3 } —— 注入的混元调用闭包，返回 {text} 或抛错（hy3-preview 已下线，仅 hy3）
//   db —— 用于读 ai_custom 配置
// 降级链（hy3 主通道，限流退避重试 1 次）：
//   mode:'fallback' : hy3 → 自定义 → [SF]
//   mode:'replace'  : 自定义 → hy3 → [SF]
async function callUnifiedText(messages, opts, calls, db) {
  const label = (opts && opts.label) || 'gen';
  const enableSF = !!(opts && opts.enableSF);
  const temperature = (opts && opts.temperature != null) ? opts.temperature : 0.9;
  const topP = (opts && opts.topP != null) ? opts.topP : 0.9;
  const primary = (opts && opts.primary) || 'hy3';
  const maxTokens = (opts && opts.maxTokens) != null ? opts.maxTokens : 1200;

  const cfg = await loadAiCustomConfig(db);
  const useCustom = cfg.enabled && cfg.baseUrl && cfg.model;

  const callHy3 = async () => calls.callHy3(messages, { temperature, topP, maxTokens, primary });
  const tryCustom = async () => {
    const t = await callCustomText(messages, cfg, { timeoutMs: 15000 });
    console.log('[aiGateway](' + label + ') 借自定义端点兜底/主通道');
    return { text: t };
  };
  const trySF = async () => {
    const sfText = await callSiliconFlow(messages, Object.assign({ maxTokens: 32 }, opts && opts.sfOpts));
    console.log('[aiGateway](' + label + ') 借硅基流动兜底');
    return { text: sfText };
  };

  // replace 模式：自定义先行
  if (useCustom && cfg.mode === 'replace') {
    try { return await tryCustom(); }
    catch (e) { console.warn('[aiGateway](' + label + ') 自定义主通道失败, 回退混元: ' + ((e && e.message) || e)); }
  }

  // 混元主链路（hy3-preview 2026-08-31 已下线，仅 hy3 单一通道）
  // 2026-08-27：hy3-preview 8-31 下线，移除 preview 链路。
  // hy3 限流(SlotBusyError/429) 退避重试 1 次（sleep 1500）→ 再失败走 custom → [SF] → throw。
  // 只试 1 次：不因重试拖慢主出文流程（定稿决策）。
  const runHunyuan = async () => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await callHy3(); }
      catch (e) {
        lastErr = e;
        const isBusy = e instanceof Error && /429|Too Many|rate limit|EXCEED|busy/i.test(String(e.message || ''));
        if (isBusy && attempt === 0) {
          console.warn('[aiGateway](' + label + ') hy3 限流, 退避重试 1 次');
          await sleep(1500);
          continue;
        }
        if (useCustom) { try { return await tryCustom(); } catch (e3) { console.warn('[aiGateway](' + label + ') 自定义兜底失败: ' + ((e3 && e3.message) || e3)); } }
        if (enableSF) return await trySF();
        throw e;
      }
    }
    throw lastErr;
  };

  const hunyuanResult = await runHunyuan();
  if (hunyuanResult) return hunyuanResult;

  // fallback 模式且混元成功 → 直接返回（上面已 return）；若混元失败且未用 SF/custom，上面已抛。
  // 仅当 fallback 模式且 useCustom 但混元成功时不会到这里。
  throw new Error('[aiGateway](' + label + ') 未产生结果');
}

// ── 统一图像降级网关 ──────────────────────────────────────────────
// 参数：
//   prompt, db, calls{ callHunyuanImage(prompt)->{url} }
//   enabled=false 或配置不全 → 走混元；enabled=true 且 baseUrl/model 全 → 走自定义
async function callUnifiedImage(prompt, db, calls) {
  const cfg = await loadAiImageConfig(db);
  const useCustom = cfg.enabled && cfg.baseUrl && cfg.model;
  if (!useCustom) {
    return await calls.callHunyuanImage(prompt); // 现状混元，零影响
  }
  try {
    const r = await callCustomImage(prompt, cfg, { timeoutMs: 30000 });
    if (!r || !r.url) throw new Error('自定义图像返回空');
    return r; // { url }
  } catch (e) {
    console.warn('[aiGateway] 自定义图像失败, 回退混元: ' + ((e && e.message) || e));
    return await calls.callHunyuanImage(prompt);
  }
}

module.exports = {
  loadAiCustomConfig, loadAiImageConfig,
  callCustomText, callCustomImage, callSiliconFlow,
  callUnifiedText, callUnifiedImage
};
