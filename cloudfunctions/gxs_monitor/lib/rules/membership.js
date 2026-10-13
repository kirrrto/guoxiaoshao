'use strict';
const { toDate, addDays } = require('../time');
const { settle } = require('./membership-entitlements');

/** Product limits for paid members: 3 SKUs × up to 3 stores each. */
const LIMITS = Object.freeze({
  maxFollows: 3,
  maxStoresPerFollow: 3,
  defaultMemberDays: 30,
});
const ENHANCED_LIMITS = Object.freeze({ ...LIMITS, maxFollows: 4, maxStoresPerFollow: 4 });

function planSnapshot(user, now) {
  if (!isMember(user, now)) return { planId: null, enhanced: false, enhancedExpiresAt: null };
  const membership = settle(user.membership, toDate(now).toISOString());
  let cursor = Date.parse(membership.entitlements.settledAt), enhancedUntil = null, planId = null;
  for (const segment of membership.entitlements.segments) {
    cursor += segment.remainingMs;
    if (segment.source !== 'virtual_payment') continue;
    if (segment.planId === 'member_7d' && !planId) planId = segment.planId;
    if (['member_30d', 'member_365d'].includes(segment.planId)) {
      enhancedUntil = cursor;
      if (planId !== 'member_365d') planId = segment.planId;
    }
  }
  return { planId, enhanced: enhancedUntil !== null, enhancedExpiresAt: enhancedUntil === null ? null : new Date(enhancedUntil).toISOString() };
}

function memberLimits(user, now) {
  const limits = planSnapshot(user, now).enhanced ? ENHANCED_LIMITS : LIMITS;
  return isMember(user, now) ? limits : { ...limits, maxFollows: 0 };
}

function accountLimits(user, now, config) {
  const limits = memberLimits(user, now);
  const base = Math.min(3, Math.max(1, Number(config && config.query && config.query.maxStores) || 3));
  return { ...limits, queryMaxStores: base < 3 ? base : limits.maxStoresPerFollow, alternativeMaxColors: limits.maxStoresPerFollow };
}

/** Saved slots have stable ownership even if the user pauses or edits a follow. */
function followAllowance(user, follow, follows, now) {
  const limits = memberLimits(user, now);
  const sorted = (user && user._followPolicy || follows || []).filter(item => item.userKey === follow.userKey && item.status !== 'removed')
    .slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a._id.localeCompare(b._id));
  const position = sorted.findIndex(item => item._id === follow._id);
  const allowed = position >= 0 && position < limits.maxFollows;
  return { limitPaused: isMember(user, now) && !allowed,
    eligibleStoreNumbers: allowed ? follow.storeNumbers.slice(0, limits.maxStoresPerFollow) : [] };
}

function membershipExpiresAt(user) {
  const value = user && user.membership && user.membership.expiresAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Membership is active strictly before its expiry instant. */
function isMember(user, now) {
  const expiresAt = membershipExpiresAt(user);
  return Boolean(expiresAt && expiresAt.getTime() > toDate(now).getTime());
}

/**
 * Renewals extend the remaining validity: an active member keeps the unused
 * days, an expired one starts from `now`. No auto-renew is implied.
 */
function extendMembership(user, days, now) {
  if (!Number.isInteger(days) || days <= 0) throw new TypeError('days must be a positive integer');
  const current = membershipExpiresAt(user);
  const base = current && current.getTime() > toDate(now).getTime() ? current : toDate(now);
  return addDays(base, days);
}

function membershipSnapshot(user, now) {
  const expiresAt = membershipExpiresAt(user);
  const active = isMember(user, now);
  return {
    active,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    remainingMs: active ? expiresAt.getTime() - toDate(now).getTime() : 0,
    ...planSnapshot(user, now),
    limits: memberLimits(user, now),
  };
}

/**
 * Validate a follow set against the member limits. `follows` are the user's
 * existing follows (excluding the one being edited), `candidate` is the new
 * or edited follow. Returns { ok, reason }.
 */
function validateFollowLimits(follows, candidate, maxFollows = LIMITS.maxFollows, maxStores = LIMITS.maxStoresPerFollow) {
  const stores = Array.isArray(candidate.storeNumbers) ? [...new Set(candidate.storeNumbers)] : [];
  if (stores.length === 0) return { ok: false, reason: 'no_stores' };
  if (stores.length > maxStores) return { ok: false, reason: 'too_many_stores' };
  if (!candidate.partNumber) return { ok: false, reason: 'no_part_number' };
  if (follows.some(follow => follow.partNumber === candidate.partNumber)) return { ok: false, reason: 'duplicate_part_number' };
  if (follows.length >= maxFollows) return { ok: false, reason: 'too_many_follows' };
  return { ok: true, reason: null, storeNumbers: stores };
}

/**
 * Follow and WeChat reminders are member-only. Free accounts only receive
 * query trial credits; there is no free follow or free restock alert.
 */
const FREE_REMINDER_FOLLOWS = 0;
function hasFreeReminder() {
  return false;
}

/** Only members may follow products or receive WeChat restock/sold-out alerts. */
function canUseReminders(user, now) {
  return isMember(user, now);
}

/** Why an account cannot be alerted: follow and reminders require an active membership. */
function reminderBlockReason(user) {
  return user && user.membership && user.membership.expiresAt ? 'member_expired' : 'membership_required';
}

module.exports = { LIMITS, ENHANCED_LIMITS, FREE_REMINDER_FOLLOWS, isMember, hasFreeReminder, canUseReminders, reminderBlockReason, extendMembership, membershipSnapshot, membershipExpiresAt, validateFollowLimits, planSnapshot, memberLimits, accountLimits, followAllowance };
