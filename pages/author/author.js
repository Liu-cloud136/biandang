// 作者信息页：长按头像进入。展示各平台账号与特别鸣谢。
// 点击账号可复制（UID/账号 ID 复制数字，昵称复制文本）。
Page({
  onLoad() {
    try {
      const win = wx.getWindowInfo();
      const statusBar = win.statusBarHeight || 20;
      // 标题栏高度：iOS 44px，安卓 48px
      const isIOS = (win.platform || '').toLowerCase().indexOf('ios') > -1
        || (wx.getDeviceInfo && wx.getDeviceInfo().platform === 'ios');
      const titleBar = isIOS ? 44 : 48;
      const navH = statusBar + titleBar;
      this.setData({ navH: navH + 'px' });
    } catch (e) {
      this.setData({ navH: '88rpx' });
    }
  },
  copyId(e) {
    const id = e.currentTarget.dataset.text || '';
    if (!id) return;
    wx.setClipboardData({ data: id });
  },
  copyText(e) {
    const text = e.currentTarget.dataset.text || '';
    if (!text) return;
    wx.setClipboardData({ data: text });
  }
});
