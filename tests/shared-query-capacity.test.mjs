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

test('switching to continuous capacity releases a member target held until midnight by the old daily cap', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ start: '2026-10-01T11:05:43.000Z', fetchImpl,
    config: { ...config, collector: { budgetMode: 'daily', maxRequestsPerDay: 10000 } } });
  await member(f);
  const dayId = 'collector_budget_2026-10-01';
  f.repo.tables.get(C.config).set(dayId, { _id: dayId, dayCount: 10000 });
  const denied = ok(await f.call('query.pickup', payload('migration-before')));
  assert.equal(denied.member, true); assert.equal(denied.budgetScope, 'daily');
  assert.equal(denied.retryAfterMs, 17657000, 'the incident wait was exactly the remaining time to Beijing midnight');
  ok(await f.call('admin.updateConfig', { patch: { collector: { budgetMode: 'continuous' } } }, operatorContext()));
  const recovering = ok(await f.call('query.pickup', payload('migration-refill')));
  assert.equal(recovering.budgetScope, 'continuous', 'a saved target wait must not retain the retired daily hard stop');
  assert.ok(recovering.retryAfterMs > 0 && recovering.retryAfterMs <= 43201);
  assert.equal(fetchImpl.calls.length, 0, 'migration must still wait for continuously replenished capacity');
  assert.equal(f.repo.tables.get(C.config).get(dayId).dayCount, 10000);
  f.advance(recovering.retryAfterMs);
  const recovered = ok(await f.call('query.pickup', payload('migration-recovered')));
  assert.equal(recovered.ok, true); assert.equal(recovered.member, true); assert.equal(recovered.charged, 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(f.repo.tables.get(C.config).get(dayId).dayCount, 10001, 'the historical count is retained as accounting');
});

test('continuous migration preserves minute waits and real upstream failures while daily mode retains its cap', async () => {
  for (const [budgetMode, reason] of [
    ['daily', 'daily_budget'], ['daily', 'auto_budget_reserved'],
    ['continuous', 'minute_budget'], ['continuous', 'capacity_wait'],
    ['continuous', 'upstream_paused'], ['continuous', 'upstream_unavailable'],
  ]) {
    const fetchImpl = fakeFetch({ R577: { display: 'available' } });
    const f = createFixture({ config: { ...config, collector: { budgetMode } }, fetchImpl }); await member(f);
    const id = queryTargetId('R577', 'MXXX1CH/A');
    const target = { _id: id, ownerId: null, leaseUntil: 0, reason, deferUntil: f.state.now.getTime() + 60000 };
    f.repo.tables.get(C.config).set(id, target);
    const response = ok(await f.call('query.pickup', payload(`preserve-${budgetMode}-${reason}`)));
    assert.equal(response.ok, false, `${budgetMode}: ${reason}`);
    assert.equal(response.transport[0].error, reason);
    assert.equal(response.retryAfterMs, 60000); assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(f.repo.tables.get(C.config).get(id), target, 'a current wait is retained without mutation');
  }
});

test('retiring a saved daily target wait still honors the shared upstream circuit breaker', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ config, fetchImpl }); await member(f);
  const id = queryTargetId('R577', 'MXXX1CH/A');
  const until = f.state.now.getTime() + 60000;
  f.repo.tables.get(C.config).set(id, { _id: id, ownerId: null, leaseUntil: 0, reason: 'daily_budget', deferUntil: until + 3600000 });
  const breaker = { _id: 'upstream_breaker', generation: 1, trips: 1, until, reason: 'http_429' };
  f.repo.tables.get(C.config).set('upstream_breaker', breaker);
  const response = ok(await f.call('query.pickup', payload('migration-paused')));
  assert.equal(response.reason, 'upstream_paused'); assert.equal(response.retryAfterMs, 60000);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(f.repo.tables.get(C.config).get('upstream_breaker'), breaker);
});

test('continuous migration can retire an old automatic reservation wait without taking an active target lease', async () => {
  const f = createFixture({ config });
  const id = queryTargetId('R577', 'MXXX1CH/A');
  const input = { storeNumber: 'R577', partNumber: 'MXXX1CH/A', ownerId: 'replacement', nowIso: f.state.now.toISOString(), maxAgeMs: 10000, budgetMode: 'continuous' };
  const target = { _id: id, ownerId: 'active-owner', leaseUntil: f.state.now.getTime() + 25000,
    reason: 'auto_budget_reserved', deferUntil: f.state.now.getTime() + 3600000 };
  f.repo.tables.get(C.config).set(id, target);
  assert.equal((await f.repo.claimQueryTarget(input)).busy, true);
  assert.deepEqual(f.repo.tables.get(C.config).get(id), target);
  f.advance(25000);
  assert.equal((await f.repo.claimQueryTarget({ ...input, nowIso: f.state.now.toISOString() })).acquired, true);
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
