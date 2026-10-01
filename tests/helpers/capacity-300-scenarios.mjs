import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixture, fakeFetch, operatorContext, userContext, PRODUCTS, STORES } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { createHandler } = require('../../cloudfunctions/gxs_api/lib/app');
const { guardedPickup } = require('../../cloudfunctions/gxs_api/lib/engine/guarded-pickup');
const { mergeConfig } = require('../../cloudfunctions/gxs_api/lib/config');
const { COLLECTIONS: C } = require('../../cloudfunctions/gxs_api/lib/collections');
const { CAPACITY_ID, capacityLimits } = require('../../cloudfunctions/gxs_api/lib/engine/capacity-budget');
const quiet = { error() {}, warn() {}, info() {} };
export const CLIENTS = 300;
export const slowUpstreamMs = 2500;
const config = { collector: { budgetMode: 'continuous', enabled: true }, query: { sharedFreshnessSeconds: 10 } };
const requireOk = result => { if (!result.ok) throw new Error(`fixture/API rejection: ${result.error?.code}`); return result.data; };
const partOf = i => `M${String(i).padStart(4, '0')}CH/A`;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] || 0;

export async function capacityFixture({ latencyMs = 0, start = '2026-10-01T12:00:00.000Z' } = {}) {
  const fastFetch = fakeFetch(() => ({ display: 'available' }));
  const fetchImpl = async (...args) => { if (latencyMs) await delay(latencyMs); return fastFetch(...args); };
  fetchImpl.calls = fastFetch.calls;
  const products = [...PRODUCTS, ...Array.from({ length: CLIENTS }, (_, i) => ({ ...PRODUCTS[1], _id: partOf(i), partNumber: partOf(i), title: `模拟测试商品 ${i}` }))];
  const stores = [...STORES, ...Array.from({ length: CLIENTS }, (_, i) => ({ _id: `R${String(i).padStart(3, '0')}`, storeNumber: `R${String(i).padStart(3, '0')}`, name: `模拟门店 ${i}`, city: '模拟城市', province: '模拟地区' }))];
  const f = createFixture({ config, fetchImpl, products, stores, start });
  const contexts = Array.from({ length: CLIENTS }, (_, i) => userContext(`oCAPACITY${String(i).padStart(20, '0')}`));
  // Exercise the actual account bootstrap and operator grant entry points. These
  // are simulated WX contexts in memory, never an assertion of paid-order testing.
  await Promise.all(contexts.map(async context => {
    requireOk(await f.call('user.bootstrap', {}, context));
    requireOk(await f.call('admin.grantMembership', { userKey: `${context.FROM_APPID}:${context.FROM_OPENID}`, days: 30, grantId: `capacity-${context.FROM_OPENID}` }, operatorContext()));
  }));
  const counters = { targetClaims: 0, budgetChecks: 0, admitted: { auto: 0, manual: 0 }, denied: {} };
  const claim = f.repo.claimQueryTarget;
  f.repo.claimQueryTarget = async args => { counters.targetClaims++; return claim(args); };
  const consume = f.repo.consumeCollectorBudget;
  f.repo.consumeCollectorBudget = async args => {
    counters.budgetChecks++;
    const result = await consume(args);
    if (result.allowed) counters.admitted[args.source === 'auto' ? 'auto' : 'manual']++;
    else counters.denied[result.reason] = (counters.denied[result.reason] || 0) + 1;
    return result;
  };
  return { f, contexts, fetchImpl, counters, config: mergeConfig(config) };
}

function publicCapacity(s) {
  const capacity = s.f.repo.tables.get(C.config).get(CAPACITY_ID);
  const days = [...s.f.repo.tables.get(C.config).values()].filter(row => row._id.startsWith('collector_budget_')).map(row => ({
    date: row._id.slice('collector_budget_'.length), dayCount: row.dayCount, autoCount: row.autoCount || 0, manualCount: row.manualCount || 0, minuteCount: row.minuteCount || 0,
  }));
  return { tokens: capacity ? { ...capacity.tokens } : null, days };
}

export async function queryWave(s, { name, distinct = false, stores = ['R577'], wave = 0 } = {}) {
  const beforeCalls = s.fetchImpl.calls.length;
  const beforeClaims = s.counters.targetClaims;
  const beforeBudgetChecks = s.counters.budgetChecks;
  const started = performance.now();
  const rows = await Promise.all(s.contexts.map(async (wxContext, i) => {
    // New handlers on every wave model loss of all instance-local memory.
    const handler = createHandler({ repo: s.f.repo, fetchImpl: s.fetchImpl, clock: () => new Date(s.f.state.now), log: quiet });
    const begin = performance.now();
    const result = requireOk(await handler({ action: 'query.pickup', payload: { queryId: `capacity-${name}-${wave}-${i}`, partNumber: distinct ? partOf(i) : 'MXXX1CH/A', storeNumbers: stores } }, wxContext));
    return { result, elapsedMs: performance.now() - begin };
  }));
  const reasons = {};
  for (const { result } of rows) if (!result.ok) reasons[result.reason] = (reasons[result.reason] || 0) + 1;
  const results = rows.flatMap(row => row.result.results || []);
  const samples = s.fetchImpl.calls.slice(beforeCalls);
  const uniqueRequests = new Set(samples.map(call => `${call.storeNumber}|${call.parts.slice().sort().join(',')}`));
  const summary = { name, clients: CLIENTS, simulatedAt: s.f.state.now.toISOString(), requestedTargetReads: CLIENTS * stores.length,
    distinctRequestedTargets: (distinct ? CLIENTS : 1) * stores.length,
    successfulQueries: rows.filter(row => row.result.ok).length, fullySuccessfulQueries: rows.filter(row => row.result.ok && !row.result.partial).length,
    partialQueries: rows.filter(row => row.result.partial).length, busyOrFailedQueries: rows.filter(row => !row.result.ok).length, reasons,
    knownTargetReads: results.filter(row => row.status !== 'unknown').length, reusedTargetReads: results.filter(row => row.reused).length,
    upstreamHttp: samples.length, duplicateTargetHttpWithinWave: samples.length - uniqueRequests.size,
    targetClaimCalls: s.counters.targetClaims - beforeClaims, budgetChecks: s.counters.budgetChecks - beforeBudgetChecks,
    netQuotaDebit: rows.reduce((sum, row) => sum + (row.result.charged || 0) - (row.result.refunded || 0), 0),
    allResponsesConfirmMember: rows.every(row => row.result.member === true),
    localElapsedMs: Math.round(performance.now() - started),
    localLatencyMs: Object.fromEntries([['p50', .5], ['p95', .95], ['p99', .99], ['max', 1]].map(([label, fraction]) => [label, Math.round(percentile(rows.map(row => row.elapsedMs), fraction))])),
    ...publicCapacity(s),
  };
  return summary;
}

export async function runBurstScenario({ name, distinct = false, stores = ['R577'], latencyMs = 0 } = {}) {
  const s = await capacityFixture({ latencyMs });
  const report = await queryWave(s, { name, distinct, stores });
  const latest = [...s.f.repo.tables.get(C.latest).values()];
  return { ...report, simulatedUpstreamLatencyMs: latencyMs, persistedSamples: latest.reduce((sum, item) => sum + item.sampleCount, 0),
    falseConfirmationsFromSharedReads: latest.filter(item => item.sampleCount === 1 && item.statusConfirmed).length,
    all300ImmediateResults: report.fullySuccessfulQueries === CLIENTS };
}

export async function runSustainedScenario() {
  const s = await capacityFixture({ start: '2026-10-01T15:59:00.000Z' });
  const limits = s.config.collector;
  const start = s.f.state.now.getTime();
  const autoWave = () => Promise.all(Array.from({ length: CLIENTS }, (_, i) => guardedPickup({ repo: s.f.repo, config: s.config,
    clock: () => new Date(s.f.state.now), fetchImpl: s.fetchImpl, storeNumber: `R${String(i).padStart(3, '0')}`, partNumbers: ['AU000CH/A'], timeoutMs: 8000, source: 'auto' })));
  const waves = [];
  // Four bounded waves test conservation and midnight without turning the
  // eager-copy in-memory transaction model into a misleading CPU benchmark.
  const waveCount = 4;
  for (let wave = 0; wave < waveCount; wave++) {
    const beforeHttp = s.fetchImpl.calls.length;
    const [manual, automatic] = await Promise.all([queryWave(s, { name: 'sustained', distinct: true, wave }), autoWave()]);
    const capacity = publicCapacity(s);
    waves.push({ wave, elapsedSimulatedSeconds: (s.f.state.now.getTime() - start) / 1000,
      manualSuccess: manual.successfulQueries, manualBusy: manual.busyOrFailedQueries, manualReasons: manual.reasons,
      autoSuccess: automatic.filter(batch => !batch.record.budgetDenied).length, autoBusy: automatic.filter(batch => batch.record.budgetDenied).length,
      netQuotaDebit: manual.netQuotaDebit, totalUpstreamHttp: s.fetchImpl.calls.length - beforeHttp, ...capacity });
    if (wave < waveCount - 1) s.f.advance(45000);
  }
  const elapsedMs = s.f.state.now.getTime() - start;
  const rates = capacityLimits(limits.maxRequestsPerMinute, limits.maxRequestsPerDay);
  return { name: 'continuous-300-manual-plus-300-auto-every-45s', clients: CLIENTS,
    simulatedSeconds: elapsedMs / 1000, crossesBeijingMidnight: true, coldHandlersPerWave: CLIENTS,
    totalManualQueries: CLIENTS * waves.length, totalAutomaticAdmissionAttempts: CLIENTS * waves.length,
    manualSuccess: waves.reduce((sum, wave) => sum + wave.manualSuccess, 0), manualBusy: waves.reduce((sum, wave) => sum + wave.manualBusy, 0),
    autoSuccess: waves.reduce((sum, wave) => sum + wave.autoSuccess, 0), totalHttp: s.fetchImpl.calls.length,
    sharedRefillEnvelope: rates.capacities.shared + elapsedMs * rates.rates.shared,
    overRefillEnvelope: s.fetchImpl.calls.length > Math.floor(rates.capacities.shared + elapsedMs * rates.rates.shared + 1e-8),
    invalidTokenBalance: waves.some(wave => Object.values(wave.tokens || {}).some(value => !Number.isFinite(value) || value < -1e-8)),
    anyMinuteExceeded: waves.some(wave => wave.days.some(day => day.minuteCount > limits.maxRequestsPerMinute)),
    netQuotaDebit: waves.reduce((sum, wave) => sum + wave.netQuotaDebit, 0), counters: s.counters, ...publicCapacity(s), waves };
}

export async function runCapacity300({ onScenario = () => {} } = {}) {
  const scenarios = [];
  for (const scenario of [
    { name: 'same-target-fast' },
    { name: 'same-target-slow', latencyMs: slowUpstreamMs },
    { name: 'same-three-stores', stores: ['R577', 'R639', 'R320'] },
    { name: 'distinct-300-targets', distinct: true },
    { name: 'distinct-900-targets', distinct: true, stores: ['R577', 'R639', 'R320'] },
  ]) { const report = await runBurstScenario(scenario); scenarios.push(report); await onScenario(report); }
  const sustained = await runSustainedScenario(); scenarios.push(sustained); await onScenario(sustained);
  return { generatedAt: new Date().toISOString(), kind: 'offline-contract-simulation', productionRequests: 0,
    limitations: ['300 simulated distinct membership contexts, not real user identities or real payments',
      'In-memory transactions serialize; CloudBase conflicts, serverless quotas and real latency are not measured',
      'HTTP is stubbed. Local wall latency is diagnostic, not a production SLO',
      'Sustained automatic demand uses the real admission guard under synthetic pressure, not a forecast of scheduler traffic'],
    config: mergeConfig(config).collector, scenarios };
}
