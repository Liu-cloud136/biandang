// adminGeneric —— 通用配置兼容接口（管理员后台用，2026-08-18）
//
// 目的：在不重构现有各 manage* 函数、不动前端的前提下，提供一个「集合+字段白名单」驱动的
//       通用读写通道。以后新增 A 类 / 简单 B 类管理功能，只需：
//         1) 在下方 ALLOWED 白名单登记（集合 + 允许字段 + 类型）
//         2) 业务云函数直接读 sys_config 对应文档
//       即可生效，无需为功能改代码发版（改已登记字段的值更是零发版）。
//
// action：
//   genericGet    → { collection, docId }  读回一条白名单内配置文档
//   genericUpsert → { collection, docId, fields }  白名单校验后写 sys_config（含自定义字段，不含 secret）
//   updateSecret  → { key, value }  把密钥写入云函数环境变量（CUSTOM_AI_KEY / CUSTOM_IMAGE_KEY 等），
//                                       不落库明文、日志脱敏
//
// 安全：① 集合+字段必须登记，未登记拒绝（防任意写库，R5）；
//       ② secret 永远不进 genericUpsert 的 fields，只能走 updateSecret 写环境变量；
//       ③ 日志不打印密钥明文（R12）。
//
// 权限：仅管理员 OPENID 可调用（与现有 manage* 一致）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));

// 允许操作的集合（仅 sys_config 树；如需扩展到其他集合，在此加项）
// 每个集合登记允许写入的字段名 + 类型，未登记字段一律拒绝。
const ALLOWED = {
  sys_config: {
    // 文本自定义 AI 开关
    ai_custom: {
      enabled: 'boolean',
      mode: { enum: ['fallback', 'replace'] },
      baseUrl: 'string',
      model: 'string'
    },
    // 图像自定义 AI 开关
    ai_custom_image: {
      enabled: 'boolean',
      mode: { enum: ['fallback', 'replace'] },
      baseUrl: 'string',
      model: 'string'
    }
    // 以后加新 A 类 / 简单 B 类功能：在此追加一行 docId + 字段定义即可，免改前端
  }
};

// 允许写入环境变量的密钥名白名单（防任意环境变量覆盖）
const ALLOWED_SECRET_KEYS = ['CUSTOM_AI_KEY', 'CUSTOM_IMAGE_KEY'];

const BUILD_TAG = '2026-08-26.adminGeneric-set-no-add-id';
console.log('[build] adminGeneric BUILD_TAG=' + BUILD_TAG);

async function readDoc(collection, docId) {
  try {
    const r = await db.collection(collection).doc(docId).get();
    return (r && r.data) || null;
  } catch (e) { return null; }
}

function validateField(spec, value) {
  if (spec === 'boolean') return typeof value === 'boolean';
  if (spec === 'string') return typeof value === 'string';
  if (spec && spec.enum) return spec.enum.includes(value);
  return false;
}

function sanitize(v) {
  // 仅允许基础类型序列化，防原型污染 / 函数注入
  if (v === null || v === undefined) return v;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (/^__proto__$|^constructor$|^prototype$/i.test(k)) continue;
      out[k] = sanitize(v[k]);
    }
    return out;
  }
  return undefined;
}

exports.main = async (event) => {
  console.log('[build] adminGeneric BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const action = (event && event.action) || 'genericGet';
  const collection = (event && event.collection) || 'sys_config';

  // 集合必须在白名单内
  const colSpec = ALLOWED[collection];
  if (!colSpec) return { code: 400, msg: '集合未授权: ' + collection };

  if (action === 'genericGet') {
    const docId = event.docId;
    if (!docId || !colSpec[docId]) return { code: 400, msg: 'docId 未授权: ' + docId };
    const doc = await readDoc(collection, docId);
    // 返回时剥离开头下划线字段（如 _id, _openid）避免泄露
    const safe = {};
    if (doc) {
      for (const f of Object.keys(colSpec[docId])) {
        if (Object.prototype.hasOwnProperty.call(doc, f)) safe[f] = doc[f];
      }
    }
    return { code: 0, data: safe };
  }

  if (action === 'genericUpsert') {
    const docId = event.docId;
    const fields = event.fields;
    if (!docId || !colSpec[docId]) return { code: 400, msg: 'docId 未授权: ' + docId };
    if (!fields || typeof fields !== 'object') return { code: 400, msg: 'fields 缺失或非法' };

    const spec = colSpec[docId];
    const payload = {};
    for (const f of Object.keys(fields)) {
      if (!spec[f]) return { code: 400, msg: '字段未授权: ' + f }; // 含 secret 字段一律拒绝
      const val = sanitize(fields[f]);
      if (!validateField(spec[f], val)) return { code: 400, msg: '字段类型不符: ' + f };
      payload[f] = val;
    }
    if (Object.keys(payload).length === 0) return { code: 400, msg: '无有效字段' };

    payload.updatedAt = Date.now();
    const existing = await readDoc(collection, docId);
    try {
      if (existing) {
        await db.collection(collection).doc(docId).update({ data: payload });
      } else {
        await db.collection(collection).doc(docId).set({ data: payload });
      }
    } catch (e) {
      return { code: 500, msg: '写库失败: ' + ((e && e.message) || e) };
    }
    return { code: 0, msg: 'ok', data: payload };
  }

  if (action === 'updateSecret') {
    const key = event.key;
    const value = event.value;
    if (!ALLOWED_SECRET_KEYS.includes(key)) return { code: 400, msg: '密钥名未授权: ' + key };
    if (typeof value !== 'string' || value.length === 0) return { code: 400, msg: '密钥值非法' };
    // 走环境变量：通过 CloudBase MCP manageFunctions(updateFunctionConfig) 或在控制台配置。
    // 本函数只做「登记合法性 + 提示」，实际写入由部署侧 / 控制台完成（避免运行时改自身环境变量）。
    // 返回需要配置的环境变量名，供管理员在控制台/部署脚本里落地。
    console.log('[adminGeneric] updateSecret 请求 key=' + key + ' (value 已脱敏, 长度=' + value.length + ')');
    return {
      code: 0,
      msg: '密钥需在云函数环境变量中配置（控制台或部署脚本），本接口已校验合法性。',
      needEnv: { key: key, hint: '请在 adminGeneric 云函数环境变量中设置该 key（不落库、日志脱敏）' }
    };
  }

  return { code: 400, msg: '未知 action: ' + action };
};
