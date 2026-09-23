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
  await f.repo.saveFollow({ _id: FOLLOW, userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available', observedAt: f.state.now.toISOString(), source: 'auto', quote: '今天可取货' } });
  const task = { _id: `${userKeyOf()}|${EVENT}`, userKey: userKeyOf(), followId: FOLLOW, eventId: EVENT, eventType: 'restock_confirmed', partNumber: 'MJYH4CH/A',
    storeNumber: 'R577', storeName: '天环广场', templateId: 'TPL', status: 'pending', attempts: 0, createdAt: f.state.now.toISOString(), detectedAt: f.state.now.toISOString() };
  await f.repo.saveNotification(task);
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
  await f.repo.updateNotification(`${userKeyOf()}|${EVENT}`, { sentAt: at(9000) });
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
