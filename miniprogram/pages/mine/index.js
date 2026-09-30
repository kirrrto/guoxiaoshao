const { call, showError, toast, newId } = require('../../utils/api');
const { getBootstrap, invalidateBootstrap, invalidateFollows, publishQuota, subscribeQuota } = require('../../utils/store');
const { topUpReminderCredit } = require('../../utils/reminder-credits');
const { confirmTap } = require('../../utils/haptic');
const { VERSION } = require('../../config/version');
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
const { paymentAvailability, createPaymentController, purchaseNotice } = require('../../utils/member-payment');

const LEDGER_TEXT = {
  signin_reward: '每日签到',
  task_reward: '体验任务',
  query_debit: '实时查询',
  query_refund: '查询次数返还',
  history_debit: '查看历史',
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
  user_missing: '账号信息暂时无法确认',
  consumer_appid_mismatch: '当前账号暂时无法接收提醒',
  openid_missing: '账号信息暂时无法确认',
  event_expired: '补货信息已过时，本次未发送',
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
  return { ...order, sourceLabel, amountText: order.amountFen > 0 ? fmt.fen(order.amountFen) : '',
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
  data: {
    ready: false,
    loadError: null,
    versionLabel: versionLabel(),
    boot: null,
    membership: null,
    quota: null,
    tasks: [],
    settings: null,
    dndStart: '23:00',
    dndEnd: '08:00',
    showLedger: false,
    ledger: [],
    orders: [],
    showOrders: false,
    showMembershipRules: false,
    showQuotaDetails: false,
    showReminderSettings: false,
    showNotifications: false,
    ordersLoading: false,
    ordersError: null,
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
    paymentCanRetry: false,
    paymentMessage: '',
    paymentError: '',
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
    this.setTabBarOverlay(this.data.redemptionOpen);
    this.pageVisible = true;
    this.consumePendingSection();
    if (this.data.ready) await this.refresh({ quiet: true });
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
    this.pageVisible = false;
    if (this.data.redemptionOpen) {
      this.setData({ redemptionOpen: false });
      this.setTabBarOverlay(false);
    }
    if (this.paymentController) this.paymentController.hide();
  },

  retirePage() {
    this.setTabBarOverlay(false);
    this.pageRetired = true;
    this.pageVisible = false;
    if (this.paymentController) this.paymentController.dispose();
    this.ledgerGeneration = (this.ledgerGeneration || 0) + 1;
    if (this.unsubscribeQuota) { this.unsubscribeQuota(); this.unsubscribeQuota = null; }
    this.pageSession = (this.pageSession || 0) + 1;
    this.accountGeneration = (this.accountGeneration || 0) + 1;
    this.ordersGeneration = (this.ordersGeneration || 0) + 1;
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
      this.setData({ ready: true, loadError: null, refreshError: null });
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

  async loadOrders({ force = false } = {}) {
    if (this.pageRetired) return;
    if (!force && (this.data.ordersLoading || (this.ordersLoadedAt && Date.now() - this.ordersLoadedAt < SECONDARY_CACHE_MS))) return;
    const generation = (this.ordersGeneration || 0) + 1;
    this.ordersGeneration = generation;
    this.setData({ ordersLoading: true, ordersError: null });
    try {
      const data = await call('member.status');
      if (this.pageRetired || generation !== this.ordersGeneration) return;
      this.setData({
        orders: data.orders.map(presentOrder),
      });
      this.ordersLoadedAt = Date.now();
    } catch (e) { if (!this.pageRetired && generation === this.ordersGeneration) this.setData({ ordersError: '会员记录暂时加载失败，请重试。' }); }
    finally { if (!this.pageRetired && generation === this.ordersGeneration) this.setData({ ordersLoading: false }); }
  },

  applyBoot(boot) {
    const membership = boot.membership;
    const settings = boot.settings || { dnd: { enabled: false, startMinute: 23 * 60, endMinute: 8 * 60 }, notifyEnabled: true };
    const availability = paymentAvailability(boot.memberProduct, wx);
    this.setData({
      boot: {
        identity: boot.identity,
        memberProduct: boot.memberProduct,
        priceText: fmt.fen(boot.memberProduct.priceFen),
        collector: { ...boot.collector, ...fmt.collectorMeta(boot.collector.state) },
        followCount: boot.followCount,
        freeReminder: !membership.active && boot.freeReminder === true,
        limits: boot.limits,
        paymentReady: availability.ready,
        paymentReason: availability.reason,
        purchaseNotice: purchaseNotice(boot.memberProduct),
      },
      membership: presentMembership(membership),
      quota: boot.quota,
      tasks: presentTasks(boot.tasks, boot.quota),
      settings,
      dndStart: minuteToTime(settings.dnd.startMinute),
      dndEnd: minuteToTime(settings.dnd.endMinute),
    });
    this.ensurePaymentController().sync(boot.identity, boot.memberProduct);
  },

  ensurePaymentController() {
    if (!this.paymentController) {
      this.paymentController = createPaymentController({ wx, call, makeId: typeof newId === 'function' ? () => newId('member') : undefined,
      onUpdate: patch => { if (!this.pageRetired) this.setData(patch); },
      onResolved: async ({ membership }) => {
        if (this.pageRetired) return;
        this.accountGeneration = (this.accountGeneration || 0) + 1;
        this.ordersGeneration = (this.ordersGeneration || 0) + 1;
        this.refreshing = null;
        invalidateBootstrap(); invalidateFollows(); this.ordersLoadedAt = 0;
        this.setData({ membership: presentMembership(membership), showOrders: true });
        this.resumeMemberFollow(membership);
        await this.loadOrders({ force: true });
      },
      });
      if (this.pageVisible) this.paymentController.show();
    }
    return this.paymentController;
  },

  async onBuyMembership() {
    if (this.pageRetired || this.data.redeeming || !this.data.ready || !this.data.boot || !this.data.boot.paymentReady) return;
    const notice = this.data.boot.purchaseNotice;
    const intent = typeof getApp === 'function' ? getApp().globalData.pendingMemberFollow : null;
    const confirmed = await new Promise(resolve => {
      if (typeof wx.showModal !== 'function') { resolve(false); return; }
      wx.showModal({
        title: '购买须知',
        content: `${notice}${intent ? '\n\n开通后继续为你关注：' + intent.title : ''}\n\n确认即表示已阅读并同意上述说明。`,
        confirmText: '同意购买',
        cancelText: '取消',
        success: result => resolve(Boolean(result.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed || this.pageRetired || this.data.redeeming) return;
    return this.ensurePaymentController().buy();
  },

  onCheckPayment() {
    if (this.pageRetired || this.data.redeeming) return;
    return this.ensurePaymentController().check();
  },

  async onAbandonPayment() {
    if (this.pageRetired || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking) return;
    const confirmed = await new Promise(resolve => {
      if (typeof wx.showModal !== 'function') { resolve(false); return; }
      wx.showModal({
        title: '放弃这笔订单',
        content: '放弃前会先向微信核对一次：已付款会直接开通会员，确认没有付款才会放弃，之后可以重新购买。',
        confirmText: '确认放弃',
        cancelText: '再等等',
        success: result => resolve(Boolean(result.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed || this.pageRetired || this.data.redeeming) return;
    return this.ensurePaymentController().abandon();
  },

  noop() {},

  onOpenRedemption() {
    if (this.pageRetired || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking) return;
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
    if (this.pageRetired || this.data.redeeming || this.data.paymentBusy || this.data.paymentChecking) return;
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
    if (typeof getApp !== 'function') return;
    const app = getApp(), intent = app.globalData.pendingMemberFollow;
    if (!intent || !membership || !membership.active || this.pageRetired) return;
    app.globalData.pendingMemberFollow = null;
    wx.showModal({
      title: '会员已开通',
      content: `继续关注「${intent.title}」？可在关注页确认门店后保存。`,
      confirmText: '去关注',
      cancelText: '稍后',
      success: r => {
        if (!r.confirm) return;
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
      if (publishQuota(data.quota) !== false) this.setData({ quota: data.quota });
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
    if (!this.pageRetired) this.setData({ showMembershipRules: !this.data.showMembershipRules });
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
    if (!['reminder-settings', 'membership-card', 'quota-card', 'notification-records'].includes(section)) return;
    if (section === 'reminder-settings') this.setData({ showReminderSettings: true });
    if (section === 'membership-card') this.setData({ showMembershipRules: true });
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
      const explanations = { cooldown: '短时间内同一配置与门店的重复变化会合并控制提醒频率。本次未发送，之后的新变化仍按有效授权与提醒设置处理。', event_expired: '这次取货变化已经超过发送时限，为避免用旧信息打扰你，本次不发送。可到小哨页查看新的观测。', credit_released: '本次提醒已取消，预留的授权次数已恢复。这条旧提醒不会重新发送。' };
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
    this.setData({ savingSettings: true });
    try {
      const data = await call('user.updateSettings', patch);
      if (!this.isCurrentSession(session)) return;
      const settings = data.settings;
      this.setData({ settings, dndStart: minuteToTime(settings.dnd.startMinute), dndEnd: minuteToTime(settings.dnd.endMinute) });
      invalidateBootstrap();
    } catch (error) {
      if (this.isCurrentSession(session)) {
        showError(error);
        await this.refresh({ quiet: true, force: true });
      }
    } finally {
      if (this.isCurrentSession(session)) this.setData({ savingSettings: false });
    }
  },

  onNotifyToggle(e) {
    this.saveSettings({ notifyEnabled: Boolean(e.detail.value) });
  },

  onDndToggle(e) {
    const dnd = this.data.settings.dnd;
    this.saveSettings({ dnd: { ...dnd, enabled: Boolean(e.detail.value) } });
  },

  onDndStart(e) {
    const dnd = this.data.settings.dnd;
    this.saveSettings({ dnd: { ...dnd, startMinute: timeToMinute(e.detail.value) } });
  },

  onDndEnd(e) {
    const dnd = this.data.settings.dnd;
    this.saveSettings({ dnd: { ...dnd, endMinute: timeToMinute(e.detail.value) } });
  },

  onHelp() {
    wx.showModal({
      title: '使用说明',
      content: `1. 查询：选择具体配置与门店，免费查询消耗 ${this.data.quota.queryCost} 次，接口失败按服务端规则返还。\n2. 次数：每日签到和体验任务可获取次数，每日最多 ${this.data.quota.dailyGrantCap} 次，累计上限 ${this.data.quota.balanceCap} 次。\n3. 会员：查询不扣次数，可关注 3 个具体配置，每配置最多 3 家门店；颜色或容量不同分别占用名额。该产品为一次性虚拟服务，一经售出不予退款。\n4. 提醒：新用户可免费关注 1 个配置并收到 1 条到货提醒，之后为会员功能。提醒需要授权微信订阅消息，每次「允许」增加 1 次，开通会员不等于无限接收提醒。\n5. 新品：受限新品开售 30 天内，免费用户不可实时查询，只能看昨天及更早历史。`,
      showCancel: false,
    });
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
    this.setData({ loadError: null });
    this.refresh();
  },

  /** Called by the tab bar when the phone reconnects. */
  onNetworkRestored() {
    if (this.data.loadError) return this.onRetryLoad();
    if (this.data.ready) this.refresh({ quiet: true, force: true });
  },
});
