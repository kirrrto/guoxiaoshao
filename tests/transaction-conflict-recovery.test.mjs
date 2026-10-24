import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');

test('pinned CloudBase SDK rolls back each conflict before bounded, jittered transaction replay', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); } catch { t.skip('Run npm ci in cloudfunctions/gxs_api for the pinned SDK contract'); return; }
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV;
  process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk');
  cloud.init({ env: 'offline-conflict-contract' });
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson');
  const copy = value => EJSON.parse(EJSON.stringify(value));
  const input = { id: 'collector_lease', ownerId: 'worker', now: '2026-10-24T00:00:00.000Z', expiresAt: '2026-10-24T00:00:15.000Z' };
  let committed, transactions, calls, waits, sequence, failAction, failuresLeft, failureCode, failureMessage, commitBeforeFailure;
  function reset(action, count, { code = 'ResourceUnavailable.TransactionConflict', message = '[ResourceUnavailable.TransactionConflict] Transaction is conflict, maybe resource operated by others', uncertainCommit = false } = {}) {
    committed = { _id: input.id, ownerId: input.ownerId, expiresAt: input.now };
    transactions = new Map(); calls = []; waits = []; sequence = 0;
    failAction = action; failuresLeft = count; failureCode = code; failureMessage = message; commitBeforeFailure = uncertainCommit;
  }
  Database.reqClass = class OfflineTransport {
    async send(action, args = {}) {
      calls.push({ action, id: args.transactionId });
      if (action === 'database.startTransaction') {
        const id = `tx-${++sequence}`;
        transactions.set(id, copy(committed));
        return { transactionId: id };
      }
      if (action === failAction && failuresLeft-- > 0) {
        if (commitBeforeFailure) committed = copy(transactions.get(args.transactionId));
        return { code: failureCode, message: failureMessage };
      }
      if (action === 'database.abortTransaction') { transactions.delete(args.transactionId); return {}; }
      if (action === 'database.commitTransaction') { committed = copy(transactions.get(args.transactionId)); transactions.delete(args.transactionId); return {}; }
      if (action === 'database.getDocument') return { data: { list: [EJSON.stringify(transactions.get(args.transactionId))] } };
      if (action === 'database.modifyDocument') {
        transactions.set(args.transactionId, { _id: EJSON.parse(args.query)._id, ...EJSON.parse(args.data) });
        return { data: { updated: 1 } };
      }
      throw new Error(`Unexpected SDK operation: ${action}`);
    }
  };
  const repo = createCloudbaseRepo(db, {
    random: () => 0.999999,
    sleep: async ms => { waits.push(ms); assert.equal(transactions.size, 0, 'failed transaction is rolled back before retry waiting'); },
  });
  try {
    for (const action of ['database.getDocument', 'database.modifyDocument', 'database.commitTransaction']) {
      await t.test(`${action} explicit conflict recovers once and releases its transaction`, async () => {
        reset(action, 1);
        assert.equal((await repo.acquireLease(input)).acquired, true);
        assert.equal(sequence, 2);
        assert.equal(transactions.size, 0);
        assert.deepEqual(waits, [49]);
        assert.equal(committed.expiresAt, input.expiresAt);
        const abort = calls.findIndex(call => call.action === 'database.abortTransaction');
        const retry = calls.findIndex((call, index) => index > 0 && call.action === 'database.startTransaction');
        assert.ok(abort > 0 && abort < retry, 'rollback precedes the fresh transaction');
      });
    }
    await t.test('persistent wrapped conflicts stop after four attempts and under 350ms added waiting', async () => {
      reset('database.modifyDocument', Infinity);
      await assert.rejects(repo.acquireLease(input), /TransactionConflict/);
      assert.equal(sequence, 4, 'SDK retries must be disabled; nested loops would multiply attempts');
      assert.deepEqual(waits, [49, 99, 199]);
      assert.ok(waits.reduce((sum, value) => sum + value, 0) < 350);
      assert.equal(transactions.size, 0);
      assert.equal(committed.expiresAt, input.now, 'failed transaction writes never commit');
    });
    await t.test('canonical commit conflict also recovers through the same bounded loop', async () => {
      reset('database.commitTransaction', 1, { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'database transaction conflict' });
      assert.equal((await repo.acquireLease(input)).acquired, true);
      assert.equal(sequence, 2);
      assert.equal(transactions.size, 0);
    });
    for (const uncertainCommit of [false, true]) {
      await t.test(`generic ${uncertainCommit ? 'committed-but-uncertain' : 'write'} failure is never replayed`, async () => {
        reset(uncertainCommit ? 'database.commitTransaction' : 'database.modifyDocument', 1,
          { code: 'ResourceUnavailable', message: 'resource system error: connection reset', uncertainCommit });
        await assert.rejects(repo.acquireLease(input));
        assert.equal(sequence, 1);
        assert.deepEqual(waits, []);
        assert.equal(committed.expiresAt, uncertainCommit ? input.expiresAt : input.now);
      });
    }
  } finally {
    Database.reqClass = previousRequest;
    if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV;
    else process.env.TENCENTCLOUD_RUNENV = previousRuntime;
  }
});

test('healthy successful observations leave a clean shared breaker untouched but reset real failures', async () => {
  const f = createFixture();
  const now = f.state.now.toISOString();
  const token = { generation: 0, id: 'normal', probe: false };
  const outcome = success => f.repo.recordUpstreamOutcome({ token, record: { httpStatus: success ? 200 : null }, success, now });
  const writes = [];
  f.repo.transactionWriteHook = async (collection, doc) => { if (collection === C.config && doc._id === 'upstream_breaker') writes.push(doc); };
  await outcome(true);
  assert.equal(writes.length, 0, 'first healthy response need not create a shared hotspot document');
  await outcome(false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].failures.length, 1);
  await outcome(true);
  assert.equal(writes.length, 2, 'success must still clear a preceding failure');
  assert.deepEqual(writes[1].failures, []);
  const settled = copyPlain(writes[1]);
  await outcome(true);
  assert.equal(writes.length, 2);
  assert.deepEqual(f.repo.tables.get(C.config).get('upstream_breaker'), settled);
});

function copyPlain(value) { return JSON.parse(JSON.stringify(value)); }
