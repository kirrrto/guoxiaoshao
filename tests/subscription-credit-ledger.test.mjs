import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');

async function setup(initial = { credits: 3, accepted: 3 }) {
  const f = createFixture(); await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { subscriptions: { TPL: initial, OTHER: { credits: 7 } } });
  const userBefore = await f.repo.getUser(userKeyOf());
  const now = f.state.now.toISOString();
  const args = id => ({ userKey: userKeyOf(), templateId: 'TPL', taskId: id, now });
  const grant = id => f.repo.recordSubscriptionGrant({ userKey: userKeyOf(), requestId: id, templateIds: ['TPL'], results: { TPL: 'accept' }, now });
  const add = async id => f.repo.saveNotification({ _id: id, userKey: userKeyOf(), status: 'pending' });
  const reserve = (id, targetKey) => f.repo.reserveSubscriptionCredit({ ...args(id), cooldownMinutes: targetKey ? 30 : 0, targetKey });
  const release = id => f.repo.releaseSubscriptionCredit(args(id));
  const invalidate = id => f.repo.invalidateSubscriptionCredit(args(id));
  const sub = async () => (await f.repo.getUser(userKeyOf())).subscriptions.TPL;
  const getTask = id => structuredClone(f.repo.tables.get(C.notifications).get(id));
  return { f, userBefore, now, args, grant, add, reserve, release, invalidate, sub, getTask };
}

test('a grant between two old-credit reservations cannot make an expired refund look new', async () => {
  const s = await setup(); await s.add('a'); await s.add('b');
  await s.reserve('a'); await s.grant('new-grant'); await s.reserve('b');
  await s.invalidate('a');
  assert.equal((await s.sub()).credits, 1);
  assert.equal((await s.release('b')).released, false);
  assert.equal((await s.sub()).credits, 1);
  assert.deepEqual((await s.sub()).creditLedger.available, [[1, 1]]);
});

test('an in-flight fresh credit cannot be copied by another old failure after invalidation', async () => {
  const s = await setup();
  for (const id of ['old-a', 'old-b', 'fresh']) await s.add(id);
  await s.reserve('old-a'); await s.grant('new-grant'); await s.reserve('old-b');
  await s.invalidate('old-a'); await s.reserve('fresh');
  assert.equal((await s.sub()).credits, 0);
  assert.equal((await s.release('old-b')).released, false);
  assert.equal((await s.sub()).credits, 0);
  assert.equal((await s.release('fresh')).released, true);
  assert.equal((await s.sub()).credits, 1);
  assert.equal((await s.sub()).needsReauthorization, false);
});

test('only the actually reserved ticket can be refunded across delayed refusals', async () => {
  const s = await setup({ credits: 0 });
  for (let i = 1; i <= 3; i++) await s.grant(`g-${i}`);
  for (const id of ['a', 'b', 'c']) await s.add(id);
  await s.reserve('a'); await s.grant('g-4'); await s.reserve('b');
  assert.equal(s.getTask('b').subscriptionCreditSequence, 2);
  assert.equal(s.getTask('b').subscriptionCreditHighWater, 4);
  await s.invalidate('a');
  assert.deepEqual((await s.sub()).creditLedger.available, [[4, 4]]);
  assert.equal((await s.release('b')).released, false);
  await s.reserve('c');
  assert.equal(s.getTask('c').subscriptionCreditSequence, 4);
  assert.equal((await s.release('c')).released, true);
  assert.deepEqual((await s.sub()).creditLedger.available, [[4, 4]]);
  assert.equal((await s.release('c')).released, false);
  assert.equal((await s.invalidate('c')).invalidated, false);
});

test('non-refundable failures still clear their own cooldown so fresh consent can serve the same target', async () => {
  const s = await setup();
  for (const id of ['a', 'b', 'b-next']) await s.add(id);
  await s.reserve('a', 'store-A|sku'); await s.reserve('b', 'store-B|sku');
  await s.invalidate('a'); await s.release('b'); await s.grant('new-grant');
  assert.equal((await s.reserve('b-next', 'store-B|sku')).reserved, true);
  assert.equal((await s.reserve('a')).reserved, false);
  assert.equal((await s.reserve('a')).reason, 'subscription_authorization_expired');
  assert.equal((await s.reserve('b')).reserved, false);
});

test('a delayed old refusal never erases newer consent after a newer refusal already advanced the boundary', async () => {
  const s = await setup({ credits: 0 });
  await s.grant('g1'); await s.add('old'); await s.reserve('old');
  await s.grant('g2'); await s.add('new'); await s.reserve('new');
  await s.grant('g3'); await s.invalidate('new');
  await s.grant('g4'); await s.invalidate('old');
  assert.equal((await s.sub()).credits, 2);
  assert.equal((await s.sub()).creditLedger.invalidatedThrough, 2);
  assert.deepEqual((await s.sub()).creditLedger.available, [[3, 4]]);
  assert.equal((await s.invalidate('old')).invalidated, false);
});

test('legacy credits without accepted are preserved and new tickets never depend on that counter', async () => {
  const s = await setup({ credits: 2 }); await s.add('old'); await s.reserve('old');
  assert.equal((await s.sub()).credits, 1);
  assert.equal((await s.sub()).creditLedger.legacyCredits, 1);
  await s.grant('first-counted-grant');
  assert.equal((await s.sub()).accepted, 1);
  assert.equal((await s.sub()).credits, 2);
  await s.invalidate('old');
  assert.equal((await s.sub()).credits, 1);
  assert.deepEqual((await s.sub()).creditLedger.available, [[1, 1]]);
});

test('a pre-upgrade unknown reservation refunds once before legacy invalidation but never after it', async () => {
  const s = await setup({ credits: 1 });
  for (const id of ['legacy-refund', 'legacy-refusal', 'late-legacy-refund']) {
    await s.f.repo.saveNotification({ _id: id, userKey: userKeyOf(), status: 'sending', subscriptionReserved: true, subscriptionTemplateId: 'TPL' });
  }
  await s.grant('new-grant');
  assert.equal((await s.release('legacy-refund')).released, true);
  assert.equal((await s.release('legacy-refund')).released, false);
  assert.equal((await s.sub()).credits, 3);
  await s.invalidate('legacy-refusal');
  assert.equal((await s.sub()).credits, 1);
  assert.equal((await s.release('late-legacy-refund')).released, false);
  assert.equal((await s.sub()).credits, 1);
  assert.equal((await s.reserve('legacy-refusal')).reserved, false);
});

test('concurrent grants are idempotent and compressed ranges merge refunded holes without duplicates', async () => {
  const s = await setup({ credits: 0 });
  await Promise.all(Array.from({ length: 30 }, (_, i) => s.grant(`g-${i % 10}`)));
  assert.equal((await s.sub()).credits, 10);
  assert.equal((await s.sub()).creditLedger.sequence, 10);
  assert.deepEqual((await s.sub()).creditLedger.available, [[1, 10]]);
  for (const id of ['a', 'b', 'c']) { await s.add(id); await s.reserve(id); }
  await s.release('a'); await s.release('c');
  assert.deepEqual((await s.sub()).creditLedger.available, [[1, 1], [3, 10]]);
  await s.release('b');
  assert.deepEqual((await s.sub()).creditLedger.available, [[1, 10]]);
  assert.equal((await s.sub()).credits, 10);
});

test('a late failure cannot clear a newer task cooldown on the same target', async () => {
  const s = await setup({ credits: 0 }); await s.grant('g1'); await s.grant('g2');
  for (const id of ['old', 'new', 'third']) await s.add(id);
  await s.f.repo.reserveSubscriptionCredit({ ...s.args('old'), targetKey: 'same-target', cooldownMinutes: 0 });
  await s.f.repo.reserveSubscriptionCredit({ ...s.args('new'), targetKey: 'same-target', cooldownMinutes: 0 });
  await s.release('old');
  assert.equal((await s.reserve('third', 'same-target')).reason, 'cooldown');
});

test('credit invalidation and failed-send settlement roll back user, task and cooldown together', async () => {
  for (const action of ['invalidate', 'release']) {
    const s = await setup(); await s.add('a'); await s.reserve('a', 'store-A|sku');
    const before = await s.f.repo.getUser(userKeyOf());
    const taskBefore = s.getTask('a');
    s.f.repo.transactionWriteHook = async (table, doc) => { if (table === C.config && doc._id === taskBefore.cooldownId) throw Error('cooldown-write-failed'); };
    await assert.rejects(s[action]('a'), /cooldown-write-failed/);
    assert.deepEqual(await s.f.repo.getUser(userKeyOf()), before);
    assert.deepEqual(s.getTask('a'), taskBefore);
    s.f.repo.transactionWriteHook = null;
    await s[action]('a');
    assert.equal(s.getTask('a')[action === 'release' ? 'subscriptionReleased' : 'subscriptionInvalidated'], true);
  }
});

test('credit lifecycle preserves identity, membership, quota, settings and other template credits', async () => {
  const s = await setup(); await s.add('a'); await s.reserve('a'); await s.grant('new'); await s.invalidate('a');
  const after = await s.f.repo.getUser(userKeyOf());
  for (const key of Object.keys(s.userBefore).filter(key => key !== 'subscriptions')) assert.deepEqual(after[key], s.userBefore[key], key);
  assert.deepEqual(after.subscriptions.OTHER, s.userBefore.subscriptions.OTHER);
});
