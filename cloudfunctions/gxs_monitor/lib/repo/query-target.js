'use strict';
const { createHash } = require('node:crypto');
const { COLLECTIONS: C } = require('../collections');
const { canReadMarket } = require('../rules/regional-query-access');
const { decideMarketQuery } = require('../rules/access');
const { targetKeyOf } = require('../engine/events');

const queryTargetId = (storeNumber, partNumber, market) => `query_target_${createHash('sha256').update(targetKeyOf(storeNumber, partNumber, market || 'CN')).digest('hex')}`;
const KNOWN = new Set(['available', 'unavailable', 'ineligible', 'pending']);

// Serving a shared sample and reserving an HTTP request both require the
// current account's entitlement to the SKU at the cost agreed for this query.
async function regionalQueryDenial(tx, market, runtime, now, query) {
  if (!query) return runtime?.internationalMarkets?.[market] === true ? null : 'market_disabled';
  if (runtime?.internationalMarkets?.[market] !== true && query.charged > 0) return 'market_disabled';
  const user = await tx.get(C.users, query.userKey);
  const checkedAt = query.clock ? query.clock() : new Date(now);
  if (!user || !canReadMarket(market, user, runtime, checkedAt)) return 'market_disabled';
  const decision = decideMarketQuery({ user, product: query.product, now: checkedAt, config: runtime });
  // beginQuery may already have spent the account's last credit.
  if (!decision.allowed && decision.reason !== 'insufficient_credits') return decision.reason;
  return decision.cost > query.charged ? 'query_cost_changed' : null;
}

function queryTargetMethods(run) {
  return {
    claimQueryTarget: ({ storeNumber, partNumber, market = null, regionalQuery = null, ownerId, nowIso, maxAgeMs, budgetMode, leaseMs = 25000 }) => run(async tx => {
      const now = Date.parse(nowIso);
      if (market) {
        const reason = await regionalQueryDenial(tx, market, await tx.get(C.config, 'runtime'), nowIso, regionalQuery);
        if (reason) return { deferred: true, reason, retryAt: 0 };
      }
      const latest = await tx.get(C.latest, targetKeyOf(storeNumber, partNumber, market || 'CN'));
      const age = latest ? now - Date.parse(latest.observedAt) : Infinity;
      // Reuse only an actual, still-fresh known sample. Never revive a sample
      // superseded by an unknown observation or a timestamp from the future.
      if (latest && (!market || latest.market === market && latest.storeNumber === storeNumber && latest.partNumber === partNumber)
        && KNOWN.has(latest.status) && !latest.unknownSince && age >= 0 && age < maxAgeMs) return { latest };
      const id = queryTargetId(storeNumber, partNumber, market);
      const current = await tx.get(C.config, id);
      // A target may retain the previous policy until midnight after the runtime
      // switches to continuous capacity. Retire only that old daily-cap wait;
      // the new owner still passes the current capacity and circuit guards.
      const retiredDailyWait = budgetMode === 'continuous' && current && ['daily_budget', 'auto_budget_reserved'].includes(current.reason);
      if (current && current.deferUntil > now && !retiredDailyWait) return { deferred: true, reason: current.reason, retryAt: current.deferUntil };
      if (current && current.ownerId && current.leaseUntil > now) return { busy: true, retryAt: Math.min(current.leaseUntil, now + 1000) };
      await tx.put(C.config, { _id: id, kind: 'query_target', ownerId, leaseUntil: now + leaseMs,
        expiresAt: new Date(now + 86400000).toISOString(), updatedAt: nowIso });
      return { acquired: true, id };
    }),
    releaseQueryTarget: ({ id, ownerId, nowIso, reason = null, retryAt = 0 }) => run(async tx => {
      const current = await tx.get(C.config, id);
      if (!current || current.ownerId !== ownerId) return { released: false };
      await tx.put(C.config, { ...current, ownerId: null, leaseUntil: 0, reason,
        deferUntil: reason ? Math.max(Date.parse(nowIso) + 1000, retryAt || 0) : 0, updatedAt: nowIso });
      return { released: true };
    }),
  };
}

module.exports = { queryTargetId, queryTargetMethods, regionalQueryDenial };
