const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 构建指纹（2026-08-08 推广）
// 2026-09-07.quick-guide-reward：场景不再必选 + quick 首次建档奖励 bonusFree+1（source=quick_guide）
// 2026-09-07.reopen-unbind：action='reopen' 一键重新开通——仅清墓碑让 getUserId 重发新编号，
//   解耦「建档/发号」与「偏好填写」（C+A 引导已非强制，注销重开不再必须先答 5 问）。
const BUILD_TAG = '2026-09-07.reopen-unbind';
console.log('[build] savePreferences BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] savePreferences BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };

  // 一键重新开通（2026-09-07 C+A）：已注销（墓碑）用户主动点「重新开通」→ 立即清墓碑，
  // 后续 getPrefs.getUserId 会对本 openid 分配全新编号并正常建档（偏好仍空 exists=false，
  // 首页/我的保留可选 5 问引导，不强制）。仅清理墓碑，不写偏好、不触发建档奖励。
  if (event && event.action === 'reopen') {
    try {
      await db.collection('deleted_users').where({ _openid: OPENID }).remove();
    } catch (e) {
      console.error('[savePreferences] reopen 清墓碑异常 openid=' + OPENID + ':', e && e.message);
      return { code: 500, msg: '开通失败，请稍后重试' };
    }
    return { code: 200, msg: 'ok', data: { reopened: true } };
  }

  // 推荐调校 tuning 单独保存（mine 页「推荐调校」卡），与硬偏好相互独立，不依赖 scene
  if (event && event.action === 'saveTuning') {
    const tuning = event.tuning;
    if (!tuning || typeof tuning !== 'object') return { code: 400, msg: '参数缺失' };
    const exist = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
    if (!exist.data.length) {
      // 推荐调校独立于硬偏好：用户尚未设置任何饮食偏好时，也允许单独保存 tuning（自动建文档）
      await db.collection('user_preferences').add({ data: { tuning, _openid: OPENID, pendingBonus: 0 } });
    } else {
      await db.collection('user_preferences').doc(exist.data[0]._id).update({ data: { tuning } });
    }
    return { code: 200, msg: 'ok' };
  }

  const {
    taste = [],
    spicy = '',
    cuisine = [],
    type = [],
    meat = [],
    veg = [],
    cookMethod = [],
    drink = [],
    avoid = [],
    scene = [],
    communityIngredients = [],
    masterIngredients = [],
    quick = false          // quick 引导完成（2026-09-07 C+A）：首次建档时发 1 次引导奖励
  } = event || {};

  // 场景不再必选（2026-09-07 C+A）：未选则出菜按时段默认；scene 恒为数组即可落库

  const data = {
    taste: Array.isArray(taste) ? taste : [],
    spicy: spicy || '',
    cuisine: Array.isArray(cuisine) ? cuisine : [],
    type: Array.isArray(type) ? type : [],
    meat: Array.isArray(meat) ? meat : [],
    veg: Array.isArray(veg) ? veg : [],
    cookMethod: Array.isArray(cookMethod) ? cookMethod : [],
    drink: Array.isArray(drink) ? drink : [],
    avoid: Array.isArray(avoid) ? avoid : [],
    communityIngredients: Array.isArray(communityIngredients) ? communityIngredients : [],
    masterIngredients: Array.isArray(masterIngredients) ? masterIngredients : [],
    scene: Array.isArray(scene) ? scene : (scene ? [scene] : []),
    updatedAt: new Date(),
    _openid: OPENID
  };

  // 重新注册语义（方案 Y）：用户在引导页「保存完成」= 主动重新注册。
  // 先清死亡名单墓碑，使其后续 getUserId 能重新分配全新编号、正常建档。
  // 注意：仅在「完成引导页」此处清墓碑，进引导页不填/不保存则墓碑保留、各处仍拦截（防自动复活）。
  try {
    await db.collection('deleted_users').where({ _openid: OPENID }).remove();
  } catch (e) {
    console.error('[savePreferences] 清墓碑异常 openid=' + OPENID + ':', e && e.message);
  }

  // 同一用户只保留一份偏好（存在则更新，否则新增）
  const exist = await db.collection('user_preferences').where({ _openid: OPENID }).limit(1).get();
  const existDoc = exist.data && exist.data[0];
  // 判定「本次为新建档」（无论老档是完整偏好还是仅 tuning 哑档都不再发引导奖励——幂等防重复发放）
  const isNewPrefs = !existDoc;
  if (existDoc) {
    await db.collection('user_preferences').doc(existDoc._id).update({ data });
  } else {
    // 首次建档：C+A quick 引导完成 → bonusFree 起发 1 次奖励；非 quick → 0
    const initialBonus = (quick === true) ? 1 : 0;
    await db.collection('user_preferences').add({ data: Object.assign({}, data, { pendingBonus: 0, baseFree: 0, bonusFree: initialBonus }) });
  }

  // 引导奖励流水（仅新建档 + quick；bonusFree 已在建档时置 1）
  let rewarded = false;
  if (isNewPrefs && quick === true) {
    try {
      await db.collection('free_log').add({
        data: { _openid: OPENID, type: 'add', source: 'quick_guide', sourceName: '完成引导奖励', amount: 1, desc: '完成新手引导 +1', ts: db.serverDate() }
      });
      rewarded = true;
    } catch (e) {
      console.error('[savePreferences] quick 引导奖励流水失败：', e && e.message);
      // 流水失败不影响建档（bonusFree 已入账）
    }
  }

  return { code: 200, msg: 'ok', data: { rewarded, newUser: isNewPrefs } };
};
