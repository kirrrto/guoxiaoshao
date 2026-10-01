import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { createScheduler } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { createWechatSender } = require('../cloudfunctions/gxs_api/lib/engine/wechat-sender');
const log = { info() {}, warn() {}, error() {} };

async function collectorFixture() {
  const f = createFixture({ config: {
    collector: { enabled: true, intervalSeconds: 60 },
    notifications: { enabled: true, cooldownMinutes: 0, templateIds: { restock: 'TPL', soldout: 'SOLD' } },
  } });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { TPL: { credits: 5 }, SOLD: { credits: 5 } } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  const sends = [];
  const collector = createCollector({ repo: f.repo, clock: () => new Date(f.state.now), log,
    sendImpl: async message => { sends.push(message); return { errcode: 0 }; } });
  await collector.lease.acquire();
  await collector.refreshTargets();
  const observe = async status => {
    f.advance(2000);
    await collector.lease.renew();
    await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status,
      observedAt: f.state.now.toISOString(), source: 'auto' } });
    await collector.drainNotifications();
  };
  return { f, collector, sends, observe };
}

test('unknown breaks consecutive confirmation for both restock and sold-out alerts', async () => {
  const s = await collectorFixture();
  await s.observe('unavailable');
  await s.observe('available');
  await s.observe('unknown');
  await s.observe('available');
  assert.equal(s.sends.length, 0, 'one valid result after a failed re-check cannot confirm stock');
  await s.observe('available');
  assert.equal(s.sends.length, 1);
  await s.observe('unavailable');
  await s.observe('unknown');
  await s.observe('unavailable');
  assert.equal(s.sends.length, 1, 'sold-out needs two consecutive valid results as well');
  await s.observe('unavailable');
  assert.equal(s.sends.length, 2);
});

test('re-reading a waiting event cannot extend the 20-second quiet period', async () => {
  const s = await collectorFixture();
  await s.observe('available');
  const changedAt = s.f.state.now.getTime();
  for (let i = 0; i < 10; i++) await s.observe('unknown');
  assert.equal(s.f.state.now.getTime() - changedAt, 20000);
  assert.equal(s.collector.scheduler.bursting(), false);
  assert.equal(s.sends.length, 0);
});

test('unconfirmed stock separated by an unknown sample cannot create a phantom sold-out alert', async () => {
  const s = await collectorFixture();
  for (const status of ['unavailable', 'available', 'unknown', 'available', 'unavailable', 'unavailable']) await s.observe(status);
  assert.equal(s.sends.length, 0, 'availability was never confirmed, so neither transition may alert');
});

test('an unconfirmed sold-out dip with an unknown sample cannot duplicate the restock alert', async () => {
  const s = await collectorFixture();
  for (const status of ['unavailable', 'available', 'available', 'unavailable', 'unknown', 'available', 'available']) await s.observe(status);
  assert.equal(s.sends.length, 1, 'the sold-out period never passed confirmation');
});

test('legacy confirmed availability survives an unknown gap during upgrade and can still alert on sold-out', async () => {
  const s = await collectorFixture();
  await s.f.repo.saveLatest({ _id: 'R577|MJYH4CH/A', storeNumber: 'R577', partNumber: 'MJYH4CH/A',
    status: 'available', statusSince: '2026-09-15T01:59:50.000Z', knownAt: '2026-09-15T01:59:52.000Z',
    observedAt: '2026-09-15T01:59:54.000Z', unknownSince: '2026-09-15T01:59:54.000Z', unknownCount: 1, sampleCount: 3 });
  await s.observe('available');
  const [latest] = await s.f.repo.getLatest(['R577|MJYH4CH/A']);
  assert.equal(latest.statusConfirmed, true, 'legacy knownAt after statusSince already proves past confirmation');
  assert.equal(latest.knownStreakSince, latest.knownAt, 'the new consecutive streak still starts after the gap');
  await s.observe('unavailable');
  await s.observe('unavailable');
  assert.deepEqual(s.sends.map(message => message.templateId), ['SOLD']);
});

test('refreshing the same interval preserves a running burst and its next re-check', async () => {
  let now = 0;
  const scheduler = createScheduler({ clock: () => new Date(now), intervalMs: 60000, burstIntervalMs: 2000, burstQuietMs: 20000,
    fetchPickup: async () => ({ record: { httpStatus: 200 }, observations: [{ status: 'available' }] }),
    onBatch: async () => ({ changed: true }), log });
  scheduler.setTargets([{ key: 'R577|A', storeNumber: 'R577', partNumbers: ['A'] }]);
  await Promise.all(scheduler.tick());
  now = 1000;
  scheduler.configure({ intervalMs: 60000, burstIntervalMs: 2000, burstQuietMs: 20000 });
  assert.equal(scheduler.nextDueInMs(), 1000, 'refreshing targets must keep the due re-check at 2 seconds');
});

test('scheduled pickup timeout fits the remaining budget and retains time to persist results', async t => {
  const s = await collectorFixture();
  await s.collector.lease.release();
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return nativeTimeout(ms); });
  await runScheduled({ repo: s.f.repo, fetchImpl: fakeFetch(() => ({ display: 'unavailable' })),
    clock: () => new Date(s.f.state.now), log, maxRunMs: 1500 });
  assert.deepEqual(timeouts, [500], 'an 8-second request must not start with only 1.5 seconds left');
});

test('a deadline reached during credit reservation prevents the send and restores the trial and subscription credit', async () => {
  const s = await collectorFixture();
  await s.f.repo.updateUser(userKeyOf(), { membership: null });
  const task = { _id: 'deadline-task', userKey: userKeyOf(), followId: 'F', eventId: 'event-deadline', eventType: 'restock_confirmed',
    partNumber: 'MJYH4CH/A', storeNumber: 'R577', templateId: 'TPL', status: 'pending', attempts: 0,
    createdAt: s.f.state.now.toISOString(), detectedAt: s.f.state.now.toISOString() };
  await s.f.repo.saveNotification(task);
  await seedNotificationObservation(s.f.repo, task);
  let allowed = true;
  const reserve = s.f.repo.reserveSubscriptionCredit;
  s.f.repo.reserveSubscriptionCredit = async args => { const result = await reserve(args); allowed = false; return result; };
  const result = await sendTask({ task, repo: s.f.repo, sendImpl: async () => { s.sends.push('sent'); return { errcode: 0 }; },
    now: s.f.state.now, clock: () => new Date(s.f.state.now), beforeSend: async () => allowed });
  assert.equal(s.sends.length, 0, 'the send guard is checked again after the reservation transaction');
  assert.equal(result.status, 'pending');
  const user = await s.f.repo.getUser(userKeyOf());
  assert.equal(user.subscriptions.TPL.credits, 5);
  assert.equal(user.firstReminderSentAt || null, null);
  assert.equal(user.freeReminderTaskId || null, null);
  allowed = true;
  s.f.repo.reserveSubscriptionCredit = reserve;
  const retry = await sendTask({ task: result, repo: s.f.repo, sendImpl: async () => { s.sends.push('sent'); return { errcode: 0 }; },
    now: s.f.state.now, clock: () => new Date(s.f.state.now), beforeSend: async () => allowed });
  assert.equal(retry.status, 'accepted');
  assert.equal(s.sends.length, 1, 'the next eligible worker can claim and send the deferred task once');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 4);
});

test('consumer message token and send requests share the per-attempt time budget', async t => {
  let now = Date.parse('2026-09-15T02:00:00Z');
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return nativeTimeout(ms); });
  const sender = createWechatSender({ appid: 'wx-test', expectedAppid: 'wx-test', appSecret: 'fixture-secret', clock: () => new Date(now),
    fetchImpl: async url => {
      if (url.endsWith('/stable_token')) { now += 300; return { ok: true, json: async () => ({ access_token: 'fixture-token', expires_in: 7200 }) }; }
      return { ok: true, json: async () => ({ errcode: 0 }) };
    } });
  await sender({ appid: 'wx-test', touser: 'fixture-user', templateId: 'TPL', data: {} }, { timeoutMs: 500 });
  assert.deepEqual(timeouts, [500, 200]);
});

test('split SKU groups share the same-store interval across target changes and cold starts', async () => {
  let now = 0;
  const calls = [];
  const options = { clock: () => new Date(now), intervalMs: 60000, burstIntervalMs: 2000,
    fetchPickup: async ({ storeNumber }) => { calls.push({ storeNumber, at: now }); return { record: {}, observations: [{ status: 'unavailable' }] }; },
    onBatch: async () => ({}), log };
  const scheduler = createScheduler(options);
  const groups = ['A', 'B'].map(part => ({ key: `R577|${part}`, storeNumber: 'R577', partNumbers: [part] }));
  scheduler.setTargets(groups);
  await Promise.all(scheduler.tick());
  assert.equal(calls.length, 1, 'two batches for one store cannot both start in the same tick');
  assert.equal(scheduler.nextDueInMs(), 2000);
  const checkpoint = JSON.parse(JSON.stringify(scheduler.checkpoint()));
  const cold = createScheduler(options);
  cold.setTargets([{ key: 'R577|C', storeNumber: 'R577', partNumbers: ['C'] }]);
  cold.restore(checkpoint);
  now = 1999;
  await Promise.all(cold.tick());
  assert.equal(calls.length, 1, 'changing the group key cannot bypass the store interval');
  now = 2000;
  await Promise.all(cold.tick());
  assert.equal(calls.length, 2);
});

test('a scheduled scan still visits all same-store SKU batches after spacing them out', async () => {
  const s = await collectorFixture();
  await s.collector.lease.release();
  const stored = await s.f.repo.getConfig();
  await s.f.repo.saveConfig({ ...stored, collector: { ...stored.collector, maxPartsPerRequest: 1 } });
  await s.f.repo.saveFollow({ _id: 'F2', userKey: userKeyOf(), partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], status: 'active' });
  const calls = [];
  const upstream = fakeFetch(() => { calls.push(s.f.state.now.getTime()); return { display: 'unavailable' }; });
  const result = await runScheduled({ repo: s.f.repo, fetchImpl: upstream, clock: () => new Date(s.f.state.now), log,
    sleep: async ms => s.f.advance(ms) });
  assert.equal(result.scanned, 2);
  assert.ok(calls[1] - calls[0] >= 2000, 'same-store split batches respect the 2-second minimum');
});

test('slow database admission cannot compress actual same-store HTTP starts below two seconds', async () => {
  const s = await collectorFixture();
  await s.collector.lease.release();
  const stored = await s.f.repo.getConfig();
  await s.f.repo.saveConfig({ ...stored, collector: { ...stored.collector, maxPartsPerRequest: 1 } });
  await s.f.repo.saveFollow({ _id: 'F2', userKey: userKeyOf(), partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], status: 'active' });
  const originalBudget = s.f.repo.consumeCollectorBudget;
  let admissions = 0;
  s.f.repo.consumeCollectorBudget = async args => {
    if (++admissions === 1) s.f.advance(1500);
    return originalBudget(args);
  };
  const calls = [];
  const upstream = fakeFetch(() => { calls.push(s.f.state.now.getTime()); return { display: 'unavailable' }; });
  const result = await runScheduled({ repo: s.f.repo, fetchImpl: upstream, clock: () => new Date(s.f.state.now), log,
    sleep: async ms => s.f.advance(ms) });
  assert.equal(result.scanned, 2);
  assert.ok(calls[1] - calls[0] >= 2000, `actual HTTP start gap was ${calls[1] - calls[0]}ms`);
});

async function slowLeaseFixture(delayMs) {
  const s = await collectorFixture();
  await s.collector.lease.release();
  const acquire = s.f.repo.acquireLease;
  s.f.repo.acquireLease = async args => {
    const result = await acquire(args);
    s.f.advance(delayMs);
    return result;
  };
  const deadline = s.f.state.now.getTime() + 120000;
  return { ...s, options: { repo: s.f.repo, clock: () => new Date(s.f.state.now), log,
    remainingMs: () => deadline - s.f.state.now.getTime(), fetchImpl: fakeFetch(() => ({ display: 'unavailable' })) } };
}

test('pickup timeout uses the actual lease time left after a slow renewal', async t => {
  const s = await slowLeaseFixture(10000);
  const timeouts = [];
  const nativeTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return nativeTimeout(ms); });
  const collector = createCollector(s.options);
  const result = await collector.step();
  await Promise.all(result.started);
  assert.ok(s.options.remainingMs() > 15000, 'the invocation deadline is not the limiting budget');
  assert.deepEqual(timeouts, [4000], 'the returned 15-second lease has only 5 seconds left after its 10-second renewal');
});

test('message timeout uses the actual lease time left after the final renewal', async () => {
  const s = await slowLeaseFixture(10000);
  const attempts = [];
  const collector = createCollector({ ...s.options, sendImpl: async (message, options) => {
    attempts.push({ timeoutMs: options.timeoutMs, leaseRemainingMs: Date.parse(collector.lease.expiresAt()) - s.f.state.now.getTime() });
    return { errcode: 0 };
  } });
  await collector.lease.acquire();
  await collector.refreshTargets();
  await s.f.repo.saveNotification({ _id: 'slow-lease-task', userKey: userKeyOf(), followId: 'F', eventId: 'event-slow-lease',
    eventType: 'restock_confirmed', partNumber: 'MJYH4CH/A', storeNumber: 'R577', templateId: 'TPL', status: 'pending', attempts: 0,
    createdAt: s.f.state.now.toISOString(), detectedAt: s.f.state.now.toISOString() });
  await seedNotificationObservation(s.f.repo, await s.f.repo.getNotification('slow-lease-task'));
  await collector.drainNotifications();
  assert.ok(s.options.remainingMs() > 15000, 'the invocation still has ample time');
  assert.deepEqual(attempts, [{ timeoutMs: 4000, leaseRemainingMs: 5000 }]);
  assert.equal((await s.f.repo.getNotification('slow-lease-task')).status, 'accepted');
});

test('token probe timeout also reserves time inside the actual remaining lease', async () => {
  const s = await slowLeaseFixture(13000);
  const probes = [];
  const sender = async () => ({ errcode: 0 });
  sender.probe = async options => { probes.push(options.timeoutMs); };
  const collector = createCollector({ ...s.options, sendImpl: sender });
  const result = await collector.step();
  await Promise.all(result.started);
  assert.ok(s.options.remainingMs() > 15000);
  assert.deepEqual(probes, [1000], '2 seconds remain after renewal, including 1 second reserved for persistence');
});
