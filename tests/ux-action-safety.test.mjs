import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, userContext } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { buildTasks } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const FOLLOW_ID = 'ux-safety-follow-001';
const FOLLOW = `${userKeyOf()}|${FOLLOW_ID}`;
const PART = 'MJYH4CH/A';
const EVENT = `R577|${PART}|restock_confirmed|2026-09-15T02:00:00.000Z`;
const config = mergeConfig({ notifications: { enabled: true, templateIds: { restock: 'TPL' } } });

async function fixture() {
  const f = createFixture({ config });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00.000Z' }, subscriptions: { TPL: { credits: 2 } } });
  ok(await f.call('follow.upsert', { followId: FOLLOW_ID, partNumber: PART, storeNumbers: ['R577', 'R639'] }));
  const follow = await f.repo.getFollow(FOLLOW);
  const user = await f.repo.getUser(userKeyOf());
  const [task] = buildTasks({ events: [{ _id: EVENT, type: 'restock_confirmed', partNumber: PART, storeNumber: 'R577', detectedAt: f.state.now.toISOString() }],
    follows: [follow], users: new Map([[userKeyOf(), user]]), config, now: f.state.now });
  await f.repo.saveNotification(task);
  return { f, task, follow };
}

const bought = f => f.call('notify.feedback', { eventId: EVENT, outcome: 'bought' });
const edit = (f, partNumber, storeNumbers = ['R577', 'R639']) => f.call('follow.upsert', { followId: FOLLOW_ID, partNumber, storeNumbers });

test('a planned alert pauses only its unchanged complete target and records feedback atomically', async () => {
  const { f, task, follow } = await fixture();
  assert.deepEqual(task.targetSnapshot, { partNumber: PART, storeNumbers: ['R577', 'R639'], updatedAt: follow.updatedAt });
  const before = await f.repo.getUser(userKeyOf());
  assert.deepEqual(ok(await bought(f)), { outcome: 'bought', paused: true });
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'paused');
  const user = await f.repo.getUser(userKeyOf());
  assert.equal(user.followIndex.find(item => item._id === FOLLOW).status, 'paused');
  assert.deepEqual(user.quota, before.quota);
  assert.deepEqual(user.subscriptions, before.subscriptions);
  assert.deepEqual((await f.repo.getNotification(task._id)).feedback, { outcome: 'bought', at: f.state.now.toISOString() });
  assert.deepEqual(ok(await bought(f)), { outcome: 'bought', paused: false });
});

test('an old alert never pauses a different product or an edited set containing the original store', async () => {
  for (const [partNumber, stores] of [['MXXX1CH/A', ['R577', 'R639']], [PART, ['R577', 'R320']]]) {
    const { f } = await fixture();
    ok(await edit(f, partNumber, stores));
    assert.equal(ok(await f.call('notify.detail', { eventId: EVENT })).follow, null);
    assert.deepEqual(ok(await bought(f)), { outcome: 'bought', paused: false });
    const follow = await f.repo.getFollow(FOLLOW);
    assert.equal(follow.status, 'active');
    assert.equal(follow.partNumber, partNumber);
    assert.deepEqual(follow.storeNumbers, stores);
  }
});

test('the complete store snapshot is checked even if a legacy writer retained its timestamp', async () => {
  const { f, follow } = await fixture();
  await f.repo.saveFollow({ ...follow, storeNumbers: ['R577', 'R320'] });
  assert.deepEqual(ok(await bought(f)), { outcome: 'bought', paused: false });
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'active');
});

test('same-clock edits away and back cannot make an old alert match again', async () => {
  const { f, follow } = await fixture();
  ok(await edit(f, 'MXXX1CH/A'));
  ok(await edit(f, PART));
  const current = await f.repo.getFollow(FOLLOW);
  assert.equal(Date.parse(current.updatedAt), Date.parse(follow.updatedAt) + 2);
  assert.deepEqual(ok(await bought(f)), { outcome: 'bought', paused: false });
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'active');
});

test('a resumed follow cannot be paused again by the same old bought card', async () => {
  const { f } = await fixture();
  assert.equal(ok(await bought(f)).paused, true);
  ok(await f.call('follow.resume', { followId: FOLLOW_ID }));
  assert.equal(ok(await bought(f)).paused, false);
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'active');
});

test('legacy alerts missing a complete versioned snapshot record feedback without pausing', async () => {
  for (const snapshot of [undefined, { partNumber: PART, storeNumbers: ['R577', 'R639'] }, { partNumber: PART, updatedAt: 'invalid', storeNumbers: ['R577', 'R639'] }]) {
    const { f, task } = await fixture();
    const legacy = { ...task, targetSnapshot: snapshot };
    if (snapshot === undefined) delete legacy.targetSnapshot;
    f.repo.tables.get(C.notifications).set(task._id, legacy);
    assert.equal(ok(await f.call('notify.detail', { eventId: EVENT })).follow, null);
    assert.equal(ok(await bought(f)).paused, false);
    assert.equal((await f.repo.getFollow(FOLLOW)).status, 'active');
    assert.equal((await f.repo.getNotification(task._id)).feedback.outcome, 'bought');
  }
});

test('an edit between the service read and feedback transaction is rechecked before pausing', async () => {
  const { f } = await fixture();
  const record = f.repo.recordNotificationFeedback;
  f.repo.recordNotificationFeedback = async args => {
    ok(await edit(f, 'MXXX1CH/A'));
    return record(args);
  };
  assert.equal(ok(await bought(f)).paused, false);
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'active');
});

test('failed feedback storage rolls back follow status and index together', async () => {
  const { f, task, follow } = await fixture();
  const before = await f.repo.getUser(userKeyOf());
  f.repo.transactionWriteHook = async table => { if (table === C.notifications) throw Error('storage unavailable'); };
  assert.equal((await bought(f)).ok, false);
  assert.deepEqual(await f.repo.getFollow(FOLLOW), follow);
  assert.deepEqual((await f.repo.getUser(userKeyOf())).followIndex, before.followIndex);
  assert.equal((await f.repo.getNotification(task._id)).feedback, undefined);
  f.repo.transactionWriteHook = null;
  assert.equal(ok(await bought(f)).paused, true);
});

test('feedback cannot affect a hidden alert or another account', async () => {
  const { f, task } = await fixture();
  const another = await f.call('notify.feedback', { eventId: EVENT, outcome: 'bought' }, userContext('oOTHER00000000000000000001'));
  assert.equal(another.error.code, 'notification_not_found');
  const record = f.repo.recordNotificationFeedback;
  f.repo.recordNotificationFeedback = async args => {
    await f.repo.updateNotification(task._id, { userHiddenAt: f.state.now.toISOString() });
    return record(args);
  };
  assert.equal((await bought(f)).error.code, 'notification_not_found');
  assert.equal((await f.repo.getFollow(FOLLOW)).status, 'active');
});
