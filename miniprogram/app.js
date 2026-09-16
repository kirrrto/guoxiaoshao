const cloudConfig = require('./config/cloud');

App({
  globalData: {
    cloud: null,
    cloudError: null,
    bootstrap: null,
    catalog: null,
    pendingFollow: null,
    lastQuery: null,
  },

  onLaunch() {
    this.cloudReady = this.ensureCloud();
    this.cloudReady.catch(() => {});
  },

  ensureCloud() {
    if (this.globalData.cloud) return Promise.resolve(this.globalData.cloud);
    if (this.cloudInitPromise) return this.cloudInitPromise;
    const pending = this.initCloud();
    this.cloudInitPromise = pending;
    pending.then(() => { if (this.cloudInitPromise === pending) this.cloudInitPromise = null; }, () => {
      if (this.cloudInitPromise === pending) this.cloudInitPromise = null;
    });
    this.cloudReady = pending;
    return pending;
  },

  /**
   * 果小哨 is a *consumer* of a shared environment: it must open the resource
   * owner's environment through wx.cloud.Cloud and await init(), which runs the
   * owner's cloudbase_auth hook. When this code runs inside the owner's own
   * app (console testing), the plain wx.cloud.init path is used instead.
   */
  async initCloud() {
    if (!wx.cloud) {
      this.globalData.cloudError = '请使用 2.23.0 或以上的基础库';
      throw new Error(this.globalData.cloudError);
    }
    const account = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
    const selfAppid = account && account.miniProgram ? account.miniProgram.appId : null;
    try {
      let cloud;
      if (selfAppid && selfAppid === cloudConfig.resourceAppid) {
        wx.cloud.init({ env: cloudConfig.resourceEnv, traceUser: true });
        cloud = wx.cloud;
      } else {
        cloud = new wx.cloud.Cloud({ resourceAppid: cloudConfig.resourceAppid, resourceEnv: cloudConfig.resourceEnv });
        await cloud.init();
      }
      this.globalData.cloud = cloud;
      this.globalData.cloudError = null;
      return cloud;
    } catch (error) {
      this.globalData.cloudError = (error && (error.errMsg || error.message)) || String(error);
      console.error('[gxs] cloud init failed', error);
      throw error;
    }
  },
});
