import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { createFixture, fakeFetch, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { createScheduler, buildGroups } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { createWechatSender } = require('../cloudfunctions/gxs_api/lib/engine/wechat-sender');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { createLeaseKeeper } = require('../cloudfunctions/gxs_api/lib/engine/lease');
const { isTransactionConflict } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const log = { info() {}, warn() {}, error() {} };
const config = { collector: { enabled: true, intervalSeconds: 1, maxConcurrency: 2 }, notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 30 } };

test('same-worker lease renewals share one in-flight transaction and recover after rejection', async () => {
  let calls = 0; let resolve; let reject;
  const lease = createLeaseKeeper({ ownerId: 'same-worker', clock: () => new Date('2026-09-16T01:25:00Z'), log,
    repo: { acquireLease: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); } } });
  const first = lease.renew(); const second = lease.renew();
  assert.equal(first, second); assert.equal(calls, 1);
  resolve({ acquired: true, expiresAt: '2026-09-16T01:25:15Z' });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  const failed = lease.renew(); const alsoFailed = lease.renew();
  reject(new Error('temporary conflict')); await assert.rejects(failed); await assert.rejects(alsoFailed);
  assert.equal(calls, 2);
  const recovered = lease.renew(); resolve({ acquired: false, holder: 'new-owner', expiresAt: '2026-09-16T01:25:15Z' });
  assert.equal(await recovered, false); assert.equal(calls, 3); assert.equal(lease.isHeld(), false);
});

test('only explicit transaction conflicts are retriable after wx-server-sdk wrapping', () => {
  assert.equal(isTransactionConflict({ errCode: -501001, errMsg: 'document.update:fail -501001 resource system error. [ResourceUnavailable.TransactionConflict] Transaction is conflict, maybe resource operated by others' }), true);
  assert.equal(isTransactionConflict({ code: 'OTHER', errMsg: 'SDK outer error', message: 'DATABASE_TRANSACTION_CONFLICT' }), true);
  for (const error of [new Error('socket timeout'), { errCode: -501001, errMsg: 'resource system error' }, { code: 'NETWORK_ERROR', message: 'write may already have completed' }, { errMsg: 'document not found' }]) assert.equal(isTransactionConflict(error), false);
});

async function setup(override = {}) {
  let display = 'unavailable';
  const upstream = fakeFetch(() => ({ display }));
  const f = createFixture({ config: { ...config, ...override }, fetchImpl: upstream });
  assert.equal((await f.call('user.bootstrap')).ok, true);
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00.000Z' }, subscriptions: { TPL: { credits: 3 } } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  const sends = [];
  const sender = async m => { sends.push(m); return { errcode: 0 }; };
  sender.appid = CONSUMER_APPID;
  const collector = createCollector({ repo: f.repo, fetchImpl: upstream, clock: () => new Date(f.state.now), sendImpl: sender, log, statusEveryMs: 0, refreshEveryMs: 0 });
  const run = async () => { const result = await collector.step(); await Promise.all(result.started); return result; };
  const task = id => ({ _id: id, userKey: userKeyOf(), followId: 'F', eventId: `event-${id}`, eventType: 'restock_confirmed',
    partNumber: 'MJYH4CH/A', storeNumber: 'R577', templateId: 'TPL', status: 'pending', attempts: 0,
    createdAt: f.state.now.toISOString(), detectedAt: f.state.now.toISOString() });
  const send = async (t, impl = sender) => { await seedNotificationObservation(f.repo, t); return sendTask({ task: t, repo: f.repo, config, sendImpl: impl, now: f.state.now, clock: () => f.state.now, ownerId: 'test-sender' }); };
  return { f, upstream, collector, sends, sender, run, task, send, available: () => { display = 'available'; } };
}

test('notification expiry reconciliation starts immediately and repeats at the 30-second boundary', async () => {
  const s = await setup({ collector: { enabled: false } });
  let reconciles = 0;
  const reconcile = s.f.repo.reconcileExpiredNotifications.bind(s.f.repo);
  s.f.repo.reconcileExpiredNotifications = async args => { reconciles++; return reconcile(args); };
  const expired = s.task('already-expired');
  await s.f.repo.saveNotification(expired);
  await s.f.repo.claimNotification({ id: expired._id, ownerId: 'dead', now: s.f.state.now.toISOString(),
    leaseUntil: new Date(s.f.state.now.getTime() - 1).toISOString() });
  await s.collector.lease.acquire();
  await Promise.all([s.collector.drainNotifications(), s.collector.drainNotifications()]);
  assert.equal(reconciles, 1, 'queued passes share the successful reconciliation window');
  assert.equal((await s.f.repo.getNotification(expired._id)).status, 'uncertain');

  const later = s.task('expires-during-window');
  await s.f.repo.saveNotification(later);
  await s.f.repo.claimNotification({ id: later._id, ownerId: 'dead', now: s.f.state.now.toISOString(),
    leaseUntil: new Date(s.f.state.now.getTime() + 1000).toISOString() });
  s.f.advance(29999);
  await s.run();
  assert.equal(reconciles, 1);
  assert.equal((await s.f.repo.getNotification(later._id)).status, 'sending');
  s.f.advance(1);
  await s.run();
  assert.equal(reconciles, 2);
  const reconciled = await s.f.repo.getNotification(later._id);
  assert.equal(reconciled.status, 'uncertain');
  assert.equal(reconciled.reason, 'worker_expired_after_claim');
  assert.equal(s.sends.length, 0, 'expired sending claims must not be replayed');
});

test('a slow successful expiry update does not postpone the next reconciliation window', async () => {
  const s = await setup({ collector: { enabled: false } });
  let reconciles = 0;
  const reconcile = s.f.repo.reconcileExpiredNotifications.bind(s.f.repo);
  s.f.repo.reconcileExpiredNotifications = async args => {
    reconciles++;
    if (reconciles === 1) s.f.advance(5000);
    return reconcile(args);
  };
  await s.run();
  s.f.advance(24999);
  await s.run();
  assert.equal(reconciles, 1);
  s.f.advance(1);
  await s.run();
  assert.equal(reconciles, 2, '30 seconds since query start, not since its completion');
});

test('a failed expiry update remains eligible for retry on the next notification pass', async () => {
  const s = await setup({ collector: { enabled: false } });
  let reconciles = 0;
  const reconcile = s.f.repo.reconcileExpiredNotifications.bind(s.f.repo);
  s.f.repo.reconcileExpiredNotifications = async args => {
    reconciles++;
    if (reconciles === 1) throw new Error('temporary expiry update failure');
    return reconcile(args);
  };
  await assert.rejects(s.run(), /temporary expiry update failure/);
  await s.run();
  assert.equal(reconciles, 2, 'retry succeeds without advancing the clock');
  await s.run();
  assert.equal(reconciles, 2, 'only the successful retry starts the window');
});

test('a replacement collector reconciles immediately even within the previous instance window', async () => {
  const s = await setup({ collector: { enabled: false } });
  let reconciles = 0;
  const reconcile = s.f.repo.reconcileExpiredNotifications.bind(s.f.repo);
  s.f.repo.reconcileExpiredNotifications = async args => { reconciles++; return reconcile(args); };
  await s.run();
  await s.collector.lease.release();
  const replacement = createCollector({ repo: s.f.repo, fetchImpl: s.upstream, clock: () => new Date(s.f.state.now),
    sendImpl: s.sender, log, mode: 'scheduled', ownerId: 'replacement-worker' });
  assert.equal(await replacement.lease.acquire(), true);
  await replacement.drainNotifications();
  assert.equal(reconciles, 2);
});

test('runtime 8-second interval and concurrency one are effective and can change without restart', async () => {
  const s = await setup({ collector: { enabled: true, intervalSeconds: 8, maxConcurrency: 1 } });
  await s.f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'], status: 'active' });
  assert.equal((await s.run()).started.length, 1);
  assert.equal((await s.run()).started.length, 1);
  s.f.advance(1000);
  assert.equal((await s.run()).started.length, 0);
  assert.equal((await s.f.repo.getCollectorStatus()).intervalMs, 8000);
  const runtime = await s.f.repo.getConfig();
  await s.f.repo.saveConfig({ ...runtime, collector: { ...runtime.collector, enabled: true, intervalSeconds: 2, maxConcurrency: 2 } });
  s.f.advance(1000);
  assert.equal((await s.run()).started.length, 2);
  assert.equal(s.collector.scheduler.snapshot().maxConcurrency, 2);
});

test('a success already in flight cannot clear a concurrent 429 Retry-After breaker', async () => {
  let now = Date.parse('2026-09-15T02:00:00.000Z');
  const gates = {};
  const scheduler = createScheduler({ clock: () => new Date(now), fetchPickup: ({ storeNumber }) => new Promise(resolve => { gates[storeNumber] = resolve; }), onBatch: async () => {}, log });
  scheduler.setTargets(buildGroups([{ partNumber: 'SKU', storeNumbers: ['R001', 'R002', 'R003'] }]));
  const work = scheduler.tick();
  gates.R001({ record: { httpStatus: 429, retryAfter: '30' }, observations: [{ status: 'unknown' }] });
  await work[0];
  gates.R002({ record: { httpStatus: 200 }, observations: [{ status: 'available' }] });
  await work[1];
  assert.equal(scheduler.snapshot().breaker.state, 'open');
  assert.equal(scheduler.tick().length, 0);
  now += 30000;
  const probe = scheduler.tick();
  assert.equal(probe.length, 1);
  gates.R003({ record: { httpStatus: 200 }, observations: [{ status: 'available' }] });
  await probe[0];
  assert.equal(scheduler.snapshot().breaker.state, 'closed');
});

test('replacing a target retains the in-flight request in the global concurrency count', async () => {
  let release;
  const scheduler = createScheduler({ maxConcurrency: 1, clock: () => new Date(), fetchPickup: () => new Promise(resolve => { release = resolve; }), onBatch: async () => {}, log });
  scheduler.setTargets(buildGroups([{ partNumber: 'A', storeNumbers: ['R001'] }]));
  const work = scheduler.tick();
  scheduler.setTargets(buildGroups([{ partNumber: 'B', storeNumbers: ['R001'] }]));
  assert.equal(scheduler.tick().length, 0);
  release({ record: { httpStatus: 200 }, observations: [{ status: 'available' }] });
  await Promise.all(work);
});

test('a manual query restock creates exactly one durable subscription notification', async () => {
  const s = await setup();
  let reconciles = 0;
  const reconcile = s.f.repo.reconcileExpiredNotifications.bind(s.f.repo);
  s.f.repo.reconcileExpiredNotifications = async args => { reconciles++; return reconcile(args); };
  await s.run(); s.f.advance(500); s.available();
  const result = await s.f.call('query.pickup', { queryId: 'manual-00001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] });
  assert.equal(result.ok, true);
  assert.equal(result.data.results[0].events[0].type, 'restock_confirmed');
  s.f.advance(500); await s.run(); s.f.advance(1000); await s.run();
  assert.equal(s.sends.length, 1);
  assert.equal(await s.f.repo.count(C.notifications), 1);
  assert.equal(reconciles, 1, 'event planning and confirmed delivery continue during the reconciliation window');
});

test('a temporary notification insert failure is recovered from the persisted event', async () => {
  const s = await setup(); await s.run(); s.available(); s.f.advance(1000);
  const save = s.f.repo.saveNotification.bind(s.f.repo); let failed = false;
  s.f.repo.saveNotification = async t => { if (!failed) { failed = true; throw new Error('temporary storage outage'); } return save(t); };
  await s.run();
  assert.equal(s.sends.length, 0, 'the restock waits for a confirming re-check');
  assert.equal((await s.f.repo.listUnprocessedEvents()).length, 1);
  s.f.advance(1000); await s.run();
  assert.equal(s.sends.length, 0, 'confirmed, but the notification insert failed');
  assert.equal((await s.f.repo.listUnprocessedEvents()).length, 1);
  s.f.advance(1000); await s.run();
  assert.equal(s.sends.length, 1);
  assert.equal((await s.f.repo.listUnprocessedEvents()).length, 0);
});

test('two workers claim one task once and spend one subscription credit', async () => {
  const s = await setup(); const task = s.task('concurrent-task'); await s.f.repo.saveNotification(task);
  await Promise.all([s.send(task), s.send(task)]);
  assert.equal(s.sends.length, 1);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
});

test('send-time membership, follow, DND and user switch are rechecked after planning', async () => {
  const mutations = [
    [async s => s.f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2020-01-01T00:00:00Z' }, firstReminderSentAt: '2026-08-20T00:00:00.000Z' }), 'member_expired'],
    [async s => s.f.repo.saveFollow({ ...await s.f.repo.getFollow('F'), status: 'paused' }), 'follow_not_active'],
    [async s => s.f.repo.updateUser(userKeyOf(), { settings: { notifyEnabled: false } }), 'user_disabled'],
    [async s => s.f.repo.updateUser(userKeyOf(), { settings: { dnd: { enabled: true, startMinute: 540, endMinute: 660 } } }), 'dnd'],
  ];
  for (const [mutate, reason] of mutations) {
    const s = await setup(); const task = s.task(`task-${reason}`); await s.f.repo.saveNotification(task); await mutate(s);
    const result = await s.send(task);
    assert.equal(result.reason, reason); assert.equal(s.sends.length, 0);
    assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  }
});

test('uncertain transport and malformed platform response are never blindly replayed', async () => {
  for (const impl of [async () => { throw new Error('timeout'); }, async () => ({})]) {
    const s = await setup(); const task = s.task('uncertain-task'); await s.f.repo.saveNotification(task);
    let attempts = 0; const sender = async message => { attempts++; return impl(message); };
    const result = await s.send(task, sender); assert.equal(result.status, 'uncertain');
    await s.send(task, sender); assert.equal(attempts, 1);
    assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
  }
});

test('a crashed sending claim expires to uncertain rather than returning to pending', async () => {
  const s = await setup(); const task = s.task('crashed-task'); await s.f.repo.saveNotification(task);
  await s.f.repo.claimNotification({ id: task._id, ownerId: 'dead', now: s.f.state.now.toISOString(), leaseUntil: new Date(s.f.state.now.getTime() + 1000).toISOString() });
  s.f.advance(1001); await s.f.repo.reconcileExpiredNotifications({ now: s.f.state.now.toISOString() });
  assert.equal((await s.send(task)).status, 'uncertain'); assert.equal(s.sends.length, 0);
});

test('cooldown applies atomically per user and target; explicit rejection releases credit', async () => {
  const s = await setup(); const a = s.task('a'); const b = s.task('b');
  await s.f.repo.saveNotification(a); await s.f.repo.saveNotification(b);
  assert.equal((await s.send(a)).status, 'accepted');
  assert.equal((await s.send(b)).reason, 'cooldown');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
  const other = await setup(); const rejected = other.task('rejected'); await other.f.repo.saveNotification(rejected);
  assert.equal((await other.send(rejected, async () => ({ errcode: 40037 }))).status, 'failed');
  assert.equal((await other.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('subscription grants enforce template whitelist and idempotency under concurrent retries', async () => {
  const f = createFixture({ config });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' } });
  const payload = { requestId: 'grant-00001', results: { TPL: 'accept' } };
  const results = await Promise.all([f.call('notify.recordSubscription', payload), f.call('notify.recordSubscription', payload)]);
  assert.ok(results.every(r => r.ok));
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 1);
  const bad = await f.call('notify.recordSubscription', { requestId: 'grant-00002', results: { FAKE: 'accept' } });
  assert.equal(bad.error.code, 'invalid_subscription_result');
});

test('durable collector budgets survive another collector process and reset by minute/day', async () => {
  const s = await setup();
  const take = now => s.f.repo.consumeCollectorBudget({ now, maxRequestsPerMinute: 1, maxRequestsPerDay: 2, budgetMode: 'daily' });
  assert.equal((await take('2026-09-15T02:00:00Z')).allowed, true);
  assert.equal((await take('2026-09-15T02:00:01Z')).reason, 'minute_budget');
  assert.equal((await take('2026-09-15T02:01:00Z')).allowed, true);
  assert.equal((await take('2026-09-15T02:02:00Z')).reason, 'daily_budget');
  assert.equal((await take('2026-09-15T16:00:00Z')).allowed, true);
});

test('consumer sender is explicitly disabled without matching credentials', async () => {
  let called = 0; const fetchImpl = async () => { called++; };
  const missing = createWechatSender({ expectedAppid: CONSUMER_APPID, fetchImpl });
  assert.equal(missing.enabled, false);
  await assert.rejects(missing({ appid: CONSUMER_APPID }), /consumer_credentials_missing/);
  const wrong = createWechatSender({ appid: 'wxRESOURCE', appSecret: 'test-only', expectedAppid: CONSUMER_APPID, fetchImpl });
  assert.equal(wrong.disabledReason, 'consumer_appid_mismatch'); assert.equal(called, 0);
});

test('consumer HTTP sender maps platform fields correctly and caches only the consumer token', async () => {
  const calls = [];
  const sender = createWechatSender({ appid: CONSUMER_APPID, appSecret: 'test-only', expectedAppid: CONSUMER_APPID,
    fetchImpl: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => url.includes('stable_token') ? { access_token: 'test-token', expires_in: 7200 } : { errcode: 0 } }; } });
  const message = { appid: CONSUMER_APPID, touser: 'consumer-openid', templateId: 'TPL', page: 'pages/follow/index', data: {}, miniprogramState: 'developer' };
  await sender(message); await sender(message);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.appid, CONSUMER_APPID);
  assert.equal(calls[1].body.template_id, 'TPL');
  assert.equal(calls[1].body.miniprogram_state, 'developer');
  assert.equal(Object.hasOwn(calls[1].body, 'appid'), false);
  await assert.rejects(sender({ ...message, appid: 'resource-appid' }), /consumer_appid_mismatch/);
});

test('resident runner exposes health while disabled and shuts down without any upstream calls', async () => {
  const { start } = require('../tools/collector/runner');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  let calls = 0;
  const runner = await start({ env: { PORT: String(port) }, fetchImpl: async () => { calls++; throw new Error('unexpected network'); }, log });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).state, 'disabled');
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
    assert.equal(calls, 0);
  } finally { await runner.stop(); }
});

test('resident runner drains, records stopped state and releases its lease on shutdown', async () => {
  const { start } = require('../tools/collector/runner');
  const s = await setup({ collector: { enabled: false, intervalSeconds: 8, maxConcurrency: 1 } });
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const runner = await start({ env: { PORT: String(port), GXS_ENABLE_COLLECTOR_PROCESS: 'true' }, repo: s.f.repo, fetchImpl: async () => { throw new Error('unexpected network'); }, log });
  // Wait for one actual heartbeat, with a bounded polling loop rather than an
  // arbitrary startup delay. All state is an in-memory repo.
  for (let i = 0; i < 100 && !runner.getStatus(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runner.getStatus().state, 'disabled');
  await runner.stop();
  assert.equal((await s.f.repo.getCollectorStatus()).state, 'stopped');
  assert.equal(runner.collector.lease.isHeld(), false);
});
