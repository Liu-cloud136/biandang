const cloud = require('wx-server-sdk');
const tcb = require('@cloudbase/node-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const TCB_ENV = process.env.TCB_ENV || 'your-env-id-1'; // 支持环境变量覆盖，便于环境迁移
const app = tcb.init({ env: TCB_ENV, timeout: 10000 });
const ai = app.ai();
const model = ai.createModel('cloudbase');
const TEXT_MODEL = 'hy3'; // 混元文本模型（原 deepseek-v4-flash 模型不对，改为 hy3）
const db = app.database(); // 供 aiGateway 读取 sys_config/ai_custom
const aiGateway = require('./utils/aiGateway');

// —— 文本生成（hy3-preview 2026-08-31 已下线，仅 hy3 单一通道）——
// 2026-08-18: 硅基流动 SF 兜底 与 自定义端点 逻辑已收口到共享网关 utils/aiGateway.js。
// 旧 callSiliconFlow 函数在此删除，避免与网关重复实现。

// 统一文本生成 + 多后端降级封装（2026-08-18 改为走 aiGateway.callUnifiedText）。
// 网关读 sys_config/ai_custom（enabled/mode/baseUrl/model），按 mode 编排降级链；
// 过敏原校验 enableSF:true，混元+自定义均失败时借 SF 兜底。
async function genTextWithFallback(messages, opts) {
  const temperature = (opts && opts.temperature != null) ? opts.temperature : 0;
  const topP = (opts && opts.topP != null) ? opts.topP : 0.9;
  const enableSF = !!(opts && opts.enableSF);
  const label = (opts && opts.label) || 'gen';
  const maxTokens = (opts && opts.maxTokens) || 4;
  const callHy3 = async () => model.generateText({ model: TEXT_MODEL, messages, temperature, topP, maxTokens });
  const calls = { callHy3 };
  const gwOpts = { temperature, topP, primary: 'hy3', maxTokens, label, enableSF, sfOpts: { maxTokens: 32 } };
  return await aiGateway.callUnifiedText(messages, gwOpts, calls, db);
}

// 过敏原有效性 AI 校验（轻量，<0.5s）
// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-27.env1-hy3-preview-removed';
console.log('[build] validateAllergen BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] validateAllergen BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { text } = event || {};
  if (!text || !text.trim()) return { code: 400, msg: '输入为空' };
  const t = text.trim();

  const allergenPrompt = `判断输入「${t}」是否为真实的食物过敏原（指食用后可能引发过敏反应的食材或物质）。仅回答"是"或"否"，不要解释。`;
  // 过敏原校验链路：hy3 单一通道(限流退避重试 1 次) → 自定义 → 硅基流动兜底(enableSF:true)。统一走 genTextWithFallback。
  let r;
  try {
    r = await genTextWithFallback([{ role: 'user', content: allergenPrompt }], { temperature: 0, maxTokens: 4, primary: 'hy3', enableSF: true, label: 'allergen' });
  } catch (e) {
    console.error('[validateAllergen] hy3→自定义→SF 均失败，校验失败：', (e && e.message) || e);
    return { code: 500, msg: '校验失败' };
  }
  const ans = (r.text || '').trim();
  const valid = ans === '是' || ans.startsWith('是');
  return { code: 200, data: { valid, reason: valid ? '' : '「' + t + '」不是有效过敏原' } };
};
