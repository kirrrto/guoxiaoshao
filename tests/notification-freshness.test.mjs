import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { buildTasks, sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const config = mergeConfig({ notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 0 } });

async function setup() {
  const f = createFixture({ config });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { TPL: { credits: 3 } } });
  const follow = { _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' };
  await f.repo.saveFollow(follow);
  const observe = async status => {
    f.advance(1000);
    return f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status, observedAt: f.state.now.toISOString(), source: 'auto' } });
  };
  await observe('unavailable'); await observe('unavailable');
  const changed = await observe('available'); await observe('available');
  const [task] = buildTasks({ events: changed.events, follows: [follow], users: new Map([[userKeyOf(), await f.repo.getUser(userKeyOf())]]), config, now: f.state.now });
  await f.repo.saveNotification(task);
  let sends = 0;
  const sender = async () => { sends++; return { errcode: 0 }; };
  sender.appid = CONSUMER_APPID;
  const send = () => sendTask({ task, config, repo: f.repo, sendImpl: sender, now: f.state.now, clock: () => f.state.now, ownerId: 'freshness-test' });
  return { f, task, observe, send, get sends() { return sends; } };
}

test('a confirmed pending restock is skipped if stock changed again before delivery', async () => {
  const s = await setup();
  await s.observe('unavailable');
  const result = await s.send();
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'event_superseded');
  assert.equal(s.sends, 0); assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('unknown latest or missing latest cannot deliver a previously confirmed pending restock', async () => {
  for (const missing of [false, true]) {
    const s = await setup();
    if (missing) s.f.repo.tables.get(C.latest).clear(); else await s.observe('unknown');
    const result = await s.send();
    assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'event_unconfirmed');
    assert.equal(s.sends, 0); assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  }
});

test('send-time reread after reservation suppresses a stock reversal and restores the authorization', async () => {
  const s = await setup();
  const reserve = s.f.repo.reserveSubscriptionCredit;
  s.f.repo.reserveSubscriptionCredit = async args => { const result = await reserve(args); await s.observe('unavailable'); return result; };
  const result = await s.send();
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'event_superseded');
  assert.equal(s.sends, 0); assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  assert.equal((await s.f.repo.getUser(userKeyOf())).firstReminderSentAt ?? null, null);
});

test('changes during the final lease renewal are reread before handing a notification to WeChat', async () => {
  for (const mutation of ['notifications_disabled', 'follow_not_active', 'user_disabled', 'event_unconfirmed']) {
    const s = await setup();
    let checks = 0, sends = 0;
    const sender = async () => { sends++; return { errcode: 0 }; }; sender.appid = CONSUMER_APPID;
    const result = await sendTask({ task: s.task, config, repo: s.f.repo, sendImpl: sender, now: s.f.state.now, clock: () => s.f.state.now,
      beforeSend: async () => {
        if (++checks === 3) {
          if (mutation === 'notifications_disabled') await s.f.repo.saveConfig({ ...config, notifications: { ...config.notifications, enabled: false } });
          if (mutation === 'follow_not_active') await s.f.repo.saveFollow({ ...await s.f.repo.getFollow('F'), status: 'paused' });
          if (mutation === 'user_disabled') await s.f.repo.updateUser(userKeyOf(), { settings: { notifyEnabled: false } });
          if (mutation === 'event_unconfirmed') await s.observe('unknown');
        }
        return true;
      } });
    assert.equal(checks, 3);
    assert.equal(sends, 0, mutation);
    assert.equal(result.status, 'skipped'); assert.equal(result.reason, mutation);
    assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  }
});

test('final policy reads still cannot send after the claim expires or the worker budget runs out', async () => {
  for (const expiredClaim of [true, false]) {
    const s = await setup();
    let latestReads = 0, remaining = 10000, sends = 0;
    const getLatest = s.f.repo.getLatest;
    s.f.repo.getLatest = async keys => {
      const result = await getLatest(keys);
      if (++latestReads === 2) {
        if (expiredClaim) { s.f.advance(61000); await s.f.repo.reconcileExpiredNotifications({ now: s.f.state.now.toISOString() }); }
        else remaining = 900;
      }
      return result;
    };
    const result = await sendTask({ task: s.task, config, repo: s.f.repo, sendImpl: async () => { sends++; return { errcode: 0 }; },
      now: s.f.state.now, clock: () => s.f.state.now, remainingMs: () => remaining });
    assert.equal(sends, 0);
    assert.equal(result.status, expiredClaim ? 'uncertain' : 'pending');
    assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
  }
});

test('an event expiring while its credit is reserved is not sent and the credit is restored', async () => {
  const s = await setup();
  const reserve = s.f.repo.reserveSubscriptionCredit;
  s.f.repo.reserveSubscriptionCredit = async args => { const result = await reserve(args); s.f.advance(121000); return result; };
  await s.send();
  assert.equal(s.sends, 0);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('malformed or implausibly future event time cannot bypass notification expiry', async () => {
  for (const detectedAt of ['not-a-time', '2027-01-01T00:00:00Z']) {
    const s = await setup();
    await s.f.repo.updateNotification(s.task._id, { detectedAt });
    const result = await s.send();
    assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'event_invalid_time'); assert.equal(s.sends, 0);
  }
});

test('a valid confirmed current restock is delivered only once across competing calls', async () => {
  const s = await setup();
  await Promise.all([s.send(), s.send()]);
  assert.equal(s.sends, 1);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
});

test('an expired sender cannot replay a claim reconciled by another worker', async () => {
  const s = await setup();
  const reserve = s.f.repo.reserveSubscriptionCredit;
  s.f.repo.reserveSubscriptionCredit = async args => {
    const result = await reserve(args);
    s.f.advance(61000);
    await s.f.repo.reconcileExpiredNotifications({ now: s.f.state.now.toISOString() });
    return result;
  };
  const result = await s.send();
  assert.equal(result.status, 'uncertain');
  assert.equal((await s.f.repo.getNotification(s.task._id)).status, 'uncertain');
  assert.equal(s.sends, 0);
  await s.send(); assert.equal(s.sends, 0, 'the expired original owner must not reset the task to pending');
});

test('a message attempt is bounded by its task claim even without a collector deadline', async () => {
  const s = await setup();
  const reserve = s.f.repo.reserveSubscriptionCredit;
  s.f.repo.reserveSubscriptionCredit = async args => { const result = await reserve(args); s.f.advance(57000); return result; };
  const attempts = [];
  await sendTask({ task: s.task, config, repo: s.f.repo, now: s.f.state.now, clock: () => s.f.state.now,
    sendImpl: async (_message, options) => { attempts.push(options.timeoutMs); return { errcode: 0 }; } });
  assert.deepEqual(attempts, [2000], 'three claim seconds left must reserve one for recording the outcome');
});
