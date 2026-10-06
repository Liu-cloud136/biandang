// ============================================================================
// aiProbe · env2 cloud.ai() 阶段0 探针（方案 §7 阶段0，只探路不改主流程）
// BUILD_TAG: 2026-08-21.ai-probe-phase0
//
// 目的：确认 env2 环境 cloud.ai() 已开通可用、消耗的是 env2 免费额度，而非报未开通。
//   - hy3 文本：ai.createModel('cloudbase') → textModel.generateText({ model:'hy3' })
//   - 生图：ai.createImageModel('hunyuan-image') → generateImage({ model:'HY-Image-3.0-Plus-4090-Tob-v1.0' })
//
// 纪律：
//   - 探针绝不写入 env1、不触发跨账号、不持久化图片（仅验证可用性）。
//   - 所有调用只记 env2 本地 bypass_log / console，失败静默。
//   - 阶段0 验证标准：env2 额度 usage AI DeductValue > 0（MCP 查 env usage）。
// ============================================================================

const BUILD_TAG = '2026-08-21.ai-probe-phase0';
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const tcb = require('@cloudbase/node-sdk');

const TCB_ENV = process.env.TCB_ENV || 'your-env-id-2';
const app = tcb.init({ env: TCB_ENV, timeout: 60000 });
const ai = app.ai();
const imageModelObj = ai.createImageModel('hunyuan-image');
const IMAGE_MODEL_ID = 'HY-Image-3.0-Plus-4090-Tob-v1.0';

exports.main = async (event) => {
  console.log('[build] aiProbe BUILD_TAG=' + BUILD_TAG);
  const db = cloud.database();
  const { task } = event || {};

  // health：验证函数本体与 BUILD_TAG 命中
  if (task === 'health') {
    return { ok: true, build: BUILD_TAG, env: TCB_ENV };
  }

  const result = {
    ok: true,
    build: BUILD_TAG,
    text: null,
    image: null,
    err: null,
  };

  // 1) hy3 文本探针（默认跑）
  if (task !== 'image-only') {
    try {
      const textModel = ai.createModel('cloudbase');
      const textResp = await textModel.generateText({
        model: 'hy3',
        messages: [{ role: 'user', content: '你是探针。请只回复两个汉字：成功' }],
        temperature: 0.5,
        maxTokens: 16,
      });
      // hy3 文本标准返回：{ text: '...' }
      const text = textResp && (textResp.text || textResp.data && textResp.data.text) || '';
      result.text = { ok: !!text, len: text.length, preview: text.slice(0, 50) };
      console.log('[aiProbe] hy3 文本探针 ->', JSON.stringify(result.text));
      await logTask(db, 'aiProbe-text', result.text.ok ? 'ok' : 'fail', 'len=' + text.length);
    } catch (e) {
      result.text = { ok: false, err: (e && e.message) || String(e) };
      result.ok = false;
      console.error('[aiProbe] hy3 文本探针失败：', (e && e.message) || e);
      await logTask(db, 'aiProbe-text', 'fail', (e && e.message) || String(e));
    }
  }

  // 2) 生图探针（默认跑）
  if (task !== 'text-only') {
    try {
      const img = await imageModelObj.generateImage({
        model: IMAGE_MODEL_ID,
        prompt: '一碗热气腾腾的番茄鸡蛋面，写实摄影，浅色陶瓷碗，桌面干净',
        size: '768x768',
        revise: { value: false },
      });
      const url = img && img.data && img.data[0] && img.data[0].url || '';
      result.image = { ok: !!url, urlPreview: url.slice(0, 60) };
      console.log('[aiProbe] 生图 ok ->', JSON.stringify(result.image));
      await logTask(db, 'aiProbe-image', url ? 'ok' : 'fail', url ? '' : 'empty_url');
    } catch (e) {
      result.image = { ok: false, err: (e && e.message) || String(e) };
      result.ok = false;
      console.error('[aiProbe] 生图探针失败：', (e && e.message) || e);
      await logTask(db, 'aiProbe-image', 'fail', (e && e.message) || String(e));
    }
  }

  return result;
};

async function logTask(db, task, status, errMsg) {
  try {
    await db.collection('bypass_log').add({
      data: { task, _openid: null, status, errMsg: errMsg || '', computedAt: Date.now() },
    });
  } catch (e) { /* 日志失败不影响主流程 */ }
}