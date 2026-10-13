import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const now = Date.parse('2026-10-13T04:00:00Z');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const account = () => ({ identity: { userKey: 'account:alice' }, membership: { active: true },
  quota: { balance: 4, queryCost: 1, historyCost: 1, signedInToday: true, tasksDoneToday: [] },
  limits: { queryMaxStores: 3 }, followCount: 0, collector: { state: 'running' }, features: {}, newProductWindows: [] });

function fixture(name, handler) {
  const action = name === 'query' ? 'query.pickup' : 'history.list';
  const rt = runtime((current, payload) => current === action ? handler(payload) : account());
  const catalog = rt.load('utils/store.js').currentCatalog();
  const product = catalog.products.find(item => item.supported && !item.comingSoon);
  const store = catalog.stores[0];
  const page = rt.instance(`pages/${name}/index.js`);
  page.catalog = catalog;
  page.selection = { partNumber: product.partNumber, product, storeNumbers: [store.storeNumber], stores: [store] };
  page.data.ready = true;
  page.applyBoot(account());
  const success = () => ({ ok: true, product, queriedAt: new Date(now).toISOString(), dayKey: '2026-10-13',
    balance: 4, quotaRevision: 1,
    results: [{ storeNumber: store.storeNumber, status: 'available', observedAt: new Date(now).toISOString() }],
    latest: [], events: [], summary: { available: 0, restocks: 0, recoveries: 0, ended: 0 }, pagination: { total: 0, hasMore: false } });
  return { rt, page, success, calls: () => rt.calls.filter(call => call.action === action) };
}

for (const name of ['query', 'history']) {
  test(`${name}: a failed refresh stays visible beside the unchanged previous result until explicit retry`, async t => {
    t.mock.method(Date, 'now', () => now);
    let request = 0;
    const retry = deferred();
    const f = fixture(name, () => {
      if (++request === 1) return f.success();
      if (request === 2) throw Object.assign(Error('raw provider trace and request identifiers'), { code: 'unrecognized_error' });
      return retry.promise;
    });
    await f.page.onQuery();
    const previous = copy(f.page.data.result), target = copy(f.page.selection);
    await f.page.onQuery();
    assert.match(f.page.data.queryFailureMessage, /查询未完成/);
    assert.doesNotMatch(f.page.data.queryFailureMessage, /provider|identifiers|unrecognized|未扣次|返还/);
    assert.deepEqual(copy(f.page.data.result), previous, 'a failure cannot become a new stock/history result');
    assert.deepEqual(copy(f.page.selection), target, 'the failed target is not silently replaced');
    assert.equal(f.calls().length, 2, 'no automatic query is scheduled');
    assert.equal(f.rt.messages.length, 0, 'the persistent notice does not also open an interrupting error dialog');

    const retrying = f.page.onQuery();
    assert.equal(f.page.data.queryFailureMessage, '', 'an explicit new attempt clears the old failure');
    assert.equal(f.page.data.querying, true);
    retry.resolve(f.success()); await retrying;
    assert.equal(f.page.data.queryFailureMessage, '');
    assert.equal(f.page.data.querying, false);
    assert.equal(f.calls().length, 3);
  });

  test(`${name}: uncertain results preserve the original operation and never claim an unverified refund`, async t => {
    t.mock.method(Date, 'now', () => now);
    let request = 0;
    const f = fixture(name, () => ++request === 1
      ? Promise.reject(Object.assign(Error('cloud.callFunction failed after debit'), { code: 'call_failed' }))
      : request === 2 ? { ok: false, reason: 'query_in_progress' } : f.success());
    await f.page.onQuery();
    assert.match(f.page.data.queryFailureMessage, /结果尚未确认/);
    assert.match(f.page.data.queryFailureMessage, /相同.*恢复原请求.*不重复扣次/);
    assert.doesNotMatch(f.page.data.queryFailureMessage, /未扣次|返还|cloud|debit/);
    await f.page.onQuery();
    assert.match(f.page.data.queryFailureMessage, /仍在处理中|正在处理中/);
    await f.page.onQuery();
    assert.equal(f.page.data.queryFailureMessage, '');
    const ids = f.calls().map(call => call.payload[name === 'query' ? 'queryId' : 'historyQueryId']);
    assert.equal(new Set(ids).size, 1, 'transport loss and in-progress replies must reuse the billed request');
  });

  test(`${name}: known business denials use the existing user-facing mapping and new conditions clear them`, async t => {
    t.mock.method(Date, 'now', () => now);
    const f = fixture(name, () => ({ ok: false, reason: 'query_rate_limited', balance: 4, quotaRevision: 1 }));
    await f.page.onQuery();
    assert.match(f.page.data.queryFailureMessage, /查询过于频繁/);
    assert.equal(f.page.data.queryFailureMessage, f.page.data.restriction);
    assert.doesNotMatch(f.page.data.queryFailureMessage, /query_rate_limited/);
    if (name === 'query') f.page.onPickerChange({ detail: f.page.selection });
    else f.page.onDateChange({ detail: { value: '2026-10-12' } });
    assert.equal(f.page.data.queryFailureMessage, '');
    assert.equal(f.calls().length, 1);
  });

  test(`${name}: a late failure cannot mutate a retired page`, async t => {
    t.mock.method(Date, 'now', () => now);
    const pending = deferred(), f = fixture(name, () => pending.promise);
    const querying = f.page.onQuery();
    f.page.onUnload();
    const before = copy(f.page.data);
    pending.reject(Object.assign(Error('late backend failure'), { code: 'internal_error' }));
    await querying;
    assert.deepEqual(copy(f.page.data), before);
    assert.equal(f.rt.messages.length, 0);
  });
}

test('query: a rejected request from a previous account cannot overwrite the current account notice', async t => {
  t.mock.method(Date, 'now', () => now);
  const pending = deferred(), f = fixture('query', () => pending.promise);
  const querying = f.page.onQuery();
  f.page.applyBoot({ ...account(), identity: { userKey: 'account:bob' } });
  assert.equal(f.page.data.queryFailureMessage, '');
  f.page.setData({ queryFailureMessage: '当前账户自己的提示' });
  pending.reject(Object.assign(Error('old account failed'), { code: 'call_failed' }));
  await querying;
  assert.equal(f.page.data.queryFailureMessage, '当前账户自己的提示');
  assert.equal(f.rt.messages.length, 0);
});
