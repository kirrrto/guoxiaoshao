'use strict';
const { isMember } = require('./membership');
const { isLiveRestricted, isHistoryRestricted } = require('./new-product');
const { resolveConfig, canAfford } = require('./quota');

/**
 * Decide whether a live query may run and what it costs.
 * Members query for free; free users spend one credit and cannot touch
 * restricted new products. The decision is made on the server only.
 */
function decideLiveQuery({ user, product, now, config }) {
  const cfg = resolveConfig(config && config.quota);
  if (!product) return { allowed: false, reason: 'unknown_product', cost: 0, member: false };
  if (product.supported === false) return { allowed: false, reason: 'unsupported_product', cost: 0, member: false };
  if (isMember(user, now)) return { allowed: true, reason: null, cost: 0, member: true };
  const restriction = isLiveRestricted(product, config && config.newProductWindows, now);
  if (restriction.restricted) {
    return { allowed: false, reason: 'new_product_restricted', cost: 0, member: false, restrictionEndsAt: restriction.endsAt };
  }
  const balance = (user && user.quota && user.quota.balance) || 0;
  if (!canAfford(balance, cfg.queryCost)) return { allowed: false, reason: 'insufficient_credits', cost: cfg.queryCost, member: false };
  return { allowed: true, reason: null, cost: cfg.queryCost, member: false };
}

function decideHistoryQuery({ user, product, requestedDayKey, now, config, alreadyCharged }) {
  const cfg = resolveConfig(config && config.quota);
  if (isMember(user, now)) return { allowed: true, reason: null, cost: 0, member: true };
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

module.exports = { decideLiveQuery, decideHistoryQuery };
