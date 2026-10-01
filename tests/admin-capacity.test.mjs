import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, operatorContext, userKeyOf } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response.data; };
const call = f => f.call('admin.capacity', {}, operatorContext());
const put = (f, collection, doc) => f.repo.tables.get(collection).set(doc._id, structuredClone(doc));
const snapshot = f => structuredClone([...f.repo.tables].map(([name, rows]) => [name, [...rows]]));

test('capacity diagnostics require administrator privileges before reading operational records', async () => {
  const f = createFixture();
  let reads = 0;
  f.repo.getUpstreamCapacity = async () => { reads++; throw Error('must not read'); };
  f.repo.listSince = async () => { reads++; throw Error('must not read'); };
  const response = await f.call('admin.capacity', { isAdmin: true });
  assert.equal(response.error.code, 'forbidden');
  assert.equal(reads, 0);
});

test('continuous capacity reports demand, partial legacy attribution and selected stored tokens without writes', async () => {
  const f = createFixture({ config: { collector: { budgetMode: 'continuous', enabled: true, intervalSeconds: 8, maxRequestsPerMinute: 60, maxRequestsPerDay: 10000 } } });
  put(f, C.config, { _id: 'collector_budget_2026-09-15', dayCount: 1234, autoCount: 800, manualCount: 200, ownerId: 'private-day-owner' });
  put(f, C.config, { _id: 'collector_status', mode: 'scheduled', groupCount: 9, intervalMs: 97200, updatedAt: '2026-09-15T01:59:00.000Z', expiresAt: '2026-09-15T02:01:30.000Z', ownerId: 'private-collector-owner', scheduler: { token: 'private-scheduler' } });
  put(f, C.config, { _id: 'upstream_capacity', version: 1, updatedAtMs: Date.parse('2026-09-15T01:59:00Z'),
    tokens: { shared: 3.5, auto: 2.5, manual: 1 }, capacities: { shared: 60, auto: 48, manual: 12 },
    rates: { shared: 10000 / 86400000, auto: 8000 / 86400000, manual: 2000 / 86400000 },
    ownerId: 'private-capacity-owner', probeId: 'private-probe-token', lastDemandAt: { 'private-user': 999 } });
  const before = snapshot(f);
  const data = ok(await call(f));
  assert.equal(data.mode, 'continuous');
  assert.equal(data.sustainedDailyTarget, 10000);
  assert.equal(Object.hasOwn(data, 'hardDailyLimit'), false);
  assert.equal(data.maxRequestsPerMinute, 60);
  assert.equal(data.uniqueGroups, 9);
  assert.equal(data.collectorStatusUpdatedAt, '2026-09-15T01:59:00.000Z');
  assert.equal(data.collectorStatusStale, false);
  assert.equal(data.normalCadenceSeconds, 60, 'scheduled cadence has a one-minute minimum');
  assert.equal(data.plannedIntervalSeconds, 97.2);
  assert.equal(data.configuredNormalRequestsPerDay, 12960);
  assert.equal(data.autoRequestsPerDay, 8000);
  assert.equal(data.aboveAutoCapacity, true);
  assert.deepEqual(data.todayReservations, { date: '2026-09-15', available: true, total: 1234, auto: 800, manual: 200, unclassified: 234, sourceSplitComplete: false });
  assert.deepEqual(data.tokenSnapshot.tokens, { shared: 3.5, auto: 2.5, manual: 1 }, 'stored snapshot is not silently projected/refilled');
  assert.equal(data.tokenSnapshot.recordedAt, '2026-09-15T01:59:00.000Z');
  assert.ok(Math.abs(data.tokenSnapshot.refillPerSecond.shared - 10000 / 86400) < 1e-9);
  assert.equal(JSON.stringify(data).includes('private-'), false);
  assert.deepEqual(snapshot(f), before);
});

test('bounded reuse statistics count completed live results and preserve unknown legacy attribution', async () => {
  const f = createFixture({ config: { collector: { budgetMode: 'continuous' } } });
  const record = (id, status, results, extra = {}) => ({ _id: id, kind: 'live', userKey: 'private-user-id', createdAt: '2026-09-15T01:00:00Z', status, response: { results }, ...extra });
  put(f, C.queries, record('mixed', 'success', [{ status: 'available', reused: false }, { status: 'pending', reused: true }, { status: 'unknown', reused: false }]));
  put(f, C.queries, record('legacy', 'success', [{ status: 'ineligible' }]));
  put(f, C.queries, record('failed', 'failed', [{ status: 'unknown', reused: false }]));
  put(f, C.queries, record('pending', 'pending', [{ status: 'available', reused: true }]));
  put(f, C.queries, record('history', 'success', [{ status: 'available', reused: false }], { kind: 'history' }));
  put(f, C.queries, record('yesterday', 'success', [{ status: 'available', reused: true }], { createdAt: '2026-09-14T15:59:59.000Z' }));
  const originalList = f.repo.listSince;
  let parameters;
  f.repo.listSince = async (...args) => { parameters = args; return originalList(...args); };
  const before = snapshot(f);
  const data = ok(await call(f));
  assert.deepEqual(parameters, [C.queries, 'createdAt', '2026-09-14T16:00:00.000Z', 2000]);
  assert.deepEqual(data.recentQueryReuse, { since: '2026-09-14T16:00:00.000Z', sampleLimit: 2000, sampledRecords: 5, truncated: false,
    completedLiveQueries: 3, freshTargets: 1, reusedTargets: 1, unclassifiedTargets: 1, unknownTargets: 2,
    reuseShareOfClassifiedTargets: 0.5, attributionComplete: false });
  assert.equal(JSON.stringify(data).includes('private-user-id'), false);
  assert.deepEqual(snapshot(f), before);
});

test('reuse sample cap is explicit and does not claim to represent all daily queries', async () => {
  const f = createFixture();
  for (let i = 0; i < 2001; i++) put(f, C.queries, { _id: `q-${i}`, kind: 'live', status: 'success', createdAt: '2026-09-15T01:00:00.000Z', response: { results: [{ status: 'unavailable', reused: true }] } });
  const data = ok(await call(f));
  assert.equal(data.recentQueryReuse.sampledRecords, 2000);
  assert.equal(data.recentQueryReuse.completedLiveQueries, 2000);
  assert.equal(data.recentQueryReuse.reusedTargets, 2000);
  assert.equal(data.recentQueryReuse.truncated, true);
  assert.equal(data.recentQueryReuse.attributionComplete, true);
});

test('explicit daily mode exposes the hard cap and resident demand uses its configured cadence', async () => {
  const f = createFixture({ config: { collector: { budgetMode: 'daily', intervalSeconds: 8, maxRequestsPerDay: 10000 } } });
  put(f, C.config, { _id: 'collector_status', mode: 'resident', groupCount: 2, intervalMs: 8000 });
  put(f, C.config, { _id: 'collector_budget_2026-09-15', dayCount: 10, autoCount: 8, manualCount: 2 });
  const data = ok(await call(f));
  assert.equal(data.hardDailyLimit, 10000);
  assert.equal(data.normalCadenceSeconds, 8);
  assert.equal(data.configuredNormalRequestsPerDay, 21600);
  assert.equal(data.tokenSnapshot, null);
  assert.equal(data.todayReservations.sourceSplitComplete, true);
  assert.equal(data.todayReservations.unclassified, 0);
});

test('missing collector data stays unknown and listed administrator reads do not bootstrap users', async () => {
  const f = createFixture({ config: { adminUserKeys: [userKeyOf()], collector: { budgetMode: 'continuous' } } });
  const before = snapshot(f);
  const data = ok(await f.call('admin.capacity'));
  assert.equal(data.uniqueGroups, null);
  assert.equal(data.plannedIntervalSeconds, null);
  assert.equal(data.configuredNormalRequestsPerDay, null);
  assert.equal(data.aboveAutoCapacity, null);
  assert.equal(data.collectorStatusUpdatedAt, null);
  assert.equal(data.collectorStatusStale, true);
  assert.equal(data.todayReservations.total, 0);
  assert.equal(data.todayReservations.available, false);
  assert.equal(data.todayReservations.sourceSplitComplete, true);
  assert.deepEqual(snapshot(f), before);
});

test('old collector measurements are explicitly marked stale', async () => {
  const f = createFixture({ config: { collector: { budgetMode: 'continuous', enabled: true } } });
  put(f, C.config, { _id: 'collector_status', mode: 'scheduled', groupCount: 9, intervalMs: 120000,
    updatedAt: '2026-09-15T01:00:00.000Z', expiresAt: '2026-09-15T01:02:30.000Z' });
  const data = ok(await call(f));
  assert.equal(data.uniqueGroups, 9);
  assert.equal(data.collectorStatusUpdatedAt, '2026-09-15T01:00:00.000Z');
  assert.equal(data.collectorStatusStale, true);
});

test('nonfinite or unexpected operational fields do not leak through token snapshots', async () => {
  const f = createFixture();
  put(f, C.config, { _id: 'upstream_capacity', updatedAtMs: 1e20,
    tokens: { shared: Infinity, auto: -1, manual: 'secret' }, capacities: { shared: 60 }, rates: { shared: 1e308 }, probeId: 'private-probe' });
  const data = ok(await call(f));
  assert.deepEqual(data.tokenSnapshot, { recordedAt: null, tokens: { shared: null, auto: null, manual: null },
    burstCapacity: { shared: 60, auto: null, manual: null }, refillPerSecond: { shared: null, auto: null, manual: null } });
});
