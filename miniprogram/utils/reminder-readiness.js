/** Personal readiness uses the same restock template as the server sender. */
// At or below this many sends, members are asked to top up before alerts stop.
const LOW_CREDITS = 2;
function restockSubscription(notifications = {}, subscriptions = {}) {
  const id = notifications.templateIds && notifications.templateIds.restock;
  const templateIds = typeof id === 'string' && id.trim() ? [id] : [];
  const rawCredits = templateIds.length && subscriptions && subscriptions[id] && Number(subscriptions[id].credits);
  return { templateIds, templateCount: templateIds.length, credits: Number.isFinite(rawCredits) ? Math.max(0, Math.floor(rawCredits)) : 0 };
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

function reminderReadiness({ boot, follows = [], followsLoaded = false, collector, delivery, settings = {}, subscription = {}, subscriptionPending = false }, now = Date.now()) {
  const saved = follows.filter(f => f.status !== 'removed');
  const active = saved.filter(f => f.status === 'active');
  const stores = new Set();
  for (const follow of active) for (const store of follow.stores || []) if (store.storeNumber) stores.add(store.storeNumber);
  const dndActive = activeDnd(settings, now);
  const result = { activeCount: active.length, storeCount: stores.size, dndActive, ready: false };
  const state = (code, title, detail, action, actionLabel, tone = 'warn') => ({ ...result, code, title, detail, action, actionLabel, tone });
  if (!boot) return state('loading', '正在检查提醒条件', '正在读取账户与关注状态。', '', '', 'muted');
  if (!boot.member) return state('membership', boot.expired ? '会员已到期，提醒已停止' : '关注与到货提醒为会员专属', boot.expired ? '关注配置和剩余提醒次数会保留，续费会员后可继续使用。' : '会员可关注 3 个具体配置，每个配置最多 3 家门店，并可累加到货提醒次数；可到「我的」开通。', 'membership', '查看会员');
  if (!followsLoaded) return state('checking_follows', '正在确认你的关注', '读取完成后会检查是否有已开启的配置。', '', '', 'muted');
  if (!saved.length) return state('no_follows', '先给心仪配置留个哨', '还没有添加关注。选择具体型号、容量、颜色和门店后，才能参与自动检测。', 'add', '添加关注', 'muted');
  if (!active.length) return state('all_paused', '你的关注全部已暂停', '后台服务可能仍在运行，但当前没有你的配置参与检测。请在下方开启需要关注的配置。', 'follows', '查看并开启关注');
  if (!subscription.templateCount) return state('template_missing', '微信提醒暂未开放', '订阅消息模板尚未配置，暂不能授权或发送。已开启的关注会保留，无需反复开关或重复授权。', 'service', '查看服务状态');
  if (!collector || collector.state !== 'running') {
    if (collector && collector.state === 'idle') return state('collector_idle', '等待后台下一轮检测', '关注已保存，等待后台下一轮检测，无需重复操作。', 'refresh', '刷新检测状态');
    return state('collector_unready', '后台检测暂未就绪', '关注已开启时无需重复操作；后台恢复后才会自动检测补货。可查看具体服务状态。', 'service', '查看服务状态');
  }
  if (!delivery || delivery.cls !== 'ok') return state('delivery_unready', '正在检测，微信发送未就绪', '后台正在检测，消息发送服务尚未就绪，暂不能收到微信提醒。' + (subscriptionPending ? '已有授权记录待同步，可点击下方「同步授权」。' : subscription.credits ? `已记录的 ${subscription.credits} 次提醒会保留，服务就绪后使用。` : '可先点击下方「增加提醒次数」记录授权，服务就绪后才能发送。'), 'service', '查看服务状态');
  if (settings.notifyEnabled === false) return state('user_disabled', '你的消息提醒已关闭', '后台检测继续。请到「我的」开启接收补货提醒。', 'settings', '前往提醒设置');
  if (dndActive) return state('dnd', '当前处于免打扰时段', '后台检测继续，期间不发送提醒，也不会在时段结束后补发旧消息。可查看或调整免打扰时间。', 'settings', '查看免打扰设置');
  if (subscriptionPending) return state('subscription_pending', '授权记录等待同步', '上次微信授权的记录尚未确认。同步已有记录即可，无需再次向微信授权。', 'subscribe', '同步授权记录');
  if (!subscription.credits) return state('no_credit', '还没有提醒次数', '每点一次「允许」增加 1 次到货提醒，可连续点击累加；每次补货提醒消耗 1 次。勾选「总是保持以上选择」后，点查询、刷新时会自动补充。', 'subscribe', '增加提醒次数');
  if (subscription.credits <= LOW_CREDITS) return { ...state('low_credit', `提醒次数只剩 ${subscription.credits} 次`, '每次补货提醒消耗 1 次，用完后将收不到提醒。点下方按钮可连续累加。', 'subscribe', '增加提醒次数'), ready: true };
  return { ...state('ready', '已准备接收补货提醒', `剩余 ${subscription.credits} 次提醒，每次补货提醒消耗 1 次。微信受理后，实际接收与声音仍遵循微信和手机设置。`, 'subscribe', '增加提醒次数', 'ok'), ready: true };
}

function notificationAdvice(notification) {
  if (notification.status === 'uncertain') return { action: 'uncertain', actionLabel: '查看结果说明' };
  if (!['failed', 'skipped'].includes(notification.status)) return { action: '', actionLabel: '' };
  const reason = notification.reason;
  if (reason === 'subscription_authorization_expired') return { action: 'authorization', actionLabel: '重新授权提醒' };
  if (reason === 'no_subscription_credit') return { action: 'authorization', actionLabel: '查看授权状态' };
  if (reason === 'user_disabled' || reason === 'dnd') return { action: 'settings', actionLabel: '查看提醒设置' };
  if (reason === 'follow_not_active') return { action: 'follow', actionLabel: '查看对应关注' };
  if (reason === 'member_expired') return { action: 'membership', actionLabel: '查看会员' };
  if (reason === 'cooldown' || reason === 'event_expired' || reason === 'credit_released') return { action: 'explain', actionLabel: '了解未发送原因' };
  return { action: 'service', actionLabel: '查看提醒体检' };
}

module.exports = { LOW_CREDITS, restockSubscription, activeDnd, reminderReadiness, notificationAdvice };
