const cloudConfig = require('./config/cloud');
const { readSharedSelection } = require('./utils/share');
const { readSession, writeSession } = require('./utils/session');
const { VERSION } = require('./config/version');
const { reLaunch, getNavigationContext } = require('./utils/navigation');

// The shared environment's auth hook can stall on a weak network. Give up after
// this long so pages show a retry instead of waiting forever; the next call retries.
const CLOUD_INIT_TIMEOUT_MS = 10000;
const LAUNCH_COUNT_KEY = 'gxs_launch_count_v1';

function yieldTurn() {
  // nextTick splits the SDK work into separate script tasks. A microtask is
  // only the fallback for runtimes that do not provide nextTick.
  if (typeof wx.nextTick === 'function') return new Promise(resolve => wx.nextTick(resolve));
  return Promise.resolve();
}

function errorText(detail) {
  try { return String(detail && (detail.stack || detail.errMsg || detail.message) || detail); }
  catch (_) { return 'Runtime error details could not be read'; }
}

function errorContext(app, detail) {
  const context = { version: VERSION, route: '', observedAt: new Date().toISOString(),
    appState: app && app.runtimeVisibility || 'unknown' };
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const page = pages[pages.length - 1];
    // Route only: query strings can contain order or notification identifiers.
    context.route = page && typeof page.route === 'string' ? page.route.split(/[?#]/)[0].slice(0, 120) : '';
  } catch (_) { /* Error collection is best effort. */ }
  // Read only our own state here: asking the native bridge for device details
  // while it is failing can produce another error before it has started.
  try {
    const navigation = getNavigationContext();
    if (navigation) context.navigation = navigation;
  } catch (_) { /* Navigation context must not prevent the original report. */ }
  for (const name of ['errCode', 'errno']) {
    try {
      const value = detail && detail[name];
      if (typeof value === 'number' && Number.isFinite(value)) context[name] = value;
    } catch (_) { /* Some native Error properties are inaccessible. */ }
  }
  return context;
}

// Only known platform timeouts with an entirely SDK-owned stack are downgraded.
// Other runtime failures, unknown frames and app.js itself must remain actionable.
const BASE_LIB_FRAME = /(?:^|[/\\])(?:WACloud|WAServiceMainContext|WAWebview|WAServiceContext|appservice|webview|app-config)\.js:\d+(?::\d+)?\)?\s*$/i;
const APP_FRAME = /(?:^|[/\\(\s])(?:app\.js\b|(?:pages|utils|components|config|custom-tab-bar)[/\\])|miniprogram/i;

function isSdkTimeout(detail, text) {
  if (APP_FRAME.test(text)) return false;
  let errCode;
  try { errCode = Number(detail && detail.errCode); } catch (_) { /* Retain the error if its code cannot be read. */ }
  const knownTimeout = errCode === -601008
    || /(?:^|[^\d])-601008(?!\d)|server-side request timed\s*out/i.test(text);
  if (!knownTimeout) return false;
  const frames = text.split(/\r?\n/).filter(line => /(?:^\s*at\s|@|\.js:\d+)/.test(line));
  return frames.length > 0 && frames.every(line => BASE_LIB_FRAME.test(line));
}

App({
  globalData: {
    cloud: null,
    cloudError: null,
    bootstrap: null,
    catalog: null,
    pendingFollow: null,
    pendingSharedTarget: null,
    pendingAlert: null,
    handledAlerts: [],
    singlePage: false,
    launchCount: 0,
    lastQuery: null,
  },

  onLaunch(options) {
    this.runtimeVisibility = 'launching';
    // Opened from a Moments share (scene 1154): a preview without cloud access.
    this.globalData.singlePage = Boolean(options && options.scene === 1154);
    this.launchCountReady = this.countLaunch();
    this.captureAlert(options);
    this.captureSharedTarget(options);
    if (!this.globalData.singlePage) {
      this.cloudReady = this.ensureCloud();
      this.cloudReady.catch(() => {});
    }
    this.watchForUpdate();
  },

  /** An old shared link may name a page that no longer exists: open the home tab instead. */
  onPageNotFound() {
    reLaunch({ url: '/pages/query/index' });
  },

  countLaunch() {
    const remember = value => {
      const count = (Number(value) || 0) + 1;
      this.globalData.launchCount = count;
      writeSession(LAUNCH_COUNT_KEY, count);
      return count;
    };
    if (typeof wx.getStorage === 'function') return readSession(LAUNCH_COUNT_KEY).then(remember);
    // Compatibility fallback only; supported WeChat clients use the async API.
    try {
      return Promise.resolve(remember(wx.getStorageSync(LAUNCH_COUNT_KEY)));
    } catch (e) { this.globalData.launchCount = 1; return Promise.resolve(1); }
  },

  // Users can change "总是保持以上选择" in WeChat settings while the app is hidden.
  onShow(options) {
    this.runtimeVisibility = 'foreground';
    // A warm entry from the Moments preview must regain normal cloud access.
    // Do not infer a transition from missing options (ordinary native returns).
    if (this.globalData.singlePage && options && Number.isInteger(options.scene) && options.scene !== 1154) {
      this.globalData.singlePage = false;
      this.cloudReady = this.ensureCloud();
      this.cloudReady.catch(() => {});
    }
    this.captureAlert(options); this.captureSharedTarget(options); this.refreshConsentLater();
  },

  onHide() { this.runtimeVisibility = 'background'; },

  // Android WebView may not re-evaluate prefers-color-scheme media queries when
  // the system theme changes. Force every live page to re-render so CSS picks up
  // the new theme without requiring a mini-program restart.
  onThemeChange(res) {
    this.globalData.themeMode = res && res.theme === 'dark' ? 'dark' : 'light';
    const pages = getCurrentPages();
    for (const page of pages) {
      if (page && typeof page.setData === 'function') {
        page.setData({ _themeForce: Date.now() });
      }
    }
  },

  refreshConsentLater() {
    if (this.consentRefreshScheduled) return;
    this.consentRefreshScheduled = true;
    const refresh = () => {
      this.consentRefreshScheduled = false;
      // The reminder module also imports the product catalog. Defer loading it
      // until after the current render task instead of making App pay for it.
      require('./utils/reminder-credits').refreshConsentSetting();
    };
    if (typeof wx.nextTick === 'function') wx.nextTick(refresh);
    else refresh();
  },

  /** Existing tab pages receive warm launch parameters through App.onShow. */
  captureSharedTarget(options) {
    if (!options || (options.path && (typeof options.path !== 'string' || options.path.replace(/^\//, '') !== 'pages/query/index'))) return;
    const target = readSharedSelection(options.query);
    if (target) this.globalData.pendingSharedTarget = target;
  },

  /** A restock message opens pages/follow/index?eid=…; the follow page shows that alert once. */
  captureAlert(options) {
    if (options && options.path && (typeof options.path !== 'string' || options.path.replace(/^\//, '') !== 'pages/follow/index')) return;
    const raw = options && options.query && options.query.eid;
    if (typeof raw !== 'string' || !raw) return;
    let eventId = raw;
    try { eventId = decodeURIComponent(raw); } catch (e) { /* already decoded */ }
    // These documented scenes indicate entry from a subscription message.
    // A prior successful display must not permanently disable the message link;
    // ordinary resume/page onLoad options still keep the handled-event guard.
    const messageEntry = options && [1014, 1107].includes(options.scene);
    if (messageEntry || !this.globalData.handledAlerts.includes(eventId)) this.globalData.pendingAlert = eventId;
  },

  /** A newly released package downloads in the background; offer a restart instead of running the old one. */
  watchForUpdate() {
    // Some clients expose the factory but return no manager (older libs, previews).
    if (typeof wx.getUpdateManager !== 'function') return;
    let manager = null;
    try { manager = wx.getUpdateManager(); } catch (e) { return; }
    if (!manager || typeof manager.onUpdateReady !== 'function') return;
    manager.onUpdateReady(() => {
      wx.showModal({
        title: '发现新版本',
        content: '新版本已下载完成，重启小程序即可使用。',
        confirmText: '立即重启',
        success: result => { if (result.confirm && typeof manager.applyUpdate === 'function') manager.applyUpdate(); },
      });
    });
  },

  // Both runtime hooks may receive a cloud SDK timeout. Keep those warnings in
  // our realtime log; this does not change the platform's own error collection.
  onError(message) { this.reportError('error', message); },
  onUnhandledRejection(event) {
    this.reportError('unhandledrejection', event && event.reason);
  },
  reportError(kind, detail) {
    // A native logger may itself report an error through this hook. Do not
    // recursively invoke it until the JavaScript call stack is exhausted.
    if (this.reportingError) return;
    this.reportingError = true;
    try { this.writeError(kind, detail); }
    finally { this.reportingError = false; }
  },
  writeError(kind, detail) {
    const text = errorText(detail);
    if (isSdkTimeout(detail, text)) {
      try {
        const log = typeof wx.getRealtimeLogManager === 'function' ? wx.getRealtimeLogManager() : null;
        if (log && typeof log.warn === 'function') log.warn('[gxs] sdk_timeout', { kind, detail: text.slice(0, 500), ...errorContext(this, detail) });
      } catch (e) { /* Diagnostics must never raise another error. */ }
      return;
    }
    try {
      const log = typeof wx.getRealtimeLogManager === 'function' ? wx.getRealtimeLogManager() : null;
      if (log && typeof log.error === 'function') log.error(`[gxs] ${kind}`, text.slice(0, 2000), errorContext(this, detail));
    } catch (e) { /* Reporting must never raise another error. */ }
    try { console.error(`[gxs] ${kind}`, text.slice(0, 2000)); }
    catch (_) { /* An unavailable native logger cannot throw from onError. */ }
  },

  ensureCloud() {
    if (this.globalData.cloud) return Promise.resolve(this.globalData.cloud);
    if (this.cloudInitPromise) return this.cloudInitPromise;
    const generation = this.cloudInitGeneration = (this.cloudInitGeneration || 0) + 1;
    // Cloud construction/auth can do synchronous SDK work before init returns
    // its promise. Let the initial page render task finish before paying that
    // cost. Every page still shares this same connection and retry deadline.
    const init = typeof wx.nextTick === 'function'
      ? new Promise(resolve => wx.nextTick(resolve)).then(() => this.initCloud(generation))
      : this.initCloud(generation);
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
    // Account lookup, SDK construction and init each resume on their own turn
    // when the client can schedule one. One synchronous slice over about 50ms
    // is reported as a long script task.
    if (typeof wx.nextTick === 'function') await yieldTurn();
    if (generation !== this.cloudInitGeneration) return this.globalData.cloud;
    const account = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
    const selfAppid = account && account.miniProgram ? account.miniProgram.appId : null;
    if (typeof wx.nextTick === 'function') await yieldTurn();
    if (generation !== this.cloudInitGeneration) return this.globalData.cloud;
    try {
      let cloud;
      if (selfAppid && selfAppid === cloudConfig.resourceAppid) {
        wx.cloud.init({ env: cloudConfig.resourceEnv, traceUser: true });
        cloud = wx.cloud;
      } else {
        cloud = new wx.cloud.Cloud({ resourceAppid: cloudConfig.resourceAppid, resourceEnv: cloudConfig.resourceEnv });
        if (typeof wx.nextTick === 'function') await yieldTurn();
        if (generation !== this.cloudInitGeneration) return this.globalData.cloud;
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
