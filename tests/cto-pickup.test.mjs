import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createFixture, operatorContext, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { ctoPartNumber, resolvePickupTarget, canQueryProduct, canMonitorProduct } = require('../cloudfunctions/gxs_api/lib/rules/product-target');
const { buildPickupUrl, parseApplePickup, fetchPickup } = require('../cloudfunctions/gxs_api/lib/apple-pickup');
const { toProductDoc } = require('../cloudfunctions/gxs_api/lib/services/catalog');
const { buildGroups } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const source = JSON.parse(fs.readFileSync(new URL('../evidence/catalog/2026-10-30/mac-studio-cto-research.json', import.meta.url)));
const at = '2026-09-15T02:00:00.000Z';
const family = { displayName: 'Mac Studio', supported: true, pickupVerification: { verified: true, status: 'available' } };
const sourceProduct = (index, monitor = false) => {
  const selected = source.configurationResponses[index].response.body.selectedKits;
  const pickupTarget = { kind: 'apple_cto', containerPartNumber: selected.aosContainerPartNumber, optionIds: Object.values(selected.productConfiguration) };
  const attrs = selected.dimensions;
  return { partNumber: ctoPartNumber(pickupTarget), targetType: 'apple_cto', pickupTarget, category: 'mac', familyKey: 'mac-studio',
    title: 'Mac Studio exact configured test target', model: 'Mac Studio', attributes: { memory: attrs['memory-dimensionMemory'].dimensionValue.toUpperCase(), capacity: attrs['storage-dimensionCapacity'].dimensionValue.toUpperCase() },
    querySupported: true, pickupVerification: { verified: monitor, status: monitor ? 'available' : 'unverified' } };
};
const productA = toProductDoc(sourceProduct(0), family), productB = toProductDoc(sourceProduct(1), family);
const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response.data; };
const query = (product, suffix) => ({ queryId: 'cto-query-' + suffix, partNumber: product.partNumber, storeNumbers: ['R577'] });
// Simulated transport fixtures exercise the official frontend schema; these
// are deliberately not claims of a successful live Apple pickup response.
function fulfillment(product, display = 'available', key = resolvePickupTarget(product).responseKey) {
  return { head: { status: '200' }, body: { content: { pickupMessage: { stores: [{ storeNumber: 'R577', storeName: '天环广场',
    partsAvailability: { [key]: { partNumber: product.pickupTarget.containerPartNumber, pickupDisplay: display, pickupSearchQuote: '模拟取货结果', messageTypes: { regular: { storePickupProductTitle: product.title } } } },
  }] } } } };
}
const target = product => ({ ...product, storeNumber: 'R577' });

test('CTO identity includes every canonical option and refuses missing, duplicate or mismatched catalog targets', () => {
  assert.equal(ctoPartNumber({ ...productA.pickupTarget, optionIds: [...productA.pickupTarget.optionIds].reverse() }), productA.partNumber);
  assert.notEqual(productA.partNumber, productB.partNumber);
  assert.throws(() => ctoPartNumber({ ...productA.pickupTarget, optionIds: productA.pickupTarget.optionIds.slice(1) }), /invalid_cto_pickup_target/);
  assert.throws(() => ctoPartNumber({ ...productA.pickupTarget, optionIds: Array(8).fill('065-CLQ2') }), /invalid_cto_pickup_target/);
  assert.throws(() => resolvePickupTarget({ ...productA, pickupTarget: productB.pickupTarget }), /cto_identity_mismatch/);
  assert.equal(canQueryProduct(productA), true);
  assert.equal(canQueryProduct({ ...productA, comingSoon: true }), false, 'a prelaunch configuration cannot be queried');
  assert.equal(canQueryProduct({ partNumber: 'MHL64CH/A', supported: true, comingSoon: true }), false,
    'retail and CTO capability checks agree that comingSoon blocks queries');
  assert.equal(canMonitorProduct(productA), false, 'family pickup verification never grants CTO monitoring');
  assert.equal(productA.supported, false);
  assert.equal(canQueryProduct({ ...productA, pickupTarget: productB.pickupTarget }), false);
});

test('configured request uses the complete official options and reconciles the exact configured map key', async () => {
  const url = buildPickupUrl('R577', [productB.partNumber], [productB]);
  assert.equal(url.origin + url.pathname, 'https://www.apple.com.cn/shop/fulfillment-messages');
  assert.equal(url.searchParams.get('fae'), 'true');
  assert.equal(url.searchParams.get('parts.0'), productB.pickupTarget.containerPartNumber);
  assert.deepEqual(url.searchParams.get('option.0').split(','), [...productB.pickupTarget.optionIds].sort());
  assert.equal(url.searchParams.get('mts.0'), 'regular');
  assert.equal(url.searchParams.get('store'), 'R577');
  assert.throws(() => buildPickupUrl('R577', [productB.partNumber]), /missing_cto_catalog_product/);
  assert.throws(() => buildPickupUrl('R577', [productA.partNumber, productB.partNumber], [productA, productB]), /individual_request/);
  const parsed = parseApplePickup({ httpStatus: 200, body: fulfillment(productB), targets: [target(productB)], observedAt: at });
  assert.equal(parsed[0].status, 'available'); assert.equal(parsed[0].partNumber, productB.partNumber);
  for (const body of [fulfillment(productA), fulfillment(productB, 'available', productB.pickupTarget.containerPartNumber), { head: { status: '200' }, body: { stores: [] } }]) {
    const [row] = parseApplePickup({ httpStatus: 200, body, targets: [target(productB)], observedAt: at });
    assert.equal(row.status, 'unknown');
  }
  let calls = 0;
  const result = await fetchPickup({ storeNumber: 'R577', partNumbers: [productB.partNumber], products: [productB], now: () => new Date(at),
    fetchImpl: async (request, options) => { calls++; assert.equal(options.redirect, 'manual'); assert.equal(request.href, url.href); return new Response(JSON.stringify(fulfillment(productB)), { status: 200 }); } });
  assert.equal(calls, 1); assert.equal(result.observations[0].partNumber, productB.partNumber); assert.equal(result.observations[0].status, 'available');
});

test('unverified CTO can perform a real query attempt; HTTP 541 records unknown and refunds without changing target', async () => {
  const calls = [];
  const f = createFixture({ products: [productB], fetchImpl: async request => { calls.push(request); return new Response('access denied', { status: 541 }); } });
  ok(await f.call('user.bootstrap', {})); ok(await f.call('quota.signin', {}));
  const balance = (await f.repo.getUser(userKeyOf())).quota.balance;
  const result = ok(await f.call('query.pickup', { ...query(productB, 'blocked'), pickupTarget: productA.pickupTarget, optionIds: ['ATTACK'] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('option.0'), [...productB.pickupTarget.optionIds].sort().join(','), 'payload options cannot override the catalog');
  assert.equal(result.ok, false); assert.equal(result.results[0].status, 'unknown');
  assert.equal(result.results[0].reason.code, 'http_error'); assert.equal(result.results[0].partNumber, productB.partNumber);
  assert.equal(result.charged - result.refunded, 0); assert.equal(result.balance, balance);
  const latest = await f.repo.getLatest(['R577|' + productB.partNumber]);
  assert.equal(latest.length, 1); assert.ok(latest[0].unknownSince);
  assert.equal((await f.repo.listProducts()).length, 1);
});

test('unknown or corrupted CTO identities cannot reach HTTP or debit by supplying matching-looking payload options', async () => {
  const corrupted = { ...productB, pickupTarget: productA.pickupTarget };
  let calls = 0;
  const f = createFixture({ products: [corrupted], fetchImpl: async () => { calls++; throw Error('must not fetch'); } });
  ok(await f.call('user.bootstrap', {})); ok(await f.call('quota.signin', {}));
  const balance = (await f.repo.getUser(userKeyOf())).quota.balance;
  const unknown = await f.call('query.pickup', query(productA, 'unlisted'));
  assert.equal(unknown.error.code, 'unknown_product');
  const denied = ok(await f.call('query.pickup', query(corrupted, 'corrupted')));
  assert.equal(denied.reason, 'unsupported_product'); assert.equal(denied.balance, balance);
  assert.equal(calls, 0);
});

test('different options on one container have separate shared samples, observations and history', async () => {
  const calls = [];
  const f = createFixture({ config: { query: { sharedFreshnessSeconds: 10 } }, products: [productA, productB], fetchImpl: async request => {
    calls.push(request);
    const product = request.searchParams.get('option.0') === [...productA.pickupTarget.optionIds].sort().join(',') ? productA : productB;
    return new Response(JSON.stringify(fulfillment(product, product === productA ? 'available' : 'unavailable')), { status: 200 });
  } });
  ok(await f.call('user.bootstrap', {}));
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'cto-query-member' }, operatorContext()));
  const a = ok(await f.call('query.pickup', query(productA, 'variant-a'))), b = ok(await f.call('query.pickup', query(productB, 'variant-b')));
  assert.equal(a.results[0].status, 'available'); assert.equal(b.results[0].status, 'unavailable'); assert.equal(calls.length, 2);
  const shared = ok(await f.call('query.pickup', query(productA, 'variant-a-cached')));
  assert.equal(shared.allShared, true); assert.equal(shared.results[0].status, 'available'); assert.equal(calls.length, 2);
  assert.equal((await f.repo.getLatest(['R577|' + productA.partNumber, 'R577|' + productB.partNumber])).length, 2);
  const history = ok(await f.call('history.list', { historyQueryId: 'cto-history-variant-b', partNumber: productB.partNumber, storeNumbers: ['R577'], dayKey: '2026-09-15' }));
  assert.equal(history.ok, true); assert.equal(history.product.partNumber, productB.partNumber);
  assert.equal(history.summary.available, 0); assert.equal(history.latest[0].status, 'unavailable');
});

test('CTO monitoring requires its own capability; eligible configured targets use distinct budgeted groups', async () => {
  const verified = toProductDoc(sourceProduct(1, true), family);
  const f = createFixture({ products: [productA, verified], config: { collector: { enabled: true, intervalSeconds: 1 }, notifications: { enabled: false } },
    fetchImpl: async () => new Response(JSON.stringify(fulfillment(verified, 'unavailable')), { status: 200 }) });
  ok(await f.call('user.bootstrap', {}));
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'cto-follow-member' }, operatorContext()));
  const rejected = await f.call('follow.upsert', { followId: 'cto-follow-unverified', partNumber: productA.partNumber, storeNumbers: ['R577'] });
  assert.equal(rejected.error.code, 'unsupported_product');
  const followed = ok(await f.call('follow.upsert', { followId: 'cto-follow-verified', partNumber: verified.partNumber, storeNumbers: ['R577'] }));
  assert.equal(followed.follow.partNumber, verified.partNumber);
  const saved = (await f.repo.listFollows(userKeyOf()))[0];
  await f.repo.saveFollow({ ...saved, _id: userKeyOf() + '|cto-follow-injected', partNumber: productA.partNumber });
  const collector = createCollector({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => f.state.now, log: { info() {}, error() {}, warn() {} }, ownerId: 'cto-test-collector' });
  const summary = await collector.refreshTargets();
  assert.equal(summary.eligible, 1); assert.equal(summary.groups, 1);
  const { started } = await collector.step(); await Promise.all(started);
  const latest = await f.repo.getLatest(['R577|' + verified.partNumber]);
  assert.equal(latest[0].source, 'auto'); assert.equal(latest[0].status, 'unavailable');
  assert.equal((await f.repo.getLatest(['R577|' + productA.partNumber])).length, 0);
  const groups = buildGroups([{ partNumber: productA.partNumber, storeNumbers: ['R577'] }, { partNumber: verified.partNumber, storeNumbers: ['R577'] }, { partNumber: 'MHL64CH/A', storeNumbers: ['R577'] }]);
  assert.equal(groups.length, 3); assert.ok(groups.every(group => group.partNumbers.length === 1));
  // Monitoring capability changes are authoritative on both resume and refresh.
  f.repo.tables.get(C.catalogProducts).set(verified.partNumber, { ...verified, monitorSupported: false, supported: false });
  await f.call('follow.pause', { followId: followed.follow.followId });
  const resume = await f.call('follow.resume', { followId: followed.follow.followId });
  assert.equal(resume.error.code, 'unsupported_product');
});
