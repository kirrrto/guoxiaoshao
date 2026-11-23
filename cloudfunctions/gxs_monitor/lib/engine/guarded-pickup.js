'use strict';
const { fetchPickup } = require('../apple-pickup');
const { isCtoPartNumber } = require('../rules/product-target');
const { findMarket } = require('../markets');

// Only requests for the same storefront contend on the same budget documents.
// A slow regional transaction must not delay other storefronts in this instance.
const admissionTails = new WeakMap();
function serialiseAdmission(repo, market, task, waitMs) {
  let queues = admissionTails.get(repo);
  if (!queues) { queues = new Map(); admissionTails.set(repo, queues); }
  let started = false, cancelled = false, timer;
  const expired = Number.isFinite(waitMs) ? new Promise(resolve => {
    timer = setTimeout(() => {
      if (!started) { cancelled = true; resolve(null); }
    }, Math.max(0, waitMs));
  }) : null;
  const next = (queues.get(market) || Promise.resolve()).then(() => {
    started = true;
    clearTimeout(timer);
    return cancelled ? null : task();
  });
  // A waiting caller may finish early, but its queue slot stays behind the
  // running transaction. Never race the tail or cancel an admission in flight.
  const tail = next.then(() => {}, () => {});
  queues.set(market, tail);
  tail.then(() => {
    if (queues.get(market) === tail) queues.delete(market);
    if (!queues.size) admissionTails.delete(repo);
  });
  return expired ? Promise.race([next, expired]) : next;
}

async function guardedPickup({ repo, config, clock, fetchImpl, storeNumber, partNumbers, products = null, timeoutMs, market = null, source = 'manual', beforeRequest = async () => true, onBudget = () => {}, remainingMs = () => Infinity }) {
  const denied = (reason, retryAt) => ({ record: { httpStatus: null, budgetDenied: true, retryAt, error: { message: reason }, elapsedMs: 0 }, observations: partNumbers.map(partNumber => ({ storeNumber, partNumber, status: 'unknown', quote: null, storeName: null, productTitle: null, observedAt: clock().toISOString(), reason: { code: reason, message: '暂缓查询，请稍后重试' } })) });
  if (remainingMs() <= 1000) return denied('request_cancelled', clock().getTime() + 1000);
  if (market !== null) {
    const site = findMarket(market);
    const flags = source === 'auto' ? config.internationalMonitoring : config.internationalMarkets;
    if (!site || flags?.[market] !== true) return denied('market_disabled', 0);
    if (!site.stores.some(store => store.storeNumber === storeNumber) || !Array.isArray(partNumbers) || !partNumbers.length
      || partNumbers.some(part => !site.products.some(product => product.partNumber === part))) return denied('invalid_market_target', 0);
  }
  if (!products && partNumbers.some(isCtoPartNumber)) products = await repo.getProducts(partNumbers.filter(isCtoPartNumber));
  const autoShare = Math.min(0.95, Math.max(0.01, (config.collector.autoSharePercent || 80) / 100));
  const budget = await serialiseAdmission(repo, market, () => {
    // Waiting consumes the invocation/lease budget too. Do not reserve an
    // expired request, and choose its calendar day only when it reaches the head.
    if (remainingMs() <= 1000) return null;
    const limits = market ? config.internationalQueryLimits : config.collector;
    return repo.consumeCollectorBudget({ now: clock().toISOString(), maxRequestsPerMinute: limits.maxRequestsPerMinute, maxRequestsPerDay: limits.maxRequestsPerDay, budgetMode: market ? 'daily' : config.collector.budgetMode, source, autoShare, market });
  }, remainingMs() - 1000);
  if (!budget) return denied('request_cancelled', clock().getTime() + 1000);
  onBudget(budget);
  if (!budget.allowed) return denied(budget.reason, budget.retryAt);
  if (!await beforeRequest()) return denied('request_cancelled', clock().getTime() + 1000);
  if (budget.token.probe && budget.token.expiresAt <= clock().getTime()) return denied('request_cancelled', clock().getTime() + 1000);
  // Transactions above consume invocation time too. Bound the actual network
  // request only now and leave a second for outcome/observation persistence.
  timeoutMs = Math.min(timeoutMs, Math.floor(remainingMs()) - 1000);
  if (timeoutMs < 1) return denied('request_cancelled', clock().getTime() + 1000);
  let timer;
  const fallback = () => ({ record: { httpStatus: null, elapsedMs: timeoutMs, error: { message: '查询超时' } }, observations: partNumbers.map(partNumber => ({ storeNumber, partNumber, storeName: null, productTitle: null, status: 'unknown', quote: null, observedAt: clock().toISOString(), reason: { code: 'transport_error', message: '查询超时' } })) });
  let result;
  try {
    result = await Promise.race([
      fetchPickup({ storeNumber, partNumbers, products: products || [], market, fetchImpl, now: clock, timeoutMs }),
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback()), timeoutMs + 10); }),
    ]);
  } finally { clearTimeout(timer); }
  if (market) result.observations = result.observations.map(observation => ({ ...observation, market }));
  const outcome = await repo.recordUpstreamOutcome({ token: budget.token, record: result.record, success: result.observations.length > 0 && result.observations.every(item => item.status !== 'unknown'), now: clock().toISOString() });
  if (outcome.paused) result.record.retryAt = outcome.retryAt;
  return result;
}
module.exports = { guardedPickup };
