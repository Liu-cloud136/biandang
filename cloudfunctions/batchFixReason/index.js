const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const ENV2_APPID = 'wx1111111111111111';
const ENV2_ENV_ID = 'your-env-id-2';
const { fetchAll } = require('./_shared/cursorFetch');

exports.main = async (event) => {
  const fix = event && event.fix;
  const aimodel = event && event.aimodel || 'deepseek-v3';
  const batch = event && event.batch || 10;
  const mode = event && event.mode || 'reason';

  let inst2;
  try {
    inst2 = new cloud.Cloud({ resourceAppid: ENV2_APPID, resourceEnv: ENV2_ENV_ID });
    await inst2.init();
  } catch (e) { return { ok: false, err: '跨账号 init 失败：' + (e.message || e) }; }

  // 取 dish_lexicon 中有 reason 的菜（作为待修复池）
  const all = await fetchAll('dish_lexicon', { name: true, reason: true });
  const pool = all.filter(d => d.reason && typeof d.reason === 'string');

  let fixed = 0, failed = 0;
  const log = [];
  for (const d of pool.slice(0, batch)) {
    const name = d.name;
    let newReason = d.reason;
    if (mode === 'reason') {
      // 示例：清理首尾空白、去重标点——实际可接 AI 润色
      newReason = d.reason.trim().replace(/\s+/g, ' ');
    }
    if (fix) {
      try {
        await db.collection('dish_lexicon').doc(name).update({ data: { reason: newReason } });
        // 同步 env2
        await inst2.database().collection('dish_mirror').where({ name }).update({ data: { reason: newReason } });
        fixed++;
      } catch (e) { failed++; log.push({ name, err: e.message || e }); }
    } else {
      log.push({ name, preview: newReason.slice(0, 30) });
    }
  }
  return { ok: true, total: pool.length, fixed, failed, log };
};
