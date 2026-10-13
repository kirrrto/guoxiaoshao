import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const { grantCredit, writeLedger } = require('../cloudfunctions/gxs_api/lib/repo/subscription-credit-ledger.js');
const TPL = 'restock-template-A';
const config = { notifications: { enabled: true, templateIds: { restock: TPL } } };
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };

/** The 2026-09-22 build issued 365 tickets for every member "allow". */
function pooled(accepts, now) {
  let sub = { credits: 0 };
  for (let i = 0; i < accepts * 365; i += 1) sub = writeLedger(sub, grantCredit(sub), now);
  return { ...sub, accepted: accepts, rejected: 0, lastResult: 'accept', updatedAt: now };
}

async function member(subscription) {
  const f = createFixture({ config });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { [TPL]: subscription(f.state.now.toISOString()) } });
  return f;
}
const sent = (f, id) => f.repo.tables.get(C.notifications).set(id, { _id: id, userKey: userKeyOf(), templateId: TPL, status: 'accepted' });

test('an inflated count from the old reminder pool is corrected once to allows minus delivered sends', async () => {
  const f = await member(now => pooled(2, now));
  sent(f, 'delivered-1');
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions[TPL].credits, 730);
  const repaired = ok(await f.call('user.bootstrap')).subscriptions[TPL];
  assert.equal(repaired.credits, 1);
  assert.ok(repaired.poolRepairedAt);
  assert.equal(repaired.needsReauthorization, false);
  assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 1, 'repaired only once');
  const added = ok(await f.call('notify.recordSubscription', { requestId: 'after-repair-01', results: { [TPL]: 'accept' } }));
  assert.equal(added.subscriptions[TPL].credits, 2, 'new allows keep accumulating one by one');
});

test('the repair never raises a count, and a used-up pool asks for a new authorization', async () => {
  const f = await member(now => pooled(1, now));
  sent(f, 'delivered-1');
  const repaired = ok(await f.call('user.bootstrap')).subscriptions[TPL];
  assert.equal(repaired.credits, 0); assert.equal(repaired.needsReauthorization, true);
  const honest = await member(now => { let sub = { credits: 0 }; for (let i = 0; i < 3; i += 1) sub = writeLedger(sub, grantCredit(sub), now); return { ...sub, accepted: 3 }; });
  const untouched = ok(await honest.call('user.bootstrap')).subscriptions[TPL];
  assert.equal(untouched.credits, 3); assert.equal(untouched.poolRepairedAt, undefined);
});

async function reserve(f, id, status = 'sending') {
  await f.repo.saveNotification({ _id: id, userKey: userKeyOf(), templateId: TPL, status });
  assert.equal((await f.repo.reserveSubscriptionCredit({ userKey: userKeyOf(), templateId: TPL, taskId: id, now: f.state.now.toISOString() })).reserved, true);
}

test('repair never copies permissions already reserved by sends in flight', async () => {
  const f = await member(now => pooled(2, now));
  await reserve(f, 'in-flight-one'); await reserve(f, 'in-flight-two');
  const repaired = ok(await f.call('user.bootstrap')).subscriptions[TPL];
  assert.equal(repaired.credits, 0, 'the two real allows already belong to the in-flight sends');
  await f.repo.updateNotification('in-flight-one', { status: 'accepted' });
  await f.repo.updateNotification('in-flight-two', { status: 'accepted' });
  assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 0);
  assert.equal((await f.repo.releaseSubscriptionCredit({ userKey: userKeyOf(), templateId: TPL, taskId: 'in-flight-one', now: f.state.now.toISOString() })).released, false,
    'a late old-pool failure cannot create another ticket');
});

test('repair counts uncertain delivery once and excludes a terminal failure whose ticket was restored', async () => {
  const f = await member(now => pooled(2, now));
  await reserve(f, 'possibly-delivered', 'uncertain');
  await reserve(f, 'refundable-failure', 'failed');
  assert.equal((await f.repo.releaseSubscriptionCredit({ userKey: userKeyOf(), templateId: TPL, taskId: 'refundable-failure', now: f.state.now.toISOString() })).released, true);
  assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 1);
});

test('a new reservation between usage inspection and repair is re-read before applying the correction', async () => {
  const f = await member(now => pooled(2, now));
  const repair = f.repo.repairInflatedCredits; let calls = 0;
  f.repo.repairInflatedCredits = async args => {
    if (calls++ === 0) await reserve(f, 'racing-reservation');
    return repair(args);
  };
  assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 1);
  assert.equal(calls, 2, 'a changed ledger is not repaired using a stale usage count');
});

test('a sending-to-accepted transition during inspection cannot release or duplicate its occupied permission', async () => {
  const f = await member(now => pooled(2, now)); await reserve(f, 'finishing-send');
  const repair = f.repo.repairInflatedCredits;
  f.repo.repairInflatedCredits = async args => {
    await f.repo.updateNotification('finishing-send', { status: 'accepted' });
    return repair(args);
  };
  assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 1);
});

test('repair rolls back the ledger and marker on storage failure and safely retries with occupied permissions', async () => {
  const f = await member(now => pooled(2, now)); await reserve(f, 'occupied-before-retry');
  const before = await f.repo.getUser(userKeyOf());
  f.repo.transactionWriteHook = async (collection, doc) => { if (collection === C.users && doc.subscriptions[TPL].poolRepairedAt) throw new Error('repair commit failed'); };
  assert.equal((await f.call('user.bootstrap')).ok, false);
  assert.deepEqual(await f.repo.getUser(userKeyOf()), before);
  f.repo.transactionWriteHook = null;
  assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 1);
});

test('concurrent new consent and refunded reservations preserve their exact usable permission count', async () => {
  for (const change of ['grant', 'refund']) {
    const f = await member(now => pooled(2, now)); await reserve(f, 'existing-occupied');
    const repair = f.repo.repairInflatedCredits; let calls = 0;
    f.repo.repairInflatedCredits = async args => {
      if (calls++ === 0) {
        if (change === 'grant') ok(await f.call('notify.recordSubscription', { requestId: 'concurrent-real-allow', results: { [TPL]: 'accept' } }));
        else await f.repo.releaseSubscriptionCredit({ userKey: userKeyOf(), templateId: TPL, taskId: 'existing-occupied', now: f.state.now.toISOString() });
      }
      return repair(args);
    };
    assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 2, change);
    assert.equal(calls, 2, change);
  }
});

test('missing notification records never make issued but unavailable tickets reusable during repair', async () => {
  const f = await member(now => pooled(2, now));
  await reserve(f, 'unretained-delivery');
  f.repo.tables.get(C.notifications).delete('unretained-delivery');
  assert.equal(ok(await f.call('user.bootstrap')).subscriptions[TPL].credits, 1);
});

test('old repair callers without a matching inspected snapshot cannot rewrite a live ledger', async () => {
  const f = await member(now => pooled(2, now)); await reserve(f, 'old-caller-in-flight');
  const before = await f.repo.getUser(userKeyOf());
  const result = await f.repo.repairInflatedCredits({ userKey: userKeyOf(), templateId: TPL, sends: 0, now: f.state.now.toISOString() });
  assert.equal(result.repaired, false); assert.equal(result.retry, true);
  assert.deepEqual(await f.repo.getUser(userKeyOf()), before);
});

test('CloudBase repair usage uses one account-and-template-scoped union count with no duplicate delivery or row download', async () => {
  const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
  const rows = [
    { _id: 'legacy-accepted', userKey: userKeyOf(), templateId: TPL, status: 'accepted' },
    { _id: 'accepted-reserved', userKey: userKeyOf(), templateId: TPL, status: 'accepted', subscriptionTemplateId: TPL, subscriptionReserved: true },
    { _id: 'sending', userKey: userKeyOf(), templateId: TPL, status: 'sending', subscriptionTemplateId: TPL, subscriptionReserved: true },
    { _id: 'uncertain', userKey: userKeyOf(), templateId: TPL, status: 'uncertain', subscriptionTemplateId: TPL, subscriptionReserved: true },
    { _id: 'legacy-uncertain', userKey: userKeyOf(), templateId: TPL, status: 'uncertain' },
    { _id: 'refunded', userKey: userKeyOf(), templateId: TPL, status: 'failed', subscriptionTemplateId: TPL, subscriptionReserved: true, subscriptionCreditRestored: true },
    { _id: 'not-yet-reserved', userKey: userKeyOf(), templateId: TPL, status: 'sending' },
    { _id: 'other-user', userKey: 'another-account', templateId: TPL, status: 'accepted' },
    { _id: 'other-template', userKey: userKeyOf(), templateId: 'OTHER', status: 'accepted', subscriptionTemplateId: 'OTHER', subscriptionReserved: true },
  ];
  const evaluate = (query, row) => query.and ? query.and.every(part => evaluate(part, row))
    : query.or ? query.or.some(part => evaluate(part, row))
      : Object.entries(query).every(([key, value]) => value && Object.hasOwn(value, 'neq') ? row[key] !== value.neq : row[key] === value);
  let counts = 0;
  const repo = createCloudbaseRepo({
    command: { and: and => ({ and }), or: or => ({ or }), neq: neq => ({ neq }) },
    collection: name => ({ where: query => ({ count: async () => { assert.equal(name, C.notifications); counts++; return { total: rows.filter(row => evaluate(query, row)).length }; } }) }),
  });
  assert.equal(await repo.countSubscriptionRepairUsage({ userKey: userKeyOf(), templateId: TPL }), 5);
  assert.equal(counts, 1);
  const f = createFixture();
  for (const row of rows) f.repo.tables.get(C.notifications).set(row._id, row);
  assert.equal(await f.repo.countSubscriptionRepairUsage({ userKey: userKeyOf(), templateId: TPL }), 5);
});
