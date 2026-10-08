const { getBootstrap, getFollows, subscribeSubscriptions } = require('../../utils/store');
const { nudgeFor, claimNudge } = require('../../utils/reminder-nudge');
const { readPending, isSubscriptionBusy, getConsentSetting, syncPendingAuthorization, requestReminderAuthorization } = require('../../utils/reminder-credits');
const { toast } = require('../../utils/api');

Component({
  properties: {
    enabled: { type: Boolean, value: false },
    blocked: { type: Boolean, value: false },
  },
  data: { open: false, submitting: false, prompt: null },
  observers: {
    'enabled, blocked': function () {
      if (this.data.blocked || !this.data.enabled) this.dismiss();
      else this.check();
    },
  },
  lifetimes: {
    attached() {
      this.attachedToPage = true;
      this.unsubscribe = subscribeSubscriptions(() => {
        if (this.data.open && !this.data.submitting) this.dismiss();
      });
      this.check();
    },
    detached() {
      this.attachedToPage = false;
      this.pageVisible = false;
      if (this.unsubscribe) this.unsubscribe();
    },
  },
  pageLifetimes: {
    show() { this.pageVisible = true; this.check(); },
    hide() { this.pageVisible = false; this.dismiss(); },
  },
  methods: {
    swallow() {},
    available() { return this.attachedToPage && this.pageVisible && this.data.enabled && !this.data.blocked; },
    async check() {
      if (!this.available() || this.checking || this.data.open || this.data.submitting || isSubscriptionBusy()) return;
      this.checking = true;
      try {
        const initial = await getBootstrap();
        if (!this.available()) return;
        if (!initial.membership || !initial.membership.active) return;
        let boot = initial;
        // A response lost before a package restart retains its idempotency key.
        // Only synchronize that record; this path never asks WeChat to authorize.
        if (readPending()) {
          if (!boot.membership || !boot.membership.active) return;
          await syncPendingAuthorization();
          boot = getApp().globalData.bootstrap || boot;
          if (!this.available() || readPending()) return;
        }
        const response = await getFollows();
        if (!this.available()) return;
        const follows = response && response.follows;
        const prompt = nudgeFor({ boot, follows, pending: Boolean(readPending()), busy: isSubscriptionBusy(), consentSetting: getConsentSetting() });
        if (!prompt || !claimNudge(prompt)) return;
        this.boot = boot;
        this.follows = follows;
        this.setData({ open: true, prompt });
      } catch (_) { /* A failed account read never becomes an authorization prompt. */ }
      finally { this.checking = false; }
    },
    dismiss() {
      if (this.data.open) this.setData({ open: false });
    },
    async authorize() {
      if (!this.available() || !this.data.open || this.data.submitting) return;
      const boot = getApp().globalData.bootstrap || this.boot;
      const prompt = nudgeFor({ boot, follows: this.follows, blocked: this.data.blocked, busy: isSubscriptionBusy(), consentSetting: getConsentSetting() });
      if (!prompt) { this.dismiss(); return; }
      this.setData({ submitting: true });
      try {
        // Invoke synchronously in this button's tap, before any await.
        const result = await requestReminderAuthorization(prompt.templateIds);
        const accepted = result.accepted || [];
        const filtered = result.filtered || [];
        if (!this.attachedToPage || !this.pageVisible) return;
        if (result.replayed) toast('已有授权已同步，未重复增加次数');
        else {
          const templates = boot.notifications.templateIds;
          const outcome = (label, id) => accepted.includes(id) ? `${label} +1` : filtered.includes(id) ? `${label}模板被过滤` : `${label}未授权`;
          toast([outcome('到货', templates.restock), ...(templates.soldout ? [outcome('断货', templates.soldout)] : [])].join('，'));
        }
      } catch (error) {
        if (!this.attachedToPage || !this.pageVisible) return;
        const text = String(error && (error.errMsg || error.message) || '');
        toast(readPending() ? '授权已保存，联网后会继续同步' : /20004/.test(text) ? '订阅消息总开关已关闭，可在微信设置中开启' : '本次授权未完成，已有次数保留');
      } finally {
        if (this.attachedToPage) this.setData({ open: false, submitting: false });
      }
    },
  },
});
