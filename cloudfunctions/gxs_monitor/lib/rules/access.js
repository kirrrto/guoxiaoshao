'use strict';
const { hasMemberAccess, hasAdminTestAccess, isMember, planSnapshot } = require('./membership');
const { isLiveRestricted, isHistoryRestricted } = require('./new-product');
const { resolveConfig, canAfford } = require('./quota');
const { ApiError } = require('../errors');
const { canQueryProduct } = require('./product-target');

// Older clients omit the ceiling. A supplied zero is a firm no-charge agreement.
function queryCostLimit(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new ApiError('invalid_payload', '查询费用无效。');
  return value;
}

/**
 * Decide whether a live query may run and what it costs.
 * Members query for free; free users spend one credit and cannot touch
 * restricted new products. The decision is made on the server only.
 */
function decideLiveQuery({ user, product, now, config }) {
  const cfg = resolveConfig(config && config.quota);
  if (!product) return { allowed: false, reason: 'unknown_product', cost: 0, member: false };
  if (!canQueryProduct(product)) return { allowed: false, reason: 'unsupported_product', cost: 0, member: false };
  if (hasMemberAccess(user, now, config)) return { allowed: true, reason: null, cost: 0, member: true };
  const restriction = isLiveRestricted(product, config && config.newProductWindows, now);
  if (restriction.restricted) {
    return { allowed: false, reason: 'new_product_restricted', cost: 0, member: false, restrictionEndsAt: restriction.endsAt };
  }
  const balance = (user && user.quota && user.quota.balance) || 0;
  if (!canAfford(balance, cfg.queryCost)) return { allowed: false, reason: 'insufficient_credits', cost: cfg.queryCost, member: false };
  return { allowed: true, reason: null, cost: cfg.queryCost, member: false };
}

function decideMarketQuery({ user, product, now, config }) {
  if (!product || !canQueryProduct(product)) return { allowed: false, reason: 'unsupported_product', cost: 0, member: false };
  if (hasAdminTestAccess(user, config)) return { allowed: true, reason: null, cost: 0, member: true };
  const member = isMember(user, now);
  const opensAt = Date.parse(product.freeQueryStartsAt);
  if (!Number.isFinite(opensAt) || now.getTime() < opensAt) {
    const tier = planSnapshot(user, now).planId;
    if (!['member_7d', 'member_30d', 'member_365d'].includes(tier)) return { allowed: false, reason: 'new_product_restricted',
      restrictionEndsAt: Number.isFinite(opensAt) ? new Date(opensAt).toISOString() : null, cost: 0, member };
  }
  if (member) return { allowed: true, reason: null, cost: 0, member };
  const allowed = canAfford(user?.quota?.balance || 0, 1);
  return { allowed, reason: allowed ? null : 'insufficient_credits', cost: 1, member: false };
}

function decideHistoryQuery({ user, product, requestedDayKey, now, config, alreadyCharged }) {
  const cfg = resolveConfig(config && config.quota);
  if (hasMemberAccess(user, now, config)) return { allowed: true, reason: null, cost: 0, member: true };
  if (product) {
    const restriction = isHistoryRestricted(product, config && config.newProductWindows, requestedDayKey, now);
    if (restriction.restricted) {
      return { allowed: false, reason: 'new_product_history_restricted', cost: 0, member: false, restrictionEndsAt: restriction.endsAt };
    }
  }
  if (alreadyCharged) return { allowed: true, reason: null, cost: 0, member: false, reused: true };
  const balance = (user && user.quota && user.quota.balance) || 0;
  if (!canAfford(balance, cfg.historyCost)) return { allowed: false, reason: 'insufficient_credits', cost: cfg.historyCost, member: false };
  return { allowed: true, reason: null, cost: cfg.historyCost, member: false };
}

module.exports = { queryCostLimit, decideLiveQuery, decideMarketQuery, decideHistoryQuery };
