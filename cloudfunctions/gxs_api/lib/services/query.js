'use strict';
const { randomUUID } = require('node:crypto');
const { ApiError } = require('../errors');
const { sharedQueryPickup } = require('../engine/shared-query');
const { ensureUser } = require('./users');
const { accountLimits, ANNUAL_LIMITS } = require('../rules/membership');
const { isRetiredPartNumber, retiredProductMessage } = require('../rules/follow-access');
const { recordObservations } = require('../engine/observations');
const { isProductIdentity } = require('../rules/product-target');
const { MARKETS, findMarket } = require('../markets');
const { isValidTemplateId } = require('../config');
const { monitoringSnapshot } = require('../monitor-readiness');
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
function validatePayload(ctx, payload, user, existingOnly = false) {
  const queryId = typeof payload.queryId === 'string' && ID_PATTERN.test(payload.queryId) ? payload.queryId : null;
  if (!queryId) throw new ApiError('invalid_query_id', 'queryId 需为 8–64 位字母数字标识');
  const partNumber = typeof payload.partNumber === 'string' ? payload.partNumber.trim() : '';
  if (!isProductIdentity(partNumber)) throw new ApiError('invalid_part_number', '商品编号格式无效');
  if (isRetiredPartNumber(partNumber)) throw new ApiError('product_retired', retiredProductMessage(partNumber));
  // Cap catalog reads at the largest supported scope. The transaction enforces
  // the current user's limit for new IDs after checking for a matching old ID.
  const maxStores = accountLimits(user, ctx.now, ctx.config).queryMaxStores;
  const storeNumbers = Array.isArray(payload.storeNumbers) ? [...new Set(payload.storeNumbers.filter(s => typeof s === 'string' && /^R\d{3}$/.test(s)))] : [];
  if (storeNumbers.length === 0) throw new ApiError('no_stores', '请至少选择一家门店');
  if ((existingOnly || storeNumbers.length > maxStores) && storeNumbers.length !== payload.storeNumbers.length) throw new ApiError('invalid_query_id', '旧查询门店不匹配，请核对原配置。');
  if (storeNumbers.length > ANNUAL_LIMITS.maxStoresPerFollow) throw new ApiError('too_many_stores', `单次最多查询 ${maxStores} 家门店`);
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
  const superseded = (outcome === 'stale' || outcome === 'duplicate') && validLatest;
  const current = superseded ? { ...observation, status: latest.unknownSince ? 'unknown' : latest.status,
    quote: latest.unknownSince ? null : latest.quote, observedAt: latest.observedAt, reason: latest.lastReason || null } : observation;
  return {
    storeNumber: observation.storeNumber, storeName: observation.storeName || (latest && latest.storeName) || null,
    partNumber: observation.partNumber, status: current.status, quote: current.quote,
    productTitle: observation.productTitle || (latest && latest.productTitle) || null,
    observedAt: current.observedAt, reason: current.reason, statusSince: validLatest ? latest.statusSince : null,
    superseded: Boolean(superseded),
    reused: Boolean(reused || (superseded && current.status !== 'unknown')),
    events: events.map(e => ({ type: e.type, detectedAt: e.detectedAt })),
  };
}
// Read only. Look up the exact historical key inside the authenticated user's
// namespace. Missing, foreign and mismatched requests disclose the same status.
async function recovery(ctx, payload) {
  if (payload.expectedUserKey !== ctx.identity.userKey) throw new ApiError('query_recovery_account', '账号已变化，请重新核对旧查询。');
  const { queryId, kind, partNumber, storeNumbers, dayKey } = payload;
  if (!['live', 'history'].includes(kind) || typeof queryId !== 'string' || !ID_PATTERN.test(queryId)
      || !isProductIdentity(partNumber) || !Array.isArray(storeNumbers) || storeNumbers.length > 100
      || storeNumbers.some(s => typeof s !== 'string' || !/^R\d{3}$/.test(s)) || new Set(storeNumbers).size !== storeNumbers.length
      || (kind === 'live' ? !storeNumbers.length || dayKey !== undefined : !/^\d{4}-\d{2}-\d{2}$/.test(dayKey))) {
    throw new ApiError('invalid_query_id', '旧查询条件无效，请核对原配置。');
  }
  const id = kind === 'history' ? `${ctx.identity.userKey}|history|${queryId}` : `${ctx.identity.userKey}|${queryId}`;
  const record = await ctx.repo.getQuery(id);
  const matched = record && record.userKey === ctx.identity.userKey && record.kind === kind && record.queryId === queryId
    && record.partNumber === partNumber && (kind !== 'history' || record.dayKey === dayKey)
    && Array.isArray(record.storeNumbers) && JSON.stringify([...record.storeNumbers].sort()) === JSON.stringify([...storeNumbers].sort());
  return { userKey: ctx.identity.userKey, status: matched ? 'matched' : 'missing' };
}

async function resumeLegacy(ctx, payload) {
  if (payload.expectedUserKey !== ctx.identity.userKey) throw new ApiError('query_recovery_account', '账号已变化，请重新核对旧查询。');
  if (!['live', 'history'].includes(payload.kind) || !['resume', 'start'].includes(payload.mode)) throw new ApiError('invalid_query_id', '旧查询操作无效。');
  const existingOnly = payload.mode === 'resume';
  if (!existingOnly && (!Number.isSafeInteger(payload.maxCost) || payload.maxCost < 0)) throw new ApiError('invalid_query_id', '请重新确认查询费用。');
  const limits = { existingOnly, maxCost: payload.maxCost };
  return payload.kind === 'live' ? pickup(ctx, payload, limits)
    : require('./history').list(ctx, { ...payload, historyQueryId: payload.queryId }, limits);
}

async function pickup(ctx, payload, { existingOnly = false, maxCost } = {}) {
  if (payload.expectedUserKey !== undefined && payload.expectedUserKey !== ctx.identity.userKey) {
    throw new ApiError('query_account_changed', '账号已变化，请下拉刷新后再查询。');
  }
  const startedAt = Date.now();
  const user = await ensureUser(ctx);
  const { queryId, partNumber, storeNumbers } = validatePayload(ctx, payload, user, existingOnly);
  const [product, stores] = await Promise.all([ctx.repo.getProduct(partNumber), ctx.repo.getStores(storeNumbers)]);
  if (!product) throw new ApiError('unknown_product', '该商品不在目录中');
  if (stores.length !== storeNumbers.length) throw new ApiError('unknown_store', '存在未知门店编号');
  return executePickup(ctx, { user, product, queryId, partNumber, storeNumbers, startedAt, existingOnly, maxCost });
}

async function marketCatalog(ctx) {
  const config = ctx.config;
  const ids = config.notifications.templateIds || {};
  let status = null;
  if (config.collector.enabled && MARKETS.some(site => config.internationalMonitoring?.[site.code] === true)) {
    try { status = await ctx.repo.getCollectorStatus(); }
    catch { ctx.log?.warn?.('[markets] monitoring status unavailable'); }
  }
  const worker = status && monitoringSnapshot(config, status, ctx.now).collector;
  const workerReady = worker && !worker.stale && !['error', 'not_deployed', 'no_lease', 'stopped', 'disabled'].includes(worker.state);
  return { markets: MARKETS.map(site => {
    const monitorEnabled = config.collector.enabled === true && config.internationalMonitoring?.[site.code] === true;
    const notify = monitorEnabled && config.notifications.enabled === true && config.internationalNotifications?.[site.code] === true;
    const region = monitorEnabled && status?.markets?.[site.code];
    const monitorIntervalMs = region && Number.isSafeInteger(region.intervalMs) && region.intervalMs >= 60000 ? region.intervalMs : null;
    const observed = region ? Date.parse(region.lastSuccessAt) : NaN;
    const monitorStale = !(workerReady && monitorIntervalMs && region.state === 'running' && region.health?.state === 'healthy'
      && Number.isFinite(observed) && observed <= ctx.now.getTime() && !(region.admissionUntil > ctx.now.getTime()));
    return { ...site, enabled: config.internationalMarkets?.[site.code] === true, monitorEnabled,
      monitorIntervalMs, monitorStale, monitorLastSuccessAt: Number.isFinite(observed) && observed <= ctx.now.getTime() ? new Date(observed).toISOString() : null,
      notificationsEnabled: notify && isValidTemplateId(ids.restock),
      notificationsEnabledEn: notify && isValidTemplateId(ids.restockEn) && ![ids.restock, ids.soldout, ids.soldoutEn, config.deadlineReminders.templateId].includes(ids.restockEn) };
  }) };
}

async function marketPickup(ctx, payload) {
  const startedAt = Date.now();
  const { market, partNumber, storeNumbers, queryId, maxCost } = payload;
  const site = findMarket(market);
  if (!site) throw new ApiError('unknown_market', '该站点不在支持范围内。');
  if (payload.expectedUserKey !== ctx.identity.userKey) throw new ApiError('query_account_changed', '账号已变化，请重新确认查询。');
  if (typeof queryId !== 'string' || !ID_PATTERN.test(queryId)) throw new ApiError('invalid_query_id', '查询编号无效。');
  if (maxCost !== undefined && (!Number.isSafeInteger(maxCost) || maxCost < 0)) throw new ApiError('invalid_payload', '查询费用无效。');
  const product = site.products.find(item => item.partNumber === partNumber);
  if (!product || !Array.isArray(storeNumbers) || storeNumbers.length !== 1
    || !site.stores.some(store => store.storeNumber === storeNumbers[0])) throw new ApiError('invalid_market_target', '请在当前站点重新选择商品与门店。');
  if (ctx.config.internationalMarkets?.[market] !== true) {
    // Closing a storefront must not strand or recharge an already-debited request.
    // A disabled market can replay/settle an existing receipt, never restart HTTP.
    const id = ctx.identity.userKey + '|' + queryId;
    let record = await ctx.repo.getQuery(id);
    if (!record || record.kind !== 'market' || record.market !== market || record.partNumber !== partNumber
      || record.storeNumbers?.length !== 1 || record.storeNumbers[0] !== storeNumbers[0]) throw new ApiError('market_disabled', '该站点尚未开放实时查询。');
    if (record.status === 'pending') {
      if (record.leaseUntil <= ctx.nowIso) {
        await ctx.repo.expireQuery({ id, userKey: ctx.identity.userKey, nowIso: ctx.nowIso, staleBefore: ctx.nowIso });
        record = await ctx.repo.getQuery(id);
      }
      if (record?.status === 'pending') return { market, queryId, ok: false, reason: 'query_in_progress', retryAfterMs: Math.max(1000, Date.parse(record.leaseUntil) - ctx.now.getTime()) };
    }
    if (!record?.response) throw new ApiError('market_disabled', '该站点尚未开放实时查询。');
    const owner = await ctx.repo.getUser(ctx.identity.userKey);
    return { ...record.response, market, queryId, balance: owner.quota.balance, quotaRevision: owner.quota.revision || 0, replayed: true };
  }
  const user = await ensureUser(ctx);
  const reply = await executePickup(ctx, { user, product, queryId, partNumber, storeNumbers, startedAt, market, maxCost });
  return { ...reply, market, queryId };
}

async function executePickup(ctx, { user, product, queryId, partNumber, storeNumbers, startedAt, market = null, existingOnly = false, maxCost }) {
  const remaining = () => typeof ctx.remainingMs === 'function' ? ctx.remainingMs() : Infinity;
  // Slow configuration/account/catalog reads used to be followed by another
  // full 14-second fetch window, exceeding the invocation limit after debit.
  // 1.5.3 clients only preserve uncertain IDs for known error codes. This may
  // be a retry of an already-debited query, so retain that recovery contract.
  if (remaining() <= 7000) throw new ApiError('query_in_progress', '连接耗时较长，本次未继续查询；原编号已保留，请重试确认原结果',
    { reason: 'request_budget_exhausted' });
  const ownerId = randomUUID(); const recordId = `${user._id}|${queryId}`;
  const scope = market ? { kind: 'market', market } : { kind: 'live' };
  const begun = await ctx.repo.beginQuery({ record: { _id: recordId, userKey: user._id, queryId, ...scope, partNumber, storeNumbers }, product, config: ctx.config, ownerId, nowIso: ctx.nowIso, existingOnly, maxCost });
  if (begun.replayed) return { ...begun.record.response, balance: begun.balance, quotaRevision: begun.quotaRevision, replayed: true };
  if (begun.busy) return { ok: false, reason: 'query_in_progress', queryId, retryAfterMs: begun.retryAfterMs, balance: begun.balance, quotaRevision: begun.quotaRevision };
  if (begun.denied) return { ok: false, reason: begun.denied.reason, retryAfterMs: begun.denied.retryAfterMs || null, restrictionEndsAt: begun.denied.restrictionEndsAt || null, cost: begun.denied.cost, balance: begun.balance, quotaRevision: begun.quotaRevision };
  let response; let refund = false;
  try {
    // Keep six seconds for recording/refund even after slow admission reads.
    const deadline = Math.min(startedAt + 14000, Date.now() + Math.max(0, remaining() - 6000));
    const batches = await mapLimit(storeNumbers, 3, store => sharedQueryPickup(ctx, store, partNumber, deadline, product, market));
    // A denied request is not an upstream observation and must not alter history.
    const recorded = batches.flatMap(batch => batch.record.budgetDenied
      ? batch.observations.map(observation => ({ observation, latest: null, events: [], outcome: 'not_sampled' }))
      : batch.recorded);
    // A manual reply may lose the persistence race to a later automatic sample.
    // Settle the query using the exact same observations the user receives.
    const results = recorded.map(item => ({
      ...presentResult(item, ctx.clock().getTime()), ...(market ? { market } : {}),
    }));
    const allUnknown = results.every(r => r.status === 'unknown');
    const allShared = results.length > 0 && results.every(r => r.reused);
    const sharedResult = results.some(r => r.reused);
    const hasNewValidResult = results.some(r => !r.reused && r.status !== 'unknown');
    refund = !hasNewValidResult;
    const retryAt = Math.max(0, ...batches.map(batch => Number(batch.record.retryAt) || 0));
    const guardReason = batches.find(batch => batch.record.budgetDenied)?.record.error.message
      || (retryAt > ctx.clock().getTime() ? 'upstream_paused' : null);
    const reason = ['upstream_paused', 'query_refresh_pending', 'upstream_unavailable', 'market_disabled'].includes(guardReason) ? guardReason
      : ['daily_budget', 'minute_budget', 'capacity_wait'].includes(guardReason) ? 'upstream_budget_limited' : 'upstream_unavailable';
    response = { ok: !allUnknown, reason: allUnknown ? reason : null, queryId,
      sharedResult, allShared, billingReason: refund && sharedResult ? 'shared_result_no_charge' : refund ? 'no_valid_result' : null,
      budgetScope: guardReason === 'daily_budget' ? 'daily' : guardReason === 'minute_budget' ? 'minute' : guardReason === 'capacity_wait' ? 'continuous' : null,
      retryAfterMs: Math.max(0, retryAt - ctx.clock().getTime()), partial: !allUnknown && results.some(item => item.status === 'unknown'),
      product: { partNumber: product.partNumber, title: product.title, model: product.model, familyName: product.familyName },
      results, queriedAt: ctx.nowIso,
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
  const limit = Math.max(1, Math.min(50, Math.floor(Number(payload.limit) || 10)));
  const list = await ctx.repo.listQueries(user._id, limit, 'live');
  return { queries: list.map(q => ({ queryId: q.queryId, partNumber: q.partNumber, storeNumbers: q.storeNumbers, status: q.status, createdAt: q.createdAt, summary: q.response ? (q.response.results || []).map(r => ({ storeNumber: r.storeNumber, storeName: r.storeName, status: r.status })) : [], productTitle: q.response && q.response.product ? q.response.product.title : null })) };
}
module.exports = { pickup, marketCatalog, marketPickup, recent, recovery, resumeLegacy, recordObservations, validatePayload };
