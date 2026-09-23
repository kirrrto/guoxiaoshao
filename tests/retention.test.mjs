import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMemoryRepo } from './helpers/memory-repo.mjs';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const { RETENTION_DAYS, retentionStart, runRetentionIfDue } = require('../cloudfunctions/gxs_api/lib/engine/retention.js');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled.js');
const log = { info() {}, warn() {}, error() {} };
// 04:30 on 2026-09-24 in Beijing: the window keeps 2026-09-15 through 2026-09-24.
const now = new Date('2026-09-23T20:30:00.000Z');
const old = '2026-09-14T15:59:59.000Z', kept = '2026-09-14T16:00:00.000Z';

function seeded() {
  const repo = createMemoryRepo();
  const put = (collection, doc) => repo.tables.get(collection).set(doc._id, doc);
  put(C.events, { _id: 'old-event', dayKey: '2026-09-14' }); put(C.events, { _id: 'kept-event', dayKey: '2026-09-15' });
  put(C.observationDays, { _id: 'old-day', dayKey: '2026-09-14' }); put(C.observationDays, { _id: 'kept-day', dayKey: '2026-09-15' });
  put(C.queries, { _id: 'old-query', createdAt: old, status: 'success' }); put(C.queries, { _id: 'old-pending', createdAt: old, status: 'pending' }); put(C.queries, { _id: 'kept-query', createdAt: kept, status: 'success' });
  put(C.notifications, { _id: 'old-sent', createdAt: old, status: 'accepted' }); put(C.notifications, { _id: 'old-sending', createdAt: old, status: 'sending' }); put(C.notifications, { _id: 'kept-sent', createdAt: kept, status: 'accepted' });
  put(C.health, { _id: 'old-health', recordedAt: old });
  for (const doc of [{ _id: 'old-grant', kind: 'subscription_grant', createdAt: old }, { _id: 'kept-grant', kind: 'subscription_grant', createdAt: kept },
    { _id: 'old-guard', kind: 'query_guard', updatedAt: old }, { _id: 'collector_budget_2026-09-10', dayCount: 3 }, { _id: 'collector_budget_2026-09-15', dayCount: 3 },
    { _id: 'runtime', updatedAt: old }, { _id: 'collector_status', updatedAt: old, expiresAt: old }, { _id: 'collector_lease', expiresAt: old },
    { _id: 'payment_receipt-x', kind: 'payment_receipt', createdAt: old }, { _id: 'member_redemption_claims_launch_30d_v1', claimed: 3, updatedAt: old }]) put(C.config, doc);
  put(C.ledger, { _id: 'old-ledger', createdAt: old }); put(C.orders, { _id: 'old-order', createdAt: old });
  put(C.users, { _id: 'user' }); put(C.follows, { _id: 'follow', createdAt: old }); put(C.latest, { _id: 'latest', observedAt: old });
  return repo;
}
const ids = (repo, collection) => [...repo.tables.get(collection).keys()].sort();

test('retention keeps the latest 10 Beijing days and never touches accounts, money or live state', async () => {
  assert.equal(RETENTION_DAYS, 10);
  assert.equal(retentionStart(now), '2026-09-15');
  const repo = seeded();
  const status = await runRetentionIfDue({ repo, now, log });
  assert.equal(status.lastRunDay, '2026-09-24'); assert.equal(status.firstDay, '2026-09-15');
  assert.deepEqual(ids(repo, C.events), ['kept-event']);
  assert.deepEqual(ids(repo, C.observationDays), ['kept-day']);
  assert.deepEqual(ids(repo, C.queries), ['kept-query', 'old-pending'], 'a pending query may still owe a refund');
  assert.deepEqual(ids(repo, C.notifications), ['kept-sent', 'old-sending'], 'in-flight reminders stay');
  assert.deepEqual(ids(repo, C.health), []);
  assert.deepEqual(ids(repo, C.config), ['collector_budget_2026-09-15', 'collector_lease', 'collector_status', 'kept-grant', 'member_redemption_claims_launch_30d_v1', 'payment_receipt-x', 'retention_status', 'runtime']);
  for (const collection of [C.ledger, C.orders, C.users, C.follows, C.latest]) assert.equal(repo.tables.get(collection).size, 1, collection);
  assert.deepEqual(status.removed, { events: 1, observationDays: 1, queries: 1, notifications: 1, targetHealth: 1, subscriptionGrants: 1, queryGuards: 1, budgets: 1 });
});

test('retention runs once per Beijing day, only after 04:00, and never fails the monitor', async () => {
  const repo = seeded();
  assert.equal(await runRetentionIfDue({ repo, now: new Date('2026-09-23T19:59:00.000Z'), log }), null, '03:59 Beijing is too early');
  assert.equal(repo.tables.get(C.events).size, 2);
  assert.equal(await runRetentionIfDue({ repo, now, log, remainingMs: () => 5000 }), null, 'not enough time left in this run');
  assert.ok(await runRetentionIfDue({ repo, now, log }));
  let purges = 0; const purge = repo.purgeExpiredData; repo.purgeExpiredData = async args => { purges += 1; return purge(args); };
  assert.equal(await runRetentionIfDue({ repo, now: new Date(now.getTime() + 3600000), log }), null, 'already ran today');
  assert.equal(purges, 0);
  repo.purgeExpiredData = async () => { throw new Error('database unavailable'); };
  assert.equal(await runRetentionIfDue({ repo, now: new Date(now.getTime() + 86400000), log }), null, 'a failure is logged, not thrown');
});

test('the scheduled monitor purges expired history after its scan', async () => {
  const f = createFixture({ start: now.toISOString(), config: { collector: { enabled: true, intervalSeconds: 60, statusStaleAfterSeconds: 150 } }, fetchImpl: fakeFetch(() => ({ display: 'unavailable' })) });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-30T00:00:00Z' } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  f.repo.tables.get(C.events).set('old-event', { _id: 'old-event', dayKey: '2026-09-01', type: 'status_changed', notificationPlannedAt: old });
  const result = await runScheduled({ repo: f.repo, fetchImpl: fakeFetch(() => ({ display: 'unavailable' })), clock: () => new Date(f.state.now), log });
  assert.equal(result.scanned, 1);
  assert.equal(f.repo.tables.get(C.events).has('old-event'), false);
  assert.equal(f.repo.tables.get(C.config).get('retention_status').lastRunDay, '2026-09-24');
});

test('history refuses purged days before charging and hides expired recent views', async () => {
  const f = createFixture({ start: now.toISOString() });
  const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
  ok(await f.call('quota.signin'));
  const expired = await f.call('history.list', { historyQueryId: 'expired-day-01', partNumber: 'MJYH4CH/A', storeNumbers: [], dayKey: '2026-09-14' });
  assert.equal(expired.error.code, 'history_day_expired');
  assert.equal([...f.repo.tables.get(C.ledger).values()].filter(entry => entry.type === 'history_debit').length, 0);
  f.repo.tables.get(C.queries).set(`${userKeyOf()}|history|old-view`, { _id: `${userKeyOf()}|history|old-view`, userKey: userKeyOf(), kind: 'history', status: 'success', partNumber: 'MJYH4CH/A', dayKey: '2026-09-14', storeNumbers: [], createdAt: kept, finishedAt: kept });
  assert.deepEqual(ok(await f.call('history.browse')).recentViews, []);
});
