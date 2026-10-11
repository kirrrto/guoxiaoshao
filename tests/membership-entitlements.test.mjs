import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const entitlements = require('../cloudfunctions/gxs_api/lib/rules/membership-entitlements.js');
const DAY = 86400000;
const now = f => f.state.now.toISOString();
const at = (f, days) => new Date(f.state.now.getTime() + days * DAY).toISOString();
const member = async f => (await f.repo.getUser(userKeyOf())).membership;
const segments = async f => (await member(f)).entitlements.segments;
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const fixture = async () => { const f = createFixture(); ok(await f.call('user.bootstrap')); return f; };
async function order(f, id, patch = {}) {
  await f.repo.createOrderIfAbsent({ _id: id, orderId: `public-${id}`, productId: 'member-week', userKey: userKeyOf(), days: 7, amountFen: 700, status: 'created', createdAt: now(f), ...patch });
}
const paid = (f, id, extra = {}) => f.repo.markOrderPaid({ orderId: id, transactionId: `tx-${id}`, nowIso: now(f), providerData: { amountFen: 700 }, ...extra });
const fulfil = (f, id) => f.repo.fulfilMembershipOrder({ orderId: id, nowIso: now(f), source: 'virtual_payment' });
const refund = (f, id, refundFen) => f.repo.markOrderRefunded({ orderId: id, nowIso: now(f), ...(refundFen === undefined ? {} : { refundFen }), providerData: { trusted: true } });
async function purchase(f, id) { await order(f, id); await paid(f, id); await fulfil(f, id); }

test('refund removes only the unconsumed days of the refunded order, preserving a later purchase', async () => {
  const f = await fixture(); await purchase(f, 'A');
  f.advance(2 * DAY); await purchase(f, 'B');
  const before = await f.repo.getUser(userKeyOf());
  const result = await refund(f, 'A');
  assert.equal(result.revokedMs, 5 * DAY);
  assert.equal(result.expiresAt, at(f, 7));
  assert.deepEqual(await segments(f), [{ orderId: 'B', source: 'virtual_payment', remainingMs: 7 * DAY }]);
  const after = await f.repo.getUser(userKeyOf());
  const { membership: ignoredBefore, ...otherBefore } = before;
  const { membership: ignoredAfter, ...otherAfter } = after;
  assert.deepEqual(otherAfter, otherBefore, 'quota, identity, settings and subscription credits are untouched');
  assert.equal((await fulfil(f, 'A')).applied, false, 'refunded fulfilled orders cannot receive a second grant');
});

test('an already consumed order cannot revoke the later order currently being used', async () => {
  const f = await fixture(); await purchase(f, 'A'); await purchase(f, 'B');
  f.advance(8 * DAY);
  const result = await refund(f, 'A');
  assert.equal(result.revokedMs, 0); assert.equal(result.expiresAt, at(f, 6));
  assert.deepEqual(await segments(f), [{ orderId: 'B', source: 'virtual_payment', remainingMs: 6 * DAY }]);
});

test('redemption shares the entitlement ledger and survives a refund of the preceding paid order', async () => {
  const f = await fixture(); await purchase(f, 'A'); f.advance(2 * DAY);
  const redemption = ok(await f.call('member.redeemCode', { code: 'hbw666' }));
  assert.equal(redemption.alreadyRedeemed, false);
  const rows = await segments(f);
  assert.equal(rows.length, 2); assert.equal(rows[1].source, 'redemption_code'); assert.equal(rows[1].remainingMs, 30 * DAY);
  const result = await refund(f, 'A');
  assert.equal(result.revokedMs, 5 * DAY); assert.equal(result.expiresAt, at(f, 30));
  assert.deepEqual(await segments(f), [rows[1]]);
  assert.equal(ok(await f.call('member.redeemCode', { code: 'hbw666' })).alreadyRedeemed, true);
  assert.deepEqual(await segments(f), [rows[1]]);
});

test('legacy membership stays unattributed and an old order refund cannot deduct its baseline or regrant it', async () => {
  const f = await fixture(), legacyExpiry = at(f, 20);
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: legacyExpiry, source: 'legacy' } });
  await order(f, 'old', { status: 'fulfilled', paidAt: now(f) });
  await purchase(f, 'new');
  assert.deepEqual((await segments(f)).map(row => [row.orderId, row.remainingMs]), [[null, 20 * DAY], ['new', 7 * DAY]]);
  const original = await member(f);
  const result = await refund(f, 'old', 350);
  assert.equal(result.revokedMs, 0); assert.equal(result.order.entitlementFulfilled, true);
  assert.equal(result.order.fulfilledAt, undefined, 'migration does not invent an old fulfilment timestamp');
  assert.equal((await fulfil(f, 'old')).applied, false, 'partial refund cannot erase the old fulfilled marker');
  assert.deepEqual(await member(f), original);
  await refund(f, 'old', 700); await refund(f, 'new');
  assert.equal((await member(f)).expiresAt, legacyExpiry);
  assert.deepEqual((await segments(f)).map(row => [row.orderId, row.remainingMs]), [[null, 20 * DAY]]);
});

test('partial refunds use cumulative money amounts, ignoring duplicate and out-of-order smaller amounts', async () => {
  const f = await fixture(); await purchase(f, 'A'); await purchase(f, 'B');
  assert.equal((await refund(f, 'A', 350)).revokedMs, 3.5 * DAY);
  const afterHalf = await member(f);
  for (const amount of [350, 0, 100]) assert.equal((await refund(f, 'A', amount)).applied, false);
  assert.deepEqual(await member(f), afterHalf);
  assert.equal((await refund(f, 'A', 525)).revokedMs, 1.75 * DAY);
  assert.equal((await refund(f, 'A', 700)).revokedMs, 1.75 * DAY);
  assert.equal((await refund(f, 'A', 525)).applied, false);
  const result = await f.repo.getOrder('A');
  assert.equal(result.refundFen, 700); assert.equal(result.entitlementRefundTargetMs, 7 * DAY); assert.equal(result.entitlementRevokedMs, 7 * DAY);
  assert.equal(result.status, 'refunded'); assert.equal((await member(f)).expiresAt, at(f, 7));
  assert.deepEqual((await segments(f)).map(row => row.orderId), ['B']);
});

test('later partial-refund increments are capped by that order remaining time after consumption', async () => {
  const f = await fixture(); await purchase(f, 'A'); await purchase(f, 'B');
  f.advance(2 * DAY);
  assert.equal((await refund(f, 'A', 350)).revokedMs, 3.5 * DAY);
  f.advance(DAY);
  assert.equal((await refund(f, 'A', 700)).revokedMs, 0.5 * DAY);
  assert.equal((await member(f)).expiresAt, at(f, 7));
  assert.deepEqual((await segments(f)).map(row => [row.orderId, row.remainingMs]), [['B', 7 * DAY]]);
  assert.equal((await f.repo.getOrder('A')).entitlementRevokedMs, 4 * DAY);
});

test('partial refund before fulfilment requires payment confirmation and grants the paid net duration once', async () => {
  const f = await fixture(); await order(f, 'A');
  await refund(f, 'A', 350);
  await assert.rejects(fulfil(f, 'A'), error => error.code === 'order_not_paid');
  assert.equal((await member(f)).expiresAt, null);
  const confirmed = await paid(f, 'A');
  assert.equal(confirmed.order.status, 'partially_refunded'); assert.equal(confirmed.order.refundFen, 350);
  const result = await fulfil(f, 'A');
  assert.equal(result.applied, true); assert.equal(result.order.status, 'partially_refunded');
  assert.equal(result.order.entitlementGrantedMs, 3.5 * DAY); assert.equal(result.expiresAt, at(f, 3.5));
  assert.equal(result.order.fulfilledAt, now(f));
  assert.equal((await fulfil(f, 'A')).applied, false);
  assert.equal((await paid(f, 'A')).order.status, 'partially_refunded');
  await assert.rejects(paid(f, 'A', { transactionId: 'different-transaction' }), error => error.code === 'payment_conflict');
  assert.equal((await refund(f, 'A', 700)).revokedMs, 3.5 * DAY);
  assert.equal((await member(f)).expiresAt, now(f));
});

test('paid-before-fulfil partial refund grants only the net days and a full refund prohibits fulfilment', async () => {
  const f = await fixture(); await order(f, 'partial'); await paid(f, 'partial'); await refund(f, 'partial', 350);
  assert.equal((await fulfil(f, 'partial')).expiresAt, at(f, 3.5));
  await order(f, 'full'); await paid(f, 'full'); await refund(f, 'full', 700);
  const before = await member(f);
  await assert.rejects(fulfil(f, 'full'), error => error.code === 'order_refunded');
  await assert.rejects(paid(f, 'full'), error => error.code === 'invalid_order_status');
  assert.deepEqual(await member(f), before);
});

test('a confirmed full refund that precedes payment confirmation cannot be revived by a delayed paid event', async () => {
  const f = await fixture(); await order(f, 'A'); await refund(f, 'A', 700);
  await assert.rejects(paid(f, 'A'), error => error.code === 'invalid_order_status');
  await assert.rejects(fulfil(f, 'A'), error => error.code === 'order_refunded');
  assert.equal((await member(f)).expiresAt, null); assert.deepEqual(await segments(f), []);
  assert.equal((await f.repo.getOrder('A')).status, 'refunded');
});

test('fulfilment racing a partial refund produces the same net entitlement in either transaction ordering', async () => {
  for (const refundFirst of [false, true]) {
    const f = await fixture(); await order(f, 'A'); await paid(f, 'A');
    await Promise.all(refundFirst ? [refund(f, 'A', 350), fulfil(f, 'A')] : [fulfil(f, 'A'), refund(f, 'A', 350)]);
    assert.equal((await member(f)).expiresAt, at(f, 3.5));
    assert.deepEqual((await segments(f)).map(row => [row.orderId, row.remainingMs]), [['A', 3.5 * DAY]]);
    assert.equal((await f.repo.getOrder('A')).status, 'partially_refunded');
    assert.equal((await fulfil(f, 'A')).applied, false);
  }
});

test('fulfilment racing a full refund never leaves membership active or harms an unrelated purchase', async () => {
  for (const refundFirst of [false, true]) {
    const f = await fixture(); await purchase(f, 'B'); await order(f, 'A'); await paid(f, 'A');
    const results = await Promise.allSettled(refundFirst ? [refund(f, 'A', 700), fulfil(f, 'A')] : [fulfil(f, 'A'), refund(f, 'A', 700)]);
    const rejected = results.filter(row => row.status === 'rejected');
    assert.equal(rejected.length, refundFirst ? 1 : 0);
    if (rejected.length) assert.equal(rejected[0].reason.code, 'order_refunded');
    assert.equal((await member(f)).expiresAt, at(f, 7));
    assert.deepEqual((await segments(f)).map(row => row.orderId), ['B']);
    assert.equal((await f.repo.getOrder('A')).status, 'refunded');
  }
});

test('concurrent cumulative refunds converge to the highest confirmed amount without duplicate revocation', async () => {
  for (const amounts of [[175, 525, 350, 700, 700], [700, 525, 175, 700]]) {
    const f = await fixture(); await purchase(f, 'A'); await purchase(f, 'B');
    const results = await Promise.all(amounts.map(amount => refund(f, 'A', amount)));
    assert.equal(results.reduce((sum, result) => sum + result.revokedMs, 0), 7 * DAY);
    assert.equal((await f.repo.getOrder('A')).refundFen, 700);
    assert.equal((await member(f)).expiresAt, at(f, 7));
  }
});

test('clock rollback never resurrects consumed time or anchors a new grant before the last settlement', async () => {
  const f = await fixture(); await purchase(f, 'A'); f.advance(2 * DAY); await purchase(f, 'B');
  const anchor = now(f), before = await member(f);
  f.advance(-DAY); await purchase(f, 'C');
  let current = await member(f);
  assert.equal(current.entitlements.settledAt, anchor);
  assert.equal(current.expiresAt, new Date(Date.parse(before.expiresAt) + 7 * DAY).toISOString());
  assert.equal((await refund(f, 'A')).revokedMs, 5 * DAY);
  current = await member(f);
  assert.equal(current.entitlements.settledAt, anchor);
  assert.equal(current.expiresAt, new Date(Date.parse(anchor) + 14 * DAY).toISOString());
  assert.deepEqual(current.entitlements.segments.map(row => row.orderId), ['B', 'C']);
});

test('a refund write failure rolls back both the member ledger and order amounts, then retries exactly once', async () => {
  for (const failedTable of [C.users, C.orders]) {
    const f = await fixture(); await purchase(f, 'A');
    const beforeMember = await member(f), beforeOrder = await f.repo.getOrder('A');
    f.repo.transactionWriteHook = async table => { if (table === failedTable) throw new Error('refund persistence unavailable'); };
    await assert.rejects(refund(f, 'A', 350), /refund persistence unavailable/);
    assert.deepEqual(await member(f), beforeMember); assert.deepEqual(await f.repo.getOrder('A'), beforeOrder);
    f.repo.transactionWriteHook = null;
    assert.equal((await refund(f, 'A', 350)).revokedMs, 3.5 * DAY);
    assert.equal((await refund(f, 'A', 350)).applied, false);
  }
});

test('fractional money ratios use exact cumulative milliseconds and invalid amounts leave state unchanged', async () => {
  const priced = { days: 7, amountFen: 699 };
  let deltaSum = 0, previous = 0;
  for (let fen = 1; fen <= 699; fen++) {
    const target = entitlements.refundDurationMs(priced, fen);
    assert.equal(target, Number(604800000n * BigInt(fen) / 699n));
    deltaSum += target - previous; previous = target;
  }
  assert.equal(deltaSum, 7 * DAY);
  const f = await fixture(); await purchase(f, 'A'); const before = await member(f), beforeOrder = await f.repo.getOrder('A');
  for (const amount of [-1, 700.1, 701, NaN, Infinity, '350', null]) {
    await assert.rejects(refund(f, 'A', amount), error => error.code === 'invalid_refund_amount');
    assert.deepEqual(await member(f), before); assert.deepEqual(await f.repo.getOrder('A'), beforeOrder);
  }
});

test('empty and expired legacy accounts start grants at the current accounting time and exhausted segments are removed', () => {
  const start = '2026-09-20T00:00:00.000Z', end = '2026-09-27T00:00:00.000Z';
  for (const membership of [{}, { expiresAt: '2026-01-01T00:00:00.000Z' }]) {
    const granted = entitlements.grant(membership, { orderId: 'A', source: 'test', milliseconds: 7 * DAY, nowIso: start });
    assert.equal(granted.expiresAt, end);
    const settled = entitlements.settle(granted, '2026-10-01T00:00:00.000Z');
    assert.equal(settled.expiresAt, end); assert.deepEqual(settled.entitlements.segments, []);
  }
});
