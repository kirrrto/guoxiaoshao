'use strict';
const { randomUUID } = require('node:crypto');
const { ApiError } = require('../errors');
const { guardedPickup } = require('../engine/guarded-pickup');
const { ensureUser } = require('./users');
const { recordObservations } = require('../engine/observations');
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
function validatePayload(ctx, payload) {
  const queryId = typeof payload.queryId === 'string' && ID_PATTERN.test(payload.queryId) ? payload.queryId : null;
  if (!queryId) throw new ApiError('invalid_query_id', 'queryId 需为 8–64 位字母数字标识');
  const partNumber = typeof payload.partNumber === 'string' ? payload.partNumber.trim() : '';
  if (!/^[A-Z0-9]{5}CH\/A$/.test(partNumber)) throw new ApiError('invalid_part_number', '商品编号格式无效');
  const maxStores = Math.min(10, Math.max(1, Number(ctx.config.query.maxStores) || 3));
  const storeNumbers = Array.isArray(payload.storeNumbers) ? [...new Set(payload.storeNumbers.filter(s => typeof s === 'string' && /^R\d{3}$/.test(s)))] : [];
  if (storeNumbers.length === 0) throw new ApiError('no_stores', '请至少选择一家门店');
  if (storeNumbers.length > maxStores) throw new ApiError('too_many_stores', `单次最多查询 ${maxStores} 家门店`);
  return { queryId, partNumber, storeNumbers };
}
async function mapLimit(items, concurrency, fn) {
  const result = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (index < items.length) { const at = index++; result[at] = await fn(items[at], at); }
  }));
  return result;
}
function presentResult({ observation, latest, events, outcome }) {
  const current = outcome === 'stale' && latest ? { ...observation, status: latest.unknownSince ? 'unknown' : latest.status, quote: latest.quote, observedAt: latest.observedAt, reason: latest.lastReason || null } : observation;
  return {
    storeNumber: observation.storeNumber, storeName: observation.storeName || (latest && latest.storeName) || null,
    partNumber: observation.partNumber, status: current.status, quote: current.quote,
    productTitle: observation.productTitle || (latest && latest.productTitle) || null,
    observedAt: current.observedAt, reason: current.reason, statusSince: latest ? latest.statusSince : null,
    superseded: outcome === 'stale',
    events: events.map(e => ({ type: e.type, detectedAt: e.detectedAt })),
  };
}
async function boundedPickup(ctx, storeNumber, partNumber, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  const timeoutMs = Math.max(1, Math.min(remaining, Number(ctx.config.query.upstreamTimeoutMs) || 8000, 12000));
  return guardedPickup({ repo: ctx.repo, config: ctx.config, clock: ctx.clock, fetchImpl: ctx.fetchImpl, storeNumber, partNumbers: [partNumber], timeoutMs, beforeRequest: async () => Date.now() < deadline });
}
async function pickup(ctx, payload) {
  const startedAt = Date.now();
  const { queryId, partNumber, storeNumbers } = validatePayload(ctx, payload);
  const user = await ensureUser(ctx);
  const [product, stores] = await Promise.all([ctx.repo.getProduct(partNumber), ctx.repo.getStores(storeNumbers)]);
  if (!product) throw new ApiError('unknown_product', '该商品不在目录中');
  if (stores.length !== storeNumbers.length) throw new ApiError('unknown_store', '存在未知门店编号');
  const ownerId = randomUUID(); const recordId = `${user._id}|${queryId}`;
  const begun = await ctx.repo.beginQuery({ record: { _id: recordId, userKey: user._id, queryId, kind: 'live', partNumber, storeNumbers }, product, config: ctx.config, ownerId, nowIso: ctx.nowIso });
  if (begun.replayed) return { ...begun.record.response, replayed: true };
  if (begun.busy) return { ok: false, reason: 'query_in_progress', queryId, retryAfterMs: begun.retryAfterMs, balance: begun.balance };
  if (begun.denied) return { ok: false, reason: begun.denied.reason, retryAfterMs: begun.denied.retryAfterMs || null, restrictionEndsAt: begun.denied.restrictionEndsAt || null, cost: begun.denied.cost, balance: begun.balance };
  let response; let refund = false;
  try {
    // Three parallel requests; keep six seconds of the 20-second invocation for persistence.
    const deadline = startedAt + 14000;
    const batches = await mapLimit(storeNumbers, 3, store => boundedPickup(ctx, store, partNumber, deadline));
    // A denied request is not an upstream observation and must not alter history.
    const observed = await recordObservations(ctx, batches.filter(batch => !batch.record.budgetDenied).flatMap(batch => batch.observations), 'manual');
    const recorded = batches.flatMap(batch => batch.record.budgetDenied
      ? batch.observations.map(observation => ({ observation, latest: null, events: [], outcome: 'not_sampled' }))
      : observed.filter(item => item.observation.storeNumber === batch.observations[0]?.storeNumber));
    const allUnknown = recorded.length === 0 || recorded.every(r => r.observation.status === 'unknown');
    refund = allUnknown;
    const retryAt = Math.max(0, ...batches.map(batch => Number(batch.record.retryAt) || 0));
    const guardReason = batches.find(batch => batch.record.budgetDenied)?.record.error.message;
    response = { ok: !allUnknown, reason: allUnknown ? (guardReason === 'upstream_paused' ? 'upstream_paused' : guardReason ? 'upstream_budget_limited' : 'upstream_unavailable') : null, queryId,
      retryAfterMs: Math.max(0, retryAt - ctx.clock().getTime()), partial: !allUnknown && recorded.some(item => item.observation.status === 'unknown'),
      product: { partNumber: product.partNumber, title: product.title, model: product.model, familyName: product.familyName },
      results: recorded.map(presentResult), queriedAt: ctx.nowIso,
      transport: batches.map((batch, i) => ({ storeNumber: storeNumbers[i], httpStatus: batch.record.httpStatus, elapsedMs: batch.record.elapsedMs, error: batch.record.error ? batch.record.error.message : null })),
    };
  } catch (error) {
    ctx.log.error('[query] execution failed; compensating', error && error.message);
    refund = true; response = { ok: false, reason: 'query_failed', queryId, results: [], queriedAt: ctx.nowIso, transport: [] };
  }
  const finished = await ctx.repo.finishQuery({ id: recordId, ownerId, response, refund, nowIso: ctx.clock().toISOString() });
  if (finished.stale) return { ok: false, reason: 'query_in_progress', queryId, retryAfterMs: 1000 };
  return finished.response;
}
async function recent(ctx, payload) {
  const user = await ensureUser(ctx);
  const list = await ctx.repo.listQueries(user._id, Math.min(Number(payload.limit) || 10, 50));
  return { queries: list.filter(q => q.kind === 'live').map(q => ({ queryId: q.queryId, partNumber: q.partNumber, storeNumbers: q.storeNumbers, status: q.status, createdAt: q.createdAt, summary: q.response ? (q.response.results || []).map(r => ({ storeNumber: r.storeNumber, storeName: r.storeName, status: r.status })) : [], productTitle: q.response && q.response.product ? q.response.product.title : null })) };
}
module.exports = { pickup, recent, recordObservations, validatePayload };
