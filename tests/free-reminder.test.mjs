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

// Follow and WeChat reminders are member-only. Free accounts only get query trial credits.
test('a free account cannot follow or authorize reminders; only query trial credits remain', async () => {
  const f = createFixture({ config });
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.freeReminder, false);
  assert.equal(boot.limits.maxFollows, 0);
  failWith(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'] }), 'member_required');
  failWith(await f.call('notify.recordSubscription', { requestId: 'subscription-0001', results: { TPL: 'accept' } }), 'membership_required');
  const listed = ok(await f.call('follow.list'));
  assert.equal(listed.freeReminder, false);
  assert.equal(listed.limits.maxFollows, 0);
  assert.equal(listed.follows.length, 0);

  const collector = createCollector({ repo: f.repo, fetchImpl: async () => { throw new Error('unused'); }, clock: () => new Date(f.state.now), log, statusEveryMs: 0 });
  await f.repo.saveFollow({ _id: `${userKeyOf()}|legacy`, userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  assert.equal((await collector.refreshTargets()).eligible, 0, 'non-member follows are not monitored');

  const sender = async () => { throw new Error('must not send'); };
  sender.appid = CONSUMER_APPID;
  const task = { _id: 'free-a', userKey: userKeyOf(), followId: `${userKeyOf()}|legacy`, eventId: 'event-free-a', eventType: 'restock_confirmed',
    partNumber: 'MJYH4CH/A', storeNumber: 'R577', templateId: 'TPL', status: 'pending', attempts: 0, createdAt: f.state.now.toISOString(), detectedAt: f.state.now.toISOString() };
  await seedNotificationObservation(f.repo, task);
  await f.repo.saveNotification(task);
  const sent = await sendTask({ task, repo: f.repo, config, sendImpl: sender, now: f.state.now, clock: () => f.state.now });
  assert.equal(sent.status, 'skipped');
  assert.ok(['membership_required', 'free_reminder_used', 'member_expired'].includes(sent.reason), sent.reason);
});

test('an active member may follow and record subscription grants as before', async () => {
  const f = createFixture({ config });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), {
    membership: { expiresAt: new Date(Date.parse(f.state.now) + 30 * 86400000).toISOString() },
    subscriptions: { TPL: { credits: 3 } },
  });
  ok(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'] }));
  ok(await f.call('notify.recordSubscription', { requestId: 'subscription-0001', results: { TPL: 'accept' } }));
  const listed = ok(await f.call('follow.list'));
  assert.equal(listed.member, true);
  assert.equal(listed.limits.maxFollows, 3);
  assert.equal(listed.follows[0].status, 'active');
});

test('an expired member keeps saved follows but cannot resume or authorize', async () => {
  const f = createFixture({ config });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2020-01-01T00:00:00.000Z' } });
  await f.repo.saveFollow({ _id: `${userKeyOf()}|f-0001-aaaa`, userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'paused' });
  failWith(await f.call('follow.resume', { followId: 'f-0001-aaaa' }), 'member_required');
  failWith(await f.call('notify.recordSubscription', { requestId: 'subscription-0002', results: { TPL: 'accept' } }), 'membership_required');
  const listed = ok(await f.call('follow.list'));
  assert.equal(listed.member, false);
  assert.equal(listed.follows.length, 1, 'saved configuration is kept');
});
