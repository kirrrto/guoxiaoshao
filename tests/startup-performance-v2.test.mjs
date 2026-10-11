import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const boot = () => ({ identity: { userKey: 'performance-user' }, membership: { active: false },
  quota: { balance: 1, queryCost: 1, historyCost: 1, signedInToday: true, tasksDoneToday: [] },
  limits: { queryMaxStores: 3, maxFollows: 3, maxStoresPerFollow: 3 },
  collector: { state: 'not_deployed' }, notifications: { templateIds: {} }, tasks: [], memberProduct: {} });

test('native launch yields cloud SDK work and uses asynchronous launch storage while callers share the connection', async () => {
  const rt = runtime(), tasks = [], reads = [], writes = [];
  let constructed = 0;
  rt.wx.nextTick = callback => tasks.push(callback);
  rt.wx.getStorage = options => reads.push(options);
  rt.wx.setStorage = options => { writes.push(options); options.success(); };
  rt.wx.getStorageSync = rt.wx.setStorageSync = () => { throw Error('synchronous launch storage'); };
  rt.wx.cloud = { Cloud: class { constructor() { constructed++; } init() { return Promise.resolve(); } } };
  rt.load('app.js');
  rt.app.onLaunch({ scene: 1001 }); rt.app.onShow({ scene: 1001 });
  const pending = rt.app.ensureCloud();
  assert.equal(pending, rt.app.cloudReady);
  assert.equal(constructed, 0, 'SDK construction does not run in the launch/show synchronous task');
  assert.equal(reads.length, 1);
  reads[0].success({ data: 1 });
  await rt.app.launchCountReady;
  assert.equal(rt.app.globalData.launchCount, 2);
  assert.equal(writes[0].data, 2);
  for (const task of tasks.splice(0)) task();
  assert.equal(await pending, rt.app.globalData.cloud);
  assert.equal(constructed, 1);
  assert.equal(rt.timers.size, 0);
});

test('native UI cache coalesces reads and late snapshots cannot undo a user save', async () => {
  const rt = runtime(), reads = [];
  rt.wx.getStorage = options => reads.push(options);
  rt.wx.setStorage = options => options.success();
  const cache = rt.load('utils/session.js');
  const first = cache.readSession('selection'), second = cache.readSession('selection');
  assert.equal(first, second);
  assert.equal(reads.length, 1);
  const changed = { partNumber: 'new-choice' };
  await cache.writeSession('selection', changed);
  reads[0].success({ data: { partNumber: 'old-choice' } });
  assert.equal(await first, changed);
  assert.equal(await cache.readSession('selection'), changed);
  assert.equal(reads.length, 1);
  assert.equal(rt.timers.size, 0);
});

test('lost native cache callbacks have a deadline and a late callback cannot revive a stale value', async () => {
  const rt = runtime(), reads = [];
  rt.wx.getStorage = options => reads.push(options);
  const cache = rt.load('utils/session.js');
  const pending = cache.readSession('selection');
  assert.equal([...rt.timers.values()][0].ms, 1200);
  await rt.nextTimer();
  assert.equal(await pending, null);
  reads[0].success({ data: 'old-choice' });
  assert.equal(await cache.readSession('selection'), null);
  assert.equal(reads.length, 1);
});

test('rapid native cache saves reach disk in order while the latest value is immediately readable', async () => {
  const rt = runtime(), writes = [];
  rt.wx.setStorage = options => writes.push(options);
  const cache = rt.load('utils/session.js');
  const first = cache.writeSession('selection', 'first');
  const last = cache.writeSession('selection', 'last');
  assert.equal(writes.length, 1);
  assert.equal(await cache.readSession('selection'), 'last');
  writes[0].success(); await first; await settle();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].data, 'last');
  writes[1].success(); await last;
});

test('a cached catalog loads asynchronously once and concurrent pages share one indexed snapshot and refresh', async () => {
  const rt = runtime(async () => ({ unchanged: true })), reads = [];
  rt.wx.getStorage = options => reads.push(options);
  rt.wx.getStorageSync = () => { throw Error('synchronous catalog read'); };
  const store = rt.load('utils/store.js');
  store.currentCatalog(); // A picker may request the packaged seed before hydration.
  const pending = [store.getCatalog(), store.getCatalog(), store.getCatalog()];
  assert.equal(reads.length, 1);
  reads[0].success({ data: { version: 'persisted-catalog', stores: [], products: [] } });
  const results = await Promise.all(pending); await settle();
  assert.equal(results[0].version, 'persisted-catalog');
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0].payload.ifVersion, 'persisted-catalog');
  await store.getCatalog();
  assert.equal(reads.length, 1);
});

test('legacy catalog storage is still read only once across indexing and forced refreshes', async () => {
  const rt = runtime(async () => ({ unchanged: true }));
  let reads = 0;
  const original = rt.wx.getStorageSync;
  rt.wx.getStorageSync = key => { if (key === 'gxs_catalog_v1') reads++; return original(key); };
  const store = rt.load('utils/store.js');
  store.currentCatalog(); await store.getCatalog(); await store.refreshCatalog(); await store.refreshCatalog();
  assert.equal(reads, 1);
});

for (const name of ['query', 'history']) {
  test(`${name} restores native UI caches without synchronous storage in page startup`, async () => {
    const rt = runtime(async action => action === 'user.bootstrap' ? boot() : action === 'catalog.get' ? { unchanged: true } : {});
    const reads = [], syncReads = [];
    rt.wx.getStorage = options => { reads.push(options.key); queueMicrotask(() => options.fail()); };
    rt.wx.getStorageSync = key => { syncReads.push(key); return null; };
    const page = rt.instance(`pages/${name}/index.js`);
    await page.onLoad();
    assert.equal(page.data.ready, true);
    assert.equal(page.data.accountReady, true);
    assert.ok(reads.includes(`gxs_${name}_selection_v1`));
    assert.equal(reads.filter(key => key === 'gxs_catalog_v1').length, 1);
    assert.equal(syncReads.some(key => /gxs_(query|history|catalog|add_tip)/.test(key)), false);
    page.onUnload();
  });
}
