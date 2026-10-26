import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { guardedPickup } = require('../cloudfunctions/gxs_api/lib/engine/guarded-pickup');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const config = mergeConfig({ collector: { budgetMode: 'continuous', maxRequestsPerMinute: 60, maxRequestsPerDay: 86400 } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
const allowed = id => ({ allowed: true, token: { id, generation: 0, probe: false }, dayCount: 1 });
function fixture() {
  let nowMs = Date.parse('2026-10-26T07:00:00.000Z');
  const admissions = [], reports = [], outcomes = [];
  const repo = {
    async consumeCollectorBudget(args) { admissions.push(args); return allowed(`budget-${admissions.length}`); },
    async recordUpstreamOutcome(args) { outcomes.push(args); return { paused: false }; },
  };
  const fetchImpl = fakeFetch(() => ({ display: 'available' }));
  const clock = () => new Date(nowMs);
  const call = overrides => guardedPickup({ repo, config, clock, fetchImpl, storeNumber: 'R577',
    partNumbers: ['MXXX1CH/A'], timeoutMs: 2000, onBudget: value => reports.push(value), ...overrides });
  return { repo, call, clock, advance: ms => { nowMs += ms; }, admissions, reports, outcomes, fetchImpl };
}

test('same-repository admission never overlaps while HTTP and outcome persistence remain concurrent', { timeout: 4000 }, async t => {
  const s = fixture();
  const budgetGate = deferred(), firstBudgetStarted = deferred(), firstHttpGate = deferred(), secondHttpStarted = deferred();
  const firstOutcomeGate = deferred(), firstOutcomeStarted = deferred();
  t.after(() => { budgetGate.resolve(); firstHttpGate.resolve(); firstOutcomeGate.resolve(); });
  let activeAdmissions = 0, maxAdmissions = 0, activeHttp = 0, maxHttp = 0;
  s.repo.consumeCollectorBudget = async args => {
    s.admissions.push(args); const id = `budget-${s.admissions.length}`;
    activeAdmissions++; maxAdmissions = Math.max(maxAdmissions, activeAdmissions);
    try {
      if (id === 'budget-1') { firstBudgetStarted.resolve(); await budgetGate.promise; }
      return allowed(id);
    } finally { activeAdmissions--; }
  };
  const fetchImpl = async (url, options) => {
    const store = new URL(String(url)).searchParams.get('store');
    activeHttp++; maxHttp = Math.max(maxHttp, activeHttp);
    try {
      if (store === 'R577') await firstHttpGate.promise;
      if (store === 'R639') secondHttpStarted.resolve();
      return await s.fetchImpl(url, options);
    } finally { activeHttp--; }
  };
  s.repo.recordUpstreamOutcome = async args => {
    s.outcomes.push(args);
    if (args.token.id === 'budget-1') { firstOutcomeStarted.resolve(); await firstOutcomeGate.promise; }
    return { paused: false };
  };
  const first = s.call({ fetchImpl });
  const second = s.call({ storeNumber: 'R639', fetchImpl });
  await firstBudgetStarted.promise; await turn();
  assert.equal(s.admissions.length, 1, 'the second transaction waits for the first admission to settle');
  budgetGate.resolve();
  await secondHttpStarted.promise;
  assert.equal((await second).record.httpStatus, 200, 'second HTTP finishes while the first HTTP is still pending');
  assert.equal(maxAdmissions, 1);
  assert.equal(maxHttp, 2, 'upstream concurrency is preserved');
  firstHttpGate.resolve(); await firstOutcomeStarted.promise;
  assert.equal((await s.call({ storeNumber: 'R389', fetchImpl })).record.httpStatus, 200,
    'an unfinished outcome cannot block the next admission');
  firstOutcomeGate.resolve(); await first;
  assert.equal(s.reports.length, 3); assert.equal(s.outcomes.length, 3);
});

test('an invocation or lease deadline reached in the queue cancels without a second reservation', { timeout: 4000 }, async t => {
  const s = fixture(), gate = deferred(), started = deferred();
  t.after(() => gate.resolve());
  const consume = s.repo.consumeCollectorBudget;
  s.repo.consumeCollectorBudget = async args => { started.resolve(); await gate.promise; return consume(args); };
  const first = s.call();
  const deadline = s.clock().getTime() + 3000;
  let expiredReports = 0;
  const second = s.call({ remainingMs: () => deadline - s.clock().getTime(), onBudget: () => { expiredReports++; } });
  await started.promise; s.advance(2000); gate.resolve();
  assert.equal((await second).record.error.message, 'request_cancelled');
  await first;
  assert.equal(s.admissions.length, 1); assert.equal(s.fetchImpl.calls.length, 1);
  assert.equal(expiredReports, 0, 'no budget result was produced for the expired queued request');
});

test('a waiting deadline settles before a stuck head and its skipped slot never reserves later', { timeout: 2000 }, async t => {
  const s = fixture(), gate = deferred(), started = deferred();
  t.after(() => gate.resolve());
  let calls = 0, firstSettled = false, queuedReports = 0;
  s.repo.consumeCollectorBudget = async args => {
    s.admissions.push(args);
    const id = `budget-${++calls}`;
    if (calls === 1) { started.resolve(); await gate.promise; }
    return allowed(id);
  };
  const first = s.call({ beforeRequest: async () => false }).finally(() => { firstSettled = true; });
  await started.promise;
  let remaining = 1050;
  const expired = s.call({ remainingMs: () => remaining,
    onBudget: () => { queuedReports++; } });
  // This unlimited waiter stays behind the expiring slot and the live head.
  const third = s.call({ beforeRequest: async () => false });
  remaining = 1000;
  assert.equal((await expired).record.error.message, 'request_cancelled');
  assert.equal(firstSettled, false, 'refund/finalization can continue without waiting for the stalled transaction');
  assert.equal(calls, 1, 'cancelling a waiter must not let a later admission pass the live head');
  assert.equal(queuedReports, 0);
  gate.resolve(); await Promise.all([first, third]);
  assert.equal(calls, 2, 'the skipped request never consumes a reservation when its turn eventually arrives');
  assert.equal(s.reports.length, 2); assert.equal(s.fetchImpl.calls.length, 0);
});

test('a wait timer is cleared when admission starts and never cancels or replays a live transaction', { timeout: 2000 }, async t => {
  const s = fixture(), gate = deferred(), started = deferred();
  t.after(() => gate.resolve());
  let settled = false, calls = 0;
  s.repo.consumeCollectorBudget = async () => { calls++; started.resolve(); await gate.promise; return allowed('live'); };
  let remaining = 1050;
  const request = s.call({ remainingMs: () => remaining, beforeRequest: async () => false })
    .finally(() => { settled = true; });
  await started.promise;
  remaining = 950;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(settled, false, 'once started, a transaction keeps its original settlement semantics');
  gate.resolve();
  assert.equal((await request).record.error.message, 'request_cancelled');
  assert.equal(calls, 1); assert.equal(s.reports.length, 1, 'the completed reservation remains consumed and reported');
});

test('queued admission uses the departure time across Beijing midnight', { timeout: 4000 }, async t => {
  const f = createFixture({ start: '2026-10-26T15:59:59.000Z', config: { collector: config.collector } });
  const gate = deferred(), started = deferred(); t.after(() => gate.resolve());
  const consume = f.repo.consumeCollectorBudget;
  const admissionTimes = [];
  f.repo.consumeCollectorBudget = async args => {
    admissionTimes.push(args.now);
    const result = await consume(args);
    if (admissionTimes.length === 1) { started.resolve(); await gate.promise; }
    return result;
  };
  const call = () => guardedPickup({ repo: f.repo, config, clock: () => new Date(f.state.now),
    fetchImpl: fakeFetch(() => ({ display: 'available' })), storeNumber: 'R577', partNumbers: ['MXXX1CH/A'], timeoutMs: 100 });
  const first = call(), second = call();
  await started.promise; f.advance(2000); gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(admissionTimes, ['2026-10-26T15:59:59.000Z', '2026-10-26T16:00:01.000Z']);
  assert.equal(f.repo.tables.get(C.config).get('collector_budget_2026-10-26').dayCount, 1);
  assert.equal(f.repo.tables.get(C.config).get('collector_budget_2026-10-27').dayCount, 1);
});

test('synchronous and asynchronous admission errors reach their caller and release the queue', async t => {
  for (const synchronous of [true, false]) await t.test(synchronous ? 'synchronous throw' : 'rejected promise', async () => {
    const s = fixture(); let calls = 0;
    const failure = Error('database admission failed');
    s.repo.consumeCollectorBudget = () => {
      if (++calls === 1) { if (synchronous) throw failure; return Promise.reject(failure); }
      return Promise.resolve(allowed('next'));
    };
    const first = s.call(), rejected = assert.rejects(first, error => error === failure);
    const second = s.call();
    await rejected; assert.equal((await second).record.httpStatus, 200);
    assert.equal(calls, 2); assert.equal(s.fetchImpl.calls.length, 1); assert.equal(s.reports.length, 1);
  });
});

test('budget rejection preserves its reason and callback without blocking later admission', async () => {
  const s = fixture(), rejected = { allowed: false, reason: 'capacity_wait', retryAt: s.clock().getTime() + 3000 };
  let calls = 0;
  s.repo.consumeCollectorBudget = async () => ++calls === 1 ? rejected : allowed('next');
  const [first, second] = await Promise.all([s.call(), s.call()]);
  assert.equal(first.record.error.message, rejected.reason); assert.equal(first.record.retryAt, rejected.retryAt);
  assert.equal(second.record.httpStatus, 200); assert.equal(s.fetchImpl.calls.length, 1);
  assert.equal(s.reports[0], rejected); assert.equal(s.reports.length, 2);
});

test('post-admission cancellation retains the consumed budget and releases the queue before callbacks', async () => {
  const s = fixture();
  const cancelled = await s.call({ beforeRequest: async () => false });
  assert.equal(cancelled.record.error.message, 'request_cancelled');
  assert.equal(s.admissions.length, 1); assert.equal(s.reports.length, 1); assert.equal(s.fetchImpl.calls.length, 0);
  await assert.rejects(s.call({ onBudget: () => { throw Error('callback failed'); } }), /callback failed/);
  assert.equal((await s.call()).record.httpStatus, 200);
  assert.equal(s.admissions.length, 3, 'already-consumed reservations are not replayed or refunded');
  assert.equal(s.fetchImpl.calls.length, 1);
});

test('a blocked repository does not lock another instance sharing the transactional budget and breaker', { timeout: 4000 }, async t => {
  const f = createFixture({ config: { collector: config.collector } });
  const gate = deferred(), started = deferred(); t.after(() => gate.resolve());
  let oldToken;
  const repoA = { ...f.repo, async consumeCollectorBudget(args) { started.resolve(); await gate.promise; return f.repo.consumeCollectorBudget(args); } };
  const repoB = { ...f.repo };
  const call = (repo, overrides = {}) => guardedPickup({ repo, config, clock: () => new Date(f.state.now),
    fetchImpl: fakeFetch(() => ({ display: 'available' })), storeNumber: 'R577', partNumbers: ['MXXX1CH/A'], timeoutMs: 100, ...overrides });
  const pending = call(repoA);
  await started.promise;
  await call(repoB, { onBudget: result => { oldToken = result.token; } });
  assert.equal(f.repo.tables.get(C.config).get('collector_budget_2026-09-15').dayCount, 1);
  const paused = await f.repo.recordUpstreamOutcome({ token: oldToken, record: { httpStatus: 429 }, success: false, now: f.state.now.toISOString() });
  const generation = f.repo.tables.get(C.config).get('upstream_breaker').generation;
  await f.repo.recordUpstreamOutcome({ token: oldToken, record: { httpStatus: 200 }, success: true, now: f.state.now.toISOString() });
  assert.equal(f.repo.tables.get(C.config).get('upstream_breaker').generation, generation, 'an old success cannot erase the newer 429 generation');
  gate.resolve();
  const denied = await pending;
  assert.equal(denied.record.error.message, 'upstream_paused'); assert.equal(denied.record.retryAt, paused.retryAt);
  assert.equal(f.repo.tables.get(C.config).get('collector_budget_2026-09-15').dayCount, 1, 'the blocked instance must still consult the shared transaction');
});
