'use strict';
const { randomUUID } = require('node:crypto');
const { guardedPickup } = require('./guarded-pickup');
const { recordObservations } = require('./observations');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferredBatch(ctx, storeNumber, partNumber, reason, retryAt) {
  return { record: { budgetDenied: true, httpStatus: null, elapsedMs: 0, retryAt, error: { message: reason } },
    observations: [{ storeNumber, partNumber, status: 'unknown', observedAt: ctx.clock().toISOString(), quote: null,
      reason: { code: reason, message: '暂缓更新，请稍后重试' } }], recorded: [] };
}

function sharedBatch(latest) {
  const observation = { storeNumber: latest.storeNumber, partNumber: latest.partNumber, status: latest.status,
    storeName: latest.storeName, productTitle: latest.productTitle, quote: latest.quote, observedAt: latest.observedAt, reason: null };
  return { record: { httpStatus: null, elapsedMs: 0, shared: true }, observations: [observation],
    recorded: [{ observation, latest, events: [], outcome: 'shared', reused: true }] };
}

/** Cross-instance manual-query coalescing. A reused sample is never persisted again. */
async function sharedQueryPickup(ctx, storeNumber, partNumber, deadline) {
  const freshnessMs = (ctx.config.query.sharedFreshnessSeconds || 0) * 1000;
  const ownerId = randomUUID();
  let claim;
  if (freshnessMs > 0) {
    // Bound both latency and database polling. A slow owner keeps its lease;
    // followers return a short wait instead of launching duplicate HTTP work.
    for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
      claim = await ctx.repo.claimQueryTarget({ storeNumber, partNumber, ownerId, nowIso: ctx.clock().toISOString(), maxAgeMs: freshnessMs,
        budgetMode: ctx.config.collector.budgetMode });
      if (claim.latest) return sharedBatch(claim.latest);
      if (claim.deferred) return deferredBatch(ctx, storeNumber, partNumber, claim.reason, claim.retryAt);
      if (claim.acquired) break;
      if (attempt < 3) await sleep(Math.min(200 * 2 ** attempt, Math.max(0, deadline - Date.now())));
    }
    if (!claim || !claim.acquired) return deferredBatch(ctx, storeNumber, partNumber, 'query_refresh_pending', ctx.clock().getTime() + 1000);
  }
  let blockedReason = null, retryAt = 0;
  try {
    const remaining = Math.max(1, deadline - Date.now());
    const timeoutMs = Math.max(1, Math.min(remaining, Number(ctx.config.query.upstreamTimeoutMs) || 8000, 12000));
    const batch = await guardedPickup({ repo: ctx.repo, config: ctx.config, clock: ctx.clock, fetchImpl: ctx.fetchImpl,
      storeNumber, partNumbers: [partNumber], timeoutMs, remainingMs: () => Math.max(0, deadline - Date.now()),
      beforeRequest: async () => Date.now() < deadline });
    if (batch.record.budgetDenied) {
      blockedReason = batch.record.error.message;
      retryAt = batch.record.retryAt;
      return { ...batch, recorded: [] };
    }
    if (batch.observations.every(o => o.status === 'unknown')) {
      blockedReason = batch.record.retryAt ? 'upstream_paused' : 'upstream_unavailable';
      retryAt = batch.record.retryAt;
    }
    const recordingContext = claim && claim.acquired ? { ...ctx, queryTargetLease: { id: claim.id, ownerId } } : ctx;
    // Publish the observation before releasing the lease, so another instance
    // cannot acquire a duplicate refresh between HTTP completion and persistence.
    const recorded = await recordObservations(recordingContext, batch.observations, 'manual');
    return { ...batch, recorded };
  } finally {
    if (claim && claim.acquired) await ctx.repo.releaseQueryTarget({ id: claim.id, ownerId, nowIso: ctx.clock().toISOString(), reason: blockedReason, retryAt });
  }
}

module.exports = { sharedQueryPickup };
