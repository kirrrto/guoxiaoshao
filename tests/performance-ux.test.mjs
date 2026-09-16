import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const boot = () => ({ identity: { isAdmin: false }, membership: { active: false }, quota: { balance: 1, queryCost: 1, historyCost: 1, tasksDoneToday: [] }, limits: { queryMaxStores: 3, maxFollows: 3, maxStoresPerFollow: 3 }, collector: { state: 'not_deployed' }, notifications: { templateIds: {} }, tasks: [], memberProduct: {} });

test('cold catalog is usable while cloud is unresolved and concurrent callers share one refresh', async () => {
  let resolve;
  const rt = runtime(() => new Promise(r => { resolve = r; }));
  const store = rt.load('utils/store.js');
  const catalogs = await Promise.all([store.getCatalog(), store.getCatalog(), store.getCatalog()]);
  assert.equal(catalogs[0].products.length, 292);
  assert.equal(catalogs[0], catalogs[1]);
  assert.equal(rt.calls.length, 1);
  resolve({ unchanged: true });
});

test('catalog refresh publishes once and unchanged versions keep the same render reference', async () => {
  let resolve;
  const rt = runtime(() => new Promise(r => { resolve = r; }));
  const store = rt.load('utils/store.js'); let changes = 0;
  const unsubscribe = store.subscribeCatalog(() => changes++);
  await store.getCatalog();
  const pending = store.refreshCatalog();
  resolve({ version: 'updated', stores: [], products: [] });
  const updated = await pending;
  assert.equal(changes, 1);
  const next = store.refreshCatalog(); resolve({ unchanged: true });
  assert.equal(await next, updated); assert.equal(changes, 1); unsubscribe();
});

test('rapid tab account reads reuse one fresh bootstrap; explicit invalidation fetches again', async () => {
  const rt = runtime(async () => boot()); const store = rt.load('utils/store.js');
  await Promise.all([store.getBootstrap(), store.getBootstrap(), store.getBootstrap()]);
  await store.getBootstrap(); await store.getBootstrap();
  assert.equal(rt.calls.length, 1);
  store.invalidateBootstrap(); await store.getBootstrap(); assert.equal(rt.calls.length, 2);
});

test('late catalog response cannot overwrite a newly selected real or acceptance session', async () => {
  const resolves = [];
  const rt = runtime(() => new Promise(resolve => resolves.push(resolve)));
  const store = rt.load('utils/store.js'); const published = [];
  store.subscribeCatalog(catalog => published.push(catalog.version));
  const old = store.refreshCatalog();
  store.resetSession();
  const current = store.refreshCatalog();
  resolves[1]({ version: 'new-session', stores: [], products: [] });
  await current;
  resolves[0]({ version: 'old-session', stores: [], products: [] });
  assert.equal((await old).version, 'new-session');
  assert.equal((await store.getCatalog()).version, 'new-session');
  assert.equal(rt.storage.get('gxs_catalog_v1').version, 'new-session');
  assert.deepEqual(published, ['new-session']);
});

test('expired membership cannot remain active merely because the account cache is fresh', async () => {
  let count = 0;
  const rt = runtime(async () => { const b = boot(); if (++count === 1) b.membership = { active: true, expiresAt: '2000-01-01T00:00:00Z' }; return b; });
  const store = rt.load('utils/store.js'); await store.getBootstrap();
  assert.equal((await store.getBootstrap()).membership.active, false); assert.equal(count, 2);
});

test('query page paints selectable public catalog before slow account authentication finishes', async () => {
  let resolveBoot;
  const rt = runtime(action => action === 'user.bootstrap' ? new Promise(r => { resolveBoot = r; }) : new Promise(() => {}));
  const page = rt.instance('pages/query/index.js'); const pending = page.onLoad();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(page.data.ready, true); assert.equal(page.data.accountReady, false);
  assert.ok(page.data.catalog.categories.length); assert.equal(page.data.catalog.productByPart, undefined);
  resolveBoot(boot()); await pending; assert.equal(page.data.accountReady, true);
});

test('failed account connection keeps catalog visible and can retry without clearing selections', async () => {
  let fail = true;
  const rt = runtime(async action => { if (action === 'catalog.get') return { unchanged: true }; if (fail) throw Error('network'); return boot(); });
  const page = rt.instance('pages/query/index.js'); await page.onLoad();
  assert.equal(page.data.ready, true); assert.match(page.data.accountError, /连接/); assert.equal(page.data.loadError, null);
  page.data.selection = { partNumber: 'retained' }; fail = false; await page.onRetryAccount();
  assert.equal(page.data.accountReady, true); assert.equal(page.data.selection.partNumber, 'retained');
});

test('query and follow tabs reuse recent follows but a mutation invalidates the shared snapshot', async () => {
  const rt = runtime(async () => ({ follows: [] })); const store = rt.load('utils/store.js');
  await Promise.all([store.getFollows(), store.getFollows()]); await store.getFollows();
  assert.equal(rt.calls.length, 1); store.invalidateFollows(); await store.getFollows(); assert.equal(rt.calls.length, 2);
});
