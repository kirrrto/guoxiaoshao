import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');

test('pinned SDK retention builds bounded budget queries and keeps every deletion inside the existing policy', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); }
  catch { t.skip('Run npm ci in cloudfunctions/gxs_api for the pinned SDK contract'); return; }
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV;
  process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk'); cloud.init({ env: 'offline-retention-contract' });
  assert.equal(sdkRequire('wx-server-sdk/package.json').version, '4.0.2');
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson');
  const requests = []; let rejectEvents = false;
  Database.reqClass = class OfflineTransport {
    async send(action, args) {
      assert.equal(action, 'database.removeDocument', 'the SDK must use only this offline transport');
      requests.push({ collection: args.collectionName, query: EJSON.parse(args.query) });
      if (rejectEvents && args.collectionName === C.events) return { code: 'DATABASE_REQUEST_FAILED', message: 'offline event cleanup rejected' };
      return { data: { deleted: 1 } };
    }
  };
  try {
    const repo = createCloudbaseRepo(db);
    const firstDay = '2026-10-17', cutoffIso = '2026-10-16T16:00:00.000Z';
    const result = await repo.purgeExpiredData({ firstDay, cutoffIso });
    assert.deepEqual(result.errors, {});
    assert.deepEqual(result.removed, { events: 1, queries: 1, notifications: 1, targetHealth: 1,
      subscriptionGrants: 1, queryGuards: 1, queryTargets: 1, budgets: 3 });
    assert.equal(requests.length, 10);
    const queryFor = collection => requests.find(row => row.collection === collection).query;
    assert.deepEqual(queryFor(C.events), { dayKey: { $lt: firstDay } });
    assert.deepEqual(queryFor(C.queries), { createdAt: { $lt: cutoffIso }, status: { $ne: 'pending' } });
    assert.deepEqual(queryFor(C.notifications), { createdAt: { $lt: cutoffIso }, status: { $nin: ['pending', 'sending'] } });
    assert.deepEqual(queryFor(C.health), { recordedAt: { $lt: cutoffIso } });
    const configRequests = requests.filter(row => row.collection === C.config);
    for (const [kind, field] of [['subscription_grant', 'createdAt'], ['query_guard', 'updatedAt'], ['query_target', 'updatedAt']]) {
      assert.deepEqual(configRequests.find(row => row.query.kind === kind).query, { kind, [field]: { $lt: cutoffIso } });
    }
    const batches = configRequests.filter(row => row.query._id).map(row => row.query._id.$in);
    assert.deepEqual(batches.map(batch => batch.length), [20, 20, 20]);
    const budgetIds = batches.flat();
    assert.equal(new Set(budgetIds).size, 60);
    assert.equal(budgetIds[0], 'collector_budget_2026-10-16');
    assert.equal(budgetIds.at(-1), 'collector_budget_2026-08-18');
    assert.ok(budgetIds.every(id => /^collector_budget_\d{4}-\d{2}-\d{2}$/.test(id) && id < `collector_budget_${firstDay}`));
    const preserved = new Set([C.users, C.ledger, C.orders, C.follows, C.latest, C.observationDays]);
    assert.ok(requests.every(row => !preserved.has(row.collection)), 'accounts, money, follows and live/summary state must not be deleted');

    requests.length = 0; rejectEvents = true;
    const partial = await repo.purgeExpiredData({ firstDay, cutoffIso });
    assert.equal(requests.length, 10, 'one rejected collection must not prevent the remaining cleanup');
    assert.match(partial.errors.events, /offline event cleanup rejected/);
    assert.deepEqual(Object.keys(partial.errors), ['events']);
    assert.equal(partial.removed.events, 0);
    assert.equal(partial.removed.budgets, 3);
  } finally {
    Database.reqClass = previousRequest;
    if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV;
    else process.env.TENCENTCLOUD_RUNENV = previousRuntime;
  }
});
