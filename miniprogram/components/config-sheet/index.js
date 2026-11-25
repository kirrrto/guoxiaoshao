const languageUI = require('../../utils/language');
const { setTabBarOverlay } = require('../../utils/tab-bar');
const { confirmTap } = require('../../utils/haptic');

Component(require('../../utils/language').component('config-sheet', {
  options: { multipleSlots: true, styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false, observer: 'onVisible' },
    docked: { type: Boolean, value: false, observer: 'onDocked' },
    title: { type: String, value: '选择配置与门店' },
    subtitle: { type: String, value: '' },
    confirmText: { type: String, value: '保存选择' },
    summary: { type: String, value: '' },
    busy: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    dirty: { type: Boolean, value: false },
    externalClose: { type: Boolean, value: false },
  },
  data: { keyboardHeight: 0, nativeGuardSupported: false, nativeGuardShow: false, dragging: false, dragActivated: false, dragOffset: 0 },
  lifetimes: {
    attached() {
      this.retired = false;
      const supported = typeof wx.canIUse === 'function' && wx.canIUse('page-container');
      this.setData({ nativeGuardSupported: Boolean(supported) });
      this.syncKeyboard();
      if (this.data.visible) this.onVisible(true);
    },
    detached() {
      this.retired = true;
      this.guardEpoch = (this.guardEpoch || 0) + 1;
      this.closeEpoch = (this.closeEpoch || 0) + 1;
      this.setTabHidden(false);
      this.unbindKeyboard();
    },
  },
  pageLifetimes: {
    show() {
      this.pageHidden = false;
      this.syncKeyboard();
      if (this.data.visible && !this.data.docked) { this.setTabHidden(true); this.armNativeGuard(); }
    },
    hide() {
      this.pageHidden = true;
      this.guardEpoch = (this.guardEpoch || 0) + 1;
      this.dragStartY = null;
      this.setTabHidden(false);
      this.unbindKeyboard();
      const patch = { nativeGuardShow: false, dragging: false, dragActivated: false, dragOffset: 0 };
      if (this.data.keyboardHeight) patch.keyboardHeight = 0;
      this.setData(patch);
    },
  },
  methods: {
    bindKeyboard() {
      if (this.keyboardListener || this.retired || this.pageHidden || !this.data.visible || this.data.docked) return;
      if (typeof wx.onKeyboardHeightChange !== 'function' || typeof wx.offKeyboardHeightChange !== 'function') return;
      this.keyboardListener = event => {
        if (!this.retired && !this.pageHidden && this.data.visible && !this.data.docked) this.setData({ keyboardHeight: Math.max(0, Number(event.height) || 0) });
      };
      wx.onKeyboardHeightChange(this.keyboardListener);
    },
    unbindKeyboard() {
      if (this.keyboardListener && typeof wx.offKeyboardHeightChange === 'function') wx.offKeyboardHeightChange(this.keyboardListener);
      this.keyboardListener = null;
    },
    syncKeyboard() {
      if (!this.retired && !this.pageHidden && this.data.visible && !this.data.docked) this.bindKeyboard();
      else this.unbindKeyboard();
    },
    onVisible(visible) {
      this.closeEpoch = (this.closeEpoch || 0) + 1;
      this.confirmingClose = false;
      this.syncPresentation(visible);
    },
    onDocked() { this.syncPresentation(this.data.visible); },
    syncPresentation(visible) {
      const modal = Boolean(visible && !this.data.docked && !this.pageHidden && !this.retired);
      this.dragStartY = null;
      this.syncKeyboard();
      this.setTabHidden(modal);
      this.guardEpoch = (this.guardEpoch || 0) + 1;
      const patch = { nativeGuardShow: Boolean(modal && this.data.nativeGuardSupported) };
      if (!modal && (this.data.dragging || this.data.dragActivated || this.data.dragOffset)) {
        patch.dragging = false; patch.dragActivated = false; patch.dragOffset = 0;
      }
      this.setData(patch);
      if (!modal && this.data.keyboardHeight) this.setData({ keyboardHeight: 0 });
    },
    setTabHidden(hidden) {
      if (hidden) {
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        this.ownerPage = pages[pages.length - 1];
      }
      const page = this.ownerPage;
      const epoch = this.tabVisibilityEpoch = (this.tabVisibilityEpoch || 0) + 1;
      const sync = () => {
        if (epoch !== this.tabVisibilityEpoch) return;
        setTabBarOverlay(page, hidden, this);
      };
      // This method is called from a property observer during the parent render.
      // Change native viewport visibility after that render transaction, and
      // publish only the latest open/close state if both occur in one turn.
      if (typeof wx.nextTick === 'function') wx.nextTick(sync); else setTimeout(sync, 0);
    },
    stopTouch() {},
    onSheetTouchStart(e) {
      if (this.data.docked || this.data.busy || !this.data.visible || this.confirmingClose) return;
      const point = e && e.touches && e.touches[0];
      if (!point || !Number.isFinite(point.clientY)) return;
      this.dragStartY = point.clientY;
    },
    onSheetTouchMove(e) {
      if (this.dragStartY == null || this.data.docked || this.data.busy || !this.data.visible || this.confirmingClose) return;
      const point = e && e.touches && e.touches[0];
      if (!point || !Number.isFinite(point.clientY)) return;
      const deltaY = Math.max(0, point.clientY - this.dragStartY);
      const offset = deltaY <= 180 ? deltaY : 180 + (deltaY - 180) * 0.35;
      const rounded = Math.round(offset);
      if (!this.data.dragging && rounded <= 2) return;
      if (!this.data.dragging || !this.data.dragActivated || this.data.dragOffset !== rounded) {
        this.setData({ dragging: true, dragActivated: true, dragOffset: rounded });
      }
    },
    onSheetTouchEnd() {
      if (this.dragStartY == null) return;
      this.dragStartY = null;
      const offset = this.data.dragOffset || 0;
      if (this.data.dragging || offset) this.setData({ dragging: false, dragOffset: 0 });
      if (offset >= 84 && !this.data.docked && !this.data.busy && this.data.visible && !this.confirmingClose) {
        confirmTap();
        this.onCloseTap();
      }
    },
    armNativeGuard() {
      if (!this.data.nativeGuardSupported || this.retired || this.pageHidden || this.data.docked || !this.data.visible || this.data.nativeGuardShow) return;
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
      if (!this.data.visible || this.retired || this.pageHidden || this.data.docked || !this.data.nativeGuardShow) return;
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
      languageUI.modal({ title: '放弃这次修改？', content: '已保存的配置会保留，这次未保存的选择将丢弃。',
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
}));
