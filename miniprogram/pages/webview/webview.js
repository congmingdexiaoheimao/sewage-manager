Page({
  data: {
    // TODO: 替换为你的 ICP 备案域名（必须 HTTPS）
    url: ''
  },
  onLoad(options) {
    // 从全局配置读取 URL，支持传入参数
    const app = getApp();
    let url = options.url || app.globalData.webUrl;
    
    // 确保以 / 结尾
    if (!url.endsWith('/')) url += '/';
    
    this.setData({ url });
  },
  onWebLoad() {
    console.log('web-view loaded');
  },
  onWebError(e) {
    console.error('web-view error:', e.detail);
    wx.showModal({
      title: '加载失败',
      content: '网页加载失败，请检查网络连接后重试',
      showCancel: false
    });
  }
});
