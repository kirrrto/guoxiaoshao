'use strict';
const { ApiError } = require('../errors');
const { ensureUser } = require('./users');
const { encodeToken, decodeToken } = require('../notification-view');
const { isValidTemplateId } = require('../config');
const { canUseReminders, isMember } = require('../rules/membership');
const { isLiveRestricted } = require('../rules/new-product');
const { targetKeyOf } = require('../engine/events');
const { RETENTION_DAYS } = require('../engine/retention');
const follows = require('./follows');

const FEEDBACK = ['bought', 'missed', 'skipped'];

/**
 * Record the outcome of wx.requestSubscribeMessage. Each accepted one-time
 * template grants exactly one send and sends accumulate across requests; the
 * collector's notifier consumes them. Members, and accounts with their one free
 * alert unused, may record grants.
 */
async function recordSubscription(ctx, payload) {
  const user = await ensureUser(ctx);
  const results = payload && payload.results && typeof payload.results === 'object' ? payload.results : null;
  if (!results || Array.isArray(results)) throw new ApiError('invalid_payload', 'results 需为模板ID→结果 映射');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(payload.requestId || '')) throw new ApiError('invalid_request_id', '授权请求需要有效 requestId');
  const templateIds = [...new Set(Object.values(ctx.config.notifications.templateIds || {}).filter(isValidTemplateId))];
  const entries = Object.entries(results);
  if (!entries.length || entries.length > 3 || entries.some(([id, result]) => !templateIds.includes(id) || !['accept', 'reject', 'ban'].includes(result))) {
    throw new ApiError('invalid_subscription_result', '只接受当前配置模板的 accept、reject 或 ban 结果');
  }
  // Reminders are for members and for an account's one free alert; the notifier enforces the same rule.
  if (!canUseReminders(user, ctx.now)) throw new ApiError('membership_required', '免费体验提醒已用完，开通会员后可继续接收到货提醒');
  return ctx.repo.recordSubscriptionGrant({ userKey: user._id, requestId: payload.requestId, templateIds, results, now: ctx.nowIso });
}

async function list(ctx, payload) {
  const user = await ensureUser(ctx);
  const view = await ctx.repo.getNotificationView(user._id);
  const cursor = payload.cursor ? decodeToken(payload.cursor, 'cursor', view, ctx.nowIso) : null;
  // The atomic view sequence defines the modern snapshot. Request time only
  // bounds legacy tasks without a sequence, matching the two clear watermarks.
  const snapshot = cursor || { at: ctx.nowIso, sequence: view.lastSequence };
  const limit = Math.min(100, Math.max(1, Math.floor(Number(payload.limit) || 20)));
  const { items, hasMore } = await ctx.repo.listVisibleNotifications({ userKey: user._id, view, snapshot, cursor, limit });
  const last = items[items.length - 1];
  return {
    notifications: items.map(n => ({ id: n._id, status: n.status, reason: n.reason || null, eventType: n.eventType, partNumber: n.partNumber, storeNumber: n.storeNumber, storeName: n.storeName || null, productTitle: n.productTitle || null, createdAt: n.createdAt, sentAt: n.sentAt || null })),
    nextCursor: hasMore && last ? encodeToken('cursor', { at: snapshot.at, sequence: snapshot.sequence, createdAt: last.createdAt, id: last._id }, view) : null,
    hasMore,
    clearBefore: encodeToken('clear', { at: snapshot.at, sequence: snapshot.sequence }, view),
  };
}

async function remove(ctx, payload) {
  const user = await ensureUser(ctx);
  if (typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 1024) throw new ApiError('invalid_notification_id', '请选择有效的提醒');
  return ctx.repo.hideNotification({ userKey: user._id, id: payload.id, nowIso: ctx.nowIso });
}

async function clear(ctx, payload) {
  const user = await ensureUser(ctx);
  return ctx.repo.clearNotificationView({ userKey: user._id, before: payload.before, nowIso: ctx.nowIso });
}

/** Task IDs embed the caller's account, so only the caller's own alert can be read. */
async function ownAlert(ctx, payload) {
  const user = await ensureUser(ctx);
  const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
  if (!eventId || eventId.length > 256) throw new ApiError('invalid_notification_id', '请选择有效的提醒');
  const task = await ctx.repo.getNotification(`${user._id}|${eventId}`);
  if (!task || task.userKey !== user._id || task.userHiddenAt) throw new ApiError('notification_not_found', `这条提醒已超过 ${RETENTION_DAYS} 天或已删除`);
  return { user, task };
}

/** The alert a WeChat message opens, with the target's current observation. */
async function detail(ctx, payload) {
  const { user, task } = await ownAlert(ctx, payload);
  const [latest, product, follow] = await Promise.all([
    ctx.repo.getLatest([targetKeyOf(task.storeNumber, task.partNumber)]),
    ctx.repo.getProduct(task.partNumber),
    task.followId ? ctx.repo.getFollow(task.followId) : null,
  ]);
  const restricted = !isMember(user, ctx.now) && isLiveRestricted(product || { partNumber: task.partNumber }, ctx.config.newProductWindows, ctx.now).restricted;
  return {
    notification: { eventId: task.eventId, status: task.status, eventType: task.eventType, partNumber: task.partNumber, storeNumber: task.storeNumber,
      storeName: task.storeName || null, productTitle: product ? product.title : task.productTitle || task.partNumber,
      detectedAt: task.detectedAt, sentAt: task.sentAt || null, feedback: task.feedback ? task.feedback.outcome : null },
    latest: { restricted, ...follows.presentLatest(latest[0] || null, ctx, restricted) },
    follow: follow && follow.userKey === user._id && follow.status !== 'removed' ? { followId: follow._id, status: follow.status } : null,
  };
}

/** Did the alert help? "bought" also pauses the follow so no more alerts are spent on it. */
async function feedback(ctx, payload) {
  const { user, task } = await ownAlert(ctx, payload);
  if (!FEEDBACK.includes(payload.outcome)) throw new ApiError('invalid_feedback', '请选择有效的反馈');
  await ctx.repo.updateNotification(task._id, { feedback: { outcome: payload.outcome, at: ctx.nowIso } });
  const follow = payload.outcome === 'bought' && task.followId ? await ctx.repo.getFollow(task.followId) : null;
  const pause = Boolean(follow && follow.userKey === user._id && follow.status === 'active');
  if (pause) await follows.pause(ctx, { followId: follow._id });
  return { outcome: payload.outcome, paused: pause };
}

module.exports = { recordSubscription, list, remove, clear, detail, feedback };
