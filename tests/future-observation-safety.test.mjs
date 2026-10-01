import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';

const require = createRequire(import.meta.url);
const { applyObservation } = require('../cloudfunctions/gxs_api/lib/engine/events');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { createScheduler } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { observationHealth } = require('../cloudfunctions/gxs_api/lib/engine/observation-health');
const { sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const now = '2026-09-15T02:00:00.000Z', nowMs = Date.parse(now), future = '2026-09-16T02:00:00.000Z';
const observation = (status, observedAt = now) => ({ storeNumber: 'R577', partNumber: 'MXXX1CH/A', status, observedAt, source: 'auto' });
const corrupt = status => ({ _id: 'R577|MXXX1CH/A', ...observation(status, future), statusSince: now,
  knownStreakSince: now, knownAt: future, unknownSince: null, statusConfirmed: true, sampleCount: 20 });
const config = mergeConfig({ collector: { enabled: true, budgetMode: 'continuous', intervalSeconds: 8 },
  notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 0 } });

async function setup() {
  const f = createFixture({ config }); await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { TPL: { credits: 3 } } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], status: 'active' });
  return f;
}

test('a trustworthy current sample repairs future latest without fabricating transitions or continuity', () => {
  for (const status of ['available', 'unavailable', 'unknown']) {
    const repaired = applyObservation(corrupt(status === 'available' ? 'unavailable' : 'available'), observation(status), { nowMs });
    assert.equal(repaired.latest.observedAt, now);
    assert.equal(repaired.latest.statusConfirmed, false);
    assert.deepEqual(repaired.events, []);
    assert.equal(repaired.latest.sampleCount, 1);
    if (status !== 'unknown') {
      assert.equal(repaired.latest.status, status);
      assert.equal(repaired.latest.statusSince, now);
      assert.equal(repaired.latest.knownStreakSince, now);
      const next = applyObservation(repaired.latest, observation(status, '2026-09-15T02:00:01.000Z'), { nowMs: nowMs + 1000 });
      assert.equal(next.latest.statusConfirmed, true);
      assert.deepEqual(next.events, [], 'repair followed by confirmation cannot manufacture a restock event');
    } else {
      assert.equal(repaired.latest.status, null);
      assert.equal(repaired.latest.knownAt, null);
    }
  }
});

test('future repair requires server time and never rewinds an ordinary out-of-order or slightly skewed sample', () => {
  const recent = applyObservation(null, observation('unavailable', '2026-09-15T01:59:59.000Z')).latest;
  assert.equal(applyObservation(recent, observation('available', '2026-09-15T01:59:58.000Z'), { nowMs }).outcome, 'stale');
  assert.equal(applyObservation(corrupt('available'), observation('unavailable')).outcome, 'stale', 'an old input alone is not proof of a corrupt stored timestamp');
  const skewed = { ...recent, observedAt: new Date(nowMs + 20000).toISOString() };
  assert.equal(applyObservation(skewed, observation('available'), { nowMs }).outcome, 'stale');
  assert.throws(() => applyObservation(recent, observation('available', future), { nowMs }), /future/);
});

test('future repair commits a real daily observation atomically without a fabricated historical event', async () => {
  const f = await setup(); await f.repo.saveLatest(corrupt('unavailable'));
  f.repo.transactionWriteHook = async table => { if (table === C.observationDays) throw Error('daily write failed'); };
  await assert.rejects(f.repo.recordObservation({ observation: observation('available'), nowIso: now }), /daily write failed/);
  assert.equal((await f.repo.getLatest(['R577|MXXX1CH/A']))[0].observedAt, future);
  f.repo.transactionWriteHook = null;
  await f.repo.recordObservation({ observation: observation('available'), nowIso: now });
  assert.equal((await f.repo.getLatest(['R577|MXXX1CH/A']))[0].observedAt, now);
  const [daily] = await f.repo.getObservationCoverage({ partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], dayKey: '2026-09-15' });
  assert.equal(daily.sampleCount, 1); assert.equal(daily.knownCount, 1);
  assert.equal(f.repo.tables.get(C.events).size, 0);
});

test('the collector replaces a future sample with actual inventory before declaring persistence healthy', async () => {
  const f = await setup(); await f.repo.saveLatest(corrupt('available'));
  const collector = createCollector({ repo: f.repo, fetchImpl: fakeFetch({ R577: { display: 'unavailable' } }), clock: () => f.state.now,
    ownerId: 'future-repair', statusEveryMs: 0, log: { info() {}, warn() {}, error() {} } });
  const { started } = await collector.step(); await Promise.all(started); await collector.publishStatus();
  const [latest] = await f.repo.getLatest(['R577|MXXX1CH/A']);
  assert.equal(latest.status, 'unavailable'); assert.equal(latest.observedAt, now);
  assert.equal(latest.statusConfirmed, false); assert.equal(f.repo.tables.get(C.events).size, 0);
  assert.equal((await f.repo.getCollectorStatus()).observationHealth.state, 'healthy');
  assert.equal(collector.stats.observations, 1);
});

test('successful HTTP whose observation was not applied cannot refresh persistence health or saved-sample counts', async () => {
  for (const outcome of ['stale', 'duplicate']) {
    const f = await setup(), logs = [];
    f.repo.recordObservation = async ({ observation: value }) => ({ observation: value, outcome, events: [], latest: corrupt('available') });
    const collector = createCollector({ repo: f.repo, fetchImpl: fakeFetch({ R577: { display: 'unavailable' } }), clock: () => f.state.now,
      ownerId: `discarded-${outcome}`, statusEveryMs: 0, log: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) } });
    for (let i = 0; i < 2; i++) { const { started } = await collector.step(); await Promise.all(started); if (i === 0) f.advance(160000); }
    await collector.publishStatus();
    const status = await f.repo.getCollectorStatus();
    assert.equal(status.observationHealth.state, 'stalled', outcome);
    assert.equal(collector.scheduler.snapshot().targets[0].health.lastPersistedSuccessAt, null);
    assert.equal(collector.stats.batches, 0); assert.equal(collector.stats.observations, 0); assert.equal(collector.stats.lastBatchAt, null);
    assert.ok(logs.some(value => String(value).includes('collector_observation_health')));
  }
});

test('current-dated alerts cannot use future or invalid latest observations as send confirmation', async () => {
  for (const patch of [{ observedAt: future }, { knownAt: future }, { observedAt: 'invalid' }, { knownAt: 'invalid' }]) {
    const f = await setup();
    const task = { _id: 'future-confirmation', userKey: userKeyOf(), followId: 'F', eventType: 'restock_confirmed',
      partNumber: 'MXXX1CH/A', storeNumber: 'R577', detectedAt: now, createdAt: now, templateId: 'TPL', status: 'pending', attempts: 0 };
    await f.repo.saveNotification(task); await seedNotificationObservation(f.repo, task);
    const [latest] = await f.repo.getLatest(['R577|MXXX1CH/A']); await f.repo.saveLatest({ ...latest, ...patch });
    let sends = 0; const sender = async () => { sends++; return { errcode: 0 }; }; sender.appid = CONSUMER_APPID;
    const result = await sendTask({ task, config, repo: f.repo, sendImpl: sender, now: f.state.now, clock: () => f.state.now });
    assert.equal(sends, 0, JSON.stringify(patch)); assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'event_unconfirmed');
    assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  }
});

test('a future checkpoint cannot keep an unsampled target warming up across cold starts', () => {
  let time = nowMs;
  const create = () => {
    const scheduler = createScheduler({ clock: () => new Date(time), fetchPickup: async () => {}, onBatch: async () => {} });
    scheduler.setTargets([{ key: 'R577|MXXX1CH/A', storeNumber: 'R577', partNumbers: ['MXXX1CH/A'] }]);
    return scheduler;
  };
  let scheduler = create();
  const checkpoint = scheduler.checkpoint(), tomorrow = nowMs + 86400000;
  checkpoint.storeLastRequestAt = [['R577', tomorrow]];
  Object.assign(checkpoint.targets[0], { trackedAt: tomorrow, nextDueAt: tomorrow, guardUntil: tomorrow, guardReason: 'upstream_paused' });
  Object.assign(checkpoint.targets[0].health, { lastRequestAt: tomorrow, lastSuccessAt: tomorrow, lastPersistedAt: tomorrow, lastPersistedSuccessAt: tomorrow });
  scheduler.restore(checkpoint);
  const repaired = scheduler.checkpoint();
  assert.equal(repaired.targets[0].trackedAt, nowMs);
  assert.equal(repaired.targets[0].health.lastRequestAt, nowMs);
  assert.equal(repaired.storeLastRequestAt[0][1], nowMs);
  assert.equal(repaired.targets[0].nextDueAt, tomorrow, 'restoring trustworthy health must retain real scheduling/backoff deadlines');
  assert.equal(repaired.targets[0].guardUntil, tomorrow);
  for (const elapsed of [60000, 160000, 3600000]) {
    time = nowMs + elapsed;
    const saved = scheduler.checkpoint(); scheduler = create(); scheduler.restore(saved);
    const snapshot = scheduler.snapshot();
    const health = observationHealth({ targets: snapshot.targets, intervalMs: snapshot.intervalMs, mode: 'scheduled', nowMs: time });
    assert.equal(health.state, elapsed > health.staleAfterMs ? 'stalled' : 'warming_up');
    assert.equal(health.freshGroups, 0, 'future success timestamps cannot become evidence of healthy persisted observations');
    assert.equal(snapshot.targets[0].trackedAt, nowMs, 'cold starts must retain the first trusted recovery time');
    assert.equal(snapshot.targets[0].dueInMs, tomorrow - time, 'the original Retry-After remains in force');
  }
});
