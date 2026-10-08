import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, userContext, operatorContext, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const config = { notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 0 } };
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const failWith = (result, code) => { assert.equal(result.ok, false); assert.equal(result.error.code, code); };
const FOLLOW = `${userKeyOf()}|f-0001-aaaa`;
const EVENT = 'R577|MJYH4CH/A|restock_confirmed|2026-09-15T02:00:00.000Z';

async function alerted() {
  const f = createFixture({ config });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00.000Z' }, subscriptions: { TPL: { credits: 2 } } });
  await f.repo.saveFollow({ _id: FOLLOW, userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active', updatedAt: f.state.now.toISOString() });
  await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available', observedAt: f.state.now.toISOString(), source: 'auto', quote: '今天可取货' } });
  const task = { _id: `${userKeyOf()}|${EVENT}`, userKey: userKeyOf(), followId: FOLLOW, eventId: EVENT, eventType: 'restock_confirmed', partNumber: 'MJYH4CH/A',
    storeNumber: 'R577', storeName: '天环广场', templateId: 'TPL', status: 'pending', attempts: 0, createdAt: f.state.now.toISOString(), detectedAt: f.state.now.toISOString(),
    targetSnapshot: { partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], updatedAt: f.state.now.toISOString() } };
  await f.repo.saveNotification(task);
  f.advance(1);
  await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available', observedAt: f.state.now.toISOString(), source: 'auto', quote: '今天可取货' } });
  const sends = [];
  const sender = async m => { sends.push(m); return { errcode: 0 }; };
  sender.appid = CONSUMER_APPID;
  await sendTask({ task, repo: f.repo, config, sendImpl: sender, now: f.state.now, clock: () => f.state.now });
  return { f, sends };
}

test('the alert opens the follow page on that event, readable only by its own account', async () => {
  const { f, sends } = await alerted();
  assert.equal(sends[0].page, `pages/follow/index?eid=${encodeURIComponent(EVENT)}`);
  const eventId = decodeURIComponent(sends[0].page.split('eid=')[1]);
  f.advance(60000);
  const detail = ok(await f.call('notify.detail', { eventId }));
  assert.equal(detail.notification.productTitle, 'iPhone 18 Pro Max 1TB 勃艮第酒红色');
  assert.equal(detail.notification.storeName, '天环广场');
  assert.equal(detail.notification.status, 'accepted');
  assert.equal(detail.latest.status, 'available');
  assert.equal(detail.latest.restricted, false);
  assert.deepEqual(detail.follow, { followId: FOLLOW, status: 'active' });
  failWith(await f.call('notify.detail', { eventId }, userContext('oOTHER00000000000000000001')), 'notification_not_found');
  failWith(await f.call('notify.detail', { eventId: '' }), 'invalid_notification_id');
  await f.repo.updateNotification(`${userKeyOf()}|${EVENT}`, { userHiddenAt: f.state.now.toISOString() });
  failWith(await f.call('notify.detail', { eventId }), 'notification_not_found');
});

test('"bought" feedback is recorded and pauses the follow; other answers keep watching', async () => {
  const { f } = await alerted();
  failWith(await f.call('notify.feedback', { eventId: EVENT, outcome: 'maybe' }), 'invalid_feedback');
  assert.deepEqual(ok(await f.call('notify.feedback', { eventId: EVENT, outcome: 'missed' })), { outcome: 'missed', paused: false });
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'active');
  assert.deepEqual(ok(await f.call('notify.feedback', { eventId: EVENT, outcome: 'bought' })), { outcome: 'bought', paused: true });
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'paused');
  const stored = await f.repo.getNotification(`${userKeyOf()}|${EVENT}`);
  assert.deepEqual(stored.feedback, { outcome: 'bought', at: f.state.now.toISOString() });
  assert.equal(ok(await f.call('notify.detail', { eventId: EVENT })).notification.feedback, 'bought');
  assert.deepEqual(ok(await f.call('notify.feedback', { eventId: EVENT, outcome: 'bought' })), { outcome: 'bought', paused: false }, 'already paused');
});

test('operator insights summarise availability windows, skipped alerts, send delay and feedback', async () => {
  const { f } = await alerted();
  const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
  const at = ms => new Date(f.state.now.getTime() + ms).toISOString();
  for (const [id, availableDurationMs] of [['w1', 30000], ['w2', 4 * 60000], ['w3', 20 * 60000], ['w4', 2 * 3600000]]) {
    f.repo.tables.get(C.events).set(id, { _id: id, type: 'became_unavailable', dayKey: '2026-09-15', detectedAt: at(0), availableDurationMs });
  }
  await f.repo.saveNotification({ _id: 'skip-1', userKey: 'someone', status: 'skipped', reason: 'no_subscription_credit', createdAt: at(1000), detectedAt: at(0) });
  await f.call('notify.feedback', { eventId: EVENT, outcome: 'bought' });
  await f.repo.updateNotification(`${userKeyOf()}|${EVENT}`, { sentAt: '2026-09-15T02:00:09.000Z' });
  f.advance(10000);
  failWith(await f.call('admin.insights', {}), 'forbidden');
  const data = ok(await f.call('admin.insights', { days: 3 }, operatorContext()));
  assert.equal(data.days, 3);
  assert.equal(data.availability.count, 4);
  assert.deepEqual(data.availability.buckets.map(b => b.count), [1, 1, 0, 1, 1]);
  assert.equal(data.availability.p50Ms, 4 * 60000);
  assert.equal(data.alerts.total, 2);
  assert.deepEqual(data.alerts.byStatus, { accepted: 1, skipped: 1 });
  assert.equal(data.alerts.noCreditShare, 0.5);
  assert.deepEqual(data.alerts.sendDelay, { count: 1, p50Ms: 9000, p90Ms: 9000, maxMs: 9000 });
  assert.deepEqual(data.feedback, { answered: 1, bought: 1, boughtShare: 1 });
  assert.equal(data.truncated, false);
});

test('only an explicit rendered-view acknowledgment records a view; detail reads remain available on metric failure', async () => {
  const { f } = await alerted();
  const taskId = `${userKeyOf()}|${EVENT}`;
  assert.equal((await f.repo.getNotification(taskId)).firstOpenedAt, undefined);
  ok(await f.call('notify.detail', { eventId: EVENT }));
  assert.equal((await f.repo.getNotification(taskId)).firstOpenedAt, undefined, 'reads and preloading are not rendered views');
  ok(await f.call('notify.open', { eventId: EVENT }));
  const first = (await f.repo.getNotification(taskId)).firstOpenedAt;
  f.advance(1000);
  ok(await f.call('notify.open', { eventId: EVENT }));
  assert.equal((await f.repo.getNotification(taskId)).firstOpenedAt, first);
  f.repo.recordNotificationOpen = async () => { throw Error('write unavailable'); };
  assert.equal(ok(await f.call('notify.detail', { eventId: EVENT })).latest.status, 'available');
});

test('activity counts distinct users and separates trial receipts from real inventory and bought feedback', async () => {
  const { f } = await alerted();
  const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
  const createdAt = f.state.now.toISOString();
  for (const [id, kind, status] of [['q1', 'live', 'success'], ['q2', 'live', 'success'], ['q3', 'history', 'success'], ['q4', 'live', 'failed']]) {
    f.repo.tables.get(C.queries).set(id, { _id: id, userKey: userKeyOf(), kind, status, response: { ok: status === 'success' }, createdAt });
  }
  f.repo.tables.get(C.notificationTests).set('t1', { _id: 't1', userKey: userKeyOf(), status: 'accepted', createdAt, firstOpenedAt: createdAt, firstPresentedAt: createdAt, feedback: { outcome: 'received', updatedAt: createdAt } });
  f.repo.tables.get(C.notificationTests).set('t2', { _id: 't2', userKey: userKeyOf(), status: 'failed', createdAt, refunded: true });
  ok(await f.call('notify.detail', { eventId: EVENT }));
  ok(await f.call('notify.open', { eventId: EVENT }));
  ok(await f.call('notify.feedback', { eventId: EVENT, outcome: 'bought' }));
  const data = ok(await f.call('admin.insights', {}, operatorContext()));
  assert.equal(data.activity.successfulQueryUsers, 1);
  assert.equal(data.activity.acceptedAlertUsers, 1);
  assert.equal(data.activity.openedAlertUsers, 1);
  assert.equal(data.activity.boughtUsers, 1);
  assert.equal(data.alerts.total, 1);
  assert.equal(data.feedback.answered, 1);
  assert.deepEqual(data.notificationTests, { total: 2, users: 1, byStatus: { accepted: 1, failed: 1 }, feedback: { received: 1 }, opened: 1, legacyOpened: 0 });
});

test('failed detail reads never invent an opening and explicit presentation remains account scoped', async () => {
  const { f } = await alerted();
  f.repo.getLatest = async () => { throw Error('offline'); };
  assert.equal((await f.call('notify.detail', { eventId: EVENT })).ok, false);
  assert.equal((await f.repo.getNotification(`${userKeyOf()}|${EVENT}`)).firstOpenedAt, undefined);
  failWith(await f.call('notify.open', { eventId: EVENT }, userContext('oOTHER00000000000000000001')), 'notification_not_found');
  await f.repo.updateNotification(`${userKeyOf()}|${EVENT}`, { userHiddenAt: f.state.now.toISOString() });
  failWith(await f.call('notify.open', { eventId: EVENT }), 'notification_not_found');
});

test('legacy read telemetry is preserved but never reported as a 1.6.0 rendered presentation', async () => {
  const { f } = await alerted();
  const taskId = `${userKeyOf()}|${EVENT}`, legacyAt = f.state.now.toISOString();
  await f.repo.updateNotification(taskId, { firstOpenedAt: legacyAt });
  let data = ok(await f.call('admin.insights', {}, operatorContext()));
  assert.equal(data.activity.openedAlertUsers, 0); assert.equal(data.activity.legacyOpenedAlertUsers, 1);
  assert.equal(data.activity.scope, 'created_in_window_cohort_not_sequential_funnel');
  f.advance(1000); ok(await f.call('notify.open', { eventId: EVENT }));
  const record = await f.repo.getNotification(taskId);
  assert.equal(record.firstOpenedAt, legacyAt); assert.equal(record.firstPresentedAt, f.state.now.toISOString());
  data = ok(await f.call('admin.insights', {}, operatorContext()));
  assert.equal(data.activity.openedAlertUsers, 1); assert.equal(data.activity.legacyOpenedAlertUsers, 0);
});
