import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const ids = count => Array.from({ length: count }, (_, i) => `target-${String(i).padStart(4, '0')}`);

function fixture(existingIds) {
  const documents = existingIds.map(_id => ({ _id, value: `value-${_id}` }));
  const calls = [];
  function query(collection, state = {}) {
    return {
      where: filter => query(collection, { ...state, filter }),
      orderBy: (field, direction) => query(collection, { ...state, field, direction }),
      skip: offset => query(collection, { ...state, offset }),
      limit: limit => query(collection, { ...state, limit }),
      async get() {
        assert.equal(state.field, '_id'); assert.equal(state.direction, 'asc');
        assert.ok(state.limit > 0 && state.limit <= 100);
        calls.push({ collection, ...state });
        const matches = documents.filter(doc => state.filter._id.$in.includes(doc._id))
          .sort((a, b) => a._id.localeCompare(b._id));
        return { data: matches.slice(state.offset || 0, (state.offset || 0) + state.limit) };
      },
    };
  }
  const repo = createCloudbaseRepo({ command: { in(values) {
    assert.ok(values.length > 0 && values.length <= 100);
    return { $in: [...values] };
  } }, collection: query, runTransaction() { assert.fail('ID reads must not open transactions'); } });
  return { repo, calls };
}

for (const [method, collection] of [['getUsers', C.users], ['getLatest', C.latest], ['getProducts', C.catalogProducts]]) {
  test(`${method} reads 21/100/101/245 IDs without an empty boundary page`, async t => {
    for (const count of [21, 100, 101, 245]) await t.test(String(count), async () => {
      const requested = ids(count), f = fixture(requested);
      const result = await f.repo[method](requested);
      assert.deepEqual(result.map(doc => doc._id), requested);
      assert.equal(f.calls.length, Math.ceil(count / 100));
      assert.deepEqual(f.calls.map(call => call.limit), count === 245 ? [100, 100, 45]
        : count === 101 ? [100, 1] : [count]);
      assert.ok(f.calls.every(call => call.collection === collection && call.offset === 0));
    });
  });

  test(`${method} preserves missing-ID semantics and de-duplicates across batch boundaries`, async () => {
    const requested = ids(245), existing = requested.filter((_, i) => i % 7 !== 0), f = fixture(existing);
    const result = await f.repo[method]([...requested, ...requested.slice(0, 120), requested.at(-1)]);
    assert.deepEqual(result.map(doc => doc._id), existing);
    assert.equal(new Set(result.map(doc => doc._id)).size, existing.length);
    assert.equal(f.calls.length, 3, 'missing rows finish their ID batch without discarding subsequent batches');
    assert.deepEqual(f.calls.flatMap(call => call.filter._id.$in), requested);
    assert.ok(f.calls.every(call => call.collection === collection));
  });

  test(`${method} returns an empty list without touching the database for empty IDs`, async () => {
    const f = fixture(ids(10));
    assert.deepEqual(await f.repo[method]([]), []);
    assert.deepEqual(f.calls, []);
  });
}

test('installed wx-server-sdk encodes 100-ID reads with their exact limits and no transaction', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); }
  catch { t.skip('Run npm ci in cloudfunctions/gxs_api for the pinned SDK contract'); return; }
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV;
  process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk'); cloud.init({ env: 'offline-read-id-batching' });
  assert.equal(sdkRequire('wx-server-sdk/package.json').version, '4.0.2');
  assert.equal(sdkRequire('@cloudbase/database/package.json').version, '1.5.1');
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson');
  const requests = [];
  Database.reqClass = class OfflineTransport {
    async send(action, args) {
      assert.equal(action, 'database.getDocument', 'the SDK must stay in this offline read-only transport');
      assert.ok(!args.transactionId);
      const filter = EJSON.parse(args.query);
      assert.deepEqual(Object.keys(filter), ['_id']);
      const requested = filter._id.$in;
      assert.ok(requested.length > 0 && requested.length <= 100);
      assert.equal(args.limit, requested.length);
      assert.equal(args.offset || 0, 0);
      requests.push({ collection: args.collectionName, ids: [...requested], limit: args.limit });
      return { data: { list: [...requested].sort().map(_id => EJSON.stringify({ _id, read: true })) } };
    }
  };
  try {
    const repo = createCloudbaseRepo(db), summary = [];
    for (const [method, collection] of [['getUsers', C.users], ['getLatest', C.latest], ['getProducts', C.catalogProducts]]) {
      for (const count of [0, 21, 100, 101, 245]) {
        requests.length = 0;
        const requested = ids(count), result = await repo[method](requested);
        assert.deepEqual(result.map(doc => doc._id), requested);
        assert.equal(requests.length, Math.ceil(count / 100));
        assert.ok(requests.every(request => request.collection === collection));
        assert.deepEqual(requests.flatMap(request => request.ids), requested);
        summary.push({ method, ids: count, sdkRequests: requests.length, limits: requests.map(request => request.limit) });
      }
    }
    t.diagnostic(`READ_IDS_SDK_RESULT ${JSON.stringify(summary)}`);
  } finally {
    Database.reqClass = previousRequest;
    if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV;
    else process.env.TENCENTCLOUD_RUNENV = previousRuntime;
  }
});
