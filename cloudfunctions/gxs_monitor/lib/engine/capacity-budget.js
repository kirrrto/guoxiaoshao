'use strict';

// This document survives calendar-day rollover and function cold starts. Daily
// counters are accounting only; availability replenishes continuously.
const DAY_MS = 86400000;
const AUTO_SHARE = 0.8;
const IDLE_LANE_MS = 60000;
const EPSILON = 1e-9;
const CAPACITY_ID = 'upstream_capacity';

function capacityLimits(maxRequestsPerMinute, maxRequestsPerDay) {
  const shared = Math.max(1, maxRequestsPerMinute);
  const auto = Math.max(1, Math.floor(shared * AUTO_SHARE));
  const manual = Math.max(1, shared - auto);
  const rate = maxRequestsPerDay / DAY_MS;
  return { capacities: { shared, auto, manual }, rates: { shared: rate, auto: rate * AUTO_SHARE, manual: rate * (1 - AUTO_SHARE) } };
}

function reserveCapacity(stored, { nowMs, maxRequestsPerMinute, maxRequestsPerDay, source, legacyDayCount = 0, consume = true }) {
  source = source === 'auto' ? 'auto' : 'manual';
  const other = source === 'auto' ? 'manual' : 'auto';
  const limits = capacityLimits(maxRequestsPerMinute, maxRequestsPerDay);
  const previous = stored && stored.version === 1 ? stored : null;
  // Migrating an exhausted legacy day must not create a fresh request burst.
  // A partially used legacy day gets at most one immediate shared request.
  const seed = legacyDayCount >= maxRequestsPerDay ? 0 : legacyDayCount > 0 ? 1 : Infinity;
  const tokens = {};
  const elapsed = previous ? Math.max(0, nowMs - previous.updatedAtMs) : 0;
  for (const lane of ['shared', 'auto', 'manual']) {
    // Refill the elapsed period using the OLD rate/capacity. Raising a setting
    // cannot retroactively refill at the new rate or mint a larger burst.
    const oldCapacity = previous && previous.capacities[lane];
    const available = previous
      ? Math.min(oldCapacity, previous.tokens[lane] + elapsed * previous.rates[lane])
      : Math.min(seed, limits.capacities[lane]);
    tokens[lane] = Math.max(0, Math.min(limits.capacities[lane], available));
  }
  const lastDemandAt = { ...(previous && previous.lastDemandAt) };
  const mayBorrow = lastDemandAt[other] == null || nowMs - lastDemandAt[other] >= IDLE_LANE_MS;
  lastDemandAt[source] = Math.max(lastDemandAt[source] || 0, nowMs);
  // One request remains reserved for a returning idle lane. The shared bucket
  // still bounds total bursts, including when either lane has minimum size 1.
  const borrowable = mayBorrow ? Math.max(0, tokens[other] - 1) : 0;
  const allowed = tokens.shared + EPSILON >= 1 && tokens[source] + borrowable + EPSILON >= 1;
  let borrowed = 0;
  if (allowed && consume) {
    const own = Math.min(1, tokens[source]);
    borrowed = Math.max(0, 1 - own);
    tokens[source] = Math.max(0, tokens[source] - own);
    tokens[other] = Math.max(0, tokens[other] - borrowed);
    tokens.shared = Math.max(0, tokens.shared - 1);
  }
  const sharedWait = Math.max(0, 1 - tokens.shared) / limits.rates.shared;
  const ownWait = Math.max(0, 1 - tokens[source]) / limits.rates[source];
  const borrowWait = mayBorrow && tokens[source] + borrowable + EPSILON >= 1 ? 0 : ownWait;
  const waitMs = Math.max(1, Math.ceil(Math.max(sharedWait, borrowWait)));
  return {
    allowed,
    retryAt: allowed ? null : nowMs + waitMs,
    state: { _id: CAPACITY_ID, version: 1, tokens, ...limits, lastDemandAt, updatedAtMs: Math.max(nowMs, previous && previous.updatedAtMs || nowMs) },
    detail: { budgetMode: 'continuous', source, sharedTokens: tokens.shared, sourceTokens: tokens[source],
      burstCapacity: limits.capacities.shared, sourceCapacity: limits.capacities[source],
      refillPerSecond: limits.rates.shared * 1000, sourceRefillPerSecond: limits.rates[source] * 1000,
      borrowedTokens: borrowed, idleBorrowAfterMs: IDLE_LANE_MS },
  };
}

module.exports = { CAPACITY_ID, AUTO_SHARE, DAY_MS, capacityLimits, reserveCapacity };
