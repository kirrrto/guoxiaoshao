import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, fakeFetch } from './helpers/fixture.mjs';

const ok = envelope => { assert.equal(envelope.ok, true, JSON.stringify(envelope.error)); return envelope.data; };
const config = { collector: { budgetMode: 'continuous' }, query: { sharedFreshnessSeconds: 10 } };
const query = { queryId: 'release-resilience-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };

test('cleanup failure after a persisted shared refresh keeps the successful result and idempotent billing', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const f = createFixture({ config, fetchImpl });
  ok(await f.call('quota.signin'));
  f.repo.releaseQueryTarget = async () => { throw new Error('temporary cleanup outage'); };
  const result = ok(await f.call('query.pickup', query));
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'available');
  assert.equal(result.charged, 1);
  assert.equal(result.refunded, 0);
  const replay = ok(await f.call('query.pickup', query));
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(fetchImpl.calls.length, 1);
  ok(await f.call('history.browse'));
  const shared = ok(await f.call('query.pickup', { ...query, queryId: 'release-resilience-002' }));
  assert.equal(shared.ok, true);
  assert.equal(shared.allShared, true);
  assert.equal(shared.refunded, 1);
  assert.equal(fetchImpl.calls.length, 1, 'a retained lease cannot block the published fresh sample');
  assert.equal((await f.repo.getLatest(['R577|MXXX1CH/A']))[0].sampleCount, 1);
});

test('cleanup failure does not hide the real upstream pause or prevent the failed-query refund', async () => {
  const fetchImpl = fakeFetch({ R577: { status: 429 } });
  const f = createFixture({ config, fetchImpl });
  ok(await f.call('quota.signin'));
  f.repo.releaseQueryTarget = async () => { throw new Error('temporary cleanup outage'); };
  const result = ok(await f.call('query.pickup', query));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream_paused');
  assert.equal(result.refunded, 1);
  assert.equal(result.balance, 1);
  assert.ok(result.retryAfterMs > 0);
});

for (const timestamp of ['2026-09-16T02:00:00.000Z', 'invalid-time']) {
  test(`follow and history never present an invalid or future sample as current: ${timestamp}`, async () => {
    const f = createFixture({ config: { quota: { historyCost: 0 } } });
    ok(await f.call('user.bootstrap'));
    ok(await f.call('follow.upsert', { followId: 'sample-time-001', partNumber: query.partNumber, storeNumbers: ['R577'] }));
    await f.repo.saveLatest({ _id: 'R577|MXXX1CH/A', partNumber: query.partNumber, storeNumber: 'R577', status: 'available', observedAt: timestamp, knownAt: timestamp });
    const follow = ok(await f.call('follow.list')).follows[0].stores[0];
    assert.equal(follow.status, 'unknown');
    assert.equal(follow.isStale, true);
    const history = ok(await f.call('history.list', { historyQueryId: 'sample-history-001', partNumber: query.partNumber, storeNumbers: ['R577'] }));
    assert.equal(history.latest[0].status, 'unknown');
    assert.equal(history.latest[0].isStale, true);
    assert.equal(history.latest[0].observedAt, timestamp, 'do not invent a replacement capture time');
  });
}
