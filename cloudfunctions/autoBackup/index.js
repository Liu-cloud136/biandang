const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 定时任务：每日 03:00 自动保存一条「真正的全量」备份（scope=global，含全部用户 9 类集合）。
// 与 backupData.backupAll 同口径（全量、无 filter），但 desc 标「定时全量备份」便于区分手动全量，
// 并独立轮转：仅保留最近 RETAIN_AUTO 份定时全量，不误删管理员手动全量备份。
const STATE_ID = 'auto_backup_state';
const RETAIN_AUTO = 7; // 保留最近 7 份定时全量（覆盖一周+）
const COLLECTIONS = [
  'user_preferences',
  'favorites',
  'recommend_history',
  'dish_feedback',
  'free_log',
  'cook_viewed',
  'dish_contrib',
  'fav_contrib',
  'user_no_map'
];
// 老化阈值（天）：超过即清理（仅清理日志/历史类，用户偏好等长期保留）。
// ⚠️ 2026-09-08 修复：原老化按 updatedAt 查询，但 recommend_history 写的是 timestamp、
// free_log 写的是 ts（无 updatedAt 字段）→ 清理从未生效、邮件「老化清理」恒 0。
// 现按各集合真实时间字段 field 老化。
const AGING = [
  { name: 'recommend_history', days: 180, field: 'timestamp' },
  { name: 'free_log', days: 90, field: 'ts' },
];

// 构建指纹（2026-08-08 推广）
// 2026-09-08.aging-field-fix：AGING 按集合真实时间字段清理（timestamp/ts），修复老化从未生效
// 2026-09-08.mail-full-report：邮件补齐菜品问题反馈/截断修复积压、免费流水、虚拟支付订单发货等栏目
// 2026-09-08.contrib-fix：贡献待处理仅统计 dish_contrib（fav_contrib 非审核源）；畸形记录渲染带 _id 可定位
const BUILD_TAG = '2026-09-08.contrib-fix';
console.log('[build] autoBackup BUILD_TAG=' + BUILD_TAG);

// 把函数运行错误写入 function_errors 集合（供每日报告汇总"哪个功能出错"）
async function logErr(fn, e) {
  try {
    await db.collection('function_errors').add({
      data: { fn, msg: (e && e.message) || String(e), ts: db.serverDate() }
    });
  } catch (_) { /* 写入失败不阻塞主流程 */ }
}

// 统计某个集合在 [sinceMs, endMs) 内的新增条数（按 createdAt 或 timestamp 字段）。
// 2026-09-08 修复：原实现只有起点无上界（跑到 now），03:00 定时会把「今日 0~3 点」误计进
// 「昨日全天」，导致邮件业务数字与日期不符；现传入 endMs=今日 0 点封口昨日窗口。
async function countSince(col, sinceMs, field, endMs) {
  try {
    const f = {};
    f[field || 'createdAt'] = _.gte(new Date(sinceMs));
    if (endMs) f[field || 'createdAt'] = _.and(_.gte(new Date(sinceMs)), _.lt(new Date(endMs)));
    const r = await db.collection(col).where(f).count();
    return r.total || 0;
  } catch (e) { console.warn('[autoBackup] countSince failed', col, e && e.message); return 0; }
}

// 取某个集合在 [sinceMs, endMs) 内的昨日新增明细（按 createdAt），可选按状态过滤
async function recentRecords(col, sinceMs, proj, statusField, keepStatuses, endMs) {
  try {
    const f = {};
    if (endMs) f.createdAt = _.and(_.gte(new Date(sinceMs)), _.lt(new Date(endMs)));
    else f.createdAt = _.gte(new Date(sinceMs));
    if (statusField && keepStatuses) f[statusField] = _.in(keepStatuses);
    const r = await db.collection(col).where(f).field(proj).orderBy('createdAt', 'desc').limit(50).get();
    return r.data || [];
  } catch (e) { console.warn('[autoBackup] recentRecords failed', col, e && e.message); return []; }
}

// HTML 转义：反馈/贡献明细为用户自由文本，直接拼 HTML 时含 &<>" 会破版/乱码（2026-09-08）
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 取某个集合「当前待处理」明细（按 status 过滤，不限时间）—— 用于贡献积压清单
async function pendingRecords(col, proj, statusField, keepStatuses) {
  try {
    const f = {};
    if (statusField && keepStatuses) f[statusField] = _.in(keepStatuses);
    const r = await db.collection(col).where(f).field(proj).orderBy('createdAt', 'desc').limit(100).get();
    return r.data || [];
  } catch (e) { console.warn('[autoBackup] pendingRecords failed', col, e && e.message); return []; }
}

// 通用区间明细拉取（时间字段为 Date，如 ts/createdAt/timestamp）→ [sinceMs, endMs)
async function rangeByTime(col, sinceMs, endMs, proj, timeField, extraCond) {
  try {
    const f = {};
    f[timeField || 'createdAt'] = _.and(_.gte(new Date(sinceMs)), _.lt(new Date(endMs)));
    if (extraCond) Object.assign(f, extraCond);
    let q = db.collection(col).where(f);
    if (proj) q = q.field(proj);
    const r = await q.orderBy(timeField || 'createdAt', 'desc').limit(500).get();
    return r.data || [];
  } catch (e) { console.warn('[autoBackup] rangeByTime failed', col, e && e.message); return []; }
}

// 通用区间明细拉取（时间字段为数值毫秒，如 payment_order.createAt=Date.now()）
async function rangeByNum(col, sinceMs, endMs, proj, timeField, extraCond) {
  try {
    const f = {};
    f[timeField] = _.and(_.gte(sinceMs), _.lt(endMs));
    if (extraCond) Object.assign(f, extraCond);
    let q = db.collection(col).where(f);
    if (proj) q = q.field(proj);
    const r = await q.orderBy(timeField, 'desc').limit(500).get();
    return r.data || [];
  } catch (e) { console.warn('[autoBackup] rangeByNum failed', col, e && e.message); return []; }
}

// 当前「待发货」积压统计（payment_order status=created 且未 deliveredAt）
async function pendingPayStats() {
  try {
    const total = await db.collection('payment_order').where({ status: 'created' }).count();
    const stale = await db.collection('payment_order')
      .where({ status: 'created', createAt: _.lt(Date.now() - 30 * 60 * 1000) }).count(); // >30min 未发货视为异常积压
    return { total: total.total || 0, stale: stale.total || 0 };
  } catch (e) { console.warn('[autoBackup] pendingPayStats failed:', e && e.message); return { total: 0, stale: 0 }; }
}

// 取某个集合「当前待审核」明细（按 status 过滤，时间字段为 ts，如 dish_feedback/dish_name_fix）
async function pendingByTs(col, proj, statuses) {
  try {
    const f = { status: _.in(statuses) };
    let q = db.collection(col).where(f);
    if (proj) q = q.field(proj);
    const r = await q.orderBy('ts', 'desc').limit(100).get();
    return r.data || [];
  } catch (e) { console.warn('[autoBackup] pendingByTs failed', col, e && e.message); return []; }
}

// 按时间(Date 字段) + 附加条件计数：如 free_log 按 type 分 add/deduct
async function countCond(col, sinceMs, endMs, field, cond) {
  try {
    const f = Object.assign({}, cond || {});
    f[field] = _.and(_.gte(new Date(sinceMs)), _.lt(new Date(endMs)));
    const r = await db.collection(col).where(f).count();
    return r.total || 0;
  } catch (e) { console.warn('[autoBackup] countCond failed', col, e && e.message); return 0; }
}

// 按数值时间戳毫秒范围计数（如 payment_order.createAt / deliveredAt 是 Date.now() 数值）
async function countNumRange(col, sinceMs, endMs, field, cond) {
  try {
    const f = Object.assign({}, cond || {});
    f[field] = _.and(_.gte(sinceMs), _.lt(endMs));
    const r = await db.collection(col).where(f).count();
    return r.total || 0;
  } catch (e) { console.warn('[autoBackup] countNumRange failed', col, e && e.message); return 0; }
}

// 兼容云端 SDK 返回的 JS Date 与 MCP 序列化后的 {$date} 两种结构，输出 MM-DD HH:mm
function fmtCn(ts) {
  if (!ts) return '';
  const d = (ts && ts.$date) ? new Date(ts.$date) : new Date(ts);
  if (isNaN(d.getTime())) return '';
  // 转北京时间展示
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().replace('T', ' ').slice(5, 16);
}

async function cnDayStartMs(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - offsetDays * 86400000 - 8 * 3600 * 1000;
}

// 汇总「昨日全天」业务数据 + 出错功能，调用 mailNotify 发报告
// 定时任务在每日 03:00 跑，故统计窗口应为「昨日 00:00 ~ 今日 00:00」，
// 起点取 cnDayStartMs(1)（昨日 0 点），终点即当前 03:00 时刻，等价于昨日全天。
async function sendDailyReport(backupInfo) {
  const todayMs = await cnDayStartMs(1); // 昨日 00:00（北京时间）
  const tomorrowMs = await cnDayStartMs(0); // 今日 00:00（上界，封口「昨日全天」）
  try {
    // 并行拉取各业务源（2026-09-08 补齐：菜品问题反馈/截断修复/免费流水/虚拟支付/贡献积压）
    const [
      feedback, dishContrib, favContrib, newUsers, todayHistory,
      freeAdd, freeDeduct,           // 免费次数发放/消耗（free_log.type=add|deduct）
      dishFb, dishNf,                 // 菜品问题反馈 / 截断修复（昨日新增，走 ts 字段）
      payCreated, payDelivered, payStats,  // 虚拟支付昨日下单/发货 + 当前待发货积压
      errRecs,
      feedbackRecs, contribTodos,
      dishFbPending, dishNfPending   // 当前待审核积压（dish_feedback / dish_name_fix）
    ] = await Promise.all([
      countSince('feedback', todayMs, 'createdAt', tomorrowMs),
      countSince('dish_contrib', todayMs, 'createdAt', tomorrowMs),
      countSince('fav_contrib', todayMs, 'createdAt', tomorrowMs),
      countSince('user_no_map', todayMs, 'createdAt', tomorrowMs),
      countSince('recommend_history', todayMs, 'timestamp', tomorrowMs),
      countCond('free_log', todayMs, tomorrowMs, 'ts', { type: 'add' }),
      countCond('free_log', todayMs, tomorrowMs, 'ts', { type: 'deduct' }),
      countSince('dish_feedback', todayMs, 'ts', tomorrowMs),
      countSince('dish_name_fix', todayMs, 'ts', tomorrowMs),
      countNumRange('payment_order', todayMs, tomorrowMs, 'createAt', {}),
      countNumRange('payment_order', todayMs, tomorrowMs, 'deliveredAt', { deliveredAt: _.gt(0) }),
      pendingPayStats(),
      db.collection('function_errors')
        .where({ ts: _.and(_.gte(new Date(todayMs)), _.lt(new Date(tomorrowMs))) })
        .limit(1000).get(),
      // 昨日意见反馈明细（feedback 集合，含客户端日志）
      recentRecords('feedback', todayMs, { text: true, createdAt: true, logs: true }, null, null, tomorrowMs),
      // 当前仍需人工处理的贡献积压（pending/blocked/dup），不限时间。
      // 2026-09-08 修正：仅 dish_contrib 是管理端(manageContrib)审核源；fav_contrib 只是防重复计数 marker，
      //   无 status 且不进入贡献审核，此前并入会造成无意义/异常行（曾见「未知/内容缺失」脏行）。
      pendingRecords('dish_contrib', { raw: true, value: true, type: true, status: true, reason: true, createdAt: true }, 'status', ['pending', 'blocked', 'dup']),
      // 菜品问题反馈 / 截断修复 的当前待审核积压
      pendingByTs('dish_feedback', { dish: true, report: true, note: true, status: true, ts: true, userNo: true }, ['pending']),
      pendingByTs('dish_name_fix', { dish: true, fixed: true, report: true, note: true, status: true, ts: true, userNo: true }, ['pending'])
    ]);
    // 按函数名聚合出错次数
    const errMap = {};
    let errSample = '';
    (errRecs.data || []).forEach(r => {
      errMap[r.fn] = (errMap[r.fn] || 0) + 1;
      if (!errSample) errSample = (r.msg || '').slice(0, 80);
    });
    // 明细均经 HTML 转义，防用户自由文本（反馈内容/客户端日志/贡献理由）含 &<> 破版乱码
    const errLines = Object.keys(errMap).length
      ? Object.keys(errMap).map(k => `· ${k}：出错 ${errMap[k]} 次`).join('<br>')
      : '· 无（今日所有监控函数运行正常）';

    // 待处理：反馈明细（含客户端日志，便于定位问题）
    const fbLines = (feedbackRecs || []).length
      ? feedbackRecs.map(r => {
          const d = fmtCn(r.createdAt);
          let line = `· [${d}] ${esc(String(r.text || '').slice(0, 60))}`;
          // 附带用户提交时上报的客户端运行日志（最多展示前 30 条，避免邮件过长）
          if (Array.isArray(r.logs) && r.logs.length) {
            const shown = r.logs.slice(0, 30).map(l => esc(String(l))).join('<br>　　');
            line += `<br>　　↳ 客户端日志(${r.logs.length}条)：<br>　　${shown}`;
          }
          return line;
        }).join('<br>')
      : '· 昨日暂无新反馈';
    // 待处理：贡献明细（pending/blocked/dup）
    const ctLines = (contribTodos || []).length
      ? contribTodos.map(r => {
          const d = fmtCn(r.createdAt);
          const label = { pending: '待审核', blocked: '已驳回', dup: '重复' }[r.status] || esc(String(r.status || '未知'));
          // 内容优先 raw(显示名)，其次 value(归一名)，其次 type=dish 的菜名；均缺失时给出可定位兜底
          // （2026-09-08：曾出现只显示「未知/内容缺失」的脏行——缺 dish/raw/value 无法辨认，补 _id 便于管理端定位删除）
          const content = (r.raw || r.value || (r.type === 'dish' ? r.dish : '') || '').toString().slice(0, 30) || '（无内容，id=' + esc(String(r._id)) + '）';
          // 类型：收藏已不再并入（fav_contrib 非审核源）；菜名/食材/其余回退实际 type
          const kind = r.type === 'dish' ? '菜名' : (r.type === 'ingredient' ? '食材' : esc(String(r.type || '未知')));
          return `· [${d}] 【${esc(label)}】${esc(content)}（${kind}）${r.reason ? ' — ' + esc(String(r.reason).slice(0, 20)) : ''}`;
        }).join('<br>')
      : '· 昨日无需处理的贡献（积压为 0）';

    // 待处理：菜品问题反馈明细（dish_feedback pending）
    const dishFbLines = (dishFbPending || []).length
      ? dishFbPending.map(r => {
          const d = fmtCn(r.ts);
          const no = (r.userNo == null || r.userNo === '') ? '?' : esc(String(r.userNo));
          const note = r.note ? ' — ' + esc(String(r.note).slice(0, 30)) : '';
          return `· [${d}] #${no} 「${esc(String(r.dish || '').slice(0, 30))}」上报：${esc(String(r.report || ''))}${note}`;
        }).join('<br>')
      : '· 无待审核（已全部处理）';
    // 待处理：截断/误伤修复明细（dish_name_fix pending）
    const dishNfLines = (dishNfPending || []).length
      ? dishNfPending.map(r => {
          const d = fmtCn(r.ts);
          const no = (r.userNo == null || r.userNo === '') ? '?' : esc(String(r.userNo));
          const fix = r.fixed ? ' → 补全为「' + esc(String(r.fixed)) + '」' : '';
          return `· [${d}] #${no} 「${esc(String(r.dish || '').slice(0, 30))}」${fix}（${esc(String(r.report || ''))}）`;
        }).join('<br>')
      : '· 无待处理';

    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const t = now.toISOString().replace('T', ' ').slice(0, 16);
    // 统计日期 = 昨日（窗口起点 cnDayStartMs(1) 所在的日期）
    const statDate = new Date(todayMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const html = `
      <h3>「今天吃啥呀」每日运维报告（统计日期：${statDate}，生成于 ${t}）</h3>
      <h4>一、备份运维</h4>
      <p>· 定时全量备份：文档 ${backupInfo.count} 条<br>
      · 轮转清理旧全量：${backupInfo.cleaned} 份<br>
      · 老化清理（历史/日志）：${backupInfo.aged} 条</p>
      <h4>二、业务数据（${statDate} 全天新增）</h4>
      <p>· 新增用户：${newUsers} 人<br>
      · 出文次数：${todayHistory} 次<br>
      · 免费次数流水：发放 ${freeAdd} 次 / 消耗 ${freeDeduct} 次<br>
      · 虚拟支付：下单 ${payCreated} 单 / 已发货 ${payDelivered} 单${payStats && payStats.total ? '（当前待发货 ' + payStats.total + ' 单' + (payStats.stale ? '，超 30min 异常 ' + payStats.stale + ' 单' : '') + '）' : ''}<br>
      · 意见反馈：${feedback} 条<br>
      · 菜品问题反馈：${dishFb} 条 ｜ 截断修复：${dishNf} 条<br>
      · 贡献（菜品+收藏）：${dishContrib + favContrib} 条（菜品 ${dishContrib} / 收藏 ${favContrib}）</p>
      <h4>三、待处理事项（需你及时处理）</h4>
      <p><b>① 菜品问题反馈待审核（${(dishFbPending || []).length} 条积压）</b><br>${dishFbLines}</p>
      <p><b>② 截断/误伤修复待处理（${(dishNfPending || []).length} 条积压）</b><br>${dishNfLines}</p>
      <p><b>③ 贡献待处理（${(contribTodos || []).length} 条：待审核/已驳回/重复）</b><br>${ctLines}</p>
      <p><b>④ 意见反馈昨日明细（${(feedbackRecs || []).length} 条）</b><br>${fbLines}</p>
      <h4>四、功能出错情况（${statDate}）</h4>
      <p>${errLines}${errSample ? '<br><span style="color:#999">示例：' + esc(errSample) + '</span>' : ''}</p>
    `;
    await cloud.callFunction({
      name: 'mailNotify',
      data: { action: 'send', subject: '[吃啥呀] 每日运维报告 ' + t, html }
    }).catch(e => console.warn('[autoBackup] mailNotify failed:', e && e.message));
    // 清理已汇总的当天错误记录，避免次日重复
    for (const r of (errRecs.data || [])) {
      await db.collection('function_errors').doc(r._id).remove().catch(() => {});
    }
  } catch (e) {
    console.warn('[autoBackup] sendDailyReport failed:', e && e.message);
  }
}

// 分页导出某个集合（filter 为空 = 全量）
async function dumpCollection(col, filter) {
  const docs = [];
  let last = null;
  while (true) {
    let q = db.collection(col).limit(100).orderBy('_id', 'asc');
    if (filter) q = q.where(filter);
    if (last) q = q.where({ _id: _.gt(last) });
    const r = await q.get();
    if (!r.data.length) break;
    r.data.forEach(d => docs.push(d));
    last = r.data[r.data.length - 1]._id;
    if (r.data.length < 100) break;
  }
  return docs;
}

exports.main = async () => {
  console.log('[build] autoBackup BUILD_TAG=' + BUILD_TAG + ' action=' + String((typeof event !== 'undefined' && event && event.action) || 'main'));

  // 1) 生成一条全量备份（含全部用户全部 9 类集合）
  let count = 0;
  try {
    const snapshot = {};
    for (const col of COLLECTIONS) {
      snapshot[col] = await dumpCollection(col, null);
      count += snapshot[col].length;
    }
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const label = '定时全量 ' + now.toISOString().replace('T', ' ').slice(0, 16);
    await db.collection('data_backups').add({
      data: {
        scope: 'global',
        _openid: '__GLOBAL__',
        snapshot,
        createdAt: db.serverDate(),
        label,
        desc: '定时全量备份',
        count
      }
    });
  } catch (e) {
    console.error('[autoBackup] global backup failed:', e && e.message);
    await logErr('autoBackup.backup', e);
    return { code: 500, msg: '定时全量备份失败', data: { err: e && e.message } };
  }

  // 2) 轮转：仅保留最近 RETAIN_AUTO 份「定时全量」（desc='定时全量备份'），不波及手动全量
  let cleaned = 0;
  try {
    const list = await db.collection('data_backups')
      .where({ scope: 'global', desc: '定时全量备份' })
      .orderBy('createdAt', 'desc')
      .limit(1000)
      .get();
    if (list.data.length > RETAIN_AUTO) {
      const toDelete = list.data.slice(RETAIN_AUTO).map(d => d._id);
      for (const id of toDelete) {
        await db.collection('data_backups').doc(id).remove().catch(e => console.warn('[autoBackup] rotate remove failed:', e && e.message));
        cleaned++;
      }
    }
  } catch (e) { console.warn('[autoBackup] rotate failed:', e && e.message); await logErr('autoBackup.rotate', e); }

  // 3) 数据老化清理：删除超期 recommend_history / free_log（按各自真实时间字段清理，
  //    见 AGING.field；2026-09-08 修复原 updatedAt 失效 bug）
  let aged = 0;
  try {
    for (const a of AGING) {
      const thr = new Date(Date.now() - a.days * 86400000);
      const cond = {};
      cond[a.field] = _.lt(thr);
      let s = 0;
      while (true) {
        const res = await db.collection(a.name)
          .where(cond)
          .orderBy(a.field, 'asc')
          .skip(s).limit(100).get();
        if (!res.data.length) break;
        for (const d of res.data) {
          if (d._id) { await db.collection(a.name).doc(d._id).remove(); aged++; }
        }
        if (res.data.length < 100) break;
        s += 100;
      }
    }
  } catch (e) { console.warn('[autoBackup] aging cleanup failed:', e && e.message); await logErr('autoBackup.aging', e); }

  // 4) 记录本次运行时间，供排查
  try {
    await db.collection('backup_state').doc(STATE_ID).set({ data: { lastRun: db.serverDate() } });
  } catch (e) { console.warn('[autoBackup] save backup_state failed:', e && e.message); }

  // 5) 汇总运维+业务+出错报告，发邮件给管理员
  await sendDailyReport({ count, cleaned, aged });

  return { code: 200, msg: '定时全量备份完成', data: { count, cleaned, aged } };
};
