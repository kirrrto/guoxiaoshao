import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');

test('pinned SDK launch gift scan uses fixed ID watermark and bounded keyset pages without dropping refunded/malformed rows', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); }
  catch { t.skip('Run npm ci in cloudfunctions/gxs_api for the pinned SDK contract'); return; }
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV;
  process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk'); cloud.init({ env: 'offline-launch-gift-contract' });
  assert.equal(sdkRequire('wx-server-sdk/package.json').version, '4.0.2');
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson');
  const calls = [];
  Database.reqClass = class OfflineTransport {
    async send(action, args) {
      assert.equal(action, 'database.getDocument');
      assert.equal(args.collectionName, C.orders);
      assert.equal(args.offset || 0, 0);
      assert.ok(args.limit > 0 && args.limit <= 100);
      const query = args.query ? EJSON.parse(args.query) : {};
      calls.push({ query, limit: args.limit, order: args.order });
      if (calls.length === 1) return { data: { list: [EJSON.stringify({ _id: 'z', status: 'refunded' })] } };
      return { data: { list: [] } };
    }
  };
  try {
    const repo = createCloudbaseRepo(db);
    assert.equal(await repo.getLaunchGiftOrderWatermark(), 'z');
    await repo.scanLaunchGiftOrders({ throughId: 'z', limit: 100 });
    await repo.scanLaunchGiftOrders({ afterId: 'a', throughId: 'z', limit: 101 });
    assert.deepEqual(calls.map(call => call.limit), [1, 100, 100]);
    assert.deepEqual(calls[0].query, {});
    assert.deepEqual(calls[1].query, { _id: { $lte: 'z' } });
    assert.deepEqual(calls[2].query, { $and: [{ _id: { $gt: 'a' } }, { _id: { $lte: 'z' } }] });
    assert.ok(calls.every(call => !Object.hasOwn(call.query, 'status') && !Object.hasOwn(call.query, 'createdAt')));
    await repo.scanLaunchGiftOrders({ throughId: null, limit: 100 });
    assert.equal(calls.length, 3);
  } finally {
    Database.reqClass = previousRequest;
    if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV;
    else process.env.TENCENTCLOUD_RUNENV = previousRuntime;
  }
});
