'use strict';
const { ApiError } = require('../errors');
const { ensureUser } = require('./users');
const { encodeToken, decodeToken } = require('../notification-view');
const { isValidTemplateId } = require('../config');
const { isMember } = require('../rules/membership');

/**
 * Record the outcome of wx.requestSubscribeMessage. Each accepted one-time
 * template grants exactly one send and sends accumulate across requests; the
 * collector's notifier consumes them. Members only.
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
  // Restock reminders are a member benefit; the notifier also skips non-members when sending.
  if (!isMember(user, ctx.now)) throw new ApiError('membership_required', '到货提醒为会员专属，开通会员后可增加提醒次数');
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

module.exports = { recordSubscription, list, remove, clear };
