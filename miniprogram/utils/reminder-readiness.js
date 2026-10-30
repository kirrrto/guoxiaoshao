/** Personal readiness follows the configured sender templates and their separate credits. */
const { activeDnd: activeDndSchedule } = require('./dnd');
// At or below this many sends, members are asked to top up before alerts stop.
const LOW_CREDITS = 2;
// Members should stockpile well above the floor so a busy restock window cannot exhaust the queue.
const RECOMMENDED_CREDITS = 10;
function restockSubscription(notifications = {}, subscriptions = {}) {
  const id = notifications.templateIds && notifications.templateIds.restock;
  const templateIds = typeof id === 'string' && id.trim() ? [id] : [];
  const rawCredits = templateIds.length && subscriptions && subscriptions[id] && Number(subscriptions[id].credits);
  return { templateIds, templateCount: templateIds.length, credits: Number.isFinite(rawCredits) ? Math.max(0, Math.floor(rawCredits)) : 0 };
}

/** The sold-out template, when configured. Members subscribe to it along with restock alerts. */
function soldoutSubscription(notifications = {}, subscriptions = {}) {
  const id = notifications.templateIds && notifications.templateIds.soldout;
  if (typeof id !== 'string' || !id.trim()) return { templateId: null, credits: 0 };
  const raw = subscriptions && subscriptions[id] && Number(subscriptions[id].credits);
  return { templateId: id, credits: Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0 };
}

function activeDnd(settings, now = Date.now()) {
  return activeDndSchedule(settings && settings.dnd, now);
}

/** Follow and WeChat reminders are member-only; free accounts only get query trial credits. */
function canRemind(boot) {
  return Boolean(boot && boot.member);
}

/**
 * Nudge members to stockpile sends. One restock wave can burn several
 * authorizations; below the recommended buffer the UI asks them to top up.
 */
function creditBoostTip(subscription = {}) {
  const restock = Math.max(0, Number(subscription.credits) || 0);
  const soldout = Math.max(0, Number(subscription.soldoutCredits) || 0);
  // A configured optional template does not mean the user chose to receive it.
  const soldoutEnabled = Boolean(subscription.soldoutEnabled && soldout > 0);
  if (restock >= RECOMMENDED_CREDITS && (!soldoutEnabled || soldout >= RECOMMENDED_CREDITS)) return '';
  return soldoutEnabled
    ? `当前次数低于 ${RECOMMENDED_CREDITS} 次，可连点「增加提醒次数」累加到货与断货次数。`
    : `当前次数低于 ${RECOMMENDED_CREDITS} 次，可连点「增加提醒次数」累加。`;
}

function reminderReadiness({ boot, follows = [], followsLoaded = false, collector, delivery, settings = {}, subscription = {}, subscriptionPending = false, consent = null }, now = Date.now()) {
  const saved = follows.filter(f => f.status !== 'removed');
  const active = saved.filter(f => f.status === 'active');
  const stores = new Set();
  for (const follow of active) for (const store of follow.stores || []) if (store.storeNumber && !store.limitPaused) stores.add(store.storeNumber);
  const dndActive = activeDnd(settings, now);
  const result = { activeCount: active.length, storeCount: stores.size, dndActive, ready: false };
  const state = (code, title, detail, action, actionLabel, tone = 'warn') => ({ ...result, code, title, detail, action, actionLabel, tone });
  if (!boot) return state('loading', '正在检查提醒条件', '正在读取账户与关注状态。', '', '', 'muted');
  if (!canRemind(boot)) {
    if (boot.expired) return state('membership', '会员已到期，提醒已停止', '关注配置和剩余提醒次数会保留，续费会员后可继续使用。', 'membership', '查看会员');
    return state('membership', '关注与到货提醒为会员专属', '周卡 3 个配置 × 3 家门店，月卡 4 × 4，年卡 5 × 5；会员可累加提醒次数，免费用户可用次数实时看货。', 'membership', '查看会员');
  }
  if (!followsLoaded) return state('checking_follows', '正在确认你的关注', '读取完成后会检查是否有已开启的配置。', '', '', 'muted');
  if (!saved.length) return state('no_follows', '先给心仪配置留个哨', '选择型号、容量、颜色与门店后即可开启自动检测。', 'add', '添加关注', 'muted');
  if (!active.length) return state('all_paused', '你的关注全部已暂停', '当前无配置参与检测，请在下方开启需关注的配置。', 'follows', '查看并开启关注');
  if (!subscription.templateCount) return state('template_missing', '微信提醒暂未开放', '消息模板尚未配置，已开启的关注会保留，无需重复操作。', 'service', '查看服务状态');
  // A stored credit is not the same as a live WeChat permission. When the
  // platform already locked 「不允许」, sends would be rejected — say so even
  // if earlier accepts still leave a positive balance.
  if (consent && consent.restockBlocked) {
    return state('consent_blocked', '微信提醒权限未开启',
      `微信已拒绝到货提醒；库存监测继续，但提醒暂无法接收。${subscription.credits ? `已记录的 ${subscription.credits} 次会保留。` : ''}请到微信设置改为接收，再返回点「补充提醒次数」。`,
      'open_settings', '前往微信设置', 'error');
  }
  if (collector && collector.observationStale) return state('collector_observation_stale', '库存观测更新延迟', '部分库存观测更新延迟，关注与提醒次数会保留，等待服务恢复即可。', 'service', '查看服务状态');
  if (!collector || collector.state !== 'running') {
    if (collector && collector.state === 'idle') return state('collector_idle', '等待后台下一轮检测', '关注已保存，等待后台下一轮检测，无需重复操作。', 'refresh', '刷新检测状态');
    return state('collector_unready', '后台检测暂未就绪', '关注已开启，后台恢复后自动继续检测。', 'service', '查看服务状态');
  }
  if (!delivery || delivery.cls !== 'ok') return state('delivery_unready', '正在检测，微信发送未就绪', '后台正在检测，消息发送服务尚未就绪，暂不能收到微信提醒。' + (subscriptionPending ? '已有授权记录待同步；同步失败可点击「重试同步」。' : subscription.credits ? `已记录的 ${subscription.credits} 次提醒会保留，服务就绪后使用。` : '可先点击下方「增加提醒次数」记录授权，服务就绪后才能发送。'), 'service', '查看服务状态');
  if (settings.notifyEnabled === false) return state('user_disabled', '你的消息提醒已关闭', '后台检测继续。请到「我的」开启接收补货提醒。', 'settings', '前往提醒设置');
  if (dndActive) return state('dnd', '当前处于免打扰时段', '后台检测继续，期间不发送提醒，结束后不补发旧消息。', 'settings', '查看免打扰设置');
  if (subscriptionPending && !subscription.credits) return state('subscription_pending', '授权记录等待同步', '微信已允许，等待同步为可用次数。同步失败可点击「重试同步」，不会重复申请授权。', 'subscribe', '增加提醒次数');
  const soldoutBlocked = Boolean(consent && consent.items && consent.items[1] && consent.items[1].blocked);
  const soldoutBlockNote = soldoutBlocked ? '断货提醒在微信设置中为已拒绝，补充次数时只会增加到货提醒；需要断货时请先到微信设置改为接收。' : '';
  if (subscription.soldoutEnabled) {
    const restock = subscription.credits || 0, soldout = subscription.soldoutCredits || 0;
    const boost = creditBoostTip(subscription);
    if (!restock && !soldout) return state('no_credit', '到货提醒暂无次数', `点「增加提醒次数」可允许到货提醒（断货可选），每项允许各 +1 次。${boost}${soldoutBlockNote ? ' ' + soldoutBlockNote : ''}`, 'subscribe', '增加提醒次数');
    if (restock && !soldout) return {
      ...state(restock <= LOW_CREDITS ? 'low_credit' : 'restock_ready', restock <= LOW_CREDITS ? `到货提醒只剩 ${restock} 次` : '到货提醒已就绪',
        `到货提醒还可发送 ${restock} 次。断货提醒为可选项，暂无次数；按需授权即可，不影响到货提醒。${boost}${soldoutBlockNote ? ' ' + soldoutBlockNote : ''}`,
        'subscribe', '增加提醒次数', restock <= LOW_CREDITS ? 'warn' : 'ok'), ready: true,
    };
    if (!restock) return state('partial_credit', '到货提醒暂无次数', `断货提醒还可发送 ${soldout} 次；到货提醒暂无次数。点击下方按钮，可单独允许到货提醒。${boost}${soldoutBlockNote ? ' ' + soldoutBlockNote : ''}`, 'subscribe', '增加提醒次数');
    if (restock <= LOW_CREDITS || soldout <= LOW_CREDITS) {
      const title = restock <= LOW_CREDITS && soldout <= LOW_CREDITS ? '到货、断货提醒次数较少' : restock <= LOW_CREDITS ? `到货提醒只剩 ${restock} 次` : `断货提醒只剩 ${soldout} 次`;
      return { ...state('low_credit', title, `每条消息消耗对应类型 1 次授权，用完暂停发送；可点下方按钮补充。${boost}${soldoutBlockNote ? ' ' + soldoutBlockNote : ''}`, 'subscribe', '增加提醒次数'), ready: true };
    }
    return { ...state('ready', soldoutBlocked ? '到货提醒已就绪' : '到货、断货提醒已就绪',
      `${soldoutBlocked ? `确认到货后通过微信提醒你。${soldoutBlockNote}` : '确认到货或断货后通过微信提醒你，每条消耗对应类型 1 次授权。'}${boost}`,
      soldoutBlocked ? 'open_settings' : 'subscribe', soldoutBlocked ? '前往微信设置' : '增加提醒次数', 'ok'), ready: true };
  }
  const boost = creditBoostTip(subscription);
  if (!subscription.credits) return state('no_credit', '还没有提醒次数', `每点一次「允许」增加 1 次到货提醒，可连点累加；勾选「总是保持以上选择」后查询或刷新时可自动补充。${boost}`, 'subscribe', '增加提醒次数');
  if (subscription.credits <= LOW_CREDITS) return { ...state('low_credit', `提醒次数只剩 ${subscription.credits} 次`, `每次补货提醒消耗 1 次，用完后将收不到提醒。点下方按钮可连续累加。${boost}`, 'subscribe', '增加提醒次数'), ready: true };
  return { ...state('ready', '已准备接收补货提醒', `剩余 ${subscription.credits} 次提醒，每次消耗 1 次。${boost}实际横幅与提示音随微信及手机设置。`, 'subscribe', '增加提醒次数', 'ok'), ready: true };
}

function notificationAdvice(notification) {
  if (notification.status === 'uncertain') return { action: 'uncertain', actionLabel: '查看结果说明' };
  if (!['failed', 'skipped'].includes(notification.status)) return { action: '', actionLabel: '' };
  const reason = notification.reason;
  if (reason === 'subscription_authorization_expired') return { action: 'authorization', actionLabel: '重新授权提醒' };
  if (reason === 'no_subscription_credit') return { action: 'authorization', actionLabel: '查看授权状态' };
  if (reason === 'user_disabled' || reason === 'dnd') return { action: 'settings', actionLabel: '查看提醒设置' };
  if (reason === 'follow_not_active') return { action: 'follow', actionLabel: '查看对应关注' };
  if (reason === 'member_expired' || reason === 'free_reminder_used') return { action: 'membership', actionLabel: '查看会员' };
  if (['already_notified', 'cooldown', 'event_expired', 'credit_released', 'event_superseded', 'event_unconfirmed', 'event_invalid_time'].includes(reason)) return { action: 'explain', actionLabel: '了解未发送原因' };
  return { action: 'service', actionLabel: '查看提醒体检' };
}

module.exports = { LOW_CREDITS, RECOMMENDED_CREDITS, creditBoostTip, restockSubscription, soldoutSubscription, activeDnd, canRemind, reminderReadiness, notificationAdvice };
