import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userContext, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { requestBudget } = require('../cloudfunctions/gxs_api/lib/request-budget');
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const query = { queryId: 'budget-query-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };

test('invocation budget includes elapsed setup and survives a broken platform helper', () => {
  let now = 1000;
  const remaining = requestBudget({ getRemainingTimeInMillis() { throw Error('runtime helper broken'); } }, () => now);
  assert.equal(remaining(), 30000);
  now += 25000; assert.equal(remaining(), 5000);
  now += 6000; assert.equal(remaining(), 0);
});

test('a platform deadline is honored without allowing a stale helper to extend the invocation', () => {
  let now = 0, platform = 1900;
  const remaining = requestBudget({ getRemainingTimeInMillis: () => platform }, () => now);
  assert.equal(remaining(), 1900);
  platform = 60000; now = 29000; assert.equal(remaining(), 1000);
  platform = -1; assert.equal(remaining(), 0);
});

test('slow setup does not start a query or debit when too little invocation time remains', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl });
  await f.call('quota.signin');
  const handle = createHandler({ repo: f.repo, fetchImpl, clock: () => f.state.now, remainingMs: () => 6500 });
  const result = await handle({ action: 'query.pickup', payload: query }, userContext());
  assert.equal(result.error.code, 'query_in_progress');
  assert.equal(result.error.details.reason, 'request_budget_exhausted');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(await f.repo.getQuery(`${userKeyOf()}|${query.queryId}`), null);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
});

test('slow admission leaves time to finalize and refund without starting an upstream request', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl });
  await f.call('quota.signin');
  let remainingMs = 10000;
  const begin = f.repo.beginQuery;
  f.repo.beginQuery = async args => { const result = await begin(args); remainingMs = 6500; return result; };
  const handle = createHandler({ repo: f.repo, fetchImpl, clock: () => f.state.now, remainingMs: () => remainingMs });
  const result = await handle({ action: 'query.pickup', payload: query }, userContext());
  assert.equal(result.ok, true);
  assert.equal(result.data.refunded, 1);
  assert.equal(result.data.balance, 1);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal((await f.repo.getQuery(`${userKeyOf()}|${query.queryId}`)).status, 'failed');
});

for (const legacyClient of [false, true]) test(`a budget refusal preserves the committed ID through the ${legacyClient ? '1.5.3' : '1.6.0'} query recovery contract`, async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl });
  await f.call('quota.signin');
  let remaining = 30000, loseResponse = true;
  const handle = createHandler({ repo: f.repo, fetchImpl, clock: () => f.state.now, remainingMs: () => remaining });
  const rt = runtime(async (action, payload) => {
    const result = await handle({ action, payload }, userContext());
    if (!result.ok) throw Object.assign(Error(result.error.message), { code: result.error.code });
    if (action === 'query.pickup' && loseResponse) {
      loseResponse = false;
      throw Object.assign(Error('committed response lost'), { code: 'call_failed' });
    }
    return result.data;
  });
  if (legacyClient) {
    // Freeze the shipped 1.5.3 classification: a new backend error code must
    // not rely on users already having downloaded the new front end.
    rt.load('utils/operation.js').uncertain = error => !error || [
      'cloud_init_failed', 'call_failed', 'bad_response', 'internal_error',
      'query_in_progress', 'request_in_progress', 'busy',
    ].includes(error.code);
  }
  const page = rt.instance('pages/query/index.js'), product = PRODUCTS[1];
  page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: { R577: STORES[0] } };
  page.selection = { partNumber: product.partNumber, storeNumbers: ['R577'], product };
  page.data.boot = { member: false, balance: 1, queryCost: 1 };
  await page.onQuery();
  remaining = 6500; await page.onQuery();
  remaining = 30000; await page.onQuery();
  const ids = rt.calls.filter(call => call.action === 'query.pickup').map(call => call.payload.queryId);
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 1);
  assert.equal(page.data.result.replayed, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'query_debit').length, 1);
});
