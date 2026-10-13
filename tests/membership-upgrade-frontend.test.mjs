import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { renewalPreview } = require('../miniprogram/utils/member-products');
const products = [
  { id: 'member_7d', planId: 'member_7d', days: 7, priceFen: 700, productId: 'vip666' },
  { id: 'member_30d', planId: 'member_30d', days: 30, priceFen: 1990, productId: 'vip777' },
  { id: 'member_365d', planId: 'member_365d', days: 365, priceFen: 20000, productId: 'vip888' },
].map(value => ({ ...value, enabled: true, paymentReady: true }));

function account(active = true, handler) {
  const rt = runtime(handler);
  rt.wx.requestVirtualPayment = () => {};
  const page = rt.instance('pages/mine/index.js');
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const boot = { identity: { userKey: 'upgrade-account' }, memberProducts: products, memberProduct: products[0],
    membership: { active, expiresAt: active ? expiresAt : null, remainingMs: active ? 7 * 86400000 : 0 },
    quota: { balance: 2, tasksDoneToday: [] }, collector: { state: 'not_deployed' }, limits: {}, tasks: [], followCount: 0 };
  page.applyBoot(boot); page.setData({ ready: true });
  return { rt, page, boot };
}

test('monthly and annual upgrades add the full duration after the existing expiry', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const membership = { active: true, expiresAt: '2026-10-12T00:00:00Z' };
  assert.equal(renewalPreview(products[1], membership, now).expiresAtText, '2026-11-11 08:00:00');
  assert.equal(renewalPreview(products[2], membership, now).expiresAtText, '2027-10-12 08:00:00');
  assert.match(renewalPreview(products[1], membership, now).description, /按所选套餐价格购买.*不抵扣差价.*不自动续费/);
  assert.equal(renewalPreview(products[2], { active: true, expiresAt: '2024-02-29T00:00:00Z' }, Date.parse('2024-02-20T00:00:00Z')).expiresAtText, '2025-02-28 08:00:00');
});

test('expired membership starts at confirmation-time estimate rather than extending a date in the past', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const value = renewalPreview(products[1], { active: true, expiresAt: '2026-10-01T00:00:00Z' }, now);
  assert.equal(value.expiresAtText, '2026-11-04 08:00:00');
  assert.equal(value.extensionText, '本次开通 30 天');
});

test('member purchase cards describe server-issued limits without inferring rights from duration', () => {
  const { page, boot } = account();
  boot.memberProducts = products.map((p, index) => ({ ...p, limits: { maxFollows: index ? 4 : 3, maxStoresPerFollow: index ? 4 : 3 } }));
  page.applyBoot(boot);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.boot.memberProducts.map(p => p.benefitShort))), ['3 配置 × 3 门店', '4 配置 × 4 门店', '4 配置 × 4 门店']);
  page.onOpenMembershipUpgrade();
  assert.match(page.data.membershipUpgradePreview.description, /4 个配置.*4 家门店/);
  assert.match(renewalPreview(products[2], boot.membership).description, /3 个配置.*3 家门店/, 'legacy server snapshots cannot be upgraded solely by a 365-day label');
});

test('concise benefit cards group equal advertised allowances while the current account keeps its own actual limit', () => {
  const { page, boot } = account();
  boot.memberProducts = products.map((product, index) => ({ ...product, limits: { maxFollows: index ? 4 : 3, maxStoresPerFollow: index ? 4 : 3 } }));
  boot.limits = { maxFollows: 3, maxStoresPerFollow: 3 };
  boot.membership.remainingMs = 365 * 86400000;
  page.applyBoot(boot);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.membershipBenefitPlans)), [
    { key: '3:3', label: '周卡', configs: 3, stores: 3, enhanced: false },
    { key: '4:4', label: '月卡 / 年卡', configs: 4, stores: 4, enhanced: true },
  ]);
  assert.equal(page.data.boot.limits.maxFollows, 3, 'gifted or accumulated membership days do not grant paid-plan slots');
  const original = page.data.membership.expiresAt;
  page.onToggleMembershipRules(); page.onTogglePurchaseRules();
  assert.equal(page.data.showMembershipRules, true);
  assert.equal(page.data.showPurchaseRules, true);
  page.onToggleMembershipRules();
  assert.equal(page.data.showMembershipRules, false);
  assert.equal(page.data.showPurchaseRules, true, 'purchase terms have their own disclosure');
  assert.equal(page.data.membership.expiresAt, original);
});

test('legacy product snapshots never advertise enhanced slots based only on a long duration', () => {
  const { page } = account();
  assert.equal(page.data.membershipBenefitPlans.length, 1);
  const card = page.data.membershipBenefitPlans[0];
  assert.equal(card.label, '周卡 / 月卡 / 年卡');
  assert.equal(card.configs, 3); assert.equal(card.stores, 3); assert.equal(card.enhanced, false);
});

test('the extra-slot entry requires an available product above the current server-issued allowance', () => {
  const { page, boot } = account();
  const expandedProducts = products.map((product, index) => ({ ...product,
    limits: { maxFollows: index ? 4 : 3, maxStoresPerFollow: index ? 4 : 3 } }));
  for (const [current, offered, active, expected] of [
    [{ maxFollows: 3, maxStoresPerFollow: 3 }, expandedProducts, true, true],
    [{ maxFollows: 4, maxStoresPerFollow: 4 }, expandedProducts, true, false],
    [{ maxFollows: 3, maxStoresPerFollow: 3 }, products, true, false],
    [{ maxFollows: 3, maxStoresPerFollow: 3 }, expandedProducts.map(product => ({ ...product, enabled: false })), true, false],
    [{ maxFollows: 3, maxStoresPerFollow: 3 }, expandedProducts, false, false],
    [{}, expandedProducts, true, false],
  ]) {
    page.applyBoot({ ...boot, limits: current, memberProducts: offered, membership: { ...boot.membership, active } });
    assert.equal(page.data.membershipCanExpand, expected);
  }
});

test('collapsed purchase details do not bypass the selected product notice and final consent', async () => {
  const { rt, page, boot } = account(false);
  const note = '月卡测试说明：一次性虚拟服务，一经售出不予退款。';
  boot.memberProducts = products.map(product => product.days === 30 ? { ...product, priceFen: 2290, note } : product);
  page.applyBoot(boot);
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_30d' } } });
  assert.equal(page.data.showPurchaseRules, false);
  assert.equal(page.data.boot.priceText, '¥22.90');
  let modal, purchases = 0;
  rt.wx.showModal = options => { modal = options; };
  page.paymentController.buy = async () => { purchases++; };
  const buying = page.onBuyMembership();
  assert.equal(purchases, 0);
  assert.equal(modal.title, '购买须知');
  assert.match(modal.content, /30 天会员 · ¥22\.90/);
  assert.ok(modal.content.includes(note));
  modal.success({ confirm: false }); await buying;
  assert.equal(purchases, 0);
  assert.equal(rt.calls.length, 0);
});

const promotion = { active: true, endsAt: null, timezone: 'Asia/Shanghai' };
function promotionalProducts(active = true) {
  return products.map(value => value.days === 7 ? value : { ...value,
    priceFen: value.days === 30 ? active ? 1499 : 3000 : active ? 12900 : 36000,
    standardPriceFen: value.days === 30 ? 3000 : 36000, promotion: { ...promotion, active } });
}

test('ongoing monthly and annual offers use server prices and do not invent a price-restoration deadline', () => {
  const { page, boot } = account(false);
  page.applyBoot({ ...boot, memberProducts: promotionalProducts() });
  const [week, month, year] = page.data.boot.memberProducts;
  assert.equal(week.promotionText, ''); assert.equal(week.standardPriceText, '');
  assert.equal(month.priceText, '¥14.99'); assert.equal(month.standardPriceText, '¥30.00');
  assert.equal(month.dailyPriceText, '约 ¥0.50 / 天');
  assert.equal(year.priceText, '¥129.00'); assert.equal(year.standardPriceText, '¥360.00');
  assert.equal(year.dailyPriceText, '约 ¥0.35 / 天');
  assert.equal(month.promotionText, '优惠价');
  assert.equal(month.promotionDeadlineText, undefined);
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_365d' } } });
  assert.equal(page.data.boot.priceText, '¥129.00');
  assert.equal(page.data.boot.memberProduct.days, 365);
});

test('a changed server snapshot with inactive offers follows its prices without a stale offer label', () => {
  const { page, boot } = account(false);
  page.applyBoot({ ...boot, memberProducts: promotionalProducts() });
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_30d' } } });
  page.applyBoot({ ...boot, memberProducts: promotionalProducts(false) });
  assert.equal(page.data.boot.priceText, '¥30.00');
  for (const value of page.data.boot.memberProducts) {
    assert.equal(value.standardPriceText, ''); assert.equal(value.promotionText, ''); assert.equal(value.promotionDeadlineText, undefined);
  }
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_365d' } } });
  assert.equal(page.data.boot.priceText, '¥360.00');
});

test('a safely changed monthly quote updates the actual account page and requires a second modal before paying', async () => {
  let creates = 0, cashiers = 0;
  const { rt, page, boot } = account(false, async (action, payload) => {
    assert.equal(action, 'member.createOrder');
    if (++creates === 1) throw { code: 'payment_price_changed', details: { product: promotionalProducts(false)[1],
      orderId: payload.orderId, canDiscardIntent: true, reason: 'quote_expired' } };
    return { ok: true, order: { orderId: payload.orderId, planId: 'member_30d', days: 30, amountFen: 3000, status: 'created' },
      payment: { mode: 'short_series_goods', signData: '{"goodsPrice":3000}', paySig: 'test-server-signature', signature: 'test-user-signature' } };
  });
  rt.wx.login = options => options.success({ code: 'test-login' });
  rt.wx.requestVirtualPayment = options => { cashiers++; options.fail({ errMsg: 'cancel' }); };
  page.pageVisible = true;
  page.applyBoot({ ...boot, memberProducts: promotionalProducts() });
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_30d' } } });
  await page.paymentController.show();
  let modal;
  rt.wx.showModal = value => { modal = value; };
  let buying = page.onBuyMembership();
  assert.match(modal.content, /30 天会员 · ¥14\.99/);
  assert.doesNotMatch(modal.content, /优惠至|恢复标准价|2026-11-30/);
  assert.match(modal.content, /一经售出不予退款/);
  modal.success({ confirm: true }); await buying;
  assert.equal(creates, 1); assert.equal(cashiers, 0);
  assert.equal(page.data.paymentPendingId, ''); assert.equal(page.data.boot.priceText, '¥30.00');
  assert.match(page.data.paymentError, /重新确认/);
  buying = page.onBuyMembership();
  assert.equal(creates, 1, 'price refresh cannot itself create another order');
  assert.match(modal.content, /30 天会员 · ¥30\.00/); assert.doesNotMatch(modal.content, /14\.99|限时优惠|优惠至/);
  modal.success({ confirm: true }); await buying;
  assert.equal(creates, 2); assert.equal(cashiers, 1);
  assert.deepEqual(rt.calls.map(value => value.payload.expectedPriceFen), [1499, 3000]);
  assert.notEqual(rt.calls[0].payload.orderId, rt.calls[1].payload.orderId);
});

test('an open purchase modal cannot approve a refreshed price or inherit an account change', async () => {
  for (const change of ['price', 'account']) {
    const { rt, page, boot } = account(false);
    page.applyBoot({ ...boot, memberProducts: promotionalProducts() });
    page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_30d' } } });
    let modal, purchases = 0;
    rt.wx.showModal = options => { modal = options; };
    page.paymentController.buy = async () => purchases++;
    const buying = page.onBuyMembership();
    if (change === 'price') page.applyPriceChange(promotionalProducts(false)[1]);
    else page.applyBoot({ ...boot, identity: { userKey: 'another-account' }, memberProducts: promotionalProducts() });
    modal.success({ confirm: true }); await buying;
    assert.equal(purchases, 0, change);
    if (change === 'price') assert.match(page.data.paymentError, /重新确认/);
  }
});

test('guide navigation and purchase-record shortcut open their destinations without ordering', async () => {
  const { rt, page } = account(false, async action => {
    assert.equal(action, 'member.status'); return { orders: [] };
  });
  let destination, scroll;
  rt.wx.navigateTo = value => { destination = value.url; };
  rt.wx.pageScrollTo = value => { scroll = value.selector; };
  page.onHelp(); assert.equal(destination, '/pages/guide/index');
  await page.onOpenOrders();
  assert.equal(page.data.showOrders, true); assert.equal(scroll, '#membership-records');
  assert.deepEqual(rt.calls.map(value => value.action), ['member.status']);
});

test('paid member upgrade selects a long-term package at full price without ordering or changing existing membership', () => {
  const { rt, page } = account();
  const originalExpiry = page.data.membership.expiresAt;
  assert.equal(page.data.membershipUpgradeOpen, false);
  page.onOpenMembershipUpgrade();
  assert.equal(page.data.membershipUpgradeOpen, true);
  assert.equal(page.data.purchaseMode, 'upgrade');
  assert.equal(page.data.selectedPlanId, 'member_30d');
  assert.equal(page.data.boot.priceText, '¥19.90');
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_365d' } } });
  assert.equal(page.data.boot.priceText, '¥200.00');
  assert.match(page.data.membershipUpgradePreview.extensionText, /增加 365 天/);
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_7d' } } });
  assert.equal(page.data.selectedPlanId, 'member_365d', 'week is a renewal, not a long-term upgrade choice');
  assert.equal(page.data.membership.expiresAt, originalExpiry);
  assert.equal(rt.calls.length, 0);
  page.onCloseMembershipUpgrade();
  assert.equal(page.data.membershipUpgradeOpen, false);
});

test('renewal can select the weekly package, while pending orders cannot be replaced through upgrade controls', () => {
  const { page } = account();
  page.onOpenMembershipUpgrade();
  page.onOpenMembershipRenew();
  assert.equal(page.data.purchaseMode, 'renew');
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_7d' } } });
  assert.equal(page.data.selectedPlanId, 'member_7d');
  page.setData({ paymentPendingId: 'existing-weekly-order' });
  page.onOpenMembershipUpgrade();
  assert.equal(page.data.selectedPlanId, 'member_7d');
  assert.equal(page.data.purchaseMode, 'renew');
  page.onCloseMembershipUpgrade();
  assert.equal(page.data.membershipUpgradeOpen, true);
});

test('free accounts cannot trigger the paid-member upgrade entry and switching accounts closes it', () => {
  const { page, boot } = account(false);
  page.onOpenMembershipUpgrade();
  assert.equal(page.data.membershipUpgradeOpen, false);
  assert.equal(page.data.purchaseMode, 'purchase');
  const active = account();
  active.page.onOpenMembershipUpgrade();
  active.page.applyBoot({ ...boot, identity: { userKey: 'another-account' } });
  assert.equal(active.page.data.membershipUpgradeOpen, false);
  assert.equal(active.page.data.purchaseMode, 'purchase');
});

test('abandon confirmation belongs to its original visible account and order', async () => {
  for (const change of ['account', 'hide', 'order', 'unchanged']) {
    const { rt, page, boot } = account();
    let modal, modalCount = 0, abandonCount = 0;
    rt.wx.showModal = options => { modal = options; modalCount++; };
    page.pageVisible = true;
    page.setData({ paymentPendingId: 'original-abandon-order' });
    page.paymentController.abandon = async () => { abandonCount++; };
    const confirming = page.onAbandonPayment();
    await page.onAbandonPayment();
    assert.equal(modalCount, 1, 'double tap creates one confirmation');
    if (change === 'account') { page.applyBoot({ ...boot, identity: { userKey: 'another-account' } }); page.applyBoot(boot); }
    if (change === 'hide') page.onHide();
    if (change === 'order') page.setData({ paymentPendingId: 'replacement-order' });
    modal.success({ confirm: true });
    await confirming;
    assert.equal(abandonCount, change === 'unchanged' ? 1 : 0, change);
    assert.equal(page.data.paymentConfirming, false);
  }
});

test('real account page lifecycle loads membership and quota and recovers an initial failure', async () => {
  const { boot } = account(false);
  for (const initiallyOffline of [false, true]) {
    let offline = initiallyOffline;
    const rt = runtime(async action => {
      if (action === 'user.bootstrap') {
        if (offline) throw Error('网络暂时不可用');
        return structuredClone(boot);
      }
      if (action === 'notify.list') return { notifications: [], hasMore: false };
      throw Error(`unexpected ${action}`);
    });
    const page = rt.instance('pages/mine/index.js');
    await page.onLoad();
    if (initiallyOffline) {
      assert.equal(page.data.ready, false);
      assert.match(page.data.loadError, /网络/);
      offline = false;
      await page.onRetryLoad();
    }
    await page.onShow();
    assert.equal(page.data.ready, true);
    assert.equal(page.data.quota.balance, boot.quota.balance);
    assert.equal(page.data.boot.memberProducts.length, 3);
    assert.equal(page.data.loadError, null);
    page.onUnload();
  }
});
