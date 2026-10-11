import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCheckoutContext, TTL_MS, STORAGE_PREFIX } = require('../miniprogram/utils/checkout-context');
const a = { userKey: 'account:a' }, b = { userKey: 'account:b' };
const catalog = { version: 'v1', products: [{ partNumber: 'SKU-A', title: '真实目录配置', supported: true, imageUrl: 'https://example.test/product.png' }],
  stores: [{ storeNumber: 'R001', name: '甲店', city: '上海' }, { storeNumber: 'R002', name: '乙店', city: '北京' }] };
const target = { partNumber: 'SKU-A', storeNumbers: ['R002', 'R001'], title: '不能保存的UI文案', priceFen: 1, loginCode: 'secret', inventory: 'available' };
function runtime() {
  const storage = new Map(); let time = 1000;
  const wx = { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key) };
  const make = () => createCheckoutContext({ wx, now: () => time });
  return { storage, wx, make, controller: make(), advance: delta => { time += delta; } };
}
test('checkout survives a restart with account isolation, canonical target identity and minimal storage fields', () => {
  const rt = runtime(), saved = rt.controller.save(a, target, catalog, { entryPoint: 'query_result' });
  assert.equal(saved.ok, true);
  assert.equal(saved.context.title, '真实目录配置');
  assert.equal(saved.context.targetSignature, 'SKU-A|R001,R002');
  assert.equal(saved.context.storeText, '上海 · 甲店、北京 · 乙店');
  assert.equal(rt.make().restore(a, catalog).context.targetSignature, saved.context.targetSignature);
  assert.equal(rt.make().restore(b, catalog).status, 'empty');
  const stored = [...rt.storage.values()][0];
  assert.deepEqual(Object.keys(stored).sort(), ['catalogVersion', 'createdAt', 'entryPoint', 'expiresAt', 'partNumber', 'revision', 'schemaVersion', 'storeNumbers', 'targetSignature'].sort());
  assert.doesNotMatch(JSON.stringify(stored), /secret|inventory|priceFen|title|account:a/);
});
test('exact 24 hour TTL, changed catalog, removed store and unsupported product all require reconfirmation', () => {
  const rt = runtime(); rt.controller.save(a, target, catalog);
  rt.advance(TTL_MS - 1); assert.equal(rt.controller.restore(a, catalog).status, 'ready');
  rt.advance(1); assert.equal(rt.controller.restore(a, catalog).status, 'expired');
  rt.controller.save(a, target, catalog);
  assert.equal(rt.controller.restore(a, { ...catalog, version: 'v2' }).status, 'catalog_changed');
  assert.equal(rt.controller.restore(a, { ...catalog, stores: catalog.stores.slice(0, 1) }).status, 'catalog_changed');
  assert.equal(rt.controller.restore(a, { ...catalog, products: [{ ...catalog.products[0], supported: false }] }).status, 'catalog_changed');
  assert.equal(rt.controller.restore(a, { ...catalog, products: [{ ...catalog.products[0], comingSoon: true }] }).status, 'catalog_changed');
});
test('invalid targets and corrupted signatures cannot become a recoverable purchase intent', () => {
  const rt = runtime();
  for (const invalid of [{ ...target, partNumber: 'missing' }, { ...target, storeNumbers: [] }, { ...target, storeNumbers: ['R001', 'R001'] }, { ...target, storeNumbers: ['missing'] }]) {
    assert.equal(rt.controller.save(a, invalid, catalog).ok, false);
  }
  rt.controller.save(a, target, catalog);
  const key = STORAGE_PREFIX + encodeURIComponent(a.userKey);
  rt.storage.set(key, { ...rt.storage.get(key), partNumber: 'OTHER' });
  assert.equal(rt.controller.restore(a, catalog).status, 'invalid');
});
test('completion clears only the revision it saved and cannot erase a newer or another account intent', () => {
  const rt = runtime();
  const first = rt.controller.save(a, target, catalog).context;
  rt.controller.save(b, target, catalog);
  const second = rt.controller.save(a, { ...target, storeNumbers: ['R001'] }, catalog).context;
  assert.ok(second.revision > first.revision);
  assert.equal(rt.controller.clear(a, first.revision), false);
  assert.equal(rt.controller.restore(a, catalog).context.revision, second.revision);
  assert.equal(rt.controller.clear(a, second.revision), true);
  assert.equal(rt.controller.restore(b, catalog).status, 'ready');
  const third = rt.make().save(a, target, catalog).context;
  assert.ok(third.revision > second.revision);
  assert.equal(rt.controller.clear(a, second.revision), false);
});
test('failed persistence cannot report the selected target as safely retained', () => {
  const rt = runtime(); rt.wx.setStorageSync = () => {};
  assert.deepEqual(rt.make().save(a, target, catalog), { ok: false, reason: 'storage_failed' });
  rt.wx.getStorageSync = () => { throw Error('offline'); };
  assert.equal(rt.make().restore(a, catalog).status, 'storage_failed');
  assert.equal(rt.make().clear(a), false);
});
