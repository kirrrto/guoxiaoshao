import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createFixture, userContext, userKeyOf, operatorContext } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { orderKey, paymentProviderFor } = require('../cloudfunctions/gxs_api/lib/payment/service');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const APPID = 'wxe96ad9e77b602f1b';
const OPENID = 'oUSER000000000000000000001';
const DAY = 86400000;
const env = { GXS_CONSUMER_APPID: APPID, GXS_CONSUMER_APPSECRET: 'fake-secret', GXS_VIRTUAL_PAYMENT_APPKEY: 'fake-appkey',
  GXS_PAYMENT_CALLBACK_TOKEN: 'TestCallbackToken', GXS_PAYMENT_CALLBACK_AES_KEY: Buffer.alloc(32, 5).toString('base64').slice(0, -1) };
const json = data => new Response(JSON.stringify(data), { status: 200 });
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };

async function fixture({ enabled = true } = {}) {
  const f = createFixture({ config: { memberProduct: { enabled } } });
  const calls = [], remote = new Map();
  const behavior = { ackFails: false, sessionOpenid: OPENID, sessionFails: false };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, body });
    if (parsed.pathname === '/sns/jscode2session') return json(behavior.sessionFails ? { errcode: 40029, errmsg: 'invalid code' } : { openid: behavior.sessionOpenid, session_key: '9hAb/NEYUlkaMBEsmFgzig==' });
    if (parsed.pathname === '/cgi-bin/stable_token') return json({ access_token: 'fake-token', expires_in: 7200 });
    if (parsed.pathname === '/xpay/query_order') {
      const value = remote.get(body.order_id);
      return json(value || { errcode: -1, errmsg: 'do not interpret this as order not found' });
    }
    if (parsed.pathname === '/xpay/notify_provide_goods') return behavior.ackFails ? json({ errcode: -1, errmsg: 'temporary' }) : new Response('');
    throw Error('unexpected business network endpoint');
  };
  const handler = createHandler({ repo: f.repo, fetchImpl, clock: () => f.state.now, paymentEnv: env, log: { error: (...args) => { f.logs.push(args); } } });
  const call = (action, payload = {}, identity = userContext()) => handler({ action, payload }, identity);
  ok(await call('user.bootstrap'));
  function setRemote(id, patch = {}) {
    const platformId = orderKey(userKeyOf(), id);
    const data = { errcode: 0, order: { order_id: platformId, env_type: 1, status: 2, order_type: 0,
      order_fee: 700, paid_fee: 700, left_fee: 700, wx_order_id: `wx-${id}`, paid_time: 1790000000, ...patch } };
    remote.set(platformId, data); return data;
  }
  const create = (id = 'purchase-0001', payload = {}) => call('member.createOrder', { orderId: id, loginCode: 'fresh-code', ...payload });
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
