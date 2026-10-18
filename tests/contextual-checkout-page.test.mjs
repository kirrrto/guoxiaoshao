import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { isolatedAccountUi } from './helpers/isolated-account-ui.mjs';
const require = createRequire(import.meta.url);
const { createCheckoutContext } = require('../miniprogram/utils/checkout-context');
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const catalog = { version: 'v1', products: [{ partNumber: 'SKU-A', title: '所选型号 256GB 蓝色', supported: true }], stores: [{ storeNumber: 'R001', name: '甲门店', city: '上海' }] };
const target = { partNumber: 'SKU-A', storeNumbers: ['R001'] };
const boot = (userKey = 'a', features = { contextualCheckout: true, growthEvents: true }) => ({ identity: { userKey }, features,
  membership: { active: false, remainingMs: 0, expiresAt: null }, quota: { balance: 1, tasksDoneToday: [] }, tasks: [],
  collector: { state: 'not_deployed' }, memberProduct: { planId: 'member_7d', priceFen: 700, days: 7, enabled: true, paymentReady: true, note: '原始服务端退款规则。' },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 }, followCount: 0 });
function runtime({ catalogRead = async () => catalog, callRead = async () => ({}) } = {}) {
  const storage = new Map(), modals = [], calls = [], events = [], navigations = [], app = { globalData: {} }; let definition, current = catalog;
  const wx = { getDeviceInfo: () => ({ platform: 'android' }), canIUse: () => true, requestVirtualPayment() {},
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    showModal: options => modals.push(options), switchTab: options => navigations.push(options.url) };
  const source = path.resolve('miniprogram/pages/mine/index.js');
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { wx, getApp: () => app, Page: value => { definition = value; },
    require: name => name.endsWith('/api') ? { call: async (action, payload) => { calls.push({ action, payload }); return callRead(action, payload); } }
      : name.endsWith('/store') ? { getCatalog: catalogRead, currentCatalog: () => current, invalidateBootstrap() {}, invalidateFollows() {} }
      : name.endsWith('/conversion-events') ? { track: (name, fields) => events.push({ name, fields }) }
      : isolatedAccountUi(name) || require(path.resolve(path.dirname(source), name)) });
  const page = { ...definition, data: structuredClone(definition.data), pageVisible: true,
    setData(patch, done) { Object.assign(this.data, patch); if (done) done(); } };
  const context = createCheckoutContext({ wx });
  return { page, context, app, modals, calls, events, navigations, storage, setCatalog(value) { current = value; } };
}
test('contextual account page restores exact catalog target and gates payment on explicit consent with original server terms', async () => {
  const rt = runtime(); rt.context.save(boot().identity, target, catalog); rt.page.applyBoot(boot()); rt.page.data.ready = true; await tick();
  assert.equal(rt.page.data.checkoutTarget.title, catalog.products[0].title);
  assert.equal(rt.page.data.checkoutTarget.storeText, '上海 · 甲门店');
  assert.equal(rt.page.data.selectedPlanId, 'member_7d');
  let bought = 0; rt.page.paymentController.buy = () => bought++;
  const buying = rt.page.onBuyMembership();
  assert.equal(bought, 0);
  assert.match(rt.modals[0].content, /7 天会员 · ¥7.*原始服务端退款规则。/s);
  assert.match(rt.modals[0].content, /所选型号 256GB 蓝色.*门店：上海 · 甲门店/s);
  rt.modals[0].success({ confirm: false }); await buying; assert.equal(bought, 0);
  const second = rt.page.onBuyMembership(); rt.modals[1].success({ confirm: true }); await second;
  assert.equal(bought, 1);
});
test('replacing an intent while the consent dialog is open requires a new confirmation', async () => {
  const rt = runtime(); rt.context.save(boot().identity, target, catalog); rt.page.applyBoot(boot()); rt.page.data.ready = true; await tick();
  let bought = 0; rt.page.paymentController.buy = () => bought++;
  const buying = rt.page.onBuyMembership(); rt.context.save(boot().identity, target, catalog); rt.modals[0].success({ confirm: true }); await buying;
  assert.equal(bought, 0);
});

test('the same plan cannot use changed server terms under an older purchase confirmation', async () => {
  const rt = runtime(); rt.page.applyBoot(boot()); rt.page.data.ready = true; await tick();
  let bought = 0; rt.page.paymentController.buy = () => bought++;
  const buying = rt.page.onBuyMembership();
  const updated = boot(); updated.memberProduct = { ...updated.memberProduct, priceFen: 900, note: '更新后的服务端说明。' };
  rt.page.applyBoot(updated); await tick(); rt.modals[0].success({ confirm: true }); await buying;
  assert.equal(bought, 0); assert.match(rt.page.data.paymentError, /重新确认购买/);
});
test('updated catalog prevents checkout under a stale target and leaves an explicit recovery action', async () => {
  const rt = runtime(); rt.context.save(boot().identity, target, catalog); rt.page.applyBoot(boot()); rt.page.data.ready = true; await tick();
  rt.setCatalog({ ...catalog, version: 'v2' }); await rt.page.onBuyMembership();
  assert.equal(rt.modals.length, 0); assert.equal(rt.calls.length, 0); assert.match(rt.page.data.checkoutMessage, /信息已更新/);
  rt.page.onReturnToQuery(); assert.equal(rt.navigations[0], '/pages/query/index');
});
test('verified membership offers a user-triggered continuation and keeps intent until follow save', async () => {
  const rt = runtime(); const saved = rt.context.save(boot().identity, target, catalog).context;
  const memberBoot = boot(); memberBoot.membership = { active: true, expiresAt: '2027-01-01T00:00:00Z', remainingMs: 10000 };
  rt.page.applyBoot(memberBoot); await tick(); rt.page.resumeMemberFollow(memberBoot.membership);
  assert.equal(rt.modals.length, 0); assert.equal(rt.navigations.length, 0);
  rt.page.onContinueCheckout();
  assert.equal(rt.navigations[0], '/pages/follow/index');
  assert.deepEqual(JSON.parse(JSON.stringify(rt.app.globalData.pendingFollow)), { ...target, checkoutRevision: saved.revision, checkoutSignature: saved.targetSignature });
  assert.equal(rt.context.restore(boot().identity, catalog).status, 'ready');
});
test('late catalog reads cannot put another account target back on the page', async () => {
  let resolve; const rt = runtime({ catalogRead: () => new Promise(done => { resolve = done; }) });
  rt.context.save(boot().identity, target, catalog); rt.page.applyBoot(boot()); const resolveA = resolve;
  rt.page.applyBoot(boot('b')); resolveA(catalog); await tick();
  assert.equal(rt.page.data.checkoutTarget, null); resolve(catalog); await tick();
  assert.equal(rt.page.data.checkoutTarget, null); assert.equal(rt.page.data.boot.identity.userKey, 'b');
});
test('offer exposure requires native viewport evidence and is deduplicated; research answer is optional and sent once', async () => {
  const rt = runtime(); rt.page.applyBoot(boot()); rt.page.data.ready = true; await tick();
  let observerCallback;
  rt.page.createIntersectionObserver = () => ({ relativeToViewport() { return this; }, observe(_id, callback) { observerCallback = callback; }, disconnect() {} });
  rt.page.observeMembershipOffer(); assert.equal(rt.events.length, 0);
  assert.equal(observerCallback, undefined, 'collapsed free-user entry has no offer to observe');
  rt.page.onOpenMembershipRenew();
  observerCallback({ intersectionRatio: 0 }); assert.equal(rt.events.length, 0);
  observerCallback({ intersectionRatio: 0.5 }); observerCallback({ intersectionRatio: 0.9 });
  assert.equal(rt.events.filter(item => item.name === 'offer_viewed').length, 1);
  assert.equal(rt.page.data.showPurchaseFeedback, false);
  rt.page.onPurchaseFeedback({ currentTarget: { dataset: { code: 'feedback_no_need' } } });
  rt.page.onPurchaseFeedback({ currentTarget: { dataset: { code: 'feedback_payment' } } });
  assert.equal(rt.events.filter(item => item.name === 'purchase_feedback').length, 1);
});

test('pending payment removes offer observation and a closed original order restores it without accepting stale visibility', async () => {
  const rt = runtime({ callRead: async (action, payload) => {
    assert.equal(action, 'member.abandonOrder');
    return { order: { orderId: payload.orderId, status: 'cancelled' }, membership: boot().membership };
  } });
  rt.page.applyBoot(boot()); rt.page.data.ready = true; await tick();
  const observations = [];
  rt.page.createIntersectionObserver = () => {
    const observation = { disconnected: false, relativeToViewport() { return this; },
      observe(id, callback) { assert.equal(id, '#membership-offer'); this.callback = callback; observations.push(this); },
      disconnect() { this.disconnected = true; } };
    return observation;
  };
  rt.page.onOpenMembershipRenew();
  const first = observations[0];
  await rt.page.paymentController.buy(); // Missing login preserves the real pending intent without opening a cashier.
  assert.ok(rt.page.data.paymentPendingId);
  assert.equal(first.disconnected, true);
  assert.equal(rt.page.offerObserver, null);
  rt.page.observeMembershipOffer(); first.callback({ intersectionRatio: 1 });
  assert.equal(observations.length, 1, 'recovery state has no offer node to observe');
  assert.equal(rt.events.filter(item => item.name === 'offer_viewed').length, 0);
  await rt.page.paymentController.abandon();
  assert.equal(rt.page.data.paymentPendingId, '');
  assert.equal(observations.length, 2, 'closed original order restores the purchase surface');
  first.callback({ intersectionRatio: 1 });
  assert.equal(rt.events.filter(item => item.name === 'offer_viewed').length, 0, 'a disconnected callback cannot record the restored offer');
  observations[1].callback({ intersectionRatio: 1 });
  assert.equal(rt.events.filter(item => item.name === 'offer_viewed').length, 1);
});
test('rollback hides the contextual view without deleting intent or a pending payment', async () => {
  const rt = runtime(); rt.context.save(boot().identity, target, catalog); rt.page.applyBoot(boot('a', {})); await tick();
  assert.equal(rt.page.data.contextualCheckout, false); assert.equal(rt.page.data.checkoutTarget, null);
  assert.equal(rt.context.restore(boot().identity, catalog).status, 'ready');
});

test('generic membership purchase does not depend on a catalog fetch when no checkout target is saved', async () => {
  let reads = 0;
  const rt = runtime({ catalogRead: async () => { reads++; throw Error('catalog offline'); } });
  rt.page.applyBoot(boot()); rt.page.data.ready = true; await tick();
  assert.equal(reads, 0); assert.equal(rt.page.data.checkoutMessage, ''); assert.equal(rt.page.data.checkoutLoading, false);
  const buying = rt.page.onBuyMembership(); assert.equal(rt.modals.length, 1); rt.modals[0].success({ confirm: false }); await buying;
});

test('an invalid old target cannot block an existing member from reviewing renewal terms', async () => {
  const rt = runtime(); rt.context.save(boot().identity, target, catalog);
  rt.setCatalog({ ...catalog, version: 'v2' });
  const memberBoot = boot(); memberBoot.membership = { active: true, expiresAt: new Date(Date.now() + 86400000).toISOString(), remainingMs: 86400000 };
  rt.page.applyBoot(memberBoot); rt.page.data.ready = true; await tick();
  const buying = rt.page.onBuyMembership();
  assert.match(rt.page.data.checkoutMessage, /信息已更新/); assert.equal(rt.modals.length, 1);
  assert.doesNotMatch(rt.modals[0].content, /开通后继续设置关注/);
  rt.modals[0].success({ confirm: false }); await buying;
});

test('legacy continuation accepts old session hints but rejects a new hint from another account or past its TTL', async () => {
  for (const metadata of [{ userKey: 'other', createdAt: Date.now() }, { userKey: 'a', createdAt: Date.now() - 86400000 }, { userKey: 'a', createdAt: Date.now() + 86400000 }]) {
    const rt = runtime(); rt.page.applyBoot(boot('a', {})); await tick();
    rt.app.globalData.pendingMemberFollow = { ...target, title: '不应展示', ...metadata };
    rt.page.resumeMemberFollow({ active: true });
    assert.equal(rt.modals.length, 0); assert.equal(rt.app.globalData.pendingMemberFollow, null);
  }
  const rt = runtime(); rt.page.applyBoot(boot('a', {})); await tick();
  rt.app.globalData.pendingMemberFollow = { ...target, title: '兼容旧内存意向' };
  rt.page.resumeMemberFollow({ active: true }); assert.equal(rt.modals.length, 1);
  rt.page.applyBoot(boot('b', {})); rt.modals[0].success({ confirm: true });
  assert.equal(rt.navigations.length, 0, 'a delayed old-account consent cannot open the new-account editor');
});
