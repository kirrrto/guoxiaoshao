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
