import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { monitoringSnapshot } = require('../cloudfunctions/gxs_api/lib/monitor-readiness');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { createScheduler } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { observationHealth } = require('../cloudfunctions/gxs_api/lib/engine/observation-health');
const config = mergeConfig({ collector: { enabled: true }, notifications: { enabled: true, templateIds: { restock: 'TPL' } } });
const now = new Date('2026-10-01T13:58:04.585Z');
const target = (key, successAt, more = {}) => ({ key, nextDueAt: now.getTime() + 10000,
  trackedAt: now.getTime() - 3600000,
  health: { lastSuccessAt: successAt, lastPersistedAt: successAt, persistenceFailed: false }, ...more });
const heartbeat = targets => ({ mode: 'scheduled', state: 'running', groupCount: targets.length, intervalMs: 194400,
  updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 150000).toISOString(),
  scheduler: { version: 1, targets }, stats: { lastBatchAt: '2026-10-01T04:08:11.855Z' },
  notifications: { enabled: true, authReady: true, authState: 'ready', validUntil: new Date(now.getTime() + 3600000).toISOString() } });

test('fresh timer heartbeats cannot declare delivery ready when all 17 real observations stopped hours ago', () => {
  const targets = Array.from({ length: 17 }, (_, i) => target(`R${i}|SKU`, Date.parse('2026-10-01T04:08:11.855Z')));
  const result = monitoringSnapshot(config, heartbeat(targets), now);
  assert.equal(result.collector.stale, false, 'the worker heartbeat is genuinely fresh');
  assert.equal(result.collector.state, 'running', 'preserve the existing worker-state contract');
  assert.equal(result.collector.observationHealth.state, 'stalled');
  assert.equal(result.collector.observationHealth.staleGroups, 17);
  assert.equal(result.notifications.deliveryReady, false);
  assert.equal(result.notifications.reason, 'collector_observation_stale');
});

test('a healthy target cannot hide another stalled target or unpersisted success', () => {
  const targets = [target('fresh', now.getTime() - 1000), target('stalled', now.getTime() - 3600000),
    target('not-persisted', now.getTime() - 1000, { health: { lastSuccessAt: now.getTime() - 1000, lastPersistedAt: now.getTime() - 3600000, persistenceFailed: true } })];
  const result = monitoringSnapshot(config, heartbeat(targets), now);
  assert.equal(result.collector.observationHealth.state, 'degraded');
  assert.equal(result.collector.observationHealth.freshGroups, 1);
  assert.equal(result.collector.observationHealth.staleGroups, 2);
  assert.equal(result.notifications.deliveryReady, false);
});

test('business freshness follows sustainable coverage cadence, not a fixed heartbeat timeout', () => {
  const targets = [target('slow', now.getTime() - 70 * 60000)];
  const result = monitoringSnapshot(config, { ...heartbeat(targets), intervalMs: 72 * 60000 }, now);
  assert.equal(result.collector.observationHealth.state, 'healthy');
  assert.equal(result.collector.observationStale, false);
  assert.equal(result.notifications.deliveryReady, true);
  const idle = monitoringSnapshot(config, { ...heartbeat([]), state: 'idle' }, now);
  assert.equal(idle.collector.observationHealth.state, 'idle');
  assert.equal(idle.notifications.deliveryReady, true);
});

test('unobserved targets receive bounded startup grace and cannot reset it at each cold start', async () => {
  const f = createFixture({ config: { collector: { enabled: true }, notifications: { enabled: false } } });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), status: 'active', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] });
  const original = f.state.now.getTime();
  const warnings = [];
  const log = { info: value => warnings.push(value), warn: value => warnings.push(value), error: value => warnings.push(value) };
  const run = () => runScheduled({ repo: f.repo, clock: () => new Date(f.state.now), maxRunMs: 0, log, fetchImpl: fakeFetch({}) });
  await run();
  let status = await f.repo.getCollectorStatus();
  assert.equal(status.scheduler.targets[0].trackedAt, original);
  assert.equal(status.observationHealth.state, 'warming_up');
  f.advance(10 * 60000);
  await run();
  status = await f.repo.getCollectorStatus();
  assert.equal(status.scheduler.targets[0].trackedAt, original);
  assert.equal(status.observationHealth.state, 'stalled');
  assert.equal(status.observationHealth.staleGroups, 1);
  const alert = warnings.map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value && value.event === 'collector_observation_health');
  assert.equal(alert.severity, 'error');
  assert.equal(alert.staleGroups, 1);
});

test('unknown observations and a failed write do not refresh the last durably successful observation', async () => {
  let time = now.getTime();
  let status = 'available';
  let failWrite = false;
  const scheduler = createScheduler({ clock: () => new Date(time), intervalMs: 60000,
    fetchPickup: async () => ({ record: { httpStatus: 200 }, observations: [{ status }] }),
    onBatch: async () => { if (failWrite) throw new Error('write unavailable'); } });
  scheduler.setTargets([{ key: 'R577|SKU', storeNumber: 'R577', partNumbers: ['SKU'] }]);
  await Promise.all(scheduler.tick());
  const firstSuccess = time;
  time += 60000; status = 'unknown';
  await Promise.all(scheduler.tick());
  assert.equal(scheduler.snapshot().targets[0].health.lastPersistedSuccessAt, firstSuccess);
  time += 60000; status = 'available'; failWrite = true;
  await Promise.all(scheduler.tick());
  assert.equal(scheduler.snapshot().targets[0].health.lastPersistedSuccessAt, firstSuccess);
  time += 60000;
  assert.equal(observationHealth({ ...scheduler.snapshot(), mode: 'resident', nowMs: time }).state, 'stalled');
  failWrite = false;
  await Promise.all(scheduler.tick());
  assert.equal(observationHealth({ ...scheduler.snapshot(), mode: 'resident', nowMs: time }).state, 'healthy');
});
