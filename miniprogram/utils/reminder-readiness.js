/** Personal readiness follows the configured sender templates and their separate credits. */
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
  const dnd = settings && settings.dnd;
  if (!dnd || !dnd.enabled || !Number.isInteger(dnd.startMinute) || !Number.isInteger(dnd.endMinute)) return false;
  const date = new Date(now + 8 * 3600000);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return dnd.startMinute === dnd.endMinute || (dnd.startMinute < dnd.endMinute
    ? minute >= dnd.startMinute && minute < dnd.endMinute
    : minute >= dnd.startMinute || minute < dnd.endMinute);
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
    ? `当前次数低于 ${RECOMMENDED_CREDITS} 次，可连点「增加提醒次数」累加，到货或断货时才不容易漏掉。`
    : `当前次数低于 ${RECOMMENDED_CREDITS} 次，可连点「增加提醒次数」累加，补货时才不容易漏掉。`;
}

function reminderReadiness({ boot, follows = [], followsLoaded = false, collector, delivery, settings = {}, subscription = {}, subscriptionPending = false }, now = Date.now()) {
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
    return state('membership', '关注与到货提醒为会员专属', '周卡可关注 3 个配置、每配置 3 家门店；月卡、年卡为 4 个配置、每配置 4 家门店，并可累加提醒次数；免费用户可用查询次数实时看货。可到「我的」开通会员。', 'membership', '查看会员');
  }
  if (!followsLoaded) return state('checking_follows', '正在确认你的关注', '读取完成后会检查是否有已开启的配置。', '', '', 'muted');
  if (!saved.length) return state('no_follows', '先给心仪配置留个哨', '还没有添加关注。选择具体型号、容量、颜色和门店后，才能参与自动检测。', 'add', '添加关注', 'muted');
  if (!active.length) return state('all_paused', '你的关注全部已暂停', '后台服务可能仍在运行，但当前没有你的配置参与检测。请在下方开启需要关注的配置。', 'follows', '查看并开启关注');
  if (!subscription.templateCount) return state('template_missing', '微信提醒暂未开放', '订阅消息模板尚未配置，暂不能授权或发送。已开启的关注会保留，无需反复开关或重复授权。', 'service', '查看服务状态');
  if (collector && collector.observationStale) return state('collector_observation_stale', '库存观测更新延迟', '后台连接仍在，但部分库存观测未及时更新，暂不能确认最新取货状态。关注和提醒次数会保留，等待服务恢复即可。', 'service', '查看服务状态');
  if (!collector || collector.state !== 'running') {
    if (collector && collector.state === 'idle') return state('collector_idle', '等待后台下一轮检测', '关注已保存，等待后台下一轮检测，无需重复操作。', 'refresh', '刷新检测状态');
    return state('collector_unready', '后台检测暂未就绪', '关注已开启时无需重复操作；后台恢复后才会自动检测补货。可查看具体服务状态。', 'service', '查看服务状态');
  }
  if (!delivery || delivery.cls !== 'ok') return state('delivery_unready', '正在检测，微信发送未就绪', '后台正在检测，消息发送服务尚未就绪，暂不能收到微信提醒。' + (subscriptionPending ? '已有授权记录待同步；同步失败可点击「重试同步」。' : subscription.credits ? `已记录的 ${subscription.credits} 次提醒会保留，服务就绪后使用。` : '可先点击下方「增加提醒次数」记录授权，服务就绪后才能发送。'), 'service', '查看服务状态');
  if (settings.notifyEnabled === false) return state('user_disabled', '你的消息提醒已关闭', '后台检测继续。请到「我的」开启接收补货提醒。', 'settings', '前往提醒设置');
  if (dndActive) return state('dnd', '当前处于免打扰时段', '后台检测继续，期间不发送提醒，也不会在时段结束后补发旧消息。可查看或调整免打扰时间。', 'settings', '查看免打扰设置');
  if (subscriptionPending && !subscription.credits) return state('subscription_pending', '授权记录等待同步', '微信已允许，等待同步为可用次数。同步失败可点击「重试同步」，不会重复申请授权。', 'subscribe', '增加提醒次数');
  if (subscription.soldoutEnabled) {
    const restock = subscription.credits || 0, soldout = subscription.soldoutCredits || 0;
    const boost = creditBoostTip(subscription);
    if (!restock && !soldout) return state('no_credit', '到货提醒暂无次数', `点击「增加提醒次数」，可只允许到货提醒；如需断货提醒，也可一并允许。每项允许各增加 1 次。${boost}`, 'subscribe', '增加提醒次数');
    if (restock && !soldout) return {
      ...state(restock <= LOW_CREDITS ? 'low_credit' : 'restock_ready', restock <= LOW_CREDITS ? `到货提醒只剩 ${restock} 次` : '到货提醒已就绪',
        `到货提醒还可发送 ${restock} 次。断货提醒为可选项，目前暂无次数；需要时可通过下方按钮授权，不影响到货提醒。${boost}`,
        'subscribe', '增加提醒次数', restock <= LOW_CREDITS ? 'warn' : 'ok'), ready: true,
    };
    if (!restock) return state('partial_credit', '到货提醒暂无次数', `断货提醒还可发送 ${soldout} 次；到货提醒暂无次数。点击下方按钮，可单独允许到货提醒。${boost}`, 'subscribe', '增加提醒次数');
    if (restock <= LOW_CREDITS || soldout <= LOW_CREDITS) {
      const title = restock <= LOW_CREDITS && soldout <= LOW_CREDITS ? '到货、断货提醒次数较少' : restock <= LOW_CREDITS ? `到货提醒只剩 ${restock} 次` : `断货提醒只剩 ${soldout} 次`;
      return { ...state('low_credit', title, `每条消息消耗对应类型的 1 次授权。可用下方同一个按钮补充，用完的类型将暂停发送。${boost}`, 'subscribe', '增加提醒次数'), ready: true };
    }
    return { ...state('ready', '到货、断货提醒已就绪', `确认到货或断货后，通过微信提醒你。每条消息消耗对应类型的 1 次授权。${boost}`, 'subscribe', '增加提醒次数', 'ok'), ready: true };
  }
  const boost = creditBoostTip(subscription);
  if (!subscription.credits) return state('no_credit', '还没有提醒次数', `每点一次「允许」增加 1 次到货提醒，可连续点击累加；每次补货提醒消耗 1 次。勾选「总是保持以上选择」后，点查询、刷新时会自动补充。${boost}`, 'subscribe', '增加提醒次数');
  if (subscription.credits <= LOW_CREDITS) return { ...state('low_credit', `提醒次数只剩 ${subscription.credits} 次`, `每次补货提醒消耗 1 次，用完后将收不到提醒。点下方按钮可连续累加。${boost}`, 'subscribe', '增加提醒次数'), ready: true };
  return { ...state('ready', '已准备接收补货提醒', `剩余 ${subscription.credits} 次提醒，每次补货提醒消耗 1 次。${boost}微信受理后，实际接收与声音仍遵循微信和手机设置。`, 'subscribe', '增加提醒次数', 'ok'), ready: true };
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
  if (['cooldown', 'event_expired', 'credit_released', 'event_superseded', 'event_unconfirmed', 'event_invalid_time'].includes(reason)) return { action: 'explain', actionLabel: '了解未发送原因' };
  return { action: 'service', actionLabel: '查看提醒体检' };
}

module.exports = { LOW_CREDITS, RECOMMENDED_CREDITS, creditBoostTip, restockSubscription, soldoutSubscription, activeDnd, canRemind, reminderReadiness, notificationAdvice };
