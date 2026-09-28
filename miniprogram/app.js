const cloudConfig = require('./config/cloud');
const { refreshConsentSetting } = require('./utils/reminder-credits');

// The shared environment's auth hook can stall on a weak network. Give up after
// this long so pages show a retry instead of waiting forever; the next call retries.
const CLOUD_INIT_TIMEOUT_MS = 10000;
const LAUNCH_COUNT_KEY = 'gxs_launch_count_v1';

App({
  globalData: {
    cloud: null,
    cloudError: null,
    bootstrap: null,
    catalog: null,
    pendingFollow: null,
    pendingAlert: null,
    handledAlerts: [],
    singlePage: false,
    launchCount: 0,
    lastQuery: null,
  },

  onLaunch(options) {
    // Opened from a Moments share (scene 1154): a preview without cloud access.
    this.globalData.singlePage = Boolean(options && options.scene === 1154);
    this.globalData.launchCount = this.countLaunch();
    this.captureAlert(options);
    if (!this.globalData.singlePage) {
      this.cloudReady = this.ensureCloud();
      this.cloudReady.catch(() => {});
    }
    this.watchForUpdate();
  },

  /** An old shared link may name a page that no longer exists: open the home tab instead. */
  onPageNotFound() {
    wx.reLaunch({ url: '/pages/query/index' });
  },

  countLaunch() {
    try {
      const count = (Number(wx.getStorageSync(LAUNCH_COUNT_KEY)) || 0) + 1;
      wx.setStorageSync(LAUNCH_COUNT_KEY, count);
      return count;
    } catch (e) { return 1; }
  },

  // Users can change "总是保持以上选择" in WeChat settings while the app is hidden.
  onShow(options) { this.captureAlert(options); refreshConsentSetting(); },

  /** A restock message opens pages/follow/index?eid=…; the follow page shows that alert once. */
  captureAlert(options) {
    const raw = options && options.query && options.query.eid;
    if (typeof raw !== 'string' || !raw) return;
    let eventId = raw;
    try { eventId = decodeURIComponent(raw); } catch (e) { /* already decoded */ }
    if (!this.globalData.handledAlerts.includes(eventId)) this.globalData.pendingAlert = eventId;
  },

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
    const generation = this.cloudInitGeneration = (this.cloudInitGeneration || 0) + 1;
    const init = this.initCloud(generation);
    init.catch(() => {});
    // A late success still stores the cloud for the next call (initCloud sets it).
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (generation === this.cloudInitGeneration) this.globalData.cloudError = '连接云环境超时，请检查网络后重试';
        reject(new Error('cloud_init_timeout'));
      }, CLOUD_INIT_TIMEOUT_MS);
      init.then(cloud => { clearTimeout(timer); resolve(cloud); }, error => { clearTimeout(timer); reject(error); });
    });
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
  async initCloud(generation) {
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
      // A timed-out init can finish after its replacement. Only the newest
      // attempt may publish state; a late success without a replacement is useful.
      if (generation === this.cloudInitGeneration) {
        this.globalData.cloud = cloud;
        this.globalData.cloudError = null;
      }
      return cloud;
    } catch (error) {
      if (generation === this.cloudInitGeneration) this.globalData.cloudError = (error && (error.errMsg || error.message)) || String(error);
      console.error('[gxs] cloud init failed', error);
      throw error;
    }
  },
});
