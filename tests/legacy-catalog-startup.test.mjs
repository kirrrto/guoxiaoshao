import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const legacyValue = value => vm.runInNewContext('Array.prototype.flatMap = undefined; JSON.parse(input)', { input: JSON.stringify(value) });

test('first launch still paints a usable offline catalog when Object.fromEntries is unavailable', async t => {
  const evaluate = vm.runInNewContext;
  t.mock.method(vm, 'runInNewContext', (source, context, options) =>
    evaluate(`Object.fromEntries = undefined;\n${source}`, context, options));
  const rt = runtime(async action => {
    if (action === 'catalog.get') return { unchanged: true };
    throw Error('account offline');
  });
  const page = rt.instance('pages/query/index.js');
  await page.onLoad();
  assert.equal(page.data.ready, true);
  assert.equal(page.data.loadError, null);
  assert.equal(page.data.accountReady, false);
  assert.ok(page.catalog.categories.length > 0);
  assert.ok(page.catalog.products.length > 0);
  assert.ok(page.catalog.cities.length > 0);
  assert.equal(page.catalog.categories[0].families[0].name.length > 0, true);
  page.onUnload();
});

test('follow summaries and alternative stores work without Array.prototype.flatMap', async () => {
  const now = new Date().toISOString();
  const stores = legacyValue([
    { storeNumber: 'R577', name: '天环广场', city: '广州', province: '广东' },
    { storeNumber: 'R639', name: '珠江新城', city: '广州', province: '广东' },
  ]);
  const follows = legacyValue([{ status: 'active', followId: 'follow-1', productTitle: '测试配置',
    stores: [{ storeNumber: 'R577', status: 'available', observedAt: now, knownAt: now }] }]);
  const rt = runtime(async () => ({ follows }));
  const page = rt.instance('pages/query/index.js');
  page.data.boot = { member: true, followCount: 1 }; page.visible = true;
  page.startFollowPolling();
  for (let i = 0; i < 16; i++) await Promise.resolve();
  assert.equal(page.data.followTargets.length, 1);
  assert.equal(page.data.followRefreshError, false);
  page.onHide();

  const choices = rt.load('utils/alternative-rules.js').storeChoices(stores, legacyValue(['R577']));
  assert.deepEqual(Array.from(choices, item => item.storeNumber), ['R577', 'R639']);
  const catalog = { productByPart: { SKU: { partNumber: 'SKU', supported: true } }, storeByNumber: { R577: stores[0] } };
  const snapshot = legacyValue({ ok: true, product: { partNumber: 'SKU' }, results: [{ storeNumber: 'R577', status: 'available', observedAt: now, knownAt: now }] });
  const observed = rt.load('utils/observation-insights.js').availableStoreChoices(snapshot, catalog, { membership: { active: true } });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].storeNumber, 'R577');
});
