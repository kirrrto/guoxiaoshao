'use strict';
// These guards run in the same database used by both API and monitor instances.
const { createHash, randomUUID } = require('node:crypto');
const { COLLECTIONS: C } = require('../collections');
const { dayKey, endOfDay } = require('../time');
const { CAPACITY_ID, AUTO_SHARE, reserveCapacity } = require('../engine/capacity-budget');

const accountId = userKey => `query_guard_${createHash('sha256').update(userKey).digest('hex')}`;
async function reserveAccountQuery(tx, { record, ownerId, nowIso, leaseMs, config }) {
  if (record.kind !== 'live') return null;
  const now = Date.parse(nowIso);
  const id = accountId(record.userKey);
  const stored = await tx.get(C.config, id) || { _id: id };
  const active = (stored.active || []).filter(item => Date.parse(item.expiresAt) > now);
  const starts = (stored.starts || []).filter(at => at > now - 60000);
  const maxConcurrent = config.query.maxConcurrentPerUser || 1;
  const maxPerMinute = config.query.maxRequestsPerUserMinute || 6;
  if (active.length >= maxConcurrent) return { reason: 'query_concurrency_limited', retryAfterMs: Math.max(1, Math.min(...active.map(item => Date.parse(item.expiresAt))) - now) };
  if (starts.length >= maxPerMinute) return { reason: 'query_rate_limited', retryAfterMs: Math.max(1, starts[0] + 60000 - now) };
  active.push({ id: record._id, ownerId, expiresAt: new Date(now + leaseMs).toISOString() });
  await tx.put(C.config, { _id: id, kind: 'query_guard', active, starts: [...starts, now], updatedAt: nowIso, expiresAt: new Date(now + 86400000).toISOString() });
  return null;
}
async function releaseAccountQuery(tx, record, ownerId, nowIso) {
  if (record.kind !== 'live') return;
  const id = accountId(record.userKey);
  const stored = await tx.get(C.config, id);
  if (stored) await tx.put(C.config, { ...stored, active: (stored.active || []).filter(item => !(item.id === record._id && item.ownerId === ownerId) && item.expiresAt > nowIso), updatedAt: nowIso });
}
function retryAfterMs(value, now) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const seconds = Number(value);
  const result = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(result) ? Math.max(0, Math.min(result, 2147483647)) : 0;
}
function upstreamGuardMethods(run) {
  return {
    getUpstreamCapacity: ({ now }) => run(async tx => ({
      day: await tx.get(C.config, `collector_budget_${dayKey(now)}`),
      capacity: await tx.get(C.config, CAPACITY_ID),
      collector: await tx.get(C.config, 'collector_status'),
    })),
    // Legacy method name retained; this is now the shared manual + auto budget.
    consumeCollectorBudget: ({ now, maxRequestsPerMinute, maxRequestsPerDay, budgetMode = 'continuous', source = 'manual' }) => run(async tx => {
      source = source === 'auto' ? 'auto' : 'manual';
      const nowMs = Date.parse(now);
      const breaker = await tx.get(C.config, 'upstream_breaker') || { _id: 'upstream_breaker', generation: 0, trips: 0 };
      if (breaker.until > nowMs) return { allowed: false, reason: 'upstream_paused', retryAt: breaker.until };
      if (breaker.probeUntil > nowMs) return { allowed: false, reason: 'upstream_paused', retryAt: breaker.probeUntil };
      const date = dayKey(now);
      const id = `collector_budget_${date}`;
      const minuteKey = new Date(now).toISOString().slice(0, 16);
      const current = await tx.get(C.config, id) || { _id: id, dayCount: 0 };
      const minuteCount = current.minuteKey === minuteKey ? current.minuteCount || 0 : 0;
      const sourceCounts = { auto: current.autoCount || 0, manual: current.manualCount || 0 };
      let detail = { budgetMode, source, sourceCounts };
      if (budgetMode === 'daily') {
        // Explicit compatibility/cost-control mode. This is the only mode that
        // can stop all queries until the next Beijing calendar day.
        const autoLimit = Math.max(1, Math.floor(maxRequestsPerDay * AUTO_SHARE));
        if (source === 'auto' && current.dayCount >= autoLimit && current.dayCount < maxRequestsPerDay) {
          return { allowed: false, reason: 'auto_budget_reserved', retryAt: endOfDay(date).getTime(), minuteCount, dayCount: current.dayCount, ...detail };
        }
        if (current.dayCount >= maxRequestsPerDay) {
          return { allowed: false, reason: 'daily_budget', retryAt: endOfDay(date).getTime(), minuteCount, dayCount: current.dayCount, ...detail };
        }
      } else {
        const capacity = reserveCapacity(await tx.get(C.config, CAPACITY_ID), { nowMs, maxRequestsPerMinute, maxRequestsPerDay, source,
          legacyDayCount: current.dayCount, consume: minuteCount < maxRequestsPerMinute });
        await tx.put(C.config, capacity.state);
        detail = { ...capacity.detail, sourceCounts };
        if (!capacity.allowed && minuteCount < maxRequestsPerMinute) {
          return { allowed: false, reason: 'capacity_wait', retryAt: capacity.retryAt, minuteCount, dayCount: current.dayCount, ...detail };
        }
      }
      if (minuteCount >= maxRequestsPerMinute) {
        return { allowed: false, reason: 'minute_budget', retryAt: Math.floor(nowMs / 60000) * 60000 + 60000, minuteCount, dayCount: current.dayCount, ...detail };
      }
      const token = { id: randomUUID(), generation: breaker.generation || 0, probe: Boolean(breaker.until), expiresAt: nowMs + 30000 };
      if (token.probe) await tx.put(C.config, { ...breaker, probeId: token.id, probeUntil: nowMs + 30000, updatedAt: now });
      sourceCounts[source] += 1;
      await tx.put(C.config, { ...current, minuteKey, minuteCount: minuteCount + 1, dayCount: current.dayCount + 1,
        autoCount: sourceCounts.auto, manualCount: sourceCounts.manual, updatedAt: now, expiresAt: new Date(nowMs + 7 * 86400000).toISOString() });
      return { allowed: true, reason: null, minuteCount: minuteCount + 1, dayCount: current.dayCount + 1, ...detail, token };
    }),
    recordUpstreamOutcome: ({ token, record, success, now }) => run(async tx => {
      const state = await tx.get(C.config, 'upstream_breaker') || { _id: 'upstream_breaker', generation: 0, trips: 0 };
      const nowMs = Date.parse(now);
      const ownsProbe = token && token.probe && state.probeId === token.id && token.generation === state.generation && state.probeUntil > nowMs;
      if (success) {
        // A request started before a 429 cannot reopen the source afterward.
        if (ownsProbe || (!state.until && token && token.generation === state.generation)) {
          await tx.put(C.config, { ...state, until: null, reason: null, probeId: null, probeUntil: null, trips: 0, failures: [], updatedAt: now });
        }
        return { paused: Boolean(state.until && !ownsProbe) };
      }
      const failures = (state.failures || []).filter(at => at > nowMs - 60000).concat(nowMs).slice(-5);
      const immediate = record.httpStatus === 429 || record.httpStatus === 503;
      if (!immediate && !ownsProbe && failures.length < 5) {
        await tx.put(C.config, { ...state, failures, updatedAt: now });
        return { paused: Boolean(state.until), retryAt: state.until || null };
      }
      const trips = (state.trips || 0) + 1;
      const cooldown = Math.max(retryAfterMs(record.retryAfter, nowMs), Math.min(1800000, 30000 * 2 ** Math.min(trips - 1, 6)));
      const until = Math.max(state.until || 0, nowMs + cooldown);
      await tx.put(C.config, { _id: 'upstream_breaker', generation: (state.generation || 0) + 1, trips, until, reason: immediate ? `http_${record.httpStatus}` : 'failure_burst', failures: [], probeId: null, probeUntil: null, updatedAt: now });
      return { paused: true, retryAt: until };
    }),
  };
}
module.exports = { upstreamGuardMethods, reserveAccountQuery, releaseAccountQuery, retryAfterMs };
