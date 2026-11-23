import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createFixture, operatorContext, userContext, userKeyOf, RESOURCE_APPID } from './helpers/fixture.mjs';
import { marketMembership } from './helpers/market-membership.mjs';

const require = createRequire(import.meta.url);
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const { GIFT_ID, GIFT_SOURCE, ANNUAL_MS, giftRecordId } = require('../cloudfunctions/gxs_api/lib/rules/owner-annual-gift');
const { classifyOrder } = require('../cloudfunctions/gxs_api/lib/services/growth');
const { resolvePlanMetadata } = require('../cloudfunctions/gxs_api/lib/rules/member-plan');
const DAY = 86400000;
const userKey = userKeyOf();
const otherOpenid = 'oOTHER00000000000000000001';
const start = '2026-11-23T03:00:00.000Z';
const iso = value => new Date(value).toISOString();
const ok = reply => { assert.equal(reply.ok, true, reply.error?.code); return reply.data; };
function gift(f, { target = userKey, payload = {}, context = operatorContext() } = {}) {
  const handler = createHandler({ repo: f.repo, clock: () => f.state.now, ownerAnnualGiftUserKey: target });
  return handler({ action: 'admin.grantOwnerAnnualPass', payload }, context);
}

test('the single-owner campaign requires a trusted operator, a bound consumer account and an empty payload', async () => {
  const f = createFixture({ config: { adminUserKeys: [userKey] }, start });
  for (const context of [userContext(), userContext(otherOpenid), { SOURCE: 'scf' }, { SOURCE: 'wx_client,scf' }]) {
    assert.equal((await gift(f, { context })).error.code, 'forbidden');
  }
  for (const target of ['', 'bad-target', userKeyOf(otherOpenid, RESOURCE_APPID)]) {
    assert.equal((await gift(f, { target })).error.code, 'gift_not_configured');
  }
  for (const payload of [{ userKey }, { days: 366 }, { grantId: 'repeat' }, { planId: 'member_365d' }]) {
    assert.equal((await gift(f, { payload })).error.code, 'invalid_payload');
  }
  assert.equal((await gift(f)).error.code, 'unknown_user');
  assert.equal(await f.repo.getOrder(giftRecordId(userKey)), null);
});

test('an untyped membership keeps all original time after exactly one year at 5×5, including across concurrent calls and retries', async () => {
  const f = createFixture({ start });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('user.bootstrap', {}, userContext(otherOpenid)));
  const oldExpiry = '2027-10-18T03:00:00.000Z';
  await f.repo.updateUser(userKey, { membership: { expiresAt: oldExpiry, source: 'admin_grant' } });
  const before = await f.repo.getUser(userKey);
  const results = (await Promise.all(Array.from({ length: 6 }, () => gift(f)))).map(ok);
  assert.equal(results.filter(row => row.status === 'granted').length, 1);
  assert.equal(results.filter(row => row.status === 'already_granted').length, 5);
  const membership = results[0].membership;
  assert.deepEqual([membership.planId, membership.limits.maxFollows, membership.limits.maxStoresPerFollow, results[0].canWatchMarkets],
    ['member_365d', 5, 5, true]);
  assert.equal(membership.annualExpiresAt, iso(Date.parse(start) + ANNUAL_MS));
  assert.equal(membership.expiresAt, iso(Date.parse(oldExpiry) + ANNUAL_MS));
  assert.equal((await gift(f, { target: userKeyOf(otherOpenid) })).error.code, 'owner_gift_conflict');
  assert.equal((await f.repo.listOrders(userKeyOf(otherOpenid))).length, 0);
  const after = await f.repo.getUser(userKey);
  assert.deepEqual(after.quota, before.quota);
  assert.deepEqual(after.subscriptions, before.subscriptions);
  const receipt = await f.repo.getOrder(giftRecordId(userKey));
  assert.deepEqual([receipt.type, receipt.source, receipt.amountFen, receipt.paidAt, classifyOrder(receipt).kind],
    [GIFT_SOURCE, 'admin_grant', 0, null, 'non_cash']);
  assert.deepEqual([receipt.provider, receipt.transactionId, receipt.paymentSnapshot], [undefined, undefined, undefined]);
  assert.deepEqual(ok(await f.call('member.status')).membership, membership);
  ok(await f.call('member.deleteRecord', { orderId: GIFT_ID }));
  assert.equal(ok(await gift(f)).status, 'already_granted');
  f.advance(ANNUAL_MS);
  const end = ok(await gift(f));
  assert.deepEqual([end.membership.active, end.membership.planId, end.membership.limits.maxFollows, end.canWatchMarkets],
    [true, null, 3, false]);
  assert.equal(end.membership.remainingMs, Date.parse(oldExpiry) - Date.parse(start));
});

test('an account with active annual rights keeps its existing expiry and a replay after expiry remains a no-op', async () => {
  const f = createFixture({ start });
  ok(await f.call('user.bootstrap'));
  const original = marketMembership(start, 'member_365d', 9 * DAY);
  await f.repo.updateUser(userKey, { membership: original });
  assert.equal(ok(await gift(f)).status, 'already_annual');
  f.advance(9 * DAY);
  const replay = ok(await gift(f));
  assert.equal(replay.status, 'already_annual');
  assert.equal(replay.membership.active, false);
  assert.deepEqual((await f.repo.getUser(userKey)).membership, original);
  assert.equal(await f.repo.getOrder(giftRecordId(userKey)), null);
});

test('metadata repair requires the gift receipt and preserves its value through a refund of an unrelated paid order', async () => {
  const f = createFixture({ start });
  ok(await f.call('user.bootstrap'));
  const paid = { _id: 'old-paid-month', orderId: 'old-paid-month', userKey, days: 30, amountFen: 1990, status: 'fulfilled',
    type: 'membership_order', entitlementFulfilled: true, fulfilledAt: start, paidAt: start, createdAt: start };
  await f.repo.createOrderIfAbsent(paid);
  const previous = marketMembership(start, 'member_30d', 30 * DAY);
  previous.entitlements.segments[0].orderId = paid._id;
  await f.repo.updateUser(userKey, { membership: previous });
  ok(await gift(f));
  const account = await f.repo.getUser(userKey);
  const receipt = await f.repo.getOrder(giftRecordId(userKey));
  assert.deepEqual(account.membership.entitlements.segments[1], previous.entitlements.segments[0]);
  delete account.membership.entitlements.planMetadataVersion;
  for (const record of [null, { ...receipt, paidAt: start }, { ...receipt, userKey: userKeyOf(otherOpenid) },
    { ...receipt, days: 366 }, { ...receipt, type: 'admin_grant' }, { ...receipt, amountFen: 10 }]) {
    const repaired = await resolvePlanMetadata(account, async () => record);
    assert.equal(repaired.membership.entitlements.segments[0].planId, undefined);
  }
  const verified = await resolvePlanMetadata(account, id => f.repo.getOrder(id));
  assert.equal(verified.membership.entitlements.segments[0].planId, 'member_365d');
  f.advance(7 * DAY);
  await f.repo.markOrderRefunded({ orderId: paid._id, nowIso: iso(f.state.now), refundFen: 1990 });
  const remaining = ok(await f.call('member.status')).membership;
  assert.equal(remaining.expiresAt, iso(Date.parse(start) + ANNUAL_MS));
  assert.equal(remaining.annualExpiresAt, remaining.expiresAt);
  assert.equal(remaining.remainingMs, ANNUAL_MS - 7 * DAY);
});

test('an interrupted grant rolls back the entitlement, the order and the campaign decision before retry', async () => {
  const f = createFixture({ start });
  ok(await f.call('user.bootstrap'));
  const original = await f.repo.getUser(userKey);
  f.repo.transactionWriteHook = (_, doc) => { if (doc._id === GIFT_ID) throw Error('storage unavailable'); };
  assert.equal((await gift(f)).error.code, 'owner_gift_unconfirmed');
  assert.deepEqual(await f.repo.getUser(userKey), original);
  assert.equal(await f.repo.getOrder(giftRecordId(userKey)), null);
  delete f.repo.transactionWriteHook;
  assert.equal(ok(await gift(f)).status, 'granted');
});
