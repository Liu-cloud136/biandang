// 位置信息：用于真实天气推荐（C 方案）。
// 2026-08-14 方案 B：不再使用 wx.getLocation（该接口需在公众平台申请且审核难通过），
// 改为「IP 定位」——由云函数 getRecommendation action=locateByIp 拿客户端 IP 反查城市（腾讯位置服务）。
// 定位失败时本模块仅返回 { ok:false, reason }，由调用方（首页）按节气近似兜底；不再支持手动填城市。
// 结果缓存到本地 storage，避免每次推荐都重复调用。
const LS_KEY = 'bd_weather_loc'; // { lat, lon, city, district, by: 'ip', ts }

function lsGet() {
  try { return wx.getStorageSync(LS_KEY) || null; } catch (e) { return null; }
}
function lsSet(v) {
  try { wx.setStorageSync(LS_KEY, v); } catch (e) {}
}

// 读取已缓存的定位（仅认 IP 定位；手动填旧缓存视为无效，无则返回 null）
function getCached() {
  try {
    const loc = lsGet();
    if (loc && loc.by === 'ip') return loc;
  } catch (e) {}
  return null;
}

// IP 定位：调云函数拿当前城市（无授权弹窗，替代 wx.getLocation）。
// 成功：缓存并返回 { ok:true, city, district, by:'ip' }
// 失败：返回 { ok:false, reason, errMsg }，reason 用于前端给出可操作的提示
function locateByIp() {
  return new Promise((resolve) => {
    wx.cloud.callFunction({
      name: 'getRecommendation',
      data: { action: 'locateByIp' },
      success: (r) => {
        try {
          const d = r && r.result;
          if (d && d.code === 200 && d.data && (d.data.city || d.data.district)) {
            // 腾讯 IP 定位自带 IP 归属地经纬度（城市/区县级精度），直接缓存。
            // 天气查询因此走经纬度直查（最准），不再走「中文名→GeoAPI→LocationID」的转换链路。
            const loc = { lat: (typeof d.data.lat === 'number') ? d.data.lat : null, lon: (typeof d.data.lon === 'number') ? d.data.lon : null, city: d.data.city || '', district: d.data.district || '', by: 'ip', ts: Date.now() };
            lsSet(loc);
            resolve(Object.assign({ ok: true }, loc));
            return;
          }
          console.warn('[locateByIp] 无城市结果:', (d && d.msg) || 'unknown');
          resolve({ ok: false, reason: 'no_city', errMsg: (d && d.msg) || '未能定位到城市' });
        } catch (e) {
          console.error('[locateByIp] 解析失败:', e && e.message);
          resolve({ ok: false, reason: 'unknown', errMsg: String((e && e.message) || e) });
        }
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || '';
        // 常见失败原因：云函数未部署新版本 / sys_config.ip_loc 未配置腾讯位置服务 key
        console.error('[locateByIp] 云函数调用失败:', errMsg);
        let reason = 'cloud_fail';
        if (/FunctionName|not found|未找到|404/.test(errMsg)) reason = 'fn_missing';
        else if (/ip_loc|not configured/.test(errMsg)) reason = 'no_key';
        resolve({ ok: false, reason, errMsg });
      }
    });
  });
}

// 对外主入口：返回可用于天气查询的定位对象（仅认 IP 定位，且必须带经纬度）。
// 手动填的旧缓存（by:'manual'）已废弃，一律视为无效（2026-08-14 删除手动填功能）。
// 注意：本函数【不主动弹授权】，避免干扰主流程；定位由「我的」页按钮或首次需要时显式触发。
function getLocationForWeather() {
  try {
    const loc = lsGet();
    if (loc && loc.by === 'ip' && typeof loc.lat === 'number' && typeof loc.lon === 'number') return loc;
  } catch (e) {}
  return null;
}

module.exports = {
  getCached,
  getLocationForWeather,
  locateByIp
};
