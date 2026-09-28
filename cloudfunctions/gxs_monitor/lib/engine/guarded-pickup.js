'use strict';
const { fetchPickup } = require('../apple-pickup');

async function guardedPickup({ repo, config, clock, fetchImpl, storeNumber, partNumbers, timeoutMs, beforeRequest = async () => true, onBudget = () => {}, remainingMs = () => Infinity }) {
  const denied = (reason, retryAt) => ({ record: { httpStatus: null, budgetDenied: true, retryAt, error: { message: reason }, elapsedMs: 0 }, observations: partNumbers.map(partNumber => ({ storeNumber, partNumber, status: 'unknown', quote: null, storeName: null, productTitle: null, observedAt: clock().toISOString(), reason: { code: reason, message: '暂缓查询，请稍后重试' } })) });
  if (remainingMs() <= 1000) return denied('request_cancelled', clock().getTime() + 1000);
  const budget = await repo.consumeCollectorBudget({ now: clock().toISOString(), maxRequestsPerMinute: config.collector.maxRequestsPerMinute, maxRequestsPerDay: config.collector.maxRequestsPerDay });
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
