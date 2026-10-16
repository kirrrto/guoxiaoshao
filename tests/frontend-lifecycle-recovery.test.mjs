import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const seed = require('../miniprogram/config/catalog-seed.js');
const product = seed.products.find(p => p.supported);
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const boot = active => ({ membership: { active }, quota: { balance: 4, queryCost: 1, historyCost: 1, signedInToday: true, tasksDoneToday: [] },
  limits: { queryMaxStores: 3, maxStoresPerFollow: 3, maxFollows: 3 }, collector: { state: 'running' }, followCount: 0, tasks: [] });

test('late completion only clears its own query recovery ID, preserving a newer uncertain request', () => {
  const rt = runtime(), operations = rt.load('utils/operation.js');
  for (const kind of ['q', 'h']) {
    const first = operations.begin(kind, { partNumber: 'FIRST', storeNumbers: ['R577'] });
    const second = operations.begin(kind, { partNumber: 'SECOND', storeNumbers: ['R577'] });
    operations.finish(kind, first);
    assert.equal(operations.begin(kind, { partNumber: 'SECOND', storeNumbers: ['R577'] }), second);
    operations.finish(kind, second);
    assert.notEqual(operations.begin(kind, { partNumber: 'SECOND', storeNumbers: ['R577'] }), second);
  }
});

test('invalidated follow reads resolve to current membership and follow state, including late failures', async () => {
  for (const failed of [false, true]) {
    const old = deferred(); let reads = 0;
    const current = { follows: [{ followId: 'f1', status: 'active' }] };
    const rt = runtime(() => ++reads === 1 ? old.promise : current), store = rt.load('utils/store.js');
    const pending = store.getFollows();
    store.invalidateFollows();
    assert.deepEqual(await store.getFollows(), current);
    if (failed) old.reject(Object.assign(Error('old network failure'), { code: 'call_failed' }));
    else old.resolve({ follows: [{ followId: 'f1', status: 'expired' }] });
    assert.deepEqual(await pending, current);
    assert.equal(reads, 2, 'the already-fresh snapshot satisfies the invalidated reader');
  }
});

test('a failed account read from before membership confirmation resolves to the refreshed membership', async () => {
  const old = deferred(); let reads = 0;
  const rt = runtime(() => ++reads === 1 ? old.promise : boot(true)), store = rt.load('utils/store.js');
  const pending = store.getBootstrap();
  store.invalidateBootstrap();
  assert.equal((await store.getBootstrap()).membership.active, true);
  old.reject(Object.assign(Error('outdated account connection failed'), { code: 'call_failed' }));
  assert.equal((await pending).membership.active, true);
  assert.equal(reads, 2);
});

test('retired query and history pages ignore late query responses without losing a newer recovery ID', async () => {
  for (const name of ['query', 'history']) {
    const pending = deferred();
    const action = name === 'query' ? 'query.pickup' : 'history.list';
    const kind = name === 'query' ? 'q' : 'h';
    const rt = runtime(current => current === action ? pending.promise : {});
    const page = rt.instance(`pages/${name}/index.js`);
    page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: { R577: { storeNumber: 'R577', name: '天环广场' } } };
    page.selection = { partNumber: product.partNumber, product, storeNumbers: ['R577'] };
    page.data.boot = { member: true, balance: 4, queryCost: 1, historyCost: 1 };
    const reading = page.onQuery();
    page.onUnload();
    const snapshot = clone(page.data);
    const operations = rt.load('utils/operation.js'), newer = { partNumber: 'SECOND', storeNumbers: ['R577'] };
    const newerId = operations.begin(kind, newer);
    pending.resolve({ ok: true, balance: 4, product, queriedAt: new Date().toISOString(), results: [],
      dayKey: page.data.dayKey, latest: [], summary: {}, events: [], pagination: { hasMore: false, total: 0 } });
    await reading;
    assert.deepEqual(clone(page.data), snapshot, name);
    assert.equal(operations.begin(kind, newer), newerId, name);
    assert.equal(rt.storage.has('gxs_query_result_v1'), false, 'an old page cannot replace the current result cache');
    assert.deepEqual(rt.messages, []);
  }
});

test('unloading during startup prevents late account data and follow-up page reads', async () => {
  for (const name of ['query', 'history', 'follow']) {
    const account = deferred();
    const rt = runtime(action => action === 'user.bootstrap' ? account.promise : action === 'catalog.get' ? { unchanged: true }
      : action === 'follow.list' ? { follows: [], limits: {} } : {});
    const page = rt.instance(`pages/${name}/index.js`), loading = page.onLoad();
    await tick();
    page.onUnload();
    const snapshot = clone(page.data), calls = rt.calls.length;
    account.resolve(boot(true));
    await loading;
    assert.deepEqual(clone(page.data), snapshot, name);
    assert.equal(rt.calls.length, calls, `${name}: no page reads after unload`);
    await page.onShow();
    assert.deepEqual(clone(page.data), snapshot, name);
    assert.equal(rt.calls.length, calls);
    assert.equal(rt.timers.size, 0);
  }
});

test('history membership activation clears only the obsolete free-user restrictions', async () => {
  for (const reason of ['insufficient_credits', 'new_product_history_restricted', 'query_rate_limited']) {
    let active = false;
    const rt = runtime(action => action === 'user.bootstrap' ? boot(active) : action === 'catalog.get' ? { unchanged: true }
      : action === 'history.list' ? { ok: false, reason, balance: 0 } : { recentViews: [] });
    const page = rt.instance('pages/history/index.js');
    await page.onLoad();
    page.selection = { partNumber: product.partNumber, product, storeNumbers: ['R577'] };
    await page.onQuery();
    const restriction = page.data.restriction;
    active = true;
    rt.load('utils/store.js').invalidateBootstrap();
    await page.onShow();
    assert.equal(page.data.boot.member, true);
    assert.equal(page.data.restriction, reason === 'query_rate_limited' ? restriction : null, reason);
    page.onUnload();
  }
});

test('a membership-only denial refreshes an outdated member badge without hiding the server restriction', async () => {
  for (const name of ['query', 'history']) {
    let active = true;
    const action = name === 'query' ? 'query.pickup' : 'history.list';
    const reason = name === 'query' ? 'new_product_restricted' : 'new_product_history_restricted';
    const rt = runtime(current => {
      if (current === 'user.bootstrap') return boot(active);
      if (current === 'catalog.get') return { unchanged: true };
      if (current === action) { active = false; return { ok: false, reason, balance: 4 }; }
      return { recentViews: [] };
    });
    const page = rt.instance(`pages/${name}/index.js`);
    await page.onLoad();
    page.selection = { partNumber: product.partNumber, product, storeNumbers: ['R577'] };
    assert.equal(page.data.boot.member, true);
    await page.onQuery();
    assert.equal(page.data.boot.member, false, name);
    assert.match(page.data.restriction, /免费用户/, name);
    assert.equal(rt.calls.filter(call => call.action === action).length, 1);
    page.onUnload();
  }
});
