import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const boot = () => ({ identity: { isAdmin: false }, membership: { active: false }, quota: { balance: 1, queryCost: 1, historyCost: 1, tasksDoneToday: [] }, limits: { queryMaxStores: 3, maxFollows: 3, maxStoresPerFollow: 3 }, collector: { state: 'not_deployed' }, notifications: { templateIds: {} }, tasks: [], memberProduct: {} });

for (const name of ['query', 'history']) {
  test(`${name} owns independent selection state before asynchronous startup`, async () => {
    const rt = runtime(async action => {
      if (action === 'catalog.get') return { unchanged: true };
      throw Error('account offline');
    });
    const first = rt.instance(`pages/${name}/index.js`);
    const second = rt.instance(`pages/${name}/index.js`);
    const firstLoad = first.onLoad();
    const secondLoad = second.onLoad();
    assert.ok(first.selection && second.selection, 'logic state is ready before the first asynchronous result');
    assert.notEqual(first.selection, second.selection);
    assert.notEqual(first.selection.storeNumbers, second.selection.storeNumbers);
    assert.notEqual(first.selection.stores, second.selection.stores);
    first.selection.storeNumbers.push('R577');
    assert.equal(second.selection.storeNumbers.length, 0);
    assert.equal(Object.hasOwn(first.data, 'selection'), false, 'logic state stays off the rendering bridge');
    await Promise.all([firstLoad, secondLoad]);
    assert.equal(first.data.ready, true, 'the public catalog remains usable while the account is offline');
    assert.ok(first.data.accountError);
    first.onUnload(); second.onUnload();
  });
}

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
  assert.ok(page.catalog.categories.length); assert.equal(page.data.catalogVersion, page.catalog.version); assert.equal(page.data.catalog, undefined);
  resolveBoot(boot()); await pending; assert.equal(page.data.accountReady, true);
});

test('failed account connection keeps catalog visible and can retry without clearing selections', async () => {
  let fail = true;
  const rt = runtime(async action => { if (action === 'catalog.get') return { unchanged: true }; if (fail) throw Error('network'); return boot(); });
  const page = rt.instance('pages/query/index.js'); await page.onLoad();
  assert.equal(page.data.ready, true); assert.match(page.data.accountError, /连接/); assert.equal(page.data.loadError, null);
  page.selection = { partNumber: 'retained' }; fail = false; await page.onRetryAccount();
  assert.equal(page.data.accountReady, true); assert.equal(page.selection.partNumber, 'retained');
});

test('query and follow tabs reuse recent follows but a mutation invalidates the shared snapshot', async () => {
  const rt = runtime(async () => ({ follows: [] })); const store = rt.load('utils/store.js');
  await Promise.all([store.getFollows(), store.getFollows()]); await store.getFollows();
  assert.equal(rt.calls.length, 1); store.invalidateFollows(); await store.getFollows(); assert.equal(rt.calls.length, 2);
});

test('visible pages poll once per monitor minute, shortly after the recorded next run', () => {
  const { monitorPollDelay } = runtime().load('utils/poll.js');
  const now = Date.parse('2026-09-23T04:00:30.000Z');
  assert.equal(monitorPollDelay({ nextRunAt: '2026-09-23T04:01:00.000Z' }, now), 50000);
  assert.equal(monitorPollDelay({ nextRunAt: '2026-09-23T04:00:00.000Z' }, now), 50000, 'a passed run keeps the minute phase');
  assert.equal(monitorPollDelay({ nextRunAt: '2026-09-23T03:00:00.000Z' }, now), 50000);
  assert.equal(monitorPollDelay({ nextRunAt: '2026-09-23T05:00:00.000Z' }, now), 80000, 'clock skew never stretches past one period plus settle time');
  assert.equal(monitorPollDelay({ state: 'running' }, now), 60000);
  assert.equal(monitorPollDelay(null, now), 60000);
});

test('follow and query pages schedule refreshes from the monitor cadence instead of every 15 seconds', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-23T04:00:30.000Z'));
  const collector = { state: 'running', nextRunAt: '2026-09-23T04:01:00.000Z' };
  const followRt = runtime(), follow = followRt.instance('pages/follow/index.js');
  follow.data.collector = collector; follow.visible = true; follow.startPolling();
  assert.deepEqual([...followRt.timers.values()].map(timer => timer.ms), [50000]);
  follow.onHide(); assert.equal(followRt.timers.size, 0);
  const queryRt = runtime(), query = queryRt.instance('pages/query/index.js');
  query.data.collector = collector; query.visible = true; query.startFollowPolling();
  assert.deepEqual([...queryRt.timers.values()].map(timer => timer.ms), [50000]);
  query.onHide(); assert.equal(queryRt.timers.size, 0);
});

test('a downloaded new version offers a restart and uncaught errors reach the realtime log', () => {
  const rt = runtime(); let ready, applied = 0; const logged = [];
  rt.wx.getUpdateManager = () => ({ onUpdateReady: fn => { ready = fn; }, applyUpdate: () => { applied++; } });
  rt.wx.getRealtimeLogManager = () => ({ error: (...args) => logged.push(args) });
  rt.wx.showModal = options => options.success({ confirm: true });
  rt.load('app.js'); const app = rt.app;
  app.ensureCloud = () => Promise.resolve(null);
  app.onLaunch(); ready();
  assert.equal(applied, 1);
  app.onError('TypeError: boom\n    at page');
  app.onUnhandledRejection({ reason: new Error('lost') });
  assert.deepEqual(logged.map(entry => entry[0]), ['[gxs] error', '[gxs] unhandledrejection']);
  assert.match(logged[0][1], /TypeError: boom/);
});

test('known SDK-only timeouts are warnings while unknown and app rejections still report', () => {
  const rt = runtime(); const errors = [], warns = [];
  rt.wx.getRealtimeLogManager = () => ({
    error: (...args) => errors.push(args),
    warn: (...args) => warns.push(args),
  });
  rt.load('app.js'); const app = rt.app;

  // Exact shape of the WACloud.js rejection after a -601008 init timeout.
  const sdkError = Object.assign(new Error('errCode: -601008 server-side request timedout | errMsg: 请求超时'), {
    stack: 'errCode: -601008 server-side request timedout | errMsg: 请求超时\n'
      + 'success@https://lib/WACloud.js:1:266619\n'
      + 'p@https://lib/WAServiceMainContext.js:1:177155\n'
      + 'u@https://lib/WAServiceMainContext.js:1:1334349',
  });
  app.onUnhandledRejection({ reason: sdkError });
  app.onUnhandledRejection({ reason: 'server-side request timedout' });
  app.onUnhandledRejection({ reason: undefined });
  assert.equal(errors.length, 2, 'missing stacks cannot establish that a rejection is SDK-only');
  assert.equal(warns.length, 1);
  assert.equal(warns[0][0], '[gxs] sdk_timeout');
  assert.match(warns[0][1].detail, /WACloud\.js/);

  const appError = Object.assign(new Error('follow load failed'), {
    stack: 'Error: follow load failed\n    at loadFollows (pages/follow/index.js:400:5)',
  });
  app.onUnhandledRejection({ reason: appError });
  assert.equal(errors.length, 3);
  assert.equal(errors[2][0], '[gxs] unhandledrejection');
  assert.match(errors[2][1], /follow load failed/);
});
