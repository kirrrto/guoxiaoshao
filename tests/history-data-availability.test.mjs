import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const partNumber = 'MXXX1CH/A';
const selectedDay = '2026-09-14';
const start = '2026-09-16T01:00:00.000Z';
const request = { historyQueryId: 'history-availability-01', partNumber, storeNumbers: ['R577', 'R639'], dayKey: selectedDay };
const ok = envelope => { assert.equal(envelope.ok, true, JSON.stringify(envelope.error)); return envelope.data; };
const rows = (f, collection) => [...f.repo.tables.get(collection).values()];
const history = (f, payload = {}) => f.call('history.list', { ...request, ...payload }).then(ok);
const observation = (f, observedAt, status = 'unavailable', source = 'auto') => f.repo.recordObservation({ observation: { partNumber, storeNumber: 'R577', observedAt, status, source } });
const event = (id, minute, type = 'status_changed') => ({ _id: id, partNumber, storeNumber: 'R577', type, detectedAt: `2026-09-14T00:${minute}:00.000Z`, dayKey: selectedDay, status: 'pending', previousStatus: 'ineligible', source: 'auto' });

async function funded() {
  const f = createFixture({ start });
  ok(await f.call('quota.signin'));
  return f;
}

test('empty unobserved history returns an explicit absence and refunds its one debit', async () => {
  const f = await funded();
  const response = await history(f);
  assert.equal(response.ok, true);
  assert.deepEqual(response.dataAvailability, { status: 'no_records', eventCount: 0 });
  assert.deepEqual(response.billing, { reason: 'empty_history_refunded' });
  assert.equal(response.charged, 1);
  assert.equal(response.refunded, 1);
  assert.equal(response.balance, 1);
  assert.deepEqual(response.observationCoverage, { tracking: 'daily_samples_v1', scope: 'recorded_samples_only', checkedAt: start, requestedStoreNumbers: ['R577', 'R639'], stores: [] });
  assert.equal(response.pagination.total, 0);
  assert.equal(response.events.length, 0);
  assert.equal(rows(f, C.ledger).filter(entry => entry.type === 'history_debit').length, 1);
  assert.equal(rows(f, C.ledger).filter(entry => entry.type === 'query_refund').length, 1);
});

test('valid daily samples without changes are still no event result and do not consume credits', async () => {
  const f = await funded();
  await observation(f, '2026-09-14T00:00:00.000Z');
  await observation(f, '2026-09-14T00:01:00.000Z');
  const response = await history(f);
  assert.equal(response.dataAvailability.status, 'no_records');
  assert.equal(response.refunded, 1);
  assert.equal(response.balance, 1);
  assert.equal(response.observationCoverage.stores.length, 1, 'missing stores must not acquire invented zero-sample summaries');
  const sample = response.observationCoverage.stores[0];
  assert.equal(sample.storeNumber, 'R577');
  assert.equal(sample.sampleCount, 2);
  assert.equal(sample.knownCount, 2);
  assert.equal(sample.unknownCount, 0);
});

test('failed samples remain unknown evidence and an empty history is refunded', async () => {
  const f = await funded();
  await observation(f, '2026-09-14T00:00:00.000Z', 'unknown');
  await observation(f, '2026-09-14T00:01:00.000Z', 'unknown');
  const response = await history(f);
  assert.equal(response.dataAvailability.status, 'no_records');
  assert.equal(response.refunded, 1);
  const sample = response.observationCoverage.stores[0];
  assert.equal(sample.sampleCount, 2);
  assert.equal(sample.knownCount, 0);
  assert.equal(sample.unknownCount, 2);
});

test('a recent latest observation cannot manufacture coverage for an older selected day', async () => {
  const f = await funded();
  await observation(f, '2026-09-16T00:59:00.000Z');
  const response = await history(f);
  assert.equal(response.latest.length, 1);
  assert.equal(response.latest[0].isStale, false);
  assert.deepEqual(response.observationCoverage.stores, []);
  assert.equal(response.dataAvailability.status, 'no_records');
  assert.equal(response.refunded, 1);
});

test('status_changed counts as a real history result even when all four featured counters are zero', async () => {
  const f = await funded();
  await f.repo.saveEvents([event('status-change', '01')]);
  const response = await history(f);
  assert.deepEqual(response.dataAvailability, { status: 'recorded_events', eventCount: 1 });
  assert.deepEqual([response.summary.available, response.summary.restocks, response.summary.recoveries, response.summary.ended], [0, 0, 0, 0]);
  assert.equal(response.billing.reason, 'history_charged');
  assert.equal(response.charged, 1);
  assert.equal(response.refunded, 0);
  assert.equal(response.balance, 0);
  assert.equal(response.events[0].type, 'status_changed');
  assert.deepEqual(response.observationCoverage.stores, [], 'legacy events alone are not daily sample summaries');
});

test('an empty page in a nonempty history uses the full total and is not refunded', async () => {
  const f = await funded();
  await f.repo.saveEvents([event('status-change', '01')]);
  const cursor = Buffer.from(JSON.stringify({ detectedAt: '2026-09-14T00:00:00.000Z', id: 'before-events' })).toString('base64url');
  const response = await history(f, { cursor });
  assert.equal(response.events.length, 0);
  assert.equal(response.pagination.total, 1);
  assert.equal(response.dataAvailability.status, 'recorded_events');
  assert.equal(response.refunded, 0);
  assert.equal(response.balance, 0);
});

test('empty result replay and repeated cursors preserve the original absence and refund only once', async () => {
  const f = await funded();
  const first = await history(f);
  await observation(f, '2026-09-14T00:02:00.000Z', 'available');
  const cursor = Buffer.from(JSON.stringify({ detectedAt: start, id: 'any-id' })).toString('base64url');
  f.repo.getObservationCoverage = async () => { throw new Error('a replay must not reread newer coverage'); };
  const replays = await Promise.all([history(f), history(f, { cursor }), history(f)]);
  for (const response of replays) {
    assert.equal(response.replayed, true);
    assert.equal(response.pagination.total, 0);
    assert.equal(response.events.length, 0);
    assert.equal(response.refunded, 1);
    assert.equal(response.balance, 1);
    assert.deepEqual(response.observationCoverage, first.observationCoverage);
    assert.deepEqual(response.dataAvailability, first.dataAvailability);
    assert.deepEqual(response.billing, first.billing);
  }
  assert.equal(rows(f, C.ledger).filter(entry => entry.type === 'history_debit').length, 1);
  assert.equal(rows(f, C.ledger).filter(entry => entry.type === 'query_refund').length, 1);
});

test('pagination freezes original totals, summary, billing and independently timed coverage', async () => {
  const f = await funded();
  await observation(f, '2026-09-14T00:00:00.000Z');
  await f.repo.saveEvents([event('first', '03'), event('second', '02'), event('third', '01')]);
  const originalRead = f.repo.getObservationCoverage.bind(f.repo);
  let reads = 0;
  f.repo.getObservationCoverage = async args => {
    reads++;
    assert.equal(args.snapshotAt, undefined, 'daily summaries do not support historical event-cutoff reconstruction');
    const result = await originalRead(args);
    f.advance(1500);
    return result;
  };
  const readEvents = f.repo.getEventHistory.bind(f.repo), counted = [];
  f.repo.getEventHistory = async args => { counted.push(args.includeCounts); return readEvents(args); };
  const first = await history(f, { limit: 1 });
  assert.equal(first.observationCoverage.checkedAt, '2026-09-16T01:00:01.500Z');
  assert.equal(first.pagination.snapshotAt, start);
  assert.equal(first.observationCoverage.stores[0].sampleCount, 1);
  await observation(f, '2026-09-14T00:04:00.000Z');
  // A delayed historical insert changes the underlying aggregate after the
  // first query, but must not rewrite this already-billed result's counters.
  await f.repo.saveEvents([event('late-insert', '04', 'restock_confirmed')]);
  const second = await history(f, { limit: 1, cursor: first.pagination.nextCursor });
  assert.equal(second.replayed, true);
  assert.equal(second.events[0].id, 'second');
  assert.equal(second.pagination.total, 3);
  assert.deepEqual(second.summary, first.summary);
  assert.deepEqual(second.observationCoverage, first.observationCoverage);
  assert.deepEqual(second.dataAvailability, first.dataAvailability);
  assert.deepEqual(second.billing, first.billing);
  assert.equal(second.refunded, 0);
  assert.equal(second.balance, 0);
  assert.equal(reads, 1);
  assert.deepEqual(counted, [true, false], 'later pages reuse the frozen counts instead of re-running count queries');
  assert.equal(rows(f, C.ledger).filter(entry => entry.type === 'history_debit').length, 1);
  assert.equal(rows(f, C.ledger).filter(entry => entry.type === 'query_refund').length, 0);
});

test('members with no events receive a no-charge reason rather than a fictitious refund', async () => {
  const f = await funded();
  const user = rows(f, C.users)[0];
  await f.repo.updateUser(user._id, { membership: { expiresAt: '2026-10-16T01:00:00.000Z' } });
  const response = await history(f);
  assert.equal(response.member, true);
  assert.equal(response.billing.reason, 'empty_history_no_charge');
  assert.equal(response.charged, 0);
  assert.equal(response.refunded, 0);
  assert.equal(response.balance, 1);
  assert.equal(rows(f, C.ledger).filter(entry => ['history_debit', 'query_refund'].includes(entry.type)).length, 0);
});

test('legacy saved results without daily evidence stay unknown when replayed or paged', async () => {
  const f = await funded();
  await f.repo.saveEvents([event('first', '02'), event('second', '01')]);
  const first = await history(f, { limit: 1 });
  const saved = rows(f, C.queries)[0];
  delete saved.response.observationCoverage;
  delete saved.response.dataAvailability;
  delete saved.response.billing;
  await f.repo.saveQuery(saved);
  await observation(f, '2026-09-14T00:03:00.000Z');
  f.repo.getObservationCoverage = async () => { throw new Error('current daily samples cannot reconstruct a legacy query snapshot'); };
  const replay = await history(f);
  const next = await history(f, { cursor: first.pagination.nextCursor });
  assert.equal(replay.observationCoverage, undefined);
  assert.equal(next.observationCoverage, undefined);
  assert.equal(next.pagination.total, 2);
  assert.equal(next.events[0].id, 'second');
  assert.equal(next.balance, 0);
});

test('zero-balance visitors retain the existing pre-query gate and are not promised a free lookup', async () => {
  const f = createFixture({ start });
  f.repo.getObservationCoverage = async () => { throw new Error('denied queries must not read coverage'); };
  f.repo.getEventHistory = async () => { throw new Error('denied queries must not read events'); };
  const response = await history(f);
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'insufficient_credits');
  assert.equal(response.balance, 0);
  assert.equal(rows(f, C.queries).length, 0);
});

test('coverage read failure is a query failure with compensation, never a fabricated empty success', async () => {
  const f = await funded();
  f.repo.getObservationCoverage = async () => { throw new Error('coverage database unavailable'); };
  const response = await history(f);
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'query_failed');
  assert.equal(response.refunded, 1);
  assert.equal(response.balance, 1);
  assert.equal(response.dataAvailability, undefined);
  assert.equal(response.billing, undefined);
});
