import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, fakeFetch, operatorContext, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';

const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response.data; };

for (const kind of ['q', 'h']) {
  test(`${kind} switching targets preserves every unresolved ID across a new app runtime`, () => {
    const rt = runtime(), operations = rt.load('utils/operation.js');
    const first = operations.begin(kind, target);
    const changed = { ...target, partNumber: 'MYYY2CH/A' };
    const second = operations.begin(kind, changed);
    assert.notEqual(second, first);
    assert.equal(operations.begin(kind, target), first, 'return to an unresolved target resumes its original operation');
    const reopened = runtime();
    for (const [key, value] of rt.storage) reopened.storage.set(key, JSON.parse(JSON.stringify(value)));
    const restored = reopened.load('utils/operation.js');
    assert.equal(restored.begin(kind, changed), second);
    assert.equal(restored.begin(kind, target), first);
    restored.finish(kind, second);
    assert.equal(restored.begin(kind, target), first, 'completion of another target cannot remove this one');
    restored.finish(kind, first);
    assert.equal(reopened.storage.has(`gxs_pending_${kind}_v1`), false);
  });

  test(`${kind} migrates a pre-upgrade uncertain ID before adding another target`, () => {
    const rt = runtime();
    rt.storage.set(`gxs_pending_${kind}_v1`, { id: 'legacy-pending-request', fingerprint: JSON.stringify(target) });
    const operations = rt.load('utils/operation.js');
    operations.begin(kind, { ...target, partNumber: 'MYYY2CH/A' });
    assert.equal(operations.begin(kind, target), 'legacy-pending-request');
  });

  test(`${kind} retries retain their ID while storage is unavailable and persist it on recovery`, () => {
    const rt = runtime(), operations = rt.load('utils/operation.js');
    const read = rt.wx.getStorageSync, write = rt.wx.setStorageSync;
    rt.wx.getStorageSync = rt.wx.setStorageSync = () => { throw Error('storage unavailable'); };
    const first = operations.begin(kind, target);
    assert.equal(operations.begin(kind, target), first);
    rt.wx.getStorageSync = read; rt.wx.setStorageSync = write;
    assert.equal(operations.begin(kind, target), first);
    assert.equal(rt.storage.get(`gxs_pending_${kind}_v1`).id, first);
    operations.finish(kind, first);
    assert.notEqual(operations.begin(kind, target), first);
  });

  test(`${kind} completion cannot resurrect its saved ID or remove a newer uncertain request`, () => {
    const rt = runtime(), operations = rt.load('utils/operation.js');
    const first = operations.begin(kind, target);
    rt.wx.removeStorageSync = rt.wx.setStorageSync = () => { throw Error('storage unavailable'); };
    operations.finish(kind, first);
    const next = operations.begin(kind, target);
    assert.notEqual(next, first, 'a completed but undeleted storage entry is ignored');
    operations.finish(kind, first);
    assert.equal(operations.begin(kind, target), next, 'late completion cannot discard the newer operation');
    const changed = operations.begin(kind, { ...target, partNumber: 'MYYY2CH/A' });
    assert.notEqual(changed, next);
    operations.finish(kind, next);
    assert.equal(operations.begin(kind, { ...target, partNumber: 'MYYY2CH/A' }), changed);
    assert.notEqual(operations.begin(kind, target), next, 'changing targets still starts a new intent');
  });
}

test('storage recovery state follows the full localKey scope', () => {
  let scope = 'one', sequence = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../miniprogram/utils/operation.js', import.meta.url), 'utf8'), {
    module, Map, wx: { getStorageSync() { throw Error('unavailable'); }, setStorageSync() { throw Error('unavailable'); } },
    require(name) {
      if (name === './api') return { newId: kind => `${kind}-scoped-${++sequence}` };
      if (name === './local-key') return { localKey: key => `${scope}:${key}` };
      throw Error(`unexpected module: ${name}`);
    },
  });
  const operations = module.exports;
  const first = operations.begin('q', target);
  scope = 'two';
  const second = operations.begin('q', target);
  assert.notEqual(second, first);
  operations.finish('q', first);
  assert.equal(operations.begin('q', target), second);
  scope = 'one';
  assert.equal(operations.begin('q', target), first);
});

test('a lost committed query response with unavailable storage retries without a second debit', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ config: { query: { sharedFreshnessSeconds: 10 } }, fetchImpl });
  ok(await f.call('quota.signin'));
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'storage-recovery-credit', amount: 1 }, operatorContext()));
  let responses = 0;
  const rt = runtime(async (action, payload) => {
    const response = ok(await f.call(action, payload));
    if (action === 'query.pickup' && ++responses === 1) throw Object.assign(Error('response lost after commit'), { code: 'call_failed' });
    return response;
  });
  rt.wx.getStorageSync = rt.wx.setStorageSync = rt.wx.removeStorageSync = () => { throw Error('storage unavailable'); };
  const page = rt.instance('pages/query/index.js');
  const product = PRODUCTS.find(value => value.partNumber === target.partNumber);
  page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: { R577: STORES[0] } };
  page.selection = { ...target, product };
  page.data.boot = { member: false, balance: 2, queryCost: 1 };

  await page.onQuery();
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1, 'the first request committed before its response was lost');
  f.advance(11000); // Expire shared samples so only idempotency can prevent another charge.
  await page.onQuery();
  assert.equal(rt.calls[0].payload.queryId, rt.calls[1].payload.queryId);
  assert.equal(page.data.result.replayed, true);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'query_debit').length, 1);
  assert.equal(fetchImpl.calls.length, 1);

  await page.onQuery();
  assert.notEqual(rt.calls[2].payload.queryId, rt.calls[1].payload.queryId, 'confirmed completion releases the previous intent');
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 0);
});

test('a lost committed query remains recoverable after another target is queried and shared data expires', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' }, R639: { display: 'available' } });
  const f = createFixture({ config: { query: { sharedFreshnessSeconds: 10 } }, fetchImpl });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'multi-target-recovery', amount: 5 }, operatorContext()));
  let responses = 0;
  const rt = runtime(async (action, payload) => {
    const result = ok(await f.call(action, payload));
    if (action === 'query.pickup' && ++responses === 1) throw Object.assign(Error('response lost after commit'), { code: 'call_failed' });
    return result;
  });
  const page = rt.instance('pages/query/index.js');
  const product = PRODUCTS.find(value => value.partNumber === target.partNumber);
  page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: Object.fromEntries(STORES.map(store => [store.storeNumber, store])) };
  page.data.boot = { member: false, balance: 5, queryCost: 1 };
  await page.performQuery({ ...target, product });
  await page.performQuery({ ...target, product, storeNumbers: ['R639'] });
  f.advance(11000);
  await page.performQuery({ ...target, product });
  const queries = rt.calls.filter(item => item.action === 'query.pickup');
  assert.equal(queries[2].payload.queryId, queries[0].payload.queryId);
  assert.equal(page.data.result.replayed, true);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'query_debit').length, 2);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 3);
});
