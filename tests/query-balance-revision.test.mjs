import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf, operatorContext, PRODUCTS } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const ok = envelope => { assert.equal(envelope.ok, true, JSON.stringify(envelope.error)); return envelope.data; };
const payload = { queryId: 'revision-query-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
const snapshot = value => ({ balance: value.balance, revision: value.quotaRevision });

test('denied, busy, refunded and replayed queries expose the matching atomic balance revision', async () => {
  const f = createFixture();
  const denied = ok(await f.call('query.pickup', payload));
  assert.equal(denied.reason, 'insufficient_credits');
  assert.deepEqual(snapshot(denied), { balance: 0, revision: 0 });
  assert.equal(ok(await f.call('quota.signin')).quota.revision, 1);
  const record = { _id: `${userKeyOf()}|${payload.queryId}`, userKey: userKeyOf(), kind: 'live', ...payload };
  const begun = await f.repo.beginQuery({ record, product: PRODUCTS[1], config: mergeConfig(null), ownerId: 'owner', nowIso: f.state.now.toISOString() });
  assert.deepEqual(snapshot(begun), { balance: 0, revision: 2 });
  const busy = ok(await f.call('query.pickup', payload));
  assert.equal(busy.reason, 'query_in_progress');
  assert.deepEqual(snapshot(busy), { balance: 0, revision: 2 });
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 2, grantId: 'revision-reward' }, operatorContext()));
  const finished = await f.repo.finishQuery({ id: record._id, ownerId: 'owner', response: { ok: false, reason: 'query_failed', results: [] }, refund: true, nowIso: f.state.now.toISOString() });
  assert.deepEqual(snapshot(finished.response), { balance: 3, revision: 4 });
  assert.deepEqual(snapshot(ok(await f.call('query.pickup', payload))), { balance: 3, revision: 4 });
  assert.deepEqual(snapshot((await f.repo.finishQuery({ id: record._id, ownerId: 'owner', response: {}, refund: true, nowIso: f.state.now.toISOString() })).response), { balance: 3, revision: 4 });
});

test('completed live queries publish the debit revision so delayed rewards cannot restore spent balance', async () => {
  const f = createFixture({ fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
  const signin = ok(await f.call('quota.signin'));
  const result = ok(await f.call('query.pickup', payload));
  assert.equal(result.ok, true);
  assert.deepEqual(snapshot(result), { balance: 0, revision: signin.quota.revision + 1 });
  const user = await f.repo.getUser(userKeyOf());
  assert.equal(result.quotaRevision, user.quota.revision);
  assert.equal(result.balance, user.quota.balance);
});

test('expired pending query refunds save their newer balance revision without a second debit', async () => {
  const f = createFixture();
  ok(await f.call('quota.signin'));
  const record = { _id: `${userKeyOf()}|${payload.queryId}`, userKey: userKeyOf(), kind: 'live', ...payload };
  await f.repo.beginQuery({ record, product: PRODUCTS[1], config: mergeConfig(null), ownerId: 'lost', nowIso: f.state.now.toISOString() });
  f.advance(180000);
  const expired = await f.repo.expireQuery({ id: record._id, userKey: userKeyOf(), nowIso: f.state.now.toISOString(), staleBefore: new Date(f.state.now.getTime() - 120000).toISOString() });
  assert.equal(expired.expired, true);
  assert.deepEqual(snapshot(expired), { balance: 1, revision: 3 });
  const stored = await f.repo.getQuery(record._id);
  assert.deepEqual(snapshot(stored.response), { balance: 1, revision: 3 });
  assert.deepEqual(snapshot(ok(await f.call('query.pickup', payload))), { balance: 1, revision: 3 });
});

test('history rejection, charging, pagination and empty-result refunds preserve balance revision ordering', async () => {
  const f = createFixture();
  const request = { historyQueryId: 'revision-history-001', partNumber: payload.partNumber, storeNumbers: ['R577'], limit: 1 };
  assert.deepEqual(snapshot(ok(await f.call('history.list', request))), { balance: 0, revision: 0 });
  ok(await f.call('quota.signin'));
  await f.repo.saveEvents([1, 2].map(index => ({ _id: `revision-event-${index}`, partNumber: payload.partNumber, storeNumber: 'R577',
    dayKey: '2026-09-15', detectedAt: f.state.now.toISOString(), type: 'first_seen_available' })));
  const first = ok(await f.call('history.list', request));
  assert.deepEqual(snapshot(first), { balance: 0, revision: 2 });
  assert.ok(first.pagination.nextCursor);
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 2, grantId: 'history-revision-reward' }, operatorContext()));
  const second = ok(await f.call('history.list', { ...request, cursor: first.pagination.nextCursor }));
  assert.deepEqual(snapshot(second), { balance: 2, revision: 3 });
  const empty = ok(await f.call('history.list', { ...request, historyQueryId: 'revision-history-empty', dayKey: '2026-09-14' }));
  assert.equal(empty.refunded, 1);
  assert.deepEqual(snapshot(empty), { balance: 2, revision: 5 });
});

test('restricted history reports its current balance revision without granting restricted access', async () => {
  const f = createFixture({ config: { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-11T00:00:00.000Z' }] } });
  ok(await f.call('quota.signin'));
  const result = ok(await f.call('history.list', { historyQueryId: 'restricted-history-001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }));
  assert.equal(result.reason, 'new_product_history_restricted');
  assert.deepEqual(snapshot(result), { balance: 1, revision: 1 });
  assert.equal(result.events, undefined);
});
