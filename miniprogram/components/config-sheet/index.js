Component({
  options: { multipleSlots: true, styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false, observer: 'onVisible' },
    title: { type: String, value: '选择配置与门店' },
    subtitle: { type: String, value: '' },
    confirmText: { type: String, value: '保存选择' },
    summary: { type: String, value: '' },
    busy: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    dirty: { type: Boolean, value: false },
    externalClose: { type: Boolean, value: false },
  },
  data: { keyboardHeight: 0, nativeGuardSupported: false, nativeGuardShow: false },
  lifetimes: {
    attached() {
      this.retired = false;
      const supported = typeof wx.canIUse === 'function' && wx.canIUse('page-container');
      this.setData({ nativeGuardSupported: Boolean(supported) });
      if (typeof wx.onKeyboardHeightChange === 'function' && typeof wx.offKeyboardHeightChange === 'function') {
        this.keyboardListener = event => {
          if (!this.retired && this.data.visible) this.setData({ keyboardHeight: Math.max(0, Number(event.height) || 0) });
        };
        wx.onKeyboardHeightChange(this.keyboardListener);
      }
      if (this.data.visible) this.onVisible(true);
    },
    detached() {
      this.retired = true;
      this.guardEpoch = (this.guardEpoch || 0) + 1;
      this.closeEpoch = (this.closeEpoch || 0) + 1;
      this.setTabHidden(false);
      if (this.keyboardListener && typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(this.keyboardListener);
    },
  },
  pageLifetimes: {
    show() { this.pageHidden = false; if (this.data.visible) { this.setTabHidden(true); this.armNativeGuard(); } },
    hide() { this.pageHidden = true; this.guardEpoch = (this.guardEpoch || 0) + 1; this.setTabHidden(false); this.setData({ nativeGuardShow: false }); },
  },
  methods: {
    onVisible(visible) {
      this.closeEpoch = (this.closeEpoch || 0) + 1;
      this.confirmingClose = false;
      this.setTabHidden(Boolean(visible));
      this.guardEpoch = (this.guardEpoch || 0) + 1;
      this.setData({ nativeGuardShow: Boolean(visible && this.data.nativeGuardSupported && !this.pageHidden) });
      if (!visible && this.data.keyboardHeight) this.setData({ keyboardHeight: 0 });
    },
    setTabHidden(hidden) {
      if (hidden) {
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        this.ownerPage = pages[pages.length - 1];
        this.ownerBar = this.ownerPage && typeof this.ownerPage.getTabBar === 'function' ? this.ownerPage.getTabBar() : null;
      }
      // The tab bar can mount after the sheet. Resolve it again on the same
      // owning page so closing also releases a late-mounted bar.
      const bar = this.ownerPage && typeof this.ownerPage.getTabBar === 'function' ? this.ownerPage.getTabBar() : this.ownerBar;
      // Separate from keyboardHidden: closing a keyboard must not expose the
      // bottom navigation while a configuration sheet is still active.
      if (bar && typeof bar.setData === 'function') bar.setData({ sheetHidden: hidden });
      if (!hidden) { this.ownerBar = null; this.ownerPage = null; }
    },
    stopTouch() {},
    armNativeGuard() {
      if (!this.data.nativeGuardSupported || this.retired || this.pageHidden || !this.data.visible || this.data.nativeGuardShow) return;
      const epoch = this.guardEpoch = (this.guardEpoch || 0) + 1;
      // A native back leaves the virtual container without updating our bound
      // property. Toggle it across a render tick so a cancelled close is guarded
      // again; the real editor and its draft never unmount during this process.
      const arm = () => {
        if (epoch === this.guardEpoch && !this.retired && !this.pageHidden && this.data.visible) this.setData({ nativeGuardShow: true });
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(arm); else setTimeout(arm, 0);
    },
    onNativeLeave() {
      if (!this.data.visible || this.retired || this.pageHidden || !this.data.nativeGuardShow) return;
      this.setData({ nativeGuardShow: false });
      this.armNativeGuard();
      this.onCloseTap();
    },
    onCloseTap() {
      if (this.data.busy || this.confirmingClose) return;
      if (this.data.externalClose) this.triggerEvent('requestclose');
      else this.requestClose(this.data.dirty);
    },
    requestClose(dirty = this.data.dirty) {
      if (!this.data.visible || this.data.busy || this.confirmingClose) return;
      if (!dirty) { this.triggerEvent('close'); return; }
      this.confirmingClose = true;
      const epoch = this.closeEpoch;
      wx.showModal({ title: '放弃这次修改？', content: '已保存的配置会保留，这次未保存的选择将丢弃。',
        confirmText: '放弃修改', cancelText: '继续编辑',
        success: result => {
          if (this.retired || epoch !== this.closeEpoch || !this.data.visible) return;
          this.confirmingClose = false;
          if (result.confirm && !this.data.busy) this.triggerEvent('close');
        },
        fail: () => { if (!this.retired && epoch === this.closeEpoch) this.confirmingClose = false; },
      });
    },
    onConfirm() {
      if (!this.data.busy && !this.data.disabled && !this.confirmingClose) this.triggerEvent('confirm');
    },
  },
});
