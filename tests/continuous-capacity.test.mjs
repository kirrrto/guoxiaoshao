import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, operatorContext, userKeyOf } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { CAPACITY_ID, reserveCapacity } = require('../cloudfunctions/gxs_api/lib/engine/capacity-budget');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { buildGroups } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { guardedPickup } = require('../cloudfunctions/gxs_api/lib/engine/guarded-pickup');

const ok = r => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const limits = { budgetMode: 'continuous', maxRequestsPerMinute: 10, maxRequestsPerDay: 8640 };
const take = (f, source = 'manual', options = {}) => f.repo.consumeCollectorBudget({ now: f.state.now.toISOString(), ...limits, ...options, source });
const quiet = { info() {}, warn() {}, error() {} };

test('continuous capacity and shared freshness are the validated production defaults', () => {
  const config = mergeConfig(null);
  assert.equal(config.collector.budgetMode, 'continuous');
  assert.equal(config.query.sharedFreshnessSeconds, 10);
  validateConfig(config);
  for (const budgetMode of ['continuous', 'daily']) validateConfig(mergeConfig({ collector: { budgetMode } }));
  for (const sharedFreshnessSeconds of [0, 30]) validateConfig(mergeConfig({ query: { sharedFreshnessSeconds } }));
  for (const sharedFreshnessSeconds of [-1, 31, 0.5]) assert.throws(() => validateConfig(mergeConfig({ query: { sharedFreshnessSeconds } })));
  assert.throws(() => validateConfig(mergeConfig({ collector: { budgetMode: 'unlimited' } })));
});

test('concurrent reservations share one burst and reserve both active lanes', async () => {
  const f = createFixture();
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => take(f, i % 2 ? 'manual' : 'auto')));
  const allowed = results.filter(r => r.allowed);
  assert.equal(allowed.length, 10);
  assert.equal(allowed.filter(r => r.source === 'auto').length, 8);
  assert.equal(allowed.filter(r => r.source === 'manual').length, 2);
  const daily = f.repo.tables.get(C.config).get('collector_budget_2026-09-15');
  assert.equal(daily.dayCount, 10);
  assert.equal(daily.autoCount, 8);
  assert.equal(daily.manualCount, 2);
  assert.ok(results.filter(r => !r.allowed).every(r => r.retryAt > f.state.now.getTime()));
});

test('unused capacity can be borrowed while one request stays reserved for the idle lane', async () => {
  const f = createFixture();
  for (let i = 0; i < 9; i++) assert.equal((await take(f, 'manual')).allowed, true);
  const blocked = await take(f, 'manual');
  assert.equal(blocked.reason, 'capacity_wait');
  assert.equal((await take(f, 'auto')).allowed, true, 'idle monitor can immediately claim its reserved request');
  f.advance(60000);
  const auto = await take(f, 'auto');
  const manual = await take(f, 'manual');
  assert.equal(auto.allowed, true);
  assert.equal(manual.allowed, true);
});

test('sustained contention remains within the refill envelope with progress for both lanes', async () => {
  const f = createFixture();
  const counts = { auto: 0, manual: 0 };
  const waits = [];
  for (let second = 0; second < 3600; second++) {
    for (const source of ['auto', 'manual']) {
      const result = await take(f, source);
      if (result.allowed) counts[source]++;
      else waits.push(result.retryAt - f.state.now.getTime());
    }
    f.advance(1000);
  }
  assert.ok(counts.auto >= 288 && counts.auto <= 296, JSON.stringify(counts));
  assert.ok(counts.manual >= 72 && counts.manual <= 74, JSON.stringify(counts));
  assert.ok(counts.auto + counts.manual <= 370, 'initial burst plus 360 requests/hour');
  assert.ok(Math.max(...waits) <= 60000, 'capacity restores within a minute at these configured rates');
});

test('Beijing midnight resets accounting without refilling cross-day capacity', async () => {
  const f = createFixture({ start: '2026-09-15T15:59:59.000Z' });
  for (let i = 0; i < 9; i++) assert.equal((await take(f, 'manual')).allowed, true);
  assert.equal((await take(f, 'auto')).allowed, true);
  f.advance(1000);
  const afterMidnight = await take(f, 'manual');
  assert.equal(afterMidnight.allowed, false);
  assert.equal(afterMidnight.reason, 'capacity_wait');
  assert.ok(afterMidnight.sharedTokens < 1);
  f.advance(50000);
  assert.equal((await take(f, 'manual')).allowed, true);
  const next = f.repo.tables.get(C.config).get('collector_budget_2026-09-16');
  assert.equal(next.dayCount, 1);
  assert.equal(next.manualCount, 1);
});

test('an exhausted legacy counter migrates without minting a burst or waiting for midnight', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl, config: { collector: { ...limits } } });
  f.repo.tables.get(C.config).set('collector_budget_2026-09-15', { _id: 'collector_budget_2026-09-15', dayCount: 8640 });
  const call = () => guardedPickup({ repo: f.repo, config: mergeConfig(f.repo.tables.get(C.config).get('runtime')), clock: () => new Date(f.state.now),
    fetchImpl, storeNumber: 'R577', partNumbers: ['MXXX1CH/A'], timeoutMs: 100 });
  const first = await call();
  assert.equal(first.record.error.message, 'capacity_wait');
  assert.equal(fetchImpl.calls.length, 0);
  assert.ok(first.record.retryAt - f.state.now.getTime() <= 50001);
  f.advance(first.record.retryAt - f.state.now.getTime());
  assert.equal((await call()).record.httpStatus, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(f.repo.tables.get(C.config).get('collector_budget_2026-09-15').dayCount, 8641);
});

test('partially consumed legacy budget seeds at most one shared request', async () => {
  const f = createFixture();
  f.repo.tables.get(C.config).set('collector_budget_2026-09-15', { _id: 'collector_budget_2026-09-15', dayCount: 1 });
  assert.equal((await take(f, 'manual')).allowed, true);
  assert.equal((await take(f, 'auto')).reason, 'capacity_wait');
});

test('raising configuration refills the elapsed period at the old rate and never mints a burst', () => {
  const nowMs = Date.parse('2026-09-15T02:00:00.000Z');
  let current = reserveCapacity(null, { nowMs, ...limits, source: 'manual', legacyDayCount: 8640 }).state;
  const increased = reserveCapacity(current, { nowMs: nowMs + 1000, maxRequestsPerMinute: 100, maxRequestsPerDay: 86400, source: 'manual' });
  assert.equal(increased.allowed, false);
  assert.ok(Math.abs(increased.detail.sharedTokens - 0.1) < 1e-9);
  assert.ok(Math.abs(increased.detail.sourceTokens - 0.02) < 1e-9);
  const sameInstant = reserveCapacity(increased.state, { nowMs: nowMs + 1000, maxRequestsPerMinute: 600, maxRequestsPerDay: 100000, source: 'manual' });
  assert.equal(sameInstant.allowed, false);
  assert.ok(Math.abs(sameInstant.detail.sharedTokens - 0.1) < 1e-9);
  const backwards = reserveCapacity(sameInstant.state, { nowMs: nowMs - 60000, ...limits, source: 'manual', consume: false });
  assert.equal(backwards.state.updatedAtMs, nowMs + 1000);
  const caughtUp = reserveCapacity(backwards.state, { nowMs: nowMs + 1000, ...limits, source: 'manual', consume: false });
  assert.equal(caughtUp.detail.sharedTokens, backwards.detail.sharedTokens);
});

test('the token state survives multiple Beijing days and minute denials never spend tokens', async () => {
  const f = createFixture();
  for (let i = 0; i < 9; i++) await take(f, 'manual');
  await take(f, 'auto');
  const before = structuredClone(f.repo.tables.get(C.config).get(CAPACITY_ID));
  assert.equal((await take(f)).reason, 'minute_budget');
  assert.deepEqual(f.repo.tables.get(C.config).get(CAPACITY_ID).tokens, before.tokens);
  f.advance(3 * 86400000);
  const recovered = await take(f, 'auto');
  assert.equal(recovered.allowed, true);
  assert.equal(recovered.sharedTokens, 9, 'three idle days restore only the bounded burst');
});

test('capacity inspection returns operational state without replenishing or changing demand', async () => {
  const f = createFixture();
  await take(f, 'auto');
  const before = structuredClone([...f.repo.tables.get(C.config)]);
  f.advance(60000);
  const snapshot = await f.repo.getUpstreamCapacity({ now: f.state.now.toISOString() });
  assert.equal(snapshot.day.autoCount, 1);
  assert.equal(snapshot.capacity.tokens.shared, 9);
  assert.equal(snapshot.collector, null);
  assert.deepEqual([...f.repo.tables.get(C.config)], before);
});

test('collector status reports the actual continuous lane rates and reservation counters', async () => {
  const f = createFixture({ config: { collector: { ...limits, enabled: true } }, fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'capacity-status-member' }, operatorContext()));
  ok(await f.call('follow.upsert', { followId: 'capacity-status-follow', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
  const collector = createCollector({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => new Date(f.state.now), log: quiet });
  const result = await collector.step();
  await Promise.all(result.started);
  const status = await collector.publishStatus();
  assert.equal(status.budget.budgetMode, 'continuous');
  assert.equal(status.budget.refillPerSecond, 0.1);
  assert.ok(Math.abs(status.budget.sourceRefillPerSecond - 0.08) < 1e-9);
  assert.deepEqual(status.budget.sourceCounts, { auto: 1, manual: 0 });
  await collector.lease.release();
});

test('both collector modes scale with deduplicated request groups beyond nine users and one hour', async () => {
  const identical = Array.from({ length: 1000 }, (_, i) => ({ userKey: `u${i}`, storeNumbers: ['R577'], partNumber: 'MXXX1CH/A' }));
  assert.equal(buildGroups(identical).length, 1, 'a thousand followers of one target create one group');
  const f = createFixture({ config: { collector: { budgetMode: 'continuous', enabled: true, maxRequestsPerDay: 10000 } } });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'capacity-growth-member' }, operatorContext()));
  // Preserve the 400 independent request groups while assigning each to a
  // real fixture account within its plan allowance (not 400 follows on one).
  const seed = await f.repo.getUser(userKeyOf());
  for (let i = 0; i < 400; i++) {
    const userKey = `capacity-member-${i}`;
    await f.repo.createUser({ ...seed, _id: userKey, followIndex: [] });
    await f.repo.saveFollow({ _id: `${userKey}|follow`, userKey, partNumber: 'MXXX1CH/A',
      storeNumbers: [`R${String(i).padStart(3, '0')}`], status: 'active', createdAt: f.state.now.toISOString() });
  }
  for (const mode of ['scheduled', 'resident']) {
    const collector = createCollector({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => new Date(f.state.now), mode, log: quiet });
    await collector.refreshTargets();
    assert.equal(collector.scheduler.snapshot().groupCount, 400);
    assert.equal(collector.scheduler.snapshot().intervalMs, 4320000, `${mode}: 400 groups get a sustainable 72-minute interval`);
  }
});
