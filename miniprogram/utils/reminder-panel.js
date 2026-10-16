const { subscribeSubscriptions } = require('./store');
const { restockSubscription, soldoutSubscription, canRemind } = require('./reminder-readiness');
const { getAuthorizationState, subscribeAuthorizationState, requestReminderAuthorization, syncPendingAuthorization, whenAuthorizationReady } = require('./reminder-credits');
const { confirmTap } = require('./haptic');
const { toast } = require('./api');
const pageAccount = page => {
  const boot = page.accountSnapshot || page.data.boot;
  return boot && boot.identity && boot.identity.userKey || null;
};
const currentAccount = () => {
  const app = typeof getApp === 'function' && getApp();
  const boot = app && app.globalData && app.globalData.bootstrap;
  return boot && boot.identity && boot.identity.userKey || null;
};
const accountMatches = (page, owner = pageAccount(page)) => Boolean(owner && owner === pageAccount(page) && owner === currentAccount());
const currentAction = (page, owner, epoch) => !page.pageRetired && accountMatches(page, owner) && epoch === page.authorizationEpoch;
const visible = page => page.visible !== false && page.pageVisible !== false;
function setOverlay(page, hidden) {
  const bar = typeof page.getTabBar === 'function' && page.getTabBar();
  if (bar && typeof bar.setData === 'function') bar.setData({ sheetHidden: Boolean(hidden) });
}
// Both pages share presentation actions and the existing durable authorization queue.
const reminderPanelMethods = {
  onOpenAuthorizationPanel() {
    if (this.pageRetired || this.data.editing || this.data.redemptionOpen || this.data.paymentPendingId || this.data.paymentBusy) return;
    if (!this.data.boot) return toast('正在读取账户，请稍后再试');
    this.observeAuthorization();
    this.setData({ authorizationOpen: true });
    this.syncAuthorizationOverlay();
    this.applyAuthorizationState(getAuthorizationState());
    this.resumeAuthorizationSync();
  },
  onCloseAuthorizationPanel() {
    if (this.pageRetired || this.data.subscribing) return;
    this.setData({ authorizationOpen: false });
    this.syncAuthorizationOverlay();
  },
  syncAuthorizationOverlay() {
    setOverlay(this, !this.pageRetired && visible(this) && (this.data.authorizationOpen || this.data.redemptionOpen || this.data.editing));
  },
  hideAuthorizationOverlay() {
    setOverlay(this, false);
    clearTimeout(this.authorizationFeedbackTimer);
    this.authorizationFeedbackTimer = null;
  },
  isAuthorizationAccountCurrent() {
    return accountMatches(this);
  },
  setAuthorizationFeedback(feedback) {
    const owner = pageAccount(this), epoch = this.authorizationEpoch;
    if (!currentAction(this, owner, epoch)) return;
    clearTimeout(this.authorizationFeedbackTimer);
    this.authorizationFeedbackTimer = null;
    this.setData({ authorizationFeedback: feedback });
    this.resumeAuthorizationFeedback();
  },
  resumeAuthorizationFeedback() {
    if (this.authorizationFeedbackTimer || !this.data.authorizationFeedback || !visible(this)) return;
    const owner = pageAccount(this), epoch = this.authorizationEpoch;
    if (!currentAction(this, owner, epoch)) return;
    const timer = setTimeout(() => {
      if (this.authorizationFeedbackTimer !== timer) return;
      this.authorizationFeedbackTimer = null;
      if (currentAction(this, owner, epoch) && visible(this)) this.setData({ authorizationFeedback: '' });
    }, 4500);
    this.authorizationFeedbackTimer = timer;
  },
  disposeAuthorizationPanel() {
    this.authorizationEpoch = (this.authorizationEpoch || 0) + 1;
    clearTimeout(this.authorizationFeedbackTimer);
    this.hideAuthorizationOverlay();
    if (this.unsubscribeCredits) { this.unsubscribeCredits(); this.unsubscribeCredits = null; }
    if (this.unsubscribeAuthorization) { this.unsubscribeAuthorization(); this.unsubscribeAuthorization = null; }
  },
  observeAuthorization() {
    if (this.pageRetired) return;
    const owner = pageAccount(this);
    if (this.authorizationOwner !== owner) {
      this.authorizationOwner = owner;
      this.authorizationEpoch = (this.authorizationEpoch || 0) + 1;
      clearTimeout(this.authorizationFeedbackTimer);
      this.authorizationFeedbackTimer = null;
      this.setData({ authorizationOpen: false, authorizationFeedback: '' });
      this.syncAuthorizationOverlay();
    }
    if (!this.unsubscribeCredits) this.unsubscribeCredits = subscribeSubscriptions(subscriptions => this.applyCredits(subscriptions));
    if (!this.unsubscribeAuthorization) this.unsubscribeAuthorization = subscribeAuthorizationState(state => this.applyAuthorizationState(state));
    this.resumeAuthorizationFeedback();
  },

  applyAuthorizationState(state) {
    if (this.pageRetired) return;
    // Queue state belongs to the globally verified account. A hidden old page
    // must not show another account's pending grants, errors or balances.
    if (!accountMatches(this)) state = { nativeBusy: state.nativeBusy, pendingCount: 0, acceptedByTemplate: {}, syncing: false, storageBlocked: false, error: null };
    const boot = this.data.boot || {}, accepted = state.acceptedByTemplate || {};
    const authorization = {
      pendingRestock: accepted[boot.templateIds && boot.templateIds[0]] || 0,
      pendingSoldout: accepted[boot.soldoutId] || 0,
      pendingCount: state.pendingCount,
      syncing: state.syncing,
      errorMessage: state.storageBlocked ? (state.pendingCount ? '授权暂存在本次运行，存储失败，请重试同步。' : '无法读取本地授权记录，请重试同步后再授权。') : state.error && state.error.message || '',
      storageBlocked: state.storageBlocked,
    };
    const patch = {};
    if (JSON.stringify(this.data.authorization) !== JSON.stringify(authorization)) patch.authorization = authorization;
    if (this.data.subscribing !== state.nativeBusy) patch.subscribing = state.nativeBusy;
    const pendingChanged = this.data.subscriptionPending !== (state.pendingCount > 0);
    if (pendingChanged) patch.subscriptionPending = state.pendingCount > 0;
    if (Object.keys(patch).length) this.setData(patch);
    if (pendingChanged) this.refreshReadiness();
  },

  resumeAuthorizationSync() {
    // The queue owns retries and survives page hide/unload; no native prompt.
    return whenAuthorizationReady().then(() => {
      const state = getAuthorizationState();
      if (this.pageRetired || !accountMatches(this) || (!state.pendingCount && !state.storageBlocked)) return;
      return syncPendingAuthorization().catch(() => {});
    });
  },

  async onRetryAuthorizationSync() {
    if (this.pageRetired || !visible(this) || !accountMatches(this) || this.data.authorization.syncing) return;
    const owner = pageAccount(this), epoch = this.authorizationEpoch;
    await this.resumeAuthorizationSync();
    if (currentAction(this, owner, epoch) && visible(this) && !getAuthorizationState().pendingCount && !getAuthorizationState().error) this.setAuthorizationFeedback('已有授权已同步，未重复申请微信授权');
  },

  async onSubscribe() {
    if (this.pageRetired || !visible(this) || this.data.subscribing) return;
    if (['editing', 'saving', 'redemptionOpen', 'redeeming', 'paymentBusy', 'paymentChecking', 'paymentConfirming', 'paymentPendingId'].some(key => this.data[key])) return;
    if (!this.data.boot) return toast('正在读取账户，请稍后再试');
    if (!accountMatches(this)) return toast('正在确认账户，请稍后再试');
    const tmplIds = this.data.boot.requestIds || this.data.boot.templateIds || [];
    if (!tmplIds.length) {
      wx.showModal({ title: '提醒暂未开放', content: this.data.boot.notificationReason || '尚未配置可用的订阅消息模板。可在关注页查看已有观测，页面可见时约每分钟刷新。', showCancel: false });
      return;
    }
    if (!canRemind(this.data.boot)) return this.showMemberModal();
    this.observeAuthorization();
    const owner = pageAccount(this), epoch = this.authorizationEpoch;
    if (this.data.authorization.storageBlocked) return;
    try {
      // Call in the tap stack. Only WeChat's response blocks the next tap;
      // persistence and server reconciliation continue in the shared queue.
      const result = await requestReminderAuthorization(tmplIds, { deferSync: true });
      if (!currentAction(this, owner, epoch)) return;
      const accepted = result.accepted || [], filtered = result.filtered || [];
      const outcome = (label, id) => accepted.includes(id) ? label + ' +1' : filtered.includes(id) ? label + '模板被过滤' : result.results && result.results[id] === 'ban' ? label + '授权已关闭' : label + '未授权';
      let feedback;
      if (!Object.keys(result.results || {}).length) feedback = filtered.length ? '提醒模板被微信过滤，已有次数保留' : '本次未授权，已有次数保留';
      else if (this.data.boot.soldoutId) feedback = (accepted.length ? '微信已允许：' : '') + outcome('到货', tmplIds[0]) + '，' + outcome('断货', this.data.boot.soldoutId);
      else feedback = accepted.length ? '微信已允许到货 +1，可继续点击增加' : result.results[tmplIds[0]] === 'ban' ? '微信授权已关闭，本次未增加' : '本次未授权，次数未增加';
      this.setAuthorizationFeedback(feedback);
      if (accepted.length && visible(this)) confirmTap();
    } catch (error) {
      if (!currentAction(this, owner, epoch) || error && error.code === 'subscription_busy') return;
      const message = error && (error.errMsg || error.message) || '';
      const feedback = /20004/.test(message) ? '你已关闭订阅消息总开关，请在设置中开启'
        : error && ['subscription_storage_failed', 'subscription_queue_full', 'subscription_identity_required'].includes(error.code) ? message : '授权未完成，已有次数保留';
      this.setAuthorizationFeedback(feedback);
    }
  },

  applyCredits(subscriptions) {
    if (this.pageRetired || !accountMatches(this) || !this.data.boot || !this.data.boot.templateIds.length) return;
    const credits = restockSubscription({ templateIds: { restock: this.data.boot.templateIds[0] } }, subscriptions).credits;
    const soldoutCredits = soldoutSubscription({ templateIds: { soldout: this.data.boot.soldoutId } }, subscriptions).credits;
    if (credits !== this.data.subscription.credits || soldoutCredits !== this.data.subscription.soldoutCredits) {
      this.setData({ 'subscription.credits': credits, 'subscription.soldoutCredits': soldoutCredits });
      this.refreshReadiness();
    }
  },

};
module.exports = { reminderPanelMethods };
