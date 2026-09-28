const { call, newId, showError, toast } = require('../../utils/api');
const { getBootstrap, getCatalog, refreshBootstrap, invalidateBootstrap, subscribeCatalog, getFollows, invalidateFollows, publishSubscriptions, subscribeSubscriptions } = require('../../utils/store');
const fmt = require('../../utils/format');
const { syncTabBar } = require('../../utils/tab-bar');
const { restockSubscription, soldoutSubscription, reminderReadiness, canRemind } = require('../../utils/reminder-readiness');
const { shareAppMessage, shareTimeline } = require('../../utils/share');
const { monitorPollDelay } = require('../../utils/poll');
const { FINAL_ERRORS, readPending, savePending, clearPending, beginSubscription, endSubscription, refreshConsentSetting, topUpReminderCredit } = require('../../utils/reminder-credits');
const { confirmTap } = require('../../utils/haptic');

const FOLLOW_STATUS = {
  active: { label: '关注已开启', cls: 'ok' },
  paused: { label: '关注已暂停', cls: 'muted' },
  expired: { label: '会员已到期，监测已停止', cls: 'warn' },
};

const DELIVERY_REASON = {
  template_missing: '订阅消息模板尚未配置，暂不能授权或发送提醒。',
  notifications_disabled: '提醒发送服务尚未开启。',
  collector_not_deployed: '后台检测服务尚未启动，暂不能自动发现补货。',
  collector_stale: '后台检测服务状态已过期，正在等待恢复。',
  collector_stopped: '后台检测服务暂不可用，当前无法自动发送提醒。',
  consumer_credentials_missing: '提醒发送服务尚未完成配置。',
  consumer_appid_mismatch: '提醒发送配置需要修复，暂不能发送消息。',
  consumer_auth_unchecked: '提醒发送服务的连接状态尚未验证。',
  consumer_auth_failed: '提醒发送服务验证未通过，暂不能发送消息。',
  sender_missing: '提醒发送服务尚未接入。',
  sender_unknown: '提醒发送服务状态尚未确认。',
};

const DETECTION_DETAIL = {
  not_deployed: '后台检测服务尚未启动，已开启的关注会保留，无需重复操作。',
  disabled: '后台检测尚未开放，已开启的关注会保留。',
  idle: '后台服务已连接，当前尚未执行检测任务。',
  running: '后台持续检测已开启关注的门店，离开小程序后仍由后台运行。',
  stale: '后台状态已过期，当前无法确认是否仍在检测。',
  stopped: '后台检测服务已停止，需恢复服务后才能自动发现补货。',
  paused: '后台检测暂时暂停，已开启的关注会保留。',
  no_lease: '后台检测正在等待恢复，已开启的关注会保留。',
  throttled: '库存接口限制了请求频率，检测暂时降速或暂停。',
  probing: '正在检查库存接口是否已恢复。',
  budget_limited: '后台检测用量已达上限，需恢复服务额度。',
  error: '后台检测出现异常，暂不能确认最新库存，请稍后刷新。',
};

function deliveryView(notifications, templateIds) {
  const reason = notifications.reason || notifications.disabledReason || '';
  const detail = DELIVERY_REASON[reason] || (/[^\x00-\x7F]/.test(reason) ? reason : '消息服务尚未就绪，请稍后刷新状态。');
  if (!templateIds.length) return { label: '暂不能发送', cls: 'warn', detail: DELIVERY_REASON.template_missing };
  if (!notifications.enabled) return { label: '尚未开放', cls: 'warn', detail: DELIVERY_REASON.notifications_disabled };
  if (notifications.deliveryReady !== true) return { label: '发送服务未就绪', cls: 'warn', detail };
  return { label: '发送服务已就绪', cls: 'ok', detail: '检测到符合条件的库存变化后，将使用对应的有效授权发送提醒。' };
}

const FEEDBACK_TOAST = { bought: '恭喜买到！', missed: '已记录，继续为你盯着', skipped: '已记录，继续为你盯着' };

/** The alert a WeChat message opened: when it was found and what the store shows now. */
function presentAlert({ notification: n, latest, follow }, now = Date.now()) {
  const current = fmt.stockObservation(latest || {}, now, { restricted: Boolean(latest && latest.restricted) });
  return {
    eventId: n.eventId,
    productTitle: n.productTitle,
    partNumber: n.partNumber,
    storeName: n.storeName || n.storeNumber,
    eventLabel: fmt.eventMeta(n.eventType).label,
    soldOut: n.eventType === 'became_unavailable',
    foundText: fmt.fmtDateTime(n.detectedAt),
    agoText: fmt.relative(n.detectedAt, now),
    nowLabel: current.statusLabel,
    nowCls: current.statusCls,
    nowText: current.observationState === 'fresh' ? '最近观测 ' + current.observedText : current.freshnessText,
    feedback: n.feedback || null,
    followActive: Boolean(follow && follow.status === 'active'),
  };
}

function presentFollow(follow, boot, catalog, collector) {
  const now = Date.now();
  const status = { ...(FOLLOW_STATUS[follow.status] || { label: follow.status, cls: 'muted' }) };
  if (follow.status === 'paused' && ['member_expired', 'membership_expired'].includes(follow.statusReason)) status.label = '会员到期，已暂停';
  if (follow.status === 'expired' && boot.freeReminderUsed) status.label = '免费提醒已用完，监测已停止';
  let monitoringText = '';
  if (follow.status === 'active') {
    if (!canRemind(boot)) { status.cls = 'warn'; monitoringText = boot.freeReminderUsed ? '免费提醒已用完，开通会员后恢复自动检测' : '会员未生效，当前不参与自动检测'; }
    else if (!collector || collector.state !== 'running') monitoringText = '关注已保存，后台检测情况见上方';
  }
  const product = catalog && catalog.productByPart && catalog.productByPart[follow.partNumber];
  return {
    ...follow,
    imageUrl: product && product.imageUrl || '',
    imageAlt: product && product.imageAlt || follow.productTitle,
    statusLabel: status.label,
    statusCls: status.cls,
    monitoringText,
    stores: (follow.stores || []).map(s => ({ ...s, ...fmt.stockObservation(s, now, { restricted: follow.latestRestricted }) })),
  };
}

function confirmsSavedFollow(follow, payload) {
  if (!follow || typeof follow.followId !== 'string' || follow.partNumber !== payload.partNumber || follow.status !== 'active' || !Array.isArray(follow.stores)) return false;
  if (follow.followId !== payload.followId && !follow.followId.endsWith('|' + payload.followId)) return false;
  const actual = [...new Set(follow.stores.map(store => store.storeNumber))].sort();
  const expected = [...new Set(payload.storeNumbers)].sort();
  return actual.length === expected.length && actual.every((number, index) => number === expected[index]);
}

Page({
  data: {
    ready: false,
    loadError: null,
    catalogVersion: '',
    boot: null,
    collector: null,
    follows: [],
    followsLoaded: false,
    limits: { maxFollows: 3, maxStoresPerFollow: 3 },
    editing: false,
    editor: { followId: null, pickerValue: null, isNew: true },
    editorCanSave: false,
    saveError: '',
    saving: false,
    subscription: { templateCount: 0, credits: 0 },
    delivery: { label: '正在确认', cls: 'muted', detail: '' },
    settings: { notifyEnabled: true },
    showServiceDetails: false,
    readiness: { code: 'loading', title: '正在检查提醒条件', detail: '正在读取账户与关注状态。', tone: 'muted', action: '', actionLabel: '', activeCount: 0, storeCount: 0, ready: false },
    refreshing: false,
    subscribing: false,
    subscriptionPending: false,
    refreshError: null,
    refreshedText: null,
    alert: null,
    alertBusy: false,
  },

  async onLoad(options) {
    if (options && options.eid) getApp().captureAlert({ query: { eid: options.eid } });
    if (this.loadingBoot) return;
    this.loadingBoot = true;
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => { this.catalog = catalog; if (this.data.ready && this.data.catalogVersion !== catalog.version) this.setData({ catalogVersion: catalog.version }); });
    try {
      if (!this.unsubscribeCredits) this.unsubscribeCredits = subscribeSubscriptions(subscriptions => this.applyCredits(subscriptions));
      this.setData({ subscriptionPending: Boolean(readPending()) });
      const results = await Promise.all([getBootstrap(), getCatalog()]);
      const boot = results[0], initialCatalog = results[1];
      const catalog = getApp().globalData.catalog || initialCatalog;
      this.catalog = catalog;
      this.applyBoot(boot, { catalogVersion: catalog.version, ready: true, loadError: null });
      await this.loadFollows();
      this.consumePendingAlert();
      if (this.visible) this.startPolling();
    } catch (error) {
      this.setData({ loadError: error.message || String(error) });
    } finally {
      this.loadingBoot = false;
    }
  },

  async onShow() {
    syncTabBar(this, '/pages/follow/index');
    this.visible = true;
    if (!this.data.ready) {
      this.consumePending();
      return;
    }
    this.refreshFollowPresentation();
    try {
      this.applyBoot(await getBootstrap());
      getCatalog();
      await this.loadFollows();
    } catch (e) { /* keep previous data */ }
    this.consumePending();
    this.consumePendingFocus();
    this.consumePendingAlert();
    this.startPolling();
  },

  onHide() { this.visible = false; this.stopPolling(); },
  onUnload() { this.pageRetired = true; this.visible = false; this.stopPolling(); if (this.unsubscribeCatalog) this.unsubscribeCatalog(); if (this.unsubscribeCredits) this.unsubscribeCredits(); },

  onShareAppMessage() {
    return shareAppMessage('/pages/follow/index', this.data);
  },

  onShareTimeline() {
    return shareTimeline('/pages/follow/index', this.data);
  },

  onAddToFavorites() {
    return { title: '果小哨 · 我的到货提醒' };
  },

  /** Called by the tab bar when the phone reconnects. */
  onNetworkRestored() {
    if (this.data.loadError) return this.onRetryLoad();
    if (!this.data.ready) return;
    getBootstrap({ force: true }).then(boot => { this.applyBoot(boot); return this.loadFollows({ force: true }); }).catch(() => {});
  },

  stopPolling() { this.pollEpoch = (this.pollEpoch || 0) + 1; if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; },
  startPolling() {
    this.stopPolling();
    const epoch = this.pollEpoch;
    const tick = async () => {
      if (!this.visible || epoch !== this.pollEpoch) return;
      try {
        const boot = await getBootstrap();
        if (!this.visible || epoch !== this.pollEpoch) return;
        this.applyBoot(boot); await this.loadFollows({ force: true });
      } catch (e) {
        // Still age the kept observations so stale results read as stale.
        if (this.visible) { this.refreshFollowPresentation(); this.setData({ refreshError: '刷新失败，以下保留上次观测，请下拉重试。' }); }
      }
      if (this.visible && epoch === this.pollEpoch) this.pollTimer = setTimeout(tick, monitorPollDelay(this.data.collector));
    };
    this.pollTimer = setTimeout(tick, monitorPollDelay(this.data.collector));
  },

  async onPullDownRefresh() {
    try {
      const results = await Promise.all([getBootstrap({ force: true }), getCatalog({ force: true })]);
      const boot = results[0], catalog = results[1];
      this.catalog = catalog;
      this.applyBoot(boot, { catalogVersion: catalog.version, ready: true, loadError: null });
      await this.loadFollows({ force: true });
    } catch (error) { showError(error); }
    finally { wx.stopPullDownRefresh(); }
  },

  async consumePendingAlert() {
    const app = getApp(), eventId = app.globalData.pendingAlert;
    if (!eventId || !this.data.ready) return;
    app.globalData.pendingAlert = null;
    app.globalData.handledAlerts.push(eventId);
    this.setData({ alert: { eventId, loading: true } });
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    try {
      const data = await call('notify.detail', { eventId });
      if (this.data.alert && this.data.alert.eventId === eventId) this.setData({ alert: presentAlert(data) });
    } catch (error) {
      if (this.data.alert && this.data.alert.eventId === eventId) this.setData({ alert: { eventId, error: error.message || '提醒详情暂时无法读取' } });
    }
  },

  onCloseAlert() { this.setData({ alert: null }); },

  onCopyAlert() {
    const alert = this.data.alert;
    if (!alert || !alert.partNumber) return;
    wx.setClipboardData({
      data: `${alert.productTitle}\n型号：${alert.partNumber}\n门店：Apple ${alert.storeName}`,
      success: () => toast('已复制，可到 Apple Store App 下单'),
      fail: () => toast('复制失败，请长按文字手动复制'),
    });
  },

  async onAlertFeedback(e) {
    const alert = this.data.alert, outcome = e.currentTarget.dataset.outcome;
    if (this.pageRetired || !alert || !alert.eventId || this.data.alertBusy) return;
    const isCurrentAlert = () => !this.pageRetired && this.data.alert && this.data.alert.eventId === alert.eventId;
    this.setData({ alertBusy: true });
    try {
      const result = await call('notify.feedback', { eventId: alert.eventId, outcome });
      if (result.paused) this.invalidateFollowRead();
      if (this.pageRetired) return;
      // Closing or replacing the card must survive a late feedback response.
      if (isCurrentAlert()) {
        this.setData({ 'alert.feedback': result.outcome, 'alert.followActive': alert.followActive && !result.paused });
        if (this.visible !== false) {
          if (outcome === 'bought') confirmTap();
          toast(result.paused ? '恭喜买到！已暂停这条关注' : FEEDBACK_TOAST[outcome]);
        }
      }
      if (result.paused && this.visible !== false) {
        try { await this.loadFollows(); }
        catch (error) { if (!this.pageRetired) this.setData({ refreshError: '反馈已记录，关注列表刷新失败，请下拉刷新。' }); }
      }
    } catch (error) {
      if (isCurrentAlert() && this.visible !== false) showError(error);
    } finally {
      if (!this.pageRetired) this.setData({ alertBusy: false });
    }
  },

  consumePending() {
    const pending = getApp().globalData.pendingFollow;
    if (!pending) return;
    getApp().globalData.pendingFollow = null;
    if (!this.data.ready) {
      this.pendingAfterReady = pending;
      return;
    }
    this.openEditor({ followId: newId('f'), pickerValue: pending, isNew: true });
  },

  applyBoot(boot, pageData = {}) {
    const notifications = boot.notifications || {};
    const subscription = restockSubscription(notifications, boot.subscriptions);
    const templateIds = subscription.templateIds;
    const collector = boot.collector || { state: 'not_deployed' };
    const delivery = deliveryView(notifications, templateIds);
    const member = boot.membership.active, expired = !member && Boolean(boot.membership.expiresAt);
    // Sell-out alerts are a member feature on their own template, requested in the same prompt.
    const soldout = member && templateIds.length ? soldoutSubscription(notifications, boot.subscriptions) : { templateId: null, credits: 0 };
    this.setData({
      // freeReminder: a new account's one free alert; freeReminderUsed: it was sent and there is no membership.
      boot: { member, expired, freeReminder: !member && boot.freeReminder === true, freeReminderUsed: !member && !expired && boot.freeReminder === false, expiresAt: boot.membership.expiresAt, expiresText: boot.membership.expiresAt ? fmt.fmtDate(boot.membership.expiresAt) : null, notificationsEnabled: notifications.enabled, notificationReason: delivery.detail, templateIds, soldoutId: soldout.templateId, requestIds: soldout.templateId ? [...templateIds, soldout.templateId] : templateIds, templateTitle: typeof notifications.templateTitle === 'string' ? notifications.templateTitle.trim() : '', memberProduct: boot.memberProduct },
      collector: { ...collector, ...fmt.collectorMeta(collector.state), detail: DETECTION_DETAIL[collector.state] || '暂未取得后台检测状态，请稍后刷新。', updatedText: collector.updatedAt ? fmt.fmtDateTime(collector.updatedAt) : null, batchText: collector.lastBatchAt ? fmt.fmtDateTime(collector.lastBatchAt) : null },
      delivery,
      settings: boot.settings || { notifyEnabled: true },
      limits: boot.limits || this.data.limits,
      subscription: { ...subscription, soldoutEnabled: Boolean(soldout.templateId), soldoutCredits: soldout.credits },
      ...pageData,
    });
    this.refreshFollowPresentation();
    if (this.pendingAfterReady) {
      const pending = this.pendingAfterReady;
      this.pendingAfterReady = null;
      this.openEditor({ followId: newId('f'), pickerValue: pending, isNew: true });
    }
  },

  async loadFollows(options = {}) {
    if (this.followsPromise) return this.followsPromise;
    const generation = this.followReadGeneration || 0;
    const pending = getFollows(options).then(data => {
      if (this.pageRetired || generation !== (this.followReadGeneration || 0)) return;
      this.setData({ follows: data.follows.filter(f => f.status !== 'removed').map(f => presentFollow(f, this.data.boot || {}, this.catalog, this.data.collector)), followsLoaded: true, limits: data.limits, loadError: null, refreshError: null, refreshedText: fmt.fmtTime(Date.now()) });
      this.refreshReadiness();
      this.consumePendingFocus();
    });
    this.followsPromise = pending;
    try { return await pending; } finally { if (this.followsPromise === pending) this.followsPromise = null; }
  },

  invalidateFollowRead() {
    this.followReadGeneration = (this.followReadGeneration || 0) + 1;
    this.followsPromise = null;
    invalidateFollows();
  },

  refreshFollowPresentation() {
    this.refreshReadiness();
    if (!this.data.follows.length) return;
    this.setData({ follows: this.data.follows.map(f => presentFollow(f, this.data.boot || {}, this.catalog, this.data.collector)) });
  },

  refreshReadiness() {
    const readiness = reminderReadiness(this.data);
    this.setData({ readiness });
  },

  onReadinessAction() {
    const action = this.data.readiness.action;
    if (action === 'add') return this.onAdd();
    if (action === 'membership') return this.onGoMine();
    if (action === 'settings') {
      getApp().globalData.pendingMineSection = 'reminder-settings';
      return this.onGoMine();
    }
    if (action === 'follows') return wx.pageScrollTo({ selector: '#follow-configurations', duration: 240 });
    if (action === 'subscribe') return this.onSubscribe();
    if (action === 'refresh') return this.onRefreshStatus();
    if (action === 'service') return this.onServiceDetails();
  },

  consumePendingFocus() {
    if (!this.visible || !this.data.ready || !this.data.followsLoaded) return;
    const pending = getApp().globalData.pendingFollowFocus;
    if (!pending || !['reminder-health', 'follow-configurations'].includes(pending.section)) return;
    const nextTick = wx.nextTick || (fn => fn());
    nextTick(() => {
      if (!this.visible || getApp().globalData.pendingFollowFocus !== pending) return;
      getApp().globalData.pendingFollowFocus = null;
      const index = pending.partNumber ? this.data.follows.findIndex(f => f.partNumber === pending.partNumber) : -1;
      wx.pageScrollTo({ selector: index >= 0 ? '#follow-entry-' + index : '#' + pending.section, duration: 240 });
    });
  },

  async onRefreshStatus() {
    if (this.data.refreshing) return;
    topUpReminderCredit();
    this.setData({ refreshing: true });
    try { this.applyBoot(await getBootstrap({ force: true })); await this.loadFollows({ force: true }); }
    catch (error) { this.setData({ refreshError: '刷新失败，已保留上次状态。请稍后重试。' }); showError(error); }
    finally { this.setData({ refreshing: false }); }
  },

  onToggleServiceDetails() {
    if (!this.pageRetired) this.setData({ showServiceDetails: !this.data.showServiceDetails });
  },

  onServiceDetails() {
    const { collector, delivery } = this.data;
    wx.showModal({ title: '检测与消息服务', content: `${collector.label}\n${collector.detail}${collector.updatedText ? '\n最近状态：' + collector.updatedText : ''}${collector.batchText ? '\n最近检测：' + collector.batchText : ''}\n\n${delivery.label}\n${delivery.detail}\n\n页面约每分钟读取一次已有观测，跟随后台检测节奏；读取本身不会检测库存。`, showCancel: false });
  },

  openEditor({ followId, pickerValue, isNew }) {
    if (this.pageRetired) return;
    if (!canRemind(this.data.boot)) {
      this.showMemberModal();
      return;
    }
    this.editorEpoch = (this.editorEpoch || 0) + 1;
    this.editorSelection = null;
    this.setData({ editing: true, editor: { followId, pickerValue, isNew }, editorCanSave: false, saveError: '' });
  },

  showMemberModal() {
    const product = this.data.boot.memberProduct || {};
    const used = this.data.boot.freeReminderUsed;
    wx.showModal({
      title: used ? '免费体验提醒已用完' : '关注与到货提醒为会员专属',
      content: `${used ? '你的 1 条免费到货提醒已经发送。' : ''}会员可关注 3 个具体配置，每个配置最多 3 家门店，并可累加到货提醒次数。不同容量或颜色分别占用一个关注名额。${product.paymentReady ? '' : '\n\n会员购买暂未开放，可在「我的」查看状态。'}`,
      confirmText: '前往我的',
      success: r => { if (r.confirm) wx.switchTab({ url: '/pages/mine/index' }); },
    });
  },

  onAdd() {
    if (this.data.follows.length >= this.data.limits.maxFollows) {
      if (!this.data.boot.freeReminder) return toast(`最多同时关注 ${this.data.limits.maxFollows} 个机型`);
      return wx.showModal({ title: '免费体验可关注 1 个配置', content: '开通会员可关注 3 个具体配置，每个配置最多 3 家门店，并可累加到货提醒次数。', confirmText: '前往我的', success: r => { if (r.confirm) this.onGoMine(); } });
    }
    this.openEditor({ followId: newId('f'), pickerValue: null, isNew: true });
  },

  onEdit(e) {
    const follow = this.data.follows.find(f => f.followId === e.currentTarget.dataset.id);
    if (!follow) return;
    this.openEditor({ followId: follow.followId, pickerValue: { partNumber: follow.partNumber, storeNumbers: follow.stores.map(s => s.storeNumber) }, isNew: false });
  },

  onCancelEdit() {
    this.editorEpoch = (this.editorEpoch || 0) + 1;
    this.editorSelection = null;
    this.setData({ editing: false, editorCanSave: false, saveError: '' });
  },

  onEditorChange(e) {
    if (this.pageRetired || !this.data.editing) return;
    // The selection is logic state; only its validity needs the render bridge.
    const selection = this.editorSelection = e.detail;
    this.setData({ editorCanSave: Boolean(selection && selection.partNumber && selection.product && selection.product.supported && Array.isArray(selection.storeNumbers) && selection.storeNumbers.length), saveError: '' });
  },

  async onSave() {
    if (this.pageRetired || !this.data.editing || this.data.saving) return;
    const { editor } = this.data;
    const epoch = this.editorEpoch;
    // A picker's change event is deferred by nextTick. Read its current state
    // at the tap so a fast save cannot submit the previous configuration.
    const picker = typeof this.selectComponent === 'function' && this.selectComponent('#follow-target-picker');
    const selection = picker && typeof picker.getSelection === 'function' ? picker.getSelection() : this.editorSelection;
    if (!selection || !selection.partNumber) return toast('请选择具体配置');
    if (!selection.product || !selection.product.supported) return toast('此配置暂未开放监测');
    if (!Array.isArray(selection.storeNumbers) || !selection.storeNumbers.length) return toast('请至少选择一家门店');
    const payload = { followId: editor.followId, partNumber: selection.partNumber, storeNumbers: selection.storeNumbers.slice() };
    const toppedUp = topUpReminderCredit();
    this.setData({ saving: true, saveError: '' });
    try {
      const result = await call('follow.upsert', payload);
      this.invalidateFollowRead();
      invalidateBootstrap();
      if (!confirmsSavedFollow(result && result.follow, payload)) throw Object.assign(new Error('保存结果尚未确认，请重试。'), { code: 'bad_response' });
      if (this.pageRetired) return;
      const follow = presentFollow(result.follow, this.data.boot || {}, this.catalog, this.data.collector);
      const follows = this.data.follows.filter(item => item.followId !== follow.followId && item.followId !== payload.followId);
      follows.push(follow);
      const sameEditor = epoch === this.editorEpoch;
      this.setData({ follows, ...(sameEditor ? { editing: false, editorCanSave: false } : {}) });
      this.refreshReadiness();
      if (sameEditor && this.visible !== false) {
        confirmTap();
        toast(editor.isNew ? '已加入关注' : '已更新', 'success');
        if (editor.isNew && !toppedUp && (!this.data.subscription.credits || (this.data.subscription.soldoutEnabled && !this.data.subscription.soldoutCredits))) this.promptSubscribe();
      }
      if (this.visible !== false) {
        refreshBootstrap().catch(() => {});
        // A failed read cannot undo the server's confirmed save or report it as
        // a failed write. Keep the acknowledged row until a later refresh.
        try { await this.loadFollows(); }
        catch (error) { if (!this.pageRetired) this.setData({ refreshError: '关注已保存，列表状态刷新失败，请下拉刷新。' }); }
      }
    } catch (error) {
      if (!this.pageRetired && epoch === this.editorEpoch) {
        this.setData({ saveError: error.message || '保存未完成，请重试。' });
        if (this.visible !== false) showError(error);
      }
    } finally {
      if (!this.pageRetired) this.setData({ saving: false });
    }
  },

  promptSubscribe() {
    if (!this.data.boot.templateIds.length || this.data.delivery.cls !== 'ok') return;
    if (this.data.boot.freeReminder) {
      wx.showModal({ title: '开启免费到货提醒', content: '点「允许」授权 1 次，补货时就通过微信免费提醒你。', confirmText: '去授权', success: r => { if (r.confirm) this.onSubscribe(); } });
      return;
    }
    wx.showModal({
      title: this.data.subscription.soldoutEnabled ? '开启到货和断货提醒' : '开启补货提醒',
      content: this.data.subscription.soldoutEnabled ? '一个按钮同时申请到货和断货提醒；两项都选择「允许」，各增加 1 次。也可以只允许其中一项。' : '每点一次「允许」增加 1 次到货提醒，可以连续授权多次累加；勾选「总是保持以上选择」后，平时点查询、刷新时会自动补充。',
      confirmText: '增加提醒次数',
      success: r => { if (r.confirm) this.onSubscribe(); },
    });
  },

  async onSubscribe() {
    if (this.data.subscribing) return;
    if (!this.data.boot) return toast('正在读取账户，请稍后再试');
    const tmplIds = this.data.boot.requestIds || this.data.boot.templateIds;
    if (!tmplIds.length) {
      wx.showModal({ title: '提醒暂未开放', content: this.data.boot.notificationReason || '尚未配置可用的订阅消息模板。可在关注页查看已有观测，页面可见时约每分钟刷新。', showCancel: false });
      return;
    }
    // Reminders are for members and a new account's free alert.
    if (!canRemind(this.data.boot)) return this.showMemberModal();
    if (!beginSubscription()) return toast('授权正在同步，请稍后再试');
    try {
      const saved = readPending();
      if (saved) return await this.flushSubscription(saved);
      // User consent can be recorded before the sending service is ready. The
      // separate readiness status still gates actual delivery on the server.
      let res;
      const requestId = newId('ns');
      this.setData({ subscribing: true });
      try {
        res = await wx.requestSubscribeMessage({ tmplIds });
      } catch (error) {
        this.setData({ subscribing: false });
        const msg = (error && error.errMsg) || '';
        if (/20004/.test(msg)) return toast('你已关闭订阅消息总开关，请在设置中开启');
        return toast('授权未完成');
      }
      const results = {};
      for (const id of tmplIds) if (res[id]) results[id] = res[id];
      const pending = { requestId, results };
      savePending(pending);
      this.setData({ subscriptionPending: true });
      this.refreshReadiness();
      return await this.flushSubscription(pending);
    } finally { endSubscription(); }
  },

  async flushSubscription(pending) {
    this.setData({ subscribing: true });
    try {
      const data = await call('notify.recordSubscription', pending);
      const restockId = this.data.boot.templateIds[0];
      const credits = restockSubscription({ templateIds: { restock: restockId } }, data.subscriptions).credits;
      clearPending(pending);
      this.setData({ 'subscription.credits': credits, 'subscription.soldoutCredits': soldoutSubscription({ templateIds: { soldout: this.data.boot.soldoutId } }, data.subscriptions).credits, subscriptionPending: false });
      publishSubscriptions(data.subscriptions);
      this.refreshReadiness();
      const result = pending.results && pending.results[restockId];
      const soldoutId = this.data.boot.soldoutId;
      if (data.replayed) {
        toast('已有授权已同步，未重复增加次数');
      } else if (soldoutId) {
        const accepted = Array.isArray(data.accepted) ? data.accepted : [];
        const outcome = (label, id) => accepted.includes(id) ? `${label} +1` : pending.results && pending.results[id] === 'ban' ? `${label}授权已关闭` : `${label}未授权`;
        if (accepted.includes(restockId) || accepted.includes(soldoutId)) confirmTap();
        toast(`${outcome('到货', restockId)}，${outcome('断货', soldoutId)}`);
      } else if (result === 'accept') {
        confirmTap();
        toast(this.data.delivery.cls === 'ok' ? `提醒次数 +1，剩余 ${credits} 次` : `已记录，剩余 ${credits} 次提醒，服务准备中`);
      } else {
        toast(result === 'ban' ? '微信授权已关闭，本次未增加' : '本次未授权，次数未增加');
      }
      refreshBootstrap().catch(() => {});
    } catch (error) {
      if (FINAL_ERRORS.includes(error.code)) {
        // A template may change while a previously authorized result is queued.
        // Only a definitive rejection releases the pending request; uncertain
        // network failures must retain its ID to avoid double crediting.
        clearPending(pending);
        this.setData({ subscriptionPending: false });
        try { this.applyBoot(await getBootstrap({ force: true })); } catch (e) { /* retry on the next refresh */ }
        if (error.code === 'membership_required') this.showMemberModal();
        else toast('授权记录已失效，请重新点击授权');
        return;
      }
      showError(error);
    } finally {
      this.setData({ subscribing: false });
      this.refreshReadiness();
      // The prompt may have just set "总是保持以上选择", which enables silent top-ups.
      refreshConsentSetting();
    }
  },

  applyCredits(subscriptions) {
    if (!this.data.boot || !this.data.boot.templateIds.length) return;
    const credits = restockSubscription({ templateIds: { restock: this.data.boot.templateIds[0] } }, subscriptions).credits;
    const soldoutCredits = soldoutSubscription({ templateIds: { soldout: this.data.boot.soldoutId } }, subscriptions).credits;
    if (credits !== this.data.subscription.credits || soldoutCredits !== this.data.subscription.soldoutCredits) {
      this.setData({ 'subscription.credits': credits, 'subscription.soldoutCredits': soldoutCredits });
      this.refreshReadiness();
    }
  },

  async onToggle(e) {
    if (this.toggling) return;
    if (!canRemind(this.data.boot)) { this.showMemberModal(); return; }
    this.toggling = true;
    const { id, status } = e.currentTarget.dataset;
    try {
      await call(status === 'active' ? 'follow.pause' : 'follow.resume', { followId: id });
      this.invalidateFollowRead();
      await this.loadFollows();
    } catch (error) {
      showError(error);
    } finally { this.toggling = false; }
  },

  onRemove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除关注',
      content: '删除后将停止监测该机型，已产生的历史记录会保留。',
      confirmColor: '#D64545',
      success: async r => {
        if (!r.confirm) return;
        try {
          await call('follow.remove', { followId: id });
          this.invalidateFollowRead();
          await this.loadFollows();
          refreshBootstrap().catch(() => {});
        } catch (error) {
          showError(error);
        }
      },
    });
  },

  onGoMine() {
    wx.switchTab({ url: '/pages/mine/index' });
  },

  onFollowImageError(e) { const index = Number(e.currentTarget.dataset.index); this.setData({ [`follows[${index}].imageUrl`]: '' }); },

  onRetryLoad() {
    this.setData({ loadError: null });
    this.onLoad();
  },
});
