import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, operatorContext, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
const product = PRODUCTS.find(item => item.partNumber === target.partNumber);
const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response.data; };

async function fixture(reason) {
  const f = createFixture({ config: { query: { maxRequestsPerUserMinute: reason === 'query_rate_limited' ? 1 : 6 } },
    fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'admission-recovery-credit', amount: 5 }, operatorContext()));
  const config = mergeConfig(await f.repo.getConfig());
  const record = (queryId, storeNumbers = target.storeNumbers) => ({ _id: `${userKeyOf()}|${queryId}`, userKey: userKeyOf(),
    queryId, kind: 'live', partNumber: target.partNumber, storeNumbers });
  const begin = (value, ownerId) => f.repo.beginQuery({ record: value, product, config, ownerId, nowIso: f.state.now.toISOString() });
  return { ...f, record, begin };
}

for (const reason of ['query_concurrency_limited', 'query_rate_limited']) {
  test(`an already-debited query preserves its client ID through ${reason} and recovers without a second charge`, async () => {
    const f = await fixture(reason);
    let requests = 0, originalRecord;
    const rt = runtime(async (action, payload) => {
      if (action === 'query.pickup' && ++requests === 1) {
        originalRecord = f.record(payload.queryId);
        await f.begin(originalRecord, 'crashed-worker');
        throw Object.assign(Error('worker ended after debit'), { code: 'call_failed' });
      }
      return ok(await f.call(action, payload));
    });
    const page = rt.instance('pages/query/index.js');
    page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: Object.fromEntries(STORES.map(store => [store.storeNumber, store])) };
    page.data.boot = { member: false, balance: 5, queryCost: 1 };
    await page.performQuery({ ...target, product });
    assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 4);
    f.advance(30000);
    if (reason === 'query_concurrency_limited') await f.begin(f.record('other-device-query', ['R639']), 'other-device-worker');

    const held = await f.begin(originalRecord, 'recovery-worker');
    assert.equal(held.busy, true);
    assert.equal(held.denied, undefined);
    assert.equal(held.guardReason, reason);
    assert.equal(held.record._id, originalRecord._id);
    assert.ok(held.retryAfterMs > 0);
    assert.equal((await f.repo.getQuery(originalRecord._id)).ownerId, 'crashed-worker', 'waiting does not seize or reset the old request');

    await page.performQuery({ ...target, product });
    assert.match(page.data.restriction, /原查询仍在处理中/);
    assert.equal(rt.calls.filter(call => call.action === 'query.pickup')[1].payload.queryId, originalRecord.queryId);
    const fresh = ok(await f.call('query.pickup', { ...target, queryId: 'brand-new-limited-query' }));
    assert.equal(fresh.reason, reason, 'new requests remain rejected before admission');
    assert.equal(await f.repo.getQuery(`${userKeyOf()}|brand-new-limited-query`), null);

    f.advance(31000);
    await page.performQuery({ ...target, product });
    const queries = rt.calls.filter(call => call.action === 'query.pickup');
    assert.equal(queries[2].payload.queryId, originalRecord.queryId, 'a denied recovery must not turn into a new billed intent');
    assert.equal(page.data.result.ok, true);
    assert.notEqual((await f.repo.getQuery(originalRecord._id)).status, 'pending');
    const debits = (await f.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'query_debit');
    assert.equal(debits.filter(entry => entry.refId === originalRecord.queryId).length, 1);
    assert.equal(debits.length, reason === 'query_concurrency_limited' ? 2 : 1);
    assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, reason === 'query_concurrency_limited' ? 3 : 4);
  });
}

test('history recovery retains shared beginQuery semantics and is not blocked by live-query admission', async () => {
  const f = await fixture('query_concurrency_limited');
  await f.begin(f.record('live-holds-admission'), 'live-worker');
  const history = { ...f.record('history-recovery'), _id: `${userKeyOf()}|history|history-recovery`, kind: 'history', dayKey: '2026-09-14' };
  const first = await f.begin(history, 'history-worker');
  assert.ok(first.record);
  assert.equal(first.denied, undefined);
  const afterDebit = (await f.repo.getUser(userKeyOf())).quota.balance;
  const inProgress = ok(await f.call('history.list', { ...target, dayKey: history.dayKey, historyQueryId: history.queryId }));
  assert.equal(inProgress.reason, 'query_in_progress');
  assert.ok(inProgress.retryAfterMs > 0);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, afterDebit);
  f.advance(30000);
  await f.begin(f.record('another-live-holds', ['R639']), 'another-live-worker');
  const recovered = await f.begin(history, 'history-recovery-worker');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.denied, undefined);
  assert.equal(recovered.record.charged, first.record.charged);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'history_debit').length, 1);
});
