import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, operatorContext, userKeyOf, userContext } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { guardedPickup } = require('../cloudfunctions/gxs_api/lib/engine/guarded-pickup');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { retryAfterMs } = require('../cloudfunctions/gxs_api/lib/repo/upstream-guard');
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const payload = i => ({ queryId: `guard-query-${String(i).padStart(4, '0')}`, partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] });
async function member(f, ctx = userContext()) {
  ok(await f.call('user.bootstrap', {}, ctx));
  const key = `${ctx.FROM_APPID}:${ctx.FROM_OPENID}`;
  ok(await f.call('admin.grantMembership', { userKey: key, days: 30, grantId: `guard-member-${ctx.FROM_OPENID}` }, operatorContext()));
}
function args(f, extra = {}) { return { repo: f.repo, config: mergeConfig(f.repo.tables.get(C.config).get('runtime')), clock: () => new Date(f.state.now), fetchImpl: f.state.fetchImpl, storeNumber: 'R577', partNumbers: ['MXXX1CH/A'], timeoutMs: 100, ...extra }; }

test('member requests with distinct IDs consume one shared minute budget; denied calls write no observations', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl, config: { collector: { maxRequestsPerMinute: 1, maxRequestsPerDay: 2 } } });
  await member(f);
  assert.equal(ok(await f.call('query.pickup', payload(0))).ok, true);
  const before = await f.repo.getLatest(['R577|MXXX1CH/A']);
  for (let i = 1; i <= 4; i++) assert.equal(ok(await f.call('query.pickup', payload(i))).reason, 'upstream_budget_limited');
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(await f.repo.getLatest(['R577|MXXX1CH/A']), before);
  f.advance(60000);
  assert.equal(ok(await f.call('query.pickup', payload(5))).ok, true);
  f.advance(60000);
  assert.equal(ok(await f.call('query.pickup', payload(6))).reason, 'upstream_budget_limited');
  assert.equal(fetchImpl.calls.length, 2);
});

test('429 Retry-After survives new API calls and auto collection using the same persisted state', async () => {
  let calls = 0;
  const f = createFixture({ config: { collector: { enabled: true } }, fetchImpl: async () => { calls++; return { status: 429, headers: { get: () => '180' }, body: (async function* () { yield Buffer.from('busy'); })() }; } });
  await member(f);
  ok(await f.call('follow.upsert', { followId: 'guard-follow-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
  const first = ok(await f.call('query.pickup', payload(1)));
  assert.equal(first.reason, 'upstream_paused');
  assert.equal(first.retryAfterMs, 180000);
  for (let i = 2; i <= 5; i++) assert.equal(ok(await f.call('query.pickup', payload(i))).reason, 'upstream_paused');
  const collector = createCollector({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => new Date(f.state.now), ownerId: 'cold-start', log: { info() {}, warn() {}, error() {} } });
  const step = await collector.step(); await Promise.all(step.started);
  assert.equal(calls, 1);
  assert.equal(collector.scheduler.snapshot().targets[0].health.requests, 0);
  assert.equal((await collector.publishStatus()).state, 'throttled');
  f.advance(180000);
  f.state.fetchImpl = fakeFetch({ R577: { display: 'available' } });
  assert.equal(ok(await f.call('query.pickup', payload(6))).ok, true);
  assert.equal(f.repo.tables.get(C.config).get('upstream_breaker').until, null);
});

test('automatic scans and manual calls compete for the same budget, including concurrent users', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl, config: { collector: { enabled: true, maxRequestsPerMinute: 1 } } });
  await member(f);
  ok(await f.call('follow.upsert', { followId: 'guard-follow-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
  const collector = createCollector({ repo: f.repo, fetchImpl, clock: () => new Date(f.state.now), ownerId: 'auto-budget', log: { info() {}, warn() {}, error() {} } });
  const step = await collector.step(); await Promise.all(step.started);
  const second = userContext('oSECOND0000000000000000001'); await member(f, second);
  const responses = await Promise.all([f.call('query.pickup', payload(1)), f.call('query.pickup', payload(2), second)]);
  assert.ok(responses.every(r => ok(r).reason === 'upstream_budget_limited'));
  assert.equal(fetchImpl.calls.length, 1);
});

test('automatic scans leave daily capacity for manual queries while the shared cap remains enforced', async () => {
  const f = createFixture({ config: { collector: { maxRequestsPerDay: 10 } }, fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
  const limits = { maxRequestsPerMinute: 60, maxRequestsPerDay: 10, budgetMode: 'daily' };
  const take = source => f.repo.consumeCollectorBudget({ now: f.state.now.toISOString(), ...limits, source });
  for (let i = 0; i < 8; i++) assert.equal((await take('auto')).allowed, true);
  const held = await take('auto');
  assert.equal(held.reason, 'auto_budget_reserved');
  assert.equal(held.retryAt, Date.parse('2026-09-15T16:00:00.000Z'));
  assert.equal((await take('manual')).allowed, true);
  assert.equal((await take('manual')).allowed, true);
  assert.equal((await take('manual')).reason, 'daily_budget');
  f.advance(14 * 60 * 60 * 1000);
  assert.equal((await take('auto')).allowed, true, 'Beijing midnight starts a new allocation');
});

test('scheduled monitoring stretches its scan interval to fit the automatic allocation', async () => {
  const f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60, maxRequestsPerDay: 1000 } } });
  await member(f);
  ok(await f.call('follow.upsert', { followId: 'budget-cadence-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
  const collector = createCollector({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => new Date(f.state.now), mode: 'scheduled', log: { info() {}, warn() {}, error() {} } });
  await collector.refreshTargets();
  assert.equal(collector.scheduler.snapshot().intervalMs, 108000);
});

test('distinct IDs cannot overlap for one member, but a finished query releases the account lease', async () => {
  let entered; let release;
  const began = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl: async (...a) => { entered(); await gate; return fetchImpl(...a); } });
  await member(f);
  const running = f.call('query.pickup', payload(1)); await began;
  const denied = ok(await f.call('query.pickup', payload(2)));
  assert.equal(denied.reason, 'query_concurrency_limited'); assert.ok(denied.retryAfterMs > 0);
  assert.equal(await f.repo.getQuery(`${userKeyOf()}|${payload(2).queryId}`), null);
  release(); assert.equal(ok(await running).ok, true);
  assert.equal(ok(await f.call('query.pickup', payload(2))).ok, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test('per-account sliding limit counts new work but never charges or blocks an idempotent replay', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl, config: { query: { maxRequestsPerUserMinute: 2 } } }); await member(f);
  assert.equal(ok(await f.call('query.pickup', payload(1))).ok, true);
  assert.equal(ok(await f.call('query.pickup', payload(2))).ok, true);
  assert.equal(ok(await f.call('query.pickup', payload(3))).reason, 'query_rate_limited');
  assert.equal(ok(await f.call('query.pickup', payload(1))).replayed, true);
  assert.equal(fetchImpl.calls.length, 2);
  f.advance(60000); assert.equal(ok(await f.call('query.pickup', payload(3))).ok, true);
});

test('free-user budget denial returns the debit and leaves observed state untouched', async () => {
  const f = createFixture({ fetchImpl: fakeFetch({ R577: { display: 'available' } }), config: { collector: { maxRequestsPerMinute: 1 } } });
  ok(await f.call('quota.signin'));
  await guardedPickup(args(f));
  const result = ok(await f.call('query.pickup', payload(1)));
  assert.equal(result.reason, 'upstream_budget_limited'); assert.equal(result.balance, 1);
  assert.equal(result.charged, result.refunded); assert.equal(result.refunded, 1);
  assert.deepEqual(await f.repo.getLatest(['R577|MXXX1CH/A']), []);
  assert.equal(ok(await f.call('query.pickup', payload(1))).replayed, true);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
});

test('shared circuit permits a single recovery probe and late success cannot undo a newer 503', async () => {
  const f = createFixture(); const consume = () => f.repo.consumeCollectorBudget({ now: f.state.now.toISOString(), maxRequestsPerMinute: 60, maxRequestsPerDay: 10000 });
  const first = await consume(); const old = await consume();
  await f.repo.recordUpstreamOutcome({ token: first.token, record: { httpStatus: 429, retryAfter: '60' }, success: false, now: f.state.now.toISOString() });
  await f.repo.recordUpstreamOutcome({ token: old.token, record: { httpStatus: 200 }, success: true, now: f.state.now.toISOString() });
  assert.equal((await consume()).allowed, false);
  f.advance(60000);
  const outcomes = await Promise.all([consume(), consume(), consume()]);
  assert.equal(outcomes.filter(r => r.allowed).length, 1);
  const probe = outcomes.find(r => r.allowed);
  await f.repo.recordUpstreamOutcome({ token: old.token, record: { httpStatus: 503, retryAfter: '120' }, success: false, now: f.state.now.toISOString() });
  await f.repo.recordUpstreamOutcome({ token: probe.token, record: { httpStatus: 200 }, success: true, now: f.state.now.toISOString() });
  assert.equal((await consume()).allowed, false);
});

test('abandoned probe lease expires and repeated transport failures pause the shared source', async () => {
  const f = createFixture({ fetchImpl: fakeFetch({ R577: { error: 'network down' } }) });
  for (let i = 0; i < 5; i++) await guardedPickup(args(f));
  assert.equal((await guardedPickup(args(f))).record.budgetDenied, true);
  assert.equal(f.state.fetchImpl.calls.length, 5);
  f.advance(30000);
  const abandoned = await f.repo.consumeCollectorBudget({ now: f.state.now.toISOString(), maxRequestsPerMinute: 60, maxRequestsPerDay: 10000 });
  assert.equal(abandoned.token.probe, true);
  assert.equal((await guardedPickup(args(f))).record.budgetDenied, true);
  f.advance(30001);
  f.state.fetchImpl = fakeFetch({ R577: { display: 'available' } });
  assert.equal((await guardedPickup(args(f))).observations[0].status, 'available');
});

test('Retry-After supports HTTP dates and refuses invalid or negative values', () => {
  const now = Date.parse('2026-09-16T00:00:00Z');
  assert.equal(retryAfterMs('Wed, 16 Sep 2026 00:03:00 GMT', now), 180000);
  assert.equal(retryAfterMs('180', now), 180000);
  assert.equal(retryAfterMs('invalid', now), 0);
  assert.equal(retryAfterMs('-1', now), 0);
});

test('a successful expired probe cannot close the circuit before or after another probe takes over', async () => {
  const f = createFixture();
  const consume = () => f.repo.consumeCollectorBudget({ now: f.state.now.toISOString(), maxRequestsPerMinute: 60, maxRequestsPerDay: 10000 });
  const first = await consume();
  await f.repo.recordUpstreamOutcome({ token: first.token, record: { httpStatus: 429 }, success: false, now: f.state.now.toISOString() });
  f.advance(30000);
  const oldProbe = await consume();
  assert.equal(oldProbe.token.probe, true);
  f.advance(30000); // The exact expiry instant must already reject ownership.
  const expiredState = structuredClone(f.repo.tables.get(C.config).get('upstream_breaker'));
  const oldSuccess = { token: oldProbe.token, record: { httpStatus: 200 }, success: true, now: f.state.now.toISOString() };
  assert.equal((await f.repo.recordUpstreamOutcome(oldSuccess)).paused, true);
  assert.deepEqual(f.repo.tables.get(C.config).get('upstream_breaker'), expiredState);
  const replacement = await consume();
  assert.equal(replacement.allowed, true);
  assert.notEqual(replacement.token.id, oldProbe.token.id);
  const replacementState = structuredClone(f.repo.tables.get(C.config).get('upstream_breaker'));
  await f.repo.recordUpstreamOutcome(oldSuccess);
  assert.deepEqual(f.repo.tables.get(C.config).get('upstream_breaker'), replacementState, 'old success cannot clear the new owner');
  await f.repo.recordUpstreamOutcome({ ...oldSuccess, token: replacement.token });
  assert.equal(f.repo.tables.get(C.config).get('upstream_breaker').until, null);
});

test('a probe that expires while awaiting beforeRequest never fetches or reports an upstream outcome', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ fetchImpl });
  const consume = () => f.repo.consumeCollectorBudget({ now: f.state.now.toISOString(), maxRequestsPerMinute: 60, maxRequestsPerDay: 10000 });
  const first = await consume();
  await f.repo.recordUpstreamOutcome({ token: first.token, record: { httpStatus: 429 }, success: false, now: f.state.now.toISOString() });
  f.advance(30000);
  let outcomeCalls = 0;
  const recordOutcome = f.repo.recordUpstreamOutcome;
  f.repo.recordUpstreamOutcome = async input => { outcomeCalls++; return recordOutcome(input); };
  let replacement;
  let replacementState;
  const result = await guardedPickup(args(f, {
    beforeRequest: async () => {
      f.advance(31000);
      replacement = await consume();
      replacementState = structuredClone(f.repo.tables.get(C.config).get('upstream_breaker'));
      return true;
    },
  }));
  assert.equal(replacement.allowed, true);
  assert.equal(replacement.token.probe, true);
  assert.equal(result.record.budgetDenied, true);
  assert.equal(result.record.error.message, 'request_cancelled');
  assert.equal(fetchImpl.calls.length, 0, 'the expired owner cannot launch an extra recovery probe');
  assert.equal(outcomeCalls, 0, 'cancellation is not a successful or failed upstream observation');
  assert.deepEqual(f.repo.tables.get(C.config).get('upstream_breaker'), replacementState);
});
