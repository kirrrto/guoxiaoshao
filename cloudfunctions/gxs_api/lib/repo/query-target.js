'use strict';
const { createHash } = require('node:crypto');
const { COLLECTIONS: C } = require('../collections');

const queryTargetId = (storeNumber, partNumber) => `query_target_${createHash('sha256').update(`${storeNumber}|${partNumber}`).digest('hex')}`;
const KNOWN = new Set(['available', 'unavailable', 'ineligible', 'pending']);

function queryTargetMethods(run) {
  return {
    claimQueryTarget: ({ storeNumber, partNumber, ownerId, nowIso, maxAgeMs, budgetMode, leaseMs = 25000 }) => run(async tx => {
      const now = Date.parse(nowIso);
      const latest = await tx.get(C.latest, `${storeNumber}|${partNumber}`);
      const age = latest ? now - Date.parse(latest.observedAt) : Infinity;
      // Reuse only an actual, still-fresh known sample. Never revive a sample
      // superseded by an unknown observation or a timestamp from the future.
      if (latest && KNOWN.has(latest.status) && !latest.unknownSince && age >= 0 && age < maxAgeMs) return { latest };
      const id = queryTargetId(storeNumber, partNumber);
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

module.exports = { queryTargetId, queryTargetMethods };
