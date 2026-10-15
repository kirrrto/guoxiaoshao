const { reminderPanelMethods } = require('../../utils/reminder-panel');
const { restockSubscription, soldoutSubscription, activeDnd } = require('../../utils/reminder-readiness');
const { getAuthorizationState } = require('../../utils/reminder-credits');
const { dndPeriods, dndSummary, dndStatus, MAX_DND_PERIODS, validateDndPeriods } = require('../../utils/dnd');
const { peekTestReturn, consumeTestReturnUrl } = require('../../utils/journey-context');
const { call, showError, toast, newId } = require('../../utils/api');
const { getBootstrap, getCatalog, currentCatalog, invalidateBootstrap, invalidateFollows, publishSettings, publishQuota, subscribeQuota, currentQuota } = require('../../utils/store');
const { topUpReminderCredit } = require('../../utils/reminder-credits');
const { confirmTap } = require('../../utils/haptic');
const { VERSION } = require('../../config/version');
const { RELEASE_NOTES } = require('../../config/release-notes');
const { storeLabel } = require('../../utils/store-label');

/** Show the shared release version plus its non-production build channel. */
function versionLabel() {
  let env = 'release';
  try { env = wx.getAccountInfoSync().miniProgram.envVersion || 'release'; } catch (e) { /* older clients */ }
  return `v${VERSION}${{ develop: ' · 开发版', trial: ' · 体验版' }[env] || ''}`;
}
const fmt = require('../../utils/format');
const { syncTabBar } = require('../../utils/tab-bar');
const { notificationAdvice } = require('../../utils/reminder-readiness');
const { shareAppMessage, shareTimeline } = require('../../utils/share');
const { paymentAvailability, createPaymentController, purchaseNotice, planPurchasable, purchaseGate } = require('../../utils/member-payment');
const { memberProducts, planId, upgradeProducts, renewalPreview, choosePurchasablePlan } = require('../../utils/member-products');
const { productBenefit } = require('../../utils/member-limits');
const { createCheckoutContext, TTL_MS: CHECKOUT_TTL_MS } = require('../../utils/checkout-context');
const conversion = require('../../utils/conversion-events');
const CHECKOUT_MESSAGES = { expired: '上次选择已超过 24 小时，请重新确认配置与门店。', catalog_changed: '商品或门店信息已更新，请重新确认你的选择。',
  invalid: '上次选择暂时无法恢复，请重新选择配置与门店。', storage_failed: '暂时无法读取上次选择，请重新选择配置与门店。' };
const PURCHASE_FEEDBACK = [
  { code: 'feedback_no_need', label: '暂时不需要' }, { code: 'feedback_bought', label: '已经买到了' },
  { code: 'feedback_price_duration', label: '价格或时长不合适' }, { code: 'feedback_unclear', label: '还没看懂提醒功能' },
  { code: 'feedback_trust', label: '担心提醒效果' }, { code: 'feedback_payment', label: '付款遇到了问题' }, { code: 'feedback_other', label: '其他原因' },
];
const RELEASE_NOTES_PAGE_SIZE = 3;
const RELEASE_NOTES_PAGE_COUNT = Math.max(1, Math.ceil(RELEASE_NOTES.length / RELEASE_NOTES_PAGE_SIZE));

function releaseNotesPage(page = 1) {
  const bounded = Math.min(RELEASE_NOTES_PAGE_COUNT, Math.max(1, page));
  return { releaseNotesPage: bounded, visibleReleaseNotes: RELEASE_NOTES.slice((bounded - 1) * RELEASE_NOTES_PAGE_SIZE, bounded * RELEASE_NOTES_PAGE_SIZE) };
}

/** Group only equal server-advertised allowances, without inferring a user's plan. */
function membershipBenefitPlans(products) {
  const groups = [];
  const bounded = value => Number.isInteger(value) && value >= 1 && value <= 4 ? value : 3;
  for (const product of products) {
    const limits = product.limits || {}, configs = bounded(limits.maxFollows), stores = bounded(limits.maxStoresPerFollow);
    const key = `${configs}:${stores}`, existing = groups.find(group => group.key === key);
    if (existing) {
      if (!existing.names.includes(product.nameText)) existing.names.push(product.nameText);
    } else groups.push({ key, names: [product.nameText], configs, stores, enhanced: configs > 3 || stores > 3 });
  }
  return groups.map(({ names, ...group }) => ({ ...group, label: names.join(' / ') }));
}

function presentMemberProduct(item) {
  const promotion = item.promotion || {};
  const discounted = promotion.active === true && Number.isSafeInteger(item.standardPriceFen)
    && item.standardPriceFen > item.priceFen;
  return { ...item, priceText: fmt.fen(item.priceFen), standardPriceText: discounted ? fmt.fen(item.standardPriceFen) : '',
    promotionText: discounted ? '优惠价' : '',
    dailyPriceText: `约 ¥${(item.priceFen / item.days / 100).toFixed(2)} / 天`,
    benefitText: productBenefit(item),
    benefitShort: `${item.limits && item.limits.maxFollows || 3} 配置 × ${item.limits && item.limits.maxStoresPerFollow || 3} 门店`,
    nameText: item.days === 365 ? '年卡' : item.days === 30 ? '月卡' : item.days === 7 ? '周卡' : '会员',
    durationText: `${item.days} 天`,
    taskLabel: item.planId === 'member_7d' ? '短期等货' : item.planId === 'member_30d' ? '持续关注' : '长期使用',
    available: paymentAvailability(item, wx).ready };
}

const LEDGER_TEXT = {
  signin_reward: '每日签到',
  task_reward: '体验任务',
  query_debit: '实时查询',
  query_refund: '查询次数返还',
  history_debit: '查看历史',
  notification_test_debit: '测试通知',
  notification_test_refund: '测试通知次数返还',
  admin_grant: '平台发放',
};

const NOTIFY_STATUS = {
  accepted: { label: '平台已受理', cls: 'ok' },
  failed: { label: '发送失败', cls: 'bad' },
  uncertain: { label: '结果未知', cls: 'warn' },
  skipped: { label: '未发送', cls: 'muted' },
  pending: { label: '待发送', cls: 'warn' },
  sending: { label: '发送处理中', cls: 'warn' },
};
const SKIP_REASON = {
  cooldown: '提醒冷却期间',
  no_subscription_credit: '未授权订阅消息',
  subscription_authorization_expired: '微信授权已失效，请重新授权提醒',
  dnd: '免打扰时段',
  notifications_disabled: '平台暂停推送',
  template_missing: '提醒服务暂未就绪',
  template_changed: '提醒配置已更新，本次未发送',
  user_disabled: '已关闭提醒',
  member_expired: '会员已到期',
  free_reminder_used: '免费体验提醒已用完',
  free_reminder_in_use: '免费提醒已用于另一条补货',
  follow_not_active: '关注已暂停',
  plan_limit: '超出当前会员套餐名额，关注已保留',
  user_missing: '账号信息暂时无法确认',
  consumer_appid_mismatch: '当前账号暂时无法接收提醒',
  openid_missing: '账号信息暂时无法确认',
  event_expired: '补货信息已过时，本次未发送',
  event_superseded: '库存状态已变化，本次旧提醒未发送',
  event_unconfirmed: '库存状态尚未重新确认，本次未发送',
  event_invalid_time: '提醒时间异常，本次未发送',
  lease_lost: '提醒服务暂时中断，本次未发送',
  missing_task_or_user: '提醒或账号信息暂时无法确认',
  credit_released: '本次提醒已取消，授权次数已恢复',
  invalid_platform_response: '发送结果暂时无法确认',
  send_transport_error: '网络异常，发送结果待确认',
  worker_expired_after_claim: '处理曾中断，发送结果待确认',
  wechat_message_transport_uncertain: '网络异常，发送结果待确认',
  wechat_message_http_error: '提醒服务暂时异常，发送结果待确认',
  consumer_credentials_missing: '提醒服务暂未就绪',
  sender_missing: '提醒服务暂未就绪',
};
const hasKey = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function notificationReasonText(reason, status) {
  if (!reason) return '';
  if (hasKey(SKIP_REASON, reason)) return SKIP_REASON[reason];
  if (typeof reason === 'string' && /^wx_-?\d+(?::|$)/.test(reason)) return '微信未受理本次提醒';
  if (typeof reason === 'string' && /^wechat_token_/.test(reason)) return '提醒服务暂时不可用，本次未发送';
  if (status === 'failed') return '本次提醒未发送成功';
  if (status === 'skipped') return '本次提醒未发送，原因暂未确认';
  if (status === 'pending' || status === 'sending') return '提醒正在处理中';
  return '发送结果暂时无法确认';
}

const ORDER_STATUS = { created: '待支付', paid: '开通确认中', fulfilled: '已开通', partially_refunded: '部分退款', refunded: '已退款', cancelled: '已取消', failed: '支付失败' };
const SECONDARY_CACHE_MS = 30000;
const presentTasks = (tasks, quota) => (tasks || []).map(task => ({ ...task,
  done: quota.tasksDoneToday.includes(task.id),
  pendingLabel: (quota.tasksViewedToday || []).includes(task.id)
    ? quota.grantedToday >= quota.dailyGrantCap ? '已浏览·今日上限' : task.reward === 0 ? '已浏览·奖励未开放' : '已浏览·待领取' : '',
}));
const presentMembership = membership => ({ ...membership, expired: !membership.active && Boolean(membership.expiresAt),
  daysLeft: membership.active ? Math.ceil(membership.remainingMs / 86400000) : 0,
  enhancedExpiresText: membership.enhancedExpiresAt ? fmt.fmtDateTime(membership.enhancedExpiresAt) : '',
  expiresShortText: membership.expiresAt ? fmt.fmtDateTime(membership.expiresAt).slice(0, 16) : '',
  expiresText: membership.expiresAt ? fmt.fmtDateTime(membership.expiresAt) : null });
function redemptionErrorText(error) {
  const code = error && error.code, details = error && error.details || {};
  if (code === 'invalid_redemption_code') return `兑换码无效，请核对后重试。${Number.isInteger(details.remainingAttempts) && details.remainingAttempts > 0 ? `还可尝试 ${details.remainingAttempts} 次。` : ''}`;
  if (code === 'redemption_rate_limited') {
    const wait = Number(details.retryAfterSeconds);
    return wait > 0 ? `尝试次数较多，请约 ${Math.ceil(wait / 60)} 分钟后再试。` : '尝试次数较多，请稍后再试。';
  }
  if (code === 'redemption_disabled') return '兑换码开通暂未开放，请稍后再试。';
  if (code === 'redemption_sold_out') return '本期兑换名额已发完，可选择购买会员。';
  if (code === 'redemption_conflict') return '兑换记录状态异常，请通过意见反馈联系支持。';
  if (code === 'user_required') return '账号尚未连接，请刷新账户后再试。';
  if (code === 'app_not_allowed' || code === 'unknown_action') return '兑换服务暂不可用，请稍后再试。';
  return '兑换结果暂未确认，请重试。同一账号重复提交不会重复增加会员时间。';
}
function presentOrder(order) {
  const redeemed = order.source === 'redemption_code' || order.type === 'membership_redemption';
  const sourceLabel = redeemed ? '兑换码开通' : ['admin', 'admin_grant'].includes(order.source) || order.productId === 'admin_grant' ? '平台发放' : order.amountFen > 0 ? '付费开通' : '会员开通';
  return { ...order, sourceLabel, titleText: order.type === 'membership_cancelled_intent' ? '购买前已取消' : `${order.days} 天会员 · ${sourceLabel}`, amountText: order.amountFen > 0 ? fmt.fen(order.amountFen) : '',
    refundText: order.refundFen > 0 ? `已退款 ${fmt.fen(order.refundFen)}` : '',
    statusLabel: order.abandoned ? '已放弃' : ORDER_STATUS[order.status] || '状态待确认', timeText: fmt.fmtDateTime(order.fulfilledAt || order.paidAt || order.createdAt) };
}

const minuteToTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeToMinute = t => { const parts = t.split(':').map(Number); return parts[0] * 60 + parts[1]; };
const presentNotification = notification => {
  const meta = hasKey(NOTIFY_STATUS, notification.status) ? NOTIFY_STATUS[notification.status] : { label: '状态待确认', cls: 'muted' };
  const eventKnown = ['first_seen_available', 'restock_confirmed', 'recovered_available', 'became_unavailable', 'status_changed'].includes(notification.eventType);
  return { ...notification, storeName: storeLabel(notification.storeNumber, notification.storeName), ...notificationAdvice(notification), statusLabel: meta.label, statusCls: meta.cls,
    reasonText: notificationReasonText(notification.reason, notification.status),
    timeText: fmt.fmtDateTime(notification.sentAt || notification.createdAt), eventLabel: eventKnown ? fmt.eventMeta(notification.eventType).label : '补货提醒' };
};

Page({
  ...reminderPanelMethods,
  data: {
    ready: false,
    loadError: null,
    versionLabel: versionLabel(),
    version: VERSION,
    ...releaseNotesPage(),
    releaseNotesPageCount: RELEASE_NOTES_PAGE_COUNT,
    showReleaseNotes: false,
    boot: null,
    membership: null,
    quota: null,
    tasks: [],
    settings: null,
    dndPeriods: [], dndSummary: '', dndStatus: '', maxDndPeriods: MAX_DND_PERIODS,
    authorizationOpen: false, subscribing: false, subscriptionPending: false,
    authorization: {}, authorizationFeedback: '', subscription: {}, reminderCenterStatus: '',
    testReturnAvailable: false,
    showLedger: false,
    ledger: [],
    orders: [],
    showOrders: false,
    showMembershipRules: false,
    showPurchaseRules: false,
    membershipBenefitPlans: [],
    membershipUpgradeEmptyText: '',
    membershipUpgradeOpen: false,
    showPurchaseShop: false,
    displayMemberProducts: [],
    purchaseUnavailableNote: '',
    purchaseMode: 'purchase',
    membershipUpgradePreview: null,
    showQuotaDetails: false,
    showReminderSettings: false,
    showNotifications: false,
    ordersLoading: false,
    ordersError: null,
    ordersClearableCount: 0,
    ordersClearUnavailable: false,
    orderActionBusy: '',
    orderDeletingId: '',
    orderConfirming: false,
    ordersActionError: null,
    ordersActionNote: '',
    notifications: [],
    notificationsLoading: false,
    notificationsError: null,
    notificationsLoadingMore: false,
    notificationsMoreError: null,
    notificationsHasMore: false,
    notificationsPaginationKnown: false,
    notificationsClearBefore: null,
    notificationActionBusy: '',
    notificationDeletingId: '',
    notificationConfirming: false,
    notificationsActionError: null,
    savingSettings: false,
    signing: false,
    refreshError: null,
    redemptionOpen: false,
    redemptionCode: '',
    redeeming: false,
    redemptionError: null,
    redemptionResult: null,
    paymentBusy: false,
    paymentChecking: false,
    paymentPendingId: '',
    paymentOrderSummary: '',
    selectedPlanId: 'member_7d',
    paymentConfirming: false,
    paymentCanRetry: false,
    paymentMessage: '',
    paymentError: '',
    contextualCheckout: false,
    checkoutTarget: null,
    checkoutMessage: '',
    checkoutLoading: false,
    showPurchaseFeedback: false,
    purchaseFeedbackSent: false,
    purchaseFeedbackOptions: PURCHASE_FEEDBACK,
  },

  async onLoad(options = {}) {
    this.pageRetired = false;
    this.pageVisible = true;
    if (!this.unsubscribeQuota) this.unsubscribeQuota = subscribeQuota(quota => {
      if (this.pageRetired) return;
      this.setData({ quota, tasks: presentTasks(this.data.tasks, quota) });
      if (this.pageVisible && this.data.showLedger) this.loadLedger();
    });
    this.setData({ redemptionOpen: options.openRedemption === '1' });
    await this.refresh();
    if (!this.pageRetired && this.pageVisible && !this.data.redeeming && this.paymentController) this.paymentController.show();
  },

  async onShow() {
    syncTabBar(this, '/pages/mine/index');
    if (this.pageRetired) return;
    this.pageVisible = true;
    this.syncAuthorizationOverlay();
    this.setData({ testReturnAvailable: Boolean(peekTestReturn()) });
    this.observeAuthorization();
    this.applyAuthorizationState(getAuthorizationState());
    this.resumeAuthorizationSync();
    this.consumePendingSection();
    this.refreshReadiness();
    const nativeReturn = this.nativePromptHiddenAt && Date.now() - this.nativePromptHiddenAt < 60000;
    this.nativePromptHiddenAt = 0;
    if (nativeReturn && this.data.ready && this.isAuthorizationAccountCurrent()) return;
    if (this.data.ready || this.data.loadError) await this.refresh({ quiet: this.data.ready, force: Boolean(this.data.loadError) });
    if (!this.pageRetired && this.pageVisible && !this.data.redeeming && this.paymentController) this.paymentController.show();
  },

  onUnload() {
    this.retirePage();
  },

  onShareAppMessage() {
    return shareAppMessage('/pages/mine/index', this.data);
  },

  onShareTimeline() {
    return shareTimeline('/pages/mine/index', this.data);
  },

  onHide() {
    this.stopDndClock();
    this.nativePromptHiddenAt = getAuthorizationState().nativeBusy ? Date.now() : 0;
    this.disconnectOfferObserver();
    this.orderConsentGeneration = (this.orderConsentGeneration || 0) + 1;
    this.paymentConsentGeneration = (this.paymentConsentGeneration || 0) + 1;
    this.pageVisible = false;
    this.hideAuthorizationOverlay();
    if (this.data.redemptionOpen) {
      this.setData({ redemptionOpen: false });
      this.setTabBarOverlay(false);
    }
    if (this.paymentController) this.paymentController.hide();
  },

  retirePage() {
    this.stopDndClock();
    this.disposeAuthorizationPanel();
    this.disconnectOfferObserver();
    this.setTabBarOverlay(false);
    this.pageRetired = true;
    this.pageVisible = false;
    if (this.paymentController) this.paymentController.dispose();
    this.ledgerGeneration = (this.ledgerGeneration || 0) + 1;
    if (this.unsubscribeQuota) { this.unsubscribeQuota(); this.unsubscribeQuota = null; }
    this.pageSession = (this.pageSession || 0) + 1;
    this.accountGeneration = (this.accountGeneration || 0) + 1;
    this.ordersGeneration = (this.ordersGeneration || 0) + 1;
    this.failedOrderAction = null;
    this.refreshing = null;
    this.notificationUnloaded = true;
    this.failedNotificationAction = null;
    this.confirmingNotificationClear = null;
    this.invalidateNotificationRead();
  },

  isCurrentSession(session) {
    return !this.pageRetired && session === (this.pageSession || 0);
  },

  onPullDownRefresh() {
    this.refresh({ quiet: true, force: true }).finally(() => wx.stopPullDownRefresh());
  },

  async refresh({ quiet, force = false, skipOrders = false } = {}) {
    if (this.pageRetired || this.data.redeeming || this.data.paymentBusy) return;
    if (this.refreshing) return this.refreshing;
    const pending = this.refreshAccount({ quiet, force, skipOrders, generation: this.accountGeneration || 0 });
    this.refreshing = pending;
    try { return await pending; }
    finally { if (this.refreshing === pending) this.refreshing = null; }
  },

  async refreshAccount({ quiet, force, skipOrders, generation }) {
    try {
      const boot = await getBootstrap({ force });
      if (this.pageRetired || generation !== (this.accountGeneration || 0)) return;
      this.applyBoot(boot);
      this.setData({ ready: true, loadError: null, refreshError: null }, () => this.observeMembershipOffer());
      this.consumePendingSection();
      const pending = [this.loadNotifications({ force })];
      if (this.data.showLedger) pending.push(this.loadLedger());
      if (this.data.showOrders && !skipOrders) pending.push(this.loadOrders({ force }));
      await Promise.all(pending);
    } catch (error) {
      if (this.pageRetired || generation !== (this.accountGeneration || 0)) return;
      if (quiet) { this.setData({ refreshError: '账户信息刷新失败，当前显示上次记录。' }); return; }
      this.setData({ loadError: error.message || String(error) });
    }
  },

  async loadOrders({ force = false, afterChange = false } = {}) {
    if (this.pageRetired || this.data.orderActionBusy) return;
    if (!force && (this.data.ordersLoading || (this.ordersLoadedAt && Date.now() - this.ordersLoadedAt < SECONDARY_CACHE_MS))) return;
    const generation = (this.ordersGeneration || 0) + 1;
    const account = this.orderAccount();
    this.ordersGeneration = generation;
    this.setData({ ordersLoading: true, ordersError: null });
    try {
      const data = await call('member.status');
      if (this.pageRetired || generation !== this.ordersGeneration || account !== this.orderAccount()) return;
      this.setOrderRecords(data.orders);
      this.ordersLoadedAt = Date.now();
    } catch (e) { if (!this.pageRetired && generation === this.ordersGeneration && account === this.orderAccount()) this.setData({ ordersError: afterChange ? '记录已清理，最新列表暂未加载成功。请重试加载。' : '会员记录暂时加载失败，请重试。' }); }
    finally { if (!this.pageRetired && generation === this.ordersGeneration) this.setData({ ordersLoading: false }); }
  },

  orderAccount() {
    return this.data.boot && this.data.boot.identity && this.data.boot.identity.userKey;
  },

  canClearOrder(order) {
    return order && order.canClearRecord === true && Boolean(order.orderId)
      && order.orderId !== this.data.paymentPendingId;
  },

  setOrderRecords(records) {
    const hidden = this.hiddenOrderIds || new Set();
    const orders = (records || []).filter(order => !hidden.has(order.orderId)).map(order => ({ ...presentOrder(order), canClear: this.canClearOrder(order),
      clearNote: order.orderId === this.data.paymentPendingId ? '请先处理上方待确认订单'
        : typeof order.canClearRecord !== 'boolean' ? '记录清理需新版服务支持'
          : this.canClearOrder(order) ? '' : '支付状态待确认，暂不可清理' }));
    this.setData({ orders, ordersClearableCount: Math.min(10, orders.filter(order => order.canClear).length),
      ordersClearUnavailable: orders.some(order => typeof order.canClearRecord !== 'boolean') });
  },

  isCurrentOrderAction(action) {
    return this.isCurrentSession(action.session) && action.account === this.orderAccount()
      && action.accountGeneration === (this.orderAccountGeneration || 0);
  },

  async confirmOrderAction(type, ids) {
    if (this.pageRetired || this.pageVisible === false || !this.orderAccount() || this.data.orderActionBusy || this.data.orderConfirming || !ids.length) return;
    const action = { type, ids: ids.slice(0, 10), account: this.orderAccount(), session: this.pageSession || 0,
      accountGeneration: this.orderAccountGeneration || 0 };
    const consent = this.orderConsentGeneration || 0;
    this.setData({ orderConfirming: true });
    let confirmed = false;
    try {
      confirmed = await new Promise(resolve => {
        if (typeof wx.showModal !== 'function') return resolve(false);
        wx.showModal({ title: type === 'clear' ? '清空当前显示的记录' : '删除这条会员记录',
          content: type === 'clear'
            ? `将移除当前显示的 ${action.ids.length} 条可清理记录。待确认订单和其他记录会保留。仅隐藏个人记录，不影响会员权益、支付核对或后台账务。`
            : '仅从你的会员记录中隐藏这一条，不影响会员权益、支付核对或后台账务。',
          confirmText: type === 'clear' ? '确认清空' : '确认删除', confirmColor: '#00C375', cancelText: '取消',
          success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) });
      });
    } finally {
      if (this.isCurrentOrderAction(action)) this.setData({ orderConfirming: false });
    }
    if (confirmed && this.isCurrentOrderAction(action) && consent === (this.orderConsentGeneration || 0) && this.pageVisible !== false) return this.applyOrderAction(action);
  },

  onDeleteOrder(e) {
    const order = this.data.orders.find(item => item.orderId === e.currentTarget.dataset.id);
    if (this.canClearOrder(order)) return this.confirmOrderAction('delete', [order.orderId]);
  },

  onClearOrders() {
    return this.confirmOrderAction('clear', this.data.orders.filter(order => this.canClearOrder(order)).map(order => order.orderId));
  },

  async applyOrderAction(action) {
    if (!this.isCurrentOrderAction(action) || this.data.orderActionBusy || this.data.orderConfirming) return;
    // Keep the consent snapshot, but protect any order now requiring payment recovery.
    const ids = action.ids.filter(id => id !== this.data.paymentPendingId && !this.data.orders.some(order => order.orderId === id && !this.canClearOrder(order)));
    if (!ids.length) {
      this.failedOrderAction = null;
      this.setData({ ordersActionError: null, ordersActionNote: '这些订单的状态已变化，待确认记录会保留。' });
      this.setOrderRecords(this.data.orders);
      return;
    }
    this.ordersGeneration = (this.ordersGeneration || 0) + 1;
    this.ordersLoadedAt = 0;
    this.setData({ orderActionBusy: action.type, orderDeletingId: action.type === 'delete' ? ids[0] : '', ordersLoading: false,
      ordersError: null, ordersActionError: null, ordersActionNote: '' });
    let applied = false;
    try {
      const response = await call(action.type === 'clear' ? 'member.clearRecords' : 'member.deleteRecord', action.type === 'clear' ? { orderIds: ids } : { orderId: ids[0] });
      if (!this.isCurrentOrderAction(action)) return;
      if (!response || !Array.isArray(response.hiddenOrderIds) || !Array.isArray(response.retained)) throw new Error('清理结果尚未确认');
      const hidden = new Set(response.hiddenOrderIds), retained = new Map(response.retained.map(item => [item.orderId, item]));
      if ([...hidden, ...retained.keys()].some(id => !ids.includes(id)) || ids.some(id => hidden.has(id) === retained.has(id))) throw new Error('清理结果尚未确认');
      if (!this.hiddenOrderIds) this.hiddenOrderIds = new Set();
      for (const id of hidden) this.hiddenOrderIds.add(id);
      this.setOrderRecords(this.data.orders.map(order => retained.has(order.orderId)
        ? { ...order, status: retained.get(order.orderId).status || order.status, canClearRecord: false, clearRecordReason: 'payment_unconfirmed' } : order));
      this.failedOrderAction = null;
      this.setData({ ordersActionNote: hidden.size ? `已清理 ${hidden.size} 条记录${retained.size ? `，${retained.size} 条待确认记录已保留` : ''}。` : '订单状态尚未确认，记录已保留，请先核对支付结果。' });
      if (hidden.size) toast('会员记录已清理', 'success');
      applied = true;
    } catch (error) {
      if (this.isCurrentOrderAction(action)) {
        this.failedOrderAction = { ...action, ids };
        this.setData({ ordersActionError: error && error.code === 'unknown_action' ? '记录清理服务尚未更新，请稍后重试。当前记录已保留。'
          : '清理结果暂未确认，记录已保留。可重试本次操作，不会清理后来显示的其他记录。' });
      }
    } finally {
      if (this.isCurrentOrderAction(action)) this.setData({ orderActionBusy: '', orderDeletingId: '' });
    }
    if (applied && this.isCurrentOrderAction(action)) return this.loadOrders({ force: true, afterChange: true });
  },

  onRetryOrderAction() {
    if (this.failedOrderAction) return this.applyOrderAction(this.failedOrderAction);
  },

  applyBoot(boot) {
    const accountChanged = !this.data.boot || this.data.boot.identity.userKey !== boot.identity.userKey;
    if (accountChanged) this.paymentConsentGeneration = (this.paymentConsentGeneration || 0) + 1;
    if (accountChanged) {
      this.checkoutGeneration = (this.checkoutGeneration || 0) + 1;
      this.checkoutContext = null;
      this.offerSeen = new Set();
      this.orderAccountGeneration = (this.orderAccountGeneration || 0) + 1;
      this.orderConsentGeneration = (this.orderConsentGeneration || 0) + 1;
      this.ordersGeneration = (this.ordersGeneration || 0) + 1;
      this.ordersLoadedAt = 0;
      this.hiddenOrderIds = new Set();
      this.failedOrderAction = null;
      this.setData({ savingSettings: false });
      this.setData({ orders: [], ordersClearableCount: 0, ordersClearUnavailable: false, orderActionBusy: '', orderDeletingId: '', orderConfirming: false,
        ordersLoading: false, ordersError: null, ordersActionError: null, ordersActionNote: '',
        checkoutTarget: null, checkoutMessage: '', showPurchaseFeedback: false, purchaseFeedbackSent: false });
    }
    const membership = boot.membership;
    this.accountSnapshot = boot;
    const notifications = boot.notifications || {};
    const subscription = restockSubscription(notifications, boot.subscriptions);
    const soldout = soldoutSubscription(notifications, boot.subscriptions);
    const settings = boot.settings || { dnd: { enabled: false, startMinute: 23 * 60, endMinute: 8 * 60 }, notifyEnabled: true };
    const products = memberProducts(boot).map(presentMemberProduct);
    const gate = purchaseGate(products, wx);
    const hasPendingOrder = Boolean(this.paymentPendingPlanId || this.data.paymentPendingId);
    const purchaseMode = membership.active ? !accountChanged && this.data.purchaseMode === 'upgrade' ? 'upgrade' : 'renew' : 'purchase';
    const purchasable = gate.showShop ? gate.purchasable : [];
    const choices = purchaseMode === 'upgrade' ? upgradeProducts(purchasable, membership) : purchasable;
    const selected = choosePurchasablePlan(hasPendingOrder ? products : choices, this.paymentPendingPlanId || this.data.selectedPlanId, {
      hasPendingOrder, isPurchasable: item => item.available === true })
      || products.find(item => item.planId === (this.paymentPendingPlanId || this.data.selectedPlanId))
      || products[0] || boot.memberProduct;
    const availability = paymentAvailability(selected, wx);
    const showPurchaseShop = gate.showShop || hasPendingOrder;
    this.setData({
      selectedPlanId: planId(selected),
      showPurchaseShop,
      purchaseUnavailableNote: gate.showShop ? '' : (gate.reason || '会员购买暂不可用，现有会员权益不受影响。'),
      displayMemberProducts: showPurchaseShop ? (gate.showShop ? choices : products.filter(item => item.planId === planId(selected))) : [],
      contextualCheckout: Boolean(boot.features && boot.features.contextualCheckout),
      membershipUpgradeOpen: showPurchaseShop && !accountChanged && this.data.membershipUpgradeOpen,
      purchaseMode,
      membershipUpgradeEmptyText: membership.planId === 'member_365d' ? '你已是年卡会员，当前没有更高档套餐。' : '暂时没有可升级的套餐，可继续延长会员。',
      membershipUpgradePreview: renewalPreview(selected, membership),
      membershipBenefitPlans: membershipBenefitPlans(products),
      boot: {
        identity: boot.identity,
        member: membership.active, templateIds: subscription.templateIds, soldoutId: soldout.templateId,
        requestIds: [...new Set([...subscription.templateIds, ...(soldout.templateId ? [soldout.templateId] : [])])],
        notificationReason: notifications.reason || '',
        features: boot.features || {},
        memberProducts: products,
        memberProduct: selected,
        priceText: fmt.fen(selected.priceFen),
        collector: { ...boot.collector, ...fmt.collectorMeta(boot.collector.state) },
        followCount: boot.followCount,
        freeReminder: false,
        limits: boot.limits,
        paymentReady: availability.ready,
        paymentReason: availability.reason,
        paymentCode: availability.code,
        purchaseNotice: purchaseNotice(selected),
      },
      membership: presentMembership(membership),
      quota: boot.quota,
      tasks: presentTasks(boot.tasks, boot.quota),
      settings,
      subscription: { ...subscription, soldoutEnabled: Boolean(soldout.templateId), soldoutCredits: soldout.credits },
      ...this.presentDnd(settings),
      testReturnAvailable: Boolean(peekTestReturn()),
    });
    this.observeAuthorization();
    this.applyAuthorizationState(getAuthorizationState());
    this.refreshReadiness();
    this.resumeAuthorizationSync();
    this.ensurePaymentController().sync(boot.identity, selected);
    this.restoreCheckoutContext();
  },

  selectMemberProduct(id) {
    const boot = this.data.boot;
    const selected = boot && (boot.memberProducts || []).find(item => item.planId === id);
    if (!selected) return;
    if (!this.data.paymentPendingId && !planPurchasable(selected, wx)) {
      toast('此套餐暂不可用，请选择其他可购买套餐');
      return;
    }
    const availability = paymentAvailability(selected, wx);
    this.setData({ selectedPlanId: selected.planId, boot: { ...boot, memberProduct: selected,
      priceText: fmt.fen(selected.priceFen), purchaseNotice: purchaseNotice(selected),
      paymentReady: availability.ready, paymentReason: availability.reason, paymentCode: availability.code },
      membershipUpgradePreview: renewalPreview(selected, this.data.membership) });
    this.observeMembershipOffer();
    if (this.paymentController) this.paymentController.sync(boot.identity, selected);
  },

  onSelectMemberProduct(event) {
    if (this.pageRetired || this.isNativeAuthorizationBusy() || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking || this.data.paymentPendingId || this.data.paymentConfirming) return;
    const candidate = this.data.boot && (this.data.boot.memberProducts || []).find(item => item.planId === event.currentTarget.dataset.planId);
    if (!candidate || !candidate.available) return;
    if (this.data.purchaseMode === 'upgrade' && !upgradeProducts([candidate], this.data.membership).length) return;
    this.selectMemberProduct(event.currentTarget.dataset.planId);
  },

  canChangeMembershipPurchase() {
    return !this.pageRetired && this.data.ready && this.data.boot && this.data.membership
      && !this.isNativeAuthorizationBusy() && !this.data.redeeming && !this.data.paymentBusy && !this.data.paymentChecking && !this.data.paymentPendingId && !this.data.paymentConfirming;
  },

  isNativeAuthorizationBusy() {
    return this.data.subscribing || getAuthorizationState().nativeBusy;
  },

  onOpenMembershipUpgrade() {
    if (!this.canChangeMembershipPurchase() || !this.data.membership.active) return;
    const products = (this.data.boot.memberProducts || []).filter(item => item.available);
    if (!products.length) return toast('会员购买暂不可用，现有会员权益不受影响。');
    const choices = upgradeProducts(products, this.data.membership);
    const selected = choices.find(item => item.planId === this.data.selectedPlanId) || choices[0];
    this.setData({ membershipUpgradeOpen: true, purchaseMode: 'upgrade', displayMemberProducts: choices,
      membershipUpgradeEmptyText: this.data.membership.planId === 'member_365d' ? '你已是年卡会员，当前没有更高档套餐。' : '暂时没有可升级的套餐，可继续延长会员。' });
    if (selected) this.selectMemberProduct(selected.planId);
  },

  onOpenMembershipRenew() {
    if (!this.canChangeMembershipPurchase()) return;
    const products = (this.data.boot.memberProducts || []).filter(item => item.available);
    if (!products.length) return toast('会员购买暂不可用，请稍后重试');
    const preferred = this.data.membership.active && products.find(item => item.planId === this.data.membership.planId)
      || products.find(item => item.planId === this.data.selectedPlanId) || products[0];
    this.setData({ membershipUpgradeOpen: true, purchaseMode: this.data.membership.active ? 'renew' : 'purchase', displayMemberProducts: products });
    this.selectMemberProduct(preferred.planId);
  },

  onCloseMembershipUpgrade() {
    if (!this.canChangeMembershipPurchase()) return;
    this.setData({ membershipUpgradeOpen: false });
    this.disconnectOfferObserver();
  },

  ensureCheckoutStore() {
    if (!this.checkoutStore) this.checkoutStore = createCheckoutContext({ wx });
    return this.checkoutStore;
  },

  legacyMemberFollow() {
    if (typeof getApp !== 'function') return null;
    const app = getApp(), intent = app.globalData.pendingMemberFollow;
    if (!intent) return null;
    const identity = this.data.boot && this.data.boot.identity;
    // Old in-memory hints have no metadata; all newly written hints are bounded.
    const wrongAccount = intent.userKey && (!identity || intent.userKey !== identity.userKey);
    const expired = intent.createdAt !== undefined && (!Number.isFinite(intent.createdAt)
      || intent.createdAt > Date.now() || Date.now() - intent.createdAt >= CHECKOUT_TTL_MS);
    if (wrongAccount || expired) { app.globalData.pendingMemberFollow = null; return null; }
    return intent;
  },

  async restoreCheckoutContext() {
    const generation = (this.checkoutGeneration || 0) + 1;
    this.checkoutGeneration = generation;
    if (!this.data.contextualCheckout || !this.data.boot) {
      this.checkoutContext = null;
      this.setData({ checkoutTarget: null, checkoutMessage: '', checkoutLoading: false });
      return;
    }
    const identity = this.data.boot.identity;
    const stored = this.ensureCheckoutStore().restore(identity, typeof currentCatalog === 'function' ? currentCatalog() : null);
    if (['empty', 'expired', 'invalid', 'storage_failed'].includes(stored.status)) {
      this.checkoutContext = null;
      this.setData({ checkoutTarget: null, checkoutMessage: CHECKOUT_MESSAGES[stored.status] || '', checkoutLoading: false }, () => this.observeMembershipOffer());
      return;
    }
    this.setData({ checkoutLoading: true });
    try {
      const catalog = typeof getCatalog === 'function' ? await getCatalog() : typeof currentCatalog === 'function' ? currentCatalog() : null;
      if (this.pageRetired || generation !== this.checkoutGeneration || identity.userKey !== this.data.boot.identity.userKey) return;
      this.checkoutCatalog = catalog;
      const restored = this.ensureCheckoutStore().restore(identity, catalog);
      this.checkoutContext = restored.context || null;
      this.setData({ checkoutTarget: restored.context || null, checkoutMessage: CHECKOUT_MESSAGES[restored.status] || '', checkoutLoading: false }, () => this.observeMembershipOffer());
    } catch (_) {
      if (!this.pageRetired && generation === this.checkoutGeneration) this.setData({ checkoutTarget: null, checkoutMessage: '暂时无法确认所选配置，请刷新后重试。', checkoutLoading: false }, () => this.observeMembershipOffer());
    }
  },

  currentCheckout() {
    if (!this.data.contextualCheckout || !this.data.boot) return null;
    const catalog = typeof currentCatalog === 'function' && currentCatalog() || this.checkoutCatalog;
    const restored = this.ensureCheckoutStore().restore(this.data.boot.identity, catalog);
    this.checkoutContext = restored.context || null;
    this.setData({ checkoutTarget: restored.context || null, checkoutMessage: CHECKOUT_MESSAGES[restored.status] || '' });
    return this.checkoutContext;
  },

  onContinueCheckout() {
    if (this.pageRetired || !this.data.membership || !this.data.membership.active) return;
    const intent = this.currentCheckout();
    if (!intent || typeof getApp !== 'function') return;
    getApp().globalData.pendingFollow = { partNumber: intent.partNumber, storeNumbers: intent.storeNumbers.slice(),
      checkoutRevision: intent.revision, checkoutSignature: intent.targetSignature };
    wx.switchTab({ url: '/pages/follow/index' });
  },

  onReturnToQuery() {
    if (this.pageRetired || this.data.paymentBusy || this.data.paymentConfirming) return;
    wx.switchTab({ url: '/pages/query/index' });
  },

  onTogglePurchaseFeedback() { this.setData({ showPurchaseFeedback: !this.data.showPurchaseFeedback }); },
  onPurchaseFeedback(event) {
    const code = event.currentTarget.dataset.code;
    if (this.data.purchaseFeedbackSent || !PURCHASE_FEEDBACK.some(item => item.code === code)) return;
    this.trackConversion('purchase_feedback', { reasonCode: code });
    this.setData({ purchaseFeedbackSent: true });
  },

  trackConversion(eventName, fields = {}) {
    try { conversion.track(eventName, { entryPoint: this.checkoutContext ? 'checkout' : 'mine', planId: this.data.selectedPlanId, ...fields }); } catch (_) { /* Optional diagnostics must not block purchases. */ }
  },

  disconnectOfferObserver() {
    if (this.offerObserver) this.offerObserver.disconnect();
    this.offerObserver = null;
  },

  observeMembershipOffer() {
    this.disconnectOfferObserver();
    if (this.pageRetired || this.pageVisible === false || !this.data.ready || !this.data.boot || this.data.checkoutLoading || !this.data.boot.features.growthEvents
      || this.data.paymentPendingId || !this.data.membershipUpgradeOpen || !this.data.displayMemberProducts.length || typeof this.createIntersectionObserver !== 'function') return;
    // Actual native visibility, never a synthetic exposure at bootstrap time.
    const observer = this.createIntersectionObserver({ thresholds: [0, 0.01] });
    this.offerObserver = observer;
    observer.relativeToViewport().observe('#membership-offer', result => {
      if (this.offerObserver !== observer || this.pageRetired || this.pageVisible === false || this.data.paymentPendingId
        || !this.data.membershipUpgradeOpen || !this.data.displayMemberProducts.length || !result || result.intersectionRatio <= 0) return;
      const key = `${this.orderAccount()}|${this.data.selectedPlanId}|${this.checkoutContext ? this.checkoutContext.targetSignature : 'mine'}`;
      if (!this.offerSeen) this.offerSeen = new Set();
      if (this.offerSeen.has(key)) return;
      this.offerSeen.add(key);
      this.trackConversion('offer_viewed');
      if (!this.data.boot.paymentReady) this.trackConversion('checkout_blocked', { reasonCode: this.data.boot.paymentCode, result: 'blocked' });
    });
  },

  onTestNotification() {
    if (this.pageRetired) return;
    wx.navigateTo({ url: '/pages/notification-test/index?from=mine' });
  },

  ensurePaymentController() {
    if (!this.paymentController) {
      this.paymentController = createPaymentController({ wx, call, makeId: typeof newId === 'function' ? () => newId('member') : undefined,
      onDiagnostic: (eventName, fields) => this.trackConversion(eventName, fields),
      onPriceChanged: product => this.applyPriceChange(product),
      onUpdate: patch => {
        if (this.pageRetired) return;
        const { paymentPendingPlanId, paymentDiagnosticCode, ...view } = patch;
        this.paymentPendingPlanId = paymentPendingPlanId;
        this.paymentDiagnosticCode = paymentDiagnosticCode;
        const pendingChanged = hasKey(view, 'paymentPendingId') && view.paymentPendingId !== this.data.paymentPendingId;
        if (pendingChanged) this.disconnectOfferObserver();
        this.setData(view, () => { if (pendingChanged) this.observeMembershipOffer(); });
        if (hasKey(view, 'paymentPendingId')) this.setOrderRecords(this.data.orders);
        if (paymentPendingPlanId && paymentPendingPlanId !== this.data.selectedPlanId) this.selectMemberProduct(paymentPendingPlanId);
      },
      onResolved: async ({ membership }) => {
        if (this.pageRetired) return;
        this.accountGeneration = (this.accountGeneration || 0) + 1;
        this.ordersGeneration = (this.ordersGeneration || 0) + 1;
        this.refreshing = null;
        invalidateBootstrap(); invalidateFollows(); this.ordersLoadedAt = 0;
        this.setData({ membership: presentMembership(membership), showOrders: true });
        this.setData({ membershipUpgradeOpen: false, purchaseMode: membership.active ? 'renew' : 'purchase',
          membershipUpgradePreview: renewalPreview(this.data.boot.memberProduct, membership) }, () => this.observeMembershipOffer());
        this.resumeMemberFollow(membership);
        await this.loadOrders({ force: true });
      },
      });
      if (this.pageVisible) this.paymentController.show();
    }
    return this.paymentController;
  },

  applyPriceChange(product) {
    if (this.pageRetired || !this.data.boot || !product || !Number.isSafeInteger(product.priceFen) || product.priceFen <= 0
      || !Number.isInteger(product.days) || product.days <= 0) return;
    const id = planId(product), products = this.data.boot.memberProducts.map(item => item.planId === id ? presentMemberProduct({ ...item, ...product }) : item);
    invalidateBootstrap();
    const available = products.filter(item => item.available);
    this.setData({ boot: { ...this.data.boot, memberProducts: products },
      displayMemberProducts: this.data.purchaseMode === 'upgrade' ? upgradeProducts(available, this.data.membership) : available });
    this.selectMemberProduct(id);
    this.setData({ paymentError: '套餐价格已更新，本次未发起付款。请核对当前金额后重新确认购买。' });
  },

  async onBuyMembership() {
    if (this.pageRetired || this.isNativeAuthorizationBusy() || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking || this.data.paymentConfirming || !this.data.ready || !this.data.boot) return;
    if (!this.data.paymentPendingId) {
      if (!this.data.showPurchaseShop || !this.data.boot.paymentReady) return;
      const selected = (this.data.boot.memberProducts || []).find(item => item.planId === this.data.selectedPlanId) || this.data.boot.memberProduct;
      if (this.data.purchaseMode === 'upgrade' && !upgradeProducts([selected], this.data.membership).length) return;
      if (!selected || !planPurchasable(selected, wx)) {
        this.setData({ paymentError: '会员购买暂不可用，现有会员权益不受影响。' });
        return;
      }
    }
    const targetRequired = !this.data.membership || !this.data.membership.active;
    if (!this.data.paymentPendingId && targetRequired && (this.data.checkoutLoading || this.data.checkoutMessage)) return;
    const checkout = this.currentCheckout();
    if (!this.data.paymentPendingId && targetRequired && this.data.checkoutMessage) return;
    const checkoutRevision = checkout && checkout.revision;
    const notice = this.data.boot.purchaseNotice;
    const selectedPlanId = this.data.selectedPlanId;
    const consentGeneration = this.paymentConsentGeneration || 0;
    const consentAccount = this.data.boot.identity.userKey;
    const consentOrder = this.data.paymentPendingId;
    const packageText = this.data.paymentOrderSummary || `${this.data.boot.memberProduct.days} 天会员 · ${this.data.boot.priceText}`;
    const consentTerms = JSON.stringify({ priceFen: this.data.boot.memberProduct.priceFen, days: this.data.boot.memberProduct.days, notice });
    const extension = renewalPreview(this.data.boot.memberProduct, this.data.membership);
    const extensionNotice = this.data.membership && this.data.membership.active
      ? `\n\n${extension.extensionText}，剩余有效期保留，不抵扣差价。${extension.expiresAtText ? '\n预计到期：' + extension.expiresAtText + '，以支付确认后的账户为准。' : ''}` : '';
    this.setData({ paymentConfirming: true });
    this.trackConversion('offer_cta_clicked');
    const intent = checkout || (!this.data.contextualCheckout ? this.legacyMemberFollow() : null);
    let confirmed = false;
    try {
      confirmed = await new Promise(resolve => {
        if (typeof wx.showModal !== 'function') { resolve(false); return; }
        let settled = false;
        const settle = value => { if (!settled) { settled = true; resolve(value); } };
        const canTime = typeof setTimeout === 'function' && typeof clearTimeout === 'function';
        const timer = canTime ? setTimeout(() => settle(false), 15000) : null;
        wx.showModal({
          title: '购买须知',
          content: `${packageText}\n\n${notice}${extensionNotice}${intent ? '\n\n开通后继续设置关注：' + intent.title + (intent.storeText ? '\n门店：' + intent.storeText : '') + '\n提醒需你主动授权，保存前可再次确认。' : ''}\n\n确认即表示已阅读并同意上述说明。`,
          confirmText: '同意购买',
          confirmColor: '#00C375',
          cancelText: '取消',
          success: result => { if (canTime) clearTimeout(timer); settle(Boolean(result.confirm)); },
          fail: () => { if (canTime) clearTimeout(timer); settle(false); },
        });
      });
    } finally {
      if (!this.pageRetired) this.setData({ paymentConfirming: false });
    }
    if (this.pageRetired) return;
    if (!confirmed || this.pageVisible === false || this.data.redeeming || selectedPlanId !== this.data.selectedPlanId
      || consentGeneration !== (this.paymentConsentGeneration || 0) || consentAccount !== this.data.boot.identity.userKey
      || consentOrder !== this.data.paymentPendingId) return;
    // Keep the controller's product aligned with the card the user just paid for.
    const latestSelected = (this.data.boot.memberProducts || []).find(item => item.planId === this.data.selectedPlanId) || this.data.boot.memberProduct;
    if (!this.data.paymentPendingId && this.data.purchaseMode === 'upgrade' && !upgradeProducts([latestSelected], this.data.membership).length) return;
    if (latestSelected) this.ensurePaymentController().sync(this.data.boot.identity, latestSelected);
    const latestPackage = this.data.paymentOrderSummary || `${this.data.boot.memberProduct.days} 天会员 · ${this.data.boot.priceText}`;
    const latestTerms = JSON.stringify({ priceFen: this.data.boot.memberProduct.priceFen, days: this.data.boot.memberProduct.days, notice: this.data.boot.purchaseNotice });
    if (consentTerms !== latestTerms || packageText !== latestPackage) {
      this.setData({ paymentError: '套餐金额或说明已更新，请查看当前内容后重新确认购买。' });
      return;
    }
    if (checkoutRevision) {
      const latest = this.currentCheckout();
      if (!latest || latest.revision !== checkoutRevision || latest.targetSignature !== checkout.targetSignature) return;
    }
    return this.ensurePaymentController().buy();
  },

  onCheckPayment() {
    if (this.pageRetired || this.isNativeAuthorizationBusy() || this.data.redeeming || this.data.paymentConfirming) return;
    return this.ensurePaymentController().check();
  },

  async onAbandonPayment() {
    if (this.pageRetired || this.isNativeAuthorizationBusy() || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking || this.data.paymentConfirming
      || !this.data.paymentPendingId || !this.data.boot) return;
    const consentGeneration = this.paymentConsentGeneration || 0;
    const consentAccount = this.data.boot.identity.userKey;
    const consentOrder = this.data.paymentPendingId;
    this.setData({ paymentConfirming: true });
    let confirmed = false;
    try {
      confirmed = await new Promise(resolve => {
        if (typeof wx.showModal !== 'function') { resolve(false); return; }
        let settled = false;
        const settle = value => { if (!settled) { settled = true; resolve(value); } };
        const canTime = typeof setTimeout === 'function' && typeof clearTimeout === 'function';
        const timer = canTime ? setTimeout(() => settle(false), 15000) : null;
        wx.showModal({
          title: '放弃这笔订单',
          content: '放弃前会先向微信核对一次：已付款会直接开通会员，确认没有付款才会放弃，之后可以重新购买。',
          confirmText: '确认放弃',
          cancelText: '再等等',
          success: result => { if (canTime) clearTimeout(timer); settle(Boolean(result.confirm)); },
          fail: () => { if (canTime) clearTimeout(timer); settle(false); },
        });
      });
    } finally {
      if (!this.pageRetired) this.setData({ paymentConfirming: false });
    }
    if (this.pageRetired) return;
    if (!confirmed || this.pageVisible === false || this.data.redeeming
      || consentGeneration !== (this.paymentConsentGeneration || 0) || consentAccount !== this.data.boot.identity.userKey
      || consentOrder !== this.data.paymentPendingId) return;
    return this.ensurePaymentController().abandon();
  },

  noop() {},

  onOpenRedemption() {
    if (this.pageRetired || this.isNativeAuthorizationBusy() || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking || this.data.paymentConfirming) return;
    const open = !this.data.redemptionOpen;
    this.setData({ redemptionOpen: open, redemptionCode: '', redemptionError: null, redemptionResult: null });
    this.setTabBarOverlay(open);
  },

  setTabBarOverlay(hidden) {
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (bar && bar.setData) bar.setData({ sheetHidden: Boolean(hidden) });
  },

  onRedemptionInput(e) {
    if (this.pageRetired || this.data.redeeming) return;
    this.setData({ redemptionCode: String(e.detail.value || ''), redemptionError: null, redemptionResult: null });
  },

  async onRedeemCode() {
    if (this.pageRetired || this.isNativeAuthorizationBusy() || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking || this.data.paymentConfirming) return;
    const code = this.data.redemptionCode.trim();
    if (!code) { this.setData({ redemptionError: '请输入兑换码。' }); return; }
    // Suspend order polling while another server-side membership change runs.
    if (this.paymentController) this.paymentController.hide();
    this.accountGeneration = (this.accountGeneration || 0) + 1;
    const generation = this.accountGeneration;
    this.refreshing = null;
    this.ordersGeneration = (this.ordersGeneration || 0) + 1;
    this.setData({ redeeming: true, redemptionError: null, redemptionResult: null, ordersLoading: false });
    let confirmed = false;
    try {
      const result = await call('member.redeemCode', { code });
      if (this.pageRetired || generation !== this.accountGeneration) return;
      const membership = result && result.membership;
      if (!result || result.redeemed !== true || !membership || typeof membership.active !== 'boolean' || !(Number.isFinite(Date.parse(membership.expiresAt)) || (!membership.active && membership.expiresAt === null)) || !Number.isFinite(membership.remainingMs)) throw new Error('兑换结果尚未确认');
      invalidateBootstrap(); invalidateFollows();
      this.ordersLoadedAt = 0;
      const already = result.alreadyRedeemed === true;
      this.setData({ membership: presentMembership(membership), redemptionCode: '', showOrders: true,
        membershipUpgradeOpen: false, purchaseMode: membership.active ? 'renew' : 'purchase',
        membershipUpgradePreview: renewalPreview(this.data.boot && this.data.boot.memberProduct, membership),
        redemptionResult: { title: already ? '此账号已兑换过' : '兑换成功',
          detail: already ? (membership.active ? '本次未重复增加时间，当前会员有效期见上方。' : membership.expiresAt ? '本次未重新开通，当前会员已到期。' : '本次未重新开通，当前账号没有生效的会员。') : '会员有效期已更新，现在可以使用会员权益。',
          kind: already ? 'info' : 'ok' } });
      confirmed = true;
      if (!already) { confirmTap(); this.resumeMemberFollow(membership); }
    } catch (error) {
      if (!this.pageRetired && generation === this.accountGeneration) this.setData({ redemptionError: redemptionErrorText(error) });
    } finally {
      if (!this.pageRetired && generation === this.accountGeneration) this.setData({ redeeming: false });
    }
    // A failed account/record refresh never undoes the server-confirmed result.
    if (confirmed) await Promise.all([this.refresh({ quiet: true, force: true, skipOrders: true }), this.loadOrders({ force: true })]);
    if (!this.pageRetired && this.pageVisible && this.paymentController) this.paymentController.show();
  },

  /** Offer the configuration a non-member tried to follow on the query page. */
  resumeMemberFollow(membership) {
    if (this.data.contextualCheckout) {
      if (membership && membership.active && !this.pageRetired) this.currentCheckout();
      return; // The visible continuation button preserves explicit save/authorization consent.
    }
    if (typeof getApp !== 'function') return;
    const app = getApp(), intent = this.legacyMemberFollow();
    if (!intent || !membership || !membership.active || this.pageRetired) return;
    const account = this.data.boot && this.data.boot.identity && this.data.boot.identity.userKey;
    const generation = this.paymentConsentGeneration || 0;
    app.globalData.pendingMemberFollow = null;
    wx.showModal({
      title: '会员已开通',
      content: `继续关注「${intent.title}」？可在关注页确认门店后保存。`,
      confirmText: '去关注',
      cancelText: '稍后',
      success: r => {
        if (!r.confirm || this.pageRetired || this.pageVisible === false || generation !== (this.paymentConsentGeneration || 0)
          || account !== (this.data.boot && this.data.boot.identity && this.data.boot.identity.userKey)) return;
        app.globalData.pendingFollow = { partNumber: intent.partNumber, storeNumbers: intent.storeNumbers.slice() };
        wx.switchTab({ url: '/pages/follow/index' });
      },
    });
  },

  invalidateNotificationRead() {
    this.notificationGeneration = (this.notificationGeneration || 0) + 1;
    this.notificationReadPromise = null;
    this.notificationsLoadedAt = 0;
  },

  rememberNotificationSnapshot(notifications, clearBefore) {
    if (!clearBefore) return;
    // Pages fetched with the original cursor belong to the same clear boundary.
    // Keep their IDs with the confirmation/retry, including pages arriving while
    // its modal is open. A genuinely newer first-page snapshot has another token.
    for (const action of [this.confirmingNotificationClear, this.failedNotificationAction]) {
      if (!action || action.type !== 'clear' || action.before !== clearBefore) continue;
      const ids = new Set(action.visibleIds || []);
      for (const notification of notifications) ids.add(notification.id);
      action.visibleIds = [...ids];
    }
  },

  async loadNotifications({ force = false, targetCount, afterChange = false } = {}) {
    if (this.notificationUnloaded || this.data.notificationActionBusy) return;
    if (!force && this.notificationReadPromise) return this.notificationReadPromise;
    if (!force && this.notificationsLoadedAt && Date.now() - this.notificationsLoadedAt < SECONDARY_CACHE_MS) return;
    const generation = (this.notificationGeneration || 0) + 1;
    this.notificationGeneration = generation;
    const wanted = Math.max(20, targetCount || this.data.notifications.length);
    this.setData({ notificationsLoading: true, notificationsLoadingMore: false, notificationsError: null, notificationsMoreError: null });
    const pending = (async () => {
      try {
        const notifications = [], seen = new Set(), cursors = new Set();
        let cursor = null, hasMore = false, clearBefore = null, fetchedPages = 0, paginationKnown = false;
        do {
          const data = await call('notify.list', { limit: 20, ...(cursor ? { cursor } : {}) });
          if (this.notificationUnloaded || generation !== this.notificationGeneration) return;
          fetchedPages++;
          if (!cursor) clearBefore = data.clearBefore || null;
          this.rememberNotificationSnapshot(data.notifications || [], clearBefore);
          for (const item of data.notifications || []) if (!seen.has(item.id)) { seen.add(item.id); notifications.push(presentNotification(item)); }
          cursor = data.nextCursor || null;
          hasMore = Boolean(data.hasMore && cursor && !cursors.has(cursor));
          paginationKnown = typeof data.hasMore === 'boolean' && (!data.hasMore || hasMore);
          if (cursor) cursors.add(cursor);
        } while (hasMore && fetchedPages < Math.ceil(wanted / 20));
        this.notificationsNextCursor = cursor;
        this.setData({ notifications, notificationsHasMore: hasMore, notificationsPaginationKnown: paginationKnown, notificationsClearBefore: clearBefore });
        this.notificationsLoadedAt = Date.now();
      } catch (e) {
        if (!this.notificationUnloaded && generation === this.notificationGeneration) this.setData({ notificationsError: afterChange ? '提醒记录已清理，但列表刷新失败。请重试加载最新记录。' : '提醒记录暂时加载失败，已显示的记录会保留，请重试。' });
      } finally {
        if (!this.notificationUnloaded && generation === this.notificationGeneration) this.setData({ notificationsLoading: false });
      }
    })();
    this.notificationReadPromise = pending;
    try { return await pending; }
    finally { if (this.notificationReadPromise === pending) this.notificationReadPromise = null; }
  },

  async onLoadMoreNotifications() {
    if (this.notificationUnloaded || this.data.notificationActionBusy || this.notificationReadPromise || !this.data.notificationsHasMore || !this.notificationsNextCursor) return;
    const generation = (this.notificationGeneration || 0) + 1;
    this.notificationGeneration = generation;
    const cursor = this.notificationsNextCursor;
    const clearBefore = this.data.notificationsClearBefore;
    this.setData({ notificationsLoadingMore: true, notificationsMoreError: null });
    const pending = (async () => {
      try {
        const data = await call('notify.list', { limit: 20, cursor });
        if (this.notificationUnloaded || generation !== this.notificationGeneration) return;
        this.rememberNotificationSnapshot(data.notifications || [], clearBefore);
        const seen = new Set(this.data.notifications.map(item => item.id));
        const additional = (data.notifications || []).filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; }).map(presentNotification);
        this.notificationsNextCursor = data.nextCursor || null;
        this.setData({ notifications: [...this.data.notifications, ...additional],
          notificationsHasMore: Boolean(data.hasMore && data.nextCursor && data.nextCursor !== cursor),
          notificationsPaginationKnown: typeof data.hasMore === 'boolean' && (!data.hasMore || Boolean(data.nextCursor && data.nextCursor !== cursor)) });
      } catch (e) {
        if (!this.notificationUnloaded && generation === this.notificationGeneration) this.setData({ notificationsMoreError: '更早的提醒加载失败，请重试。' });
      } finally {
        if (!this.notificationUnloaded && generation === this.notificationGeneration) this.setData({ notificationsLoadingMore: false });
      }
    })();
    this.notificationReadPromise = pending;
    try { return await pending; }
    finally { if (this.notificationReadPromise === pending) this.notificationReadPromise = null; }
  },

  async confirmNotificationAction(action) {
    if (this.notificationUnloaded || this.data.notificationActionBusy || this.data.notificationConfirming) return;
    const session = this.pageSession || 0;
    if (action.type === 'clear') this.confirmingNotificationClear = action;
    this.setData({ notificationConfirming: true });
    let confirmed = false;
    try {
      confirmed = await new Promise(resolve => wx.showModal({
        title: action.type === 'clear' ? '清空提醒记录' : '删除这条提醒记录',
        content: action.type === 'clear'
          ? '将清空本次列表加载时已有的全部个人提醒记录，包括尚未加载的更早记录。后来新到的提醒会保留。不会取消关注、撤回微信消息或删除库存历史。'
          : '仅从你的提醒记录中移除这一条，不会取消关注、撤回微信消息或删除库存历史。',
        confirmText: action.type === 'clear' ? '确认清空' : '确认删除', confirmColor: '#D64545',
        success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false),
      }));
    } finally {
      if (this.confirmingNotificationClear === action) this.confirmingNotificationClear = null;
      if (this.isCurrentSession(session)) this.setData({ notificationConfirming: false });
    }
    if (confirmed && this.isCurrentSession(session)) return this.applyNotificationAction(action);
  },

  onDeleteNotification(e) {
    const id = e.currentTarget.dataset.id;
    if (!this.data.notifications.some(item => item.id === id)) return;
    return this.confirmNotificationAction({ type: 'delete', id });
  },

  onClearNotifications() {
    const before = this.data.notificationsClearBefore;
    if (!this.data.notifications.length || !before) return;
    // This opaque server token remains fixed while the confirmation is open.
    return this.confirmNotificationAction({ type: 'clear', before, visibleIds: this.data.notifications.map(item => item.id) });
  },

  async applyNotificationAction(action) {
    if (this.notificationUnloaded || this.data.notificationActionBusy) return;
    const session = this.pageSession || 0;
    const targetCount = this.data.notifications.length;
    this.invalidateNotificationRead();
    this.setData({ notificationActionBusy: action.type, notificationDeletingId: action.id || '', notificationsLoading: false, notificationsLoadingMore: false,
      notificationsError: null, notificationsMoreError: null, notificationsActionError: null });
    let applied = false;
    try {
      const response = await call(action.type === 'clear' ? 'notify.clear' : 'notify.delete', action.type === 'clear' ? { before: action.before } : { id: action.id });
      if (action.type === 'clear' ? !response.cleared : !response.deleted) throw new Error('清理结果尚未确认');
      if (!this.isCurrentSession(session)) return;
      const removed = new Set(action.type === 'clear' ? action.visibleIds : [action.id]);
      this.setData({ notifications: this.data.notifications.filter(item => !removed.has(item.id)), notificationsClearBefore: null });
      this.failedNotificationAction = null;
      applied = true;
      toast(action.type === 'clear' ? '已清空此前的提醒记录' : '已删除提醒记录', 'success');
    } catch (error) {
      if (this.isCurrentSession(session)) {
        this.failedNotificationAction = action;
        this.setData({ notificationsActionError: action.type === 'clear' ? '清空结果未确认，记录暂时保留。可重试原清空操作，新到提醒不受影响。' : '删除结果未确认，记录暂时保留。请重试。' });
      }
    } finally {
      if (this.isCurrentSession(session)) this.setData({ notificationActionBusy: '', notificationDeletingId: '' });
    }
    if (applied) return this.loadNotifications({ force: true, targetCount, afterChange: true });
  },

  onRetryNotificationAction() {
    if (this.failedNotificationAction && !this.data.notificationConfirming) return this.applyNotificationAction(this.failedNotificationAction);
  },

  onRetryNotifications() {
    return this.loadNotifications({ force: true });
  },

  onRetryOrders() {
    return this.loadOrders({ force: true });
  },

  async onSignin() {
    if (this.pageRetired || this.data.signing) return;
    topUpReminderCredit();
    const session = this.pageSession || 0;
    this.setData({ signing: true });
    try {
      const data = await call('quota.signin');
      if (!this.isCurrentSession(session)) return;
      if (data.granted > 0) { confirmTap(); toast(`签到成功 +${data.granted} 次`, 'success'); }
      else if (data.reason === 'already_signed_in') toast('今天已签到');
      else if (data.reason === 'daily_cap_reached') toast('今日获取次数已达上限');
      else if (data.reason === 'balance_cap_reached') toast(`余额已达上限 ${data.quota.balanceCap} 次`);
      invalidateBootstrap();
      if (publishQuota(data.quota) !== false) this.setData({ quota: currentQuota() || data.quota });
    } catch (error) {
      if (this.isCurrentSession(session)) showError(error);
    } finally {
      if (this.isCurrentSession(session)) this.setData({ signing: false });
    }
  },

  onGoHistory() {
    wx.switchTab({ url: '/pages/history/index' });
  },

  onToggleMembershipRules() {
    if (!this.pageRetired) this.setData({ showMembershipRules: !this.data.showMembershipRules, showPurchaseRules: !this.data.showMembershipRules });
  },

  onTogglePurchaseRules() {
    if (!this.pageRetired) this.setData({ showPurchaseRules: !this.data.showPurchaseRules });
  },

  onToggleReleaseNotes() {
    if (this.pageRetired) return;
    this.setData({ showReleaseNotes: !this.data.showReleaseNotes, ...releaseNotesPage() });
  },

  onPreviousReleaseNotes() {
    if (this.pageRetired || !this.data.showReleaseNotes || this.data.releaseNotesPage <= 1) return;
    this.setData(releaseNotesPage(this.data.releaseNotesPage - 1));
  },

  onNextReleaseNotes() {
    if (this.pageRetired || !this.data.showReleaseNotes || this.data.releaseNotesPage >= RELEASE_NOTES_PAGE_COUNT) return;
    this.setData(releaseNotesPage(this.data.releaseNotesPage + 1));
  },

  onToggleQuotaDetails() {
    if (!this.pageRetired) this.setData({ showQuotaDetails: !this.data.showQuotaDetails });
  },

  onToggleReminderSettings() {
    if (!this.pageRetired) this.setData({ showReminderSettings: !this.data.showReminderSettings });
  },

  async onToggleNotifications() {
    if (this.pageRetired || this.data.notificationActionBusy || this.data.notificationConfirming) return;
    const showNotifications = !this.data.showNotifications;
    this.setData({ showNotifications });
    if (showNotifications) await this.loadNotifications();
  },

  consumePendingSection() {
    if (this.pageRetired || !this.pageVisible || !this.data.ready || this.data.loadError || typeof getApp !== 'function') return;
    const section = getApp().globalData.pendingMineSection;
    if (!['reminder-center', 'reminder-settings', 'membership-card', 'quota-card', 'notification-records'].includes(section)) return;
    if (section === 'reminder-settings') this.setData({ showReminderSettings: true });
    if (section === 'membership-card') this.setData({ showMembershipRules: true, showPurchaseRules: true });
    if (section === 'quota-card') this.setData({ showQuotaDetails: true });
    if (section === 'notification-records') {
      this.setData({ showNotifications: true });
      this.loadNotifications();
    }
    const nextTick = wx.nextTick || (fn => fn());
    nextTick(() => {
      if (this.pageRetired || !this.pageVisible || getApp().globalData.pendingMineSection !== section) return;
      getApp().globalData.pendingMineSection = null;
      wx.pageScrollTo({ selector: '#' + section, duration: 240 });
    });
  },

  onNotificationAction(e) {
    if (this.pageRetired || this.data.notificationActionBusy || this.data.notificationConfirming) return;
    const notification = this.data.notifications.find(item => item.id === e.currentTarget.dataset.id);
    if (!notification) return;
    const action = notificationAdvice(notification).action;
    if (action === 'uncertain') {
      wx.showModal({ title: '发送结果尚未确认', content: '这条消息可能已交给微信，但服务未取得明确结果。请先检查微信中的订阅消息；为避免重复打扰，不会自动重发这条旧提醒。新的补货变化仍按当前设置处理。', showCancel: false });
      return;
    }
    if (action === 'explain') {
      const explanations = { cooldown: '短时间内同一配置与门店的重复变化会合并控制提醒频率。本次未发送，之后的新变化仍按有效授权与提醒设置处理。', event_expired: '这次取货变化已经超过发送时限，为避免用旧信息打扰你，本次不发送。可到小哨页查看新的观测。', credit_released: '本次提醒已取消，预留的授权次数已恢复。这条旧提醒不会重新发送。',
        event_superseded: '发送前再次检查时，库存状态已变化，因此这条旧提醒未发送，未消耗提醒次数。可到小哨页查看新的观测。',
        event_unconfirmed: '发送前未能再次确认库存状态，因此本次未发送，未消耗提醒次数。后台恢复有效观测后，新的变化仍按当前设置处理。',
        event_invalid_time: '这条提醒的记录时间异常，无法确认信息是否及时，因此本次未发送，未消耗提醒次数。可到小哨页查看新的观测。' };
      wx.showModal({ title: '本次未发送原因', content: explanations[notification.reason], showCancel: false });
      return;
    }
    if (action === 'settings' || action === 'membership') {
      getApp().globalData.pendingMineSection = action === 'settings' ? 'reminder-settings' : 'membership-card';
      this.consumePendingSection();
      return;
    }
    if (['authorization', 'follow', 'service'].includes(action)) {
      getApp().globalData.pendingFollowFocus = { section: action === 'follow' ? 'follow-configurations' : 'reminder-health', partNumber: action === 'follow' ? notification.partNumber : null };
      wx.switchTab({ url: '/pages/follow/index' });
    }
  },

  async onToggleLedger() {
    if (this.pageRetired) return;
    const show = !this.data.showLedger;
    this.setData({ showLedger: show });
    if (!show) return;
    return this.loadLedger();
  },

  async loadLedger() {
    if (this.pageRetired) return;
    const session = this.pageSession || 0;
    const generation = (this.ledgerGeneration || 0) + 1;
    this.ledgerGeneration = generation;
    try {
      const data = await call('quota.ledger', { limit: 30 });
      if (!this.isCurrentSession(session) || generation !== this.ledgerGeneration) return;
      this.setData({ ledger: data.entries.map(e => ({ ...e, label: LEDGER_TEXT[e.type] || e.type, timeText: fmt.fmtDateTime(e.createdAt), deltaText: (e.delta > 0 ? '+' : '') + e.delta })) });
    } catch (error) {
      if (this.isCurrentSession(session) && generation === this.ledgerGeneration) showError(error);
    }
  },

  async saveSettings(patch) {
    if (this.pageRetired || this.data.savingSettings) return;
    const session = this.pageSession || 0;
    const account = this.orderAccount(), accountGeneration = this.orderAccountGeneration || 0;
    const samePage = () => this.isCurrentSession(session) && account === this.orderAccount()
      && accountGeneration === (this.orderAccountGeneration || 0);
    const current = () => {
      const cached = getApp().globalData.bootstrap;
      const owner = cached && cached.identity && cached.identity.userKey;
      return samePage() && (!owner || owner === account);
    };
    if (!current()) return;
    this.setData({ savingSettings: true });
    try {
      const data = await call('user.updateSettings', patch);
      if (!current()) return;
      const settings = data.settings;
      this.setData({ settings, ...this.presentDnd(settings) });
      if (this.accountSnapshot) this.accountSnapshot = { ...this.accountSnapshot, settings };
      this.refreshReadiness();
      if (!publishSettings(settings, account)) {
        // A separate action may have invalidated the cache during this write.
        // Restore verified identity without treating a read failure as a failed save.
        invalidateBootstrap();
        try {
          const boot = await getBootstrap({ force: true });
          if (current() && boot.identity && boot.identity.userKey === account && this.pageVisible !== false) {
            this.applyBoot(boot);
            this.setData({ refreshError: null });
          }
        } catch (error) {
          if (current() && this.pageVisible !== false) this.setData({ refreshError: '设置已保存，账户信息刷新失败，请下拉刷新后再补充提醒授权。' });
        }
      }
    } catch (error) {
      if (current()) {
        showError(error);
        await this.refresh({ quiet: true, force: true });
      }
    } finally {
      if (samePage()) this.setData({ savingSettings: false });
    }
  },

  onNotifyToggle(e) {
    this.saveSettings({ notifyEnabled: Boolean(e.detail.value) });
  },

  onDndToggle(e) {
    if (this.pageRetired || this.data.savingSettings || !this.data.settings) return;
    return this.saveDndPeriods(this.editableDndPeriods(this.data.settings.dnd), Boolean(e.detail.value));
  },

  editableDndPeriods(dnd) {
    const periods = dndPeriods(dnd);
    // A missing or malformed legacy value gets an editable default only.
    // No permission or enabled state is inferred until the user saves it.
    return periods.length ? periods : [{ startMinute: 1380, endMinute: 480 }];
  },
  presentDnd(settings) {
    const periods = this.editableDndPeriods(settings && settings.dnd);
    return { dndPeriods: periods.map((period, index) => ({ ...period, index, start: minuteToTime(period.startMinute), end: minuteToTime(period.endMinute), overnight: period.startMinute > period.endMinute, allDay: period.startMinute === period.endMinute })),
      dndSummary: dndSummary(settings && settings.dnd), dndStatus: dndStatus(settings && settings.dnd) };
  },
  saveDndPeriods(periods, enabled) {
    if (this.pageRetired || this.data.savingSettings || !this.data.settings) return;
    if (!validateDndPeriods(periods)) return toast('请选择有效的免打扰时段');
    return this.saveSettings({ dnd: { enabled: enabled === undefined ? Boolean(this.data.settings.dnd && this.data.settings.dnd.enabled) : enabled, periods, ...periods[0] } });
  },
  onDndStart(e) { return this.changeDndTime(e, 'startMinute'); },
  onDndEnd(e) { return this.changeDndTime(e, 'endMinute'); },
  changeDndTime(e, field) {
    if (this.pageRetired || this.data.savingSettings || !this.data.settings) return;
    const periods = this.editableDndPeriods(this.data.settings.dnd), index = Number(e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index || 0);
    if (!Number.isInteger(index) || !periods[index] || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.detail.value)) return;
    periods[index] = { ...periods[index], [field]: timeToMinute(e.detail.value) };
    return this.saveDndPeriods(periods);
  },
  onAddDndPeriod() {
    if (this.pageRetired || this.data.savingSettings || !this.data.settings) return;
    const periods = this.editableDndPeriods(this.data.settings.dnd);
    if (periods.length >= MAX_DND_PERIODS) return toast('最多设置 8 个时段');
    return this.saveDndPeriods([...periods, { startMinute: 720, endMinute: 780 }]);
  },
  onAddDndPreset(e) {
    if (this.pageRetired || this.data.savingSettings || !this.data.settings) return;
    const preset = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.preset;
    const period = preset === 'night' ? { startMinute: 1380, endMinute: 480 } : preset === 'lunch' ? { startMinute: 720, endMinute: 780 } : null;
    if (!period) return;
    const periods = this.editableDndPeriods(this.data.settings.dnd);
    if (periods.some(item => item.startMinute === period.startMinute && item.endMinute === period.endMinute)) return toast('这个时段已添加，可直接调整时间');
    if (periods.length >= MAX_DND_PERIODS) return toast('最多设置 8 个时段');
    return this.saveDndPeriods([...periods, period]);
  },
  onRemoveDndPeriod(e) {
    if (this.pageRetired || this.data.savingSettings || !this.data.settings) return;
    const periods = this.editableDndPeriods(this.data.settings.dnd), index = Number(e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index);
    if (periods.length <= 1 || !Number.isInteger(index) || !periods[index]) return;
    return this.saveDndPeriods(periods.filter((_, i) => i !== index));
  },
  refreshReadiness() {
    if (this.pageRetired || !this.data.boot) return;
    const boot = this.accountSnapshot || {}, subscription = this.data.subscription || {};
    const status = !this.data.boot.member ? '会员可开启持续提醒'
      : this.data.settings && !this.data.settings.notifyEnabled ? '提醒已关闭'
      : activeDnd(this.data.settings) ? '当前免打扰'
      : !subscription.templateCount ? '提醒服务待配置'
      : boot.notifications && (!boot.notifications.enabled || boot.notifications.deliveryReady !== true) ? '发送服务待恢复'
      : !boot.collector || !['running', 'idle'].includes(boot.collector.state) || boot.collector.observationStale ? '后台状态待确认'
      : !subscription.credits ? '到货暂无次数'
      : subscription.credits <= 2 ? '到货次数较少' : '到货授权充足';
    if (this.data.reminderCenterStatus !== status) this.setData({ reminderCenterStatus: status });
    const quietStatus = dndStatus(this.data.settings && this.data.settings.dnd);
    if (quietStatus !== this.data.dndStatus) this.setData({ dndStatus: quietStatus });
    this.scheduleDndClock();
  },
  stopDndClock() {
    if (this.dndClockTimer && typeof clearTimeout === 'function') clearTimeout(this.dndClockTimer);
    this.dndClockTimer = null;
  },
  scheduleDndClock() {
    if (!this.data.settings || !this.data.settings.dnd || !this.data.settings.dnd.enabled) { this.stopDndClock(); return; }
    if (this.pageRetired || this.pageVisible === false || this.dndClockTimer || typeof setTimeout !== 'function'
      || !this.data.settings || !this.data.settings.dnd || !this.data.settings.dnd.enabled) return;
    // Refresh the local status at a minute boundary; this never polls a service.
    this.dndClockTimer = setTimeout(() => {
      this.dndClockTimer = null;
      if (!this.pageRetired && this.pageVisible !== false) this.refreshReadiness();
    }, 60000 - Date.now() % 60000 + 20);
  },
  showMemberModal() {
    this.onCloseAuthorizationPanel();
    getApp().globalData.pendingMineSection = 'membership-card';
    this.consumePendingSection();
  },
  onReturnToTest() {
    const url = consumeTestReturnUrl();
    this.setData({ testReturnAvailable: false });
    if (url) wx.navigateTo({ url });
  },
  onHelp() {
    if (!this.pageRetired) wx.navigateTo({ url: '/pages/guide/index?section=prepare&from=mine' });
  },

  onOpenOrders() {
    if (this.pageRetired) return;
    this.setData({ showOrders: true }, () => {
      if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: '#membership-records', duration: 200 });
    });
    return this.loadOrders();
  },

  onDisclaimer() {
    wx.showModal({
      title: '免责声明',
      content: '果小哨仅汇总苹果官网公开的门店取货信息，不代表 Apple 官方，不保证信息的实时性与准确性；请以苹果官网或门店实际情况为准。本工具不参与任何交易。',
      showCancel: false,
    });
  },

  onPrivacy() {
    wx.showModal({
      title: '隐私说明',
      content: '果小哨仅使用微信提供的 OpenID 识别账号，不收集昵称、头像、手机号或位置信息。保存的数据包括：你的关注设置、查询与次数记录、订阅消息授权次数和提醒发送记录，仅用于提供本服务。你可以删除或清空个人提醒列表中的记录；这不会取消关注、撤回微信消息或删除库存历史。数据存储在腾讯云开发环境，不会向第三方提供。',
      showCancel: false,
    });
  },

  onToggleOrders() {
    const showOrders = !this.data.showOrders;
    this.setData({ showOrders });
    if (showOrders) return this.loadOrders();
  },

  onCopyId() {
    const id = this.data.boot.identity.userKey || this.data.boot.identity.openidMasked;
    wx.setClipboardData({ data: id, success: () => toast('已复制用户标识'), fail: () => toast('复制失败，请长按用户标识手动复制') });
  },

  onRetryLoad() {
    if (this.pageRetired) return;
    this.setData({ loadError: null });
    return this.refresh({ force: true });
  },

  /** Called by the tab bar when the phone reconnects. */
  onNetworkRestored() {
    if (this.pageRetired || this.pageVisible === false) return;
    if (this.data.loadError) return this.onRetryLoad();
    if (this.data.ready) return this.refresh({ quiet: true, force: true });
  },
});
