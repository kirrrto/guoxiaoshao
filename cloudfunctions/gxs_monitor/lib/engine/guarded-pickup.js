'use strict';
const { fetchPickup } = require('../apple-pickup');

// Concurrent stores share two budget documents. Queue only local admission;
// database transactions still arbitrate other repositories/instances.
const admissionTails = new WeakMap();
function serialiseAdmission(repo, task, waitMs) {
  let started = false, cancelled = false, timer;
  const expired = Number.isFinite(waitMs) ? new Promise(resolve => {
    timer = setTimeout(() => {
      if (!started) { cancelled = true; resolve(null); }
    }, Math.max(0, waitMs));
  }) : null;
  const next = (admissionTails.get(repo) || Promise.resolve()).then(() => {
    started = true;
    clearTimeout(timer);
    return cancelled ? null : task();
  });
  // A waiting caller may finish early, but its queue slot stays behind the
  // running transaction. Never race the tail or cancel an admission in flight.
  const tail = next.then(() => {}, () => {});
  admissionTails.set(repo, tail);
  tail.then(() => { if (admissionTails.get(repo) === tail) admissionTails.delete(repo); });
  return expired ? Promise.race([next, expired]) : next;
}

async function guardedPickup({ repo, config, clock, fetchImpl, storeNumber, partNumbers, timeoutMs, source = 'manual', beforeRequest = async () => true, onBudget = () => {}, remainingMs = () => Infinity }) {
  const denied = (reason, retryAt) => ({ record: { httpStatus: null, budgetDenied: true, retryAt, error: { message: reason }, elapsedMs: 0 }, observations: partNumbers.map(partNumber => ({ storeNumber, partNumber, status: 'unknown', quote: null, storeName: null, productTitle: null, observedAt: clock().toISOString(), reason: { code: reason, message: '暂缓查询，请稍后重试' } })) });
  if (remainingMs() <= 1000) return denied('request_cancelled', clock().getTime() + 1000);
  const autoShare = Math.min(0.95, Math.max(0.01, (config.collector.autoSharePercent || 80) / 100));
  const budget = await serialiseAdmission(repo, () => {
    // Waiting consumes the invocation/lease budget too. Do not reserve an
    // expired request, and choose its calendar day only when it reaches the head.
    if (remainingMs() <= 1000) return null;
    return repo.consumeCollectorBudget({ now: clock().toISOString(), maxRequestsPerMinute: config.collector.maxRequestsPerMinute, maxRequestsPerDay: config.collector.maxRequestsPerDay, budgetMode: config.collector.budgetMode, source, autoShare });
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
      fetchPickup({ storeNumber, partNumbers, fetchImpl, now: clock, timeoutMs }),
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback()), timeoutMs + 10); }),
    ]);
  } finally { clearTimeout(timer); }
  const outcome = await repo.recordUpstreamOutcome({ token: budget.token, record: result.record, success: result.observations.length > 0 && result.observations.every(item => item.status !== 'unknown'), now: clock().toISOString() });
  if (outcome.paused) result.record.retryAt = outcome.retryAt;
  return result;
}
module.exports = { guardedPickup };
