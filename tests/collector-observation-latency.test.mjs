import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { createScheduler } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const log = { info() {}, warn() {}, error() {} };
const key = 'R577|MJYH4CH/A';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function setup({ accounts = 1, intervalSeconds = 60 } = {}) {
  const f = createFixture({ config: {
    collector: { enabled: true, intervalSeconds, maxConcurrency: 1, burstIntervalSeconds: 0, availableIntervalSeconds: 0 },
    notifications: { enabled: true, cooldownMinutes: 0, templateIds: { restock: 'TPL' } },
  } });
  await f.call('user.bootstrap');
  const seed = await f.repo.getUser(userKeyOf());
  const since = new Date(f.state.now.getTime() - 60000).toISOString();
  const latest = { _id: key, storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available',
    statusSince: since, availabilityEpisodeSince: since, knownStreakSince: since,
    knownAt: new Date(f.state.now.getTime() - 1).toISOString(), observedAt: new Date(f.state.now.getTime() - 1).toISOString(), statusConfirmed: true, unknownSince: null };
  await f.repo.saveLatest(latest);
  for (let index = 0; index < accounts; index++) {
    const userKey = `latency-user-${index}`;
    await f.repo.createUser({ ...seed, _id: userKey, openid: `openid-${index}`, appid: CONSUMER_APPID, followIndex: [],
      membership: { expiresAt: '2027-10-15T00:00:00.000Z' }, subscriptions: { TPL: { credits: 3 } } });
    const followId = `${userKey}|follow`;
    await f.repo.saveFollow({ _id: followId, userKey, partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active', createdAt: since });
    await f.repo.saveNotification({ _id: `${userKey}|${key}|restock_confirmed|${since}`, userKey, followId,
      eventType: 'restock_confirmed', storeNumber: 'R577', partNumber: 'MJYH4CH/A', templateId: 'TPL',
      detectedAt: since, stockStatusSince: since, availabilityEpisodeSince: since,
      createdAt: f.state.now.toISOString(), status: 'pending', attempts: 0 });
  }
  const upstream = fakeFetch(() => ({ display: 'available' }));
  const run = options => runScheduled({ repo: f.repo, fetchImpl: upstream, clock: () => new Date(f.state.now),
    log, sleep: async ms => f.advance(ms), ...options });
  return { f, latest, upstream, run };
}

test('a slow notification backlog cannot consume the scheduled scan window before inventory starts', async () => {
  const s = await setup({ accounts: 20 });
  const start = s.f.state.now.getTime();
  const requests = [], sends = [];
  const fetchImpl = async (...args) => { requests.push(s.f.state.now.getTime() - start); return s.upstream(...args); };
  const result = await s.run({ fetchImpl, maxRunMs: 35000, sendImpl: async (message, options) => {
    const elapsed = s.f.state.now.getTime() - start;
    sends.push({ elapsed, timeoutMs: options.timeoutMs });
    assert.ok(options.timeoutMs <= 35000 - elapsed - 1000, 'every send reserves invocation cleanup time');
    assert.ok(options.timeoutMs <= 8000, 'sender timeout remains bounded');
    s.f.advance(Math.min(7000, options.timeoutMs));
    return { errcode: 0 };
  } });
  assert.deepEqual(requests, [0], 'the old serial drain consumed 35 seconds and made zero inventory requests');
  assert.equal(result.scanned, 1);
  assert.ok(sends.length > 1 && sends.length < 20, 'outbox progress is bounded by this invocation');
  assert.ok(s.f.state.now.getTime() - start <= 35000);
  assert.equal([...s.f.repo.tables.get(C.notifications).values()].filter(row => row.status === 'sending').length, 0);
  const status = await s.f.repo.getCollectorStatus();
  assert.equal(status.stats.observations, 1);
  assert.equal(status.stats.sent, sends.length);
});

test('an exceptional scheduled exit waits for the one active send before releasing its lease', async () => {
  const s = await setup();
  const entered = gate(), answer = gate(), failed = gate();
  let completed = false, releases = 0;
  const release = s.f.repo.releaseLease;
  s.f.repo.releaseLease = async args => { releases++; return release(args); };
  const saveStatus = s.f.repo.saveCollectorStatus;
  let first = true;
  s.f.repo.saveCollectorStatus = async status => {
    if (first) { first = false; await entered.promise; failed.resolve(); throw new Error('heartbeat unavailable'); }
    return saveStatus(status);
  };
  const run = s.run({ sendImpl: async () => { entered.resolve(); await answer.promise; return { errcode: 0 }; } });
  const checked = assert.rejects(run, /heartbeat unavailable/).finally(() => { completed = true; });
  try {
    await failed.promise;
    await turn();
    assert.equal(completed, false, 'the function must not return with an active send');
    assert.equal(releases, 0, 'a second worker cannot acquire the lease while the send is unresolved');
  } finally { answer.resolve(); }
  await checked;
  assert.equal(releases, 1);
  assert.equal([...s.f.repo.tables.get(C.notifications).values()].filter(row => row.status === 'accepted').length, 1);
});

test('inventory reversal during a concurrent credit reservation is rechecked before sending and refunds the permission', async () => {
  const s = await setup();
  const reserved = gate(), sampled = gate();
  const reserve = s.f.repo.reserveSubscriptionCredit;
  s.f.repo.reserveSubscriptionCredit = async args => {
    const result = await reserve(args);
    reserved.resolve();
    await sampled.promise;
    return result;
  };
  const record = s.f.repo.recordObservation;
  s.f.repo.recordObservation = async args => { const result = await record(args); sampled.resolve(); return result; };
  const unavailable = fakeFetch(() => ({ display: 'unavailable' }));
  let sends = 0;
  const result = await s.run({ fetchImpl: async (...args) => { await reserved.promise; s.f.advance(1); return unavailable(...args); },
    sendImpl: async () => { sends++; return { errcode: 0 }; } });
  assert.equal(result.scanned, 1);
  assert.equal(sends, 0);
  const original = [...s.f.repo.tables.get(C.notifications).values()].find(row => row.eventType === 'restock_confirmed');
  assert.equal(original.reason, 'event_superseded');
  assert.equal((await s.f.repo.getUser('latency-user-0')).subscriptions.TPL.credits, 3);
});

test('a shorter healthy no-stock cadence takes effect on the next cold start, including legacy checkpoints', async () => {
  for (const legacy of [false, true]) {
    const s = await setup({ intervalSeconds: 300 });
    const upstream = fakeFetch(() => ({ display: 'unavailable' }));
    assert.equal((await s.run({ fetchImpl: upstream })).scanned, 1);
    const checkpoint = await s.f.repo.getCollectorStatus();
    assert.equal(checkpoint.scheduler.targets[0].nextDueAt - s.f.state.now.getTime(), 300000);
    if (legacy) { delete checkpoint.scheduler.intervalMs; await s.f.repo.saveCollectorStatus(checkpoint); }
    const config = await s.f.repo.getConfig();
    await s.f.repo.saveConfig({ ...config, collector: { ...config.collector, intervalSeconds: 60 } });
    s.f.advance(59000);
    assert.equal((await s.run({ fetchImpl: upstream })).scanned, 0, 'shortened cadence still cannot duplicate the current minute');
    s.f.advance(1000);
    assert.equal((await s.run({ fetchImpl: upstream })).scanned, 1, 'old five-minute due time must not override the new one-minute cadence');
    assert.equal((await s.run({ fetchImpl: upstream })).scanned, 0, 'a duplicate minute trigger stays suppressed');
    assert.equal(upstream.calls.length, 2);
  }
});

test('changing the normal cadence preserves source backoff, shared admission, and unexplained future due times', async () => {
  let now = 0;
  const options = { clock: () => new Date(now), intervalMs: 300000, alignIntervalMs: 60000,
    fetchPickup: async () => ({ record: { httpStatus: 200 }, observations: [{ status: 'unavailable' }] }), onBatch: async () => ({ persisted: true }), log };
  const groups = [{ key: 'R577|MJYH4CH/A', storeNumber: 'R577', partNumbers: ['MJYH4CH/A'] }];
  const first = createScheduler(options); first.setTargets(groups); await Promise.all(first.tick());
  const saved = JSON.parse(JSON.stringify(first.checkpoint()));
  now = 60000;
  const scenarios = [
    { label: 'failure backoff', patch: c => { c.targets[0].failures = 1; }, due: 300000 },
    { label: 'per-target guard', patch: c => { c.targets[0].guardUntil = 240000; c.targets[0].guardReason = 'capacity_wait'; }, due: 300000 },
    { label: 'shared admission', patch: c => { c.admissionUntil = 240000; c.admissionReason = 'capacity_wait'; }, due: 240000 },
    { label: 'unexplained old wait', patch: c => { c.targets[0].nextDueAt = 900000; }, due: 900000 },
    { label: 'source Retry-After', patch: c => { c.breaker.state = 'open'; c.breaker.until = 240000; c.breaker.reason = 'http_429'; }, due: 60000 },
  ];
  for (const scenario of scenarios) {
    const checkpoint = structuredClone(saved); scenario.patch(checkpoint);
    const cold = createScheduler({ ...options, intervalMs: 60000 }); cold.setTargets(groups); cold.restore(checkpoint);
    assert.equal(cold.snapshot().targets[0].dueInMs, scenario.due - now, scenario.label);
    assert.equal(cold.tick().length, 0, scenario.label);
  }
});

test('capacity-driven four-minute observations recover when target count falls without raising request budgets', async () => {
  const s = await setup({ accounts: 6 });
  for (let index = 0; index < 6; index++) {
    const follow = await s.f.repo.getFollow(`latency-user-${index}|follow`);
    await s.f.repo.saveFollow({ ...follow, storeNumbers: Array.from({ length: index === 5 ? 2 : 3 }, (_, offset) => `R${300 + index * 3 + offset}`) });
  }
  const upstream = fakeFetch(() => ({ display: 'unavailable' }));
  assert.equal((await s.run({ fetchImpl: upstream })).scanned, 17);
  const status = await s.f.repo.getCollectorStatus();
  assert.equal(status.intervalMs, 183600, '17 groups share the unchanged 8,000 automatic requests/day rate');
  assert.ok(status.scheduler.targets.every(target => target.nextDueAt - s.f.state.now.getTime() === 240000), 'minute triggering rounds that cadence up to four minutes');
  for (let index = 1; index < 6; index++) {
    const follow = await s.f.repo.getFollow(`latency-user-${index}|follow`);
    await s.f.repo.saveFollow({ ...follow, status: 'paused' });
  }
  s.f.advance(60000);
  assert.equal((await s.run({ fetchImpl: upstream })).scanned, 3, 'the remaining stores resume their one-minute cadence immediately');
  assert.equal((await s.f.repo.getCollectorStatus()).budget.maxRequestsPerDay, status.budget.maxRequestsPerDay);
  assert.equal(upstream.calls.length, 20);
});

test('follow presentation separates the last attempted check from the last valid inventory observation', async () => {
  const { presentLatest } = require('../cloudfunctions/gxs_api/lib/services/follows');
  const s = await setup();
  s.f.advance(60000);
  const latest = { ...s.latest, observedAt: s.f.state.now.toISOString(), unknownSince: s.f.state.now.toISOString() };
  const config = require('../cloudfunctions/gxs_api/lib/config').mergeConfig(await s.f.repo.getConfig());
  const row = presentLatest(latest, { config, now: s.f.state.now });
  assert.equal(row.observedAt, s.f.state.now.toISOString());
  assert.equal(row.knownAt, s.latest.knownAt);
  assert.notEqual(row.observedAt, row.knownAt);
  assert.equal(presentLatest(latest, { config, now: s.f.state.now }, true).knownAt, null);
});
