import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createPaymentController, paymentAvailability, purchaseNotice, DEFAULT_PURCHASE_NOTICE, STORAGE_PREFIX } = require('../miniprogram/utils/member-payment');
const product = { id: 'member_7d', title: '7 天会员', days: 7, priceFen: 700, enabled: true, paymentReady: true, iosEnabled: true };
const member = { active: true, expiresAt: '2026-12-30T00:00:00Z', remainingMs: 7 * 86400000 };
const free = { active: false, expiresAt: null, remainingMs: 0 };
const signed = { mode: 'short_series_goods', signData: '{ "goodsPrice":700,"buyQuantity":1 }', paySig: 'server-pay-signature', signature: 'server-user-signature' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('purchase notice is a non-refundable one-time virtual service and empty notes fall back to the default', () => {
  assert.match(DEFAULT_PURCHASE_NOTICE, /一次性虚拟服务/);
  assert.match(DEFAULT_PURCHASE_NOTICE, /一经售出不予退款/);
  assert.match(DEFAULT_PURCHASE_NOTICE, /一次购买 7 天/);
  assert.equal(purchaseNotice({ note: '  自定义购买须知  ' }), '自定义购买须知');
  assert.equal(purchaseNotice({ note: '   ' }), DEFAULT_PURCHASE_NOTICE);
  assert.equal(purchaseNotice({}), DEFAULT_PURCHASE_NOTICE);
});

function runtime({ storage = new Map(), handler, platform = 'android', supported = true, login, cashier, nextProduct = product, account = 'wx-app:account-a' } = {}) {
  const calls = [], logins = [], payments = [], resolved = [], updates = [], timers = new Map(); let sequence = 0, timerId = 0;
  const wx = {
    getDeviceInfo: () => ({ platform }), canIUse: () => supported,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    login: options => { logins.push(options); if (login) return login(options); options.success({ code: 'one-time-login-code' }); },
    requestVirtualPayment: options => { payments.push(options); if (cashier) return cashier(options); options.success({ errMsg: 'requestVirtualPayment:ok' }); },
  };
  const call = async (action, payload) => {
    calls.push({ action, payload: structuredClone(payload) });
    if (handler) return handler(action, payload);
    const order = { orderId: payload.orderId, status: action === 'member.createOrder' ? 'created' : 'paid', fulfilledAt: null, amountFen: 700, days: 7 };
    return action === 'member.createOrder' ? { ok: true, order, payment: signed } : { order, membership: free };
  };
  const controller = createPaymentController({ wx, call, onUpdate: patch => updates.push(patch), onResolved: value => resolved.push(value),
    makeId: () => `pay-test-order-${++sequence}`, setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  controller.sync({ userKey: account }, nextProduct);
  return { controller, calls, logins, payments, resolved, updates, timers, wx, storage,
    state: () => controller.getState(), async runTimer() { const [id, value] = timers.entries().next().value || []; if (!value) return false; timers.delete(id); value.fn(); await tick(); return true; } };
}

test('cashier success never grants membership; server signatures are passed byte-for-byte and only the order reference is stored', async () => {
  const rt = runtime(); await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.resolved.length, 0);
  assert.match(rt.state().paymentMessage, /确认中/);
  assert.equal(rt.calls[0].action, 'member.createOrder');
  assert.deepEqual(rt.calls[0].payload, { orderId: 'pay-test-order-1', loginCode: 'one-time-login-code' });
  for (const key of Object.keys(signed)) assert.equal(rt.payments[0][key], signed[key]);
  assert.deepEqual([...rt.storage.values()], [{ orderId: 'pay-test-order-1' }]);
  assert.equal(rt.logins.length, 1);
});

test('only a matching fulfilled order with fulfilment timestamp and valid active membership confirms activation', async () => {
  for (const [status, fulfilledAt, membership, confirms] of [
    ['paid', null, member, false], ['fulfilled', null, member, false], ['fulfilled', 'invalid', member, false],
    ['fulfilled', '2026-09-20T00:00:00Z', member, true], ['partially_refunded', '2026-09-20T00:00:00Z', member, true],
  ]) {
    const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
      ? { ok: true, order: { orderId: payload.orderId }, payment: signed }
      : { order: { orderId: payload.orderId, status, fulfilledAt }, membership } });
    await rt.controller.show(); await rt.controller.buy();
    assert.equal(rt.resolved.length, confirms ? 1 : 0);
    if (confirms) { assert.equal(rt.resolved[0].activated, true); assert.equal(rt.storage.size, 0); }
    else assert.equal(rt.storage.size, 1);
  }
});

test('double tap creates one order and cancellation retains it without claiming membership or reopening the cashier', async () => {
  let paymentOptions;
  const rt = runtime({ cashier: options => { paymentOptions = options; } });
  await rt.controller.show(); const first = rt.controller.buy(); await tick(); await rt.controller.buy();
  assert.equal(rt.payments.length, 1);
  paymentOptions.fail({ errMsg: 'requestVirtualPayment:fail cancel' }); await first;
  assert.equal(rt.resolved.length, 0); assert.equal(rt.logins.length, 1);
  assert.equal(rt.calls.filter(c => c.action === 'member.createOrder').length, 1);
  assert.equal(rt.state().paymentPendingId, 'pay-test-order-1');
  assert.match(rt.state().paymentMessage, /取消/);
  assert.equal(rt.state().paymentCanRetry, false); assert.equal(rt.state().paymentBusy, false);
  assert.match(rt.state().paymentMessage, /请查询订单状态/);
  assert.equal(rt.timers.size, 0);
});

test('after cancellation explicit retry checks first and reuses the same order identifier', async () => {
  let paymentCount = 0;
  const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
    ? { ok: true, order: { orderId: payload.orderId }, payment: signed }
    : { order: { orderId: payload.orderId, status: 'created' }, membership: free },
  cashier: options => ++paymentCount === 1 ? options.fail({ errMsg: 'cancel' }) : options.success({}) });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.state().paymentCanRetry, false);
  await rt.controller.check(); assert.equal(rt.state().paymentCanRetry, true);
  await rt.controller.buy();
  assert.deepEqual(rt.calls.filter(c => c.action === 'member.createOrder').map(c => c.payload.orderId), ['pay-test-order-1', 'pay-test-order-1']);
  assert.equal(rt.calls[1].action, 'member.checkOrder'); assert.equal(rt.payments.length, 2);
});

test('create-order timeout keeps its reference; unknown_order can only retry by explicit click with that same reference', async () => {
  let creates = 0;
  const rt = runtime({ handler: (action, payload) => {
    if (action === 'member.checkOrder') throw { code: 'unknown_order' };
    if (++creates === 1) throw { code: 'call_failed' };
    return { ok: true, order: { orderId: payload.orderId }, payment: signed };
  } });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.state().paymentPendingId, 'pay-test-order-1');
  await rt.controller.check(); assert.equal(rt.payments.length, 0); assert.equal(creates, 1);
  assert.equal(rt.state().paymentCanRetry, true);
  await rt.controller.buy();
  assert.equal(creates, 2); assert.equal(rt.payments.length, 1);
  assert.deepEqual(rt.calls.filter(c => c.action === 'member.createOrder').map(c => c.payload.orderId), ['pay-test-order-1', 'pay-test-order-1']);
});

test('closing and reopening restores the same account order and queries it without login or automatic payment', async () => {
  const first = runtime({ cashier: options => options.fail({ errMsg: 'cancel' }) });
  await first.controller.show(); await first.controller.buy(); first.controller.dispose();
  const next = runtime({ storage: first.storage }); await next.controller.show();
  assert.equal(next.calls.length, 1); assert.equal(next.calls[0].action, 'member.checkOrder');
  assert.equal(next.calls[0].payload.orderId, 'pay-test-order-1');
  assert.equal(next.logins.length, 0); assert.equal(next.payments.length, 0);
});

test('another account cannot restore or receive the first account pending order or late confirmation', async () => {
  const result = deferred();
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'account-a-order' }]]);
  const rt = runtime({ storage, handler: () => result.promise });
  const showing = rt.controller.show();
  rt.controller.sync({ userKey: 'wx-app:account-b' }, product);
  assert.equal(rt.state().paymentPendingId, '');
  result.resolve({ order: { orderId: 'account-a-order', status: 'fulfilled', fulfilledAt: '2026-09-20T00:00:00Z' }, membership: member });
  await showing;
  assert.equal(rt.resolved.length, 0); assert.equal(rt.state().paymentPendingId, '');
  assert.equal(storage.has(STORAGE_PREFIX + encodeURIComponent('wx-app:account-a')), true);
});

test('account changes between retry lookup and continuation never transfer a purchase intent to the new account', async () => {
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'account-a-order' }]]);
  const rt = runtime({ storage, handler: (action, payload) => ({ order: { orderId: payload.orderId, status: 'created' }, membership: free }) });
  let switched = false;
  rt.updates.push = function (patch) {
    Array.prototype.push.call(this, patch);
    if (!switched && !patch.paymentChecking && patch.paymentCanRetry) { switched = true; rt.controller.sync({ userKey: 'wx-app:account-b' }, product); }
  };
  await rt.controller.buy();
  assert.equal(rt.logins.length, 0); assert.equal(rt.payments.length, 0);
  assert.equal(rt.calls.filter(c => c.action === 'member.createOrder').length, 0);
  assert.equal(rt.state().paymentPendingId, '');
});

test('hide stops polling and ignores a late result; show resumes read-only checks with a finite retry budget', async () => {
  const pending = deferred(); let reads = 0;
  const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
    ? { ok: true, order: { orderId: payload.orderId }, payment: signed }
    : ++reads === 1 ? pending.promise : { order: { orderId: payload.orderId, status: 'paid' }, membership: free } });
  await rt.controller.show(); const buying = rt.controller.buy(); await tick();
  rt.controller.hide(); pending.resolve({ order: { orderId: 'pay-test-order-1', status: 'fulfilled', fulfilledAt: '2026-09-20T00:00:00Z' }, membership: member }); await buying;
  assert.equal(rt.resolved.length, 0); assert.equal(rt.timers.size, 0);
  await rt.controller.show();
  for (let i = 0; i < 10; i++) await rt.runTimer();
  assert.equal(reads, 5); assert.equal(rt.timers.size, 0);
  assert.equal(rt.payments.length, 1); assert.equal(rt.logins.length, 1);
});

test('old runtime and backend-disabled products remain unavailable while supported iOS is allowed', async () => {
  const ios = runtime({ platform: 'ios' }); assert.equal(paymentAvailability(product, ios.wx).ready, true);
  const modern = runtime({ supported: false }); modern.wx.getAppBaseInfo = () => ({ SDKVersion: '3.10.0' });
  assert.equal(paymentAvailability(product, modern.wx).ready, true);
  for (const options of [{ supported: false, platform: 'ios' }, { platform: 'devtools' }, { nextProduct: { ...product, paymentReady: false } }, { nextProduct: { ...product, enabled: false } }]) {
    const rt = runtime(options); await rt.controller.show(); await rt.controller.buy();
    assert.equal(rt.calls.length, 0); assert.equal(rt.logins.length, 0); assert.equal(rt.payments.length, 0);
    assert.match(rt.state().paymentError, /微信|未开放/);
  }
});

test('known old iOS or WeChat versions are blocked before order creation while unknown version data is not guessed', async () => {
  for (const [system, version, ready, hint] of [
    ['iOS 14.8', '8.0.68', false, /iOS 15/], ['iOS 15.0', '8.0.67', false, /8\.0\.68/],
    ['iOS 15.0', '8.0.68', true], ['iOS 18.5', '8.0.70', true], ['unknown', undefined, true],
  ]) {
    const rt = runtime({ platform: 'ios' });
    rt.wx.getDeviceInfo = () => ({ platform: 'ios', system });
    rt.wx.getAppBaseInfo = () => ({ SDKVersion: '3.10.0', version });
    const availability = paymentAvailability(product, rt.wx);
    assert.equal(availability.ready, ready);
    if (!ready) { assert.match(availability.reason, hint); await rt.controller.show(); await rt.controller.buy(); assert.equal(rt.calls.length, 0); }
  }
});

test('disposing during create-order response prevents a late payment window and keeps recovery for a new page', async () => {
  const order = deferred(); const rt = runtime({ handler: () => order.promise });
  await rt.controller.show(); const buying = rt.controller.buy(); await tick();
  rt.controller.dispose();
  order.resolve({ ok: true, order: { orderId: 'pay-test-order-1' }, payment: signed }); await buying;
  assert.equal(rt.payments.length, 0); assert.equal(rt.resolved.length, 0); assert.equal(rt.storage.size, 1);
});

test('already-paid create response with payment null checks the server without opening an empty cashier', async () => {
  const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
    ? { ok: true, order: { orderId: payload.orderId, status: 'paid' }, payment: null }
    : { order: { orderId: payload.orderId, status: 'fulfilled', fulfilledAt: '2026-09-20T00:00:00Z' }, membership: member } });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.payments.length, 0); assert.equal(rt.resolved[0].activated, true);
});

test('unknown lookup errors and mismatched orders cannot grant membership or silently start another payment', async () => {
  for (const failLookup of [() => { throw { code: 'payment_check_pending' }; }, () => ({ order: { orderId: 'some-other-order', status: 'fulfilled', fulfilledAt: '2026-09-20T00:00:00Z' }, membership: member })]) {
    const rt = runtime({ handler: (action, payload) => action === 'member.createOrder' ? { ok: true, order: { orderId: payload.orderId }, payment: signed } : failLookup() });
    await rt.controller.show(); await rt.controller.buy(); await rt.controller.buy();
    assert.equal(rt.resolved.length, 0); assert.equal(rt.payments.length, 1); assert.equal(rt.logins.length, 1);
    assert.equal(rt.state().paymentCanRetry, false); assert.match(rt.state().paymentError, /确认中|未确认/);
  }
});

test('provider accepted status zero or one prevents reopening the cashier even when local status remains created', async () => {
  for (const pendingFields of [{ paymentPending: true }, { providerStatus: 0 }, { providerStatus: 1 }]) {
    const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
      ? { ok: true, order: { orderId: payload.orderId }, payment: signed }
      : { order: { orderId: payload.orderId, status: 'created', ...pendingFields }, membership: free } });
    await rt.controller.show(); await rt.controller.buy(); await rt.controller.buy();
    assert.equal(rt.state().paymentCanRetry, false); assert.match(rt.state().paymentMessage, /确认中/);
    assert.equal(rt.payments.length, 1); assert.equal(rt.logins.length, 1);
  }
});

test('createOrder payment_pending response triggers read-only confirmation without a new signature request or cashier', async () => {
  const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
    ? { ok: false, reason: 'payment_pending', order: { orderId: payload.orderId }, payment: null }
    : { order: { orderId: payload.orderId, status: 'created', paymentPending: true, providerStatus: 1 }, membership: free } });
  await rt.controller.show(); await rt.controller.buy(); await rt.controller.buy();
  assert.equal(rt.payments.length, 0); assert.equal(rt.logins.length, 1); assert.equal(rt.state().paymentCanRetry, false);
  assert.match(rt.state().paymentMessage, /确认中/);
});

test('create response with a provider-pending or paid order never opens cashier even if signature fields are present', async () => {
  for (const fields of [{ status: 'created', paymentPending: true }, { status: 'created', providerStatus: 1 }, { status: 'paid' }]) {
    const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
      ? { ok: true, order: { orderId: payload.orderId, ...fields }, payment: signed }
      : { order: { orderId: payload.orderId, ...fields }, membership: free } });
    await rt.controller.show(); await rt.controller.buy();
    assert.equal(rt.payments.length, 0); assert.equal(rt.state().paymentCanRetry, false);
  }
});

test('storage failure prevents payment, and navigation during login prevents a late cashier launch', async () => {
  const rt = runtime(); rt.wx.setStorageSync = () => { throw Error('disk full'); };
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.logins.length, 0); assert.equal(rt.calls.length, 0); assert.match(rt.state().paymentError, /无法保存/);
  let options; const leaving = runtime({ login: value => { options = value; } });
  await leaving.controller.show(); const buying = leaving.controller.buy(); leaving.controller.hide(); options.success({ code: 'login-code' }); await buying;
  assert.equal(leaving.payments.length, 0); assert.equal(leaving.calls.length, 0);
  assert.equal(leaving.state().paymentPendingId, 'pay-test-order-1');
});

test('refunded or expired fulfilled orders are resolved without saying a new membership was activated', async () => {
  for (const status of ['refunded', 'fulfilled']) {
    const rt = runtime({ handler: (action, payload) => action === 'member.createOrder'
      ? { ok: true, order: { orderId: payload.orderId }, payment: null }
      : { order: { orderId: payload.orderId, status, fulfilledAt: '2026-09-20T00:00:00Z' }, membership: free } });
    await rt.controller.show(); await rt.controller.buy();
    assert.equal(rt.resolved[0].activated, false); assert.equal(rt.state().paymentPendingId, '');
    assert.doesNotMatch(rt.state().paymentMessage, /会员已开通/);
  }
});

test('account page applies server-confirmed membership, invalidates caches and retains the result when record refresh fails', async () => {
  let pageDefinition, pendingPayment;
  const invalidated = [], storage = new Map();
  const wx = { getDeviceInfo: () => ({ platform: 'ios' }), canIUse: () => true,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    login: o => o.success({ code: 'login' }), requestVirtualPayment: o => { pendingPayment = o; },
    showModal: o => o.success({ confirm: true, cancel: false }) };
  const call = async (action, payload) => {
    if (action === 'member.createOrder') return { ok: true, order: { orderId: payload.orderId }, payment: signed };
    if (action === 'member.checkOrder') return { order: { orderId: payload.orderId, status: 'fulfilled', fulfilledAt: '2026-09-20T00:00:00Z' }, membership: member };
    throw Error('offline');
  };
  const source = path.resolve('miniprogram/pages/mine/index.js');
  const store = { invalidateBootstrap: () => invalidated.push('bootstrap'), invalidateFollows: () => invalidated.push('follows'), publishQuota() {}, subscribeQuota: () => () => {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { wx, Page: value => { pageDefinition = value; },
    require: name => name.endsWith('/api') ? { call } : name.endsWith('/store') ? store : require(path.resolve(path.dirname(source), name)) });
  const page = { ...pageDefinition, data: structuredClone(pageDefinition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.applyBoot({ identity: { userKey: 'page-account' }, membership: free, memberProduct: product, collector: { state: 'not_deployed' }, quota: { tasksDoneToday: [] }, limits: { maxFollows: 3 }, tasks: [], followCount: 0 });
  page.data.ready = true; await page.paymentController.show();
  assert.equal(page.data.boot.paymentReady, true);
  assert.match(page.data.boot.purchaseNotice, /一经售出不予退款/);
  const buying = page.onBuyMembership(); await tick(); assert.equal(page.data.membership.active, false);
  pendingPayment.success({}); await buying;
  assert.equal(page.data.membership.expiresAt, member.expiresAt); assert.equal(page.data.membership.active, true);
  assert.deepEqual(invalidated, ['bootstrap', 'follows']); assert.match(page.data.ordersError, /加载失败/);
});

test('cancelling the purchase notice never creates an order or opens the cashier', async () => {
  let pageDefinition;
  const storage = new Map(), calls = [];
  const wx = { getDeviceInfo: () => ({ platform: 'android' }), canIUse: () => true,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    login: o => o.success({ code: 'login' }), requestVirtualPayment: () => { throw new Error('cashier must not open'); },
    showModal: o => o.success({ confirm: false, cancel: true }) };
  const source = path.resolve('miniprogram/pages/mine/index.js');
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { wx, Page: value => { pageDefinition = value; },
    require: name => name.endsWith('/api') ? { call: async (action, payload) => { calls.push({ action, payload }); throw new Error('unexpected'); } }
      : name.endsWith('/store') ? { invalidateBootstrap() {}, invalidateFollows() {}, publishQuota() {}, subscribeQuota: () => () => {} }
      : require(path.resolve(path.dirname(source), name)) });
  const page = { ...pageDefinition, data: structuredClone(pageDefinition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.applyBoot({ identity: { userKey: 'page-account' }, membership: free, memberProduct: product, collector: { state: 'not_deployed' }, quota: { tasksDoneToday: [] }, limits: { maxFollows: 3 }, tasks: [], followCount: 0 });
  page.data.ready = true;
  await page.onBuyMembership();
  assert.equal(calls.length, 0);
  assert.equal(storage.size, 0);
  assert.equal(page.data.paymentBusy, false);
  assert.equal(page.data.paymentPendingId, '');
});

test('an iPhone cashier failure explains the Apple ID requirement and the order can then be abandoned', async () => {
  let abandoned = false;
  const handler = async (action, payload) => {
    if (action === 'member.createOrder') return { ok: true, order: { orderId: payload.orderId, status: 'created' }, payment: signed };
    if (action === 'member.abandonOrder') { abandoned = true; return { order: { orderId: payload.orderId, status: 'created', abandoned: true }, membership: free }; }
    return { order: { orderId: payload.orderId, status: 'created', paymentPending: true, providerStatus: 1 }, membership: free };
  };
  const rt = runtime({ platform: 'ios', handler, cashier: options => options.fail({ errMsg: 'requestVirtualPayment:fail system error', errCode: -1 }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.match(rt.state().paymentError, /中国大陆地区的 Apple ID/);
  assert.match(rt.state().paymentError, /放弃这笔订单/);
  assert.equal(rt.state().paymentPendingId, 'pay-test-order-1');
  await rt.controller.abandon();
  assert.equal(abandoned, true);
  assert.equal(rt.state().paymentPendingId, '', 'purchase is unlocked again');
  assert.equal(rt.storage.size, 0);
  assert.match(rt.state().paymentMessage, /已放弃这笔订单，可以重新购买/);
});

test('abandoning a paid order activates membership instead, and a network failure keeps the order', async () => {
  const fulfilled = { status: 'fulfilled', fulfilledAt: '2026-09-20T00:00:00Z' };
  const paidRt = runtime({ handler: async (action, payload) => ({ order: { orderId: payload.orderId, ...fulfilled }, membership: member }) });
  paidRt.storage.set(STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'pay-existing-001' });
  paidRt.controller.sync({ userKey: 'wx-app:account-b' }, product); paidRt.controller.sync({ userKey: 'wx-app:account-a' }, product);
  await paidRt.controller.abandon();
  assert.equal(paidRt.resolved.length, 1); assert.equal(paidRt.state().paymentPendingId, '');
  assert.match(paidRt.state().paymentMessage, /已付款，会员已开通/);
  const offline = runtime({ handler: async () => { throw { code: 'call_failed' }; } });
  offline.storage.set(STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'pay-existing-002' });
  offline.controller.sync({ userKey: 'wx-app:account-b' }, product); offline.controller.sync({ userKey: 'wx-app:account-a' }, product);
  await offline.controller.abandon();
  assert.equal(offline.state().paymentPendingId, 'pay-existing-002');
  assert.match(offline.state().paymentError, /暂时无法放弃/);
});

test('a previously abandoned order found on another device is treated as closed', async () => {
  const rt = runtime({ handler: async (action, payload) => ({ order: { orderId: payload.orderId, status: 'created', abandoned: true }, membership: free }) });
  rt.storage.set(STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'pay-existing-003' });
  rt.controller.sync({ userKey: 'wx-app:account-b' }, product); rt.controller.sync({ userKey: 'wx-app:account-a' }, product);
  await rt.controller.show();
  assert.equal(rt.state().paymentPendingId, ''); assert.match(rt.state().paymentMessage, /已放弃，可重新购买/);
});
