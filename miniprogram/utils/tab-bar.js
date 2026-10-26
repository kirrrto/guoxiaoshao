const navigation = require('./navigation');

// Native switchTab and page onShow share these routes. The page that actually
// becomes visible owns selection; a tap alone must never mark another page active.
const TABS = [
  { pagePath: '/pages/query/index', text: '查询', iconPath: '/images/tab/query.png', selectedIconPath: '/images/tab/query-active.png' },
  { pagePath: '/pages/follow/index', text: '小哨', iconPath: '/images/tab/follow.png', selectedIconPath: '/images/tab/follow-active.png' },
  { pagePath: '/pages/history/index', text: '历史', iconPath: '/images/tab/history.png', selectedIconPath: '/images/tab/history-active.png' },
  { pagePath: '/pages/mine/index', text: '我的', iconPath: '/images/tab/mine.png', selectedIconPath: '/images/tab/mine-active.png' },
];

let confirmedRoute = TABS[0].pagePath;
let visiblePage = null;
let nativeHidden = false;
let requestedHidden = false;
let nativeRequest = null;
let visibilityIntent = null;
let visibilityRetryTimer = null;
const VISIBILITY_RETRY_DELAYS = [120, 360];

function applyNativeVisibility(hidden) {
  requestedHidden = hidden;
  if (!visibilityIntent || visibilityIntent.hidden !== hidden || visibilityIntent.owner !== visiblePage) {
    if (visibilityRetryTimer) clearTimeout(visibilityRetryTimer);
    visibilityRetryTimer = null;
    visibilityIntent = { hidden, owner: visiblePage, attempts: 0 };
  }
  const intent = visibilityIntent;
  if (nativeRequest || visibilityRetryTimer || nativeHidden === hidden || typeof wx === 'undefined'
    || intent.attempts > VISIBILITY_RETRY_DELAYS.length) return;
  const method = hidden ? wx.hideTabBar : wx.showTabBar;
  if (typeof method !== 'function') return;
  intent.attempts += 1;
  const request = { hidden, intent };
  nativeRequest = request;
  const complete = () => {
    if (nativeRequest !== request) return;
    nativeRequest = null;
    // Serialize bridge commands so a late hide cannot win over a newer show.
    if (visibilityIntent !== intent) { applyNativeVisibility(requestedHidden); return; }
    if (nativeHidden !== hidden && intent.attempts <= VISIBILITY_RETRY_DELAYS.length) {
      // A failed show otherwise strands the user without navigation until the
      // next lifecycle event. Retry briefly, but never spin on a broken bridge.
      const timer = setTimeout(() => {
        if (visibilityRetryTimer !== timer || visibilityIntent !== intent) return;
        visibilityRetryTimer = null;
        applyNativeVisibility(requestedHidden);
      }, VISIBILITY_RETRY_DELAYS[intent.attempts - 1]);
      visibilityRetryTimer = timer;
    }
  };
  const success = () => { if (nativeRequest === request) nativeHidden = hidden; };
  let failureReported = false;
  const fail = error => {
    if (nativeRequest !== request) return;
    nativeHidden = null;
    if (failureReported) return;
    failureReported = true;
    try {
      const log = typeof wx.getRealtimeLogManager === 'function' ? wx.getRealtimeLogManager() : null;
      if (log && typeof log.warn === 'function') log.warn('[gxs] native_tab_bar_failure', {
        method: hidden ? 'hideTabBar' : 'showTabBar', route: confirmedRoute,
        ...navigation.nativeErrorCodes(error),
        errMsg: String(error && (error.errMsg || error.message) || error || 'native tab bar failed').slice(0, 300),
      });
    } catch (_) { /* Keep visibility recovery independent of logging. */ }
  };
  try {
    const result = method.call(wx, { animation: false, success, fail, complete });
    if (result && typeof result.then === 'function') Promise.resolve(result).then(
      value => { success(value); complete(); },
      error => { fail(error); complete(); },
    );
  } catch (error) { fail(error); complete(); }
}

function updateVisibility(page) {
  if (visiblePage !== page) return;
  const state = page.data || {};
  applyNativeVisibility(Boolean(page._tabKeyboardOpen
    || state.sheetVisible || state.editing || state.redemptionOpen || state.calendarOpen || state.authorizationOpen
    || page._tabOverlayLocks && page._tabOverlayLocks.size));
}

function setTabBarOverlay(page, hidden, owner = 'page') {
  if (!page) return;
  if (!page._tabOverlayLocks) page._tabOverlayLocks = new Set();
  if (hidden) page._tabOverlayLocks.add(owner); else page._tabOverlayLocks.delete(owner);
  // A property observer may run before onShow, but must never control a
  // different page's native bar after its owner has been hidden or retired.
  if (hidden && !visiblePage && page.visible !== false && page.pageVisible !== false && !page.pageRetired) {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    if (!pages.length || pages[pages.length - 1] === page) visiblePage = page;
  }
  updateVisibility(page);
}

function releaseTabBar(page, restore = true) {
  if (!page) return;
  if (page._tabNetworkUnsubscribe) page._tabNetworkUnsubscribe();
  page._tabNetworkUnsubscribe = null;
  if (page._tabKeyboardListener && typeof wx !== 'undefined' && typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(page._tabKeyboardListener);
  page._tabKeyboardListener = null;
  page._tabKeyboardOpen = false;
  if (page._tabOverlayLocks) page._tabOverlayLocks.clear();
  if (visiblePage === page) { visiblePage = null; if (restore) applyNativeVisibility(false); }
}

function tabIndex(pagePath) {
  const path = '/' + String(pagePath || '').replace(/^\/+/, '').split('?')[0];
  return TABS.findIndex(tab => tab.pagePath === path);
}

function getCurrentTabPath() {
  if (typeof getCurrentPages === 'function') {
    const pages = getCurrentPages();
    const current = pages && pages[pages.length - 1];
    const index = current ? tabIndex(current.route) : -1;
    if (index >= 0) return TABS[index].pagePath;
  }
  return confirmedRoute;
}

function syncTabBar(page, pagePath) {
  const index = tabIndex(pagePath);
  if (index < 0) return;
  confirmedRoute = TABS[index].pagePath;
  navigation.confirmNavigation(confirmedRoute);
  if (!page) return;
  if (visiblePage && visiblePage !== page) releaseTabBar(visiblePage, false);
  visiblePage = page;
  page._tabKeyboardOpen = false;
  updateVisibility(page);
  if (typeof wx === 'undefined') return;
  if (!page._tabNetworkUnsubscribe) {
    const { subscribeNetwork, isOnline } = require('./network');
    const update = (online, restored) => {
      if (visiblePage !== page || page.pageRetired) return;
      if (page.data.networkOffline !== !online) page.setData({ networkOffline: !online });
      if (restored && typeof page.onNetworkRestored === 'function') page.onNetworkRestored();
    };
    page._tabNetworkUnsubscribe = subscribeNetwork(update);
    update(isOnline(), false);
  }
  if (!page._tabKeyboardListener && typeof wx.onKeyboardHeightChange === 'function' && typeof wx.offKeyboardHeightChange === 'function') {
    page._tabKeyboardListener = event => {
      if (visiblePage !== page || page.pageRetired) return;
      page._tabKeyboardOpen = Number(event && event.height) > 0;
      updateVisibility(page);
    };
    wx.onKeyboardHeightChange(page._tabKeyboardListener);
  }
}

function navigateToTab(component, rawIndex) {
  // Native tab taps are handled by WeChat. Programmatic navigation shares a
  // lock until the destination onShow or the native completion callback.
  if (typeof rawIndex !== 'number' && !(typeof rawIndex === 'string' && /^\d+$/.test(rawIndex))) return false;
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index >= TABS.length || navigation.isNavigating() || requestedHidden) return false;
  if (getCurrentTabPath() === TABS[index].pagePath) return false;
  return switchToTab({ url: TABS[index].pagePath });
}

function switchToTab(options) {
  const index = tabIndex(options && options.url);
  if (index < 0 || navigation.isNavigating()) return false;
  const pagePath = TABS[index].pagePath;
  if (visiblePage && getCurrentTabPath() === pagePath) return false;
  return navigation.switchTab({ ...options, url: pagePath });
}

module.exports = { TABS, tabIndex, getCurrentTabPath, syncTabBar, releaseTabBar, setTabBarOverlay, navigateToTab, switchToTab };
