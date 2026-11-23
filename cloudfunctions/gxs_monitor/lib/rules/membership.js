'use strict';
const { toDate, addDays } = require('../time');
const { consumerAppid } = require('../connection');
const { settle } = require('./membership-entitlements');
const { GIFT_SOURCE, ANNUAL_PLAN, giftRecordId } = require('./owner-annual-gift');

/** Weekly/gifted memberships retain their original 3 configuration allowance. */
const LIMITS = Object.freeze({
  maxFollows: 3,
  maxStoresPerFollow: 3,
  defaultMemberDays: 30,
});
const ENHANCED_LIMITS = Object.freeze({ ...LIMITS, maxFollows: 4, maxStoresPerFollow: 4 });
const ANNUAL_LIMITS = Object.freeze({ ...ENHANCED_LIMITS, maxFollows: 5, maxStoresPerFollow: 5 });
const limitsForPlan = planId => planId === 'member_365d' ? ANNUAL_LIMITS : planId === 'member_30d' ? ENHANCED_LIMITS : LIMITS;

// The environment pins one consumer account. The runtime admin list controls
// its revocable test access without changing any payment or membership ledger.
function isBoundTestAccount(user) {
  const target = process.env.GXS_TEST_ADMIN_USER_KEY;
  return Boolean(target && user?.appid === consumerAppid && typeof user.openid === 'string'
    && user.openid.length > 0 && user._id === target && target === consumerAppid + ':' + user.openid);
}

function hasAdminTestAccess(user, config) {
  return isBoundTestAccount(user) && Array.isArray(config?.adminUserKeys) && config.adminUserKeys.includes(user._id);
}

function hasMemberAccess(user, now, config) {
  return isMember(user, now) || hasAdminTestAccess(user, config);
}

function planSnapshot(user, now) {
  if (!isMember(user, now)) return { planId: null, enhanced: false, enhancedExpiresAt: null, annualExpiresAt: null };
  const membership = settle(user.membership, toDate(now).toISOString());
  let cursor = Date.parse(membership.entitlements.settledAt), enhancedUntil = null, annualUntil = null, planId = null;
  for (const segment of membership.entitlements.segments) {
    cursor += segment.remainingMs;
    if (segment.source === 'trial_compensation' && !planId) planId = 'member_trial';
    const ownerGift = segment.source === GIFT_SOURCE && segment.planId === ANNUAL_PLAN && segment.orderId === giftRecordId(user._id);
    if (!ownerGift && !['virtual_payment', 'service_compensation'].includes(segment.source)) continue;
    if (segment.planId === 'member_7d' && (!planId || planId === 'member_trial')) planId = segment.planId;
    if (['member_30d', 'member_365d'].includes(segment.planId)) {
      enhancedUntil = cursor;
      if (segment.planId === 'member_365d') annualUntil = cursor;
      if (planId !== 'member_365d') planId = segment.planId;
    }
  }
  return { planId, enhanced: enhancedUntil !== null, enhancedExpiresAt: enhancedUntil === null ? null : new Date(enhancedUntil).toISOString(),
    annualExpiresAt: annualUntil === null ? null : new Date(annualUntil).toISOString() };
}

function memberLimits(user, now, config) {
  if (hasAdminTestAccess(user, config)) return ANNUAL_LIMITS;
  const limits = limitsForPlan(planSnapshot(user, now).planId);
  return isMember(user, now) ? limits : { ...limits, maxFollows: 0 };
}

// Regional watches are available to monthly/annual members and the designated test account.
function canWatchMarkets(user, now, config) {
  return hasAdminTestAccess(user, config) || planSnapshot(user, now).enhanced;
}

function accountLimits(user, now, config) {
  const limits = memberLimits(user, now, config);
  const base = Math.min(3, Math.max(1, Number(config && config.query && config.query.maxStores) || 3));
  return { ...limits, queryMaxStores: base < 3 ? base : limits.maxStoresPerFollow,
    // The annual expansion adds stores, not extra alternative-color choices.
    alternativeMaxColors: Math.min(4, limits.maxStoresPerFollow) };
}

/** Saved slots have stable ownership even if the user pauses or edits a follow. */
function followAllowance(user, follow, follows, now, config) {
  if (follow.market && follow.market !== 'CN' && !canWatchMarkets(user, now, config)) {
    return { limitPaused: false, marketPlanRequired: true, eligibleStoreNumbers: [] };
  }
  const limits = memberLimits(user, now, config);
  const sorted = (user && user._followPolicy || follows || []).filter(item => item.userKey === follow.userKey && item.status !== 'removed')
    .slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a._id.localeCompare(b._id));
  const position = sorted.findIndex(item => item._id === follow._id);
  const allowed = position >= 0 && position < limits.maxFollows;
  return { limitPaused: hasMemberAccess(user, now, config) && !allowed,
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

function membershipSnapshot(user, now, config) {
  if (hasAdminTestAccess(user, config)) return {
    active: true, isTester: true, expiresAt: null, remainingMs: 0, planId: null,
    enhanced: true, enhancedExpiresAt: null, annualExpiresAt: null, limits: ANNUAL_LIMITS,
  };
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
  if (follows.some(follow => (follow.market || 'CN') === (candidate.market || 'CN') && follow.partNumber === candidate.partNumber)) return { ok: false, reason: 'duplicate_part_number' };
  if (follows.length >= maxFollows) return { ok: false, reason: 'too_many_follows' };
  return { ok: true, reason: null, storeNumbers: stores };
}

/**
 * Free accounts receive query credits. The designated test account uses its
 * explicit access check and never receives a free reminder allowance.
 */
const FREE_REMINDER_FOLLOWS = 0;
function hasFreeReminder() {
  return false;
}

/** Eligibility to follow is separate from the customer's WeChat consent. */
function canUseReminders(user, now, config) {
  return hasMemberAccess(user, now, config);
}

/** Why an account cannot be alerted: follow and reminders require an active membership. */
function reminderBlockReason(user) {
  return user && user.membership && user.membership.expiresAt ? 'member_expired' : 'membership_required';
}

module.exports = { isBoundTestAccount, hasAdminTestAccess, hasMemberAccess, LIMITS, ENHANCED_LIMITS, ANNUAL_LIMITS, limitsForPlan, FREE_REMINDER_FOLLOWS, isMember, hasFreeReminder, canUseReminders, canWatchMarkets, reminderBlockReason, extendMembership, membershipSnapshot, membershipExpiresAt, validateFollowLimits, planSnapshot, memberLimits, accountLimits, followAllowance };
