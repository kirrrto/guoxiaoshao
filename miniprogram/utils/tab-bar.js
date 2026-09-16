// Native switchTab and page onShow share these routes. The page that actually
// becomes visible owns selection; a tap alone must never mark another page active.
const TABS = [
  { pagePath: '/pages/query/index', text: '查询', iconPath: '/images/tab/query.png', selectedIconPath: '/images/tab/query-active.png' },
  { pagePath: '/pages/follow/index', text: '小哨', iconPath: '/images/tab/follow.png', selectedIconPath: '/images/tab/follow-active.png' },
  { pagePath: '/pages/history/index', text: '历史', iconPath: '/images/tab/history.png', selectedIconPath: '/images/tab/history-active.png' },
  { pagePath: '/pages/mine/index', text: '我的', iconPath: '/images/tab/mine.png', selectedIconPath: '/images/tab/mine-active.png' },
];

let confirmedRoute = TABS[0].pagePath;
let pendingNavigation = null;

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
  if (pendingNavigation && pendingNavigation.pagePath === confirmedRoute) pendingNavigation = null;
  const bar = page && typeof page.getTabBar === 'function' ? page.getTabBar() : null;
  if (!bar) return;
  if (typeof bar.syncRoute === 'function') bar.syncRoute(confirmedRoute);
  else if (typeof bar.setData === 'function') bar.setData({ selected: index, keyboardHidden: false });
}

function navigateToTab(component, rawIndex) {
  // Mini-programs create a separate custom tab bar for each page. A module-level
  // lock also covers rapid taps while the destination component is mounting.
  if (typeof rawIndex !== 'number' && !(typeof rawIndex === 'string' && /^\d+$/.test(rawIndex))) return false;
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index >= TABS.length || pendingNavigation) return false;
  const tab = TABS[index];
  if (getCurrentTabPath() === tab.pagePath) return false;
  const navigation = { pagePath: tab.pagePath };
  pendingNavigation = navigation;
  const release = () => { if (pendingNavigation === navigation) pendingNavigation = null; };
  const fail = () => {
    release();
    // Nothing was selected optimistically. Reconcile with the current native
    // page in case navigation from another entry point has happened meanwhile.
    if (component && component._tabAttached !== false && typeof component.syncRoute === 'function') component.syncRoute(getCurrentTabPath());
    if (typeof wx.showToast === 'function') wx.showToast({ title: '页面切换未完成，请重试', icon: 'none' });
  };
  try { wx.switchTab({ url: tab.pagePath, fail, complete: release }); }
  catch (error) { fail(); return false; }
  return true;
}

module.exports = { TABS, tabIndex, getCurrentTabPath, syncTabBar, navigateToTab };
