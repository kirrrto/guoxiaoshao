import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { sendTask, buildTasks } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { currentAvailabilityEvent } = require('../cloudfunctions/gxs_api/lib/engine/current-availability');
const { applyObservation } = require('../cloudfunctions/gxs_api/lib/engine/events');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const log = { info() {}, warn() {}, error() {} };
const config = { collector: { enabled: false }, notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 0 } };
const key = 'R577|MJYH4CH/A';

async function setup({ credits = 3, status = 'active', senderResult = { errcode: 0 } } = {}) {
  const f = createFixture({ config });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-10-15T00:00:00.000Z' }, subscriptions: { TPL: { credits } } });
  const follow = { _id: `${userKeyOf()}|follow001`, userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'],
    status, createdAt: f.state.now.toISOString(), updatedAt: f.state.now.toISOString() };
  await f.repo.saveFollow(follow);
  const latest = { _id: key, storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available',
    statusSince: '2026-09-15T00:00:00.000Z', availabilityEpisodeSince: '2026-09-15T00:00:00.000Z',
    knownStreakSince: '2026-09-15T01:59:00.000Z', knownAt: f.state.now.toISOString(), observedAt: f.state.now.toISOString(),
    statusConfirmed: true, unknownSince: null, storeName: '天环广场', productTitle: 'iPhone 18 Pro Max' };
  await f.repo.saveLatest(latest);
  const sends = [];
  const sender = async message => { sends.push(message); if (senderResult instanceof Error) throw senderResult; return senderResult; };
  sender.appid = CONSUMER_APPID;
  const collector = createCollector({ repo: f.repo, clock: () => f.state.now, sendImpl: sender, log, ownerId: 'current-delivery' });
  const drain = async (elapsed = 0) => { f.advance(elapsed); await collector.lease.renew(); await collector.drainNotifications(); };
  const tasks = () => [...f.repo.tables.get(C.notifications).values()];
  return { f, follow, latest, sends, sender, collector, drain, tasks };
}

test('a newly saved follow receives current confirmed availability without waiting for a new stock transition or upstream request', async () => {
  const s = await setup();
  await s.drain();
  assert.equal(s.sends.length, 1);
  assert.equal(s.tasks()[0].eventType, 'current_available');
  assert.equal(s.tasks()[0].detectedAt, s.latest.knownAt, 'message time is the actual fresh sample, not the hours-old stock transition');
  assert.equal(s.sends[0].data.thing4.value, '当前可取货');
  assert.equal(s.tasks()[0].status, 'accepted');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
  assert.equal(s.f.state.fetchImpl.calls.length, 0);
  assert.equal(s.f.repo.tables.get(C.events).size, 0, 'current-state delivery does not invent a restock in stock history');
});

test('resume and replenishing consent recover continued availability missed while paused or lacking credits', async () => {
  for (const reason of ['paused', 'no_credit']) {
    const s = await setup({ credits: reason === 'no_credit' ? 0 : 3, status: reason === 'paused' ? 'paused' : 'active' });
    await s.drain();
    assert.equal(s.sends.length, 0);
    if (reason === 'paused') {
      assert.equal((await s.f.call('follow.resume', { followId: s.follow._id })).ok, true);
    } else {
      assert.equal((await s.f.call('notify.recordSubscription', { requestId: 'consent001', results: { TPL: 'accept' } })).ok, true);
    }
    await s.drain(31000);
    assert.equal(s.sends.length, 1, reason);
    await s.drain(31000);
    assert.equal(s.sends.length, 1, 'same availability does not spend another permission');
  }
});

test('old skipped transition records do not permanently suppress a fresh current-state reminder', async () => {
  const s = await setup();
  await s.f.repo.saveNotification({ _id: `${userKeyOf()}|${key}|restock_confirmed|${s.latest.statusSince}`, userKey: userKeyOf(),
    followId: s.follow._id, status: 'skipped', reason: 'no_subscription_credit', createdAt: s.latest.statusSince });
  await s.drain();
  assert.equal(s.sends.length, 1);
  assert.equal(s.tasks().filter(task => task.status === 'accepted').length, 1);
});

test('accepted or uncertain current delivery is never replayed by consent, pause/resume, cooldown expiry, restart, or history deletion', async () => {
  for (const senderResult of [{ errcode: 0 }, new Error('response lost')]) {
    const s = await setup({ senderResult });
    await s.drain();
    assert.equal(s.tasks()[0].status, senderResult instanceof Error ? 'uncertain' : 'accepted');
    await s.f.call('notify.recordSubscription', { requestId: 'consent002', results: { TPL: 'accept' } });
    await s.f.call('follow.pause', { followId: s.follow._id });
    await s.f.call('follow.resume', { followId: s.follow._id });
    s.f.repo.tables.get(C.notifications).clear();
    await s.collector.lease.release();
    s.f.advance(3600000);
    await s.f.repo.saveLatest({ ...s.latest, knownAt: s.f.state.now.toISOString(), observedAt: s.f.state.now.toISOString() });
    await runScheduled({ repo: s.f.repo, sendImpl: s.sender, clock: () => s.f.state.now, log, ownerId: 'replacement' });
    assert.equal(s.sends.length, 1, 'the durable episode marker survives short-lived notification history');
  }
});

test('legacy accepted transition and cooldown documents prevent a duplicate during rollout', async () => {
  const s = await setup();
  const normal = { _id: `${userKeyOf()}|${key}|restock_confirmed|${s.latest.statusSince}`, userKey: userKeyOf(),
    followId: s.follow._id, eventType: 'restock_confirmed', partNumber: 'MJYH4CH/A', storeNumber: 'R577',
    detectedAt: s.latest.statusSince, templateId: 'TPL', status: 'pending', createdAt: s.latest.statusSince };
  await s.f.repo.saveNotification(normal);
  assert.equal((await s.f.repo.reserveSubscriptionCredit({ userKey: userKeyOf(), templateId: 'TPL', taskId: normal._id,
    now: s.f.state.now.toISOString(), targetKey: key, cooldownMinutes: 0 })).reserved, true);
  const marker = [...s.f.repo.tables.get(C.config).values()].find(row => row.taskId === normal._id);
  delete marker.availabilitySince;
  await s.f.repo.updateNotification(normal._id, { status: 'accepted' });
  s.f.repo.tables.get(C.notifications).clear();
  await s.drain();
  assert.equal(s.sends.length, 0, 'legacy deterministic event IDs retain the episode barrier even after retention');
});

test('stale, unknown, future, unconfirmed and no-stock samples cannot trigger current-state delivery', async () => {
  for (const patch of [
    { knownAt: '2026-09-15T01:57:59.000Z', observedAt: '2026-09-15T01:57:59.000Z' },
    { unknownSince: '2026-09-15T01:59:59.000Z' },
    { knownAt: '2026-09-15T02:00:01.000Z', observedAt: '2026-09-15T02:00:01.000Z' },
    { knownStreakSince: '2026-09-15T02:00:00.000Z' },
    { status: 'unavailable' },
  ]) {
    const s = await setup(); await s.f.repo.saveLatest({ ...s.latest, ...patch }); await s.drain();
    assert.equal(s.sends.length, 0, JSON.stringify(patch));
    assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  }
});

test('a legacy latest row with two known observations can deliver current availability without a new schema migration', async () => {
  const s = await setup();
  const legacy = { ...s.latest };
  delete legacy.knownStreakSince;
  delete legacy.availabilityEpisodeSince;
  await s.f.repo.saveLatest(legacy);
  await s.drain();
  assert.equal(s.sends.length, 1);
  assert.equal(s.tasks()[0].status, 'accepted');
});

test('quiet-hour samples are not replayed after DND; a newly confirmed sample outside quiet hours can notify', async () => {
  const s = await setup();
  await s.f.repo.updateUser(userKeyOf(), { settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 9 * 60, endMinute: 10 * 60 + 1 } } });
  await s.drain(); assert.equal(s.sends.length, 0);
  await s.drain(61000); assert.equal(s.sends.length, 0, 'the 10:00 sample belongs to quiet hours');
  await s.f.repo.saveLatest({ ...s.latest, knownAt: '2026-09-15T02:01:30.000Z', observedAt: '2026-09-15T02:01:30.000Z' });
  await s.drain(31000); assert.equal(s.sends.length, 1);
});

test('a confirmed new no-stock phase resets the episode, but a one-sample blip and coverage gap do not', async () => {
  const s = await setup(); await s.drain();
  let previous = s.latest;
  const sample = async status => {
    s.f.advance(1000);
    previous = applyObservation(previous, { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status, observedAt: s.f.state.now.toISOString() }).latest;
    await s.f.repo.saveLatest(previous);
  };
  await sample('unavailable'); await sample('available'); await sample('available');
  await s.drain(31000);
  assert.equal(s.sends.length, 1, 'a stock blip does not create another paid notification');
  await sample('unknown'); await sample('available'); await sample('available');
  await s.drain(31000);
  assert.equal(s.sends.length, 1, 'coverage recovery of the same available phase is not another alert');
  await sample('unavailable'); await sample('unavailable'); await sample('available'); await sample('available');
  await s.drain(31000);
  assert.equal(s.sends.length, 2, 'a genuinely new confirmed availability phase may send once');
});

test('final stock recheck prevents delivery if inventory changes after planning, without losing a permission', async () => {
  const s = await setup();
  const queue = s.f.repo.queueCurrentAvailability;
  s.f.repo.queueCurrentAvailability = async task => {
    const saved = await queue(task);
    await s.f.repo.saveLatest({ ...s.latest, status: 'unavailable' });
    return saved;
  };
  await s.drain();
  assert.equal(s.sends.length, 0);
  assert.equal(s.tasks()[0].reason, 'event_superseded');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('explicitly expired WeChat authorization can recover with fresh consent, while unknown sends remain blocked', async () => {
  const s = await setup({ senderResult: { errcode: 43101 } });
  await s.drain(); assert.equal(s.tasks()[0].reason, 'subscription_authorization_expired');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 0);
  await s.f.call('notify.recordSubscription', { requestId: 'consent003', results: { TPL: 'accept' } });
  await s.collector.lease.release();
  const accepted = [];
  const replacement = createCollector({ repo: s.f.repo, clock: () => s.f.state.now, sendImpl: async message => { accepted.push(message); return { errcode: 0 }; }, log });
  await replacement.lease.acquire(); await replacement.drainNotifications();
  assert.equal(accepted.length, 1);
  assert.equal(s.tasks()[0].status, 'accepted');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 0);
});

test('concurrent normal and current-state senders reserve only one permission for an availability episode', async () => {
  const s = await setup();
  const fresh = { ...s.latest, statusSince: '2026-09-15T01:59:00.000Z', availabilityEpisodeSince: '2026-09-15T01:59:00.000Z' };
  await s.f.repo.saveLatest(fresh);
  const current = currentAvailabilityEvent(fresh, mergeConfig(config), s.f.state.now);
  const normal = { ...current, _id: `${key}|restock_confirmed|${fresh.statusSince}`, type: 'restock_confirmed', detectedAt: fresh.statusSince };
  const tasks = buildTasks({ events: [normal, current], follows: [s.follow], users: new Map([[userKeyOf(), await s.f.repo.getUser(userKeyOf())]]), config: mergeConfig(config), now: s.f.state.now });
  for (const task of tasks) await s.f.repo.saveNotification(task);
  await Promise.all(tasks.map((task, i) => sendTask({ task, config: mergeConfig(config), sendImpl: s.sender, repo: s.f.repo,
    now: s.f.state.now, clock: () => s.f.state.now, ownerId: `sender-${i}` })));
  assert.equal(s.sends.length, 1);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
  assert.equal(s.tasks().filter(task => task.reason === 'already_notified').length, 1);
});

test('scheduled cold starts persist the catch-up cursor so accounts past the first page are serviced', async () => {
  const s = await setup();
  for (let i = 0; i < 45; i += 1) {
    const key = `member-${String(i).padStart(2, '0')}`;
    await s.f.repo.createUser({ ...(await s.f.repo.getUser(userKeyOf())), _id: key, openid: key });
    await s.f.repo.saveFollow({ ...s.follow, _id: `${key}|follow001`, userKey: key });
  }
  for (let i = 0; i < 4; i += 1) {
    await runScheduled({ repo: s.f.repo, sendImpl: s.sender, clock: () => s.f.state.now, log, ownerId: `cold-${i}` });
    s.f.advance(1000);
  }
  assert.equal(new Set(s.sends.map(message => message.touser)).size, 46);
  assert.equal(s.sends.length, 46, 'round-robin pagination neither loses nor repeats paid accounts');
});

test('a large stale outbox cannot block new useful alerts, and reserved or uncertain sends are never refunded/replayed by expiry', async () => {
  const s = await setup();
  for (let i = 0; i < 150; i += 1) await s.f.repo.saveNotification({
    _id: `stale-${i}`, userKey: userKeyOf(), status: 'pending', detectedAt: '2026-09-14T00:00:00.000Z', createdAt: '2026-09-14T00:00:00.000Z',
  });
  await s.f.repo.saveNotification({ _id: 'uncertain', userKey: userKeyOf(), status: 'uncertain', subscriptionReserved: true,
    detectedAt: '2026-09-14T00:00:00.000Z', createdAt: '2026-09-14T00:00:00.000Z' });
  await s.drain();
  assert.equal(s.sends.length, 1, 'the fresh current-state reminder reaches the first delivery batch');
  assert.equal(s.tasks().filter(task => task.reason === 'event_expired').length, 150);
  assert.equal((await s.f.repo.getNotification('uncertain')).status, 'uncertain');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
});

test('explicit temporary platform failures retry only after backoff and a fresh confirmed sample', async () => {
  const response = { errcode: 45009 };
  const s = await setup({ senderResult: response });
  await s.drain();
  assert.equal(s.tasks()[0].retryable, true);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  await s.drain(31000); assert.equal(s.sends.length, 1, 'a limit rejection is not retried at every notification pass');
  response.errcode = 0;
  await s.drain(300000); assert.equal(s.sends.length, 1, 'backoff expiry alone cannot resurrect stale inventory');
  await s.f.repo.saveLatest({ ...s.latest, knownAt: s.f.state.now.toISOString(), observedAt: s.f.state.now.toISOString() });
  await s.drain(31000);
  assert.equal(s.sends.length, 2);
  assert.equal(s.tasks()[0].status, 'accepted');
  assert.equal(s.tasks()[0].attempts, 2);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
});

test('failures proven to occur before the message endpoint back off exponentially without consuming permission', async () => {
  const error = Object.assign(new Error('token request failed'), { code: 'wechat_token_transport_error', definitelyNotSent: true });
  const s = await setup({ senderResult: error });
  await s.drain();
  assert.equal(s.tasks()[0].retryAfterAt, '2026-09-15T02:00:30.000Z');
  await s.drain(31000); assert.equal(s.sends.length, 2);
  assert.equal(s.tasks()[0].retryAfterAt, '2026-09-15T02:01:31.000Z');
  await s.drain(31000); assert.equal(s.sends.length, 2);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('current-state fallback respects the original transition sender backoff', async () => {
  const s = await setup({ senderResult: { errcode: 45009 } });
  const latest = { ...s.latest, statusSince: '2026-09-15T01:59:00.000Z', availabilityEpisodeSince: '2026-09-15T01:59:00.000Z' };
  await s.f.repo.saveLatest(latest);
  const event = { ...currentAvailabilityEvent(latest, mergeConfig(config), s.f.state.now),
    _id: `${key}|restock_confirmed|${latest.statusSince}`, type: 'restock_confirmed', detectedAt: latest.statusSince };
  const [task] = buildTasks({ events: [event], follows: [s.follow], users: new Map([[userKeyOf(), await s.f.repo.getUser(userKeyOf())]]), config: mergeConfig(config), now: s.f.state.now });
  await s.f.repo.saveNotification(task);
  await sendTask({ task, config: mergeConfig(config), sendImpl: s.sender, repo: s.f.repo, now: s.f.state.now, clock: () => s.f.state.now });
  await s.drain();
  assert.equal(s.sends.length, 1);
  assert.equal(s.tasks().length, 1, 'fallback cannot bypass a real WeChat rejection backoff');
});

test('reauthorization after hiding or clearing a failed attempt creates a visible receipt and a readable message deep link', async () => {
  for (const action of ['notify.delete', 'notify.clear']) {
    const response = { errcode: 43101 };
    const s = await setup({ senderResult: response }); await s.drain();
    const previous = s.tasks()[0];
    const page = await s.f.call('notify.list', {});
    assert.equal((await s.f.call(action, action === 'notify.delete' ? { id: previous._id } : { before: page.data.clearBefore })).ok, true);
    assert.equal((await s.f.call('notify.recordSubscription', { requestId: 'consent004', results: { TPL: 'accept' } })).ok, true);
    response.errcode = 0;
    await s.drain(31000);
    const current = s.tasks()[0];
    assert.equal(current.status, 'accepted');
    assert.equal(current.userHiddenAt, undefined);
    assert.ok(current.viewSequence > previous.viewSequence);
    assert.equal(current.createdAt, s.f.state.now.toISOString());
    assert.equal(current.firstCreatedAt, previous.createdAt);
    assert.equal((await s.f.call('notify.list', {})).data.notifications.length, 1);
    assert.equal((await s.f.call('notify.detail', { eventId: current.eventId })).ok, true);
  }
});
