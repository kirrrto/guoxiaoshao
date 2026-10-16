import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, fakeFetch, userKeyOf, operatorContext } from './helpers/fixture.mjs';

const ok = envelope => { assert.equal(envelope.ok, true, JSON.stringify(envelope.error)); return envelope.data; };
const config = { collector: { budgetMode: 'continuous' }, query: { sharedFreshnessSeconds: 10 } };
const query = { queryId: 'release-resilience-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };

for (const outcome of ['available', 'failed']) {
  test(`a ${outcome} query replay retains its saved result but returns the current account balance`, async () => {
    const fetchImpl = fakeFetch({ R577: outcome === 'failed' ? { status: 503 } : { display: 'available' } });
    const f = createFixture({ fetchImpl });
    ok(await f.call('quota.signin'));
    const first = ok(await f.call('query.pickup', query));
    const requests = fetchImpl.calls.length;
    ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 2, grantId: 'replay-new-credit' }, operatorContext()));
    const replay = ok(await f.call('query.pickup', query));
    assert.equal(replay.balance, first.balance + 2);
    assert.equal(replay.quotaRevision, first.quotaRevision + 1);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay, { ...first, balance: first.balance + 2, quotaRevision: first.quotaRevision + 1, replayed: true });
    assert.equal(fetchImpl.calls.length, requests, 'replaying cannot make another upstream request');
    assert.equal((await f.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'query_debit').length, 1);
  });
}

for (const outcome of ['events', 'empty', 'failed']) {
  test(`a ${outcome} history replay retains billing and records but returns the current account balance`, async () => {
    const f = createFixture();
    ok(await f.call('quota.signin'));
    const payload = { historyQueryId: 'replay-history-001', partNumber: query.partNumber, storeNumbers: ['R577'] };
    if (outcome === 'events') await f.repo.saveEvents([{ _id: 'replay-event-001', partNumber: query.partNumber,
      storeNumber: 'R577', dayKey: '2026-09-15', detectedAt: f.state.now.toISOString(), type: 'first_seen_available' }]);
    if (outcome === 'failed') f.repo.getEventHistory = async () => { throw new Error('history unavailable'); };
    const first = ok(await f.call('history.list', payload));
    ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 2, grantId: 'replay-new-credit' }, operatorContext()));
    f.repo.getEventHistory = async () => { throw new Error('replay must use the saved history'); };
    const replay = ok(await f.call('history.list', payload));
    assert.equal(replay.balance, first.balance + 2);
    assert.equal(replay.quotaRevision, first.quotaRevision + 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.charged, first.charged);
    assert.equal(replay.refunded, first.refunded);
    assert.deepEqual(replay.events, first.events);
    assert.deepEqual(replay.pagination, first.pagination);
    assert.equal((await f.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'history_debit').length, 1);
  });
}

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
    await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00.000Z' } });
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
