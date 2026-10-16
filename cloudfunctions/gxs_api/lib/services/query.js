'use strict';
const { randomUUID } = require('node:crypto');
const { ApiError } = require('../errors');
const { sharedQueryPickup } = require('../engine/shared-query');
const { ensureUser } = require('./users');
const { accountLimits } = require('../rules/membership');
const { recordObservations } = require('../engine/observations');
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
function validatePayload(ctx, payload, user) {
  const queryId = typeof payload.queryId === 'string' && ID_PATTERN.test(payload.queryId) ? payload.queryId : null;
  if (!queryId) throw new ApiError('invalid_query_id', 'queryId 需为 8–64 位字母数字标识');
  const partNumber = typeof payload.partNumber === 'string' ? payload.partNumber.trim() : '';
  if (!/^[A-Z0-9]{5}CH\/A$/.test(partNumber)) throw new ApiError('invalid_part_number', '商品编号格式无效');
  const maxStores = accountLimits(user, ctx.now, ctx.config).queryMaxStores;
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
function presentResult({ observation, latest, events, outcome, reused }, nowMs) {
  // Corrupt future timestamps cannot overrule a real response obtained now.
  const validLatest = latest && Number.isFinite(Date.parse(latest.observedAt)) && Date.parse(latest.observedAt) <= nowMs;
  const superseded = outcome === 'stale' && validLatest;
  const current = superseded ? { ...observation, status: latest.unknownSince ? 'unknown' : latest.status, quote: latest.quote, observedAt: latest.observedAt, reason: latest.lastReason || null } : observation;
  return {
    storeNumber: observation.storeNumber, storeName: observation.storeName || (latest && latest.storeName) || null,
    partNumber: observation.partNumber, status: current.status, quote: current.quote,
    productTitle: observation.productTitle || (latest && latest.productTitle) || null,
    observedAt: current.observedAt, reason: current.reason, statusSince: validLatest ? latest.statusSince : null,
    superseded: Boolean(superseded),
    reused: Boolean(reused),
    events: events.map(e => ({ type: e.type, detectedAt: e.detectedAt })),
  };
}
async function pickup(ctx, payload) {
  const startedAt = Date.now();
  const user = await ensureUser(ctx);
  const { queryId, partNumber, storeNumbers } = validatePayload(ctx, payload, user);
  const [product, stores] = await Promise.all([ctx.repo.getProduct(partNumber), ctx.repo.getStores(storeNumbers)]);
  if (!product) throw new ApiError('unknown_product', '该商品不在目录中');
  if (stores.length !== storeNumbers.length) throw new ApiError('unknown_store', '存在未知门店编号');
  const remaining = () => typeof ctx.remainingMs === 'function' ? ctx.remainingMs() : Infinity;
  // Slow configuration/account/catalog reads used to be followed by another
  // full 14-second fetch window, exceeding the invocation limit after debit.
  // 1.5.3 clients only preserve uncertain IDs for known error codes. This may
  // be a retry of an already-debited query, so retain that recovery contract.
  if (remaining() <= 7000) throw new ApiError('query_in_progress', '连接耗时较长，本次未继续查询；原编号已保留，请重试确认原结果',
    { reason: 'request_budget_exhausted' });
  const ownerId = randomUUID(); const recordId = `${user._id}|${queryId}`;
  const begun = await ctx.repo.beginQuery({ record: { _id: recordId, userKey: user._id, queryId, kind: 'live', partNumber, storeNumbers }, product, config: ctx.config, ownerId, nowIso: ctx.nowIso });
  if (begun.replayed) return { ...begun.record.response, balance: begun.balance, quotaRevision: begun.quotaRevision, replayed: true };
  if (begun.busy) return { ok: false, reason: 'query_in_progress', queryId, retryAfterMs: begun.retryAfterMs, balance: begun.balance, quotaRevision: begun.quotaRevision };
  if (begun.denied) return { ok: false, reason: begun.denied.reason, retryAfterMs: begun.denied.retryAfterMs || null, restrictionEndsAt: begun.denied.restrictionEndsAt || null, cost: begun.denied.cost, balance: begun.balance, quotaRevision: begun.quotaRevision };
  let response; let refund = false;
  try {
    // Keep six seconds for recording/refund even after slow admission reads.
    const deadline = Math.min(startedAt + 14000, Date.now() + Math.max(0, remaining() - 6000));
    const batches = await mapLimit(storeNumbers, 3, store => sharedQueryPickup(ctx, store, partNumber, deadline));
    // A denied request is not an upstream observation and must not alter history.
    const recorded = batches.flatMap(batch => batch.record.budgetDenied
      ? batch.observations.map(observation => ({ observation, latest: null, events: [], outcome: 'not_sampled' }))
      : batch.recorded);
    const allUnknown = recorded.length === 0 || recorded.every(r => r.observation.status === 'unknown');
    const allShared = recorded.length > 0 && recorded.every(r => r.reused);
    const sharedResult = recorded.some(r => r.reused);
    const hasNewValidResult = recorded.some(r => !r.reused && r.observation.status !== 'unknown');
    refund = !hasNewValidResult;
    const retryAt = Math.max(0, ...batches.map(batch => Number(batch.record.retryAt) || 0));
    const guardReason = batches.find(batch => batch.record.budgetDenied)?.record.error.message
      || (retryAt > ctx.clock().getTime() ? 'upstream_paused' : null);
    const reason = ['upstream_paused', 'query_refresh_pending', 'upstream_unavailable'].includes(guardReason) ? guardReason
      : ['daily_budget', 'minute_budget', 'capacity_wait'].includes(guardReason) ? 'upstream_budget_limited' : 'upstream_unavailable';
    response = { ok: !allUnknown, reason: allUnknown ? reason : null, queryId,
      sharedResult, allShared, billingReason: refund && sharedResult ? 'shared_result_no_charge' : refund ? 'no_valid_result' : null,
      budgetScope: guardReason === 'daily_budget' ? 'daily' : guardReason === 'minute_budget' ? 'minute' : guardReason === 'capacity_wait' ? 'continuous' : null,
      retryAfterMs: Math.max(0, retryAt - ctx.clock().getTime()), partial: !allUnknown && recorded.some(item => item.observation.status === 'unknown'),
      product: { partNumber: product.partNumber, title: product.title, model: product.model, familyName: product.familyName },
      results: recorded.map(item => presentResult(item, ctx.clock().getTime())), queriedAt: ctx.nowIso,
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
