import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const products = () => ['member_7d', 'member_30d', 'member_365d'].map((planId, i) => ({
  id: planId, planId, days: [7, 30, 365][i], priceFen: [700, 1990, 20000][i],
  productId: `vip${i}`, enabled: true, paymentReady: true,
  limits: { maxFollows: i + 3, maxStoresPerFollow: i + 3 },
}));
const catalog = {
  version: 'checkout-plan-test',
  products: [{ partNumber: 'SKU-A', title: 'A', supported: true }],
  stores: Array.from({ length: 5 }, (_, i) => ({ storeNumber: `R00${i + 1}`, name: `门店${i + 1}`, city: '上海' })),
};
const savedFollows = (count, existing = false) => Array.from({ length: count }, (_, i) => ({
  followId: `saved-${i}`, partNumber: existing && i === 0 ? 'SKU-A' : `OTHER-${i}`, status: 'paused',
}));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture({ followRead = async () => ({ follows: [] }), offers = products(), followCount = 0 } = {}) {
  const rt = runtime(action => action === 'follow.list' ? followRead() : action === 'catalog.get' ? { unchanged: true } : {});
  rt.wx.requestVirtualPayment = () => {};
  const boot = {
    identity: { userKey: 'checkout-account' }, features: { contextualCheckout: true },
    membership: { active: false, expiresAt: '2020-01-01T00:00:00Z', remainingMs: 0 },
    memberProducts: offers, memberProduct: offers[0], followCount,
    collector: { state: 'not_deployed' }, quota: { tasksDoneToday: [] }, tasks: [], limits: {},
  };
  rt.app.globalData.catalog = catalog;
  rt.app.globalData.bootstrap = boot;
  const page = rt.instance('pages/mine/index.js');
  const context = rt.load('utils/checkout-context.js').createCheckoutContext({ wx: rt.wx });
  const save = (stores = 1, identity = boot.identity) => context.save(identity, {
    partNumber: 'SKU-A', storeNumbers: catalog.stores.slice(0, stores).map(store => store.storeNumber),
  }, catalog);
  const apply = (value = boot) => {
    rt.app.globalData.bootstrap = value;
    page.applyBoot(value);
    page.setData({ ready: true });
  };
  return { rt, page, boot, save, apply };
}

test('checkout selects the lowest-priced available plan covering both server-advertised limits', async () => {
  for (const [stores, expected] of [[3, 'member_7d'], [4, 'member_30d'], [5, 'member_365d']]) {
    const f = fixture(); f.save(stores); f.apply(); await f.page.restoreCheckoutContext();
    assert.equal(f.page.data.selectedPlanId, expected);
    assert.equal(f.rt.calls.some(call => call.action === 'follow.list'), false, 'zero saved follows need no list request');
  }
  const offers = products();
  offers[1].limits = { maxFollows: 5, maxStoresPerFollow: 3 };
  offers[2].limits = { maxFollows: 4, maxStoresPerFollow: 4 };
  const f = fixture({ offers }); f.save(4); f.apply(); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_365d', 'month label does not imply four-store capacity');
});

test('unavailable intermediate plans do not prevent a suitable available plan from being selected', async () => {
  const offers = products();
  offers[1] = { ...offers[1], enabled: false, paymentReady: false, paymentReason: 'payment_plan_disabled' };
  const f = fixture({ offers }); f.save(4); f.apply(); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_365d');
});

test('an automatic choice falls back to the smaller plan when the checkout target needs fewer stores', async () => {
  const f = fixture(); f.save(5); f.apply(); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_365d');
  f.save(1); await f.page.restoreCheckoutContext();
  assert.equal(f.page.userSelectedPlan, false);
  assert.equal(f.page.data.selectedPlanId, 'member_7d');
});

test('restoring an existing expired or paused follow does not consume another configuration slot', async () => {
  for (const existing of [true, false]) {
    const f = fixture({ followCount: 3, followRead: async () => ({ follows: savedFollows(3, existing) }) });
    f.save(); f.apply(); await f.page.restoreCheckoutContext();
    assert.equal(f.page.data.selectedPlanId, existing ? 'member_7d' : 'member_30d');
    await f.page.restoreCheckoutContext();
    assert.equal(f.rt.calls.filter(call => call.action === 'follow.list').length, 1, 'repeated restores share the follow cache');
  }
});

test('no fitting offer and missing server capacities do not produce a guessed annual recommendation', async () => {
  const full = fixture({ followCount: 5, followRead: async () => ({ follows: savedFollows(5) }) });
  full.save(); full.apply(); await full.page.restoreCheckoutContext();
  assert.equal(full.page.data.selectedPlanId, 'member_7d', 'six configurations exceed every offered plan');
  const offers = products().map(({ limits, ...product }) => product);
  const legacy = fixture({ offers }); legacy.save(5); legacy.apply(); await legacy.page.restoreCheckoutContext();
  assert.equal(legacy.page.data.selectedPlanId, 'member_7d', 'plan IDs cannot stand in for missing server limits');
});

test('a failed saved-follow read preserves the current selection and leaves the target recoverable', async () => {
  const f = fixture({ followCount: 4, followRead: async () => { throw Error('offline'); } });
  f.save(); f.apply(); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_7d');
  assert.equal(f.page.data.checkoutTarget.partNumber, 'SKU-A');
  assert.equal(f.page.data.checkoutLoading, false);
});

test('manual choices, pending orders and ongoing purchase actions freeze automatic selection', async () => {
  for (const lock of ['manual', 'pendingPlan', 'paymentPendingId', 'paymentBusy', 'paymentChecking', 'paymentConfirming', 'redeeming']) {
    const f = fixture(); f.apply(); await tick();
    if (lock === 'manual') f.page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_7d' } } });
    else if (lock === 'pendingPlan') f.page.paymentPendingPlanId = 'member_7d';
    else f.page.setData({ [lock]: lock === 'paymentPendingId' ? 'pending-order' : true });
    f.save(5); await f.page.restoreCheckoutContext();
    assert.equal(f.page.data.selectedPlanId, 'member_7d', lock);
  }
});

test('a manual selection made during follow loading survives the delayed recommendation', async () => {
  let resolve;
  const f = fixture({ followCount: 4, followRead: () => new Promise(done => { resolve = done; }) });
  f.save(); f.apply(); const restoring = f.page.restoreCheckoutContext(); await tick();
  f.page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_30d' } } });
  resolve({ follows: savedFollows(4) }); await restoring;
  assert.equal(f.page.data.selectedPlanId, 'member_30d');
});

test('a previous account follow response cannot select a plan on the new account', async () => {
  let f, resolve;
  f = fixture({ followCount: 4, followRead: () => f.rt.app.globalData.bootstrap.identity.userKey === 'checkout-account'
    ? new Promise(done => { resolve = done; }) : Promise.resolve({ follows: [] }) });
  f.save(); f.apply(); const restoring = f.page.restoreCheckoutContext(); await tick();
  const next = { ...f.boot, identity: { userKey: 'another-account' }, followCount: 0 };
  f.save(1, next.identity); f.apply(next); await f.page.restoreCheckoutContext();
  resolve({ follows: savedFollows(4) }); await restoring;
  assert.equal(f.page.data.boot.identity.userKey, 'another-account');
  assert.equal(f.page.data.selectedPlanId, 'member_7d');
  assert.equal(f.page.data.checkoutTarget.storeNumbers.length, 1);
});

test('switching accounts discards cached saved follows before recommending for an account with existing follows', async () => {
  let f;
  f = fixture({ followCount: 4, followRead: async () => ({
    follows: f.rt.app.globalData.bootstrap.identity.userKey === 'checkout-account' ? savedFollows(4) : savedFollows(1, true),
  }) });
  f.save(); f.apply(); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_365d');
  const next = { ...f.boot, identity: { userKey: 'another-account' }, followCount: 1 };
  f.save(1, next.identity); f.apply(next); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_7d');
  assert.equal(f.rt.calls.filter(call => call.action === 'follow.list').length, 2);
});

test('switching accounts retires an in-flight follow read before the second account restores its saved target', async () => {
  let f, resolve;
  f = fixture({ followCount: 4, followRead: () => f.rt.app.globalData.bootstrap.identity.userKey === 'checkout-account'
    ? new Promise(done => { resolve = done; }) : Promise.resolve({ follows: savedFollows(1, true) }) });
  f.save(); f.apply(); const previousRestore = f.page.restoreCheckoutContext(); await tick();
  const next = { ...f.boot, identity: { userKey: 'another-account' }, followCount: 1 };
  f.save(1, next.identity); f.apply(next); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_7d');
  resolve({ follows: savedFollows(4) }); await previousRestore;
  assert.equal(f.page.data.boot.identity.userKey, 'another-account');
  assert.equal(f.page.data.selectedPlanId, 'member_7d');
  assert.equal(f.rt.calls.filter(call => call.action === 'follow.list').length, 2);
  await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_7d', 'late account A results cannot overwrite account B cached follows');
  assert.equal(f.rt.calls.filter(call => call.action === 'follow.list').length, 2);
});

test('first account confirmation on a new mine page discards another page previous-account follow cache', async () => {
  let f;
  f = fixture({ followCount: 4, followRead: async () => ({
    follows: f.rt.app.globalData.bootstrap.identity.userKey === 'checkout-account' ? savedFollows(4) : savedFollows(1, true),
  }) });
  await f.rt.load('utils/store.js').getFollows();
  assert.equal(f.page.data.boot, null, 'the mine page has not yet confirmed an account');
  const next = { ...f.boot, identity: { userKey: 'another-account' }, followCount: 1 };
  f.save(1, next.identity); f.apply(next); await f.page.restoreCheckoutContext();
  assert.equal(f.page.data.selectedPlanId, 'member_7d');
  assert.equal(f.rt.calls.filter(call => call.action === 'follow.list').length, 2);
});
