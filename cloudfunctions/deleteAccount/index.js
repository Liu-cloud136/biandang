const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 管理员 OPENID 白名单（默认含本小程序所有者；可在云函数环境变量 ADMIN_OPENIDS 追加，逗号分隔）
const ADMIN_OPENID = process.env.ADMIN_OPENID || '';
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);

// 管理员判定：按 OPENID 权威识别（ID 固定 'admin'，不占用数字命名空间），或命中 ADMIN_OPENIDS 环境变量
async function amIAdmin(openid) {
  if (!openid) return false;
  if (openid === ADMIN_OPENID) return true;
  if (ADMIN_OPENIDS.includes(openid)) return true;
  return false;
}

// 构建指纹（2026-08-08 推广）
const BUILD_TAG = '2026-09-07.cleanup-genrecords';
console.log('[build] deleteAccount BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] deleteAccount BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  const { action, id, targetOpenid } = event || {};
  // 调用者身份只取平台注入的 OPENID（可靠）；不回退到 event.openid，避免客户端冒充身份。
  const callerId = OPENID || '';

  // 删除单条历史记录（个人自助，必须有身份，且限定本人记录防越权）
  if (action === 'deleteHistory') {
    if (!callerId) return { code: 401, msg: '未获取到用户身份' };
    if (!id) return { code: 400, msg: '缺少记录 ID' };
    try {
      const res = await db.collection('recommend_history').where({ _id: id, _openid: callerId }).remove();
      if (!res.stats || !res.stats.removed) return { code: 404, msg: '记录不存在或无权限' };
      return { code: 200, msg: '已删除' };
    } catch (e) {
      console.error('deleteHistory failed:', e);
      return { code: 500, msg: '删除失败' };
    }
  }

  // 注销账户：清理所有用户数据
  if (action === 'deleteAccount') {
    // 无身份（平台未注入 OPENID，如非微信上下文调用）直接拒绝，避免空 OPENID 静默「假成功」吞掉真实失败
    if (!callerId) return { code: 401, msg: '未获取到用户身份' };
    // 确定目标账户：管理员可指定注销其他用户（targetOpenid），但不可注销管理员账户
    const isAdmin = await amIAdmin(callerId);
    let targetId = callerId;
    if (isAdmin) {
      if (targetOpenid) {
        if (!/^[a-zA-Z0-9_-]{10,64}$/.test(targetOpenid)) return { code: 400, msg: 'targetOpenid 非法' };
        targetId = targetOpenid;
      } else {
        return { code: 403, msg: '管理员账户不可注销' };
      }
    }
    // 墓碑先行：注销即写入 deleted_users（独立于 user_no_map 的权威「已注销」判定源），
    // 用于拦截 getUserId 在用户重进时盲目重建 user_no_map、导致「注销后复活」。
    // fail-closed：墓碑写入失败绝不让注销报成功（否则既删了数据又没墓碑 = 可被静默复活）。
    try {
      await db.collection('deleted_users').add({ data: { _openid: targetId, deletedAt: db.serverDate() } });
    } catch (e) {
      console.error('[deleteAccount] 墓碑写入失败 target=' + targetId + ':', e && e.message);
      return { code: 500, msg: '注销失败（墓碑写入异常），请稍后重试' };
    }
    const ownerField = {
      user_preferences: '_openid',
      recommend_history: '_openid',
      free_log: '_openid',
      user_no_map: '_openid',
      favorites: '_openid',
      data_backups: '_openid',
      dish_feedback: '_openid',
      feedback: '_openid',
      cook_viewed: '_openid',
      dish_contrib: '_openid',
      gen_records: '_openid'       // 2026-09-07 补漏：周表/冰箱/剩菜生成记录，内含用户饮食选择样本
    };
    const collections = ['user_preferences', 'recommend_history', 'free_log', 'user_no_map', 'favorites', 'data_backups', 'dish_feedback', 'feedback', 'cook_viewed', 'fav_contrib', 'dish_contrib', 'gen_records'];
    // 逐集合容错：单个集合清理失败不阻断其余集合，但记录失败清单；
    // 最终若有失败则返回 500（绝不「未完全生效却报成功」），前端可提示重试。
    const failedCollections = [];
    for (const c of collections) {
      const field = ownerField[c] || '_openid';
      try {
        // fav_contrib：_id 为 "OPENID::dish"，无独立 openid 字段，按 _id 前缀正则匹配。
        // 删除前先回退该用户对各菜本地收藏的全局计数贡献（fav_count），避免「已有x人收藏」虚高；
        // 仅当全局计数 >0 才 -1，确保不取负。
        if (c === 'fav_contrib') {
          try {
            const contribs = await db.collection('fav_contrib').where({ _id: db.RegExp({ regexp: '^' + targetId + '::', options: 'i' }) }).limit(1000).get();
            for (const doc of (contribs.data || [])) {
              try {
                await db.collection('fav_count').where({ _id: doc.dish, count: _.gt(0) }).update({ data: { count: _.inc(-1) } });
              } catch (e) { console.error('[deleteAccount] fav_count 回退失败（dish=' + doc.dish + '，计数可能略虚高，不阻断注销）:', e && e.message); }
            }
          } catch (e) { console.error('[deleteAccount] fav_contrib 列取回退失败（计数可能略虚高，不阻断注销）:', e && e.message); }
          for (;;) {
            const res = await db.collection(c).where({ _id: db.RegExp({ regexp: '^' + targetId + '::', options: 'i' }) }).limit(100).get();
            if (!res.data.length) break;
            const ids = res.data.map(d => d._id);
            await db.collection(c).where({ _id: _.in(ids) }).remove();
          }
          continue;
        }
        for (;;) {
          const res = await db.collection(c).where({ [field]: targetId }).limit(100).get();
          if (!res.data.length) break;
          const ids = res.data.map(d => d._id);
          const rm = await db.collection(c).where({ _id: _.in(ids) }).remove();
          console.log('[deleteAccount] 清理集合 ' + c + ' target=' + targetId + ' 删除条数=' + (rm.stats ? rm.stats.removed : 'n/a'));
        }
      } catch (e) {
        // 集合不存在（如尚未建表的可选集合）视为「已清理干净」而非失败——
        // 否则新增的可选集合会让所有注销必返 500。其余真实错误才进失败清单。
        const msg = String((e && (e.errMsg || e.message)) || e || '');
        const missing = /ResourceNotFound|COLLECTION_NOT_EXIST|collection .*not exist|Table or Db not exist|does not exist/i.test(msg);
        if (!missing) {
          console.error('[deleteAccount] 集合清理失败 collection=' + c + ' target=' + targetId + ':', e && e.message);
          failedCollections.push(c);
        } else {
          console.log('[deleteAccount] 集合不存在视为已清理 collection=' + c + ' target=' + targetId);
        }
      }
    }
    if (failedCollections.length) {
      console.error('[deleteAccount] 注销未完全生效 target=' + targetId + ' 失败集合:', failedCollections.join(','));
      return { code: 500, msg: '部分数据清理失败（' + failedCollections.join('/') + '），请稍后重试注销' };
    }
    // 二次校验：逐集合复查是否仍有 targetId 残留。
    // 根因防御：where().get() 在并发写入或偶发空返回时会拿到空数组并直接 break，
    // 导致真实待删数据被静默跳过却返回 200（假成功）。这里兜底复查，有残留则报 500。
    const residual = [];
    for (const c of collections) {
      const field = ownerField[c] || '_openid';
      try {
        if (c === 'fav_contrib') {
          const chk = await db.collection(c).where({ _id: db.RegExp({ regexp: '^' + targetId + '::', options: 'i' }) }).limit(1).get();
          if (chk.data && chk.data.length) residual.push(c);
          continue;
        }
        const chk = await db.collection(c).where({ [field]: targetId }).limit(1).get();
        if (chk.data && chk.data.length) residual.push(c);
      } catch (e) {
        console.error('[deleteAccount] 二次校验查询异常 collection=' + c + ' target=' + targetId + ':', e && e.message);
      }
    }
    if (residual.length) {
      console.error('[deleteAccount] 二次校验发现残留未删尽 target=' + targetId + ' 残留集合:', residual.join(','));
      return { code: 500, msg: '部分数据清理失败（' + residual.join('/') + '），请稍后重试注销' };
    }
    console.log('[deleteAccount] 二次校验通过 target=' + targetId + ' 注销完整生效');
    return { code: 200, msg: targetId === callerId ? '账户已注销' : '已注销目标用户 ' + targetId };
  }

  return { code: 400, msg: '未知操作' };
};
