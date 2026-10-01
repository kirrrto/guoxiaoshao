import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const log = { info() {}, warn() {}, error() {} };
const config = { notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 0 } };
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const failWith = (result, code) => { assert.equal(result.ok, false); assert.equal(result.error.code, code); };

async function setup({ credits = 3, membership } = {}) {
  const f = createFixture({ config });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { subscriptions: { TPL: { credits } }, ...(membership ? { membership } : {}) });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'], status: 'active' });
  const sends = [];
  const sender = async m => { sends.push(m); return { errcode: 0 }; };
  sender.appid = CONSUMER_APPID;
  const task = (id, storeNumber = 'R577') => ({ _id: id, userKey: userKeyOf(), followId: 'F', eventId: `event-${id}`, eventType: 'restock_confirmed',
    partNumber: 'MJYH4CH/A', storeNumber, templateId: 'TPL', status: 'pending', attempts: 0,
    createdAt: f.state.now.toISOString(), detectedAt: f.state.now.toISOString() });
  const send = async (t, impl = sender) => {
    await seedNotificationObservation(f.repo, t);
    await f.repo.saveNotification(t);
    return sendTask({ task: t, repo: f.repo, config, sendImpl: impl, now: f.state.now, clock: () => f.state.now, ownerId: 'test-sender' });
  };
  const user = () => f.repo.getUser(userKeyOf());
  return { f, sends, sender, task, send, user };
}

test('a new account follows one configuration and receives exactly one free restock alert', async () => {
  const f = createFixture({ config });
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.freeReminder, true);
  assert.equal(boot.limits.maxFollows, 1);
  ok(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'] }));
  const second = await f.call('follow.upsert', { followId: 'f-0002-bbbb', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] });
  failWith(second, 'too_many_follows');
  assert.match(second.error.message, /免费体验可关注 1 个/);
  ok(await f.call('notify.recordSubscription', { requestId: 'subscription-0001', results: { TPL: 'accept' } }));
  ok(await f.call('notify.recordSubscription', { requestId: 'subscription-0002', results: { TPL: 'accept' } }));
  const listed = ok(await f.call('follow.list'));
  assert.equal(listed.freeReminder, true);
  assert.equal(listed.limits.maxFollows, 1);
  assert.equal(listed.follows[0].status, 'active');

  const collector = createCollector({ repo: f.repo, fetchImpl: async () => { throw new Error('unused'); }, clock: () => new Date(f.state.now), log, statusEveryMs: 0 });
  assert.equal((await collector.refreshTargets()).eligible, 1, 'the trial follow is monitored');

  const sends = [];
  const sender = async m => { sends.push(m); return { errcode: 0 }; };
  sender.appid = CONSUMER_APPID;
  const task = (id, storeNumber) => ({ _id: id, userKey: userKeyOf(), followId: `${userKeyOf()}|f-0001-aaaa`, eventId: `event-${id}`, eventType: 'restock_confirmed',
    partNumber: 'MJYH4CH/A', storeNumber, templateId: 'TPL', status: 'pending', attempts: 0, createdAt: f.state.now.toISOString(), detectedAt: f.state.now.toISOString() });
  const send = async t => { await seedNotificationObservation(f.repo, t); await f.repo.saveNotification(t); return sendTask({ task: t, repo: f.repo, config, sendImpl: sender, now: f.state.now, clock: () => f.state.now }); };
  assert.equal((await send(task('free-a', 'R577'))).status, 'accepted');
  const second2 = await send(task('free-b', 'R639'));
  assert.deepEqual([second2.status, second2.reason], ['skipped', 'free_reminder_used']);
  assert.equal(sends.length, 1);
  const user = await f.repo.getUser(userKeyOf());
  assert.equal(user.firstReminderSentAt, f.state.now.toISOString());
  assert.equal(user.freeReminderTaskId, null);
  assert.equal(user.subscriptions.TPL.credits, 1, 'the unused authorization stays for a later membership');

  assert.equal(ok(await f.call('user.bootstrap')).freeReminder, false);
  assert.equal(ok(await f.call('follow.list')).follows[0].status, 'expired');
  assert.equal((await collector.refreshTargets()).eligible, 0, 'monitoring stops after the free alert');
  failWith(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }), 'member_required');
  failWith(await f.call('notify.recordSubscription', { requestId: 'subscription-0003', results: { TPL: 'accept' } }), 'membership_required');
});

test('concurrent events lock the free alert to one task; a failed send unlocks it', async () => {
  const s = await setup();
  const a = s.task('lock-a', 'R577');
  await s.f.repo.saveNotification(a);
  const reserved = await s.f.repo.reserveSubscriptionCredit({ userKey: userKeyOf(), templateId: 'TPL', taskId: a._id, now: s.f.state.now.toISOString(), targetKey: 'R577|MJYH4CH/A' });
  assert.equal(reserved.reserved, true);
  const b = await s.send(s.task('lock-b', 'R639'));
  assert.deepEqual([b.status, b.reason], ['skipped', 'free_reminder_in_use']);
  assert.equal(s.sends.length, 0);

  const other = await setup();
  const rejected = await other.send(other.task('rejected', 'R577'), async () => ({ errcode: 40037 }));
  assert.equal(rejected.status, 'failed');
  let user = await other.user();
  assert.equal(user.firstReminderSentAt, null);
  assert.equal(user.freeReminderTaskId, null);
  assert.equal(user.subscriptions.TPL.credits, 3);
  assert.equal((await other.send(other.task('retry', 'R639'))).status, 'accepted');
  user = await other.user();
  assert.ok(user.firstReminderSentAt);
});

test('a worker that dies after reserving the free alert cannot block or double it', async () => {
  const s = await setup();
  const a = s.task('crash-a', 'R577');
  await s.f.repo.saveNotification(a);
  const now = s.f.state.now.toISOString();
  await s.f.repo.claimNotification({ id: a._id, ownerId: 'dead', now, leaseUntil: new Date(s.f.state.now.getTime() + 1000).toISOString() });
  await s.f.repo.reserveSubscriptionCredit({ userKey: userKeyOf(), templateId: 'TPL', taskId: a._id, now, targetKey: 'R577|MJYH4CH/A' });
  s.f.advance(1001);
  await s.f.repo.reconcileExpiredNotifications({ now: s.f.state.now.toISOString() });
  const b = await s.send(s.task('crash-b', 'R639'));
  assert.deepEqual([b.status, b.reason], ['skipped', 'free_reminder_used'], 'a possibly delivered alert counts');
  const user = await s.user();
  assert.ok(user.firstReminderSentAt);
  assert.equal(user.freeReminderTaskId, null);

  // A lock left by a task that ended without sending is simply released.
  const other = await setup();
  const dead = other.task('dead-a', 'R577');
  await other.f.repo.saveNotification(dead);
  await other.f.repo.reserveSubscriptionCredit({ userKey: userKeyOf(), templateId: 'TPL', taskId: dead._id, now, targetKey: 'R577|MJYH4CH/A' });
  await other.f.repo.updateNotification(dead._id, { status: 'skipped', reason: 'lease_lost' });
  assert.equal((await other.send(other.task('dead-b', 'R639'))).status, 'accepted');
});

test('a member alert also uses up the free one, so an expired member is not re-trialled', async () => {
  const s = await setup({ membership: { expiresAt: '2026-10-15T00:00:00.000Z' } });
  assert.equal((await s.send(s.task('member-a', 'R577'))).status, 'accepted');
  let user = await s.user();
  assert.ok(user.firstReminderSentAt);
  assert.equal(user.freeReminderTaskId || null, null, 'members never take the trial lock');
  await s.f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-09-01T00:00:00.000Z' } });
  const b = await s.send(s.task('member-b', 'R639'));
  assert.deepEqual([b.status, b.reason], ['skipped', 'member_expired']);
  assert.equal(ok(await s.f.call('user.bootstrap')).freeReminder, false);

  // A member whose membership lapsed before any alert still has the free one.
  const unused = await setup({ membership: { expiresAt: '2026-09-01T00:00:00.000Z' } });
  assert.equal(ok(await unused.f.call('user.bootstrap')).freeReminder, true);
  assert.equal((await unused.send(unused.task('lapsed-a', 'R577'))).status, 'accepted');
});
