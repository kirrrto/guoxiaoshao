const cloudConfig = require('./config/cloud');
const { refreshConsentSetting } = require('./utils/reminder-credits');

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
    this.watchForUpdate();
  },

  // Users can change "总是保持以上选择" in WeChat settings while the app is hidden.
  onShow() { refreshConsentSetting(); },

  /** A newly released package downloads in the background; offer a restart instead of running the old one. */
  watchForUpdate() {
    if (typeof wx.getUpdateManager !== 'function') return;
    const manager = wx.getUpdateManager();
    manager.onUpdateReady(() => {
      wx.showModal({
        title: '发现新版本',
        content: '新版本已下载完成，重启小程序即可使用。',
        confirmText: '立即重启',
        success: result => { if (result.confirm) manager.applyUpdate(); },
      });
    });
  },

  // Uncaught errors go to the WeChat realtime log (小程序后台 → 实时日志) as well as the console.
  onError(message) { this.reportError('error', message); },
  onUnhandledRejection(event) { this.reportError('unhandledrejection', event && event.reason); },
  reportError(kind, detail) {
    const text = String(detail && (detail.stack || detail.errMsg || detail.message) || detail).slice(0, 2000);
    try {
      const log = typeof wx.getRealtimeLogManager === 'function' ? wx.getRealtimeLogManager() : null;
      if (log) log.error(`[gxs] ${kind}`, text);
    } catch (e) { /* Reporting must never raise another error. */ }
    console.error(`[gxs] ${kind}`, text);
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
