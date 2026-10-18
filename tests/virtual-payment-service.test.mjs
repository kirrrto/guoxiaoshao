import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createFixture, fakeFetch, userContext, userKeyOf, operatorContext } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { orderKey, paymentProviderFor, paymentProducts } = require('../cloudfunctions/gxs_api/lib/payment/service');
const { pricedPlan, PROMOTION_ENDS_AT, QUOTE_TTL_MS } = require('../cloudfunctions/gxs_api/lib/payment/plans');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { classifyOrder, buildReport } = require('../cloudfunctions/gxs_api/lib/services/growth');
const { accountKey } = require('../cloudfunctions/gxs_api/lib/growth-policy');
const APPID = 'wxe96ad9e77b602f1b';
const OPENID = 'oUSER000000000000000000001';
const DAY = 86400000;
const env = { GXS_CONSUMER_APPID: APPID, GXS_CONSUMER_APPSECRET: 'fake-secret', GXS_VIRTUAL_PAYMENT_APPKEY: 'fake-appkey',
  GXS_PAYMENT_CALLBACK_TOKEN: 'TestCallbackToken', GXS_PAYMENT_CALLBACK_AES_KEY: Buffer.alloc(32, 5).toString('base64').slice(0, -1) };
const json = data => new Response(JSON.stringify(data), { status: 200 });
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };

async function fixture({ enabled = true, memberPlans, warn } = {}) {
  const f = createFixture({ config: { memberProduct: { enabled }, ...(memberPlans ? { memberPlans } : {}) } });
  const calls = [], remote = new Map();
  const behavior = { ackFails: false, sessionOpenid: OPENID, sessionFails: false };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, body });
    if (parsed.pathname === '/sns/jscode2session') {
      if (behavior.onSession) await behavior.onSession();
      return json(behavior.sessionFails ? { errcode: 40029, errmsg: 'invalid code' } : { openid: behavior.sessionOpenid, session_key: '9hAb/NEYUlkaMBEsmFgzig==' });
    }
    if (parsed.pathname === '/cgi-bin/stable_token') return json({ access_token: 'fake-token', expires_in: 7200 });
    if (parsed.pathname === '/xpay/query_order') {
      const value = remote.get(body.order_id);
      return json(value || { errcode: -1, errmsg: 'do not interpret this as order not found' });
    }
    if (parsed.pathname === '/xpay/notify_provide_goods') return behavior.ackFails ? json({ errcode: -1, errmsg: 'temporary' }) : new Response('');
    throw Error('unexpected business network endpoint');
  };
  const handler = createHandler({ repo: f.repo, fetchImpl, clock: () => f.state.now, paymentEnv: env, log: { error: (...args) => { f.logs.push(args); }, ...(warn ? { warn } : {}) } });
  const call = (action, payload = {}, identity = userContext()) => handler({ action, payload }, identity);
  ok(await call('user.bootstrap'));
  function setRemote(id, patch = {}) {
    const platformId = orderKey(userKeyOf(), id);
    const data = { errcode: 0, order: { order_id: platformId, env_type: 1, status: 2, order_type: 0,
      order_fee: 700, paid_fee: 700, left_fee: 700, wx_order_id: `wx-${id}`, paid_time: 1790000000, ...patch } };
    remote.set(platformId, data); return data;
  }
  const create = async (id = 'purchase-0001', payload = {}) => {
    const original = await order(id);
    const plan = pricedPlan(payload.planId || 'member_7d', f.state.now);
    return call('member.createOrder', { orderId: id, loginCode: 'fresh-code', expectedPriceFen: original ? original.amountFen : plan && plan.priceFen, ...payload });
  };
  const check = (id = 'purchase-0001') => call('member.checkOrder', { orderId: id });
  const user = () => f.repo.getUser(userKeyOf());
  const order = (id = 'purchase-0001') => f.repo.getOrder(orderKey(userKeyOf(), id));
  return { ...f, calls, remote, behavior, call, create, check, user, order, setRemote };
}

test('disabled purchases expose seven-day product but create no order and perform no payment network calls', async () => {
  const f = await fixture({ enabled: false });
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.memberProduct.id, 'vip666'); assert.equal(boot.memberProduct.days, 7); assert.equal(boot.memberProduct.priceFen, 700);
  assert.equal(boot.memberProduct.paymentReady, false); assert.equal(boot.memberProduct.enabled, false);
  assert.equal(ok(await f.create()).reason, 'payment_not_enabled');
  assert.equal(await f.order(), null); assert.equal(f.calls.length, 0);
});

test('growth cash facts match real payment reconciliation, partial refund, full refund and hidden records', async () => {
  const f = await fixture();
  ok(await f.create('growth-paid-001'));
  assert.equal(classifyOrder(await f.order('growth-paid-001')).kind, 'unpaid');
  f.setRemote('growth-paid-001');
  ok(await f.check('growth-paid-001'));
  let order = await f.order('growth-paid-001');
  assert.equal(classifyOrder(order).kind, 'cash');
  assert.equal(classifyOrder(order).grossFen, 700);
  assert.equal(classifyOrder(order).refundFen, 0);
  f.setRemote('growth-paid-001', { left_fee: 350, status: 5 });
  ok(await f.check('growth-paid-001'));
  order = await f.order('growth-paid-001');
  assert.equal(classifyOrder(order).kind, 'cash');
  assert.equal(classifyOrder(order).refundFen, 350);
  f.setRemote('growth-paid-001', { left_fee: 0, status: 5 });
  ok(await f.check('growth-paid-001'));
  await f.repo.hideMemberRecords({ userKey: userKeyOf(), records: [{ orderId: 'growth-paid-001', keys: [order._id] }], nowIso: f.state.now.toISOString() });
  order = await f.order('growth-paid-001');
  assert.equal(classifyOrder(order).kind, 'cash');
  assert.equal(classifyOrder(order).refundFen, 700);
  const report = buildReport({ orders: [order], accounts: [], events: [], complete: true, since: order.paidAt, until: f.state.now.toISOString(), config: mergeConfig({}) });
  assert.equal(report.finance.hiddenCashOrders, 1);
  assert.equal(report.finance.netFen, 0);
});

test('growth recognises legacy verified weekly receipt and excludes its later target from first-payment cohort', async () => {
  const f = await fixture();
  ok(await f.create('growth-legacy-01'));
  const original = await f.order('growth-legacy-01');
  delete original.planId;
  await f.repo.saveOrder(original);
  f.setRemote('growth-legacy-01');
  ok(await f.check('growth-legacy-01'));
  const paid = await f.order('growth-legacy-01');
  assert.equal(classifyOrder(paid).planId, 'member_7d');
  f.advance(DAY);
  const at = f.state.now.toISOString();
  f.advance(8 * DAY);
  const report = buildReport({ orders: [paid], accounts: [{ _id: accountKey(userKeyOf()), firstIntent: { at } }], events: [], complete: true,
    since: paid.paidAt, until: f.state.now.toISOString(), config: mergeConfig({}) });
  assert.equal(report.cohort.existingPayers, 1);
  assert.equal(report.cohort.mature, 0);
  assert.equal(classifyOrder({ ...paid, payment: null }).kind, 'unknown', 'legacy fulfilled alone cannot establish cash');
});

const newPlans = { member_30d: { productId: 'test-published-month', enabled: true }, member_365d: { productId: 'test-published-year', enabled: true } };

test('all three published goods are mapped and purchasable once payment credentials are ready', async () => {
  const f = await fixture();
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.memberProduct.id, 'vip666');
  assert.equal(boot.memberProduct.planId, 'member_7d');
  assert.deepEqual(boot.memberProducts.map(plan => [plan.id, plan.planId, plan.days, plan.priceFen]), [
    ['member_7d', 'member_7d', 7, 700], ['member_30d', 'member_30d', 30, 1499], ['member_365d', 'member_365d', 365, 12900],
  ]);
  assert.equal(boot.memberProducts[0].productId, 'vip666');
  assert.deepEqual(boot.memberProducts.map(plan => plan.productId), ['vip666', 'vip777', 'vip888']);
  for (const plan of boot.memberProducts) {
    assert.equal(plan.paymentReady, true, plan.id);
    assert.match(plan.note, /不自动续费/);
    assert.match(plan.note, /一次性虚拟服务.*一经售出不予退款/);
  }
  const status = ok(await f.call('member.status'));
  assert.deepEqual(status.products, boot.memberProducts);
  assert.equal(status.product.id, 'vip666');
  assert.equal((await f.create('invalid-plan-001', { planId: 'invented-plan' })).error.code, 'invalid_member_plan');
});

test('reviewable runtime patch signs the published goods and leaves disabled weekly purchases closed', async () => {
  const patch = JSON.parse(fs.readFileSync(new URL('../config/member-plans.runtime-patch.json', import.meta.url), 'utf8'));
  const f = await fixture({ enabled: false });
  ok(await f.call('admin.updateConfig', { patch }, operatorContext()));
  assert.equal(ok(await f.create('week-still-disabled')).ok, false);
  for (const [planId, productId, amount, days] of [['member_30d', 'vip777', 1499, 30], ['member_365d', 'vip888', 12900, 365]]) {
    const result = ok(await f.create(`published-${days}-001`, { planId }));
    const sign = JSON.parse(result.payment.signData);
    assert.equal(sign.productId, productId); assert.equal(sign.goodsPrice, amount); assert.equal(Object.hasOwn(sign, 'activitySellingPrice'), false);
    assert.equal(result.order.amountFen, amount); assert.equal(result.order.days, days);
    assert.equal((await f.order(`published-${days}-001`)).productId, productId);
  }
});

test('an explicit blank merchant mapping remains unavailable and never creates an order', async () => {
  const f = await fixture({ memberPlans: { member_30d: { productId: '', enabled: false } } });
  const rejected = ok(await f.create('blank-month-001', { planId: 'member_30d' }));
  assert.equal(rejected.product.paymentReason, 'payment_product_id_missing');
  assert.equal(await f.order('blank-month-001'), null); assert.equal(f.calls.length, 0);
});

for (const [planId, days, amount] of [['member_30d', 30, 1499], ['member_365d', 365, 12900]]) {
  test(`${planId} signs mapped goods at the fixed price and fulfils its immutable duration once`, async () => {
    const f = await fixture({ memberPlans: newPlans });
    const id = `plan-purchase-${days}`;
    const created = ok(await f.create(id, { planId, days: 9999, priceFen: 1, productId: 'forged-merchant-goods' }));
    assert.equal(created.ok, true); assert.equal(created.order.planId, planId);
    assert.equal(created.order.days, days); assert.equal(created.order.amountFen, amount);
    const signed = JSON.parse(created.payment.signData), stored = await f.order(id);
    assert.equal(signed.productId, newPlans[planId].productId); assert.equal(signed.goodsPrice, amount); assert.equal(Object.hasOwn(signed, 'activitySellingPrice'), false); assert.equal(signed.buyQuantity, 1);
    assert.equal(stored.paymentSnapshot.version, 4); assert.equal(stored.paymentSnapshot.planId, planId);
    assert.equal(stored.paymentSnapshot.priceFen, amount); assert.equal(stored.paymentSnapshot.days, days);
    f.setRemote(id, { order_fee: amount, paid_fee: amount, left_fee: amount });
    const checked = ok(await f.check(id));
    assert.equal(checked.membership.expiresAt, new Date(f.state.now.getTime() + days * DAY).toISOString());
    assert.equal(ok(await f.check(id)).membership.expiresAt, checked.membership.expiresAt);
    assert.equal((await f.repo.listOrders(userKeyOf(), 20)).length, 1);
  });
}

test('mixed plan renewals stack and cumulative refunds remove only their own remaining entitlement', async () => {
  const f = await fixture({ memberPlans: newPlans });
  let previousExpiry = f.state.now.getTime();
  for (const [id, planId, amount, days] of [['week-old-001', 'member_7d', 700, 7], ['month-new-001', 'member_30d', 1499, 30], ['year-new-001', 'member_365d', 12900, 365]]) {
    const created = ok(await f.create(id, { planId }));
    assert.equal(JSON.parse(created.payment.signData).goodsPrice, amount, 'upgrading charges the selected actual fee');
    assert.equal(Object.hasOwn(JSON.parse(created.payment.signData), 'activitySellingPrice'), false);
    assert.equal(created.order.amountFen, amount);
    f.setRemote(id, { order_fee: amount, paid_fee: amount, left_fee: amount });
    const activated = ok(await f.check(id));
    previousExpiry += days * DAY;
    assert.equal(activated.membership.expiresAt, new Date(previousExpiry).toISOString(), 'each package extends the existing expiry by its full duration');
  }
  assert.equal((await f.user()).membership.expiresAt, new Date(f.state.now.getTime() + 402 * DAY).toISOString());
  f.setRemote('month-new-001', { order_fee: 1499, paid_fee: 1499, left_fee: 749, status: 5 });
  assert.equal(ok(await f.check('month-new-001')).membership.expiresAt, new Date(f.state.now.getTime() + 402 * DAY - Math.floor(30 * DAY * 750 / 1499)).toISOString());
  assert.equal(ok(await f.check('month-new-001')).membership.expiresAt, new Date(f.state.now.getTime() + 402 * DAY - Math.floor(30 * DAY * 750 / 1499)).toISOString());
  f.setRemote('month-new-001', { order_fee: 1499, paid_fee: 1499, left_fee: 0, status: 5 });
  assert.equal(ok(await f.check('month-new-001')).membership.expiresAt, new Date(f.state.now.getTime() + 372 * DAY).toISOString());
  assert.equal((await f.order('year-new-001')).status, 'fulfilled');
  f.setRemote('year-new-001', { order_fee: 12900, paid_fee: 12900, left_fee: 0, status: 5 });
  const annualRefund = ok(await f.check('year-new-001'));
  assert.equal(annualRefund.membership.expiresAt, new Date(f.state.now.getTime() + 7 * DAY).toISOString());
  assert.equal((await f.order('week-old-001')).status, 'fulfilled');
  assert.equal(ok(await f.check('year-new-001')).membership.expiresAt, annualRefund.membership.expiresAt, 'annual refund replay cannot consume the weekly balance');
});

test('changing selection or disabling current goods cannot change or strand an existing paid plan', async () => {
  const f = await fixture({ memberPlans: newPlans });
  ok(await f.create('immutable-month-001', { planId: 'member_30d' }));
  const original = await f.order('immutable-month-001');
  f.setRemote('immutable-month-001', { order_fee: 1499, paid_fee: 0, left_fee: 0, status: 1 });
  const pending = ok(await f.create('immutable-month-001', { planId: 'member_365d' }));
  assert.equal(pending.order.planId, 'member_30d'); assert.equal(pending.order.amountFen, 1499); assert.equal(pending.payment, null);
  ok(await f.call('admin.updateConfig', { patch: { memberPlans: { member_30d: { enabled: false, productId: 'test-month-replacement' } }, memberProduct: { enabled: false } } }, operatorContext()));
  f.setRemote('immutable-month-001', { order_fee: 1499, paid_fee: 1499, left_fee: 1499 });
  assert.equal(ok(await f.create('immutable-month-001', { planId: 'member_365d' })).membership.expiresAt, new Date(f.state.now.getTime() + 30 * DAY).toISOString());
  assert.deepEqual((await f.order('immutable-month-001')).paymentSnapshot, original.paymentSnapshot);
  const disabled = ok(await f.create('disabled-month-001', { planId: 'member_30d' }));
  assert.equal(disabled.reason, 'payment_not_enabled');
  assert.equal(disabled.product.paymentReason, 'payment_plan_disabled');
});

test('legacy seven-day orders without logical plan metadata remain reconcilable after additional plans are enabled', async () => {
  const f = await fixture({ memberPlans: newPlans });
  ok(await f.create('legacy-seven-001'));
  const original = await f.order('legacy-seven-001');
  delete original.planId;
  f.repo.tables.get(C.orders).set(original._id, original);
  f.setRemote('legacy-seven-001');
  const result = ok(await f.create('legacy-seven-001', { planId: 'member_365d' }));
  assert.equal(result.order.planId, 'member_7d'); assert.equal(result.order.amountFen, 700);
  assert.equal(result.membership.expiresAt, new Date(f.state.now.getTime() + 7 * DAY).toISOString());
});

test('an unprepared monthly intent keeps its original plan when retried after the selection changes', async () => {
  const f = await fixture({ memberPlans: newPlans });
  f.behavior.sessionFails = true;
  assert.equal((await f.create('unprepared-month-001', { planId: 'member_30d' })).ok, false);
  assert.equal((await f.order('unprepared-month-001')).paymentPreparedAt, null);
  f.behavior.sessionFails = false;
  const retried = ok(await f.create('unprepared-month-001', { planId: 'member_365d' }));
  assert.equal(retried.order.planId, 'member_30d');
  assert.equal(JSON.parse(retried.payment.signData).goodsPrice, 1499);
  assert.equal(JSON.parse(retried.payment.signData).productId, newPlans.member_30d.productId);
});

test('unsupported or crossed plan price-duration snapshots never grant membership', async () => {
  for (const patch of [{ amountFen: 700, paymentSnapshot: { priceFen: 700 } }, { days: 365, paymentSnapshot: { days: 365 } }, { planId: 'member_365d', paymentSnapshot: { planId: 'member_365d' } }]) {
    const f = await fixture({ memberPlans: newPlans });
    ok(await f.create('tampered-month-001', { planId: 'member_30d' }));
    const order = await f.order('tampered-month-001');
    f.repo.tables.get(C.orders).set(order._id, { ...order, ...patch, paymentSnapshot: { ...order.paymentSnapshot, ...patch.paymentSnapshot } });
    f.setRemote('tampered-month-001', { order_fee: 1499, paid_fee: 1499, left_fee: 1499 });
    const refused = await f.check('tampered-month-001');
    assert.equal(refused.error.code, 'payment_evidence_mismatch');
    assert.equal((await f.user()).membership.expiresAt, null);
  }
});

test('create persists trusted immutable product/account snapshot before exposing exact signed payment data', async () => {
  const f = await fixture();
  const created = ok(await f.create('purchase-0001', { priceFen: 1, days: 9999, productId: 'forged', openid: 'other', appid: 'other' }));
  assert.equal(created.ok, true); assert.equal(created.order.status, 'created'); assert.equal(created.order.paymentPending, false);
  const order = await f.order();
  assert.equal(order.outTradeNo, `G${createHash('sha256').update(`${userKeyOf()}|purchase-0001`).digest('hex').slice(0, 31)}`);
  assert.equal(order.outTradeNo.length, 32); assert.equal(order.userKey, userKeyOf()); assert.equal(order.openid, OPENID);
  assert.deepEqual(order.paymentSnapshot, { version: 1, provider: 'wechat_virtual_payment', appid: APPID,
    offerId: '1450655203', productId: 'vip666', priceFen: 700, days: 7, currency: 'CNY', env: 0, buyQuantity: 1 });
  assert.ok(order.paymentPreparedAt); assert.equal(JSON.parse(created.payment.signData).outTradeNo, order.outTradeNo);
  assert.equal((await f.user()).membership.expiresAt, null);
  assert.doesNotMatch(JSON.stringify(order), /session_key|paySig|signature|fresh-code|fake-secret|fake-appkey/);
});

test('repeated client intents with platform status 0 or 1 never reopen the cashier or falsely become paid', async () => {
  for (const providerStatus of [0, 1]) {
    const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001', { status: providerStatus, paid_fee: 0, left_fee: 0 });
    const repeated = ok(await f.create());
    assert.equal(repeated.ok, false); assert.equal(repeated.reason, 'payment_pending'); assert.equal(repeated.payment, null);
    assert.equal(repeated.order.status, 'created'); assert.equal(repeated.order.providerStatus, providerStatus); assert.equal(repeated.order.paymentPending, true);
    assert.equal(f.calls.filter(call => call.path === '/sns/jscode2session').length, 1);
    assert.equal((await f.user()).membership.expiresAt, null);
  }
});

test('an uncertain query after signatures were issued cannot be reinterpreted as nonpayment or retried checkout', async () => {
  const f = await fixture(); ok(await f.create());
  const retry = await f.create(); assert.equal(retry.ok, false); assert.equal(retry.error.code, 'payment_check_pending');
  assert.equal(f.calls.filter(call => call.path === '/sns/jscode2session').length, 1);
  assert.equal((await f.order()).status, 'created'); assert.equal((await f.user()).membership.expiresAt, null);
  assert.equal(f.logs.length, 0);
});

test('a failed code2Session with no issued signature may recover the same local order without a new payment attempt', async () => {
  const f = await fixture(); f.behavior.sessionFails = true;
  assert.equal((await f.create()).ok, false); assert.equal((await f.order()).paymentPreparedAt, null);
  const local = ok(await f.check());
  assert.equal(local.order.status, 'created'); assert.equal(local.order.paymentPending, false);
  f.behavior.sessionFails = false;
  assert.equal(ok(await f.create()).ok, true);
  assert.equal((await f.order()).orderId, 'purchase-0001');
  assert.equal(f.calls.filter(call => call.path === '/xpay/query_order').length, 2);
  assert.equal((await f.user()).membership.expiresAt, null);
});

test('concurrent create calls only issue one checkout and retain a single account-scoped order', async () => {
  const f = await fixture();
  const results = await Promise.all([f.create(), f.create()]);
  assert.equal(results.filter(result => result.ok && result.data.payment).length, 1);
  assert.equal(results.filter(result => !result.ok && result.error.code === 'payment_pending').length, 1);
  assert.equal(f.calls.filter(call => call.path === '/sns/jscode2session').length, 1);
  assert.equal((await f.repo.listOrders(userKeyOf(), 20)).length, 1);
});

test('cross-account lookup is isolated and caller-supplied payment fields cannot read or fulfil another account', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001');
  const result = await f.call('member.checkOrder', { orderId: 'purchase-0001', userKey: userKeyOf(), openid: OPENID }, userContext('other-user'));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'unknown_order');
  assert.equal(f.calls.filter(call => call.path === '/xpay/query_order').length, 0);
  assert.equal((await f.user()).membership.expiresAt, null);
});

test('authoritative paid query grants one seven-day membership and duplicate checks cannot extend it again', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001');
  const first = ok(await f.check()); assert.equal(first.order.status, 'fulfilled'); assert.equal(first.membership.active, true);
  const expiry = new Date(f.state.now.getTime() + 7 * DAY).toISOString(); assert.equal(first.membership.expiresAt, expiry);
  assert.equal((await f.order()).transactionId, 'wx-purchase-0001'); assert.ok((await f.order()).providerAcknowledgedAt);
  assert.equal(ok(await f.check()).membership.expiresAt, expiry);
  assert.equal(f.calls.filter(call => call.path === '/xpay/notify_provide_goods').length, 1);
  const duplicateCreate = ok(await f.create()); assert.equal(duplicateCreate.payment, null); assert.equal(duplicateCreate.order.status, 'fulfilled');
  assert.equal(f.calls.filter(call => call.path === '/sns/jscode2session').length, 1);
});

test('paid fulfilment makes zero-credit live queries usable, renewals extend access and expired receipts cannot reactivate it', async () => {
  const f = await fixture();
  ok(await f.call('admin.updateConfig', { patch: { collector: { budgetMode: 'continuous' }, query: { sharedFreshnessSeconds: 10 } } }, operatorContext()));
  const pickup = fakeFetch({ R577: { display: 'available' } });
  const queryHandler = createHandler({ repo: f.repo, fetchImpl: pickup, clock: () => f.state.now, log: { error() {} } });
  const query = id => queryHandler({ action: 'query.pickup', payload: { queryId: `paid-access-${id}`, partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] } }, userContext());
  assert.equal(ok(await query('before-payment')).reason, 'insufficient_credits');
  ok(await f.create()); f.setRemote('purchase-0001'); const first = ok(await f.check());
  const available = ok(await query('after-payment'));
  assert.equal(available.ok, true); assert.equal(available.member, true); assert.equal(available.charged, 0); assert.equal(available.balance, 0);
  f.advance(DAY);
  ok(await f.create('purchase-0002')); f.setRemote('purchase-0002');
  const renewed = ok(await f.check('purchase-0002'));
  assert.equal(Date.parse(renewed.membership.expiresAt), Date.parse(first.membership.expiresAt) + 7 * DAY);
  f.advance(Date.parse(renewed.membership.expiresAt) - f.state.now.getTime());
  assert.equal(ok(await query('expired')).reason, 'insufficient_credits');
  const replayed = ok(await f.check('purchase-0002'));
  assert.equal(replayed.membership.active, false); assert.equal(replayed.membership.expiresAt, renewed.membership.expiresAt);
  ok(await f.create('purchase-0003')); f.setRemote('purchase-0003');
  const restarted = ok(await f.check('purchase-0003'));
  assert.equal(Date.parse(restarted.membership.expiresAt), f.state.now.getTime() + 7 * DAY);
  assert.equal(ok(await query('renewed-after-expiry')).ok, true);
  assert.equal(pickup.calls.length, 2, 'free-user denials never consume actual upstream requests');
  assert.deepEqual(await f.repo.listLedger(userKeyOf()), [], 'membership queries never consume free-user credits');
});

test('missing or mismatched payment evidence never grants rights', async () => {
  for (const patch of [
    { order_fee: 1 }, { paid_fee: 699 }, { paid_fee: undefined }, { order_id: 'other-order' },
    { order_type: 1 }, { env_type: 2 }, { env_type: 0 }, { wx_order_id: '' }, { left_fee: undefined }, { left_fee: 701 },
  ]) {
    const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001', patch);
    const result = await f.check(); assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal((await f.user()).membership.expiresAt, null, JSON.stringify(patch));
    assert.equal((await f.order()).status, 'created');
  }
});

test('refund already visible before delivery grants only net duration and later cumulative refunds preserve a separate purchase', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001', { status: 5, left_fee: 350 });
  let result = ok(await f.check()); assert.equal(result.order.status, 'partially_refunded');
  assert.equal(result.order.refundFen, 350);
  assert.equal(result.membership.expiresAt, new Date(f.state.now.getTime() + 3.5 * DAY).toISOString());
  ok(await f.create('purchase-0002')); f.setRemote('purchase-0002'); ok(await f.check('purchase-0002'));
  f.setRemote('purchase-0001', { status: 5, left_fee: 0 }); result = ok(await f.check());
  assert.equal(result.order.status, 'refunded'); assert.equal(result.membership.expiresAt, new Date(f.state.now.getTime() + 7 * DAY).toISOString());
  assert.equal((await f.order()).refundFen, 700);
  assert.equal(ok(await f.check()).membership.expiresAt, result.membership.expiresAt);
});

test('full refund observed before any fulfilment never briefly creates membership', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001', { status: 8, order_type: 7, left_fee: 0 });
  const result = ok(await f.check()); assert.equal(result.order.status, 'refunded'); assert.equal(result.membership.active, false);
  assert.equal(result.order.fulfilledAt, null); assert.equal(f.calls.filter(call => call.path === '/xpay/notify_provide_goods').length, 0);
  f.setRemote('purchase-0001', { status: 4 });
  assert.equal(ok(await f.check()).membership.active, false, 'late paid observation cannot revive a full refund');
});

test('a second order cannot reuse the first payment transaction receipt', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001'); ok(await f.check());
  ok(await f.create('purchase-0002')); f.setRemote('purchase-0002', { wx_order_id: 'wx-purchase-0001' });
  const result = await f.check('purchase-0002'); assert.equal(result.ok, false); assert.equal(result.error.code, 'payment_already_used');
  assert.equal((await f.user()).membership.expiresAt, new Date(f.state.now.getTime() + 7 * DAY).toISOString());
});

test('fulfilment persistence failure leaves paid intent for exactly-once recovery', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001');
  f.repo.transactionWriteHook = async (table, doc) => { if (table === C.users && doc.membership.entitlements) throw Error('write failed'); };
  assert.equal((await f.check()).ok, false); assert.equal((await f.order()).status, 'paid'); assert.equal((await f.user()).membership.expiresAt, null);
  f.repo.transactionWriteHook = null;
  assert.equal(ok(await f.check()).order.status, 'fulfilled');
  assert.equal((await f.user()).membership.expiresAt, new Date(f.state.now.getTime() + 7 * DAY).toISOString());
});

test('delivery acknowledgement failure retains confirmed membership and retries acknowledgement only', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001'); f.behavior.ackFails = true;
  const first = ok(await f.check()); assert.equal(first.membership.active, true); assert.equal((await f.order()).providerAcknowledgedAt, null);
  f.behavior.ackFails = false;
  const second = ok(await f.check()); assert.equal(second.membership.expiresAt, first.membership.expiresAt); assert.ok((await f.order()).providerAcknowledgedAt);
});

test('a lease cleanup failure cannot hide an already committed paid membership', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001');
  const release = f.repo.releaseLease;
  f.repo.releaseLease = async () => { throw new Error('lease database temporarily unavailable'); };
  const paid = ok(await f.check());
  assert.equal(paid.order.status, 'fulfilled'); assert.equal(paid.membership.active, true);
  const expiry = paid.membership.expiresAt;
  assert.equal((await f.order()).fulfilledAt, f.state.now.toISOString());
  // Cleanup is recoverable through the existing lease expiry, without issuing
  // another grant or pretending the committed payment remains uncertain.
  f.repo.releaseLease = release; f.advance(60000);
  assert.equal(ok(await f.check()).membership.expiresAt, expiry);
  assert.equal(f.calls.filter(call => call.path === '/xpay/notify_provide_goods').length, 1);
});

test('lease cleanup does not replace an actionable payment identity rejection', async () => {
  const f = await fixture(); f.behavior.sessionOpenid = 'another-user';
  f.repo.releaseLease = async () => { throw new Error('credential-bearing transport detail must not escape'); };
  const response = await f.create();
  assert.equal(response.ok, false); assert.equal(response.error.code, 'payment_openid_mismatch');
  assert.equal((await f.user()).membership.expiresAt, null);
  assert.equal((await f.order()).paymentPreparedAt, null);
  assert.doesNotMatch(JSON.stringify(response), /credential-bearing/);
});

test('a throwing cleanup logger preserves paid success and the original identity rejection', async () => {
  const warnings = [];
  const f = await fixture({ warn: text => { warnings.push(text); throw Error('logger failed'); } });
  ok(await f.create()); f.setRemote('purchase-0001');
  f.repo.releaseLease = async () => { throw Error('private transport details'); };
  const paid = ok(await f.check());
  assert.equal(paid.order.status, 'fulfilled'); assert.equal(paid.membership.active, true);
  f.behavior.sessionOpenid = 'another-user';
  const rejected = await f.create('other-intent-001');
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'payment_openid_mismatch');
  assert.deepEqual(warnings, ['[payment] order lease cleanup failed', '[payment] order lease cleanup failed']);
  assert.doesNotMatch(JSON.stringify(rejected), /private transport|logger failed/);
});

test('closed platform order becomes cancelled and can never be reopened by reuse of its client ID', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001', { status: 6, paid_fee: 0, left_fee: 0 });
  assert.equal(ok(await f.check()).order.status, 'cancelled');
  const repeated = ok(await f.create()); assert.equal(repeated.order.status, 'cancelled'); assert.equal(repeated.payment, null);
  assert.equal(f.calls.filter(call => call.path === '/sns/jscode2session').length, 1);
});

test('payment pause preserves recovery of issued orders and redemption remains compatible', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001');
  ok(await f.call('admin.updateConfig', { patch: { memberProduct: { enabled: false } } }, operatorContext()));
  const result = ok(await f.check()); assert.equal(result.membership.active, true);
  assert.equal(ok(await f.create('purchase-0002')).reason, 'payment_not_enabled');
  const redemption = ok(await f.call('member.redeemCode', { code: 'hbw666' }));
  assert.equal(redemption.membership.expiresAt, new Date(f.state.now.getTime() + 37 * DAY).toISOString());
});

test('production contexts share only the latest credential/config provider while injected contexts stay isolated', () => {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const context = () => ({ config: mergeConfig({ memberProduct: { enabled: true } }), fetchImpl: globalThis.fetch, paymentCacheAllowed: true });
    const first = paymentProviderFor(context());
    assert.equal(paymentProviderFor(context()), first);
    paymentProducts(context());
    assert.equal(paymentProviderFor(context()), first, 'listing the other plans preserves the default provider and its token cache');
    process.env.GXS_VIRTUAL_PAYMENT_APPKEY = 'rotated-fake-key';
    const rotated = paymentProviderFor(context()); assert.notEqual(rotated, first);
    assert.equal(paymentProviderFor(context()), rotated);
    const changed = context(); changed.config.memberProduct.enabled = false;
    assert.notEqual(paymentProviderFor(changed), rotated);
    const injected = () => ({ ...context(), paymentEnv: { ...env }, clock: () => new Date('2026-01-01T00:00:00Z') });
    assert.notEqual(paymentProviderFor(injected()), paymentProviderFor(injected()));
    const fakeClockContext = () => ({ ...context(), paymentCacheAllowed: false, clock: () => new Date('2026-01-01T00:00:00Z') });
    assert.notEqual(paymentProviderFor(fakeClockContext()), paymentProviderFor(fakeClockContext()));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('admin.paymentStatus is operator-only, redacted, and performs no token probe or business network request', async () => {
  const f = await fixture({ enabled: false });
  const denied = await f.call('admin.paymentStatus', { isAdmin: true, source: 'wx_devtools' });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'forbidden');
  const inspected = ok(await f.call('admin.paymentStatus', {}, operatorContext()));
  assert.equal(inspected.payment.configured, true); assert.equal(inspected.payment.verified, false);
  assert.equal(inspected.payment.ready, false); assert.equal(inspected.payment.reason, 'payment_disabled');
  assert.equal(inspected.product.id, 'vip666'); assert.equal(inspected.product.priceFen, 700);
  assert.doesNotMatch(JSON.stringify(inspected), /fake-secret|fake-appkey|TestCallbackToken|access_token|session_key/);
  assert.equal(f.calls.length, 0); assert.equal((await f.repo.listOrders(userKeyOf(), 20)).length, 0);
});

test('an unpaid order stuck at platform status 1 can be abandoned; a new purchase is then allowed', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001', { status: 1, paid_fee: 0, left_fee: 0 });
  assert.equal(ok(await f.check()).order.paymentPending, true);
  const abandoned = ok(await f.call('member.abandonOrder', { orderId: 'purchase-0001' }));
  assert.equal(abandoned.order.status, 'created'); assert.equal(abandoned.order.abandoned, true); assert.equal(abandoned.order.paymentPending, false);
  assert.equal((await f.user()).membership.expiresAt, null);
  assert.equal(ok(await f.call('member.status')).orders.find(o => o.orderId === 'purchase-0001').abandoned, true);
  const next = ok(await f.create('purchase-0002'));
  assert.equal(next.ok, true); assert.ok(next.payment);
  // A late payment of the abandoned order is still honoured, never lost.
  f.setRemote('purchase-0001');
  const late = ok(await f.check());
  assert.equal(late.order.status, 'fulfilled'); assert.equal(late.order.abandoned, false);
  assert.ok(Date.parse((await f.user()).membership.expiresAt) > f.state.now.getTime());
});

test('abandoning asks the platform first: a paid order is fulfilled instead of abandoned', async () => {
  const f = await fixture(); ok(await f.create()); f.setRemote('purchase-0001');
  const result = ok(await f.call('member.abandonOrder', { orderId: 'purchase-0001' }));
  assert.equal(result.order.status, 'fulfilled'); assert.equal(result.order.abandoned, false);
  assert.equal(result.membership.active, true);
  const other = ok(await f.call('member.abandonOrder', { orderId: 'purchase-0001' }, userContext('other-user')));
  assert.equal(other.order.status, 'cancelled');
  assert.equal((await f.order()).status, 'fulfilled', 'same client ID for another account never modifies this order');
});

test('contradictory payment evidence cannot abandon an issued checkout, but a verification outage can', async () => {
  for (const reason of ['unavailable', 'mismatched_amount']) {
    const f = await fixture(); ok(await f.create());
    if (reason === 'mismatched_amount') f.setRemote('purchase-0001', { order_fee: 1499 });
    const result = await f.call('member.abandonOrder', { orderId: 'purchase-0001' });
    if (reason === 'mismatched_amount') {
      assert.equal(result.ok, false, reason);
      assert.equal(Boolean((await f.order()).abandonedAt), false, reason);
      assert.equal((await f.order()).status, 'created');
    } else {
      // Query outage on an unpaid open checkout must not strand the buyer.
      // A late payment of the abandoned order is still fulfilled later.
      assert.equal(result.ok, true, reason);
      assert.equal(result.data.order.abandoned, true, reason);
      assert.equal(Boolean((await f.order()).abandonedAt), true, reason);
      assert.equal((await f.order()).status, 'created');
    }
  }
});

test('abandon cannot bypass another in-flight payment reconciliation lease', async () => {
  const f = await fixture(); ok(await f.create());
  const order = await f.order();
  await f.repo.acquireLease({ id: `pay_order_${order._id}`, ownerId: 'payment-callback', now: f.state.now.toISOString(), expiresAt: new Date(f.state.now.getTime() + 60000).toISOString() });
  const result = await f.call('member.abandonOrder', { orderId: 'purchase-0001' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'payment_pending');
  assert.equal(Boolean((await f.order()).abandonedAt), false);
});

test('cancelling an intent before backend creation is durable and fences delayed creates', async () => {
  const f = await fixture();
  const cancelled = ok(await f.call('member.abandonOrder', { orderId: 'before-login-001' }));
  assert.equal(cancelled.order.status, 'cancelled');
  assert.equal(cancelled.order.type, 'membership_cancelled_intent');
  assert.equal(cancelled.order.amountFen, 0);
  assert.equal(cancelled.membership.active, false);
  assert.equal(f.calls.length, 0, 'no signature was ever issued so no platform request is required');
  assert.equal(ok(await f.check('before-login-001')).order.status, 'cancelled');
  assert.equal(ok(await f.call('member.abandonOrder', { orderId: 'before-login-001' })).order.status, 'cancelled');
  const replay = ok(await f.create('before-login-001', { planId: 'member_365d' }));
  assert.equal(replay.order.status, 'cancelled');
  assert.equal(replay.payment, null);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.repo.listReconcileOrders({ nowIso: f.state.now.toISOString() })).length, 0);
  assert.equal(ok(await f.create('replacement-intent')).ok, true);
});

test('cancelling an intent with failed login after backend creation keeps its original plan', async () => {
  const f = await fixture(); f.behavior.sessionFails = true;
  assert.equal((await f.create('failed-session-001', { planId: 'member_30d' })).ok, false);
  const cancelled = ok(await f.call('member.abandonOrder', { orderId: 'failed-session-001' }));
  assert.equal(cancelled.order.abandoned, true);
  assert.equal(cancelled.order.days, 30);
  assert.equal(cancelled.order.amountFen, 1499);
  assert.equal(cancelled.membership.active, false);
  f.behavior.sessionFails = false;
  const replay = ok(await f.create('failed-session-001'));
  assert.equal(replay.payment, null);
  assert.equal(replay.order.abandoned, true);
  assert.equal(f.calls.filter(call => call.path === '/sns/jscode2session').length, 1, 'an abandoned intent never issues a new signature');
});

test('internal cancellation fences stay recoverable but never appear as zero-day memberships', async () => {
  const f = await fixture();
  ok(await f.call('member.abandonOrder', { orderId: 'hidden-intent-001' }));
  assert.deepEqual(ok(await f.call('member.status')).orders, []);
  assert.equal((await f.order('hidden-intent-001')).type, 'membership_cancelled_intent');
  assert.equal(ok(await f.check('hidden-intent-001')).order.status, 'cancelled');
  const replay = ok(await f.create('hidden-intent-001'));
  assert.equal(replay.order.status, 'cancelled');
  assert.equal(replay.payment, null);
  assert.equal(f.calls.length, 0);
});

test('membership history retains actual purchases beside hidden cancellation fences', async () => {
  const f = await fixture();
  ok(await f.create('real-purchase-001'));
  f.setRemote('real-purchase-001');
  ok(await f.check('real-purchase-001'));
  ok(await f.call('member.abandonOrder', { orderId: 'hidden-intent-002' }));
  const status = ok(await f.call('member.status'));
  assert.deepEqual(status.orders.map(order => order.orderId), ['real-purchase-001']);
  assert.equal(status.orders[0].days, 7);
  assert.equal(status.orders[0].status, 'fulfilled');
  assert.equal(status.membership.active, true);
});

test('concurrent cancellation and delayed create cannot reopen a cancelled client intent', async () => {
  const f = await fixture();
  const originalCreate = f.repo.createOrderIfAbsent;
  let releaseCancellation, reachedCancellation;
  const entered = new Promise(resolve => { reachedCancellation = resolve; });
  const persist = new Promise(resolve => { releaseCancellation = resolve; });
  f.repo.createOrderIfAbsent = async order => {
    if (order.type === 'membership_cancelled_intent') { reachedCancellation(); await persist; }
    return originalCreate(order);
  };
  const abandoning = f.call('member.abandonOrder', { orderId: 'concurrent-intent-001' });
  await entered;
  const creating = await f.create('concurrent-intent-001');
  assert.equal(creating.ok, false);
  assert.equal(creating.error.code, 'payment_pending');
  assert.equal(f.calls.length, 0);
  releaseCancellation();
  assert.equal(ok(await abandoning).order.status, 'cancelled');
  const retry = ok(await f.create('concurrent-intent-001'));
  assert.equal(retry.payment, null);
  assert.equal(retry.order.status, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.user()).membership.expiresAt, null);
});

test('ongoing month and year prices remain unchanged across the former deadline and later dates', async () => {
  const f = await fixture();
  f.state.now = new Date(Date.parse(PROMOTION_ENDS_AT) - 1);
  const before = ok(await f.call('user.bootstrap')).memberProducts;
  assert.deepEqual(before.map(p => [p.priceFen, p.standardPriceFen]), [[700, 700], [1499, 3000], [12900, 36000]]);
  assert.deepEqual(before[1].promotion, { active: true, endsAt: null, timezone: 'Asia/Shanghai' });
  f.advance(1);
  const after = ok(await f.call('member.status')).products;
  assert.deepEqual(after.map(p => [p.priceFen, p.standardPriceFen]), [[700, 700], [1499, 3000], [12900, 36000]]);
  assert.deepEqual(after[1].promotion, before[1].promotion);
  f.state.now = new Date('2027-12-01T00:00:00.000Z');
  assert.deepEqual(ok(await f.call('member.status')).products.map(p => p.priceFen), [700, 1499, 12900]);
  for (const [planId, amount, days] of [['member_30d', 1499, 30], ['member_365d', 12900, 365]]) {
    const id = `after-deadline-${days}`;
    const created = ok(await f.create(id, { planId }));
    const sign = JSON.parse(created.payment.signData);
    assert.equal(sign.goodsPrice, amount); assert.equal(Object.hasOwn(sign, 'activitySellingPrice'), false);
    assert.equal(created.order.amountFen, amount);
    const stored = await f.order(id);
    assert.equal(stored.paymentSnapshot.version, 4); assert.equal(stored.paymentSnapshot.promotionEndsAt, null);
    assert.equal(Date.parse(stored.quoteExpiresAt) - Date.parse(stored.createdAt), QUOTE_TTL_MS);
    f.setRemote(id, { order_fee: amount, paid_fee: amount, left_fee: amount });
    assert.equal(ok(await f.check(id)).membership.enhanced, true);
  }
});

test('new month/year purchases require explicit matching integer prices and issue no order on stale or missing confirmation', async () => {
  for (const [planId, price] of [['member_30d', 1499], ['member_365d', 12900]]) {
    const f = await fixture();
    for (const expectedPriceFen of [undefined, null, String(price), 1, 1990, 20000]) {
      const result = await f.create('price-confirm-001', { planId, expectedPriceFen, priceFen: price });
      assert.equal(result.error.code, 'payment_price_changed');
      assert.equal(result.error.details.canDiscardIntent, true);
      assert.equal(result.error.details.product.priceFen, price);
      assert.equal(await f.order('price-confirm-001'), null);
    }
    assert.equal(f.calls.length, 0);
    assert.ok(ok(await f.create('price-confirm-002', { planId, expectedPriceFen: price })).payment);
  }
  const week = await fixture();
  assert.ok(ok(await week.create('old-week-client-01', { expectedPriceFen: undefined })).payment);
});

test('an unprepared quote expires after ten minutes and cancelling it fences delayed retries', async () => {
  const f = await fixture(); f.behavior.sessionFails = true;
  await f.create('quote-expiry-001', { planId: 'member_30d' });
  const order = await f.order('quote-expiry-001');
  assert.equal(order.quoteExpiresAt, new Date(f.state.now.getTime() + QUOTE_TTL_MS).toISOString());
  f.advance(QUOTE_TTL_MS); f.behavior.sessionFails = false;
  const refused = await f.create('quote-expiry-001', { planId: 'member_30d' });
  assert.equal(refused.error.code, 'payment_price_changed'); assert.equal(refused.error.details.reason, 'quote_expired');
  assert.equal(refused.error.details.canDiscardIntent, true);
  assert.equal((await f.order('quote-expiry-001')).status, 'cancelled');
  assert.equal(ok(await f.create('quote-expiry-001')).payment, null);
  assert.equal(ok(await f.check('quote-expiry-001')).order.status, 'cancelled');
  assert.equal(f.calls.filter(x => x.path === '/sns/jscode2session').length, 1);
});

test('quote TTL expiry while exchanging the login code never exposes a stale signature', async () => {
  const f = await fixture();
  f.state.now = new Date(Date.parse(PROMOTION_ENDS_AT) - 2000);
  f.behavior.onSession = () => f.advance(QUOTE_TTL_MS);
  const result = await f.create('login-deadline-001', { planId: 'member_30d', expectedPriceFen: 1499 });
  assert.equal(result.error.code, 'payment_price_changed');
  assert.equal(result.error.details.reason, 'quote_expired'); assert.equal(result.error.details.product.priceFen, 1499);
  const order = await f.order('login-deadline-001');
  assert.equal(order.status, 'cancelled'); assert.equal(order.paymentPreparedAt, null);
  assert.equal(Date.parse(order.quoteExpiresAt) - Date.parse(order.createdAt), QUOTE_TTL_MS); assert.equal(order.amountFen, 1499);
  assert.doesNotMatch(JSON.stringify(result), /paySig|signature|signData/);
});

test('expiry during durable signature marking cancels before exposing payment parameters', async () => {
  const f = await fixture();
  f.state.now = new Date(Date.parse(PROMOTION_ENDS_AT) - 2000);
  const update = f.repo.updateOrder;
  f.repo.updateOrder = async (id, patch) => {
    const result = await update(id, patch);
    if (patch.paymentPreparedAt) f.advance(QUOTE_TTL_MS);
    return result;
  };
  const result = await f.create('persist-deadline-1', { planId: 'member_365d', expectedPriceFen: 12900 });
  assert.equal(result.error.code, 'payment_price_changed');
  assert.equal(result.error.details.product.priceFen, 12900);
  assert.equal((await f.order('persist-deadline-1')).paymentPreparedAt, null);
  assert.equal((await f.order('persist-deadline-1')).status, 'cancelled');
});

test('an already-issued promotion remains at its original amount after the deadline and is never repriced or reissued', async () => {
  const f = await fixture(); f.state.now = new Date(Date.parse(PROMOTION_ENDS_AT) - 5000);
  ok(await f.create('issued-promo-001', { planId: 'member_30d' }));
  const original = await f.order('issued-promo-001');
  await f.repo.saveOrder({ ...original, quoteExpiresAt: PROMOTION_ENDS_AT,
    paymentSnapshot: { ...original.paymentSnapshot, version: 3, promotionEndsAt: PROMOTION_ENDS_AT } });
  f.advance(10000);
  const failedQuery = await f.create('issued-promo-001', { expectedPriceFen: 3000 });
  assert.equal(failedQuery.error.code, 'payment_check_pending');
  assert.equal(failedQuery.error.details, null, 'uncertain payment cannot produce a discard permission');
  f.setRemote('issued-promo-001', { order_fee: 1499, paid_fee: 0, left_fee: 0, status: 1 });
  const pending = ok(await f.create('issued-promo-001', { expectedPriceFen: 3000 }));
  assert.equal(pending.order.amountFen, 1499); assert.equal(pending.payment, null);
  f.setRemote('issued-promo-001', { order_fee: 1499, paid_fee: 1499, left_fee: 1499 });
  assert.equal(ok(await f.check('issued-promo-001')).membership.enhanced, true);
  assert.equal(f.calls.filter(x => x.path === '/sns/jscode2session').length, 1);
});

for (const [planId, amount, ongoing] of [['member_30d', 3000, 1499], ['member_365d', 36000, 12900]]) {
  test(`issued v3 ${amount}-fen standard receipt retains its original fee under ongoing pricing`, async () => {
    const f = await fixture(); f.state.now = new Date(PROMOTION_ENDS_AT);
    const id = `old-standard-${amount}`;
    ok(await f.create(id, { planId }));
    const original = await f.order(id);
    await f.repo.saveOrder({ ...original, amountFen: amount,
      paymentSnapshot: { ...original.paymentSnapshot, version: 3, priceFen: amount, goodsPrice: amount, promotionEndsAt: null } });
    f.advance(QUOTE_TTL_MS + 1);
    assert.equal(ok(await f.call('member.status')).products.find(p => p.planId === planId).priceFen, ongoing);
    f.setRemote(id, { order_fee: ongoing, paid_fee: ongoing, left_fee: ongoing });
    assert.equal((await f.check(id)).error.code, 'payment_evidence_mismatch');
    assert.equal((await f.user()).membership.expiresAt, null);
    f.setRemote(id, { order_fee: amount, paid_fee: amount, left_fee: amount });
    assert.equal(ok(await f.check(id)).membership.enhanced, true);
    assert.equal((await f.order(id)).amountFen, amount);
    assert.equal((await f.order(id)).status, 'fulfilled');
    assert.equal(f.calls.filter(x => x.path === '/sns/jscode2session').length, 1);
  });
}

test('historical v3 promotion bounds remain required after ongoing pricing is introduced', async () => {
  for (const invalid of ['missing_cutoff', 'extended_quote', 'late_creation']) {
    const f = await fixture(); f.state.now = new Date(Date.parse(PROMOTION_ENDS_AT) - 5000);
    const id = `old-cutoff-${invalid}`;
    ok(await f.create(id, { planId: 'member_30d' }));
    const original = await f.order(id);
    await f.repo.saveOrder({ ...original,
      createdAt: invalid === 'late_creation' ? PROMOTION_ENDS_AT : original.createdAt,
      quoteExpiresAt: invalid === 'extended_quote' || invalid === 'late_creation'
        ? new Date(Date.parse(PROMOTION_ENDS_AT) + 1000).toISOString() : PROMOTION_ENDS_AT,
      paymentSnapshot: { ...original.paymentSnapshot, version: 3,
        promotionEndsAt: invalid === 'missing_cutoff' ? null : PROMOTION_ENDS_AT } });
    f.setRemote(id, { order_fee: 1499, paid_fee: 1499, left_fee: 1499 });
    assert.equal((await f.check(id)).error.code, 'payment_evidence_mismatch');
    assert.equal((await f.user()).membership.expiresAt, null);
  }
});

for (const [planId, amount, days] of [['member_30d', 1990, 30], ['member_365d', 20000, 365]]) {
  test(`historical ${amount}-fen v2 receipts retain duration, enhanced limits and proportional refunds after promotion expiry`, async () => {
    const f = await fixture();
    const id = `historical-${days}-001`;
    ok(await f.create(id, { planId }));
    const original = await f.order(id);
    const { goodsPrice, activitySellingPrice, promotionEndsAt, ...snapshot } = original.paymentSnapshot;
    await f.repo.saveOrder({ ...original, amountFen: amount, quoteExpiresAt: null, paymentSnapshot: { ...snapshot, version: 2, priceFen: amount } });
    f.state.now = new Date(PROMOTION_ENDS_AT);
    f.setRemote(id, { order_fee: amount, paid_fee: amount, left_fee: amount });
    const paid = ok(await f.check(id));
    assert.equal(paid.membership.limits.maxFollows, planId === 'member_365d' ? 5 : 4);
    assert.equal(paid.membership.limits.maxStoresPerFollow, planId === 'member_365d' ? 5 : 4);
    assert.equal(paid.membership.expiresAt, new Date(f.state.now.getTime() + days * DAY).toISOString());
    f.setRemote(id, { order_fee: amount, paid_fee: amount, left_fee: amount / 2, status: 5 });
    assert.equal(ok(await f.check(id)).membership.expiresAt, new Date(f.state.now.getTime() + days * DAY / 2).toISOString());
    f.setRemote(id, { order_fee: amount, paid_fee: amount, left_fee: 0, status: 5 });
    assert.equal(ok(await f.check(id)).membership.active, false);
    assert.equal((await f.order(id)).amountFen, amount);
    assert.equal(classifyOrder(await f.order(id)).refundFen, amount);
  });
}

test('an unsigned historical quote cannot silently become the new price and can be discarded only after cancellation', async () => {
  const f = await fixture(); f.behavior.sessionFails = true;
  await f.create('legacy-unsigned-1', { planId: 'member_30d' });
  const original = await f.order('legacy-unsigned-1');
  const { goodsPrice, activitySellingPrice, promotionEndsAt, ...snapshot } = original.paymentSnapshot;
  await f.repo.saveOrder({ ...original, amountFen: 1990, quoteExpiresAt: null, paymentSnapshot: { ...snapshot, version: 2, priceFen: 1990 } });
  f.behavior.sessionFails = false;
  const result = await f.create('legacy-unsigned-1', { planId: 'member_30d', expectedPriceFen: 1499 });
  assert.equal(result.error.code, 'payment_price_changed'); assert.equal(result.error.details.canDiscardIntent, true);
  assert.equal((await f.order('legacy-unsigned-1')).amountFen, 1990);
  assert.equal((await f.order('legacy-unsigned-1')).status, 'cancelled');
  assert.equal(f.calls.filter(x => x.path === '/sns/jscode2session').length, 1);
});

test('provider cache keeps the ongoing charged price across the former cutoff', () => {
  let now = new Date(Date.parse(PROMOTION_ENDS_AT) - 1);
  const ctx = { config: mergeConfig({}), paymentEnv: env, clock: () => now };
  const before = paymentProviderFor(ctx, 'member_30d');
  assert.equal(before.getReadiness().priceFen, 1499);
  assert.equal(paymentProviderFor(ctx, 'member_30d'), before);
  now = new Date(PROMOTION_ENDS_AT);
  const after = paymentProviderFor(ctx, 'member_30d');
  assert.equal(after, before); assert.equal(after.getReadiness().priceFen, 1499);
  assert.equal(ctx._paymentProviders.size, 1);
});

test('tampered v4 charged price, discount, cutoff or quote cannot grant membership', async () => {
  for (const patch of [{ goodsPrice: 3000 }, { goodsPrice: 1498 }, { activitySellingPrice: 1 }, { promotionEndsAt: '2027-01-01T00:00:00.000Z' }]) {
    const f = await fixture(); ok(await f.create('bad-promotion-01', { planId: 'member_30d' }));
    const order = await f.order('bad-promotion-01');
    await f.repo.saveOrder({ ...order, paymentSnapshot: { ...order.paymentSnapshot, ...patch } });
    f.setRemote('bad-promotion-01', { order_fee: 1499, paid_fee: 1499, left_fee: 1499 });
    assert.equal((await f.check('bad-promotion-01')).error.code, 'payment_evidence_mismatch');
    assert.equal((await f.user()).membership.expiresAt, null);
  }
  const f = await fixture(); ok(await f.create('bad-quote-0001', { planId: 'member_365d' }));
  const order = await f.order('bad-quote-0001');
  await f.repo.saveOrder({ ...order, quoteExpiresAt: new Date(Date.parse(order.createdAt) + QUOTE_TTL_MS + 1).toISOString() });
  f.setRemote('bad-quote-0001', { order_fee: 12900, paid_fee: 12900, left_fee: 12900 });
  assert.equal((await f.check('bad-quote-0001')).error.code, 'payment_evidence_mismatch');
  assert.equal((await f.user()).membership.expiresAt, null);
});

test('promotion reconciliation rejects standard-fee or unknown discount evidence instead of inventing real cash', async () => {
  for (const patch of [{ order_fee: 3000 }, { paid_fee: 3000 }, { paid_fee: 1000 }, { left_fee: 3000 }]) {
    const f = await fixture(); ok(await f.create('fee-proof-001', { planId: 'member_30d' }));
    f.setRemote('fee-proof-001', { order_fee: 1499, paid_fee: 1499, left_fee: 1499, ...patch });
    assert.equal((await f.check('fee-proof-001')).ok, false);
    assert.equal((await f.user()).membership.expiresAt, null);
  }
});

test('new standard-goods runtime example is backwards-compatible and stays disabled until actual merchant mapping is confirmed', async () => {
  const f = await fixture();
  const patch = JSON.parse(fs.readFileSync(new URL('../config/member-plans-2.0.runtime-patch.example.json', import.meta.url), 'utf8'));
  ok(await f.call('admin.updateConfig', { patch }, operatorContext()));
  const products = ok(await f.call('member.status')).products;
  assert.equal(products[1].priceFen, 1499); assert.equal(products[1].standardPriceFen, 3000);
  assert.equal(products[2].priceFen, 12900); assert.equal(products[2].standardPriceFen, 36000);
  assert.equal(products[1].paymentReady, false); assert.equal(products[2].paymentReady, false);
  assert.equal(ok(await f.create('sample-disabled-01', { planId: 'member_30d' })).reason, 'payment_not_enabled');
  assert.equal(f.calls.length, 0);
});
