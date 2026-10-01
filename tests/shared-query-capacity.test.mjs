import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, operatorContext, userContext, userKeyOf } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const { queryTargetId } = require('../cloudfunctions/gxs_api/lib/repo/query-target');
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value.error)); return value.data; };
const payload = (id, storeNumbers = ['R577']) => ({ queryId: `sharing-query-${id}`, partNumber: 'MXXX1CH/A', storeNumbers });
const config = { query: { sharedFreshnessSeconds: 10 }, collector: { budgetMode: 'continuous' } };
async function member(f, ctx = userContext()) {
  ok(await f.call('user.bootstrap', {}, ctx));
  ok(await f.call('admin.grantMembership', { userKey: `${ctx.FROM_APPID}:${ctx.FROM_OPENID}`, days: 30, grantId: `share-${ctx.FROM_OPENID}` }, operatorContext()));
}

test('100 distinct members and handler instances share one HTTP sample without false confirmation', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ config, fetchImpl });
  const contexts = Array.from({ length: 100 }, (_, i) => userContext(`oSCALE${String(i).padStart(22, '0')}`));
  for (const ctx of contexts) await member(f, ctx);
  const responses = await Promise.all(contexts.map((wxContext, i) => {
    const handler = createHandler({ repo: f.repo, fetchImpl, clock: () => new Date(f.state.now), log: { error() {} } });
    return handler({ action: 'query.pickup', payload: payload(`scale-${i}`) }, wxContext).then(ok);
  }));
  assert.ok(responses.every(r => r.ok && r.member && r.charged === 0));
  assert.equal(fetchImpl.calls.length, 1, 'cross-instance admission, not an in-process Promise cache');
  assert.equal(responses.filter(r => r.allShared).length, 99);
  assert.ok(responses.every(r => r.results[0].observedAt === f.state.now.toISOString()));
  const [latest] = await f.repo.getLatest(['R577|MXXX1CH/A']);
  assert.equal(latest.sampleCount, 1);
  assert.equal(latest.statusConfirmed, false, '100 cache reads are still only one physical observation');
  assert.equal(f.repo.tables.get(C.events).size, 1);
});

test('a new independent store costs one additional HTTP request while a recent store is shared', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' }, R639: { display: 'unavailable' } });
  const f = createFixture({ config, fetchImpl }); await member(f);
  const first = ok(await f.call('query.pickup', payload('first')));
  f.advance(1000);
  const mixed = ok(await f.call('query.pickup', payload('mixed', ['R577', 'R639'])));
  assert.equal(mixed.ok, true); assert.equal(mixed.sharedResult, true); assert.equal(mixed.allShared, false);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(mixed.results[0].observedAt, first.results[0].observedAt);
  assert.equal(mixed.results[0].reused, true); assert.equal(mixed.results[1].reused, false);
  f.advance(10000);
  assert.equal(ok(await f.call('query.pickup', payload('expired'))).allShared, false);
  assert.equal(fetchImpl.calls.length, 3, 'the exact freshness boundary requires a new sample');
});

test('fresh samples from automatic monitoring are shared and a free user gets the debit back', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ config, fetchImpl });
  ok(await f.call('user.bootstrap', {})); ok(await f.call('quota.signin', {}));
  const balance = (await f.repo.getUser(userKeyOf())).quota.balance;
  const observedAt = f.state.now.toISOString();
  await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MXXX1CH/A', status: 'available', observedAt, source: 'auto' } });
  f.advance(3000);
  const response = ok(await f.call('query.pickup', payload('auto-cache')));
  assert.equal(response.ok, true); assert.equal(response.allShared, true);
  assert.equal(response.charged - response.refunded, 0); assert.equal(response.balance, balance);
  assert.equal(response.results[0].observedAt, observedAt); assert.equal(fetchImpl.calls.length, 0);
  assert.equal((await f.repo.getLatest(['R577|MXXX1CH/A']))[0].sampleCount, 1);
  const replayed = ok(await f.call('query.pickup', payload('auto-cache')));
  assert.equal(replayed.replayed, true); assert.equal(replayed.balance, balance);
});

test('unknown, expired and future-dated observations cannot become a fresh shared result', async () => {
  for (const variant of ['unknown', 'expired', 'future']) {
    const fetchImpl = fakeFetch({ R577: { display: 'available' } });
    const f = createFixture({ config, fetchImpl }); await member(f);
    const observedAt = new Date(f.state.now.getTime() + (variant === 'future' ? 1000 : -10000)).toISOString();
    await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MXXX1CH/A', status: 'available', observedAt, source: 'auto' } });
    if (variant === 'unknown') await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MXXX1CH/A', status: 'unknown', observedAt: f.state.now.toISOString(), source: 'auto' } });
    const response = ok(await f.call('query.pickup', payload(variant)));
    assert.equal(response.allShared, false, variant); assert.equal(fetchImpl.calls.length, 1, variant);
  }
});

test('a corrupt future available sample cannot replace a freshly fetched unavailable result', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'unavailable' } });
  const f = createFixture({ config, fetchImpl }); await member(f);
  await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MXXX1CH/A', status: 'available',
    observedAt: new Date(f.state.now.getTime() + 3600000).toISOString(), source: 'auto' } });
  const response = ok(await f.call('query.pickup', payload('future-corrupt')));
  assert.equal(response.results[0].status, 'unavailable');
  assert.equal(response.results[0].observedAt, f.state.now.toISOString());
  assert.equal(response.results[0].superseded, false); assert.equal(response.results[0].statusSince, null);
});

test('cached valid results plus a failed fresh store do not consume a free query credit', async () => {
  const fetchImpl = fakeFetch({ R639: { status: 500, body: 'unavailable' } });
  const f = createFixture({ config, fetchImpl });
  ok(await f.call('user.bootstrap', {})); ok(await f.call('quota.signin', {}));
  const balance = (await f.repo.getUser(userKeyOf())).quota.balance;
  await f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MXXX1CH/A', status: 'available', observedAt: f.state.now.toISOString(), source: 'auto' } });
  const response = ok(await f.call('query.pickup', payload('cached-partial', ['R577', 'R639'])));
  assert.equal(response.ok, true); assert.equal(response.partial, true); assert.equal(response.allShared, false);
  assert.equal(response.billingReason, 'shared_result_no_charge'); assert.equal(response.balance, balance);
  assert.equal(response.charged - response.refunded, 0); assert.equal(fetchImpl.calls.length, 1);
});

test('slow database admission cannot start HTTP without the manual deadline cleanup margin', async t => {
  let wall = 1000;
  t.mock.method(Date, 'now', () => wall);
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ config, fetchImpl }); await member(f);
  const consume = f.repo.consumeCollectorBudget;
  f.repo.consumeCollectorBudget = async args => { const result = await consume(args); wall += 13500; return result; };
  const response = ok(await f.call('query.pickup', payload('slow-admission')));
  assert.equal(response.ok, false); assert.equal(fetchImpl.calls.length, 0);
  assert.equal(response.charged, 0);
});

test('a recent valid snapshot remains readable when legacy daily HTTP budget is exhausted', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ config: { ...config, collector: { budgetMode: 'daily', maxRequestsPerDay: 1 } }, fetchImpl }); await member(f);
  assert.equal(ok(await f.call('query.pickup', payload('last-slot'))).ok, true);
  f.advance(1000);
  const cached = ok(await f.call('query.pickup', payload('still-fresh')));
  assert.equal(cached.ok, true); assert.equal(cached.allShared, true); assert.equal(fetchImpl.calls.length, 1);
  f.advance(10000);
  const denied = ok(await f.call('query.pickup', payload('too-old')));
  assert.equal(denied.ok, false); assert.equal(denied.budgetScope, 'daily');
});

test('expired shared refresh ownership fences late sample writes and lease releases', async () => {
  const f = createFixture({ config });
  const input = { storeNumber: 'R577', partNumber: 'MXXX1CH/A', maxAgeMs: 10000, nowIso: f.state.now.toISOString() };
  const first = await f.repo.claimQueryTarget({ ...input, ownerId: 'old-owner' });
  assert.equal(first.acquired, true);
  assert.equal((await f.repo.claimQueryTarget({ ...input, ownerId: 'follower' })).busy, true);
  f.advance(25000);
  const replacement = await f.repo.claimQueryTarget({ ...input, nowIso: f.state.now.toISOString(), ownerId: 'new-owner' });
  assert.equal(replacement.acquired, true);
  await assert.rejects(f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MXXX1CH/A', status: 'available', observedAt: f.state.now.toISOString() },
    queryTargetLease: { id: first.id, ownerId: 'old-owner', nowIso: f.state.now.toISOString() } }), /更新中/);
  assert.equal((await f.repo.releaseQueryTarget({ id: first.id, ownerId: 'old-owner', nowIso: f.state.now.toISOString() })).released, false);
  assert.equal(f.repo.tables.get(C.config).get(queryTargetId('R577', 'MXXX1CH/A')).ownerId, 'new-owner');
  assert.equal((await f.repo.getLatest(['R577|MXXX1CH/A'])).length, 0);
});

test('a failed refresh is not multiplied into sequential HTTP failures by waiting members', async () => {
  const fetchImpl = fakeFetch({ R577: { status: 500, body: 'unavailable' } });
  const f = createFixture({ config, fetchImpl });
  const contexts = Array.from({ length: 12 }, (_, i) => userContext(`oFAIL${String(i).padStart(23, '0')}`));
  for (const ctx of contexts) await member(f, ctx);
  const responses = await Promise.all(contexts.map((ctx, i) => f.call('query.pickup', payload(`failure-${i}`), ctx).then(ok)));
  assert.ok(responses.every(r => !r.ok && r.charged === 0));
  assert.equal(fetchImpl.calls.length, 1);
});
