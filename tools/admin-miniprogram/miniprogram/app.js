const cloudConfig = require('./config/cloud');

App({
  globalData: { cloud: null, cloudError: null },
  onLaunch() { this.ensureCloud().catch(() => {}); },

  ensureCloud() {
    if (this.globalData.cloud) return Promise.resolve(this.globalData.cloud);
    if (this.cloudReady) return this.cloudReady;
    const pending = this.initCloud();
    this.cloudReady = pending;
    pending.catch(() => { if (this.cloudReady === pending) this.cloudReady = null; });
    return pending;
  },

  async initCloud() {
    try {
      if (!wx.cloud) throw new Error('请使用支持云开发的微信基础库');
      const info = wx.getAccountInfoSync();
      if (!info || !info.miniProgram || info.miniProgram.appId !== cloudConfig.resourceAppid) {
        throw new Error('请导入独立运营项目，并使用配置中的资源方 AppID');
      }
      // AppID is only a connection guard, never an administrative credential.
      // Every operation is independently authorized by gxs_api.
      wx.cloud.init({ env: cloudConfig.resourceEnv, traceUser: true });
      this.globalData.cloud = wx.cloud;
      this.globalData.cloudError = null;
      return wx.cloud;
    } catch (error) {
      this.globalData.cloudError = error.message || '云环境初始化失败';
      throw error;
    }
  },
});
