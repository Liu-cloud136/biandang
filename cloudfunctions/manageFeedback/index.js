const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 管理员 OPENID 白名单
const REAL_ADMIN = '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);

const FEEDBACK_REWARD = 1; // 每条有效反馈奖励次数（与公告一致）
// 菜名问题类：核实有效后计入全局黑名单 name_blocklist。
// 个人忌口类（命中忌口/不合口味）菜名本身正确，仅与本人冲突，绝不能进全局黑名单，否则误伤其他用户。
// 注意：「系统误伤」是 AI 误截断正常菜名，须走 dish_name_fix 隔离表，绝不能进全局黑名单（否则会屏蔽正常菜）。
// —— 构建指纹（2026-08-08 推广）——
const BUILD_TAG = '2026-08-18.auto-report-no-reward';
console.log('[build] manageFeedback BUILD_TAG=' + BUILD_TAG);

const NAME_PROBLEM_TYPES = ['拼凑', '搭配不合理', '名字缩略'];

// 时间格式化（createdAt 为服务端 Date）
function fmt(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
}

exports.main = async (event) => {
  console.log('[build] manageFeedback BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  // fail-closed：白名单外（含空身份）一律拒绝；REAL_ADMIN 兜底确保真实管理员/本地开发者工具始终可用
  const isAdminOpenid = (oid) => !!(oid && (ADMIN_OPENIDS.includes(oid) || oid === REAL_ADMIN));
  if (!isAdminOpenid(OPENID)) return { code: 403, msg: '无权限' };

  const { action, status, id, decision } = event || {};
  try {
    if (action === 'list') {
      const q = {};
      if (status) q.status = status;
      // 系统误伤类已统一隔离到 dish_name_fix（截断修复 tab），不进推荐反馈审核列表
      q.report = _.neq('系统误伤');
      const res = await db.collection('dish_feedback').where(q).orderBy('ts', 'desc').limit(100).get();
      return { code: 200, data: res.data || [] };
    }

    // 我的页「意见反馈」集合（feedback）单独读取，与 dish_feedback 隔开展示
    if (action === 'listOpinion') {
      const res = await db.collection('feedback').orderBy('createdAt', 'desc').limit(100).get();
      return {
        code: 200,
        data: (res.data || []).map(d => ({
          _id: d._id,
          text: (d.text || '').slice(0, 500),
          timeText: d.createdAt ? fmt(d.createdAt) : '',
          openid: d._openid || ''
        }))
      };
    }

    if (action === 'delOpinion') {
      if (!id) return { code: 400, msg: '缺少 id' };
      await db.collection('feedback').doc(id).remove();
      return { code: 200, msg: '已删除' };
    }

    // 截断修复反馈（dish_name_fix）：与 dish_feedback 隔离，永不进黑名单；但 valid 审核照常发次（source:'namefix'，与 dish_feedback 一致）。
    if (action === 'listNameFix') {
      const q = {};
      if (status) q.status = status;
      const res = await db.collection('dish_name_fix').where(q).orderBy('ts', 'desc').limit(100).get();
      return {
        code: 200,
        data: (res.data || []).map(d => ({
          _id: d._id,
          dish: d.dish,
          report: d.report,
          note: d.note || '',
          fixed: d.fixed || '',
          userNo: (d.userNo == null ? -1 : d.userNo),
          status: d.status,
          ts: d.ts
        }))
      };
    }

    if (action === 'reviewNameFix') {
      if (!id) return { code: 400, msg: '缺少 id' };
      if (!['valid', 'invalid'].includes(decision)) return { code: 400, msg: 'decision 须为 valid/invalid' };
      const rec0 = await db.collection('dish_name_fix').doc(id).get();
      const openid = rec0 && rec0.data ? rec0.data._openid : '';
      // 2026-08-10 修复⑥：openid 缺失（脏数据/异常）时，绝不翻 valid——否则奖励永久丢失且不可重试（资损）。
      // 改为保留 pending 并标记 needRetry，待数据补全后管理员重审补发。
      if (decision === 'valid' && !openid) {
        await db.collection('dish_name_fix').doc(id).update({ data: { status: 'pending', needRetry: true, retryNote: 'openid 缺失，奖励未发放', reviewedAt: new Date() } }).catch(() => {});
        return { code: 409, msg: '该记录 openid 缺失，已保留待审状态避免漏发，请补全后重试' };
      }
      const upd = await db.collection('dish_name_fix').where({ _id: id, status: db.command.in(['pending', 'valid']) }).update({ data: { status: decision, reviewedAt: new Date() } });
      if (!upd || !upd.stats || upd.stats.updated === 0) return { code: 400, msg: '已处理过或记录不存在' };
      // 系统误伤类：仅状态流转 + 不进黑名单；但有效反馈照常发次（与 dish_feedback 一致，2026-08-08 调整）。
      if (decision === 'valid') {
        try {
          const exist = await db.collection('user_preferences').where({ _openid: openid }).limit(1).get();
          if (exist.data && exist.data.length) {
            await db.collection('user_preferences').doc(exist.data[0]._id).update({ data: { bonusFree: _.inc(FEEDBACK_REWARD) } });
          } else {
            await db.collection('user_preferences').add({
              data: { baseFree: 0, bonusFree: FEEDBACK_REWARD, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', _openid: openid }
            });
          }
          await db.collection('free_log').add({
            data: { _openid: openid, type: 'add', source: 'namefix', amount: FEEDBACK_REWARD, desc: '有效截断修复反馈奖励 +' + FEEDBACK_REWARD, ts: db.serverDate() }
          }).catch(() => {});
          return { code: 200, msg: '已标记为已处理，发放 ' + FEEDBACK_REWARD + ' 次（未进黑名单）' };
        } catch (e) {
          console.error('[reviewNameFix] 发次失败：', e && e.message);
          // 发次失败：回滚状态为 pending + needRetry，避免奖励丢失不可重试
          await db.collection('dish_name_fix').doc(id).update({ data: { status: 'pending', needRetry: true, retryNote: '发次异常：' + (e && e.message), reviewedAt: new Date() } }).catch(() => {});
          return { code: 409, msg: '发次异常，已保留待审状态待重试' };
        }
      }
      return { code: 200, msg: '已标记为无效' };
    }

    // 删除截断修复反馈（dish_name_fix）单条记录
    if (action === 'delNameFix') {
      if (!id) return { code: 400, msg: '缺少 id' };
      await db.collection('dish_name_fix').doc(id).remove();
      return { code: 200, msg: '已删除' };
    }

    if (action === 'review') {
      if (!id) return { code: 400, msg: '缺少 id' };
      if (!['valid', 'invalid'].includes(decision)) return { code: 400, msg: 'decision 须为 valid/invalid' };

      // 原子领取审核：仅当仍为 pending 才更新；并发/重复请求仅一个 updated>0 成功，杜绝重复发奖
      const upd = await db.collection('dish_feedback').where({ _id: id, status: 'pending' }).update({ data: { status: decision, reviewedAt: new Date() } });
      if (!upd || !upd.stats || upd.stats.updated === 0) return { code: 400, msg: '已处理过或记录不存在' };
      const rec = await db.collection('dish_feedback').doc(id).get();
      if (!rec.data) return { code: 404, msg: '记录不存在' };

      if (decision === 'valid') {
        const openid = rec.data._openid;
        // 机器后处理自动上报（维度3弱可疑模式命中，source='auto'）：核实有效只进黑名单拦截，不发放次数
        // （机器批量上报用于加固黑名单，非用户主动反馈，发次会偏离"用户反馈发次"的本意）。
        const isAuto = rec.data.source === 'auto';
        // 仅「菜名问题类」（拼凑/搭配不合理/名字缩略）核实有效才发奖；
        // 「个人偏好类」（命中忌口/不合口味）只记入本人忌口、后续规避，不发次数（避免用户靠报"不合口味"刷次）。
        const rpt = (rec.data.report || '');
        const rptTypes = rpt.split(',').map(s => String(s).trim()).filter(Boolean);
        const nameTypes = rptTypes.filter(t => NAME_PROBLEM_TYPES.includes(t));
        let blockMsg = '';
        if (nameTypes.length) {
          // 菜名问题类：进全局黑名单；发奖仅限用户主动反馈（非机器自动上报）
          if (!isAuto) {
            const exist = await db.collection('user_preferences').where({ _openid: openid }).limit(1).get();
            if (exist.data && exist.data.length) {
              await db.collection('user_preferences').doc(exist.data[0]._id).update({ data: { bonusFree: _.inc(FEEDBACK_REWARD) } });
            } else {
              await db.collection('user_preferences').add({
                data: { baseFree: 0, bonusFree: FEEDBACK_REWARD, totalFreeGranted: 0, adCount: 0, pendingBonus: 0, lastSignedDate: '', _openid: openid }
              });
            }
            await db.collection('free_log').add({
              data: { _openid: openid, type: 'add', source: 'feedback', amount: FEEDBACK_REWARD, desc: '有效反馈奖励 +' + FEEDBACK_REWARD, ts: db.serverDate() }
            }).catch(() => {});
          }
          try {
            const blRes = await cloud.callFunction({
              name: 'manageBlocklist',
              data: { action: 'add', term: rec.data.dish, type: nameTypes.join(',') || 'word', note: rec.data.note || '', OPENID: OPENID }
            });
            if (isAuto) {
              blockMsg = '，已同步加入黑名单（机器上报，不发放次数）';
              if (blRes && blRes.result && blRes.result.code !== 200) blockMsg = '（黑名单同步跳过：' + (blRes.result.msg || '已存在') + '，机器上报不发放次数）';
            } else {
              blockMsg = '，已同步加入黑名单并发放 ' + FEEDBACK_REWARD + ' 次';
              if (blRes && blRes.result && blRes.result.code !== 200) blockMsg = '（黑名单同步跳过：' + (blRes.result.msg || '已存在') + '），已发放 ' + FEEDBACK_REWARD + ' 次';
            }
          } catch (e) {
            blockMsg = isAuto ? '（黑名单同步失败，可手动添加，机器上报不发放次数）' : '（黑名单同步失败，可手动添加），已发放 ' + FEEDBACK_REWARD + ' 次';
          }
        } else {
          // 个人偏好类：仅记录本人忌口、不进黑名单、不发奖
          blockMsg = '（个人偏好类，已记入您的忌口并后续规避，不发放次数）';
        }
        return { code: 200, msg: '已标记有效' + blockMsg };
      }
      return { code: 200, msg: '已标记无效' };
    }

    return { code: 400, msg: '未知 action' };
  } catch (e) {
    return { code: 500, msg: (e && e.message) || '操作失败' };
  }
};
