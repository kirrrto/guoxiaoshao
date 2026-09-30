const { TABS, tabIndex, getCurrentTabPath, navigateToTab } = require('../utils/tab-bar');
const { subscribeNetwork, isOnline } = require('../utils/network');

Component({
  data: {
    selected: 0,
    keyboardHidden: false,
    sheetHidden: false,
    offline: false,
    tabs: TABS,
  },

  lifetimes: {
    attached() {
      this._tabAttached = true;
      this._tabVisible = true;
      this.syncRoute(getCurrentTabPath());
      this.syncOverlay();
      // Show an offline notice; the visible page reloads when the phone reconnects.
      this._unsubscribeNetwork = subscribeNetwork((online, restored) => {
        if (!this._tabAttached) return;
        if (this.data.offline === online) this.setData({ offline: !online });
        if (restored && this._tabVisible) this.notifyNetworkRestored();
      });
      if (!isOnline()) this.setData({ offline: true });
      // Hide the floating controls while typing so they do not cover the city
      // search or redemption input. Only subscribe when cleanup is supported.
      if (typeof wx.onKeyboardHeightChange === 'function' && typeof wx.offKeyboardHeightChange === 'function') {
        this._keyboardListener = event => {
          if (!this._tabAttached || !this._tabVisible) return;
          const hidden = Number(event && event.height) > 0;
          if (hidden !== this.data.keyboardHidden) this.setData({ keyboardHidden: hidden });
        };
        wx.onKeyboardHeightChange(this._keyboardListener);
      }
    },
    detached() {
      this._tabAttached = false;
      this._tabVisible = false;
      if (this._unsubscribeNetwork) this._unsubscribeNetwork();
      this._unsubscribeNetwork = null;
      if (this._keyboardListener && typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(this._keyboardListener);
      this._keyboardListener = null;
    },
  },

  pageLifetimes: {
    show() {
      this._tabVisible = true;
      this.syncRoute(getCurrentTabPath());
      this.syncOverlay();
    },
    hide() { this._tabVisible = false; },
  },

  methods: {
    syncOverlay() {
      // A tab bar can attach after its page already opened an editor. Derive the
      // current overlay state instead of relying on an earlier setData callback.
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const page = pages[pages.length - 1];
      const state = page && page.data || {};
      const sheetHidden = Boolean(state.sheetVisible || state.editing || state.redemptionOpen);
      if (sheetHidden !== this.data.sheetHidden) this.setData({ sheetHidden });
    },
    syncRoute(pagePath) {
      const selected = tabIndex(pagePath);
      if (selected < 0) return;
      if (selected !== this.data.selected || this.data.keyboardHidden) this.setData({ selected, keyboardHidden: false });
    },
    notifyNetworkRestored() {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const page = pages[pages.length - 1];
      if (page && typeof page.onNetworkRestored === 'function') page.onNetworkRestored();
    },
    onTabTap(event) {
      if (this.data.sheetHidden) return false;
      return navigateToTab(this, event.currentTarget.dataset.index);
    },
  },
});
