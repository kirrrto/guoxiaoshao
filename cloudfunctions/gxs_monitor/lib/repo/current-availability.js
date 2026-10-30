'use strict';

const { createHash } = require('node:crypto');
const { COLLECTIONS: C } = require('../collections');
const { viewId, newView } = require('../notification-view');
const { targetKeyOf, NOTIFIABLE_TYPES } = require('../engine/events');

const RETRYABLE_SKIPS = new Set(['no_subscription_credit', 'notifications_disabled', 'template_changed',
  'user_disabled', 'dnd', 'follow_not_active', 'member_expired', 'plan_limit',
  'event_expired', 'event_unconfirmed', 'event_superseded', 'cooldown']);

function cooldownIdFor(userKey, targetKey) {
  return `notify_cooldown_${createHash('sha256').update(`${userKey}|${targetKey}`).digest('hex')}`;
}

function availabilitySince(task) {
  return NOTIFIABLE_TYPES.has(task.eventType) || task.eventType === 'current_available'
    ? task.availabilityEpisodeSince || task.stockStatusSince || task.detectedAt : null;
}

// Cooldown records outlive the short reminder-history retention window. Keep
// the same episode blocked after accepted/uncertain delivery, even at cooldown=0.
// Legacy records identify the same episode through their deterministic task ID.
function sameAvailability(cooldown, task) {
  const since = availabilitySince(task);
  if (!since || !cooldown || !(Date.parse(cooldown.lastReservedAt) > 0)) return false;
  if (cooldown.availabilitySince === since) return true;
  const prefix = `${task.userKey}|${targetKeyOf(task.storeNumber, task.partNumber)}|`;
  return [...NOTIFIABLE_TYPES, 'current_available'].some(type => cooldown.taskId === `${prefix}${type}|${since}`);
}

function currentAvailabilityMethods(run) {
  return {
    // Only the worker may call this with a currently eligible task. Sending
    // independently rechecks account settings, stock, membership and credits.
    queueCurrentAvailability: notification => run(async tx => {
      if (notification.eventType !== 'current_available' || notification.status !== 'pending') return false;
      const existing = await tx.get(C.notifications, notification._id);
      const retryable = existing && (existing.status === 'skipped' && RETRYABLE_SKIPS.has(existing.reason)
        || existing.status === 'failed' && (existing.reason === 'subscription_authorization_expired'
          || existing.retryable === true && Date.parse(existing.retryAfterAt) <= Date.parse(notification.createdAt)));
      if (existing && !retryable) return false;
      const key = targetKeyOf(notification.storeNumber, notification.partNumber);
      const cooldown = await tx.get(C.config, cooldownIdFor(notification.userKey, key));
      if (sameAvailability(cooldown, notification)) return false;
      // A normal transition alert has priority over its current-state fallback.
      // This also prevents a duplicate during rollout from an older worker.
      for (const since of new Set([notification.stockStatusSince, availabilitySince(notification)])) {
        for (const type of NOTIFIABLE_TYPES) {
          const original = await tx.get(C.notifications, `${notification.userKey}|${key}|${type}|${since}`);
          if (original && ['pending', 'sending', 'accepted', 'uncertain'].includes(original.status)) return false;
          if (original && original.status === 'failed' && original.retryable === true
            && Date.parse(original.retryAfterAt) > Date.parse(notification.createdAt)) return false;
        }
      }
      // A safe retry is a new visible receipt. Clearing an old failure must
      // not hide today's accepted message or make its deep link unreadable.
      const view = await tx.get(C.config, viewId(notification.userKey)) || newView(notification.userKey);
      view.lastSequence += 1;
      await tx.put(C.config, view);
      await tx.put(C.notifications, { ...notification, viewSequence: view.lastSequence,
        ...(existing ? { firstCreatedAt: existing.firstCreatedAt || existing.createdAt, attempts: existing.attempts || 0,
          replannedAt: notification.createdAt, previousReason: existing.reason } : {}) });
      return true;
    }),
  };
}

module.exports = { currentAvailabilityMethods, cooldownIdFor, availabilitySince, sameAvailability };
