import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixture, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog/products.json'), 'utf8'));
const fnCatalog = JSON.parse(fs.readFileSync(path.join(root, 'cloudfunctions/gxs_api/catalog/products.json'), 'utf8'));
const seed = require('../miniprogram/config/catalog-seed');
const productImages = require('../miniprogram/config/product-images');
const thumbnails = require('../miniprogram/config/product-thumbnails');
const {
  RETIRED_MAC_PART_NUMBERS,
  RETIRED_MAC_PRODUCT_MESSAGE,
  isRetiredPartNumber,
  retiredProductMessage,
  loadFollowUsers,
} = require('../cloudfunctions/gxs_api/lib/rules/follow-access');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { sortFamilies } = require('../miniprogram/utils/catalog-order');
const {
  MAC_LAUNCH_CELEBRATION_NOTICE,
  MAC_CATALOG_NOTICE,
  IPAD_MINI_CATALOG_NOTICE,
  withOutageCompensationNotice,
  resolveQueryNotice,
} = require('../miniprogram/utils/query-notice');

const DAY = 86400000;
const { paymentOrderId } = require('../cloudfunctions/gxs_api/lib/rules/launch-gift');
const { scanLaunchGiftManifest, runLaunchGiftBatch } = require('../cloudfunctions/gxs_api/lib/services/launch-gift-task');
const LAUNCH_GIFT_TIME = '2026-10-28T04:00:00.000Z'; // 2026-10-28 12:00:00+08:00
const BEFORE_LAUNCH_GIFT = '2026-10-27T12:00:00.000Z'; // 2026-10-27 20:00:00+08:00
const AFTER_LAUNCH_GIFT_DAY = '2026-10-28T16:00:00.000Z'; // 2026-10-29 00:00:00+08:00

const ok = response => {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.data;
};

const plans = { member_7d: [7, 700], member_30d: [30, 1990], member_365d: [365, 20000] };

async function purchase(f, id, planId) {
  const user = await f.repo.getUser(userKeyOf());
  const [days, amountFen] = plans[planId];
  const nowIso = f.state.now.toISOString();
  const order = {
    _id: paymentOrderId(user._id, id),
    outTradeNo: paymentOrderId(user._id, id),
    orderId: id,
    userKey: user._id,
    appid: user.appid,
    openid: user.openid,
    provider: 'wechat_virtual_payment',
    type: 'membership_order',
    productId: `test_${planId}`,
    planId,
    days,
    amountFen,
    status: 'paid',
    paidAt: nowIso,
    createdAt: nowIso,
    paymentSnapshot: {
      version: 2,
      provider: 'wechat_virtual_payment',
      appid: user.appid,
      planId,
      productId: `test_${planId}`,
      days,
      priceFen: amountFen,
      currency: 'CNY',
      env: 0,
      buyQuantity: 1,
    },
  };
  await f.repo.createOrderIfAbsent(order);
  await f.repo.markOrderPaid({ orderId: order._id, transactionId: `transaction_${id}`, nowIso,
    providerData: { provider: 'wechat_virtual_payment', amountFen } });
  await f.repo.fulfilMembershipOrder({ orderId: order._id, source: 'virtual_payment', nowIso });
  return order;
}

const NEW_MBP_M6_SKUS = [
  'MHWT4CH/A', 'MHWW4CH/A', 'MJ2C4CH/A',
  'MHWU4CH/A', 'MHWX4CH/A',
  'MHWV4CH/A', 'MHWY4CH/A',
];
const NEW_IMAC_M6_SKUS = [
  'MH0A4CH/A', 'MH094CH/A', 'MH084CH/A', 'MH064CH/A',
  'MH1P4CH/A', 'MH1H4CH/A', 'MH1D4CH/A', 'MH114CH/A', 'MH2U4CH/A',
  'MH1Q4CH/A', 'MH1J4CH/A', 'MH1F4CH/A', 'MH154CH/A',
  'MH1R4CH/A', 'MH1N4CH/A', 'MH1G4CH/A', 'MH164CH/A',
];

test('v3.4.3 catalog syncs all 88 standard Mac SKUs (including M6 MacBook Pro & M6 iMac), memory/storage attributes, thumbnails, and picker selection', () => {
  const mbpFamily = catalog.families.find(f => f.familyKey === 'macbook-pro');
  const imacFamily = catalog.families.find(f => f.familyKey === 'imac');
  assert.ok(mbpFamily);
  assert.ok(imacFamily);
  assert.equal(mbpFamily.releaseDate, '2026-10-27');
  assert.equal(imacFamily.releaseDate, '2026-10-27');
  assert.equal(mbpFamily.productCount, 24);
  assert.equal(imacFamily.productCount, 17);

  const mbpProducts = catalog.products.filter(p => p.familyKey === 'macbook-pro');
  const imacProducts = catalog.products.filter(p => p.familyKey === 'imac');
  assert.equal(mbpProducts.length, 24);
  assert.equal(imacProducts.length, 17);
  assert.deepEqual(mbpProducts.slice(0, 7).map(p => p.partNumber), NEW_MBP_M6_SKUS);
  assert.deepEqual(imacProducts.map(p => p.partNumber), NEW_IMAC_M6_SKUS);

  // Every Mac SKU across all 6 Mac families has memory, capacity, chipName, chip, and descriptive title
  const macProducts = catalog.products.filter(p => p.category === 'mac');
  assert.equal(macProducts.length, 88);
  for (const prod of macProducts) {
    const part = prod.partNumber;
    assert.ok(prod.attributes.memory, `missing memory on ${part}`);
    assert.ok(prod.attributes.capacity, `missing capacity on ${part}`);
    assert.ok(prod.attributes.chipName, `missing chipName on ${part}`);
    assert.ok(prod.attributes.chip, `missing chip on ${part}`);
    assert.ok(prod.title.includes(prod.attributes.memory), `title missing memory on ${part}: ${prod.title}`);
    assert.ok(prod.title.includes(prod.attributes.capacity), `title missing capacity on ${part}: ${prod.title}`);
    assert.ok(fnCatalog.products.some(p => p.partNumber === part), `missing ${part} in cloud function catalog`);
    const seedProd = seed.products.find(p => p.partNumber === part);
    assert.ok(seedProd, `missing ${part} in client seed`);
    assert.equal(seedProd.title, prod.title, `seed title mismatch for ${part}`);
    assert.ok(productImages[part] && productImages[part].imageUrl === prod.imageUrl, `missing image mapping for ${part}`);
    const thumbIdx = thumbnails.byPart[part];
    assert.ok(Number.isInteger(thumbIdx), `missing thumbnail index for ${part}`);
    const thumbAsset = thumbnails.assets[thumbIdx];
    assert.ok(thumbAsset && thumbAsset.card, `missing card thumbnail for ${part}`);
    assert.equal(fs.existsSync(path.join(root, 'miniprogram', thumbAsset.card.slice(1))), true);
  }

  for (const retired of RETIRED_MAC_PART_NUMBERS) {
    assert.equal(catalog.products.some(p => p.partNumber === retired), false, `retired SKU ${retired} still in catalog`);
    assert.equal(seed.products.some(p => p.partNumber === retired), false, `retired SKU ${retired} still in client seed`);
  }

  const macFamilies = sortFamilies(catalog.families.filter(f => f.category === 'mac'));
  assert.deepEqual(macFamilies.map(f => f.familyKey), [
    'macbook-pro',
    'imac',
    'mac-mini',
    'mac-studio',
    'macbook-neo',
    'macbook-air',
  ]);

  // Verify target-picker exposes memory, storage capacity, and specSummary across all Mac families
  const rt = runtime();
  const indexedCatalog = rt.load('utils/store.js').currentCatalog();
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3 });
  picker.onCatalog(indexedCatalog);
  const macCatIdx = picker.data.categories.findIndex(c => c.key === 'mac');
  picker.onCategoryTap({ currentTarget: { dataset: { index: macCatIdx } } });

  // 1. MacBook Pro 14-inch: memories 16GB/24GB/32GB/36GB/48GB, capacities 1TB/2TB
  assert.equal(picker.data.families[picker.data.familyIndex].familyKey, 'macbook-pro');
  assert.deepEqual(JSON.parse(JSON.stringify(picker.data.memories)), ['16GB', '24GB', '32GB', '36GB', '48GB']);
  assert.deepEqual(JSON.parse(JSON.stringify(picker.data.capacities)), ['1TB', '2TB']);
  assert.match(picker.data.product.specSummary, /M6 · 12核CPU\/12核GPU · 16GB \+ 1TB/);
  picker.onMemoryTap({ currentTarget: { dataset: { index: picker.data.memories.indexOf('24GB') } } });
  assert.equal(picker.data.product.attributes.memory, '24GB');
  assert.equal(picker.data.product.attributes.capacity, '1TB');
  picker.onCapacityTap({ currentTarget: { dataset: { index: picker.data.capacities.indexOf('2TB') } } });
  assert.equal(picker.data.product.attributes.memory, '24GB');
  assert.equal(picker.data.product.attributes.capacity, '2TB');

  // 2. iMac: memories 16GB/24GB, capacities 256GB/512GB
  const imacFamIdx = picker.data.families.findIndex(f => f.familyKey === 'imac');
  picker.onFamilyChange({ detail: { value: imacFamIdx } });
  assert.deepEqual(JSON.parse(JSON.stringify(picker.data.memories)), ['16GB', '24GB']);
  assert.deepEqual(JSON.parse(JSON.stringify(picker.data.capacities)), ['256GB', '512GB']);
  assert.match(picker.data.product.specSummary, /M6 · 12核CPU\/12核GPU · 24GB \+ 512GB/);
  picker.onMemoryTap({ currentTarget: { dataset: { index: picker.data.memories.indexOf('16GB') } } });
  picker.onCapacityTap({ currentTarget: { dataset: { index: picker.data.capacities.indexOf('256GB') } } });
  assert.equal(picker.data.product.attributes.memory, '16GB');
  assert.equal(picker.data.product.attributes.capacity, '256GB');
  assert.match(picker.data.product.specSummary, /M6 · 12核CPU\/12核GPU · 16GB \+ 256GB/);

  // 3. MacBook Air, Mac mini, Mac Studio, MacBook Neo all expose memories, capacities, and specSummary
  for (const [key, expectedMemories, expectedCapacities] of [
    ['macbook-air', ['16GB', '24GB'], ['512GB', '1TB']],
    ['mac-mini', ['16GB', '24GB', '32GB', '64GB'], ['256GB', '512GB', '1TB']],
    ['mac-studio', ['36GB', '64GB', '96GB'], ['512GB', '1TB']],
    ['macbook-neo', ['8GB'], ['256GB', '512GB']]
  ]) {
    const famIdx = picker.data.families.findIndex(f => f.familyKey === key);
    picker.onFamilyChange({ detail: { value: famIdx } });
    assert.deepEqual(JSON.parse(JSON.stringify(picker.data.memories)), expectedMemories, `${key} memories`);
    assert.deepEqual(JSON.parse(JSON.stringify(picker.data.capacities)), expectedCapacities, `${key} capacities`);
    assert.ok(picker.data.product.specSummary.includes('+'), `${key} specSummary: ${picker.data.product.specSummary}`);
  }
});

test('retired M5 MacBook Pro and M4 iMac SKUs are blocked from queries/follows, surfaced as paused, and skipped by collector', async () => {
  const f = createFixture({ start: LAUNCH_GIFT_TIME });
  await f.call('user.bootstrap');

  for (const retiredPart of ['MDE14CH/A', 'MWUG3CH/A']) {
    assert.equal(isRetiredPartNumber(retiredPart), true);
    assert.equal(retiredProductMessage(retiredPart), RETIRED_MAC_PRODUCT_MESSAGE);
  }
  assert.equal(isRetiredPartNumber('MHWT4CH/A'), false);
  assert.equal(isRetiredPartNumber('MH084CH/A'), false);

  await f.repo.updateUser(userKeyOf(), {
    membership: {
      active: true,
      planId: 'member_30d',
      expiresAt: '2026-11-20T00:00:00.000Z',
    },
  });

  const queryRes = await f.call('query.pickup', { queryId: 'q_retired_mac_1', partNumber: 'MDE14CH/A', storeNumbers: ['R577'] });
  assert.equal(queryRes.ok, false);
  assert.equal(queryRes.error.code, 'product_retired');
  assert.equal(queryRes.error.message, RETIRED_MAC_PRODUCT_MESSAGE);

  const upsertRes = await f.call('follow.upsert', { partNumber: 'MWUG3CH/A', storeNumbers: ['R577'] });
  assert.equal(upsertRes.ok, false);
  assert.equal(upsertRes.error.code, 'product_retired');

  await f.repo.saveFollow({
    _id: `${userKeyOf()}|follow_retired_mac`,
    followId: 'follow_retired_mac',
    userKey: userKeyOf(),
    partNumber: 'MWUG3CH/A',
    storeNumbers: ['R577'],
    status: 'active',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  });

  const listRes = ok(await f.call('follow.list'));
  assert.equal(listRes.follows.length, 1);
  assert.equal(listRes.follows[0].status, 'paused');
  assert.equal(listRes.follows[0].statusReason, 'product_retired');
  assert.equal(listRes.follows[0].productRetired, true);

  const resumeRes = await f.call('follow.resume', { followId: 'follow_retired_mac' });
  assert.equal(resumeRes.ok, false);
  assert.equal(resumeRes.error.code, 'product_retired');

  const collector = createCollector({
    repo: f.repo,
    fetchImpl: f.state.fetchImpl,
    clock: () => f.state.now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await collector.step();
  assert.equal(f.state.fetchImpl.calls.length, 0);
});

test('paid active members automatically receive +1 day launch celebration gift on 2026-10-28 while preserving plan tier', async () => {
  for (const [planId, expectedSlots] of [['member_7d', 3], ['member_30d', 4], ['member_365d', 5]]) {
    const f = createFixture({ start: BEFORE_LAUNCH_GIFT });
    ok(await f.call('user.bootstrap'));
    await purchase(f, `paid-launch-${planId}`, planId);
    const before = ok(await f.call('user.bootstrap'));
    const beforeExpiry = Date.parse(before.membership.expiresAt);

    f.state.now = new Date(LAUNCH_GIFT_TIME);
    const after = ok(await f.call('user.bootstrap'));
    assert.equal(after.membership.active, true);
    assert.equal(after.membership.planId, planId);
    assert.equal(Date.parse(after.membership.expiresAt), beforeExpiry + DAY);
    assert.equal(after.limits.maxFollows, expectedSlots);
    assert.equal(after.limits.maxStoresPerFollow, expectedSlots);
    if (planId === 'member_30d') {
      assert.equal(Date.parse(after.membership.enhancedExpiresAt), beforeExpiry + DAY);
    }
    if (planId === 'member_365d') {
      assert.equal(Date.parse(after.membership.annualExpiresAt), beforeExpiry + DAY);
    }

    // Repeated bootstrap and status calls are idempotent
    const again = ok(await f.call('user.bootstrap'));
    assert.equal(Date.parse(again.membership.expiresAt), beforeExpiry + DAY);
    const status = ok(await f.call('member.status'));
    const giftOrders = status.orders.filter(o => o.orderId === 'grant_launch_20261028');
    assert.equal(giftOrders.length, 1);
    assert.equal(giftOrders[0].source, 'service_compensation');
    assert.equal(giftOrders[0].days, 1);
    const savedGiftOrder = await f.repo.getOrder(`${userKeyOf()}|grant_launch_20261028`);
    assert.match(savedGiftOrder.note, /苹果新品发布会员赠礼/);
  }
});

test('expired previously paid member (including one compensated on 2026-10-21) gets +1 day restored on 2026-10-28, while free and trial-only users do not', async () => {
  // 1. Previously paid member who also received 2026-10-21 outage compensation and later expired
  const paidFixture = createFixture({ start: '2026-09-15T04:00:00.000Z' });
  ok(await paidFixture.call('user.bootstrap'));
  await purchase(paidFixture, 'paid-30d-old', 'member_30d');
  paidFixture.state.now = new Date('2026-10-21T04:00:00.000Z');
  ok(await paidFixture.call('user.bootstrap')); // receives grant_outage_20261021

  paidFixture.state.now = new Date(LAUNCH_GIFT_TIME);
  // Consumed older payment segments are deliberately covered by the backend
  // manifest, without scanning the payment history on every user bootstrap.
  const { manifest } = await scanLaunchGiftManifest(paidFixture.repo, { environmentId: 'offline', snapshotAt: LAUNCH_GIFT_TIME,
    cutoffExclusive: AFTER_LAUNCH_GIFT_DAY, cutoffConfirmed: true });
  await runLaunchGiftBatch(paidFixture.repo, manifest, { expectedEnvironmentId: 'offline', nowIso: LAUNCH_GIFT_TIME, dryRun: false });
  const paidBoot = ok(await paidFixture.call('user.bootstrap'));
  assert.equal(paidBoot.membership.active, true);
  assert.equal(paidBoot.membership.planId, 'member_30d');
  assert.equal(paidBoot.limits.maxFollows, 4);
  assert.equal(Date.parse(paidBoot.membership.expiresAt), Date.parse(LAUNCH_GIFT_TIME) + DAY);

  // 2. Free user who received 2026-10-21 trial compensation and never paid
  const trialFixture = createFixture({ start: '2026-10-21T04:00:00.000Z' });
  const trialOnOct21 = ok(await trialFixture.call('user.bootstrap'));
  assert.equal(trialOnOct21.membership.planId, 'member_trial');

  trialFixture.state.now = new Date(LAUNCH_GIFT_TIME);
  const trialOnOct28 = ok(await trialFixture.call('user.bootstrap'));
  assert.equal(trialOnOct28.membership.active, false);
  const trialStatus = ok(await trialFixture.call('member.status'));
  assert.equal(trialStatus.orders.some(o => o.orderId === 'grant_launch_20261028'), false);

  // 3. Brand-new free user on 2026-10-28
  const freeFixture = createFixture({ start: LAUNCH_GIFT_TIME });
  const freeBoot = ok(await freeFixture.call('user.bootstrap'));
  assert.equal(freeBoot.membership.active, false);
  assert.equal(freeBoot.membership.expiresAt, null);
});

test('background monitor loadFollowUsers extends paid member duration on 2026-10-28 and Mine page renders 新品礼遇 order label', async () => {
  const f = createFixture({ start: BEFORE_LAUNCH_GIFT });
  ok(await f.call('user.bootstrap'));
  await purchase(f, 'paid-7d-monitor-28', 'member_7d');
  ok(await f.call('follow.upsert', {
    followId: 'follow-mac-1',
    partNumber: PRODUCTS[0].partNumber,
    storeNumbers: [STORES[0].storeNumber],
  }));
  const beforeUser = await f.repo.getUser(userKeyOf());
  const beforeExpiry = Date.parse(beforeUser.membership.expiresAt);

  f.state.now = new Date(LAUNCH_GIFT_TIME);
  const follows = await f.repo.listActiveFollows();
  const users = await loadFollowUsers(f.repo, follows, f.state.now);
  const updatedUser = users.get(userKeyOf());
  assert.equal(Date.parse(updatedUser.membership.expiresAt), beforeExpiry + DAY);

  const status = ok(await f.call('member.status'));
  const boot = ok(await f.call('user.bootstrap'));
  const rt = runtime(async action => {
    if (action === 'user.bootstrap') return boot;
    if (action === 'member.status') return status;
    if (action === 'follow.list') return { follows: [] };
    return {};
  });
  const mine = rt.instance('pages/mine/index.js');
  await mine.loadOrders(true);
  const giftRow = mine.data.orders.find(o => o.orderId === 'grant_launch_20261028');
  assert.ok(giftRow);
  assert.equal(giftRow.sourceLabel, '新品礼遇');
  assert.equal(giftRow.titleText, '1 天会员 · 新品礼遇');
});

test('2026-10-28 celebration and Mac catalog announcements surface in bootstrap, query banner, and notice-board', async () => {
  const f = createFixture({ start: LAUNCH_GIFT_TIME });
  const boot = ok(await f.call('user.bootstrap'));
  assert.ok(boot.announcement);
  assert.equal(boot.announcement.title, MAC_LAUNCH_CELEBRATION_NOTICE.title);
  assert.equal(boot.announcement.kind, 'notice');
  assert.match(boot.announcement.text, /10 月 28 日.*曾付费用户.*发放 1 天会员/);
  assert.doesNotMatch(boot.announcement.text, /今日|全体会员|已发放/);

  // Secondary built-in notices (Mac catalog update + iPad mini catalog update) appear in notices list
  assert.ok(Array.isArray(boot.notices));
  assert.ok(boot.notices.some(n => n.id === MAC_CATALOG_NOTICE.id));
  assert.ok(boot.notices.some(n => n.id === IPAD_MINI_CATALOG_NOTICE.id));

  const queryBanner = resolveQueryNotice({
    announcement: boot.announcement,
    now: Date.parse(LAUNCH_GIFT_TIME),
  });
  assert.ok(queryBanner);
  assert.equal(queryBanner.tone, 'info');
  assert.match(queryBanner.text, /发放 1 天会员/);

  // Client fallback also injects celebration announcement and secondary notices if server cache was older
  const fallbackPayload = withOutageCompensationNotice(
    { serverTime: LAUNCH_GIFT_TIME, announcement: null, notices: [] },
    Date.parse(LAUNCH_GIFT_TIME),
  );
  assert.equal(fallbackPayload.announcement.title, MAC_LAUNCH_CELEBRATION_NOTICE.title);
  assert.ok(fallbackPayload.notices.some(n => n.id === MAC_CATALOG_NOTICE.id));

  // Notice-board page renders both primary celebration card and secondary Mac catalog row
  const rt = runtime(async action => {
    if (action === 'user.bootstrap') return boot;
    return {};
  });
  const board = rt.instance('pages/notice-board/index.js');
  await board.load();
  assert.equal(board.data.hasContent, true);
  assert.ok(board.data.items.some(n => n.title === MAC_LAUNCH_CELEBRATION_NOTICE.title && n.tone === 'info'));
  assert.ok(board.data.items.some(n => n.title === MAC_CATALOG_NOTICE.title));
});
