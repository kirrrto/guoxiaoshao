import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, CONSUMER_APPID, fakeFetch } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { buildTasks } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config');
const quiet = { info() {}, warn() {}, error() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup({ mode = 'resident', shouldContinue = () => true } = {}) {
  const f = createFixture({ config: { collector: { enabled: false, burstIntervalSeconds: 0, availableIntervalSeconds: 0 },
    notifications: { enabled: true, templateIds: { restock: 'TPL', soldout: 'SOLDOUT' }, cooldownMinutes: 0 } } });
  const sends = [], counts = {};
  const sender = async message => { sends.push(message); return { errcode: 0 }; };
  sender.appid = CONSUMER_APPID;
  const collector = createCollector({ repo: f.repo, sendImpl: sender, mode, log: quiet, shouldContinue,
    fetchImpl: fakeFetch(() => ({ display: 'available' })), clock: () => new Date(f.state.now) });
  await collector.lease.acquire();
  await collector.drainNotifications();
  for (const name of ['getConfig', 'listUnprocessedEvents', 'listPendingNotifications', 'listActiveFollows', 'reconcileExpiredNotifications']) {
    const original = f.repo[name];
    f.repo[name] = async (...args) => { counts[name] = (counts[name] || 0) + 1; return original(...args); };
  }
  const config = () => f.repo.tables.get('gxs_config').get('runtime');
  const addMember = async () => {
    await f.call('user.bootstrap');
    await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-10-15T00:00:00Z' }, subscriptions: { SOLDOUT: { credits: 3 }, TPL: { credits: 0 } } });
    await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active', createdAt: f.state.now.toISOString() });
    for (const key of Object.keys(counts)) counts[key] = 0;
  };
  const addEvent = async ({ ageMs = 1000, id = 'sold-out', partNumber = 'MJYH4CH/A' } = {}) => {
    const detectedAt = new Date(f.state.now.getTime() - ageMs).toISOString();
    const event = { _id: id, storeNumber: 'R577', partNumber, type: 'became_unavailable', status: 'unavailable', detectedAt,
      availableSince: new Date(Date.parse(detectedAt) - 60000).toISOString(), previousStatusConfirmed: true, notificationPlannedAt: null };
    await f.repo.saveEvents([event]);
    await f.repo.saveLatest({ _id: `R577|${partNumber}`, storeNumber: 'R577', partNumber, status: 'unavailable', statusSince: detectedAt,
      knownStreakSince: detectedAt, knownAt: f.state.now.toISOString(), observedAt: f.state.now.toISOString(), unknownSince: null });
    return event;
  };
  return { f, collector, sends, counts, config, addMember, addEvent };
}

test('each empty kick still polls events and outbox but avoids configuration and eligibility reads', async () => {
  const s = await setup();
  for (let i = 0; i < 10; i++) await s.collector.drainNotifications();
  assert.equal(s.counts.listUnprocessedEvents, 10);
  assert.equal(s.counts.listPendingNotifications, 10);
  assert.equal(s.counts.getConfig || 0, 0);
  assert.equal(s.counts.listActiveFollows || 0, 0);
  assert.equal(s.counts.reconcileExpiredNotifications || 0, 0);
  assert.equal(s.collector.stats.notificationPasses, 11);
  assert.equal(s.collector.stats.notificationEmptyPassesSkipped, 10);
  assert.equal(s.collector.stats.notificationConfigReads, 1);
  s.f.advance(30000); await s.collector.lease.renew();
  await s.collector.drainNotifications();
  assert.equal(s.counts.getConfig, 1);
  assert.equal(s.counts.listActiveFollows, 1, 'the existing eligibility window is not extended');
  assert.equal(s.counts.reconcileExpiredNotifications, 1);
  assert.equal(s.collector.stats.notificationConfigReads, 2);
});

test('new confirmed events reuse the prefetched page and send in the same kick', async () => {
  const s = await setup(); await s.addMember(); await s.addEvent();
  await s.collector.drainNotifications();
  assert.equal(s.sends.length, 1);
  assert.equal(s.counts.listUnprocessedEvents, 1);
  assert.equal(s.counts.listPendingNotifications, 1, 'newly planned tasks are read after planning');
  assert.equal(s.counts.getConfig, 3, 'planning and both authoritative send-time checks remain fresh');
});

test('an externally queued task is delivered without querying its pending page twice', async () => {
  const s = await setup(); await s.addMember();
  const event = await s.addEvent();
  await s.f.repo.markEventPlanned(event._id, s.f.state.now.toISOString());
  const [task] = buildTasks({ events: [event], follows: [await s.f.repo.getFollow('F')],
    users: new Map([[userKeyOf(), await s.f.repo.getUser(userKeyOf())]]), config: mergeConfig(s.config()), now: s.f.state.now });
  await s.f.repo.saveNotification(task);
  await s.collector.drainNotifications();
  assert.equal(s.sends.length, 1);
  assert.equal(s.counts.listUnprocessedEvents, 1);
  assert.equal(s.counts.listPendingNotifications, 1);
  assert.equal(s.counts.getConfig, 3);
});

test('a fresh configuration can widen the event age window up to its validated maximum', async () => {
  assert.doesNotThrow(() => validateConfig(mergeConfig({ notifications: { maxEventAgeSeconds: 3600 } })));
  assert.throws(() => validateConfig(mergeConfig({ notifications: { maxEventAgeSeconds: 3601 } })));
  const s = await setup(); await s.addMember();
  await s.f.repo.saveConfig({ ...s.config(), notifications: { ...s.config().notifications, maxEventAgeSeconds: 3600 } });
  await s.addEvent({ ageMs: 1200000 });
  await s.collector.drainNotifications();
  assert.equal(s.sends.length, 1);
  assert.equal(s.counts.listUnprocessedEvents, 1);
});

test('a broad prefetched page of old events cannot hide current events or expand processing policy', async () => {
  const s = await setup(); await s.addMember();
  for (let i = 0; i < 50; i++) await s.addEvent({ ageMs: 1200000, id: `old-${i}`, partNumber: `OLD${i}` });
  await s.addEvent();
  await s.collector.drainNotifications();
  assert.equal(s.sends.length, 1);
  assert.equal(s.counts.listUnprocessedEvents, 2, 'only a mismatched wide page needs a fresh policy-window query');
  assert.equal((await s.f.repo.getEvent('old-0')).notificationPlannedAt, null);
});

test('a saved cursor past the tail wraps before deciding that a notification poll is empty', async () => {
  const s = await setup(); await s.addMember(); await s.addEvent();
  s.collector.stats.notificationEventCursor = { detectedAt: s.f.state.now.toISOString(), id: 'past-tail' };
  await s.collector.drainNotifications();
  assert.equal(s.sends.length, 1);
  assert.equal(s.counts.listUnprocessedEvents, 2, 'one cursor read and one wrap, with no extra planning read');
});

test('a kick arriving during an empty read still plans its newly committed event', async () => {
  const s = await setup({ mode: 'scheduled' }); await s.addMember();
  const read = s.f.repo.listPendingNotifications;
  let release, entered = false;
  s.f.repo.listPendingNotifications = async args => {
    const result = await read(args);
    if (!entered) { entered = true; await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const work = s.collector.drainNotifications();
  while (!entered) await flush();
  await s.addEvent();
  assert.equal(s.collector.drainNotifications(), work);
  release(); await work;
  assert.equal(s.sends.length, 1);
  assert.equal(s.counts.listUnprocessedEvents, 2);
});

test('an availability update during an empty read retains immediate newly granted eligibility', async () => {
  const s = await setup({ mode: 'scheduled' }); await s.addMember();
  await s.f.repo.saveConfig({ ...s.config(), collector: { ...s.config().collector, enabled: true, cadenceMode: 'fixed', intervalSeconds: 60 } });
  await s.collector.refreshTargets();
  const at = new Date(s.f.state.now.getTime() - 1000).toISOString();
  await s.f.repo.saveLatest({ _id: 'R577|MJYH4CH/A', storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available',
    statusSince: at, knownStreakSince: at, knownAt: at, observedAt: at });
  const read = s.f.repo.listPendingNotifications;
  let release, entered = false;
  s.f.repo.listPendingNotifications = async args => {
    const result = await read(args);
    if (!entered) { entered = true; await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const work = s.collector.drainNotifications();
  while (!entered) await flush();
  await s.f.repo.updateUser(userKeyOf(), { subscriptions: { TPL: { credits: 1 } } });
  await Promise.all((await s.collector.step()).started);
  release(); await work;
  assert.equal(s.sends.length, 1, 'the batch invalidation is not hidden by an earlier empty outbox snapshot');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 0);
});

test('reconciliation becoming due during prefetch cannot leave fresh outbox tasks behind its retired prefix', async () => {
  const s = await setup(); await s.addMember();
  const event = await s.addEvent();
  await s.f.repo.markEventPlanned(event._id, s.f.state.now.toISOString());
  const [task] = buildTasks({ events: [event], follows: [await s.f.repo.getFollow('F')],
    users: new Map([[userKeyOf(), await s.f.repo.getUser(userKeyOf())]]), config: mergeConfig(s.config()), now: s.f.state.now });
  const old = new Date(s.f.state.now.getTime() - 121000).toISOString();
  for (let i = 0; i < 20; i++) await s.f.repo.saveNotification({ ...task, _id: `expired-${i}`, detectedAt: old, createdAt: old });
  await s.f.repo.saveNotification(task);
  const read = s.f.repo.listPendingNotifications;
  let first = true;
  s.f.repo.listPendingNotifications = async args => {
    const result = await read(args);
    if (first) { first = false; s.f.advance(30000); await s.collector.lease.renew(); }
    return result;
  };
  await s.collector.drainNotifications();
  assert.equal(s.sends.length, 1);
  assert.equal(s.counts.listPendingNotifications, 2);
  assert.equal(s.counts.reconcileExpiredNotifications, 1);
});

test('a deadline reached during empty prefetch prevents configuration and cleanup even when eligibility becomes due', async () => {
  let allowed = true;
  const s = await setup({ shouldContinue: () => allowed });
  const read = s.f.repo.listPendingNotifications;
  let release, entered = false;
  s.f.repo.listPendingNotifications = async args => {
    const result = await read(args);
    entered = true;
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  const work = s.collector.drainNotifications();
  while (!entered) await flush();
  s.f.advance(30000);
  await s.collector.lease.renew();
  allowed = false;
  release(); await work;
  assert.equal(s.collector.lease.isHeld(), true, 'the deadline is the rejecting guard');
  assert.equal(s.collector.stats.notificationEmptyPassesSkipped, 0, 'due eligibility bypasses the earlier empty shortcut');
  assert.equal(s.counts.getConfig || 0, 0);
  assert.equal(s.counts.reconcileExpiredNotifications || 0, 0);
  assert.equal(s.counts.listActiveFollows || 0, 0);
});
