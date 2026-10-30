const navigation = require('../../utils/navigation');
const { reminderPanelMethods } = require('../../utils/reminder-panel');
const { stageHistoryContext } = require('../../utils/journey-context');
const { productThumbnailUrl } = require('../../utils/product-image-fit');
const { call, newId, showError, toast } = require('../../utils/api');
const { getBootstrap, getCatalog, refreshBootstrap, invalidateBootstrap, subscribeCatalog, getFollows, invalidateFollows, subscribeSubscriptions } = require('../../utils/store');
const fmt = require('../../utils/format');
const { storeLabel, storeLabelWithCity } = require('../../utils/store-label');
const { syncTabBar, switchToTab, releaseTabBar } = require('../../utils/tab-bar');
const { restockSubscription, soldoutSubscription, reminderReadiness, canRemind, creditBoostTip } = require('../../utils/reminder-readiness');
const { shareAppMessage, shareTimeline } = require('../../utils/share');
const { followPollDelay } = require('../../utils/poll');
const { isOnline, subscribeNetwork } = require('../../utils/network');
const { getAuthorizationState, subscribeAuthorizationState, requestReminderAuthorization, syncPendingAuthorization, topUpReminderCredit, buildConsentReport, openSubscribeSettings } = require('../../utils/reminder-credits');
const { confirmTap } = require('../../utils/haptic');
const { createCheckoutContext } = require('../../utils/checkout-context');
const { activationStatus } = require('../../utils/activation-status');
const { targetSignature } = require('../../utils/result-next-action');
const conversion = require('../../utils/conversion-events');
const { presentDeadline, deadlineError } = require('../../utils/deadlines');

const FOLLOW_STATUS = {
  active: { label: '关注已开启', cls: 'ok' },
  paused: { label: '关注已暂停', cls: 'muted' },
  expired: { label: '会员已到期，监测已停止', cls: 'warn' },
  limit_paused: { label: '超出当前套餐名额', cls: 'muted' },
};

const DELIVERY_REASON = {
  template_missing: '订阅消息模板尚未配置，暂不能授权或发送提醒。',
  notifications_disabled: '提醒发送服务尚未开启。',
  collector_not_deployed: '后台检测服务尚未启动，暂不能自动发现补货。',
  collector_stale: '后台检测服务状态已过期，正在等待恢复。',
  collector_observation_stale: '库存观测未及时更新，暂不能确认最新取货状态；关注和提醒次数会保留。',
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
  budget_limited: '后台检测请求较多，正在等待更新；已开启的关注会保留。',
  error: '后台检测出现异常，暂不能确认最新库存，请稍后刷新。',
};

function deliveryView(notifications, templateIds) {
  const overallReady = notifications.deliveryReady === true;
  const hasSenderStatus = typeof notifications.senderReady === 'boolean';
  const senderReady = hasSenderStatus ? notifications.senderReady : overallReady;
  const rawReason = hasSenderStatus ? notifications.senderReason : notifications.reason || notifications.disabledReason;
  const reason = typeof rawReason === 'string' ? rawReason : '';
  const detail = DELIVERY_REASON[reason] || (/[^\x00-\x7F]/.test(reason) ? reason : '消息服务尚未就绪，请稍后刷新状态。');
  if (!templateIds.length) return { overallReady, label: '暂不能发送', cls: 'warn', detail: DELIVERY_REASON.template_missing };
  if (!notifications.enabled) return { overallReady, label: '尚未开放', cls: 'warn', detail: DELIVERY_REASON.notifications_disabled };
  if (!senderReady && reason.startsWith('collector_')) return { overallReady, label: '发送状态待确认', cls: 'muted', detail: '暂未取得微信发送通道的有效状态，请稍后刷新确认。' };
  if (!senderReady) return { overallReady, label: '发送服务未就绪', cls: 'warn', detail };
  return { overallReady, label: '发送服务已就绪', cls: 'ok', detail: '微信发送通道已连接。实际发送仍需库存、关注与有效授权等条件满足。' };
}

const FEEDBACK_TOAST = { bought: '恭喜买到！', missed: '已记录，继续为你盯着', skipped: '已记录，继续为你盯着' };

/** The alert a WeChat message opened: when it was found and what the store shows now. */
function presentAlert({ notification: n, latest, follow }, now = Date.now()) {
  const current = fmt.stockObservation(latest || {}, now, { restricted: Boolean(latest && latest.restricted) });
  return {
    eventId: n.eventId,
    productTitle: n.productTitle,
    partNumber: n.partNumber,
    storeName: storeLabel(n.storeNumber, n.storeName),
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
  const retired = Boolean(follow.productRetired || follow.statusReason === 'product_retired');
  if (follow.status === 'paused' && ['member_expired', 'membership_expired'].includes(follow.statusReason)) status.label = '会员到期，已暂停';
  if (follow.status === 'expired') status.label = '会员已到期，监测已停止';
  if (retired) { status.label = '老款已下架，请改选新款'; status.cls = 'warn'; }
  let monitoringText = retired
    ? '老款官方取货接口已停用，请改选新款配置'
    : follow.status === 'limit_paused' ? '配置已保留，可在会员权益中查看可用名额并恢复' : '';
  if (!retired && follow.status === 'active') {
    if (!canRemind(boot)) { status.cls = 'warn'; monitoringText = '会员未生效，当前不参与自动检测'; }
    else if (!collector || collector.state !== 'running' || collector.observationStale) monitoringText = '关注已保存，后台检测情况见上方';
  }
  const product = catalog && catalog.productByPart && catalog.productByPart[follow.partNumber];
  const stores = (follow.stores || []).map(s => ({ ...s, storeName: storeLabel(s.storeNumber, s.storeName), storeLabel: storeLabelWithCity(s.storeNumber, s.storeName, s.city), ...fmt.stockObservation(s, now, { restricted: follow.latestRestricted }),
    ...(Date.parse(s.observedAt) > now ? { observationState: 'unknown', statusLabel: '观测时间待核对', statusCls: 'unknown', freshnessText: '这条观测的时间尚未确认，请刷新后再判断取货状态。' } : {}),
    ...(s.limitPaused ? { statusLabel: follow.limitPaused ? '配置超出套餐名额' : '超出套餐门店上限', statusCls: 'muted',
      freshnessText: follow.limitPaused ? '配置和门店已保留，恢复配置名额后继续检测。' : '门店已保留，当前暂停检测；月卡支持 4 家门店，年卡支持 5 家。' } : {}) })).map(store => {
    const observed = Date.parse(store.observedAt);
    const validTime = Number.isFinite(observed) && observed <= now;
    const previous = store.lastKnownStatus || store.status;
    if (retired && store.observationState === 'fresh') store = { ...store, observationState: 'stale' };
    const historical = validTime && ['stale', 'unknown'].includes(store.observationState);
    const knownAt = Date.parse(store.knownAt);
    return { ...store,
      compactStatus: store.limitPaused ? '已暂停' : historical && previous === 'available' ? '上次有货'
        : historical && previous === 'unavailable' ? '上次无货' : store.statusLabel,
      compactTone: historical ? 'muted' : store.statusCls,
      checkText: store.observationState === 'restricted' ? '实时库存暂不可见' : validTime ? `${fmt.relative(store.observedAt, now)}检查 · ${fmt.fmtDateTime(store.observedAt).slice(5, 16)}`
        : Number.isFinite(observed) ? '检查时间待核对' : '等待首次检查',
      lastResultTimeText: historical && Number.isFinite(knownAt) && knownAt < observed && knownAt <= now
        ? `上次有效结果 ${fmt.fmtDateTime(store.knownAt).slice(5, 16)}` : '',
      compactNote: store.limitPaused || store.observationState === 'restricted' ? store.freshnessText
        : Number.isFinite(observed) && observed > now ? '设备与检测时间不一致，当前库存待确认。'
        : store.observationState === 'unknown' ? '本次检查未取得有效库存' : '',
    };
  });
  const color = product && product.attributes && product.attributes.color || '';
  const title = follow.productTitle || product && product.title || follow.partNumber;
  const splitColor = color && title.endsWith(color);
  const usable = stores.filter(store => !store.limitPaused);
  const availableCount = usable.filter(store => store.observationState === 'fresh' && store.status === 'available').length;
  const historicalAvailableStores = usable.filter(store => !['fresh', 'restricted'].includes(store.observationState)
    && Number.isFinite(Date.parse(store.observedAt)) && Date.parse(store.observedAt) <= now
    && (store.lastKnownStatus === 'available' || (!store.lastKnownStatus && store.status === 'available')));
  const historicalAvailable = historicalAvailableStores.length;
  const incomplete = !usable.length || usable.some(store => store.observationState !== 'fresh');
  // A fresh available headline must carry the time of those available stores,
  // not a different store's old/failed check. Details retain each store's time.
  const headlineStores = follow.latestRestricted || follow.limitPaused ? [] : availableCount ? usable.filter(store => store.observationState === 'fresh' && store.status === 'available') : historicalAvailable ? historicalAvailableStores : usable;
  const observed = headlineStores.map(store => Date.parse(!availableCount && historicalAvailable
    ? store.knownAt || (store.status === 'available' ? store.observedAt : null) : store.observedAt))
    .filter(stamp => Number.isFinite(stamp) && stamp <= now);
  const observationAt = observed.length ? Math.min(...observed) : null;
  const stockLabel = follow.latestRestricted ? '库存暂不可见' : follow.limitPaused ? '监测已暂停'
    : availableCount ? `${availableCount} 家可取货` : historicalAvailable ? `上次 ${historicalAvailable} 家可取货`
    : usable.some(store => Date.parse(store.observedAt) > now) ? '检查时间待核对'
    : incomplete ? usable.every(store => !store.observedAt) ? '等待首次检查' : '库存待确认' : '所选门店暂不可取货';
  return {
    ...follow,
    productRetired: retired,
    canToggle: !retired && !follow.limitPaused && follow.status !== 'limit_paused',
    canQuery: !retired,
    editLabel: retired ? '改选新款' : '调整',
    cardTitle: splitColor ? title.slice(0, -color.length).trim() : title,
    cardSubtitle: splitColor ? color : '',
    observationLabel: stockLabel,
    observationTone: availableCount ? 'ok' : incomplete ? 'warn' : 'muted',
    observationIncomplete: availableCount > 0 && incomplete,
    stockDetail: retired ? '老款已停止检测，已有结果仅供回看。'
      : follow.latestRestricted ? '当前权益暂不能查看此配置的库存。'
      : follow.limitPaused ? '配置已保留，可调整关注或查看会员名额。'
      : availableCount ? usable.filter(store => store.observationState === 'fresh' && store.status === 'available').map(store => store.storeLabel).join('、')
      : historicalAvailable ? '这是上次的结果，当前库存待确认。'
      : incomplete ? observationAt === null ? '关注已保存，有检测结果后会在这里显示。' : '最近未取得新的有效结果，不能据此判断无货。'
      : follow.status === 'active' ? '有货后会更新这里，并按你的提醒设置发送消息。' : '自动检测已暂停，可恢复关注继续留意。',
    notificationExpectation: retired ? '老款无法恢复检测，请改选新款。'
      : follow.status !== 'active' ? '此配置未在监测，可在详情中恢复。'
      : availableCount ? '同一轮持续有货不重复提醒，可直接查看取货信息。'
      : incomplete ? '后台检测结果会自动同步，无需手动查询。'
      : '确认有货且提醒条件满足后，将发送微信提醒。',
    observationTime: observationAt === null ? '等待观测' : fmt.fmtDateTime(observationAt).slice(5, 16),
    observationAge: observationAt === null || (!availableCount && historicalAvailable && observed.length !== headlineStores.length)
      ? '' : `${fmt.relative(new Date(observationAt).toISOString(), now)}检查`,
    pendingStoreCount: usable.filter(store => store.observationState !== 'fresh').length,
    imageUrl: product && product.imageUrl || '',
    imageDisplayUrl: productThumbnailUrl(product && product.imageUrl, 'card', product && product.partNumber),
    imageAlt: product && product.imageAlt || follow.productTitle,
    statusLabel: status.label,
    statusCls: status.cls,
    monitoringText,
    hasAvailable: follow.status !== 'limit_paused' && stores.some(s => !s.limitPaused && s.observationState === 'fresh' && s.status === 'available'),
    detailsExpanded: follow.detailsExpanded === true,
    stores,
  };
}

// A refresh changes content, not where the user was looking. New rows are appended.
function retainFollowOrder(incoming, previous) {
  const byId = new Map(incoming.map(follow => [follow.followId, follow]));
  const ordered = [];
  for (const old of previous) {
    const follow = byId.get(old.followId);
    if (!follow) continue;
    ordered.push({ ...follow, detailsExpanded: old.detailsExpanded === true });
    byId.delete(old.followId);
  }
  return ordered.concat([...byId.values()]);
}

function selectionKey(selection) {
  return JSON.stringify([selection && selection.partNumber || '', [...new Set(selection && selection.storeNumbers || [])].sort()]);
}

function readinessTaskDetail(readiness) {
  return {
    membership: '关注配置和剩余提醒次数会保留，可在「我的」查看会员。',
    collector_idle: '关注已保存，等待后台下一轮检测，无需重复添加。',
    collector_unready: '关注已保存；后台恢复后继续检测，无需重复添加。',
    delivery_unready: '后台仍在检测，消息发送恢复前暂时收不到微信提醒。',
    template_missing: '关注会保留，服务配置完成后才能授权和发送微信提醒。',
    user_disabled: '后台检测继续，开启消息开关后才能收到提醒。',
    dnd: '后台检测继续；免打扰期间不发消息，也不补发旧提醒。',
  }[readiness.code] || readiness.detail;
}

function followActionError(error, action) {
  // Transport errors have no trustworthy write result; business rejections do.
  if (error && error.code && !['call_failed', 'bad_response', 'timeout', 'request_timeout'].includes(error.code)) return error.message || `${action}未完成，请稍后重试。`;
  return `${action}结果尚未确认，请刷新状态后再试。`;
}

function confirmsSavedFollow(follow, payload) {
  if (!follow || typeof follow.followId !== 'string' || follow.partNumber !== payload.partNumber || follow.status !== 'active' || !Array.isArray(follow.stores)) return false;
  if (follow.followId !== payload.followId && !follow.followId.endsWith('|' + payload.followId)) return false;
  const actual = [...new Set(follow.stores.map(store => store.storeNumber))].sort();
  const expected = [...new Set(payload.storeNumbers)].sort();
  return actual.length === expected.length && actual.every((number, index) => number === expected[index]);
}

Page({
  ...reminderPanelMethods,
  data: {
    deadlines: [],
    deadlineCount: 0,
    deadlinesLoaded: false,
    deadlinesLoading: false,
    deadlinesError: '',
    deadlineCanOpen: false,
    deadlineServiceLabel: '读取中',
    deadlineRecordOnly: false,
    nextDeadline: null,
    recentStock: null,
    networkOffline: false,
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
    editorDirty: false,
    editorSummary: '',
    saveError: '',
    saving: false,
    subscription: { templateCount: 0, credits: 0 },
    consent: null,
    delivery: { label: '正在确认', cls: 'muted', detail: '' },
    showServiceDetails: false,
    readiness: { code: 'loading', title: '正在检查提醒条件', detail: '正在读取账户与关注状态。', tone: 'muted', action: '', actionLabel: '', activeCount: 0, storeCount: 0, ready: false },
    creditBoostTip: '',
    primaryTopUp: true,
    refreshing: false,
    subscribing: false,
    subscriptionPending: false,
    authorization: { pendingRestock: 0, pendingSoldout: 0, pendingCount: 0, syncing: false, errorMessage: '', storageBlocked: false },
    authorizationFeedback: '',
    authorizationOpen: false,
    refreshError: null,
    refreshFeedback: '',
    refreshedText: null,
    liveSync: { state: 'waiting', lastReadText: '', nextReadText: '', detail: '页面打开时自动读取后台记录，不消耗查询次数。' },
    alert: null,
    alertBusy: false,
    followBusyId: '',
    followActionError: '',
    followActionId: '',
    readinessTaskDetail: '',
    activation: null,
  },

  async onLoad(options) {
    if (this.pageRetired) return;
    this.loadDeadlines();
    if (options && options.eid) getApp().captureAlert({ query: { eid: options.eid } });
    if (this.loadingBoot) return;
    this.loadStarted = true;
    this.loadingBoot = true;
    const epoch = this.lifecycleEpoch || 0;
    const current = () => !this.pageRetired && this.visible !== false && epoch === (this.lifecycleEpoch || 0);
    this.watchLiveNetwork();
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => { this.catalog = catalog; if (this.data.ready && this.data.catalogVersion !== catalog.version) this.setData({ catalogVersion: catalog.version }); });
    try {
      this.observeAuthorization();
      const results = await Promise.all([getBootstrap(), getCatalog()]);
      if (!current()) return;
      const boot = results[0], initialCatalog = results[1];
      const catalog = getApp().globalData.catalog || initialCatalog;
      this.catalog = catalog;
      this.applyBoot(boot, { catalogVersion: catalog.version, ready: true, loadError: null });
      this.resumeAuthorizationSync();
      await this.loadFollows();
      if (!current()) return;
      this.consumePendingAlert();
      if (this.visible) this.startPolling();
    } catch (error) {
      if (current()) this.setData({ loadError: error.message || String(error) });
    } finally {
      this.loadingBoot = false;
      // A quick hide/show can retire startup before onShow has an account to
      // refresh. Finish that old work, then let the visible visit retry once.
      if (!this.pageRetired && this.visible && !this.data.ready && epoch !== (this.lifecycleEpoch || 0)) await this.onLoad();
    }
  },

  async onShow() {
    if (this.pageRetired) return;
    syncTabBar(this, '/pages/follow/index');
    this.visible = true;
    // Date reminders refresh once per visit, independently of the Apple poll.
    if (this.deadlinesShown) this.loadDeadlines();
    this.deadlinesShown = true;
    this.alertAccountUnconfirmed = true;
    this.watchLiveNetwork();
    this.syncAuthorizationOverlay();
    this.observeAuthorization();
    this.applyAuthorizationState(getAuthorizationState());
    this.resumeAuthorizationSync();
    this.nativePromptHiddenAt = 0;
    if (!this.data.ready) {
      this.consumePending();
      if (!this.loadingBoot && (this.loadStarted || this.data.loadError)) return this.onRetryLoad();
      return;
    }
    this.refreshFollowPresentation();
    // Returning after any absence reads current server records immediately.
    // It must not serve the 15-second shared snapshot or wait another minute.
    await this.refreshLiveStatus();
    if (!this.visible || this.pageRetired) return;
    this.recordAlertOpen();
    getCatalog();
    this.consumePending();
    this.consumePendingFocus();
    this.consumePendingAlert();
  },

  onHide() {
    this.retireDeadlineRead();
    releaseTabBar(this);
    this.nativePromptHiddenAt = getAuthorizationState().nativeBusy ? Date.now() : 0;
    this.visible = false; this.hideAuthorizationOverlay();
    this.serviceDetailsFocusEpoch = (this.serviceDetailsFocusEpoch || 0) + 1;
    this.retireLiveRead(); this.stopPolling(); this.stopObservationClock();
    this.setLiveSync('paused', '页面返回后会立即更新后台记录。');
  },
  onUnload() {
    this.retireDeadlineRead();
    releaseTabBar(this);
    this.disposeAuthorizationPanel(); this.pageRetired = true; this.visible = false;
    this.serviceDetailsFocusEpoch = (this.serviceDetailsFocusEpoch || 0) + 1;
    this.retireLiveRead(); this.stopPolling(); this.stopObservationClock();
    if (this.unsubscribeCatalog) this.unsubscribeCatalog();
    if (this.unsubscribeCredits) this.unsubscribeCredits();
    if (this.unsubscribeAuthorization) this.unsubscribeAuthorization();
    if (this.unsubscribeLiveNetwork) this.unsubscribeLiveNetwork();
  },

  onShareAppMessage() {
    return shareAppMessage('/pages/follow/index', this.data);
  },

  onShareTimeline() {
    return shareTimeline('/pages/follow/index', this.data);
  },

  onAddToFavorites() {
    return { title: '果小哨 · 我的到货提醒' };
  },

  watchLiveNetwork() {
    if (this.unsubscribeLiveNetwork) return;
    this.unsubscribeLiveNetwork = subscribeNetwork(online => {
      if (this.pageRetired || !this.visible) return;
      if (!online) {
        this.stopPolling(); this.refreshFollowPresentation();
        this.startObservationClock();
        this.setLiveSync('offline', '网络已断开，保留上次记录；联网后自动更新。');
      } else this.onNetworkRestored();
    });
  },

  setLiveSync(state, detail, nextAt = null) {
    if (this.pageRetired) return;
    this.setData({ liveSync: { state, detail,
      lastReadText: this.data.refreshedText || '',
      nextReadText: nextAt ? fmt.fmtTime(nextAt) : '' } });
  },

  stopObservationClock() {
    if (this.observationTimer) clearTimeout(this.observationTimer);
    this.observationTimer = null;
  },

  startObservationClock() {
    if (this.observationTimer || this.pageRetired || !this.visible || !this.data.follows.length) return;
    // This clock only ages local records. A disconnected phone or a long
    // network retry delay must never leave a once-fresh stock badge fresh.
    this.observationTimer = setTimeout(() => {
      this.observationTimer = null;
      if (this.pageRetired || !this.visible) return;
      if (!this.lastLocalPresentationAt || Date.now() - this.lastLocalPresentationAt >= 1000) {
        this.refreshFollowPresentation();
        this.lastLocalPresentationAt = Date.now();
      }
      this.startObservationClock();
    }, 30000);
  },

  retireLiveRead() {
    this.lifecycleEpoch = (this.lifecycleEpoch || 0) + 1;
    this.liveCycle = null;
    this.liveRefreshPromise = null;
    // Retire only this page's presentation. The shared read can still settle
    // for another page, and a quick return joins that same native request.
    this.followReadGeneration = (this.followReadGeneration || 0) + 1;
    this.followsPromise = null;
    this.statusRefreshEpoch = (this.statusRefreshEpoch || 0) + 1;
    if (!this.pageRetired && this.data.refreshing) this.setData({ refreshing: false, refreshFeedback: '' });
  },

  /** Both tab-bar and page network listeners share the same in-flight refresh. */
  onNetworkRestored() {
    if (this.pageRetired || this.visible === false) return;
    this.resumeAuthorizationSync();
    if (this.data.loadError) return this.onRetryLoad();
    if (!this.data.ready) return;
    this.liveFailures = 0;
    return this.refreshLiveStatus();
  },

  stopPolling() { this.pollEpoch = (this.pollEpoch || 0) + 1; if (this.pollTimer) clearTimeout(this.pollTimer); this.pollTimer = null; },
  startPolling() {
    this.stopPolling();
    if (this.pageRetired || !this.visible) return;
    this.startObservationClock();
    this.watchLiveNetwork();
    if (!isOnline()) { this.setLiveSync('offline', '网络已断开，保留上次记录；联网后自动更新。'); return; }
    const delay = followPollDelay(this.data.collector, this.liveFailures || 0);
    const epoch = this.pollEpoch;
    const degraded = this.liveFailures > 0;
    this.setLiveSync(degraded ? 'retrying' : 'waiting', degraded
      ? '后台记录暂未更新，保留上次结果并自动重试。'
      : '自动读取后台记录，不消耗查询次数；库存时间见各门店。', Date.now() + delay);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (!this.visible || this.pageRetired || epoch !== this.pollEpoch) return;
      return this.refreshLiveStatus();
    }, delay);
  },

  refreshLiveStatus() {
    if (this.pageRetired) return Promise.resolve({ ok: false });
    if (this.liveRefreshPromise) return this.liveRefreshPromise;
    this.alertAccountUnconfirmed = true;
    this.stopPolling();
    this.startObservationClock();
    if (!isOnline()) {
      this.refreshFollowPresentation();
      this.setLiveSync('offline', '网络已断开，保留上次记录；联网后自动更新。');
      return Promise.resolve({ ok: false, offline: true });
    }
    const cycle = { accountEpoch: this.accountEpoch || 0 };
    this.liveCycle = cycle;
    const current = () => !this.pageRetired && this.liveCycle === cycle && cycle.accountEpoch === (this.accountEpoch || 0);
    this.setLiveSync('syncing', '正在读取后台检测与提醒状态，不消耗查询次数。');
    let accountError = null, followError = null;
    // Read concurrently: a slow or unavailable account endpoint must not stop
    // follow.list from retrieving new observations. Only presentation waits for
    // the account decision, so old-account responses cannot cross that boundary.
    const account = getBootstrap({ force: true }).then(boot => {
      if (!current()) return;
      this.applyingLiveBoot = cycle;
      try { this.applyBoot(boot, { ready: true, loadError: null }); }
      finally { this.applyingLiveBoot = null; }
      cycle.accountEpoch = this.accountEpoch || 0;
    }).catch(error => { accountError = error; });
    const follows = this.loadFollows({ force: true, beforePresent: account }).then(applied => {
      if (!current() || applied) return applied;
      // applyBoot may have confirmed an account switch and invalidated the
      // response already in flight. Read under that new account before display.
      return this.loadFollows();
    }).catch(error => { followError = error; });
    const pending = Promise.all([account, follows]).then(() => {
      if (!current()) return { ok: false, retired: true };
      this.refreshFollowPresentation();
      this.lastLocalPresentationAt = Date.now();
      this.liveFailures = followError || accountError ? (this.liveFailures || 0) + 1 : 0;
      if (followError) this.setData({ refreshError: '后台记录暂未更新，保留上次观测；联网时会自动重试。' });
      else if (accountError) this.setData({ refreshError: '库存记录已更新，账户与提醒条件暂未更新；将自动重试。' });
      if (!accountError && this.visible) this.recordAlertOpen();
      return { ok: !followError, accountError, error: followError };
    }).finally(() => {
      if (this.liveRefreshPromise === pending) this.liveRefreshPromise = null;
      if (current() && this.visible) this.startPolling();
    });
    this.liveRefreshPromise = pending;
    return pending;
  },

  async onPullDownRefresh() {
    if (this.pageRetired) return;
    try { await this.onRefreshStatus(); }
    finally { wx.stopPullDownRefresh(); }
  },

  async consumePendingAlert() {
    if (this.pageRetired) return;
    const app = getApp(), eventId = app.globalData.pendingAlert;
    if (!eventId || !this.data.ready) return;
    app.globalData.pendingAlert = null;
    return this.loadAlert(eventId);
  },

  async loadAlert(eventId) {
    if (this.pageRetired || this.data.alert && this.data.alert.eventId === eventId && this.data.alert.loading) return;
    const epoch = this.alertReadEpoch = (this.alertReadEpoch || 0) + 1;
    const accountEpoch = this.accountEpoch || 0;
    const current = () => !this.pageRetired && accountEpoch === (this.accountEpoch || 0)
      && epoch === this.alertReadEpoch && this.data.alert && this.data.alert.eventId === eventId;
    this.alertFeedbackWork = null;
    this.setData({ alert: { eventId, loading: true }, alertBusy: false });
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    try {
      const data = await call('notify.detail', { eventId });
      if (current()) {
        this.setData({ alert: presentAlert(data) }, () => {
          if (!current()) return;
          const app = getApp();
          if (!app.globalData.handledAlerts.includes(eventId)) app.globalData.handledAlerts.push(eventId);
          this.presentedAlertId = eventId;
          this.recordAlertOpen();
        });
      }
    } catch (error) {
      if (current()) this.setData({ alert: { eventId,
        error: error.message || '提醒详情暂时无法读取', retryable: error.code !== 'notification_not_found' && error.code !== 'invalid_notification_id' } });
    }
  },

  onRetryAlert() {
    const alert = this.data.alert;
    if (!alert || !alert.retryable || alert.loading) return;
    return this.loadAlert(alert.eventId);
  },

  recordAlertOpen() {
    const alert = this.data.alert, eventId = this.presentedAlertId;
    const identityConfirmed = () => {
      const cached = getApp().globalData.bootstrap;
      const cachedKey = cached && cached.identity && cached.identity.userKey;
      const pageKey = this.accountSnapshot && this.accountSnapshot.identity && this.accountSnapshot.identity.userKey;
      return !this.alertAccountUnconfirmed && (!cachedKey || cachedKey === pageKey);
    };
    if (this.pageRetired || this.visible !== true || !identityConfirmed() || !eventId || !alert || alert.eventId !== eventId || alert.loading || alert.error) return;
    if (!this.acknowledgedAlerts) this.acknowledgedAlerts = new Set();
    const accountEpoch = this.accountEpoch || 0;
    const readEpoch = this.alertReadEpoch || 0;
    if (this.acknowledgedAlerts.has(eventId) || this.alertOpenInFlight
      && this.alertOpenInFlight.eventId === eventId && this.alertOpenInFlight.accountEpoch === accountEpoch
      && (this.alertOpenInFlight.sent || this.alertOpenInFlight.readEpoch === readEpoch)) return;
    const work = { eventId, accountEpoch, readEpoch, sent: false };
    const currentAccount = () => !this.pageRetired && accountEpoch === (this.accountEpoch || 0);
    this.alertOpenInFlight = work;
    // Analytics is independent of displaying stock or recording feedback. A
    // failed acknowledgment can retry on the next visible visit, never in a loop.
    return Promise.resolve().then(() => {
      if (!currentAccount() || !this.visible || !identityConfirmed() || readEpoch !== (this.alertReadEpoch || 0)
        || this.presentedAlertId !== eventId || !this.data.alert || this.data.alert.eventId !== eventId) return;
      work.sent = true;
      return call('notify.open', { eventId });
    }).then(() => { if (work.sent && currentAccount()) this.acknowledgedAlerts.add(eventId); }).catch(() => {})
      .finally(() => { if (this.alertOpenInFlight === work) this.alertOpenInFlight = null; });
  },

  onCloseAlert() {
    this.alertReadEpoch = (this.alertReadEpoch || 0) + 1;
    this.presentedAlertId = null; this.alertFeedbackWork = null;
    this.setData({ alert: null, alertBusy: false });
  },

  onCopyAlert() {
    const alert = this.data.alert;
    if (!alert || !alert.partNumber) return;
    topUpReminderCredit();
    wx.setClipboardData({
      data: `${alert.productTitle}\n型号：${alert.partNumber}\n门店：Apple ${alert.storeName}`,
      success: () => toast('已复制，可到 Apple Store App 下单'),
      fail: () => toast('复制失败，请长按文字手动复制'),
    });
  },

  async onAlertFeedback(e) {
    const alert = this.data.alert, outcome = e.currentTarget.dataset.outcome;
    if (this.pageRetired || !alert || !alert.eventId || this.data.alertBusy) return;
    topUpReminderCredit();
    const accountEpoch = this.accountEpoch || 0, readEpoch = this.alertReadEpoch || 0;
    const work = {};
    this.alertFeedbackWork = work;
    const currentAccount = () => !this.pageRetired && accountEpoch === (this.accountEpoch || 0);
    const isCurrentAlert = () => currentAccount() && readEpoch === (this.alertReadEpoch || 0)
      && this.alertFeedbackWork === work && this.data.alert && this.data.alert.eventId === alert.eventId;
    this.setData({ alertBusy: true });
    try {
      const result = await call('notify.feedback', { eventId: alert.eventId, outcome });
      if (!currentAccount()) return;
      if (result.paused) this.invalidateFollowRead();
      // Closing or replacing the card must survive a late feedback response.
      if (isCurrentAlert()) {
        this.setData({ 'alert.feedback': result.outcome, 'alert.followActive': alert.followActive && !result.paused });
        if (this.visible !== false) {
          if (outcome === 'bought') confirmTap();
          toast(result.paused ? '恭喜买到！已暂停这条关注' : outcome === 'bought' ? '已记录买到反馈，当前关注未暂停' : FEEDBACK_TOAST[outcome]);
        }
      }
      if (result.paused && this.visible !== false) {
        try { await this.loadFollows(); }
        catch (error) { if (currentAccount()) this.setData({ refreshError: '反馈已记录，关注列表刷新失败，请下拉刷新。' }); }
      }
    } catch (error) {
      if (isCurrentAlert() && this.visible !== false) showError(error);
    } finally {
      if (currentAccount() && this.alertFeedbackWork === work) {
        this.alertFeedbackWork = null;
        this.setData({ alertBusy: false });
      }
    }
  },

  consumePending() {
    if (this.pageRetired) return;
    const pending = getApp().globalData.pendingFollow;
    if (!pending) return;
    getApp().globalData.pendingFollow = null;
    if (!this.data.ready) {
      this.pendingAfterReady = pending;
      return;
    }
    this.openPendingEditor(pending);
  },

  openPendingEditor(pending) {
    if (pending.checkoutRevision) {
      const identity = this.accountSnapshot && this.accountSnapshot.identity;
      const restored = this.checkoutStore().restore(identity, this.catalog);
      if (restored.status !== 'ready' || restored.context.revision !== pending.checkoutRevision
        || restored.context.targetSignature !== pending.checkoutSignature || restored.context.targetSignature !== targetSignature(pending)) {
        this.refreshActivation();
        return toast('原选择已变化或过期，请重新确认配置与门店');
      }
    }
    this.openEditor({ followId: newId('f'), pickerValue: pending, isNew: true });
  },

  applyBoot(boot, pageData = {}) {
    if (this.pageRetired) return;
    let reloadDeadlines = false;
    const hadDeadlineRead = Boolean(this.loadStarted || this.deadlineUserKey || this.deadlineReadPromise);
    if (this.deadlineUserKey && boot.identity && this.deadlineUserKey !== boot.identity.userKey) {
      this.retireDeadlineRead();
      this.deadlineUserKey = null;
      this.setData({ deadlines: [], deadlineCount: 0, deadlinesLoaded: false, deadlinesError: '', nextDeadline: null,
        deadlineCanOpen: false, deadlineServiceLabel: '读取中', deadlineRecordOnly: false });
      reloadDeadlines = hadDeadlineRead;
    }
    const previousIdentity = this.accountSnapshot && this.accountSnapshot.identity;
    let restartAfterAccountChange = false;
    if (previousIdentity && boot.identity && previousIdentity.userKey !== boot.identity.userKey) {
      if (this.liveCycle && this.applyingLiveBoot !== this.liveCycle) {
        this.retireLiveRead();
        restartAfterAccountChange = true;
      }
      this.accountEpoch = (this.accountEpoch || 0) + 1;
      this.retireDeadlineRead();
      this.deadlineUserKey = null;
      this.setData({ deadlines: [], deadlineCount: 0, deadlinesLoaded: false, deadlinesError: '', nextDeadline: null,
        deadlineCanOpen: false, deadlineServiceLabel: '读取中', deadlineRecordOnly: false });
      reloadDeadlines = hadDeadlineRead;
      this.statusRefreshEpoch = (this.statusRefreshEpoch || 0) + 1;
      this.editorEpoch = (this.editorEpoch || 0) + 1;
      // Inventory event IDs are shared across accounts. Retire every alert
      // callback, including late feedback/open receipts for that same event.
      this.alertReadEpoch = (this.alertReadEpoch || 0) + 1;
      this.presentedAlertId = null;
      this.alertOpenInFlight = null;
      this.alertFeedbackWork = null;
      this.acknowledgedAlerts = new Set();
      getApp().globalData.handledAlerts = [];
      this.invalidateFollowRead();
      this.editorSelection = null;
      this.setData({ follows: [], followsLoaded: false, editing: false, saving: false, activation: null, authorizationOpen: false, authorizationFeedback: '', refreshing: false, refreshFeedback: '', refreshError: null, alert: null, alertBusy: false });
    }
    this.accountSnapshot = boot;
    if (reloadDeadlines) this.loadDeadlines();
    this.features = boot.features || {};
    const notifications = boot.notifications || {};
    const subscription = restockSubscription(notifications, boot.subscriptions);
    const templateIds = subscription.templateIds;
    const collector = boot.collector || { state: 'not_deployed' };
    const delivery = deliveryView(notifications, templateIds);
    const member = boot.membership.active, expired = !member && Boolean(boot.membership.expiresAt);
    // Sell-out alerts are a member feature on their own template, requested in the same prompt.
    const soldout = member && templateIds.length ? soldoutSubscription(notifications, boot.subscriptions) : { templateId: null, credits: 0 };
    this.settings = boot.settings || { notifyEnabled: true };
    this.setData({
      // Follow and WeChat reminders are member-only; free accounts only get query credits.
      boot: { member, expired, freeReminder: false, freeReminderUsed: false, expiresAt: boot.membership.expiresAt, expiresText: boot.membership.expiresAt ? fmt.fmtDate(boot.membership.expiresAt) : null, notificationsEnabled: notifications.enabled, notificationReason: delivery.detail, templateIds, soldoutId: soldout.templateId, requestIds: soldout.templateId ? [...templateIds, soldout.templateId] : templateIds, templateTitle: typeof notifications.templateTitle === 'string' ? notifications.templateTitle.trim() : '', memberProduct: boot.memberProduct },
      collector: { ...collector, ...fmt.collectorMeta(collector.state), detail: DETECTION_DETAIL[collector.state] || '暂未取得后台检测状态，请稍后刷新。',
        ...(collector.observationStale ? { label: '库存观测更新延迟', cls: 'warn', detail: DELIVERY_REASON.collector_observation_stale } : {}),
        updatedText: collector.updatedAt ? fmt.fmtDateTime(collector.updatedAt) : null, batchText: collector.lastBatchAt ? fmt.fmtDateTime(collector.lastBatchAt) : null },
      delivery,
      limits: boot.limits || this.data.limits,
      subscription: { ...subscription, soldoutEnabled: Boolean(soldout.templateId), soldoutCredits: soldout.credits },
      subscriptionPending: getAuthorizationState().pendingCount > 0,
      ...pageData,
    });
    this.observeAuthorization();
    this.applyAuthorizationState(getAuthorizationState());
    this.refreshFollowPresentation();
    if (this.pendingAfterReady) {
      const pending = this.pendingAfterReady;
      this.pendingAfterReady = null;
      this.openPendingEditor(pending);
    }
    if (restartAfterAccountChange && this.visible) this.startPolling();
    this.alertAccountUnconfirmed = false;
  },

  async loadFollows(options = {}) {
    if (this.pageRetired || this.visible === false) return false;
    if (this.followsPromise) return this.followsPromise;
    const generation = this.followReadGeneration || 0;
    const pending = getFollows({ force: Boolean(options.force) }).then(async data => {
      if (options.beforePresent) await options.beforePresent;
      if (this.pageRetired || this.visible === false || generation !== (this.followReadGeneration || 0)) return false;
      const incoming = data.follows.filter(f => f.status !== 'removed').map(f => presentFollow(f, this.data.boot || {}, this.catalog, this.data.collector));
      this.setData({ follows: retainFollowOrder(incoming, this.data.follows), followsLoaded: true, limits: data.limits, loadError: null, refreshError: null, followActionError: '', followActionId: '', refreshedText: fmt.fmtTime(Date.now()) });
      this.lastLocalPresentationAt = Date.now();
      this.startObservationClock();
      this.refreshReadiness();
      this.consumePendingFocus();
      return true;
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
    if (this.pageRetired) return;
    if (this.data.follows.length) this.setData({ follows: this.data.follows.map(f => presentFollow(f, this.data.boot || {}, this.catalog, this.data.collector)) });
    this.refreshReadiness();
  },

  refreshReadiness() {
    if (this.pageRetired) return;
    const boot = this.data.boot || {};
    const consent = typeof buildConsentReport === 'function' ? buildConsentReport({
      restockId: boot.templateIds && boot.templateIds[0],
      soldoutId: boot.soldoutId,
      restockTitle: boot.templateTitle || '商品到货提醒',
      soldoutTitle: '库存不足提醒',
    }) : { anyBlocked: false, restockBlocked: false, blocked: [] };
    if (JSON.stringify(this.data.consent || null) !== JSON.stringify(consent)) this.setData({ consent });
    // The status column describes the sender; overall reminder readiness must
    // still honour the server's full delivery gate, including stock health.
    const delivery = this.data.delivery.overallReady === false ? { ...this.data.delivery, cls: 'warn' } : this.data.delivery;
    const readiness = reminderReadiness({ ...this.data, delivery, settings: this.settings, consent });
    // Other credit states already include this guidance in the notice. Service
    // failures and pending records need recovery, not more authorizations.
    const tip = readiness.code === 'ready' ? creditBoostTip(this.data.subscription || {}) : '';
    const monitored = this.data.follows.filter(follow => canRemind(boot) && follow.status === 'active' && !follow.latestRestricted)
      .flatMap(follow => follow.stores || []).filter(store => !store.limitPaused);
    const delayed = monitored.filter(store => ['stale', 'unknown'].includes(store.observationState)).length;
    const awaiting = monitored.filter(store => store.observationState === 'missing').length;
    const stockOverview = delayed ? { label: '库存更新有延迟', tone: 'warn', detail: `${delayed} 项门店结果待更新，已保留上次结果。` }
      : awaiting ? { label: '等待首次检查', tone: 'muted', detail: '关注已保存，无需重复添加。' } : null;
    const recent = this.data.follows.filter(follow => !follow.latestRestricted && !follow.productRetired && !follow.limitPaused)
      .flatMap(follow => (follow.stores || []).filter(store => !store.limitPaused && store.observationState === 'fresh'
        && ['available', 'unavailable'].includes(store.status) && Number.isFinite(Date.parse(store.statusSince))
        && Date.parse(store.statusSince) <= Date.parse(store.observedAt)).map(store => ({ follow, store })))
      .sort((a, b) => Date.parse(b.store.statusSince) - Date.parse(a.store.statusSince))[0];
    const recentStock = recent ? { title: recent.follow.productTitle,
      detail: `${storeLabel(recent.store.storeNumber, recent.store.storeName)} · ${fmt.fmtDateTime(recent.store.statusSince)} 起记录为${recent.store.status === 'available' ? '可取货' : '不可取货'}` } : null;
    this.setData({ readiness, stockOverview, recentStock, readinessTaskDetail: readinessTaskDetail(readiness), creditBoostTip: tip,
      primaryTopUp: !(readiness.ready && Number(this.data.subscription.credits) > 3) });
    this.refreshActivation();
  },

  checkoutStore() {
    if (!this.checkoutContext) this.checkoutContext = createCheckoutContext({ wx });
    return this.checkoutContext;
  },

  refreshActivation() {
    if (this.pageRetired) return;
    const account = this.accountSnapshot;
    if (!this.features || !this.features.activationJourney || !account || !account.membership.active) {
      if (this.data.activation) this.setData({ activation: null });
      return;
    }
    const restored = this.checkoutStore().restore(account.identity, this.catalog);
    this.activationContext = restored.status === 'ready' ? restored.context : null;
    const activation = activationStatus({ member: true, context: this.activationContext, contextStatus: restored.status,
      follows: this.data.follows, followsLoaded: this.data.followsLoaded, readiness: this.data.readiness });
    // Completed setup yields to the task list; keep unfinished target recovery visible.
    this.setData({ activation: activation && activation.action !== 'tasks' ? activation : null });
    if (this.visible && this.data.activation && this.activationEventKey !== this.data.activation.title) {
      this.activationEventKey = this.data.activation.title;
      conversion.track('activation_viewed', { entryPoint: 'follow', resultState: this.data.readiness.code });
    }
  },

  onActivationAction() {
    if (this.pageRetired || this.data.saving || this.data.editing) return;
    this.refreshActivation();
    const action = this.data.activation && this.data.activation.action;
    if (action === 'continue' && this.activationContext) {
      const context = this.activationContext;
      return this.openPendingEditor({ partNumber: context.partNumber, storeNumbers: context.storeNumbers.slice(),
        checkoutRevision: context.revision, checkoutSignature: context.targetSignature });
    }
    if (action === 'choose' || action === 'continue') return this.onAdd();
    if (action === 'conditions' && this.data.readiness.action) return this.onReadinessAction();
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#follow-configurations', duration: 220 });
  },

  onReadinessAction() {
    const action = this.data.readiness.action;
    if (action === 'add') return this.onAdd();
    if (action === 'membership') return this.onGoMine();
    if (action === 'settings') {
      if (navigation.isNavigating()) return;
      getApp().globalData.pendingMineSection = 'reminder-settings';
      return this.onGoMine();
    }
    if (action === 'follows') return wx.pageScrollTo({ selector: '#follow-configurations', duration: 240 });
    if (action === 'subscribe') return this.onSubscribe();
    if (action === 'open_settings') return this.onOpenSubscribeSetting();
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
    if (this.pageRetired || this.data.refreshing) return;
    const epoch = this.statusRefreshEpoch = (this.statusRefreshEpoch || 0) + 1;
    const current = () => !this.pageRetired && epoch === this.statusRefreshEpoch;
    this.setData({ refreshing: true, refreshFeedback: '正在读取后台检测与提醒状态…', refreshError: null });
    try {
      const [result] = await Promise.all([this.refreshLiveStatus(), this.loadDeadlines()]);
      if (!current()) return;
      this.setData({ refreshFeedback: result.ok
        ? '状态已刷新，库存时间见各配置；查最新库存请使用卡片按钮。'
        : result.offline ? '网络已断开，联网后自动更新；上次记录已保留。' : '' });
    } finally { if (current()) this.setData({ refreshing: false }); }
  },

  onToggleServiceDetails() {
    if (this.pageRetired) return;
    const showServiceDetails = !this.data.showServiceDetails;
    const epoch = this.serviceDetailsFocusEpoch = (this.serviceDetailsFocusEpoch || 0) + 1;
    this.setData({ showServiceDetails });
    if (!showServiceDetails || typeof wx.nextTick !== 'function' || typeof wx.pageScrollTo !== 'function') return;
    const canFocus = () => !this.pageRetired && this.visible && this.data.showServiceDetails && this.serviceDetailsFocusEpoch === epoch;
    if (!canFocus()) return;
    try {
      wx.nextTick(() => {
        if (!canFocus()) return;
        try { wx.pageScrollTo({ selector: '#reminder-service-details', duration: 220, fail() {} }); } catch (e) { /* scrolling is optional; keep the details open */ }
      });
    } catch (e) { /* older runtimes retain the current scroll position */ }
  },

  onServiceDetails() {
    const { collector, delivery } = this.data;
    wx.showModal({ title: '检测与消息服务', content: `${collector.label}\n${collector.detail}${collector.updatedText ? '\n最近状态：' + collector.updatedText : ''}${collector.batchText ? '\n最近检测：' + collector.batchText : ''}\n\n${delivery.label}\n${delivery.detail}\n\n页面可见且联网时，通常每 30 秒读取一次已有记录；读取失败时会逐步延后重试。后台采集速度与页面刷新不同，请查看各门店的实际观测时间。`, showCancel: false });
  },

  openEditor({ followId, pickerValue, isNew }) {
    if (this.pageRetired) return;
    if (!canRemind(this.data.boot)) {
      this.showMemberModal();
      return;
    }
    this.editorEpoch = (this.editorEpoch || 0) + 1;
    this.editorSelection = null;
    this.editorBaseline = pickerValue ? selectionKey(pickerValue) : null;
    const value = pickerValue ? { partNumber: pickerValue.partNumber, storeNumbers: (pickerValue.storeNumbers || []).slice() } : null;
    this.setData({ editing: true, editor: { followId, pickerValue: value, isNew }, editorCanSave: false, editorDirty: false, editorSummary: '', saveError: '' });
  },

  showMemberModal() {
    const product = this.data.boot.memberProduct || {};
    wx.showModal({
      title: '关注与到货提醒为会员专属',
      content: `周卡 3 个配置、每配置 3 家门店；月卡 4 个配置、每配置 4 家门店；年卡 5 个配置、每配置 5 家门店。会员可累加到货和断货提醒次数。免费用户可用查询次数实时看货。${product.paymentReady ? '' : '\n\n会员购买暂未开放，可在「我的」查看状态。'}`,
      confirmText: '前往我的',
      success: r => { if (r.confirm) switchToTab({ url: '/pages/mine/index' }); },
    });
  },

  onAdd() {
    if (this.data.saving || this.data.followBusyId) return;
    if (!this.data.boot) return toast('正在读取账户，请稍后再试');
    if (!this.data.boot.member) return this.showMemberModal();
    if (!this.data.followsLoaded) return toast('正在确认已有关注，请稍后再试');
    if (this.data.follows.length >= this.data.limits.maxFollows) return wx.showModal({
      title: '配置名额已满', content: `已保存 ${this.data.follows.length} 个配置，当前最多 ${this.data.limits.maxFollows} 个。暂停的配置也占名额，可调整或删除已有关注。`,
      confirmText: '管理关注', cancelText: '取消',
      success: result => { if (result.confirm && !this.pageRetired) this.setData({ follows: this.data.follows.map(follow => ({ ...follow, detailsExpanded: true })) }); },
    });
    this.openEditor({ followId: newId('f'), pickerValue: null, isNew: true });
  },

  onEdit(e) {
    if (this.data.saving || this.data.followBusyId) return;
    const follow = this.data.follows.find(f => f.followId === e.currentTarget.dataset.id);
    if (!follow) return;
    this.openEditor({ followId: follow.followId, pickerValue: { partNumber: follow.partNumber, storeNumbers: follow.stores.map(s => s.storeNumber) }, isNew: false });
  },

  onCancelEdit() {
    if (this.data.saving || this.pageRetired) return;
    this.editorEpoch = (this.editorEpoch || 0) + 1;
    this.editorSelection = null;
    this.editorBaseline = null;
    this.setData({ editing: false, editorCanSave: false, editorDirty: false, editorSummary: '', saveError: '' });
  },

  onRequestCloseEditor() {
    if (this.pageRetired || this.data.saving || !this.data.editing) return;
    const sheet = typeof this.selectComponent === 'function' && this.selectComponent('#follow-config-sheet');
    const picker = typeof this.selectComponent === 'function' && this.selectComponent('#follow-target-picker');
    const current = picker && typeof picker.getSelection === 'function' ? picker.getSelection() : this.editorSelection;
    const dirty = this.editorBaseline === null ? Boolean(current && current.storeNumbers && current.storeNumbers.length) : selectionKey(current) !== this.editorBaseline;
    if (sheet && typeof sheet.requestClose === 'function') return sheet.requestClose(dirty);
    if (!dirty) return this.onCancelEdit();
    const epoch = this.editorEpoch;
    wx.showModal({ title: '放弃这次修改？', content: '已保存的关注不会改变。', confirmText: '放弃修改', cancelText: '继续编辑', success: result => { if (result.confirm && epoch === this.editorEpoch) this.onCancelEdit(); } });
  },

  onEditorChange(e) {
    if (this.pageRetired || !this.data.editing || this.data.saving) return;
    // The selection is logic state; only its validity needs the render bridge.
    const selection = this.editorSelection = e.detail;
    // New pickers choose a default product, but never choose stores themselves.
    // A coalesced first event may already contain the user's first store tap.
    if (this.editorBaseline === null) this.editorBaseline = selectionKey({ ...selection, storeNumbers: [] });
    const title = selection && selection.product && selection.product.title || '请选择具体配置';
    const count = selection && Array.isArray(selection.storeNumbers) ? selection.storeNumbers.length : 0;
    this.setData({ editorCanSave: Boolean(selection && selection.partNumber && selection.product && selection.product.supported && count && count <= this.data.limits.maxStoresPerFollow), editorDirty: selectionKey(selection) !== this.editorBaseline, editorSummary: `${title} · ${count} 家门店`, saveError: '' });
  },

  async onSave() {
    const accountEpoch = this.accountEpoch || 0;
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
    if (selection.storeNumbers.length > this.data.limits.maxStoresPerFollow) return toast(`当前套餐每个配置最多 ${this.data.limits.maxStoresPerFollow} 家门店，请手动移除超出的门店后保存`);
    const payload = { followId: editor.followId, partNumber: selection.partNumber, storeNumbers: selection.storeNumbers.slice() };
    const savedIdentity = this.accountSnapshot && this.accountSnapshot.identity;
    const intentAtSave = savedIdentity ? this.checkoutStore().restore(savedIdentity, this.catalog) : null;
    const toppedUp = topUpReminderCredit();
    if (picker && typeof picker.setInteractionLocked === 'function') picker.setInteractionLocked(true);
    this.setData({ saving: true, saveError: '' });
    try {
      const result = await call('follow.upsert', payload);
      if (!confirmsSavedFollow(result && result.follow, payload)) throw Object.assign(new Error('保存结果尚未确认，请重试。'), { code: 'bad_response' });
      if (intentAtSave && intentAtSave.status === 'ready' && intentAtSave.context.targetSignature === targetSignature(payload)) {
        this.checkoutStore().clear(savedIdentity, intentAtSave.context.revision);
        const legacy = getApp().globalData.pendingMemberFollow;
        if (legacy && legacy.userKey === savedIdentity.userKey && targetSignature(legacy) === targetSignature(payload)) getApp().globalData.pendingMemberFollow = null;
      }
      if (accountEpoch !== (this.accountEpoch || 0)) return;
      this.invalidateFollowRead();
      invalidateBootstrap();
      if (this.pageRetired) return;
      const follow = presentFollow(result.follow, this.data.boot || {}, this.catalog, this.data.collector);
      const follows = this.data.follows.slice();
      const savedIndex = follows.findIndex(item => item.followId === follow.followId || item.followId === payload.followId);
      if (savedIndex >= 0) follows[savedIndex] = { ...follow, detailsExpanded: follows[savedIndex].detailsExpanded === true };
      else follows.push(follow);
      const sameEditor = epoch === this.editorEpoch;
      if (sameEditor) { this.editorSelection = null; this.editorBaseline = null; }
      this.setData({ follows, ...(sameEditor ? { editing: false, editorCanSave: false, editorDirty: false } : {}) });
      this.refreshReadiness();
      if (sameEditor && this.visible !== false) {
        confirmTap();
        toast(editor.isNew ? '已加入关注' : '已更新', 'success');
        if (editor.isNew && !toppedUp && !this.data.subscription.credits) this.promptSubscribe();
      }
      if (this.visible !== false) {
        refreshBootstrap().catch(() => {});
        // A failed read cannot undo the server's confirmed save or report it as
        // a failed write. Keep the acknowledged row until a later refresh.
        try { await this.loadFollows(); }
        catch (error) { if (!this.pageRetired) this.setData({ refreshError: '关注已保存，列表状态刷新失败，请下拉刷新。' }); }
      }
    } catch (error) {
      if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0) && epoch === this.editorEpoch) {
        this.setData({ saveError: error.message || '保存未完成，请重试。' });
        if (this.visible !== false) showError(error);
      }
    } finally {
      if (picker && typeof picker.setInteractionLocked === 'function') picker.setInteractionLocked(false);
      if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) this.setData({ saving: false });
    }
  },

  promptSubscribe() {
    if (!this.data.boot.templateIds.length || this.data.delivery.cls !== 'ok' || this.data.delivery.overallReady === false) return;
    // showModal's confirm is not a user gesture for wx.requestSubscribeMessage
    // on Android — the dialog stays silent. Point at the real tap button instead.
    wx.showModal({
      title: this.data.subscription.soldoutEnabled ? '开启到货和断货提醒' : '开启补货提醒',
      content: `${this.data.subscription.soldoutEnabled ? '一个按钮同时申请到货和断货提醒；两项都选择「允许」，各增加 1 次。也可以只允许其中一项。' : '每点一次「允许」增加 1 次到货提醒，可以连续授权多次累加。'}建议连续授权累加到 10 次以上。点下方「补充提醒次数」按钮后，微信会弹出授权。`,
      confirmText: '知道了',
      showCancel: false,
    });
  },

  async onToggle(e) {
    if (this.toggling || this.pageRetired || this.data.saving || this.data.followBusyId) return;
    if (!canRemind(this.data.boot)) { this.showMemberModal(); return; }
    const { id, status } = e.currentTarget.dataset;
    const existing = this.data.follows.find(follow => follow.followId === id);
    if (!existing) return;
    if (existing.productRetired || existing.statusReason === 'product_retired') return toast('老款已下架，请改选新款');
    if (existing.limitPaused || existing.status === 'limit_paused') return this.showMemberModal();
    this.toggling = true;
    const nextStatus = (existing.status || status) === 'active' ? 'paused' : 'active';
    this.setData({ followBusyId: id, followActionId: '', followActionError: '' });
    try {
      const result = await call(nextStatus === 'paused' ? 'follow.pause' : 'follow.resume', { followId: id });
      this.invalidateFollowRead();
      if (this.pageRetired) return;
      const acknowledged = result && result.follow && result.follow.followId === id && result.follow.status === nextStatus;
      if (acknowledged) {
        this.setData({ follows: this.data.follows.map(follow => follow.followId === id ? presentFollow({ ...result.follow, detailsExpanded: follow.detailsExpanded }, this.data.boot, this.catalog, this.data.collector) : follow) });
        this.refreshReadiness();
      }
      if (this.visible === false) return;
      try { await this.loadFollows(); }
      catch (error) {
        if (!this.pageRetired) this.setData({ refreshError: acknowledged ? `${nextStatus === 'paused' ? '已暂停' : '已恢复'}关注，最新观测读取失败，请刷新确认。` : '操作已提交，当前状态待确认，请刷新查看。' });
      }
    } catch (error) {
      this.invalidateFollowRead();
      if (!this.pageRetired) {
        this.setData({ followActionId: id, followActionError: followActionError(error, '操作') });
        if (this.visible !== false) showError(error);
      }
    } finally { this.toggling = false; if (!this.pageRetired) this.setData({ followBusyId: '' }); }
  },

  onRemove(e) {
    if (this.pageRetired || this.data.saving || this.data.followBusyId || this.removing) return;
    const id = e.currentTarget.dataset.id;
    if (!this.data.follows.some(follow => follow.followId === id)) return;
    this.removing = true;
    wx.showModal({
      title: '删除关注',
      content: '删除后停止这条关注并释放名额，已产生的历史记录会保留。',
      confirmColor: '#D64545',
      success: async r => {
        if (!r.confirm || this.pageRetired) { this.removing = false; return; }
        this.setData({ followBusyId: id, followActionId: '', followActionError: '' });
        try {
          const result = await call('follow.remove', { followId: id });
          this.invalidateFollowRead();
          if (this.pageRetired) return;
          const acknowledged = result && result.removed === true && result.followId === id;
          if (acknowledged) {
            this.setData({ follows: this.data.follows.filter(follow => follow.followId !== id) });
            this.refreshReadiness();
          }
          refreshBootstrap().catch(() => {});
          if (this.visible === false) return;
          try { await this.loadFollows(); }
          catch (error) { if (!this.pageRetired) this.setData({ refreshError: acknowledged ? '关注已删除，列表刷新失败，请下拉刷新。' : '删除操作已提交，结果待确认，请刷新查看。' }); }
        } catch (error) {
          this.invalidateFollowRead();
          if (!this.pageRetired) {
            this.setData({ followActionId: id, followActionError: followActionError(error, '删除') });
            if (this.visible !== false) showError(error);
          }
        } finally {
          this.removing = false;
          if (!this.pageRetired) this.setData({ followBusyId: '' });
        }
      },
      fail: () => { this.removing = false; },
    });
  },

  onToggleFollowDetails(e) {
    const index = this.data.follows.findIndex(follow => follow.followId === e.currentTarget.dataset.id);
    if (index >= 0) this.setData({ [`follows[${index}].detailsExpanded`]: !this.data.follows[index].detailsExpanded });
  },

  onQueryFollow(e) {
    if (this.pageRetired || this.data.editing || this.data.saving) return;
    const follow = this.data.follows.find(item => item.followId === e.currentTarget.dataset.id);
    if (!follow || !follow.stores.length) return;
    if (follow.productRetired || follow.statusReason === 'product_retired') return toast('老款已下架，请改选新款');
    const app = getApp();
    const target = { partNumber: follow.partNumber, storeNumbers: follow.stores.filter(store => !store.limitPaused).map(store => store.storeNumber), source: 'follow' };
    if (!target.storeNumbers.length) return this.showMemberModal();
    const previousTarget = app.globalData.pendingSharedTarget;
    app.globalData.pendingSharedTarget = target;
    const started = switchToTab({ url: '/pages/query/index', fail: () => {
      if (app.globalData.pendingSharedTarget === target) app.globalData.pendingSharedTarget = null;
      toast('未能打开查询，请重试');
    } });
    if (!started && app.globalData.pendingSharedTarget === target) app.globalData.pendingSharedTarget = previousTarget;
  },

  onPickupInfo(e) {
    if (this.pageRetired) return;
    const follow = this.data.follows.find(item => item.followId === e.currentTarget.dataset.id);
    if (!follow) return;
    const current = presentFollow(follow, this.data.boot || {}, this.catalog, this.data.collector);
    if (follow.status === 'limit_paused') return toast('当前套餐名额不足，配置已保留；可升级月卡或年卡恢复');
    const stores = current.stores.filter(store => !store.limitPaused && store.observationState === 'fresh' && store.status === 'available');
    this.refreshFollowPresentation();
    if (!stores.length) return toast('这条记录已过期，当前取货情况待确认');
    wx.showModal({ title: '最近观测可取货', content: `${follow.productTitle}\n${stores.map(store => `${store.storeLabel}\n观测 ${store.observedText}${typeof store.quote === 'string' && store.quote ? '\n' + store.quote : ''}`).join('\n\n')}\n\n库存可能变化，请在 Apple Store App 或官网确认。`, confirmText: '复制配置', cancelText: '返回', success: result => {
      if (result.confirm && !this.pageRetired) wx.setClipboardData({ data: `${follow.productTitle}\n型号：${follow.partNumber}\n门店：${stores.map(store => store.storeLabel).join('、')}`, success: () => toast('已复制型号和门店'), fail: () => toast('复制失败，请重试') });
    } });
  },

  onViewHistory(e) {
    if (navigation.isNavigating()) return;
    const follow = this.data.follows.find(item => item.followId === e.currentTarget.dataset.id);
    if (this.pageRetired || !follow) return;
    if (!stageHistoryContext({ from: 'follow', target: { partNumber: follow.partNumber, storeNumbers: follow.stores.map(store => store.storeNumber) } })) return toast('请刷新账户后再查看历史');
    switchToTab({ url: '/pages/history/index' });
  },
  onManageReminders() {
    if (navigation.isNavigating()) return;
    getApp().globalData.pendingMineSection = 'reminder-center';
    this.onGoMine();
  },
  onTestNotification() { navigation.navigateTo({ url: '/pages/notification-test/index?from=follow' }); },
  onGoMine() {
    switchToTab({ url: '/pages/mine/index' });
  },

  onGoReminderSettings() {
    if (navigation.isNavigating()) return;
    getApp().globalData.pendingMineSection = 'reminder-settings';
    this.onGoMine();
  },

  onFollowImageError(e) { const index = Number(e.currentTarget.dataset.index); if (this.data.follows && this.data.follows[index]) this.setData({ [`follows[${index}].imageDisplayUrl`]: '' }); },

  onRetryLoad() {
    if (this.pageRetired) return;
    this.setData({ loadError: null });
    return this.onLoad();
  },

  retireDeadlineRead() {
    this.deadlineReadEpoch = (this.deadlineReadEpoch || 0) + 1;
    this.deadlineReadPromise = null;
    if (this.data.deadlinesLoading) this.setData({ deadlinesLoading: false });
  },

  loadDeadlines() {
    if (this.pageRetired || this.visible === false) return Promise.resolve(false);
    if (this.deadlineReadPromise) return this.deadlineReadPromise;
    const epoch = this.deadlineReadEpoch || 0;
    const identity = () => {
      const boot = getApp().globalData.bootstrap || this.accountSnapshot;
      return boot && boot.identity && boot.identity.userKey || '';
    };
    const userKey = identity();
    const current = () => !this.pageRetired && this.visible !== false && epoch === (this.deadlineReadEpoch || 0)
      && (!userKey || !identity() || userKey === identity());
    if (this.deadlineUserKey && userKey && this.deadlineUserKey !== userKey) {
      this.setData({ deadlines: [], deadlineCount: 0, deadlinesLoaded: false, nextDeadline: null,
        deadlineCanOpen: false, deadlineRecordOnly: false });
    }
    this.setData({ deadlinesLoading: true, deadlinesError: '', deadlineCanOpen: false, deadlineServiceLabel: '读取中' });
    const pending = call('deadline.list').then(result => {
      if (!current()) return false;
      if (!result || !Array.isArray(result.items) || !result.userKey) throw Error('到期提醒暂未读取成功，请重试。');
      if (identity() && result.userKey !== identity()) {
        this.deadlineUserKey = null;
        this.setData({ deadlines: [], deadlineCount: 0, deadlinesLoaded: false, nextDeadline: null,
          deadlinesError: '账户已变化，请刷新状态后重新读取到期事项。', deadlineServiceLabel: '暂不可用' });
        return false;
      }
      this.deadlineUserKey = result.userKey;
      const items = result.items.map(item => presentDeadline(item));
      const notificationsEnabled = Boolean(result.capability && result.capability.enabled);
      const planned = items.filter(item => notificationsEnabled && item.delivery && item.delivery.status === 'scheduled' && Date.parse(item.remindAt) > Date.now())
        .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt));
      const upcoming = items.filter(item => !['accepted', 'missed'].includes(item.delivery && item.delivery.status))
        .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt));
      this.setData({ deadlines: (upcoming.length ? upcoming : items).slice(0, 3), deadlineCount: items.length,
        deadlinesLoaded: true, deadlinesError: '', nextDeadline: planned[0] || null,
        deadlineCanOpen: true, deadlineRecordOnly: !notificationsEnabled,
        deadlineServiceLabel: notificationsEnabled ? '免费试用' : '仅保存事项' });
      return true;
    }).catch(error => {
      if (current()) this.setData({ deadlinesError: deadlineError(error), deadlineCanOpen: false, deadlineServiceLabel: '暂不可用', nextDeadline: null });
      return false;
    }).finally(() => {
      if (this.deadlineReadPromise === pending) {
        this.deadlineReadPromise = null;
        if (!this.pageRetired && this.visible !== false) this.setData({ deadlinesLoading: false });
      }
    });
    this.deadlineReadPromise = pending;
    return pending;
  },

  onOpenDeadlines() {
    if (!this.data.deadlineCanOpen || this.data.deadlinesLoading || this.data.deadlinesError) return;
    navigation.navigateTo({ url: '/pages/deadlines/index' });
  },
  onRetryDeadlines() { return this.loadDeadlines(); },
  onOpenInventory() { switchToTab({ url: '/pages/query/index' }); },
});
