import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const locations = [
  { storeNumber: 'R575', city: '武汉', name: '武汉武商 MALL', search: '武商 MALL' },
  { storeNumber: 'R688', city: '苏州', name: '苏州中心商场', search: '苏州中心' },
  { storeNumber: 'R670', city: '昆明', name: '昆明顺城购物中心', search: '顺城' },
  { storeNumber: 'R617', city: '长沙', name: '长沙国金中心', search: '国金' },
];
const observedAt = '2026-09-30T01:00:00.000Z';
const legacyRows = () => locations.map(s => ({ storeNumber: s.storeNumber, storeName: s.city, city: s.city, status: 'unavailable', observedAt }));

test('legacy cached and cloud catalogs restore exact stores and support shopping-center searches', async () => {
  let response;
  const rt = runtime(async () => response);
  const legacy = copy(rt.load('config/catalog-seed.js'));
  legacy.version = 'legacy-city-names';
  legacy.stores.forEach(s => { delete s.address; });
  const before = copy(legacy);
  rt.storage.set('gxs_catalog_v1', legacy);
  const store = rt.load('utils/store.js');
  const initial = store.currentCatalog();
  const product = initial.products.find(p => p.supported);
  const selected = locations.slice(0, 3).map(s => s.storeNumber);
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3 });
  picker.onCatalog(initial);
  picker.onValue({ partNumber: product.partNumber, storeNumbers: selected });
  for (const location of locations) {
    const displayed = initial.storeByNumber[location.storeNumber];
    assert.equal(displayed.name, location.name);
    assert.equal(displayed.officialName, location.city);
    assert.ok(displayed.address.includes(location.search.replace(/ MALL$/, '')));
    picker.onSearchInput({ detail: { value: location.search } });
    assert.ok(picker.data.searchResults.some(s => s.storeNumber === location.storeNumber && s.name === location.name));
  }
  assert.deepEqual(copy(picker.getSelection().storeNumbers), selected);
  assert.deepEqual(copy(picker.data.selectedStores.map(s => s.label)), locations.slice(0, 3).map(s => s.name), 'city is not repeated in selected labels');
  assert.equal(rt.calls.length, 0, 'restoring and searching stores must not query inventory');
  assert.deepEqual(legacy, before, 'presentation must not rewrite cached upstream names');

  response = { ...copy(legacy), version: 'cloud-city-names' };
  picker.onCatalog(await store.refreshCatalog());
  assert.deepEqual(copy(picker.getSelection().storeNumbers), selected);
  assert.deepEqual(copy(picker.data.selectedStores.map(s => s.name)), locations.slice(0, 3).map(s => s.name));
  response.stores.find(s => s.storeNumber === 'R575').name = '武汉新门店名称';
  response.version = 'cloud-specific-name';
  assert.equal((await store.refreshCatalog()).storeByNumber.R575.name, '武汉新门店名称', 'a specific newer upstream name takes precedence over the fallback');
});

test('saved query snapshots and historical events display locations without changing observation identities', async () => {
  const response = { ok: true, dayKey: '2026-09-30', product: { title: '测试配置' },
    latest: legacyRows(), events: legacyRows().map((s, i) => ({ ...s, id: `event-${i}`, type: 'restock_confirmed', detectedAt: observedAt, source: 'auto' })),
    summary: { available: 0, restocks: 4, recoveries: 0, ended: 0 }, pagination: { total: 4, hasMore: false },
    observationCoverage: { stores: legacyRows().map(s => ({ storeNumber: s.storeNumber, knownCount: 1, firstObservedAt: observedAt, lastObservedAt: observedAt })) },
  };
  const original = copy(response);
  const rt = runtime(async () => response);
  const catalog = rt.load('utils/store.js').currentCatalog();
  const query = rt.instance('pages/query/index.js');
  query.catalog = catalog;
  query.querySnapshot = { queriedAt: observedAt, results: legacyRows().slice(0, 3) };
  query.data.result = copy(query.querySnapshot);
  query.refreshQuerySnapshot();
  assert.deepEqual(copy(query.data.result.results.map(s => s.storeName)), locations.slice(0, 3).map(s => s.name));
  assert.equal(query.data.result.queriedAt, observedAt);
  assert.ok(query.data.result.results.every(s => s.observedAt === observedAt));
  assert.equal(rt.calls.length, 0);

  const history = rt.instance('pages/history/index.js');
  history.catalog = catalog;
  history.data.boot = { member: true };
  history.selection = { partNumber: catalog.products.find(p => p.supported).partNumber, storeNumbers: [] };
  await history.onQuery();
  for (const field of ['events', 'latest', 'coverageStores']) assert.deepEqual(copy(history.data.result[field].map(s => s.storeName)), locations.map(s => s.name));
  assert.deepEqual(copy(history.data.result.events.map(s => s.id)), original.events.map(s => s.id));
  assert.deepEqual(response, original);
});

test('existing follows, reminder records and reminder landing cards show the same locations', async () => {
  const follow = { followId: 'follow-existing', partNumber: 'SKU-A', productTitle: '测试配置', status: 'active', stores: legacyRows().slice(0, 3) };
  const notifications = legacyRows().map((s, i) => ({ ...s, id: `notification-${i}`, eventId: `event-${i}`, status: 'accepted', eventType: 'restock_confirmed', productTitle: '测试配置', partNumber: 'SKU-A', detectedAt: observedAt, createdAt: observedAt }));
  const rt = runtime(async action => {
    if (action === 'follow.list') return { follows: [follow], limits: { maxFollows: 3, maxStoresPerFollow: 3 } };
    if (action === 'notify.list') return { notifications, hasMore: false };
    if (action === 'notify.detail') return { notification: notifications[0], latest: legacyRows()[0], follow };
    throw Error(`Unexpected action: ${action}`);
  });
  const page = rt.instance('pages/follow/index.js');
  page.catalog = rt.load('utils/store.js').currentCatalog();
  page.data.boot = { member: true };
  page.data.ready = true;
  await page.loadFollows();
  assert.equal(page.data.follows[0].followId, follow.followId);
  assert.deepEqual(copy(page.data.follows[0].stores.map(s => s.storeName)), locations.slice(0, 3).map(s => s.name));
  assert.deepEqual(copy(page.data.follows[0].stores.map(s => s.storeLabel)), locations.slice(0, 3).map(s => s.name));

  rt.app.globalData.pendingAlert = notifications[0].eventId;
  rt.app.globalData.handledAlerts = [];
  await page.consumePendingAlert();
  assert.equal(page.data.alert.storeName, locations[0].name);
  assert.equal(page.data.alert.eventId, notifications[0].eventId);

  const mine = rt.instance('pages/mine/index.js');
  await mine.loadNotifications();
  assert.deepEqual(copy(mine.data.notifications.map(s => s.storeName)), locations.map(s => s.name));
  assert.deepEqual(copy(mine.data.notifications.map(s => s.id)), notifications.map(s => s.id));
  assert.deepEqual(follow.stores, legacyRows().slice(0, 3));
});
