import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const account = (userKey = 'consumer:A', credits = 4) => ({ identity: { userKey }, membership: { active: true },
  notifications: { templateIds: { restock: 'R', soldout: 'S' } }, subscriptions: { R: { credits }, S: { credits } } });
const outcome = (credits = 5, extra = {}) => ({ accepted: ['R', 'S'], subscriptions: { R: { credits }, S: { credits } }, ...extra });
function setup(handler = async () => outcome()) {
  const rt = runtime(handler); rt.app.globalData.bootstrap = account();
  const credits = rt.load('utils/reminder-credits.js');
  let native = 0;
  rt.wx.requestSubscribeMessage = async () => { native++; return { R: 'accept', S: 'accept' }; };
  return { rt, credits, native: () => native, records: () => rt.calls.filter(call => call.action === 'notify.recordSubscription') };
}
const saved = (id, patch = {}) => ({ requestId: id, results: { R: 'accept', S: 'accept' }, ...patch });

test('a second real tap can authorize while the first cloud write is slow; cloud writes remain serial', async () => {
  const first = deferred(), second = deferred(); let writes = 0;
  const s = setup(() => ++writes === 1 ? first.promise : second.promise);
  const firstTap = s.credits.requestReminderAuthorization(['R', 'S'], { deferSync: true });
  assert.equal(s.native(), 1, 'native request retains this tap, before an await');
  const firstAck = await firstTap;
  assert.equal(firstAck.queued, true);
  assert.equal(s.credits.getAuthorizationState().nativeBusy, false);
  const secondAck = await s.credits.requestReminderAuthorization(['R', 'S'], { deferSync: true });
  assert.equal(s.native(), 2);
  assert.notEqual(firstAck.requestId, secondAck.requestId);
  assert.equal(s.records().length, 1, 'the second network write is queued');
  assert.deepEqual(copy(s.credits.getAuthorizationState().acceptedByTemplate), { R: 2, S: 2 });
  assert.equal(s.rt.app.globalData.bootstrap.subscriptions.R.credits, 4, 'queued grants never inflate confirmed credits');
  first.resolve(outcome(5)); await settle();
  assert.equal(s.records().length, 2);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 1);
  second.resolve(outcome(6)); await settle();
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
  assert.equal(s.rt.app.globalData.bootstrap.subscriptions.R.credits, 6);
});

test('two overlapping native prompts are blocked even in deferred mode', async () => {
  const native = deferred(), s = setup(); let calls = 0;
  s.rt.wx.requestSubscribeMessage = () => { calls++; return native.promise; };
  const tap = s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  assert.equal(s.credits.getAuthorizationState().nativeBusy, true);
  await assert.rejects(s.credits.requestReminderAuthorization(['R'], { deferSync: true }), { code: 'subscription_busy' });
  assert.equal(calls, 1);
  native.resolve({ R: 'accept' }); await tap; await settle();
  assert.equal(s.credits.getAuthorizationState().nativeBusy, false);
});

test('deferred feedback counts only actual accepts and preserves filtered and rejected outcomes', async () => {
  const write = deferred(), s = setup(() => write.promise);
  s.rt.wx.requestSubscribeMessage = async () => ({ R: 'accept', S: 'filter', T: 'reject' });
  const result = await s.credits.requestReminderAuthorization(['R', 'S', 'T'], { deferSync: true });
  assert.deepEqual(copy(result.accepted), ['R']);
  assert.deepEqual(copy(result.filtered), ['S']);
  assert.deepEqual(copy(s.credits.getAuthorizationState().acceptedByTemplate), { R: 1 });
  assert.deepEqual(s.records()[0].payload.results, { R: 'accept', T: 'reject' });
  assert.equal(s.records()[0].payload.expectedUserKey, 'consumer:A');
  write.resolve(outcome(5)); await settle();
  s.rt.wx.requestSubscribeMessage = async () => ({ R: 'filter', S: 'filter' });
  const filtered = await s.credits.requestReminderAuthorization(['R', 'S'], { deferSync: true });
  assert.equal(filtered.skipped, true);
  assert.equal(s.records().length, 1);
});

test('lost responses stop automatic writes; explicit recovery reuses the original receipt without another prompt', async () => {
  let attempts = 0;
  const s = setup(() => {
    if (++attempts === 1) throw Object.assign(Error('response lost'), { code: 'call_failed' });
    return outcome(5, { replayed: true, accepted: [] });
  });
  const accepted = await s.credits.requestReminderAuthorization(['R', 'S'], { deferSync: true });
  await settle();
  assert.equal(attempts, 1);
  assert.equal(s.credits.getAuthorizationState().error.code, 'call_failed');
  // A bootstrap may already include the applied grant. Pending feedback must
  // remain separate instead of adding it to this confirmed server snapshot.
  s.rt.app.globalData.bootstrap = account('consumer:A', 5);
  assert.equal(s.credits.getAuthorizationState().acceptedByTemplate.R, 1);
  assert.equal(s.rt.app.globalData.bootstrap.subscriptions.R.credits, 5);
  const retried = await s.credits.syncPendingAuthorization();
  assert.equal(retried.replayed, true);
  assert.equal(s.native(), 1);
  assert.equal(s.records()[1].payload.requestId, accepted.requestId);
  assert.deepEqual(s.records()[0].payload, s.records()[1].payload);
  assert.equal(s.credits.readPending(), null);
});

test('new user taps can queue during an outage but never create an unbounded automatic retry loop', async () => {
  const s = setup(() => { throw Object.assign(Error('offline'), { code: 'call_failed' }); });
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true }); await settle();
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true }); await settle();
  assert.equal(s.records().length, 1);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 2);
  assert.equal(s.credits.getAuthorizationState().error.code, 'call_failed');
  assert.equal(s.rt.timers.size, 0, 'no background native or retry timer exists');
});

test('default callers await server confirmation and a preexisting queue is resumed without native authorization', async () => {
  const write = deferred(), s = setup(() => write.promise); let returned = false;
  const result = s.credits.requestReminderAuthorization(['R', 'S']).then(value => { returned = true; return value; });
  await settle(); assert.equal(returned, false);
  assert.equal(s.credits.isSubscriptionBusy(), false, 'server wait does not own the native lock');
  write.resolve(outcome()); assert.deepEqual(copy((await result).accepted), ['R', 'S']);
  await settle();
  s.credits.savePending(saved('already-accepted-0001'));
  const synced = await s.credits.requestReminderAuthorization(['R', 'S']);
  assert.equal(s.native(), 1);
  assert.deepEqual(copy(synced.subscriptions), outcome().subscriptions);
});

test('save deduplicates IDs and acknowledgement removes only the matching entry', () => {
  const s = setup();
  const first = s.credits.savePending(saved('request-0001'));
  const second = s.credits.savePending(saved('request-0002', { results: { R: 'accept' } }));
  s.credits.savePending(saved('request-0001', { results: { R: 'reject' } }));
  assert.equal(s.credits.getAuthorizationState().pendingCount, 2);
  assert.equal(s.credits.readPending().results.R, 'accept', 'duplicate ID cannot rewrite an accepted outcome');
  s.credits.clearPending(second);
  assert.equal(s.credits.readPending().requestId, first.requestId);
  s.credits.clearPending(saved('missing-0001'));
  assert.equal(s.credits.getAuthorizationState().pendingCount, 1);
  s.credits.clearPending(first);
  assert.equal(s.credits.readPending(), null);
});

test('a restart restores every queued request ID and drains in order', async () => {
  const first = setup();
  first.credits.savePending(saved('restart-0001'));
  first.credits.savePending(saved('restart-0002'));
  const second = setup();
  for (const [key, value] of first.rt.storage) second.rt.storage.set(key, copy(value));
  await second.credits.syncPendingAuthorization();
  assert.deepEqual(second.records().map(call => call.payload.requestId), ['restart-0001', 'restart-0002']);
  assert.equal(second.native(), 0);
  assert.equal(second.credits.getAuthorizationState().pendingCount, 0);
});

test('an account change during a native prompt preserves the grant for its original account', async () => {
  const consent = deferred(), s = setup();
  s.rt.wx.requestSubscribeMessage = () => consent.promise;
  const pending = s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  s.rt.app.globalData.bootstrap = account('consumer:B', 99);
  consent.resolve({ R: 'accept' });
  await assert.rejects(pending, { code: 'subscription_account_changed' });
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
  await s.credits.syncPendingAuthorization(); assert.equal(s.records().length, 0);
  s.rt.app.globalData.bootstrap = account('consumer:A');
  assert.equal(s.credits.readPending().userKey, 'consumer:A');
  await s.credits.syncPendingAuthorization();
  assert.equal(s.records()[0].payload.expectedUserKey, 'consumer:A');
});

test('an old account response cannot publish into another account or send the old account next entry', async () => {
  const write = deferred(), s = setup(() => write.promise);
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  s.rt.app.globalData.bootstrap = account('consumer:B', 99);
  write.resolve(outcome(5)); await settle();
  assert.equal(s.records().length, 1);
  assert.equal(s.rt.app.globalData.bootstrap.subscriptions.R.credits, 99);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
  s.rt.app.globalData.bootstrap = account('consumer:A');
  assert.equal(s.credits.getAuthorizationState().pendingCount, 1, 'only the acknowledged entry is removed');
  await s.credits.syncPendingAuthorization();
  assert.equal(s.records().length, 2);
});

test('temporary missing bootstrap never discards unsent grants or publishes an old balance', async () => {
  const write = deferred(), s = setup(() => write.promise);
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  s.rt.app.globalData.bootstrap = null;
  write.resolve(outcome(5)); await settle();
  assert.equal(s.rt.app.globalData.bootstrap, null);
  assert.equal(s.records().length, 1);
  s.rt.app.globalData.bootstrap = account();
  assert.equal(s.credits.getAuthorizationState().pendingCount, 1);
  await s.credits.syncPendingAuthorization();
  assert.equal(s.records().length, 2);
});

test('known legacy IDs migrate with their timestamp while stale and undated saved grants never replay', async () => {
  for (const offset of [60000, 8 * 86400000]) {
    const s = setup(), createdAt = Date.now() - offset;
    const requestId = `ns-${createdAt.toString(36)}-known123`;
    s.rt.storage.set(s.credits.PENDING_KEY, saved(requestId));
    assert.equal(s.credits.getAuthorizationState().pendingCount, offset < s.credits.PENDING_TTL_MS ? 1 : 0);
    if (offset > s.credits.PENDING_TTL_MS) assert.equal(s.credits.getAuthorizationState().error.code, 'subscription_pending_expired');
    await s.credits.syncPendingAuthorization();
    assert.equal(s.records().length, offset < s.credits.PENDING_TTL_MS ? 1 : 0);
  }
  const unknown = setup(); unknown.rt.storage.set(unknown.credits.PENDING_KEY, saved('old-unknown-date'));
  await unknown.credits.syncPendingAuthorization();
  assert.equal(unknown.records().length, 0);
  assert.equal(unknown.credits.getAuthorizationState().error.code, 'subscription_pending_expired');
});

test('a legacy slot first read before bootstrap can bind after account confirmation without losing its ID', async () => {
  const s = setup(), requestId = `ns-${Date.now().toString(36)}-known123`;
  s.rt.app.globalData.bootstrap = null;
  s.rt.storage.set(s.credits.PENDING_KEY, saved(requestId));
  assert.equal(s.credits.readPending(), null);
  s.rt.app.globalData.bootstrap = account();
  assert.equal(s.credits.readPending().requestId, requestId);
  await s.credits.syncPendingAuthorization();
  assert.equal(s.records()[0].payload.requestId, requestId);
});

test('a storage failure keeps the accepted grant in memory and blocks further collection until persistence recovers', async () => {
  const write = deferred(), s = setup(() => write.promise);
  const set = s.rt.wx.setStorageSync, remove = s.rt.wx.removeStorageSync;
  s.rt.wx.setStorageSync = () => { throw Error('disk full'); };
  s.rt.wx.removeStorageSync = () => { throw Error('disk full'); };
  const accepted = await s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  assert.equal(accepted.storageWarning, true);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 1);
  assert.equal(s.credits.getAuthorizationState().storageBlocked, true);
  await assert.rejects(s.credits.requestReminderAuthorization(['R'], { deferSync: true }), { code: 'subscription_storage_failed' });
  assert.equal(s.native(), 1);
  write.resolve(outcome(5)); await settle();
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0, 'a confirmed write can release the in-memory entry');
  assert.equal(s.credits.getAuthorizationState().storageBlocked, true, 'the stale on-disk state still needs repair');
  s.rt.wx.setStorageSync = set; s.rt.wx.removeStorageSync = remove;
  await s.credits.syncPendingAuthorization();
  assert.equal(s.credits.getAuthorizationState().storageBlocked, false);
});

test('an unreadable outbox cannot be overwritten by a fresh native request', async () => {
  const s = setup(), get = s.rt.wx.getStorageSync;
  s.rt.wx.getStorageSync = () => { throw Error('read failed'); };
  await assert.rejects(s.credits.requestReminderAuthorization(['R'], { deferSync: true }), { code: 'subscription_storage_failed' });
  assert.equal(s.native(), 0);
  s.rt.wx.getStorageSync = get;
  assert.equal(s.credits.getAuthorizationState().storageBlocked, false);
});

test('malformed v2 storage is preserved and cannot be overwritten by a fresh grant', async () => {
  for (const malformed of [{ version: 9, entries: [] }, { version: 2, entries: [{ requestId: 'broken-001', results: { R: 'accept' } }] }]) {
    const s = setup(); s.rt.storage.set(s.credits.PENDING_KEY, malformed);
    assert.equal(s.credits.getAuthorizationState().error.code, 'subscription_storage_invalid');
    await assert.rejects(s.credits.requestReminderAuthorization(['R'], { deferSync: true }), { code: 'subscription_storage_failed' });
    await s.credits.syncPendingAuthorization();
    assert.deepEqual(s.rt.storage.get(s.credits.PENDING_KEY), malformed);
    assert.equal(s.native(), 0); assert.equal(s.records().length, 0);
  }
});

test('a default waiter is rejected instead of hanging when its queued grant expires', async () => {
  const first = deferred(), s = setup(() => first.promise);
  const pending = s.credits.requestReminderAuthorization(['R']);
  const rejected = assert.rejects(pending, { code: 'subscription_pending_expired' });
  await settle();
  const entry = s.credits.readPending();
  entry.createdAt = Date.now() - s.credits.PENDING_TTL_MS - 1;
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
  await rejected;
  first.resolve(outcome(5)); await settle();
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
});

test('at 100 queued records a new native request is refused before any authorization occurs', async () => {
  const s = setup();
  for (let i = 0; i < 100; i++) s.credits.savePending(saved(`bounded-${String(i).padStart(4, '0')}`));
  await assert.rejects(s.credits.requestReminderAuthorization(['R'], { deferSync: true }), { code: 'subscription_queue_full' });
  assert.equal(s.native(), 0); assert.equal(s.records().length, 0);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 100);
});

test('a terminal invalid template drops only that request and continues valid entries; membership denial pauses the rest', async () => {
  let index = 0;
  const invalid = setup(() => { if (++index === 1) throw Object.assign(Error('changed template'), { code: 'invalid_subscription_result' }); return outcome(5); });
  invalid.credits.savePending(saved('invalid-0001')); invalid.credits.savePending(saved('valid-000002'));
  await assert.rejects(invalid.credits.syncPendingAuthorization(), { code: 'invalid_subscription_result' });
  assert.equal(invalid.records().length, 2); assert.equal(invalid.credits.readPending(), null);
  const expired = setup(() => { throw Object.assign(Error('expired member'), { code: 'membership_required' }); });
  expired.credits.savePending(saved('expired-0001')); expired.credits.savePending(saved('untried-0002'));
  await assert.rejects(expired.credits.syncPendingAuthorization(), { code: 'membership_required' });
  assert.equal(expired.records().length, 1);
  assert.equal(expired.credits.readPending().requestId, 'untried-0002');
});

test('immediately completing workers never strand a newly enqueued grant at the finishing boundary', async () => {
  const s = setup();
  for (let i = 0; i < 20; i++) await s.credits.requestReminderAuthorization(['R'], { deferSync: true });
  await settle();
  assert.equal(s.records().length, 20);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
  assert.equal(s.credits.getAuthorizationState().syncing, false);
  assert.equal(new Set(s.records().map(call => call.payload.requestId)).size, 20);
});

test('a new grant at a terminal-error finishing boundary does not inherit the preceding invalid request error', async () => {
  let calls = 0, next;
  const s = setup(() => { if (++calls === 1) throw Object.assign(Error('old template'), { code: 'invalid_subscription_result' }); return outcome(5); });
  s.credits.savePending(saved('old-template-001'));
  const unsubscribe = s.credits.subscribeAuthorizationState(state => {
    if (state.syncing && state.pendingCount === 0 && state.error && state.error.code === 'invalid_subscription_result' && !next) {
      next = true;
      next = s.credits.requestReminderAuthorization(['R']);
    }
  });
  await assert.rejects(s.credits.syncPendingAuthorization(), { code: 'invalid_subscription_result' });
  assert.equal((await next).subscriptions.R.credits, 5);
  await settle(); unsubscribe();
  assert.equal(calls, 2); assert.equal(s.credits.readPending(), null);
});

test('state subscriptions are immediate and removable, and an unknown identity cannot authorize', async () => {
  const s = setup(), states = [];
  const unsubscribe = s.credits.subscribeAuthorizationState(state => states.push(copy(state)));
  assert.equal(states.length, 1);
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true }); await settle();
  assert.ok(states.some(state => state.nativeBusy));
  assert.ok(states.some(state => state.pendingCount === 1));
  unsubscribe(); const count = states.length;
  await s.credits.requestReminderAuthorization(['R'], { deferSync: true }); await settle();
  assert.equal(states.length, count);
  s.rt.app.globalData.bootstrap = null;
  await assert.rejects(s.credits.requestReminderAuthorization(['R'], { deferSync: true }), { code: 'subscription_identity_required' });
  assert.equal(s.native(), 2);
});
