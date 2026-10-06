// payGoodsList —— 次数中心商品列表（登录态返回明文商品）。
// 用途：前端「次数中心」页拉取可取套餐卡片。返回字段仅含展示所需 + 下发支付所需，
// 不返回任何密钥。商品价格（price，分）= MP「道具管理」现网价（特惠价），前端据此展示并传给下单。
// 构建指纹（2026-09-07 虚拟支付 P0）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const BUILD_TAG = '2026-09-07.virtualpay-p0';
console.log('[build] payGoodsList BUILD_TAG=' + BUILD_TAG);

exports.main = async (event) => {
  console.log('[build] payGoodsList BUILD_TAG=' + BUILD_TAG + ' action=' + String((event && event.action) || 'main'));
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: 401, msg: '未获取到用户身份' };
  try {
    const terminal = (event && event.terminal) || 'android'; // 首期仅 android
    const r = await db.collection('pay_goods')
      .where({ enabled: true, terminal })
      .orderBy('sort', 'asc')
      .limit(20)
      .get();
    const list = (r.data || [])
      .filter(g => g && g.productId)
      .map(g => ({
        productId: g.productId,
        name: g.name,
        count: g.count,
        price: g.price,               // 特惠价（分）＝ MP 道具价格
        origPrice: g.origPrice,       // 划线原价（分），仅前端展示锚点
        desc: g.desc || '',
        promoTag: g.promoTag || '',
        terminal: g.terminal || terminal
      }));
    return { code: 200, data: { terminal, list } };
  } catch (e) {
    console.error('payGoodsList error:', e);
    return { code: 500, msg: (e && e.message) || '商品列表读取失败' };
  }
};
