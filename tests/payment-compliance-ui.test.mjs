import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const {
  paymentAvailability, deviceCashierCapability, planPurchasable, purchaseGate, platformPaymentSuspended,
  createPaymentController,
} = require('../miniprogram/utils/member-payment');
const { choosePurchasablePlan, purchasableProducts } = require('../miniprogram/utils/member-products');

const androidApi = {
  getDeviceInfo: () => ({ platform: 'android', system: 'Android 14' }),
  getAppBaseInfo: () => ({ version: '8.0.70', SDKVersion: '3.10.3' }),
  requestVirtualPayment() {},
  canIUse: () => true,
};
const readyPlan = {
  id: 'member_7d', planId: 'member_7d', title: '7 天会员', days: 7, priceFen: 700,
  productId: 'vip666', enabled: true, paymentReady: true, iosEnabled: true,
};
const monthPlan = { ...readyPlan, id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1499, productId: 'vip777' };
const yearPlan = { ...readyPlan, id: 'member_365d', planId: 'member_365d', days: 365, priceFen: 12900, productId: 'vip888' };

function pageRuntime(handler = async () => ({}), wxPatch = {}) {
  const rt = runtime(handler);
  Object.assign(rt.wx, androidApi, wxPatch);
  const page = rt.instance('pages/mine/index.js');
  return { rt, page };
}

function bootWith(products, extra = {}) {
  return {
    identity: { userKey: 'compliance-account' },
    memberProducts: products,
    memberProduct: products[0],
    membership: { active: false, expiresAt: null, remainingMs: 0 },
    quota: { balance: 1, tasksDoneToday: [] },
    collector: { state: 'not_deployed' },
    limits: {},
    tasks: [],
    followCount: 0,
    features: {},
    ...extra,
  };
}

test('purchaseGate lists only purchasable plans and reports the neutral copy when none remain', () => {
  const mixed = [readyPlan, { ...monthPlan, enabled: false, paymentReady: false, paymentReason: 'payment_plan_disabled' }, yearPlan];
  const gate = purchaseGate(mixed, androidApi);
  assert.equal(gate.showShop, true);
  assert.deepEqual(gate.purchasable.map(p => p.planId), ['member_7d', 'member_365d']);
  assert.equal(gate.blockedCount, 1);

  const blocked = purchaseGate(mixed.map(p => ({ ...p, enabled: false, paymentReady: false, paymentReason: 'payment_not_enabled' })), androidApi);
  assert.equal(blocked.showShop, false);
  assert.equal(blocked.purchasable.length, 0);
  assert.equal(blocked.reason, '会员购买暂不可用，现有会员权益不受影响。');
});

test('API existence alone is never treated as merchant payment readiness', () => {
  const canIUseOnly = {
    getDeviceInfo: () => ({ platform: 'android' }),
    getAppBaseInfo: () => ({ SDKVersion: '3.10.3' }),
    canIUse: () => true,
    // requestVirtualPayment intentionally missing
  };
  assert.equal(deviceCashierCapability(canIUseOnly).ready, false);
  assert.equal(paymentAvailability({ ...readyPlan }, canIUseOnly).ready, false);
  assert.equal(planPurchasable({ ...readyPlan, paymentReady: false, paymentReason: 'payment_not_enabled' }, androidApi), false);
});

test('platform suspension blocks every cashier path including a pending-order retry', async () => {
  const suspended = { ...readyPlan, enabled: false, paymentReady: false, paymentReason: 'payment_not_enabled' };
  assert.equal(platformPaymentSuspended(suspended), true);
  assert.equal(paymentAvailability(suspended, androidApi, { mode: 'continue' }).ready, false);
  assert.equal(paymentAvailability(suspended, androidApi, { mode: 'purchase' }).ready, false);

  const storage = new Map();
  storage.set('gxs_member_payment_v1:compliance-account', { orderId: 'pay-existing-order-1', planId: 'member_7d' });
  const payments = [], calls = [];
  const wx = { ...androidApi,
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    login: options => options.success({ code: 'login-code' }),
    requestVirtualPayment: options => { payments.push(options); options.success({}); },
  };
  const controller = createPaymentController({
    wx,
    onUpdate: () => {},
    onResolved: () => {},
    call: async (action, payload) => {
      calls.push(action);
      return action === 'member.checkOrder'
        ? { order: { orderId: payload.orderId, status: 'created', amountFen: 700, days: 7 }, membership: { active: false, expiresAt: null, remainingMs: 0 } }
        : { ok: true, order: { orderId: payload.orderId, status: 'created' }, payment: { mode: 'short_series_goods', signData: 's', paySig: 'p', signature: 'u' } };
    },
  });
  controller.sync({ userKey: 'compliance-account' }, suspended);
  await controller.show();
  assert.equal(calls.includes('member.checkOrder'), true, 'order lookup stays available');
  await controller.buy();
  assert.equal(payments.length, 0, 'cashier must not open under platform suspension');
  assert.equal(calls.includes('member.createOrder'), false);
});

test('plan-level disable hides that SKU but does not invent readiness for a pending-order cashier', () => {
  const planBlocked = { ...monthPlan, enabled: false, paymentReady: false, paymentReason: 'payment_plan_disabled' };
  assert.equal(platformPaymentSuspended(planBlocked), false);
  assert.equal(paymentAvailability(planBlocked, androidApi, { mode: 'purchase' }).ready, false);
  assert.equal(paymentAvailability(planBlocked, androidApi, { mode: 'continue' }).ready, true,
    'existing order keeps frozen terms; only platform suspension stops the cashier');
});

test('choosePurchasablePlan never auto-switches a pending order and prefers a live purchasable plan otherwise', () => {
  const mixed = [
    { ...readyPlan, available: false },
    { ...monthPlan, available: true },
    { ...yearPlan, available: true },
  ];
  assert.equal(choosePurchasablePlan(mixed, 'member_7d', { hasPendingOrder: true, isPurchasable: p => p.available }).planId, 'member_7d');
  assert.equal(choosePurchasablePlan(mixed, 'member_7d', { hasPendingOrder: false, isPurchasable: p => p.available }).planId, 'member_30d');
  assert.equal(choosePurchasablePlan(mixed, 'member_365d', { hasPendingOrder: false, isPurchasable: p => p.available }).planId, 'member_365d');
  assert.deepEqual(purchasableProducts(mixed, p => p.available).map(p => p.planId), ['member_30d', 'member_365d']);
});

test('payment-unavailable page hides every purchase entry and keeps membership benefits and records', () => {
  const { page } = pageRuntime();
  const blocked = [readyPlan, monthPlan, yearPlan].map(p => ({ ...p, enabled: false, paymentReady: false, paymentReason: 'payment_not_enabled' }));
  page.applyBoot(bootWith(blocked, {
    membership: { active: true, expiresAt: '2026-12-01T00:00:00.000Z', remainingMs: 30 * 86400000 },
    limits: { maxFollows: 3, maxStoresPerFollow: 3 },
  }));
  assert.equal(page.data.showPurchaseShop, false);
  assert.equal(page.data.displayMemberProducts.length, 0);
  assert.equal(page.data.purchaseUnavailableNote, '会员购买暂不可用，现有会员权益不受影响。');
  assert.equal(page.data.membershipUpgradeOpen, false);
  assert.equal(page.data.boot.paymentReady, false);
  assert.equal(page.data.membership.active, true, 'existing membership stays visible');
  assert.ok(Array.isArray(page.data.membershipBenefitPlans));
  page.onOpenMembershipRenew();
  assert.equal(page.data.membershipUpgradeOpen, false);
  page.onOpenMembershipUpgrade();
  assert.equal(page.data.membershipUpgradeOpen, false);
});

test('partial availability shows only purchasable plans and keeps the rest out of the shop', () => {
  const { page } = pageRuntime();
  const products = [
    readyPlan,
    { ...monthPlan, enabled: false, paymentReady: false, paymentReason: 'payment_plan_disabled' },
    yearPlan,
  ];
  page.applyBoot(bootWith(products));
  assert.equal(page.data.showPurchaseShop, true);
  assert.deepEqual(page.data.displayMemberProducts.map(p => p.planId), ['member_7d', 'member_365d']);
  assert.equal(page.data.selectedPlanId, 'member_7d');
  assert.equal(page.data.boot.paymentReady, true);
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_30d' } } });
  assert.equal(page.data.selectedPlanId, 'member_7d', 'blocked plan is not selectable');
});

test('available plans still reach the official virtual payment controller after consent', async () => {
  let bought = 0;
  const { rt, page } = pageRuntime();
  page.applyBoot(bootWith([readyPlan]));
  page.setData({ ready: true });
  assert.equal(page.data.showPurchaseShop, true);
  assert.equal(page.data.boot.paymentReady, true);
  rt.wx.showModal = options => options.success({ confirm: true });
  page.paymentController = { buy: async () => { bought++; }, sync() {}, show() {}, hide() {}, check: async () => {}, abandon: async () => {}, dispose() {}, getState: () => ({}) };
  await page.onBuyMembership();
  assert.equal(bought, 1);
});

test('devtools and missing cashier API stay blocked even when the product is enabled', () => {
  const devtools = { ...androidApi, getDeviceInfo: () => ({ platform: 'devtools' }) };
  assert.equal(paymentAvailability(readyPlan, devtools).ready, false);
  assert.equal(paymentAvailability(readyPlan, { ...androidApi, requestVirtualPayment: undefined }).ready, false);
  assert.equal(purchaseGate([readyPlan], devtools).showShop, false);
});

test('iOS product disable blocks only that terminal purchase path', () => {
  const ios = {
    getDeviceInfo: () => ({ platform: 'ios', system: 'iOS 18.0' }),
    getAppBaseInfo: () => ({ version: '8.0.70', SDKVersion: '3.10.3' }),
    requestVirtualPayment() {},
  };
  assert.equal(paymentAvailability({ ...readyPlan, iosEnabled: false }, ios).ready, false);
  assert.equal(paymentAvailability(readyPlan, ios).ready, true);
});
