const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 管理员权威识别源：OPENID 直接比对（ID 固定 'admin'，不占用数字命名空间、不进计数器）。
const ADMIN_OPENID = process.env.ADMIN_OPENID || '';

// 计数器集合/文档：在事务内原子自增，为每个用户分配从 1 开始的顺序数字 ID。
const COUNTER_COL = 'counters';
const COUNTER_ID = 'user_no';

// ⚠️ 编号分配必须是原子操作。
// 旧实现用 `count()+1` 再 add，两个用户并发首次进入会同时读到相同 count →
// 算出相同 next → 各自 add({no:2})，而 NoSQL 对 no 无唯一约束 → 出现两个 no=2（已发生）。
// 现改为：用 counters 集合的计数器文档，在事务内读取并自增，保证并发下每个用户拿到不同编号。
async function ensureCounter() {
  // ⚠️ 计数器文档首次不存在时 doc(id).get() 会 reject（而非返回空 data），必须 .catch 兜底，
  // 否则整段编号分配抛错 → 新用户 userId 拿不到（曾被误显为管理员 0）。
  const c = await db.collection(COUNTER_COL).doc(COUNTER_ID).get().catch(() => null);
  if (c && c.data) return c.data.seq || 0;
  // 首次初始化：用当前 user_no_map 的最大 no 作为起点（freed 的编号不复用，避免与已有编号冲突）
  let maxNo = 0;
  try {
    const r = await db.collection('user_no_map').orderBy('no', 'desc').limit(1).get();
    if (r.data && r.data[0] && typeof r.data[0].no === 'number') maxNo = r.data[0].no;
  } catch (e) { /* ignore */ }
  await db.collection(COUNTER_COL).doc(COUNTER_ID).set({ data: { seq: maxNo } }).catch(() => {});
  return maxNo;
}

async function getUserId(openid) {
  // 管理员固定为 'admin'：不查/不写 user_no_map，不消耗计数器，彻底与数字编号隔离。
  if (openid === ADMIN_OPENID) return 'admin';
  const mapCol = db.collection('user_no_map');
  // 墓碑检查（权威「已注销」判定源，独立于 user_no_map）：
  // 命中 deleted_users 说明该账号已注销，绝不重建 user_no_map（否则注销后会被静默复活）
  try {
    const tombR = await db.collection('deleted_users').where({ _openid: openid }).limit(1).get();
    if (tombR.data && tombR.data.length) return '__DELETED__';
  } catch (e) { /* 墓碑查询异常不阻断 */ }
  const ex = await mapCol.where({ _openid: openid }).limit(1).get();
  if (ex.data && ex.data.length) return ex.data[0].no;

  const seq = await ensureCounter();
  for (let attempt = 0; attempt < 6; attempt++) {
    const t = await db.startTransaction();
    try {
      // 文档可能在并发下尚未就绪：get 失败兜底为 null，base 用 ensureCounter 已写入的 seq
      const c = await t.collection(COUNTER_COL).doc(COUNTER_ID).get().catch(() => null);
      const base = (c && c.data && typeof c.data.seq === 'number') ? c.data.seq : seq;
      // 不低于当前 user_no_map 最大编号，防御并发下计数器被降级
      const no = Math.max(base, seq) + 1;
      await t.collection(COUNTER_COL).doc(COUNTER_ID).update({ data: { seq: no } });
      await t.commit();
      // 以 _openid 为文档 _id 做幂等 upsert：已存在则覆盖同一条，绝不会产生第二条记录
      // （原实现先用 add() 再回退 set()，并发/重试下会留下同一 _openid 的多条记录，
      //  导致 backupData.list 后写覆盖、manageUser/grantBonus 按 no 反查命中错误 openid）。
      try {
        // ⚠️ wx-server-sdk 2.6.3 下 doc(id).set(obj) 会把 data 解析为 undefined（no 字段丢失），
        // 导致 user_no_map 有 _openid 但无 no，前端显示「未分配数字 ID」。
        // 改用 add 显式指定 _id 做幂等 upsert；冲突则 update 补写 no（update 不受影响）。
        await mapCol.add({ data: { _id: openid, _openid: openid, no, createdAt: new Date() } });
      } catch (e2) {
        // _id 唯一冲突（同 openid 已存在记录）：补写 no 字段，确保编号落库
        try {
          await mapCol.doc(openid).update({ data: { no } });
        } catch (e3) {
          const ex2 = await mapCol.where({ _openid: openid }).limit(1).get().catch(() => ({ data: [] }));
          if (!(ex2.data && ex2.data.length)) {
            console.error('[getUserId] 写入 user_no_map 失败：', e2, e3);
          }
        }
      }
      return no;
    } catch (e) {
      await t.rollback().catch(() => {});
      if (attempt >= 5) throw e;
      // 事务冲突（并发）/ 瞬时错误 → 重试
    }
  }
  throw new Error('分配用户编号失败');
}

// 构建指纹（2026-08-08 推广）
// 2026-09-07.exists-real-prefs：exists 语义改为「实质偏好字段非空」，修复 getDailyStats 自动建空档致 exists=true 的问题
// 2026-09-07.auto-reopen：已注销（墓碑命中）不再返 410 让前端加按钮/强制引导——用户再次进入即视为主动重新使用，
//   自动清墓碑并由 getUserId 分配全新编号，体验=「注销后重进自动成为新用户」（数据已由 deleteAccount 清空）。
const BUILD_TAG = '2026-09-07.auto-reopen';
console.log('[build] getPrefs BUILD_TAG=' + BUILD_TAG);

exports.main = async () => {
  console.log('[build] getPrefs BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  const res = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
  const prefs = res.data[0] || null;
  // exists 语义（2026-09-07 C+A 修正）：必须「存在实质偏好字段」才算已设偏好。
  // 此前仅判 user_preferences 文档存在——而 getDailyStats/签到等会自动给新用户建一个仅含次数的空档，
  // 导致新用户建档后 exists=true，首页永远跳过引导、结果卡不显示、次数判定错乱。
  // 偏好维度：任一数组非空 / 字符串非空即视为已设偏好（scene 等也算）。
  const PREF_KEYS = ['taste', 'spicy', 'cuisine', 'type', 'meat', 'veg', 'cookMethod', 'drink', 'avoid', 'communityIngredients', 'masterIngredients', 'scene'];
  const exists = !!(prefs && PREF_KEYS.some(k => {
    const v = prefs[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v).trim().length > 0;
  }));
  // 编号分配失败不得影响「是否已有偏好」的判定：否则前端 ensurePrefs 会因本函数抛错
  // 落入 catch 分支被弹回 setup，与「填完偏好又跳回引导页」的死循环直接相关。
  let userId = null;
  try {
    userId = await getUserId(OPENID);
  } catch (e) {
    console.error('[getPrefs] 分配用户编号失败（不影响偏好判定）：', e);
  }
  // 已注销用户（墓碑命中）：自动重新开通（2026-09-07 C+A）。
  // 注销=数据清空（deleteAccount 已删干净），用户再次进入小程序即视为「主动重新使用」→
  // 自动清墓碑并重新分配全新编号，体验与全新用户一致（exists=false 走 C+A 引导，不强制）。
  // 墓碑仍防「旧逻辑在注销后自动重建编号复活老数据」——但那些数据已删，重建也只是新号，故直接放行。
  if (userId === '__DELETED__') {
    try {
      await db.collection('deleted_users').where({ _openid: OPENID }).remove();
      userId = await getUserId(OPENID);   // 墓碑已清，重新分配新编号
      if (userId === '__DELETED__') userId = null; // 极端并发下仍可能命中，退化为 null（前端按新用户处理）
    } catch (e) {
      console.error('[getPrefs] 自动重新开通失败：', e);
      userId = null;
    }
  }
  return { code: 200, data: { exists, prefs, userId, openid: OPENID } };
};
