import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMemoryRepo } from './helpers/memory-repo.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C, INDEX_PLAN } = require('../cloudfunctions/gxs_api/lib/collections');
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { observationDayId } = require('../cloudfunctions/gxs_api/lib/engine/observation-day');
const partNumber = 'MXXX1CH/A';
const request = { partNumber, storeNumbers: ['R577'], dayKey: '2026-09-16' };
const observation = (minute, status = 'unavailable', extra = {}) => ({
  partNumber, storeNumber: 'R577', status, source: 'auto',
  observedAt: `2026-09-16T02:${String(minute).padStart(2, '0')}:00.000Z`, ...extra,
});
const record = (repo, value, extra = {}) => repo.recordObservation({ observation: value, ...extra });

test('daily summaries distinguish known, unknown and manual/automatic samples without inventing coverage duration', async () => {
  const repo = createMemoryRepo();
  const statuses = ['unknown', 'unavailable', 'unavailable', 'unknown', 'pending', 'ineligible', 'available'];
  for (const [minute, status] of statuses.entries()) await record(repo, observation(minute, status, { source: [2, 4, 6].includes(minute) ? 'manual' : 'auto' }));
  const [daily] = await repo.getObservationCoverage(request);
  assert.deepEqual(daily, {
    _id: 'R577|MXXX1CH/A|2026-09-16', schemaVersion: 1, storeNumber: 'R577', partNumber, dayKey: '2026-09-16',
    sampleCount: 7, knownCount: 5, unknownCount: 2, manualCount: 3, autoCount: 4,
    firstObservedAt: '2026-09-16T02:00:00.000Z', lastObservedAt: '2026-09-16T02:06:00.000Z',
    firstKnownAt: '2026-09-16T02:01:00.000Z', lastKnownAt: '2026-09-16T02:06:00.000Z',
  });
  assert.ok(!('coverageDurationMs' in daily));
  assert.ok(!('continuous' in daily));
});

test('unknown-only samples keep known timestamps null, and unrecognised source is not called automatic', async () => {
  const repo = createMemoryRepo();
  await record(repo, observation(0, 'unknown', { source: null }));
  await record(repo, observation(1, 'unknown'));
  const [daily] = await repo.getObservationCoverage(request);
  assert.equal(daily.sampleCount, 2);
  assert.equal(daily.knownCount, 0);
  assert.equal(daily.unknownCount, 2);
  assert.equal(daily.autoCount, 1);
  assert.equal(daily.manualCount, 0);
  assert.equal(daily.firstKnownAt, null);
  assert.equal(daily.lastKnownAt, null);
});

test('duplicate and out-of-order samples never increase the daily totals, including concurrent retries', async () => {
  const repo = createMemoryRepo();
  await record(repo, observation(10));
  assert.equal((await record(repo, observation(10))).outcome, 'duplicate');
  assert.equal((await record(repo, observation(9))).outcome, 'stale');
  await Promise.all(Array.from({ length: 5 }, () => record(repo, observation(11))));
  const [daily] = await repo.getObservationCoverage(request);
  assert.equal(daily.sampleCount, 2);
  assert.equal(daily.firstObservedAt, observation(10).observedAt);
  assert.equal(daily.lastObservedAt, observation(11).observedAt);
});

test('Beijing midnight starts a new summary even when both samples share the same UTC date', async () => {
  const repo = createMemoryRepo();
  await record(repo, observation(0, 'unavailable', { observedAt: '2026-09-16T15:59:59.999Z' }));
  await record(repo, observation(1, 'unknown', { observedAt: '2026-09-16T16:00:00.000Z', source: 'manual' }));
  const [before] = await repo.getObservationCoverage(request);
  const [after] = await repo.getObservationCoverage({ ...request, dayKey: '2026-09-17' });
  assert.equal(before.sampleCount, 1);
  assert.equal(before.knownCount, 1);
  assert.equal(before.autoCount, 1);
  assert.equal(after.sampleCount, 1);
  assert.equal(after.knownCount, 0);
  assert.equal(after.unknownCount, 1);
  assert.equal(after.manualCount, 1);
  assert.equal(after.firstKnownAt, null, 'yesterday known status must not be counted today');
});

test('failure of the latest, event or daily-summary write rolls back every observation write', async () => {
  for (const failureTable of [C.latest, C.events, C.observationDays]) {
    const repo = createMemoryRepo();
    repo.transactionWriteHook = async table => { if (table === failureTable) throw new Error('simulated observation write failure'); };
    await assert.rejects(record(repo, observation(0, 'available')), /simulated/);
    assert.deepEqual(await repo.getLatest(['R577|' + partNumber]), []);
    assert.deepEqual(await repo.getObservationCoverage(request), []);
    assert.equal((await repo.listEvents(request)).length, 0);
    repo.transactionWriteHook = null;
    await record(repo, observation(0, 'available'));
    assert.equal((await repo.getObservationCoverage(request))[0].sampleCount, 1);
    assert.equal((await repo.listEvents(request)).length, 1);
  }
});

test('an expired collector lease cannot write a summary while an accepted manual sample can', async () => {
  const repo = createMemoryRepo({ [C.config]: [{ _id: 'collector_lease', ownerId: 'worker', expiresAt: '2026-09-16T02:00:00.000Z' }] });
  await assert.rejects(record(repo, observation(1), { collectorLease: { ownerId: 'worker', nowIso: observation(1).observedAt } }), error => error.code === 'collector_lease_lost');
  assert.deepEqual(await repo.getObservationCoverage(request), []);
  await record(repo, observation(1, 'unavailable', { source: 'manual' }));
  assert.equal((await repo.getObservationCoverage(request))[0].manualCount, 1);
});

test('legacy latest and health counters are never backfilled into a day summary', async () => {
  const repo = createMemoryRepo({
    [C.latest]: [{ _id: 'R577|' + partNumber, storeNumber: 'R577', partNumber, status: 'unavailable',
      observedAt: observation(0).observedAt, knownAt: observation(0).observedAt, statusSince: '2026-09-10T00:00:00.000Z', sampleCount: 900 }],
    [C.health]: [{ _id: 'old-health', storeNumber: 'R577', partNumbers: [partNumber], successes: 800, requests: 999 }],
  });
  assert.deepEqual(await repo.getObservationCoverage(request), []);
  assert.deepEqual(await repo.getObservationCoverage({ ...request, dayKey: '2026-09-15' }), []);
  await record(repo, observation(1));
  const [daily] = await repo.getObservationCoverage(request);
  assert.equal(daily.sampleCount, 1);
  assert.equal(daily.firstObservedAt, observation(1).observedAt);
  assert.equal((await repo.getLatest(['R577|' + partNumber]))[0].sampleCount, 901);
});

test('zero events can mean no samples, unknown samples, unchanged unavailable or unchanged available', async () => {
  for (const scenario of ['no_samples', 'unknown', 'unavailable', 'available']) {
    const repo = createMemoryRepo();
    if (scenario === 'available') await record(repo, observation(0, 'available', { observedAt: '2026-09-15T02:00:00.000Z' }));
    if (scenario !== 'no_samples') for (let minute = 0; minute < 3; minute++) await record(repo, observation(minute, scenario));
    const events = await repo.getEventHistory({ ...request, snapshotAt: '2026-09-16T02:10:00.000Z' });
    assert.equal(events.total, 0, scenario);
    assert.ok(Object.values(events.summary).every(value => value === 0), scenario);
    const [daily] = await repo.getObservationCoverage(request);
    if (scenario === 'no_samples') assert.equal(daily, undefined);
    else {
      assert.equal(daily.sampleCount, 3);
      assert.equal(daily.knownCount, scenario === 'unknown' ? 0 : 3);
      assert.equal(daily.unknownCount, scenario === 'unknown' ? 3 : 0);
    }
  }
});

test('scope filters SKU, store and Beijing day; missing stores remain absent rather than fabricated zero rows', async () => {
  const repo = createMemoryRepo();
  await record(repo, observation(0, 'unavailable', { storeNumber: 'R639' }));
  await record(repo, observation(0));
  await record(repo, observation(0, 'unknown', { partNumber: 'MYYY2CH/A' }));
  await record(repo, observation(0, 'unavailable', { observedAt: '2026-09-16T16:01:00.000Z' }));
  assert.deepEqual((await repo.getObservationCoverage({ ...request, storeNumbers: [] })).map(row => row.storeNumber), ['R577', 'R639']);
  assert.deepEqual((await repo.getObservationCoverage({ ...request, storeNumbers: ['R639', 'R639', 'R001'] })).map(row => row.storeNumber), ['R639']);
  assert.deepEqual(await repo.getObservationCoverage({ ...request, storeNumbers: ['R001'] }), []);
  assert.deepEqual(await repo.getObservationCoverage({ ...request, partNumber: 'MZZZ3CH/A' }), []);
  assert.equal((await repo.getObservationCoverage(request))[0].sampleCount, 1);
});

test('production coverage adapter uses the new collection, exact day/SKU or deterministic target IDs, and paginates', async () => {
  const rows = Array.from({ length: 130 }, (_, index) => {
    const storeNumber = `R${String(100 + index)}`;
    return { _id: observationDayId(storeNumber, partNumber, request.dayKey), storeNumber, partNumber, dayKey: request.dayKey, sampleCount: 1 };
  });
  rows.push({ ...rows[0], _id: 'wrong-day', dayKey: '2026-09-15' }, { ...rows[0], _id: 'wrong-sku', partNumber: 'MYYY2CH/A' });
  const reads = [];
  const db = {
    command: { in: values => ({ in: values }) },
    collection(name) {
      assert.equal(name, C.observationDays);
      return { where(condition) {
        reads.push(condition);
        const matching = rows.filter(row => Object.entries(condition).every(([key, value]) => value && value.in ? value.in.includes(row[key]) : row[key] === value));
        let skip = 0, limit = 100; const ordering = [];
        const query = { orderBy(key, direction) { ordering.push([key, direction]); return query; }, skip(value) { skip = value; return query; }, limit(value) { limit = value; return query; },
          async get() { return { data: matching.slice().sort((a, b) => { for (const [key, direction] of ordering) if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'asc' ? 1 : -1); return 0; }).slice(skip, skip + limit) }; } };
        return query;
      } };
    },
  };
  const repo = createCloudbaseRepo(db);
  const all = await repo.getObservationCoverage({ ...request, storeNumbers: [] });
  assert.equal(all.length, 130);
  assert.deepEqual(reads[0], { partNumber, dayKey: request.dayKey });
  const selected = await repo.getObservationCoverage({ ...request, storeNumbers: ['R229', 'R100', 'R100', 'R999'] });
  assert.deepEqual(selected.map(row => row.storeNumber), ['R100', 'R229']);
  assert.deepEqual(reads[1]._id.in, ['R229', 'R100', 'R999'].map(store => observationDayId(store, partNumber, request.dayKey)));
  assert.deepEqual(INDEX_PLAN[C.observationDays][0].keys, { partNumber: 1, dayKey: 1, storeNumber: 1 });
});
