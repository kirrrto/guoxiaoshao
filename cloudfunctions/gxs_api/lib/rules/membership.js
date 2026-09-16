'use strict';
const { toDate, addDays } = require('../time');

/** Product limits for paid members: 3 SKUs × up to 3 stores each. */
const LIMITS = Object.freeze({
  maxFollows: 3,
  maxStoresPerFollow: 3,
  defaultMemberDays: 30,
});

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
    limits: LIMITS,
  };
}

/**
 * Validate a follow set against the member limits. `follows` are the user's
 * existing follows (excluding the one being edited), `candidate` is the new
 * or edited follow. Returns { ok, reason }.
 */
function validateFollowLimits(follows, candidate) {
  const stores = Array.isArray(candidate.storeNumbers) ? [...new Set(candidate.storeNumbers)] : [];
  if (stores.length === 0) return { ok: false, reason: 'no_stores' };
  if (stores.length > LIMITS.maxStoresPerFollow) return { ok: false, reason: 'too_many_stores' };
  if (!candidate.partNumber) return { ok: false, reason: 'no_part_number' };
  if (follows.some(follow => follow.partNumber === candidate.partNumber)) return { ok: false, reason: 'duplicate_part_number' };
  if (follows.length >= LIMITS.maxFollows) return { ok: false, reason: 'too_many_follows' };
  return { ok: true, reason: null, storeNumbers: stores };
}

module.exports = { LIMITS, isMember, extendMembership, membershipSnapshot, membershipExpiresAt, validateFollowLimits };
