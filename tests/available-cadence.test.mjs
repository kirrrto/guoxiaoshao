import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createScheduler } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config');
const quiet = { info() {}, warn() {}, error() {} };
const groups = [{ key: 'R577|A', storeNumber: 'R577', partNumbers: ['A'] }];

function harness(options = {}) {
  const state = { now: 0, status: 'available', persisted: true, persistenceError: false, denied: false, httpStatus: 200 };
  const calls = [];
  const scheduler = createScheduler({ clock: () => new Date(state.now), intervalMs: 60000, burstIntervalMs: 0, availableIntervalMs: 3000, log: quiet,
    fetchPickup: async ({ storeNumber, partNumbers }) => {
      calls.push({ at: state.now, storeNumber, partNumbers });
      if (state.denied) return { record: { budgetDenied: true, retryAt: 30000, error: { message: 'capacity_wait' } }, observations: [] };
      return { record: { httpStatus: state.httpStatus, retryAfter: state.httpStatus === 429 ? '10' : null }, observations: partNumbers.map(partNumber => ({ storeNumber, partNumber, status: state.status })) };
    },
    onBatch: async () => { if (state.persistenceError) throw Error('write failed'); return { persisted: state.persisted, changed: false }; },
    ...options });
  scheduler.setTargets(groups);
  return { state, calls, scheduler, tick: async at => { state.now = at; await Promise.all(scheduler.tick()); } };
}

test('continuous availability cadence is explicit and defaults to disabled', () => {
  assert.equal(mergeConfig(null).collector.availableIntervalSeconds, 0);
  for (const value of [0, 1, 3, 60]) validateConfig(mergeConfig({ collector: { availableIntervalSeconds: value } }));
  for (const value of [-1, 0.5, 61, '3', null, true]) assert.throws(() => validateConfig(mergeConfig({ collector: { availableIntervalSeconds: value } })), /availableIntervalSeconds/);
});

test('persisted available results remain on the three-second cadence beyond the old twenty-second quiet window', async () => {
  const h = harness();
  for (let at = 0; at <= 90000; at += 3000) await h.tick(at);
  assert.equal(h.calls.length, 31);
  assert.deepEqual(h.calls.map(call => call.at), Array.from({ length: 31 }, (_, i) => i * 3000));
  assert.equal(h.scheduler.snapshot().targets[0].available, true);
  assert.equal(h.scheduler.bursting(), true, 'bounded scheduled runs recognize active fast work too');
});

test('a known non-available result stops the availability cadence without creating another status-change burst', async () => {
  for (const status of ['unavailable', 'pending', 'ineligible']) {
    const h = harness();
    await h.tick(0); await h.tick(3000);
    h.state.status = status; await h.tick(6000);
    assert.equal(h.scheduler.snapshot().targets[0].available, false, status);
    assert.equal(h.scheduler.nextDueInMs(), 60000, status);
    assert.equal(h.scheduler.bursting(), false, status);
    await h.tick(9000); assert.equal(h.calls.length, 3, status);
  }
});

test('unknown and failed or superseded persistence never establish continued availability', async () => {
  for (const failure of ['unknown', 'throw', 'not_persisted']) {
    const h = harness(); await h.tick(0);
    if (failure === 'unknown') h.state.status = 'unknown';
    if (failure === 'throw') h.state.persistenceError = true;
    if (failure === 'not_persisted') h.state.persisted = false;
    await h.tick(3000);
    assert.equal(h.scheduler.snapshot().targets[0].available, false, failure);
    assert.equal(h.scheduler.bursting(), false, failure);
    assert.equal(h.scheduler.nextDueInMs(), failure === 'not_persisted' ? 60000 : 3000, 'store spacing remains a lower bound even during failure backoff');
    if (failure !== 'not_persisted') assert.equal(h.scheduler.checkpoint().targets[0].nextDueAt, 5000, 'the original two-second backoff is retained behind store spacing');
  }
});

test('available cadence survives checkpoints and an old or future checkpoint cannot invent availability', async () => {
  const h = harness(); await h.tick(0); await h.tick(3000);
  const saved = JSON.parse(JSON.stringify(h.scheduler.checkpoint()));
  const restarted = harness(); restarted.state.now = 4000; restarted.scheduler.restore(saved);
  assert.equal(restarted.scheduler.snapshot().targets[0].available, true);
  assert.equal(restarted.scheduler.nextDueInMs(), 2000);
  await restarted.tick(6000); assert.equal(restarted.calls.length, 1);
  for (const variant of ['legacy', 'future', 'unpersisted']) {
    const invalid = structuredClone(saved);
    if (variant === 'legacy') { delete invalid.targets[0].available; delete invalid.targets[0].availableObservedAt; }
    if (variant === 'future') invalid.targets[0].availableObservedAt = 10000;
    if (variant === 'unpersisted') invalid.targets[0].health.persistenceFailed = true;
    const cold = harness(); cold.state.now = 4000; cold.scheduler.restore(invalid);
    assert.equal(cold.scheduler.snapshot().targets[0].available, false, variant);
  }
});

test('explicit enable and disable apply to resident and restored schedules without clearing guard waits', async () => {
  const h = harness({ availableIntervalMs: 0 }); await h.tick(0);
  assert.equal(h.scheduler.nextDueInMs(), 60000);
  h.state.now = 1000; h.scheduler.configure({ availableIntervalMs: 3000 });
  assert.equal(h.scheduler.nextDueInMs(), 2000);
  const saved = structuredClone(h.scheduler.checkpoint());
  h.scheduler.configure({ availableIntervalMs: 0 }); assert.equal(h.scheduler.nextDueInMs(), 59000);
  const disabled = harness({ availableIntervalMs: 0 }); disabled.state.now = 1000; disabled.scheduler.restore(saved);
  assert.equal(disabled.scheduler.nextDueInMs(), 59000);
  const oldDisabled = harness({ availableIntervalMs: 0 }); await oldDisabled.tick(0);
  const enabled = harness(); enabled.state.now = 1000; enabled.scheduler.restore(oldDisabled.scheduler.checkpoint());
  assert.equal(enabled.scheduler.nextDueInMs(), 2000);
  h.scheduler.configure({ availableIntervalMs: 3000 }); h.state.denied = true; await h.tick(3000);
  h.scheduler.configure({ availableIntervalMs: 0 }); h.scheduler.configure({ availableIntervalMs: 3000 });
  assert.equal(h.scheduler.nextDueInMs(), 27000);
  await h.tick(6000); assert.equal(h.calls.length, 2, 'shared admission still prevents requests');
});

test('availability mode preserves per-store spacing and Retry-After even when change bursts are disabled', async () => {
  const h = harness({ maxConcurrency: 3 });
  h.scheduler.setTargets([...groups, { key: 'R577|B', storeNumber: 'R577', partNumbers: ['B'] }]);
  await h.tick(0); await h.tick(1); assert.equal(h.calls.length, 1);
  await h.tick(2999); assert.equal(h.calls.length, 1);
  await h.tick(3000); assert.equal(h.calls.length, 2);
  h.state.status = 'unknown'; h.state.httpStatus = 429; await h.tick(6000);
  assert.equal(h.scheduler.snapshot().breaker.reason, 'http_429');
  assert.equal(h.scheduler.nextDueInMs(), 10000);
  await h.tick(9000); assert.equal(h.calls.length, 3);
});

test('the collector wires explicit availability cadence through real local observations and retains guarded admission', async () => {
  let display = 'available';
  const upstream = fakeFetch(() => ({ display }));
  const f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60, burstIntervalSeconds: 0, availableIntervalSeconds: 3,
    budgetMode: 'continuous', maxRequestsPerDay: 100000 } }, fetchImpl: upstream });
  await f.call('user.bootstrap'); await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' } });
  await f.repo.saveFollow({ _id: 'available-local-follow', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  const collector = createCollector({ repo: f.repo, fetchImpl: upstream, clock: () => new Date(f.state.now), log: quiet });
  for (let at = 0; at <= 36000; at += 3000) { if (at) f.advance(3000); const { started } = await collector.step(); await Promise.all(started); }
  assert.equal(upstream.calls.length, 13);
  assert.equal((await f.repo.getLatest(['R577|MJYH4CH/A']))[0].status, 'available');
  display = 'unavailable'; f.advance(3000); await Promise.all((await collector.step()).started);
  assert.equal(collector.scheduler.snapshot().targets[0].available, false);
  const before = upstream.calls.length; f.advance(3000); await Promise.all((await collector.step()).started);
  assert.equal(upstream.calls.length, before);
  await collector.lease.release();
});

test('an enabled available target still waits for actual capacity and stops requesting after another worker owns the lease', async () => {
  for (const restriction of ['capacity', 'lease']) {
    const upstream = fakeFetch(() => ({ display: 'available' }));
    const f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60, burstIntervalSeconds: 0, availableIntervalSeconds: 3,
      budgetMode: 'continuous', maxRequestsPerMinute: restriction === 'capacity' ? 2 : 60, maxRequestsPerDay: restriction === 'capacity' ? 1 : 100000 } }, fetchImpl: upstream });
    await f.call('user.bootstrap'); await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' } });
    await f.repo.saveFollow({ _id: 'guarded-available', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
    const collector = createCollector({ repo: f.repo, fetchImpl: upstream, clock: () => new Date(f.state.now), log: quiet });
    await Promise.all((await collector.step()).started);
    assert.equal(upstream.calls.length, 1);
    assert.equal(collector.scheduler.snapshot().targets[0].available, true);
    if (restriction === 'lease') {
      await collector.lease.release();
      await f.repo.acquireLease({ id: 'collector_lease', ownerId: 'other-worker', now: f.state.now.toISOString(), expiresAt: new Date(f.state.now.getTime() + 15000).toISOString() });
    }
    f.advance(3000); const next = await collector.step(); await Promise.all(next.started);
    assert.equal(upstream.calls.length, 1, restriction);
    if (restriction === 'capacity') {
      assert.equal(collector.scheduler.snapshot().admissionReason, 'capacity_wait');
      assert.ok(collector.scheduler.nextDueInMs() > 3000);
    } else assert.equal(next.held, false);
    await collector.lease.release();
  }
});

test('scheduled same-store SKU batches wait for enabled availability spacing even while every product is unavailable', async () => {
  for (const scenario of [
    { availableIntervalSeconds: 0, expected: [0, 0] },
    { availableIntervalSeconds: 3, expected: [0, 3000] },
    { availableIntervalSeconds: 3, maxRunMs: 2000, expected: [0] },
    { availableIntervalSeconds: 3, maxRequestsPerMinute: 1, expected: [0] },
  ]) {
    let f; const times = [];
    const upstream = fakeFetch(() => { times.push(f.state.now.getTime()); return { display: 'unavailable' }; });
    f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60, burstIntervalSeconds: 0,
      availableIntervalSeconds: scenario.availableIntervalSeconds, budgetMode: 'continuous', maxPartsPerRequest: 1,
      maxRequestsPerMinute: scenario.maxRequestsPerMinute || 60, maxRequestsPerDay: 100000 } }, fetchImpl: upstream });
    await f.call('user.bootstrap'); await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' } });
    for (const partNumber of ['MJYH4CH/A', 'MXXX1CH/A']) {
      await f.repo.saveFollow({ _id: `same-store-${partNumber}`, userKey: userKeyOf(), partNumber, storeNumbers: ['R577'], status: 'active' });
    }
    const start = f.state.now.getTime();
    await runScheduled({ repo: f.repo, fetchImpl: upstream, clock: () => new Date(f.state.now), log: quiet,
      maxRunMs: scenario.maxRunMs || 35000, sleep: async ms => f.advance(ms) });
    assert.deepEqual(times.map(at => at - start), scenario.expected, JSON.stringify(scenario));
    if (scenario.maxRunMs) assert.ok(f.state.now.getTime() - start < scenario.maxRunMs, 'deadline never stretched to fit a later batch');
    if (scenario.maxRequestsPerMinute) assert.equal((await f.repo.getCollectorStatus()).budget.reason, 'minute_budget');
  }
});
