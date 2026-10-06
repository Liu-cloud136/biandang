// 激励视频广告封装（配置驱动）
// - 广告位已配置真实 adunit ID → 播放广告，完整看完才 resolve(true)
// - 未配置（占位符 adunit-xxxx / adunit-yyyyyyyy）或播放失败 → 兜底 resolve(true)，
//   保证当前 / 流量主未开通时仍能直发，不会卡死领取流程
let _ad = null;

function isConfigured(id) {
  return typeof id === 'string' &&
    id.indexOf('adunit-') === 0 &&
    id.indexOf('xxxx') === -1 &&
    id.indexOf('yyyy') === -1;
}

function getAd(id) {
  if (!_ad) {
    _ad = wx.createRewardedVideoAd({ adUnitId: id });
    _ad.onError(function (err) { console.warn('[ad] rewarded error', err); });
  }
  return _ad;
}

// 返回 Promise<boolean>：true=可发奖（看完广告 / 未配置走直发），false=用户中途退出
function showRewardedAd(id) {
  return new Promise(function (resolve) {
    if (!isConfigured(id)) {
      // 未配置真实广告位：直接视为通过（当前 / 流量主未开通）
      return resolve(true);
    }
    const ad = getAd(id);
    let done = false;
    const onClose = function (res) {
      if (done) return;
      done = true;
      ad.offClose(onClose);
      // 完整看完 isEnded === true 才发奖
      resolve(res && res.isEnded === true);
    };
    ad.onClose(onClose);
    ad.show().catch(function () {
      // 广告尚未加载好：先 load 再 show
      ad.load().then(function () {
        return ad.show();
      }).catch(function (err) {
        console.warn('[ad] show failed, fallback', err);
        if (!done) { done = true; ad.offClose(onClose); resolve(true); }
      });
    });
  });
}

// 底部 Banner 广告（原生覆盖层，无需 wxml 容器）。配置驱动：占位符（含 yyyy）不创建。
// 返回广告实例（已创建时为单例）或 null（未配置时）。
let _banner = null;

function showBannerAd(id) {
  if (!isConfigured(id)) return null; // 未配置真实广告位：直接跳过
  if (_banner) {
    _banner.show().catch(function (e) { console.warn('[ad] banner show failed', e); });
    return _banner;
  }
  try {
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    _banner = wx.createBannerAd({
      adUnitId: id,
      adIntervals: 30,
      style: { left: 0, top: (info.windowHeight || 600) - 50, width: info.windowWidth || 320 }
    });
    _banner.onError(function (err) { console.warn('[ad] banner error', err); });
    _banner.show().catch(function (e) { console.warn('[ad] banner show failed', e); });
  } catch (e) {
    console.warn('[ad] banner create failed', e);
  }
  return _banner;
}

function hideBannerAd() {
  if (_banner) {
    try { _banner.hide(); } catch (e) { /* ignore */ }
  }
}

function destroyBannerAd() {
  if (_banner) {
    try { _banner.destroy(); } catch (e) { /* ignore */ }
    _banner = null;
  }
}

module.exports = { showRewardedAd, showBannerAd, hideBannerAd, destroyBannerAd };
