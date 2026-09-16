const { call, newId, showError, toast } = require('../../utils/api');
const { getBootstrap, getCatalog, refreshBootstrap, invalidateBootstrap, toViewCatalog, subscribeCatalog, getFollows, invalidateFollows } = require('../../utils/store');
const fmt = require('../../utils/format');
const { localKey } = require('../../utils/local-key');
const { syncTabBar } = require('../../utils/tab-bar');
const { restockSubscription, reminderReadiness } = require('../../utils/reminder-readiness');
const SUBSCRIPTION_PENDING_KEY = 'gxs_subscription_pending_v1';

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
  return { label: '发送服务已就绪', cls: 'ok', detail: '检测到符合条件的补货后，将使用你的有效授权发送提醒。' };
}

function presentFollow(follow, boot, catalog, collector) {
  const now = Date.now();
  const status = { ...(FOLLOW_STATUS[follow.status] || { label: follow.status, cls: 'muted' }) };
  if (follow.status === 'paused' && ['member_expired', 'membership_expired'].includes(follow.statusReason)) status.label = '会员到期，已暂停';
  let monitoringText = '';
  if (follow.status === 'active') {
    if (!boot.member) { status.cls = 'warn'; monitoringText = '会员未生效，当前不参与自动检测'; }
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

Page({
  data: {
    ready: false,
    loadError: null,
    catalog: null,
    boot: null,
    collector: null,
    follows: [],
    followsLoaded: false,
    limits: { maxFollows: 3, maxStoresPerFollow: 3 },
    editing: false,
    editor: { followId: null, pickerValue: null, selection: null, isNew: true },
    saving: false,
    subscription: { templateCount: 0, credits: 0 },
    delivery: { label: '正在确认', cls: 'muted', detail: '' },
    settings: { notifyEnabled: true },
    notice: '',
    readiness: { code: 'loading', title: '正在检查提醒条件', detail: '正在读取账户与关注状态。', tone: 'muted', action: '', actionLabel: '', activeCount: 0, storeCount: 0, ready: false },
    refreshing: false,
    subscribing: false,
    subscriptionPending: false,
    refreshError: null,
    refreshedText: null,
  },

  async onLoad() {
    if (this.loadingBoot) return;
    this.loadingBoot = true;
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => { this.catalog = catalog; if (this.data.ready && this.data.catalog.version !== catalog.version) this.setData({ catalog: toViewCatalog(catalog) }); });
    try {
      try { this.setData({ subscriptionPending: Boolean(wx.getStorageSync(localKey(SUBSCRIPTION_PENDING_KEY))) }); } catch (e) { /* ignore */ }
      const results = await Promise.all([getBootstrap(), getCatalog()]);
      const boot = results[0], initialCatalog = results[1];
      const catalog = getApp().globalData.catalog || initialCatalog;
      this.catalog = catalog;
      this.applyBoot(boot, { catalog: toViewCatalog(catalog), ready: true, loadError: null });
      await this.loadFollows();
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
    this.startPolling();
  },

  onHide() { this.visible = false; this.stopPolling(); },
  onUnload() { this.visible = false; this.stopPolling(); if (this.unsubscribeCatalog) this.unsubscribeCatalog(); },
  stopPolling() { this.pollEpoch = (this.pollEpoch || 0) + 1; if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; },
  startPolling() {
    this.stopPolling();
    const epoch = this.pollEpoch;
    const tick = async () => {
      if (!this.visible || epoch !== this.pollEpoch) return;
      this.refreshFollowPresentation();
      try {
        const boot = await getBootstrap();
        if (!this.visible || epoch !== this.pollEpoch) return;
        this.applyBoot(boot); await this.loadFollows({ force: true });
      } catch (e) { if (this.visible) this.setData({ refreshError: '刷新失败，以下保留上次观测，请下拉重试。' }); }
      if (this.visible && epoch === this.pollEpoch) this.pollTimer = setTimeout(tick, 15000);
    };
    this.pollTimer = setTimeout(tick, 15000);
  },

  async onPullDownRefresh() {
    try {
      const results = await Promise.all([getBootstrap({ force: true }), getCatalog({ force: true })]);
      const boot = results[0], catalog = results[1];
      this.catalog = catalog;
      this.applyBoot(boot, { catalog: toViewCatalog(catalog), ready: true, loadError: null });
      await this.loadFollows({ force: true });
    } catch (error) { showError(error); }
    finally { wx.stopPullDownRefresh(); }
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
    this.setData({
      boot: { member: boot.membership.active, expired: !boot.membership.active && Boolean(boot.membership.expiresAt), expiresAt: boot.membership.expiresAt, expiresText: boot.membership.expiresAt ? fmt.fmtDate(boot.membership.expiresAt) : null, notificationsEnabled: notifications.enabled, notificationReason: delivery.detail, templateIds, memberProduct: boot.memberProduct },
      collector: { ...collector, ...fmt.collectorMeta(collector.state), detail: DETECTION_DETAIL[collector.state] || '暂未取得后台检测状态，请稍后刷新。', updatedText: collector.updatedAt ? fmt.fmtDateTime(collector.updatedAt) : null, batchText: collector.lastBatchAt ? fmt.fmtDateTime(collector.lastBatchAt) : null },
      delivery,
      settings: boot.settings || { notifyEnabled: true },
      limits: boot.limits || this.data.limits,
      subscription,
      ...pageData,
    });
    this.refreshReadiness();
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
      if (generation !== (this.followReadGeneration || 0)) return;
      this.setData({ follows: data.follows.filter(f => f.status !== 'removed').map(f => presentFollow(f, this.data.boot || {}, this.catalog || this.data.catalog, this.data.collector)), followsLoaded: true, limits: data.limits, loadError: null, refreshError: null, refreshedText: fmt.fmtTime(Date.now()) });
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
    this.setData({ follows: this.data.follows.map(f => presentFollow(f, this.data.boot || {}, this.catalog || this.data.catalog, this.data.collector)) });
  },

  refreshReadiness() {
    const readiness = reminderReadiness(this.data);
    this.setData({ readiness, notice: readiness.ready ? '' : readiness.detail, dndActive: readiness.dndActive });
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
    this.setData({ refreshing: true });
    try { this.applyBoot(await getBootstrap({ force: true })); await this.loadFollows({ force: true }); }
    catch (error) { this.setData({ refreshError: '刷新失败，已保留上次状态。请稍后重试。' }); showError(error); }
    finally { this.setData({ refreshing: false }); }
  },

  onServiceDetails() {
    const { collector, delivery } = this.data;
    wx.showModal({ title: '检测与消息服务', content: `${collector.label}\n${collector.detail}${collector.updatedText ? '\n最近状态：' + collector.updatedText : ''}${collector.batchText ? '\n最近检测：' + collector.batchText : ''}\n\n${delivery.label}\n${delivery.detail}\n\n页面每 15 秒读取已有观测，不代表后台每 15 秒检测库存。`, showCancel: false });
  },

  openEditor({ followId, pickerValue, isNew }) {
    if (!this.data.boot.member) {
      this.showMemberModal();
      return;
    }
    this.setData({ editing: true, editor: { followId, pickerValue, selection: null, isNew } });
  },

  showMemberModal() {
    const product = this.data.boot.memberProduct || {};
    wx.showModal({
      title: '关注提醒为会员功能',
      content: `会员可关注 3 个具体配置，每个配置最多 3 家门店。不同容量或颜色分别占用一个关注名额。${product.paymentReady ? '' : '\n\n会员购买暂未开放，可在「我的」查看状态。'}`,
      confirmText: '前往我的',
      success: r => { if (r.confirm) wx.switchTab({ url: '/pages/mine/index' }); },
    });
  },

  onAdd() {
    if (this.data.follows.length >= this.data.limits.maxFollows) return toast(`最多同时关注 ${this.data.limits.maxFollows} 个机型`);
    this.openEditor({ followId: newId('f'), pickerValue: null, isNew: true });
  },

  onEdit(e) {
    const follow = this.data.follows.find(f => f.followId === e.currentTarget.dataset.id);
    if (!follow) return;
    this.openEditor({ followId: follow.followId, pickerValue: { partNumber: follow.partNumber, storeNumbers: follow.stores.map(s => s.storeNumber) }, isNew: false });
  },

  onCancelEdit() {
    this.setData({ editing: false });
  },

  onEditorChange(e) {
    this.setData({ 'editor.selection': e.detail });
  },

  async onSave() {
    if (this.data.saving) return;
    const { editor } = this.data;
    const selection = editor.selection;
    if (!selection || !selection.partNumber) return toast('请选择具体配置');
    if (!selection.product || !selection.product.supported) return toast('此配置暂未开放监测');
    if (!selection.storeNumbers.length) return toast('请至少选择一家门店');
    this.setData({ saving: true });
    try {
      await call('follow.upsert', { followId: editor.followId, partNumber: selection.partNumber, storeNumbers: selection.storeNumbers });
      this.invalidateFollowRead();
      this.setData({ editing: false });
      await this.loadFollows();
      invalidateBootstrap();
      refreshBootstrap().catch(() => {});
      toast(editor.isNew ? '已加入关注' : '已更新', 'success');
      if (editor.isNew && this.data.subscription.credits === 0) this.promptSubscribe();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ saving: false });
    }
  },

  promptSubscribe() {
    if (!this.data.boot.templateIds.length || this.data.delivery.cls !== 'ok') return;
    wx.showModal({
      title: '开启补货提醒',
      content: '微信订阅消息每授权一次只能发送一条提醒。建议现在授权，收到提醒后再次授权即可继续接收。',
      confirmText: '去授权',
      success: r => { if (r.confirm) this.onSubscribe(); },
    });
  },

  async onSubscribe() {
    if (this.data.subscribing) return;
    let saved;
    try { saved = wx.getStorageSync(localKey(SUBSCRIPTION_PENDING_KEY)); } catch (e) { /* ignore */ }
    if (saved) return this.flushSubscription(saved);
    const tmplIds = this.data.boot.templateIds;
    if (!tmplIds.length) {
      wx.showModal({ title: '提醒暂未开放', content: this.data.boot.notificationReason || '尚未配置可用的订阅消息模板。可在关注页查看已有观测，页面可见时每 15 秒刷新。', showCancel: false });
      return;
    }
    if (this.data.delivery.cls === 'warn') { this.onServiceDetails(); return; }
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
    try { wx.setStorageSync(localKey(SUBSCRIPTION_PENDING_KEY), pending); } catch (e) { /* kept in local call */ }
    this.setData({ subscriptionPending: true });
    return this.flushSubscription(pending);
  },

  async flushSubscription(pending) {
    this.setData({ subscribing: true });
    try {
      const data = await call('notify.recordSubscription', pending);
      const restockId = this.data.boot.templateIds[0];
      const credits = restockSubscription({ templateIds: { restock: restockId } }, data.subscriptions).credits;
      try { wx.removeStorageSync(localKey(SUBSCRIPTION_PENDING_KEY)); } catch (e) { /* ignore */ }
      this.setData({ 'subscription.credits': credits, subscriptionPending: false });
      this.refreshReadiness();
      toast(credits > 0 ? `已同步，可接收 ${credits} 条补货提醒` : '尚无有效补货提醒授权');
      refreshBootstrap().catch(() => {});
    } catch (error) {
      if (['invalid_subscription_result', 'invalid_request_id', 'invalid_payload'].includes(error.code)) {
        // A template may change while a previously authorized result is queued.
        // Only a definitive rejection releases the pending request; uncertain
        // network failures must retain its ID to avoid double crediting.
        try { wx.removeStorageSync(localKey(SUBSCRIPTION_PENDING_KEY)); } catch (e) { /* ignore */ }
        this.setData({ subscriptionPending: false });
        try { this.applyBoot(await getBootstrap({ force: true })); } catch (e) { /* retry on the next refresh */ }
        toast('授权记录已失效，请重新点击授权');
        return;
      }
      showError(error);
    } finally {
      this.setData({ subscribing: false });
    }
  },

  async onToggle(e) {
    if (this.toggling) return;
    if (!this.data.boot.member) { this.showMemberModal(); return; }
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
