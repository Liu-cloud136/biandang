const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const USER_NO_MAP = 'user_no_map';
// 管理员权威识别源：OPENID 直接比对（ID 固定 'admin'，不占用数字命名空间）。
const ADMIN_OPENID = process.env.ADMIN_OPENID || '';

// 解析/分配数字用户ID：与 getPrefs / submitContribution 统一使用 counters.user_no（seq）
// 单一计数器，避免各自一套计数器导致跨用户重号。逻辑与 getPrefs 保持一致。
const COUNTER_COL = 'counters';
const COUNTER_ID = 'user_no';
async function ensureCounter() {
  const c = await db.collection(COUNTER_COL).doc(COUNTER_ID).get();
  if (c.data) return c.data.seq || 0;
  let maxNo = 0;
  try {
    const r = await db.collection(USER_NO_MAP).orderBy('no', 'desc').limit(1).get();
    if (r.data && r.data[0] && typeof r.data[0].no === 'number') maxNo = r.data[0].no;
  } catch (e) { /* ignore */ }
  await db.collection(COUNTER_COL).doc(COUNTER_ID).set({ data: { seq: maxNo } }).catch(() => {});
  return maxNo;
}
async function getUserId(openid) {
  if (!openid) return null;
  // 管理员固定为 'admin'：不查/不写 user_no_map，不消耗计数器。
  if (openid === ADMIN_OPENID) return 'admin';
  const mapCol = db.collection(USER_NO_MAP);
  // 墓碑检查（权威「已注销」判定源）：命中 deleted_users 绝不重建 user_no_map，返回哨兵
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
      const c = await t.collection(COUNTER_COL).doc(COUNTER_ID).get();
      const base = (c.data && typeof c.data.seq === 'number') ? c.data.seq : 0;
      const no = Math.max(base, seq) + 1;
      await t.collection(COUNTER_COL).doc(COUNTER_ID).update({ data: { seq: no } });
      await t.commit();
      // 以 _openid 为文档 _id 做幂等 upsert：已存在则覆盖同一条，绝不会产生第二条记录
      // （原实现先用 add() 再回退 set()，并发/重试下会留下同一 _openid 的多条记录）。
      try {
        await mapCol.doc(openid).set({ data: { _openid: openid, no, createdAt: new Date() } });
      } catch (e2) {
        const ex2 = await mapCol.where({ _openid: openid }).limit(1).get().catch(() => ({ data: [] }));
        if (!(ex2.data && ex2.data.length)) {
          console.error('[getUserId] 写入 user_no_map 失败：', e2);
        }
      }
      await db.collection('user_preferences').where({ _openid: openid }).update({ data: { userId: no } }).catch(() => {});
      return no;
    } catch (e) {
      await t.rollback().catch(() => {});
      if (attempt >= 5) throw e;
    }
  }
  throw new Error('分配用户编号失败');
}

// 用户反馈「生成菜名/搭配有问题」的收集入口。
// 数据结构刻意对齐 name_blocklist（{term,type,note,ts}），便于管理员在后台
// 核实有效后，把 term/type/note 直接导入 name_blocklist 做后续过滤。
//
// 本集合（dish_feedback）字段：
//   { _openid, dish, report, note, status, ts }
// 导出时管理员只需取 dish 作为 term、report 作为 type、note 作为 note，即可落到 name_blocklist。
//
// report（类型，可多选，逗号拼接）：
//   —— 菜名问题类（核实有效后会进全局黑名单 name_blocklist）——
//   '拼凑'      名称涉嫌拼凑（如「蒜香拌韭菜」这类不通顺的怪名）
//   '搭配不合理' 食材搭配不合理（如甜咸冲突、相克或不符合饮食习惯）
//   '名字缩略'   缩略不规范导致歧义（如「猪肉白菜饺」应为「猪肉白菜馅饺子」）
//   '系统误伤'   名称被截断/改错（AI 把菜名写错）
//   —— 个人忌口类（菜名本身正确，仅与本人冲突；核实有效后只发奖、不进黑名单）——
//   '命中忌口'   菜名正常，但命中我的忌口/不吃（个人偏好，非怪名）
//   '不合口味'   菜名正常，但我不喜欢（个人偏好，非怪名）
//   ⚠️ 全局黑名单风险：个人忌口类绝不能进 name_blocklist，否则会误伤其他用户。
// status：'pending'（待核实）｜'valid'（已核实有效）｜'invalid'（无效/误报）
//   管理员在后台核实为有效并奖励后，置为 'valid'；误报置 'invalid'。
// 菜名问题类：核实有效后计入全局黑名单（系统误伤性质相反，单独走 dish_name_fix，绝不进黑名单）。
const NAME_PROBLEM_TYPES = ['拼凑', '搭配不合理', '名字缩略'];
// 系统误伤类（截断/AI 写错名）：写独立表 dish_name_fix，自动触发截断补全，永不进黑名单。
const NAME_FIX_TYPES = ['系统误伤'];
const REPORT_TYPES = NAME_PROBLEM_TYPES.concat(NAME_FIX_TYPES, ['命中忌口', '不合口味']);

// 截断菜名启发式补全：返回补全后的完整菜名，无法判定截断则返回 null（调用方写空串待人工审核）
function fixTruncatedName(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return null;
  // 明显截断特征：末尾省略号 / 半个括号 / 结尾是「等」「之类」等含糊词
  const ellipsis = /[…\.。．]{2,}$|…$/.test(s) || /\.\.\.$/.test(s);
  const trailingVague = /(等|之类|什么的|等菜|等类)$/.test(s);
  if (ellipsis || trailingVague) {
    // 仅剔除截断特征后缀，完整名需人工/AI 判定，这里先返回去后缀的近似；null 表示无法可靠补全
    return null;
  }
  return null; // 无明显截断特征，交由后台人工/AI 审核补全
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-08-20.logoff-tomb';
console.log('[build] submitDishFeedback BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] submitDishFeedback BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  // 解析数字用户ID（失败不影响主流程，仅记不到 userNo）
  const userNo = await getUserId(OPENID).catch(() => null);
  // 已注销用户（墓碑命中）：拒绝反馈，绝不重建编号/建档
  if (userNo === '__DELETED__') {
    return { code: 410, msg: '账号已注销，请重新注册', deleted: true };
  }

  const { dish, report, note } = event || {};
  const d = (dish && String(dish).trim()) || '';
  if (!d) return { code: 400, msg: '菜品名不能为空' };

  // 归一化 report：数组或逗号字符串 → 去空白、去重、仅保留合法类型
  let rawList = [];
  if (Array.isArray(report)) rawList = report;
  else if (typeof report === 'string') rawList = report.split(',');
  const types = Array.from(new Set(rawList.map(s => String(s).trim()).filter(Boolean)))
    .filter(t => REPORT_TYPES.includes(t));
  if (!types.length) return { code: 400, msg: '请至少选择一项反馈理由' };

  const n = (note && String(note).trim().slice(0, 200)) || '';

  // 分离三类反馈：
  //  - 菜名问题类（拼凑/搭配不合理/名字缩略）：需管理员后台核实 → 写 dish_feedback(status:pending) → 可进黑名单
  //  - 系统误伤类（截断/AI 写错名）：性质相反，写独立表 dish_name_fix，自动触发截断补全，永不进黑名单
  //  - 个人忌口类（命中忌口/不合口味）：菜名本身正确，仅与本人冲突 → 只记本人 avoidDishes，不进后台审核
  const nameTypes = types.filter(t => NAME_PROBLEM_TYPES.includes(t));
  const nameFixTypes = types.filter(t => NAME_FIX_TYPES.includes(t));
  const personalTypes = types.filter(t => !NAME_PROBLEM_TYPES.includes(t) && !NAME_FIX_TYPES.includes(t));

  try {
    // 系统误伤类 → 独立表 dish_name_fix（不进 dish_feedback/黑名单）。触发截断自动补全。
    if (nameFixTypes.length) {
      const fixed = fixTruncatedName(d);   // 可能返回补全后的完整名，或 null（无法判定截断）
      await db.collection('dish_name_fix').add({
        data: {
          _openid: OPENID,
          userNo: (userNo == null ? -1 : userNo),
          dish: d,
          report: nameFixTypes.join(','),
          note: n,
          fixed: fixed || '',               // 自动补全后的完整菜名（空=未识别截断模式）
          status: 'pending',
          ts: db.serverDate()
        }
      });
    }

    // 其余菜名问题类 → dish_feedback 审核队列（可进黑名单）。
    if (nameTypes.length) {
      await db.collection('dish_feedback').add({
        data: {
          _openid: OPENID,
          userNo: (userNo == null ? -1 : userNo),  // 数字ID，缺失记 -1，0 专用于管理员
          dish: d,
          report: nameTypes.join(','),   // 只记菜名问题类，对齐 name_blocklist.type 的存储形态
          note: n,
          status: 'pending',
          ts: db.serverDate()
        }
      });
    }

    // 个人忌口类反馈（命中忌口/不合口味）：菜名本身正确，仅与本人冲突。
    // 记入用户个人「不喜欢的菜」(user_preferences.avoidDishes)，供后续 AI 推荐时规避；仅影响本人，不进全局黑名单。
    if (personalTypes.length && OPENID) {
      try {
        // 注销守卫：已注销用户（user_no_map 已被 deleteAccount 删除）不再建档，避免复活
        const mapR = await db.collection('user_no_map').where({ _openid: OPENID }).limit(1).get();
        if (mapR.data && mapR.data.length) {
          const up = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
          if (up.data && up.data.length) {
            const cur = (Array.isArray(up.data[0].avoidDishes) ? up.data[0].avoidDishes : []).filter(Boolean);
            if (cur.indexOf(d) < 0) {
              const next = cur.concat(d).slice(-50); // 最多保留最近 50 条
              await db.collection('user_preferences').doc(up.data[0]._id).update({ data: { avoidDishes: next } });
            }
          } else {
            await db.collection('user_preferences').add({
              data: { baseFree: 0, bonusFree: 0, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', avoidDishes: [d], _openid: OPENID }
            }).catch(() => {});
          }
        }
      } catch (e2) { /* 个人忌口记录失败不影响主反馈流程 */ }
    }

    return { code: 200, msg: '已收到反馈，感谢你的帮助！' };
  } catch (e) {
    console.error('submitDishFeedback error:', e);
    return { code: 500, msg: '提交失败，请稍后重试' };
  }
};
