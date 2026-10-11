import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, userContext, operatorContext, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { orderKey, PROVIDER } = require('../cloudfunctions/gxs_api/lib/payment/service');
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const at = '2026-09-15T02:00:00.000Z';
async function fixture() { const f = createFixture(); ok(await f.call('user.bootstrap')); return f; }
async function put(f, orderId, patch = {}) {
  const userKey = patch.userKey || userKeyOf(), key = orderKey(userKey, orderId);
  const order = { _id: key, outTradeNo: key, orderId, userKey, appid: CONSUMER_APPID, openid: userContext().FROM_OPENID,
    provider: PROVIDER, type: 'membership_order', productId: 'vip666', status: 'fulfilled', amountFen: 700, days: 7,
    createdAt: at, paidAt: at, fulfilledAt: at, transactionId: `paid-${orderId}`, ...patch };
  await f.repo.saveOrder(order); return order;
}
const visible = async f => ok(await f.call('member.status')).orders;

test('deleting a fulfilled own order only hides its display and retries preserve its first hidden timestamp', async () => {
  const f = await fixture(), order = await put(f, 'receipt-visible-01');
  const account = await f.repo.getUser(userKeyOf());
  const result = ok(await f.call('member.deleteRecord', { orderId: order.orderId, userKey: 'someone-else' }));
  assert.deepEqual(result, { hiddenOrderIds: [order.orderId], hiddenCount: 1, newlyHiddenCount: 1, retained: [], retainedCount: 0 });
  const stored = await f.repo.getOrder(order._id), { userHiddenAt, ...unchanged } = stored;
  assert.deepEqual(unchanged, order); assert.equal(userHiddenAt, at);
  assert.deepEqual((await f.repo.getUser(userKeyOf())).membership, account.membership);
  assert.equal((await visible(f)).length, 0);
  assert.equal((await f.repo.listOrders(userKeyOf(), 10)).length, 1, 'backend order listing remains unchanged');
  f.advance(1000);
  const replay = ok(await f.call('member.deleteRecord', { orderId: order.orderId }));
  assert.equal(replay.hiddenCount, 1); assert.equal(replay.newlyHiddenCount, 0);
  assert.equal((await f.repo.getOrder(order._id)).userHiddenAt, at);
});

test('simultaneous hide requests commit one visibility change and both safely resolve the same snapshot', async () => {
  const f = await fixture(), order = await put(f, 'concurrent-hide-record');
  const results = await Promise.all([
    f.call('member.deleteRecord', { orderId: order.orderId }).then(ok),
    f.call('member.clearRecords', { orderIds: [order.orderId] }).then(ok),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.newlyHiddenCount, 0), 1);
  assert.ok(results.every(result => result.hiddenCount === 1 && result.retainedCount === 0));
  assert.equal((await f.repo.getOrder(order._id)).status, 'fulfilled');
});

test('admin-grant legacy keys can be hidden without revoking membership or affecting financial statistics', async () => {
  const f = await fixture();
  const grant = ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 7, grantId: 'record-cleanup-01' }, operatorContext()));
  assert.equal((await visible(f))[0].canClearRecord, true);
  const before = await f.repo.getUser(userKeyOf());
  ok(await f.call('member.deleteRecord', { orderId: grant.orderId }));
  assert.deepEqual((await f.repo.getUser(userKeyOf())).membership, before.membership);
  assert.equal(ok(await f.call('admin.stats', {}, operatorContext())).fulfilledOrders, 1);
  assert.equal((await visible(f)).length, 0);
  assert.equal((await f.repo.getOrder(`${userKeyOf()}|${grant.orderId}`)).status, 'fulfilled');
});

test('all supported grant ID lengths and real redemption IDs can be cleared without enabling repeat grants', async () => {
  const f = await fixture(), orderIds = [];
  for (const grantId of ['abcd', 'x'.repeat(64)]) {
    orderIds.push(ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 7, grantId }, operatorContext())).orderId);
  }
  const redeemed = ok(await f.call('member.redeemCode', { code: 'hbw666' }));
  const records = await visible(f), redemption = records.find(order => order.type === 'membership_redemption');
  assert.equal(orderIds[1].length, 70); assert.ok(redemption); orderIds.push(redemption.orderId);
  assert.ok(records.every(order => order.canClearRecord));
  const result = ok(await f.call('member.clearRecords', { orderIds }));
  assert.equal(result.hiddenCount, 3); assert.equal((await visible(f)).length, 0);
  assert.equal(ok(await f.call('member.redeemCode', { code: 'hbw666' })).alreadyRedeemed, true);
  assert.equal(ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 7, grantId: 'x'.repeat(64) }, operatorContext())).applied, false);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, redeemed.membership.expiresAt);
  assert.equal((await f.call('member.deleteRecord', { orderId: 'x'.repeat(71) })).error.code, 'invalid_order_id');
  assert.equal((await f.call('member.createOrder', { orderId: 'x'.repeat(65) })).error.code, 'invalid_order_id');
});

test('clear skips pending or unknown records and only accepts settled partial refunds and verified abandoned purchases', async () => {
  const f = await fixture();
  const patches = [
    { status: 'fulfilled' }, { status: 'partially_refunded', refundFen: 350 }, { status: 'refunded', refundFen: 700 },
    { status: 'cancelled', transactionId: null, paidAt: null, fulfilledAt: null },
    { status: 'created', transactionId: null, paidAt: null, fulfilledAt: null, abandonedAt: at, providerStatus: 0, lastReconciledAt: at },
    { status: 'created', transactionId: null, paidAt: null, fulfilledAt: null, abandonedAt: at, providerStatus: null, lastReconciledAt: at, paymentPreparedAt: null },
    { status: 'paid', fulfilledAt: null }, { status: 'unknown' },
    { status: 'created', transactionId: null, paidAt: null, fulfilledAt: null, abandonedAt: at, providerStatus: 1 },
    { status: 'partially_refunded', fulfilledAt: null, entitlementFulfilled: false },
  ];
  const orders = await Promise.all(patches.map((patch, i) => put(f, `state-record-${i}`, patch)));
  const flags = new Map((await visible(f)).map(order => [order.orderId, order.canClearRecord]));
  for (let i = 0; i < orders.length; i++) assert.equal(flags.get(orders[i].orderId), i < 6, JSON.stringify(patches[i]));
  const result = ok(await f.call('member.clearRecords', { orderIds: orders.map(order => order.orderId) }));
  assert.equal(result.hiddenCount, 6); assert.equal(result.retainedCount, 4);
  assert.ok(result.retained.every(item => item.reason === 'payment_unconfirmed'));
  assert.deepEqual((await visible(f)).map(order => order.orderId).sort(), orders.slice(6).map(order => order.orderId).sort());
});

test('an abandoned created order with issued parameters and no confirmed unpaid status remains visible', async () => {
  const f = await fixture();
  for (const [i, patch] of [
    { providerStatus: null, paymentPreparedAt: at }, { providerStatus: 2 }, { providerStatus: '0' },
    { providerStatus: 0, transactionId: 'paid-after-abandon' }, { providerStatus: 0, paidAt: at },
    { providerStatus: 0, abandonedAt: null }, { providerStatus: 0, lastReconciledAt: 'invalid' },
  ].entries()) {
    const order = await put(f, `unconfirmed-order-${i}`, { status: 'created', paidAt: null, fulfilledAt: null, transactionId: null,
      abandonedAt: at, lastReconciledAt: at, ...patch });
    const result = ok(await f.call('member.deleteRecord', { orderId: order.orderId }));
    assert.equal(result.hiddenCount, 0); assert.equal(result.retainedCount, 1);
    assert.equal((await f.repo.getOrder(order._id)).userHiddenAt, undefined);
  }
});

test('contradictory cancellation with a payment or entitlement still requires confirmation', async () => {
  const f = await fixture(), order = await put(f, 'contradictory-cancelled', { status: 'cancelled' });
  const result = ok(await f.call('member.deleteRecord', { orderId: order.orderId }));
  assert.equal(result.hiddenCount, 0); assert.equal(result.retainedCount, 1);
  assert.equal((await f.repo.getOrder(order._id)).userHiddenAt, undefined);
});

test('paid, refund-in-progress and payment-review records remain recoverable regardless of stale fulfilment fields', async () => {
  const f = await fixture();
  for (const status of ['paid', 'refunding', 'refund_pending', 'payment_pending', 'payment_check_pending', 'unknown']) {
    const order = await put(f, `unsettled-${status}`, { status });
    const result = ok(await f.call('member.deleteRecord', { orderId: order.orderId }));
    assert.equal(result.hiddenCount, 0, status); assert.equal(result.retainedCount, 1, status);
    assert.equal((await f.repo.getOrder(order._id)).userHiddenAt, undefined);
  }
});

test('clear uses the displayed ID snapshot and never hides newer or undisplayed older orders', async () => {
  const f = await fixture(), orders = [];
  for (let i = 0; i < 12; i++) orders.push(await put(f, `snapshot-order-${i}`, { createdAt: new Date(Date.parse(at) + i * 1000).toISOString() }));
  const snapshot = await visible(f); assert.equal(snapshot.length, 10);
  const fresh = await put(f, 'after-confirmation-new', { createdAt: new Date(Date.parse(at) + 20000).toISOString() });
  ok(await f.call('member.clearRecords', { orderIds: snapshot.map(order => order.orderId) }));
  assert.equal((await f.repo.getOrder(fresh._id)).userHiddenAt, undefined);
  assert.equal((await f.repo.getOrder(orders[0]._id)).userHiddenAt, undefined);
  assert.equal((await f.repo.getOrder(orders[1]._id)).userHiddenAt, undefined);
  assert.deepEqual((await visible(f)).map(order => order.orderId), [fresh.orderId], 'status still inspects only the original latest ten records');
});

test('all requested ownership is checked before mutation, and one foreign or missing ID aborts the batch', async () => {
  const f = await fixture(), own = await put(f, 'own-selected-order');
  const other = await put(f, 'foreign-selected-order', { userKey: userKeyOf('oOTHER00000000000000000001') });
  let writes = 0; f.repo.transactionWriteHook = async collection => { if (collection === C.orders) writes++; };
  for (const wrong of [other.orderId, 'missing-selected-order']) {
    const result = await f.call('member.clearRecords', { orderIds: [own.orderId, wrong] });
    assert.equal(result.error.code, 'unknown_order'); assert.equal(writes, 0);
    assert.equal((await f.repo.getOrder(own._id)).userHiddenAt, undefined);
  }
  // Even a corrupt record stored under the caller-derived key is rejected.
  await f.repo.saveOrder({ ...other, _id: orderKey(userKeyOf(), other.orderId) });
  assert.equal((await f.call('member.clearRecords', { orderIds: [own.orderId, other.orderId] })).error.code, 'unknown_order');
  assert.equal(writes, 0);
});

test('record selection validates bounds and duplicates are idempotently deduplicated', async () => {
  const f = await fixture(), order = await put(f, 'duplicate-selected-order');
  for (const orderIds of [null, [], Array(11).fill(order.orderId), ['short'], [{ orderId: order.orderId }]]) {
    assert.equal((await f.call('member.clearRecords', { orderIds })).error.code, 'invalid_order_ids');
  }
  assert.equal((await f.call('member.deleteRecord', { orderId: 'other|injection' })).error.code, 'invalid_order_id');
  const result = ok(await f.call('member.clearRecords', { orderIds: [order.orderId, order.orderId] }));
  assert.equal(result.hiddenCount, 1); assert.equal(result.newlyHiddenCount, 1);
});

test('a failed second write rolls back the entire hide transaction', async () => {
  const f = await fixture(), first = await put(f, 'rollback-order-first'), second = await put(f, 'rollback-order-second');
  f.repo.transactionWriteHook = async (collection, record) => { if (collection === C.orders && record._id === second._id) throw Error('write unavailable'); };
  assert.equal((await f.call('member.clearRecords', { orderIds: [first.orderId, second.orderId] })).ok, false);
  assert.equal((await f.repo.getOrder(first._id)).userHiddenAt, undefined);
  assert.equal((await f.repo.getOrder(second._id)).userHiddenAt, undefined);
});

test('hidden abandoned orders remain addressable by ID and a late paid result still grants membership once', async () => {
  const f = await fixture(), order = await put(f, 'late-paid-hidden-order', { status: 'created', paidAt: null, fulfilledAt: null, transactionId: null,
    abandonedAt: at, providerStatus: 0, lastReconciledAt: at,
    paymentSnapshot: { version: 1, provider: PROVIDER, appid: CONSUMER_APPID, offerId: '1450655203', productId: 'vip666',
      priceFen: 700, days: 7, env: 0, currency: 'CNY', buyQuantity: 1 } });
  ok(await f.call('member.deleteRecord', { orderId: order.orderId }));
  const provider = { queryOrder: async ({ openid, outTradeNo }) => ({ evidenceScope: 'query_order', authenticatedAppid: CONSUMER_APPID,
    requestedOpenid: openid, requestedOutTradeNo: outTradeNo, outTradeNo, env: 0, orderType: 0, amountFen: 700,
    status: 4, transactionId: 'late-paid-confirmed', paidAmountFen: 700, remainingAmountFen: 700 }) };
  const handle = createHandler({ repo: f.repo, clock: () => f.state.now, paymentProvider: provider, log: { error() {} } });
  const check = () => handle({ action: 'member.checkOrder', payload: { orderId: order.orderId } }, userContext());
  const first = ok(await check()); assert.equal(first.order.status, 'fulfilled'); assert.equal(first.membership.active, true);
  const expiry = first.membership.expiresAt;
  assert.equal(ok(await check()).membership.expiresAt, expiry);
  assert.equal((await f.repo.getOrder(order._id)).userHiddenAt, at);
  assert.equal((await visible(f)).length, 0);
  await f.repo.markOrderRefunded({ orderId: order._id, nowIso: at, refundFen: 700, providerData: { source: 'test' } });
  assert.equal((await f.repo.getOrder(order._id)).status, 'refunded');
  assert.equal((await f.repo.getOrder(order._id)).userHiddenAt, at);
  assert.equal(ok(await f.call('user.bootstrap')).membership.active, false, 'refund still revokes hidden-order entitlement');
});

test('payment updates interleaved in either order preserve hiding without reverting payment or refund state', async () => {
  for (const hideFirst of [false, true]) {
    const f = await fixture(), order = await put(f, `interleaved-payment-${hideFirst}`);
    // Queue transactions directly so the two arrays exercise both real
    // transaction orders, without ensureUser scheduling both hides last.
    const hide = () => f.repo.hideMemberRecords({ userKey: userKeyOf(), nowIso: at,
      records: [{ orderId: order.orderId, keys: [order._id, `${userKeyOf()}|${order.orderId}`] }] });
    const update = () => f.repo.updateOrder(order._id, { providerStatus: 4, providerAcknowledgedAt: at });
    await Promise.all(hideFirst ? [hide(), update()] : [update(), hide()]);
    let stored = await f.repo.getOrder(order._id);
    assert.equal(stored.userHiddenAt, at); assert.equal(stored.providerStatus, 4); assert.equal(stored.providerAcknowledgedAt, at);
    await f.repo.markOrderPaid({ orderId: order._id, transactionId: order.transactionId, nowIso: at, providerData: { amountFen: 700 } });
    stored = await f.repo.getOrder(order._id); assert.equal(stored.userHiddenAt, at); assert.equal(stored.status, 'fulfilled');
    const refund = () => f.repo.markOrderRefunded({ orderId: order._id, nowIso: at, refundFen: 700, providerData: { source: 'test' } });
    await Promise.all(hideFirst ? [hide(), refund()] : [refund(), hide()]);
    stored = await f.repo.getOrder(order._id);
    assert.equal(stored.userHiddenAt, at); assert.equal(stored.status, 'refunded'); assert.equal(stored.refundFen, 700);
    await f.repo.confirmPaymentRefundCallback({ orderId: order._id, refundId: 'hidden-refund-callback', refundFen: 700, nowIso: at });
    stored = await f.repo.getOrder(order._id);
    assert.equal(stored.userHiddenAt, at); assert.equal(stored.refundCallbacks.length, 1);
  }
});
