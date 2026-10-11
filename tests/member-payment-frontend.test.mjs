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

function runtime({ storage = new Map(), handler, platform = 'android', supported = true, login, cashier, nextProduct = product, account = 'wx-app:account-a', onDiagnostic, onPriceChanged } = {}) {
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
    onDiagnostic, onPriceChanged,
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

test('monthly intent survives a lost response, restart and a changed selected plan', async () => {
  const monthly = { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1990 };
  const first = runtime({ nextProduct: monthly, handler: () => { throw { code: 'call_failed' }; } });
  await first.controller.show(); await first.controller.buy();
  assert.equal(first.calls[0].payload.planId, 'member_30d');
  assert.deepEqual([...first.storage.values()][0], { orderId: 'pay-test-order-1', planId: 'member_30d', expectedPriceFen: 1990 });
  first.controller.dispose();
  const next = runtime({ storage: first.storage, nextProduct: { ...product, id: 'member_365d', planId: 'member_365d', days: 365, priceFen: 20000 },
    handler: (action, payload) => {
      if (action === 'member.checkOrder') throw { code: 'unknown_order' };
      return { ok: true, order: { orderId: payload.orderId, planId: 'member_30d', days: 30, amountFen: 1990 }, payment: signed };
    }, cashier: options => options.fail({ errMsg: 'cancel' }) });
  await next.controller.show();
  assert.equal(next.payments.length, 0);
  await next.controller.buy();
  const retry = next.calls.find(item => item.action === 'member.createOrder');
  assert.equal(retry.payload.orderId, 'pay-test-order-1');
  assert.equal(retry.payload.planId, 'member_30d');
  assert.equal(retry.payload.expectedPriceFen, 1990);
  assert.equal(next.state().paymentPendingPlanId, 'member_30d');
  assert.equal(next.state().paymentOrderSummary, '30 天会员 · ¥19.90');
});

test('checked original order overrides a restored plan hint before reopening the cashier', async () => {
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'original-plan-order', planId: 'member_365d' }]]);
  const rt = runtime({ storage, handler: (action, payload) => {
    const order = { orderId: payload.orderId, planId: 'member_30d', status: 'created', days: 30, amountFen: 1990 };
    return action === 'member.createOrder' ? { ok: true, order, payment: signed } : { order, membership: free };
  }, cashier: options => options.fail({ errMsg: 'cancel' }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.calls.find(item => item.action === 'member.createOrder').payload.planId, 'member_30d');
  assert.equal(rt.state().paymentPendingPlanId, 'member_30d');
});

test('annual intent uses 365 days in fallback purchase notice and never stores credentials', async () => {
  const annual = { ...product, id: 'member_365d', planId: 'member_365d', days: 365, priceFen: 20000 };
  assert.match(purchaseNotice(annual), /一次购买 365 天/);
  const rt = runtime({ nextProduct: annual, handler: (action, payload) => ({ ok: true,
    order: { orderId: payload.orderId, planId: 'member_365d', days: 365, amountFen: 20000, status: 'created' }, payment: signed }),
    cashier: options => options.fail({ errMsg: 'cancel' }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.calls[0].payload.planId, 'member_365d');
  assert.equal(rt.calls[0].payload.expectedPriceFen, 20000);
  assert.equal(rt.payments.length, 1);
  assert.deepEqual(Object.keys([...rt.storage.values()][0]).sort(), ['expectedPriceFen', 'orderId', 'planId']);
});

test('a safely cancelled changed quote clears only that intent and needs another explicit buy at the new price', async () => {
  const monthly = { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499 };
  const current = { ...monthly, priceFen: 3000 };
  let creates = 0, refreshes = 0;
  const rt = runtime({ nextProduct: monthly,
    onPriceChanged: value => { refreshes++; assert.equal(value.priceFen, 3000); rt.controller.sync({ userKey: 'wx-app:account-a' }, value); },
    handler: (action, payload) => {
      assert.equal(action, 'member.createOrder');
      if (++creates === 1) throw { code: 'payment_price_changed', details: { product: current, orderId: payload.orderId, canDiscardIntent: true, reason: 'quote_expired' } };
      return { ok: true, order: { orderId: payload.orderId, planId: 'member_30d', days: 30, amountFen: 3000, status: 'created' }, payment: signed };
    }, cashier: options => options.fail({ errMsg: 'cancel' }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(refreshes, 1); assert.equal(creates, 1); assert.equal(rt.payments.length, 0);
  assert.equal(rt.storage.size, 0); assert.equal(rt.state().paymentPendingId, '');
  assert.match(rt.state().paymentError, /未发起付款.*重新确认/);
  await rt.controller.show(); assert.equal(creates, 1, 'returning to the page cannot purchase automatically');
  await rt.controller.buy();
  assert.equal(rt.payments.length, 1);
  assert.deepEqual(rt.calls.map(value => value.payload.expectedPriceFen), [1499, 3000]);
  assert.notEqual(rt.calls[0].payload.orderId, rt.calls[1].payload.orderId);
});

test('price-change errors without matching cancellation evidence retain the recoverable original intent', async () => {
  for (const details of [{}, { canDiscardIntent: false, orderId: 'pay-test-order-1' }, { canDiscardIntent: true, orderId: 'another-order' }]) {
    let refreshes = 0;
    const rt = runtime({ nextProduct: { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499 },
      onPriceChanged: () => refreshes++, handler: () => { throw { code: 'payment_price_changed', details }; } });
    await rt.controller.show(); await rt.controller.buy();
    assert.equal(rt.storage.size, 1); assert.equal(rt.state().paymentPendingId, 'pay-test-order-1');
    assert.equal(rt.payments.length, 0); assert.equal(refreshes, 0); assert.equal(rt.calls.length, 1);
  }
});

test('a prepared historical monthly order remains at its original amount and can only reconcile after the price changes', async () => {
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'),
    { orderId: 'historical-monthly-order', planId: 'member_30d', expectedPriceFen: 1990 }]]);
  const rt = runtime({ storage, nextProduct: { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499 },
    handler: (action, payload) => {
      const order = { orderId: payload.orderId, planId: 'member_30d', days: 30, amountFen: 1990, status: 'created', paymentPreparedAt: '2026-10-01T00:00:00Z' };
      return action === 'member.createOrder' ? { ok: true, order, payment: null } : { order, membership: free };
    } });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.calls.find(value => value.action === 'member.createOrder').payload.expectedPriceFen, 1990);
  assert.equal(rt.payments.length, 0); assert.equal(rt.storage.size, 1);
  assert.equal(rt.state().paymentOrderSummary, '30 天会员 · ¥19.90');
});

test('an old unknown monthly intent never borrows the current offer price as previous consent', async () => {
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'legacy-monthly-order', planId: 'member_30d' }]]);
  const rt = runtime({ storage, nextProduct: { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499 },
    handler: (action, payload) => {
      if (action === 'member.checkOrder') throw { code: 'unknown_order' };
      assert.equal(Object.hasOwn(payload, 'expectedPriceFen'), false);
      throw { code: 'payment_price_changed', details: { orderId: payload.orderId, canDiscardIntent: true, reason: 'confirmation_required' } };
    } });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.payments.length, 0); assert.equal(rt.storage.size, 0);
  assert.match(rt.state().paymentError, /重新确认/);
});

test('a lookup that first discovers an original amount requires another explicit confirmation before login', async () => {
  let reads = 0;
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'unknown-amount-order', planId: 'member_30d' }]]);
  const rt = runtime({ storage, nextProduct: { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499 },
    handler: () => {
      if (++reads === 1) throw { code: 'call_failed' };
      return { order: { orderId: 'unknown-amount-order', planId: 'member_30d', days: 30, amountFen: 1990, status: 'created' }, membership: free };
    } });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.logins.length, 0); assert.equal(rt.payments.length, 0);
  assert.equal(rt.state().paymentOrderSummary, '30 天会员 · ¥19.90');
  assert.match(rt.state().paymentMessage, /重新确认/);
});

test('a create response with a different amount never opens the cashier under the earlier quote', async () => {
  const rt = runtime({ nextProduct: { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499 },
    handler: (action, payload) => ({ ok: true, order: { orderId: payload.orderId, planId: 'member_30d', days: 30, amountFen: 3000, status: 'created' }, payment: signed }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.payments.length, 0); assert.equal(rt.storage.size, 1);
  assert.equal(rt.state().paymentOrderSummary, '30 天会员 · ¥30.00');
  assert.match(rt.state().paymentMessage, /金额不同.*重新确认/);
});

test('a late price-change response from account A cannot refresh B or clear either account intent', async () => {
  const result = deferred(); let refreshes = 0;
  const monthly = { ...product, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499 };
  const rt = runtime({ nextProduct: monthly, handler: () => result.promise, onPriceChanged: () => refreshes++ });
  await rt.controller.show(); const buying = rt.controller.buy(); await tick();
  rt.storage.set(STORAGE_PREFIX + encodeURIComponent('wx-app:account-b'), { orderId: 'account-b-existing', planId: 'member_30d', expectedPriceFen: 3000 });
  rt.controller.sync({ userKey: 'wx-app:account-b' }, { ...monthly, priceFen: 3000 });
  result.reject({ code: 'payment_price_changed', details: { product: { ...monthly, priceFen: 3000 }, orderId: 'pay-test-order-1', canDiscardIntent: true } });
  await buying;
  assert.equal(refreshes, 0); assert.equal(rt.storage.size, 2); assert.equal(rt.payments.length, 0);
  assert.equal(rt.state().paymentPendingId, 'account-b-existing');
});

test('a plan corrected by the retry lookup requires a fresh explicit purchase confirmation', async () => {
  let lookups = 0;
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'corrected-plan-order', planId: 'member_365d' }]]);
  const rt = runtime({ storage, handler: (action, payload) => {
    if (action === 'member.checkOrder' && ++lookups === 1) throw { code: 'call_failed' };
    const order = { orderId: payload.orderId, planId: 'member_30d', status: 'created', days: 30, amountFen: 1990 };
    return action === 'member.createOrder' ? { ok: true, order, payment: signed } : { order, membership: free };
  }, cashier: options => options.fail({ errMsg: 'cancel' }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.payments.length, 0);
  assert.equal(rt.logins.length, 0);
  assert.match(rt.state().paymentMessage, /重新确认/);
  assert.equal(rt.state().paymentOrderSummary, '30 天会员 · ¥19.90');
  await rt.controller.buy();
  assert.equal(rt.payments.length, 1);
  assert.equal(rt.calls.find(item => item.action === 'member.createOrder').payload.planId, 'member_30d');
});

test('a create response that first reveals another original plan cannot open that cashier without reconfirming', async () => {
  const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'corrected-create-order', planId: 'member_30d' }]]);
  const rt = runtime({ storage, handler: (action, payload) => {
    if (action === 'member.checkOrder') throw { code: 'unknown_order' };
    return { ok: true, order: { orderId: payload.orderId, planId: 'member_365d', status: 'created', days: 365, amountFen: 20000 }, payment: signed };
  } });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.payments.length, 0);
  assert.equal(rt.state().paymentPendingPlanId, 'member_365d');
  assert.equal(rt.state().paymentOrderSummary, '365 天会员 · ¥200.00');
  assert.equal(rt.state().paymentCanRetry, true);
  assert.match(rt.state().paymentMessage, /重新确认/);
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

test('availability exposes stable factual blocking codes and sanitized device capabilities', () => {
  const android = { getDeviceInfo: () => ({ platform: 'android', system: 'Android 16', model: 'private-model' }),
    getAppBaseInfo: () => ({ version: '8.0.70', SDKVersion: '3.10.3' }), requestVirtualPayment() {} };
  const ios = { ...android, getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 18' }) };
  for (const [selected, api, code] of [
    [{ ...product, enabled: false }, android, 'payment_not_enabled'],
    [{ ...product, paymentReady: false }, android, 'payment_server_not_ready'],
    [{ ...product, paymentReady: false, paymentReason: 'payment_product_id_missing' }, android, 'payment_product_id_missing'],
    [{ ...product, paymentReady: false, paymentReason: 'payment_plan_disabled' }, android, 'payment_plan_disabled'],
    [product, { ...android, getDeviceInfo: () => ({ platform: 'devtools' }) }, 'payment_devtools'],
    [{ ...product, iosEnabled: false }, ios, 'payment_ios_disabled'],
    [product, { ...ios, getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 14.8' }) }, 'payment_ios_version_low'],
    [product, { ...ios, getAppBaseInfo: () => ({ version: '8.0.67' }) }, 'payment_wechat_version_low'],
    [product, { ...android, requestVirtualPayment: undefined }, 'payment_api_unavailable'],
    [product, { ...android, getDeviceInfo: () => { throw Error('private raw data'); } }, 'payment_capability_unknown'],
  ]) {
    const result = paymentAvailability(selected, api); assert.equal(result.ready, false); assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /private-model|private raw data|Apple ID/);
  }
  const ready = paymentAvailability(product, android);
  assert.deepEqual(ready.capabilities, { platform: 'android', clientVersion: '8.0.70', sdkVersion: '3.10.3', apiAvailable: true, systemVersion: '16' });
  assert.equal(ready.ready, true);
});

test('cashier diagnostics carry no raw credentials and telemetry failure cannot interrupt a payment', async () => {
  const events = [];
  const rt = runtime({ onDiagnostic: (name, fields) => events.push({ name, fields }),
    cashier: options => options.fail({ errMsg: 'network not available; secret-token', errCode: -999 }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.deepEqual(events.map(item => item.name), ['cashier_invoked', 'cashier_result']);
  assert.equal(events[1].fields.result, 'unknown'); assert.equal(events[1].fields.reasonCode, 'cashier_result_unknown');
  assert.doesNotMatch(JSON.stringify(events), /secret|signData|login|orderId/);
  const noisy = runtime({ onDiagnostic: () => { throw Error('analytics offline'); } });
  await noisy.controller.show(); await noisy.controller.buy();
  assert.equal(noisy.payments.length, 1); assert.equal(noisy.resolved.length, 0, 'cashier success is not entitlement evidence');
});

test('preflight blocked diagnostics occur without persisting an order or starting login', async () => {
  const events = [];
  const rt = runtime({ nextProduct: { ...product, paymentReady: false }, onDiagnostic: (name, fields) => events.push({ name, fields }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.equal(rt.storage.size, 0); assert.equal(rt.logins.length, 0); assert.equal(rt.calls.length, 0);
  assert.deepEqual(events, [{ name: 'checkout_blocked', fields: { planId: 'member_7d', reasonCode: 'payment_server_not_ready', result: 'blocked' } }]);
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

test('purchase confirmation cannot move to another account, hidden page or a replacement order', async () => {
  for (const change of ['account', 'hide', 'order']) {
    let definition, modal;
    const calls = [];
    const wx = { getDeviceInfo: () => ({ platform: 'android' }), requestVirtualPayment() {}, canIUse: () => true,
      getStorageSync() {}, showModal: options => { modal = options; } };
    const source = path.resolve('miniprogram/pages/mine/index.js');
    vm.runInNewContext(fs.readFileSync(source, 'utf8'), { wx, Page: value => { definition = value; },
      require: name => name.endsWith('/api') ? { call: async (...args) => calls.push(args) }
        : name.endsWith('/store') ? { invalidateBootstrap() {}, invalidateFollows() {}, publishQuota() {}, subscribeQuota: () => () => {} }
        : require(path.resolve(path.dirname(source), name)) });
    const page = { ...definition, pageVisible: true, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
    const boot = { identity: { userKey: 'account-a' }, membership: free, memberProduct: product, collector: { state: 'not_deployed' }, quota: { tasksDoneToday: [] }, limits: {}, tasks: [], followCount: 0 };
    page.applyBoot(boot); page.data.ready = true;
    const purchase = page.onBuyMembership();
    if (change === 'account') { page.applyBoot({ ...boot, identity: { userKey: 'account-b' } }); page.applyBoot(boot); }
    if (change === 'hide') page.onHide();
    if (change === 'order') page.data.paymentPendingId = 'another-order-id';
    modal.success({ confirm: true }); await purchase;
    assert.equal(calls.length, 0, change);
    assert.equal(page.data.paymentBusy, false, change);
  }
});

test('an unknown iPhone cashier failure retains the original order without inventing an Apple ID cause', async () => {
  let abandoned = false;
  const handler = async (action, payload) => {
    if (action === 'member.createOrder') return { ok: true, order: { orderId: payload.orderId, status: 'created' }, payment: signed };
    if (action === 'member.abandonOrder') { abandoned = true; return { order: { orderId: payload.orderId, status: 'created', abandoned: true }, membership: free }; }
    return { order: { orderId: payload.orderId, status: 'created', paymentPending: true, providerStatus: 1 }, membership: free };
  };
  const rt = runtime({ platform: 'ios', handler, cashier: options => options.fail({ errMsg: 'requestVirtualPayment:fail system error', errCode: -1 }) });
  await rt.controller.show(); await rt.controller.buy();
  assert.doesNotMatch(rt.state().paymentError, /Apple ID|中国大陆|地区/);
  assert.match(rt.state().paymentError, /尚未确认.*原订单/);
  assert.equal(rt.state().paymentDiagnosticCode, 'cashier_result_unknown');
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
  assert.match(offline.state().paymentError, /暂时无法确认.*订单号已保留/);
});

test('a previously abandoned order found on another device is treated as closed', async () => {
  const rt = runtime({ handler: async (action, payload) => ({ order: { orderId: payload.orderId, status: 'created', abandoned: true }, membership: free }) });
  rt.storage.set(STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'pay-existing-003' });
  rt.controller.sync({ userKey: 'wx-app:account-b' }, product); rt.controller.sync({ userKey: 'wx-app:account-a' }, product);
  await rt.controller.show();
  assert.equal(rt.state().paymentPendingId, ''); assert.match(rt.state().paymentMessage, /已放弃，可重新购买/);
});

test('abandon retains recovery for unresolved or malformed server results', async () => {
  for (const fields of [{ status: 'created' }, { status: 'created', paymentPending: true }, { status: 'unknown' }, { status: 'fulfilled' }]) {
    const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'pending-abandon-order' }]]);
    const rt = runtime({ storage, handler: (action, payload) => ({ order: { orderId: payload.orderId, ...fields }, membership: free }) });
    await rt.controller.abandon();
    assert.equal(rt.state().paymentPendingId, 'pending-abandon-order', fields.status);
    assert.equal(storage.size, 1, fields.status);
    assert.equal(rt.resolved.length, 0, fields.status);
    assert.doesNotMatch(rt.state().paymentMessage, /已放弃|会员已开通/);
  }
});

test('abandon handles confirmed refunds and expired fulfilment without claiming new activation', async () => {
  for (const status of ['refunded', 'fulfilled']) {
    const storage = new Map([[STORAGE_PREFIX + encodeURIComponent('wx-app:account-a'), { orderId: 'terminal-abandon-order' }]]);
    const rt = runtime({ storage, handler: (action, payload) => ({ order: { orderId: payload.orderId, status, fulfilledAt: '2026-09-20T00:00:00Z' }, membership: free }) });
    await rt.controller.abandon();
    assert.equal(rt.state().paymentPendingId, '');
    assert.doesNotMatch(rt.state().paymentMessage, /会员已开通|已放弃/);
    assert.equal(rt.resolved.length, 1);
    assert.equal(rt.resolved[0].activated, false);
  }
});

test('login failure can cancel its uncreated intent and then buy a different plan with a new identifier', async () => {
  let logins = 0;
  const rt = runtime({ login: options => ++logins === 1 ? options.fail({}) : options.success({ code: 'fresh-login' }),
    handler: (action, payload) => action === 'member.abandonOrder'
      ? { order: { orderId: payload.orderId, status: 'cancelled', type: 'membership_cancelled_intent', amountFen: 0, days: 0 }, membership: free }
      : { ok: true, order: { orderId: payload.orderId, planId: 'member_365d', days: 365, amountFen: 20000, status: 'created' }, payment: signed },
    cashier: options => options.fail({ errMsg: 'cancel' }) });
  await rt.controller.show(); await rt.controller.buy();
  const cancelledId = rt.state().paymentPendingId;
  assert.equal(rt.calls.length, 0);
  assert.ok(cancelledId);
  await rt.controller.abandon();
  assert.equal(rt.state().paymentPendingId, '');
  assert.equal(rt.state().paymentOrderSummary, '');
  assert.equal(rt.storage.size, 0);
  rt.controller.sync({ userKey: 'wx-app:account-a' }, { ...product, id: 'member_365d', planId: 'member_365d', days: 365, priceFen: 20000 });
  await rt.controller.buy();
  const created = rt.calls.find(call => call.action === 'member.createOrder');
  assert.notEqual(created.payload.orderId, cancelledId);
  assert.equal(created.payload.planId, 'member_365d');
  assert.equal(rt.payments.length, 1);
});
