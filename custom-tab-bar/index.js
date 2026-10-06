Component({
  data: {
    selected: 0,
    hidden: false,
    list: [
      { pagePath: '/pages/index/index', text: '主页' },
      { pagePath: '/pages/history/history', text: '菜单' },
      { pagePath: '/pages/mine/mine', text: '我的' }
    ]
  },
  pageLifetimes: {
    show() {
      // 全局拒绝：封禁用户切到任意 tab 都弹封禁说明
      const app = getApp();
      if (app && app.isBanned && app.isBanned()) {
        app.showBannedModal();
      }
    }
  },
  methods: {
    switchTab(e) {
      // 封禁用户禁止切换 tab 做操作
      const app = getApp();
      if (app && app.isBanned && app.isBanned()) {
        app.showBannedModal();
        return;
      }
      const path = e.currentTarget.dataset.path;
      wx.switchTab({ url: path });
    }
  }
});
