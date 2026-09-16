import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf, operatorContext, PRODUCTS } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config.js');
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo.js');
const { hashCode, attemptsId } = require('../cloudfunctions/gxs_api/lib/member-redemption.js');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const payload = { queryId: 'atomic-query-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
const observation = (at, status = 'available') => ({ storeNumber: 'R577', partNumber: 'MXXX1CH/A', status, observedAt: at, source: 'manual', quote: status });
const debitCount = async f => (await f.repo.listLedger(userKeyOf())).filter(x => x.type === 'query_debit').length;

test('concurrent retries run one upstream request and bind the query ID to its parameters', async () => {
  const realFetch = fakeFetch({ R577: { display: 'available' } });
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = createFixture({ fetchImpl: async (...args) => { entered(); await gate; return realFetch(...args); } });
  ok(await f.call('quota.signin'));
  const first = f.call('query.pickup', payload);
  await started;
  const retries = await Promise.all(Array.from({ length: 6 }, () => f.call('query.pickup', payload)));
  assert.ok(retries.every(r => r.data.reason === 'query_in_progress'));
  release();
  assert.equal(ok(await first).ok, true);
  assert.equal(realFetch.calls.length, 1);
  assert.equal(await debitCount(f), 1);
  const changed = await f.call('query.pickup', { ...payload, partNumber: 'MYYY2CH/A' });
  assert.equal(changed.error.code, 'query_id_conflict');
  assert.equal(ok(await f.call('query.pickup', payload)).replayed, true);
});

test('a worker crash after debit recovers with the last credit already spent and fences the old worker', async () => {
  const f = createFixture({ fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
  ok(await f.call('quota.signin'));
  const record = { _id: `${userKeyOf()}|${payload.queryId}`, userKey: userKeyOf(), kind: 'live', ...payload };
  const begun = await f.repo.beginQuery({ record, product: PRODUCTS[1], config: mergeConfig(null), ownerId: 'crashed', nowIso: f.state.now.toISOString() });
  assert.equal(begun.balance, 0);
  assert.equal(ok(await f.call('query.pickup', payload)).reason, 'query_in_progress');
  f.advance(26000);
  const result = ok(await f.call('query.pickup', payload));
  assert.equal(result.ok, true);
  assert.equal(result.balance, 0);
  assert.equal(await debitCount(f), 1);
  const obsolete = await f.repo.finishQuery({ id: record._id, ownerId: 'crashed', response: { ok: false }, refund: true, nowIso: f.state.now.toISOString() });
  assert.equal(obsolete.completed, false);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 0);
});

test('pending-record failure rolls back debit; event-write failure rolls back latest and refunds the query', async () => {
  const f = createFixture({ fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
  ok(await f.call('quota.signin'));
  f.repo.transactionWriteHook = async (table, doc) => { if (table === C.queries && doc.status === 'pending') throw new Error('query write failed'); };
  const failed = await f.call('query.pickup', payload);
  assert.equal(failed.error.code, 'internal_error');
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
  assert.equal(await debitCount(f), 0);
  f.repo.transactionWriteHook = async table => { if (table === C.events) throw new Error('event write failed'); };
  const compensated = ok(await f.call('query.pickup', payload));
  assert.equal(compensated.reason, 'query_failed');
  assert.equal(compensated.refunded, 1);
  assert.equal(compensated.balance, 1);
  assert.deepEqual(await f.repo.getLatest(['R577|MXXX1CH/A']), []);
  assert.equal(await f.repo.count(C.events), 0);
  assert.equal(ok(await f.call('query.pickup', payload)).refunded, 1);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(e => e.type === 'query_refund').length, 1);
});

test('returning to the app refunds an abandoned query after the recovery grace period exactly once', async () => {
  const f = createFixture();
  ok(await f.call('quota.signin'));
  const record = { _id: `${userKeyOf()}|${payload.queryId}`, userKey: userKeyOf(), kind: 'live', ...payload };
  await f.repo.beginQuery({ record, product: PRODUCTS[1], config: mergeConfig(null), ownerId: 'abandoned', nowIso: f.state.now.toISOString() });
  assert.equal(ok(await f.call('user.bootstrap')).quota.balance, 0, 'active worker must not be refunded');
  f.advance(180000);
  assert.equal(ok(await f.call('user.bootstrap')).quota.balance, 1);
  assert.equal(ok(await f.call('user.bootstrap')).quota.balance, 1);
  assert.equal((await f.repo.getQuery(record._id)).response.reason, 'query_expired');
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(e => e.type === 'query_refund').length, 1);
});

test('parallel store fetches obey the three-request bound and timeout returns a refund', async () => {
  let active = 0; let peak = 0;
  const underlying = fakeFetch({ R577: {}, R639: {}, R320: {} });
  const f = createFixture({ fetchImpl: async (...args) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return underlying(...args); } });
  ok(await f.call('quota.signin'));
  assert.equal(ok(await f.call('query.pickup', { ...payload, storeNumbers: ['R577', 'R639', 'R320'] })).ok, true);
  assert.equal(peak, 3);
  const stalled = createFixture({ config: { query: { upstreamTimeoutMs: 20 } }, fetchImpl: async () => new Promise(() => {}) });
  ok(await stalled.call('quota.signin'));
  const start = Date.now();
  const result = ok(await stalled.call('query.pickup', payload));
  assert.equal(result.refunded, 1);
  assert.ok(Date.now() - start < 1000);
});

test('atomic observations ignore older samples and retry one event after a transaction failure', async () => {
  const f = createFixture();
  const later = observation('2026-09-15T02:00:01.000Z');
  const older = observation('2026-09-15T02:00:00.000Z', 'unavailable');
  await Promise.all([f.repo.recordObservation({ observation: later }), f.repo.recordObservation({ observation: older })]);
  assert.equal((await f.repo.getLatest(['R577|MXXX1CH/A']))[0].status, 'available');
  assert.equal(await f.repo.count(C.events), 1);
  assert.equal((await f.repo.recordObservation({ observation: later })).outcome, 'duplicate');
  const next = observation('2026-09-15T02:00:02.000Z', 'unavailable');
  f.repo.transactionWriteHook = async table => { if (table === C.events) throw new Error('storage down'); };
  await assert.rejects(f.repo.recordObservation({ observation: next }));
  assert.equal((await f.repo.getLatest(['R577|MXXX1CH/A']))[0].status, 'available');
  f.repo.transactionWriteHook = null;
  await f.repo.recordObservation({ observation: next });
  assert.equal(await f.repo.count(C.events), 2);
});

test('new-product history cannot expose live status and cannot reuse payment for changed filters', async () => {
  const f = createFixture({ config: { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-11T00:00:00.000Z' }] } });
  ok(await f.call('quota.signin'));
  await f.repo.saveLatest({ _id: 'R577|MJYH4CH/A', storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available', observedAt: f.state.now.toISOString(), quote: '今天可取货' });
  await f.repo.saveEvents([{ _id: 'bound-paid-history-event', partNumber: 'MJYH4CH/A', storeNumber: 'R577', dayKey: '2026-09-14', detectedAt: '2026-09-14T01:00:00.000Z', type: 'restock_confirmed' }]);
  const request = { historyQueryId: 'history-bound-01', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], dayKey: '2026-09-14' };
  const history = ok(await f.call('history.list', request));
  assert.deepEqual(history.latest, []);
  assert.equal(history.latestRestricted, true);
  assert.equal(history.balance, 0);
  const other = await f.call('history.list', { ...request, partNumber: 'MXXX1CH/A' });
  assert.equal(other.error.code, 'query_id_conflict');
  assert.equal((await f.call('history.list', { ...request, dayKey: '2026-02-30' })).error.code, 'invalid_day');
});

test('history pages include all 305 events with exact totals, tie ordering and one debit', async () => {
  const f = createFixture();
  ok(await f.call('quota.signin'));
  await f.repo.saveEvents(Array.from({ length: 305 }, (_, i) => ({ _id: `event-${String(i).padStart(4, '0')}`, partNumber: 'MXXX1CH/A', storeNumber: 'R577', dayKey: '2026-09-15', detectedAt: '2026-09-15T01:00:00.000Z', type: 'restock_confirmed' })));
  const request = { historyQueryId: 'history-paging-1', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
  const ids = []; let cursor;
  do {
    const page = ok(await f.call('history.list', { ...request, cursor }));
    assert.equal(page.pagination.total, 305);
    assert.equal(page.summary.restocks, 305);
    assert.equal(page.summary.lastHourRestocks, 305);
    ids.push(...page.events.map(e => e.id));
    cursor = page.pagination.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 305);
  assert.equal(new Set(ids).size, 305);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(e => e.type === 'history_debit').length, 1);
});

test('concurrent rewards enforce both balance and daily limits inside the transaction', async () => {
  for (const settings of [{ balance: 9, cap: 2, expected: 10 }, { balance: 0, cap: 1, expected: 1 }]) {
    const f = createFixture({ config: { quota: { dailyGrantCap: settings.cap, historyCost: 0 } } });
    ok(await f.call('user.bootstrap'));
    assert.equal(ok(await f.call('history.list', { historyQueryId: 'cap-history-proof', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] })).ok, true);
    await f.repo.updateUser(userKeyOf(), { quota: { balance: settings.balance } });
    await Promise.all([f.call('quota.signin'), f.call('quota.completeTask', { taskId: 'view_history' })]);
    assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, settings.expected);
    assert.equal(ok(await f.call('user.bootstrap')).quota.grantedToday, 1);
  }
});

test('concurrent follows cannot exceed three SKUs; expiry and stale health are reported honestly', async () => {
  const f = createFixture({ config: { collector: { enabled: true } } });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), grantId: 'reliability-member', days: 1 }, operatorContext()));
  const attempts = await Promise.all(PRODUCTS.slice(0, 4).map((p, i) => f.call('follow.upsert', { followId: `follow-race-${i}`, partNumber: p.partNumber, storeNumbers: ['R577'] })));
  assert.equal(attempts.filter(r => r.ok).length, 3);
  assert.equal(attempts.find(r => !r.ok).error.code, 'too_many_follows');
  await f.repo.saveCollectorStatus({ state: 'running', intervalMs: 8000, updatedAt: f.state.now.toISOString() });
  f.advance(86400001);
  const follows = ok(await f.call('follow.list'));
  assert.ok(follows.follows.every(follow => follow.status === 'expired'));
  assert.equal(ok(await f.call('user.bootstrap')).collector.state, 'stale');
});

test('expired follows cannot expose restricted new-product inventory through any stock field', async () => {
  const f = createFixture({ config: { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-14T00:00:00.000Z' }] } });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), grantId: 'expiry-inventory-member', days: 1 }, operatorContext()));
  for (const [i, partNumber] of ['MJYH4CH/A', 'MXXX1CH/A'].entries()) ok(await f.call('follow.upsert', { followId: `expiry-inventory-${i}`, partNumber, storeNumbers: ['R577'] }));
  f.advance(2 * 86400000);
  const writeLatest = async partNumber => f.repo.saveLatest({ _id: `R577|${partNumber}`, partNumber, storeNumber: 'R577', status: 'available', statusSince: f.state.now.toISOString(), observedAt: f.state.now.toISOString(), knownAt: f.state.now.toISOString(), quote: 'fresh protected supply' });
  await Promise.all(['MJYH4CH/A', 'MXXX1CH/A'].map(writeLatest));
  assert.equal(ok(await f.call('query.pickup', { queryId: 'expiry-inventory-query', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] })).reason, 'new_product_restricted');
  const result = ok(await f.call('follow.list'));
  assert.equal(result.member, false); assert.equal(result.follows.length, 2);
  const protectedFollow = result.follows.find(follow => follow.partNumber === 'MJYH4CH/A');
  assert.equal(protectedFollow.status, 'expired'); assert.equal(protectedFollow.latestRestricted, true);
  assert.equal(protectedFollow.stores[0].status, 'unknown');
  for (const key of ['lastKnownStatus', 'statusSince', 'observedAt', 'unknownSince', 'quote']) assert.equal(protectedFollow.stores[0][key], null, key);
  assert.equal(protectedFollow.stores[0].knownAt, undefined);
  const normalFollow = result.follows.find(follow => follow.partNumber === 'MXXX1CH/A');
  assert.equal(normalFollow.latestRestricted, false); assert.equal(normalFollow.stores[0].status, 'available');
  assert.equal((await f.call('follow.resume', { followId: normalFollow.followId })).error.code, 'member_required');
  f.advance(30 * 86400000); await writeLatest('MJYH4CH/A');
  const released = ok(await f.call('follow.list')).follows.find(follow => follow.partNumber === 'MJYH4CH/A');
  assert.equal(released.latestRestricted, false); assert.equal(released.stores[0].status, 'available');
});

test('membership fulfillment rolls back on failure and concurrent different orders preserve all days', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  const nowIso = f.state.now.toISOString();
  for (const id of ['one', 'two']) await f.repo.saveOrder({ _id: id, orderId: id, userKey: userKeyOf(), days: 30, status: 'paid', createdAt: nowIso });
  f.repo.transactionWriteHook = async (table, doc) => { if (table === C.orders && doc.status === 'fulfilled') throw new Error('fulfillment write failed'); };
  await assert.rejects(f.repo.fulfilMembershipOrder({ orderId: 'one', source: 'admin_grant', nowIso }));
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, null);
  assert.equal((await f.repo.getOrder('one')).status, 'paid');
  f.repo.transactionWriteHook = null;
  await Promise.all(['one', 'two'].map(orderId => f.repo.fulfilMembershipOrder({ orderId, source: 'admin_grant', nowIso })));
  assert.equal(Date.parse((await f.repo.getUser(userKeyOf())).membership.expiresAt) - Date.parse(nowIso), 60 * 86400000);
  assert.equal((await f.repo.fulfilMembershipOrder({ orderId: 'one', source: 'admin_grant', nowIso })).applied, false);
});

test('retained disabled payment repository primitives prevent transaction reuse and repeated refunds', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  const nowIso = f.state.now.toISOString();
  for (const id of ['payment-one', 'payment-two']) await f.repo.createOrderIfAbsent({ _id: id, orderId: id, outTradeNo: id, userKey: userKeyOf(), days: 30, amountFen: 900, status: 'created', createdAt: nowIso });
  const paid = await f.repo.markOrderPaid({ orderId: 'payment-one', transactionId: 'tx-one', nowIso, providerData: { amountFen: 900 } });
  assert.equal(paid.order.status, 'paid');
  await assert.rejects(f.repo.markOrderPaid({ orderId: 'payment-two', transactionId: 'tx-one', nowIso, providerData: { amountFen: 900 } }), error => error.code === 'payment_already_used');
  await f.repo.fulfilMembershipOrder({ orderId: 'payment-one', source: 'offline-test', nowIso });
  assert.equal((await f.repo.markOrderRefunded({ orderId: 'payment-one', nowIso })).applied, true);
  assert.equal((await f.repo.markOrderRefunded({ orderId: 'payment-one', nowIso })).applied, false);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, nowIso);
});

test('unknown invocation origins cannot become administrators and cross-account identity cannot mix OPENIDs', async () => {
  const { resolveIdentity } = require('../cloudfunctions/gxs_api/lib/identity.js');
  const { authorize } = require('../cloudfunctions/cloudbase_auth/authorize.js');
  const options = { allowedAppids: ['wxe96ad9e77b602f1b'], adminUserKeys: [] };
  for (const source of [undefined, '', 'wx_http', 'scf', 'wx_unknown', 'wx_client,scf', 'wx_http,wx_devtools', 'wx_devtools,unknown']) {
    assert.equal(resolveIdentity({ SOURCE: source }, options).isAdmin, false, String(source));
  }
  for (const source of ['wx_devtools', 'wx_trigger', 'wx_devtools,scf']) assert.equal(resolveIdentity({ SOURCE: source }, options).isAdmin, true);
  const brokenPair = resolveIdentity({ FROM_APPID: 'wxe96ad9e77b602f1b', OPENID: 'resource-owner-user', SOURCE: 'wx_devtools' }, options);
  assert.equal(brokenPair.userKey, null);
  assert.equal(brokenPair.isAdmin, false);
  assert.equal(authorize({}, { fromAppid: 'wxe96ad9e77b602f1b' }).allowed, false);
  assert.equal(authorize({ FROM_APPID: 'wxe96ad9e77b602f1b' }, {}).allowed, true);
  assert.equal(authorize({ FROM_APPID: 'wxe96ad9e77b602f1b' }, { fromAppid: 'wxevil' }).allowed, false);
  const f = createFixture();
  assert.equal((await f.call('admin.getConfig', {}, {})).error.code, 'forbidden');
});

test('reused admin operation IDs reject changed amounts or membership days', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'same-credit-id', amount: 1 }, operatorContext()));
  assert.equal((await f.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'same-credit-id', amount: 10 }, operatorContext())).error.code, 'ledger_id_conflict');
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), grantId: 'same-member-id', days: 30 }, operatorContext()));
  assert.equal((await f.call('admin.grantMembership', { userKey: userKeyOf(), grantId: 'same-member-id', days: 300 }, operatorContext())).error.code, 'order_id_conflict');
});

test('real wx-server-sdk 4.0.2 adapter preserves transaction results, null/object replacements, rollback and conflict retries', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); } catch { t.skip('Run npm ci in cloudfunctions/gxs_api to execute the pinned SDK contract test'); return; }
  // Prevent the SDK environment preflight from querying a cloud metadata host.
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV;
  process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk');
  cloud.init({ env: 'offline-contract-test' });
  const db = cloud.database();
  assert.equal(sdkRequire('wx-server-sdk/package.json').version, '4.0.2');
  const { EJSON } = sdkRequire('bson');
  const Database = db._db.constructor;
  const previousRequest = Database.reqClass;
  const copy = value => EJSON.parse(EJSON.stringify(value));
  let committed = { [C.users]: { user: { _id: 'user', quota: { balance: 1 }, membership: { expiresAt: null } } } };
  const transactions = new Map(); const calls = []; let sequence = 0; let conflict = false; let conflictRead = false; let conflictWrite = false; let failWrite = false; let conflictRuntimePatch = null; let failConfigAuditWrite = false;
  Database.reqClass = class OfflineTransport {
    async send(action, args = {}) {
      calls.push({ action, args: copy(args) });
      if (action === 'database.startTransaction') { const id = `tx-${++sequence}`; transactions.set(id, copy(committed)); return { transactionId: id }; }
      if (action === 'database.commitTransaction') {
        if (conflict) {
          conflict = false;
          if (conflictRuntimePatch) { committed[C.config].runtime = { ...committed[C.config].runtime, ...conflictRuntimePatch }; conflictRuntimePatch = null; }
          transactions.delete(args.transactionId);
          return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'simulated conflict' };
        }
        committed = transactions.get(args.transactionId); transactions.delete(args.transactionId); return {};
      }
      if (action === 'database.abortTransaction') { transactions.delete(args.transactionId); return {}; }
      if (action === 'database.getDocument' && !args.transactionId) {
        const query = EJSON.parse(args.query);
        let rows;
        if (args.collectionName === C.config) {
          assert.deepEqual(query._id, { $in: ['catalog', 'collector_status'] });
          assert.equal(args.limit, 2);
          rows = Object.values(committed[C.config]);
        } else {
          assert.equal(args.collectionName, C.queries);
          assert.equal(query.userKey, 'user');
          assert.equal(query.kind, 'history');
          assert.equal(query.status, 'success');
          assert.deepEqual(query.$and, [{ finishedAt: { $gte: '2026-09-14T16:00:00.000Z' } }, { finishedAt: { $lt: '2026-09-15T16:00:00.000Z' } }]);
          assert.equal(args.limit, 1);
          rows = [committed[C.queries].history];
        }
        return { data: { list: rows.map(row => EJSON.stringify(row)) } };
      }
      assert.ok(args.transactionId, 'all database operations must carry the transaction ID');
      const tables = transactions.get(args.transactionId);
      const rows = tables[args.collectionName] ||= {};
      if (action === 'database.getDocument') {
        if (conflictRead) { conflictRead = false; return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'database transaction conflict' }; }
        const id = EJSON.parse(args.query)._id;
        return { data: { list: rows[id] ? [EJSON.stringify(rows[id])] : [] } };
      }
      if (action === 'database.insertDocument') {
        const inserted = args.data.map(data => EJSON.parse(data));
        if (failConfigAuditWrite && inserted.some(doc => doc.kind === 'runtime_config_audit')) { failConfigAuditWrite = false; throw new Error('simulated audit storage outage'); }
        for (const doc of inserted) rows[doc._id] = doc;
        return { data: { insertedIds: inserted.map(doc => doc._id) } };
      }
      if (action === 'database.modifyDocument') {
        if (conflictWrite) { conflictWrite = false; return { code: 'ResourceUnavailable.TransactionConflict', message: '[ResourceUnavailable.TransactionConflict] Transaction is conflict, maybe resource operated by others' }; }
        if (failWrite) { failWrite = false; throw new Error('simulated write outage'); }
        assert.equal(args.merge, false, 'complete transaction documents must use SDK set, not flattened update');
        const id = EJSON.parse(args.query)._id;
        rows[id] = { _id: id, ...EJSON.parse(args.data) };
        return { data: { updated: 1, upsert_id: null } };
      }
      throw new Error(`Unexpected SDK operation: ${action}`);
    }
  };
  try {
    const repo = createCloudbaseRepo(db);
    const record = { _id: 'query', userKey: 'user', kind: 'live', queryId: 'sdk-query-01', partNumber: PRODUCTS[1].partNumber, storeNumbers: ['R577'] };
    const nowIso = '2026-09-15T02:00:00.000Z';
    const leaseInput = { id: 'collector_lease', ownerId: 'worker', now: nowIso, expiresAt: '2026-09-15T02:00:15.000Z' };
    assert.equal((await repo.acquireLease(leaseInput)).acquired, true);
    conflictWrite = true;
    const leaseStarts = sequence;
    assert.equal((await repo.acquireLease({ ...leaseInput, expiresAt: '2026-09-15T02:00:16.000Z' })).acquired, true);
    assert.equal(sequence - leaseStarts, 2, 'actual SDK-wrapped ResourceUnavailable.TransactionConflict must retry lease renewal');
    assert.equal(committed[C.config].collector_lease.expiresAt, '2026-09-15T02:00:16.000Z');
    failWrite = true;
    const uncertainLeaseStarts = sequence;
    await assert.rejects(repo.acquireLease({ ...leaseInput, expiresAt: '2026-09-15T02:00:17.000Z' }));
    assert.equal(sequence - uncertainLeaseStarts, 1, 'generic network/write failures must not be retried');
    assert.equal(committed[C.config].collector_lease.expiresAt, '2026-09-15T02:00:16.000Z');
    const begun = await repo.beginQuery({ record, product: PRODUCTS[1], config: mergeConfig(null), ownerId: 'sdk-worker', nowIso });
    assert.equal(begun.balance, 0);
    assert.equal(committed[C.queries].query.response, null);
    conflict = true;
    const starts = sequence;
    const result = await repo.finishQuery({ id: 'query', ownerId: 'sdk-worker', response: { ok: true, results: [] }, refund: false, nowIso });
    assert.equal(result.response.ok, true);
    assert.equal(sequence - starts, 2, 'SDK must retry exactly the simulated commit conflict');
    assert.equal(committed[C.queries].query.response.ok, true);
    conflictRead = true;
    const readStarts = sequence;
    const replay = await repo.beginQuery({ record, product: PRODUCTS[1], config: mergeConfig(null), ownerId: 'sdk-worker', nowIso });
    assert.equal(replay.replayed, true);
    assert.equal(sequence - readStarts, 2, 'wrapped read conflicts must also enter the bounded SDK retry loop');
    committed[C.orders] = { membership: { _id: 'membership', orderId: 'membership', status: 'paid', days: 30, userKey: 'user' } };
    failWrite = true;
    await assert.rejects(repo.fulfilMembershipOrder({ orderId: 'membership', source: 'offline', nowIso }));
    assert.equal(committed[C.users].user.membership.expiresAt, null);
    assert.ok(calls.some(call => call.action === 'database.abortTransaction'));
    const fulfilled = await repo.fulfilMembershipOrder({ orderId: 'membership', source: 'offline', nowIso });
    assert.equal(fulfilled.applied, true);
    assert.equal(committed[C.users].user.membership.expiresAt, '2026-10-15T02:00:00.000Z');
    await repo.beginQuery({ record: { ...record, _id: 'history', kind: 'history', dayKey: '2026-09-14' }, product: PRODUCTS[1], config: mergeConfig(null), ownerId: 'history-worker', nowIso });
    await repo.finishQuery({ id: 'history', ownerId: 'history-worker', response: { ok: true, events: [] }, refund: false, nowIso });
    assert.equal(committed[C.users].user.taskEvidence.view_history.queryId, 'history');
    assert.equal((await repo.findCompletedHistoryQuery('user', { startAt: '2026-09-14T16:00:00.000Z', endAt: '2026-09-15T16:00:00.000Z' }))._id, 'history');
    const reward = await repo.grantReward({ entry: { _id: 'reward-history', userKey: 'user', type: 'task_reward', taskId: 'view_history', dayKey: '2026-09-15', createdAt: nowIso }, config: mergeConfig(null).quota, reward: 1, evidenceQueryId: 'history', rewardSnapshot: { dayKey: '2026-09-15', grantedToday: 0, signedInToday: false, tasksDoneToday: [] } });
    assert.equal(reward.amount, 1);
    assert.deepEqual(committed[C.users].user.quota.dailyRewardSnapshot.tasksDoneToday, ['view_history']);
    await repo.updateUserSettings('user', { notifyEnabled: false });
    await repo.updateUserSettings('user', { dnd: { enabled: true, startMinute: 1380, endMinute: 480 } });
    assert.equal(committed[C.users].user.settings.notifyEnabled, false);
    const wrongCode = await repo.redeemMembershipCode({ userKey: 'user', codeHash: hashCode('wrong-code'), nowIso });
    assert.equal(wrongCode.error.code, 'invalid_redemption_code');
    assert.equal(committed[C.config][attemptsId('user')].failures, 1, 'failed guesses commit instead of rolling back');
    const beforeRedemption = committed[C.users].user.membership.expiresAt;
    failWrite = true;
    await assert.rejects(repo.redeemMembershipCode({ userKey: 'user', codeHash: hashCode('hbw666'), nowIso }));
    assert.equal(committed[C.users].user.membership.expiresAt, beforeRedemption);
    assert.equal(committed[C.config][attemptsId('user')].failures, 1);
    conflict = true;
    const redeemStarts = sequence;
    const redeemed = await repo.redeemMembershipCode({ userKey: 'user', codeHash: hashCode('hbw666'), nowIso });
    assert.equal(redeemed.alreadyRedeemed, false); assert.equal(sequence - redeemStarts, 2);
    assert.equal(redeemed.user.membership.expiresAt, new Date(Date.parse(beforeRedemption) + 30 * 86400000).toISOString());
    assert.equal((await repo.redeemMembershipCode({ userKey: 'user', codeHash: hashCode('hbw666'), nowIso })).alreadyRedeemed, true);
    assert.equal(Object.values(committed[C.orders]).filter(o => o.type === 'membership_redemption').length, 1);
    await repo.patchRuntimeConfig({ patch: { memberRedemption: { enabled: true }, collector: { intervalSeconds: 12 } }, updatedAt: nowIso, actor: { isOperator: true, userKey: null, source: 'wx_devtools' } });
    conflict = true; conflictRuntimePatch = { memberRedemption: { enabled: false } };
    const configStarts = sequence;
    const patched = await repo.patchRuntimeConfig({ patch: { announcement: 'SDK concurrent update', collector: { maxConcurrency: 3 } }, updatedAt: nowIso, actor: { isOperator: true, userKey: null, source: 'wx_devtools' } });
    assert.equal(sequence - configStarts, 2, 'conflicting configuration edits must retry against the latest runtime');
    assert.equal(patched.config.memberRedemption.enabled, false);
    assert.equal(committed[C.config].runtime.memberRedemption.enabled, false);
    assert.equal(committed[C.config].runtime.announcement, 'SDK concurrent update');
    assert.deepEqual(committed[C.config].runtime.collector, { intervalSeconds: 12, maxConcurrency: 3 });
    const configAudits = Object.values(committed[C.config]).filter(row => row.kind === 'runtime_config_audit').sort((a, b) => a.revision - b.revision);
    assert.deepEqual(configAudits.map(row => row.revision), [1, 2], 'SDK conflict retries must commit only one audit per successful update');
    assert.equal(configAudits[1].changes.collector.before.maxConcurrency, 2);
    assert.equal(configAudits[1].changes.collector.after.maxConcurrency, 3);
    const configBeforeFailure = copy(committed[C.config]);
    failConfigAuditWrite = true;
    await assert.rejects(repo.patchRuntimeConfig({ patch: { announcement: 'must roll back with audit failure' }, updatedAt: nowIso, actor: { isOperator: true, userKey: null, source: 'wx_devtools' } }));
    assert.deepEqual(committed[C.config], configBeforeFailure, 'audit insert failure must roll back the preceding runtime write through the actual SDK');
    const guardNow = '2026-09-16T02:00:00.000Z';
    const guardLimits = { now: guardNow, maxRequestsPerMinute: 1, maxRequestsPerDay: 10 };
    conflict = true;
    const budgetStarts = sequence;
    const reserved = await repo.consumeCollectorBudget(guardLimits);
    assert.equal(sequence - budgetStarts, 2, 'SDK retries the shared budget transaction after a commit conflict');
    assert.equal(reserved.allowed, true);
    assert.equal(committed[C.config]['collector_budget_2026-09-16'].dayCount, 1, 'a transaction retry must not spend budget twice');
    const secondInstance = createCloudbaseRepo(db);
    assert.equal((await secondInstance.consumeCollectorBudget(guardLimits)).reason, 'minute_budget', 'another repository instance must read the persisted budget');
    conflict = true;
    const tripStarts = sequence;
    await repo.recordUpstreamOutcome({ token: reserved.token, record: { httpStatus: 429, retryAfter: '180' }, success: false, now: guardNow });
    assert.equal(sequence - tripStarts, 2);
    assert.equal(committed[C.config].upstream_breaker.generation, 1);
    assert.equal(committed[C.config].upstream_breaker.trips, 1, 'a failed commit cannot add another breaker generation');
    assert.equal(committed[C.config].upstream_breaker.until, Date.parse(guardNow) + 180000);
    assert.equal((await secondInstance.consumeCollectorBudget(guardLimits)).reason, 'upstream_paused');
    const probeNow = new Date(Date.parse(guardNow) + 180000).toISOString();
    conflictWrite = true;
    const probeStarts = sequence;
    const probeBudget = await secondInstance.consumeCollectorBudget({ ...guardLimits, now: probeNow });
    assert.equal(sequence - probeStarts, 2, 'SDK retries a wrapped write conflict while claiming the probe');
    assert.equal(probeBudget.token.probe, true);
    assert.equal(committed[C.config].upstream_breaker.probeId, probeBudget.token.id);
    assert.equal(committed[C.config]['collector_budget_2026-09-16'].dayCount, 2);
    assert.equal((await repo.consumeCollectorBudget({ ...guardLimits, now: probeNow })).reason, 'upstream_paused', 'a second instance cannot acquire the live probe lease');
    const probeState = copy(committed[C.config]);
    failWrite = true;
    await assert.rejects(repo.recordUpstreamOutcome({ token: probeBudget.token, record: { httpStatus: 200 }, success: true, now: probeNow }));
    assert.deepEqual(committed[C.config], probeState, 'failed breaker close must leave the persisted state unchanged');
    conflict = true;
    const closeStarts = sequence;
    const closed = await secondInstance.recordUpstreamOutcome({ token: probeBudget.token, record: { httpStatus: 200 }, success: true, now: probeNow });
    assert.equal(sequence - closeStarts, 2);
    assert.equal(closed.paused, false);
    assert.equal(committed[C.config].upstream_breaker.until, null);
    assert.equal(committed[C.config].upstream_breaker.probeId, null);
    assert.equal(committed[C.config]['collector_budget_2026-09-16'].dayCount, 2, 'recording an outcome must not consume another request budget');
    committed[C.config] = { catalog: { _id: 'catalog', version: 'sdk-catalog' }, collector_status: { _id: 'collector_status', state: 'running', updatedAt: nowIso } };
    const metadata = await repo.getBootstrapMetadata();
    assert.equal(metadata.catalogMeta.version, 'sdk-catalog');
    assert.equal(metadata.collectorStatus.state, 'running');
  } finally {
    Database.reqClass = previousRequest;
    if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV; else process.env.TENCENTCLOUD_RUNENV = previousRuntime;
  }
});

test('CloudBase bulk reads paginate past 1000 and split ID filters into bounded chunks', async () => {
  const dataset = {
    [C.catalogStores]: Array.from({ length: 245 }, (_, i) => ({ _id: `store-${i}` })),
    [C.follows]: Array.from({ length: 1205 }, (_, i) => ({ _id: `follow-${String(i).padStart(5, '0')}`, status: 'active' })),
    [C.users]: Array.from({ length: 245 }, (_, i) => ({ _id: `user-${i}` })),
  };
  const calls = [];
  function query(name, state = {}) {
    return {
      where: where => query(name, { ...state, where }),
      orderBy: () => query(name, state),
      skip: skip => query(name, { ...state, skip }),
      limit: limit => query(name, { ...state, limit }),
      get: async () => {
        calls.push({ name, ...state });
        let rows = dataset[name];
        if (state.where) rows = rows.filter(row => Object.entries(state.where).every(([key, value]) => value && value.in ? value.in.includes(row[key]) : value === row[key]));
        return { data: rows.slice(state.skip || 0, (state.skip || 0) + Math.min(100, state.limit || 100)) };
      },
    };
  }
  const repo = createCloudbaseRepo({ command: { in: values => { assert.ok(values.length <= 20); return { in: values }; } }, collection: name => query(name) });
  assert.equal((await repo.listStores()).length, 245);
  assert.equal((await repo.listActiveFollows()).length, 1205);
  assert.equal((await repo.getUsers(dataset[C.users].map(u => u._id))).length, 245);
  assert.ok(calls.some(call => call.name === C.follows && call.skip >= 1000));
});
