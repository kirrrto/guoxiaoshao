import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, fakeFetch, PRODUCTS, STORES, userContext, userKeyOf } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const alice = 'oDISPATCHALICE0000000000001';
const bob = 'oDISPATCHBOB000000000000002';
const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
const unwrap = value => { assert.ok(value.ok, JSON.stringify(value.error)); return value.data; };

for (const kind of ['query', 'history']) {
  const action = kind === 'query' ? 'query.pickup' : 'history.list';
  const storageKind = kind === 'query' ? 'q' : 'h';
  const idField = kind === 'query' ? 'queryId' : 'historyQueryId';

  for (const switchAt of ['page entry', 'cloud initialization', 'server dispatch']) {
    test(`${kind} binds a paid query to its owner when identity changes at ${switchAt}`, async () => {
      const fetchImpl = fakeFetch({ R577: { display: 'available' } });
      const f = createFixture({ start: new Date().toISOString(), fetchImpl, config: { tasks: [] } });
      for (const id of [alice, bob]) unwrap(await f.call('quota.signin', {}, userContext(id)));
      const rt = runtime(undefined, { realApi: true });
      const store = rt.load('utils/store.js'), ops = rt.load('utils/operation.js');
      let serverAccount = alice, releaseConnection, holdConnection = false;
      const dispatched = [];
      const cloud = { callFunction: async ({ data }) => {
        if (data.action === action) dispatched.push(data.payload);
        return { result: await f.call(data.action, data.payload, userContext(serverAccount)) };
      } };
      rt.app.ensureCloud = () => holdConnection
        ? new Promise(resolve => { releaseConnection = () => resolve(cloud); })
        : Promise.resolve(cloud);
      const page = rt.instance(`pages/${kind}/index.js`);
      const product = PRODUCTS.find(p => p.partNumber === target.partNumber);
      page.catalog = { productByPart: { [target.partNumber]: product }, storeByNumber: { R577: STORES[0] } };
      page.selection = { ...target, product };
      page.applyBoot(await store.getBootstrap());
      const payload = kind === 'query' ? target : { ...target, dayKey: rt.load('utils/format.js').todayKey() };
      let originalId;
      if (switchAt !== 'page entry') {
        // The previous invocation reached the service, but this user's client never saw the answer.
        originalId = ops.begin(storageKind, payload, userKeyOf(alice));
        if (kind === 'history') await f.repo.saveEvents([{ _id: 'stock-change', ...target, storeNumber: 'R577',
          type: 'restock_confirmed', detectedAt: f.state.now.toISOString(), dayKey: payload.dayKey }]);
        const committed = unwrap(await f.call(action, { ...payload, [idField]: originalId }, userContext(alice)));
        assert.equal(committed.charged, 1);
        f.advance(11000);
      }
      if (switchAt === 'page entry') {
        serverAccount = bob;
        await store.getBootstrap({ force: true });
        // A second tab can invalidate the complete cache after verifying Bob.
        store.invalidateBootstrap(userKeyOf(bob));
      }
      if (switchAt === 'cloud initialization') holdConnection = true;
      if (switchAt === 'server dispatch') serverAccount = bob;
      const pending = page.onQuery();
      if (switchAt === 'cloud initialization') {
        assert.ok(releaseConnection);
        holdConnection = false;
        serverAccount = bob;
        await store.getBootstrap({ force: true });
        store.invalidateBootstrap(userKeyOf(bob));
        releaseConnection();
      }
      await pending;
      assert.equal(dispatched.length, switchAt === 'server dispatch' ? 1 : 0);
      if (dispatched.length) assert.equal(dispatched[0].expectedUserKey, userKeyOf(alice));
      assert.equal((await f.repo.getUser(userKeyOf(bob))).quota.balance, 1);
      assert.equal((await f.repo.listLedger(userKeyOf(bob))).filter(row => row.type.endsWith('_debit')).length, 0);
      assert.equal((await f.repo.listQueries(userKeyOf(bob), 10)).length, 0);
      if (originalId) {
        assert.equal(ops.hasPending(storageKind, payload, userKeyOf(alice)), true);
        serverAccount = alice;
        page.applyBoot(await store.getBootstrap({ force: true }));
        await page.onQuery();
        assert.equal(dispatched.at(-1)[idField], originalId);
        assert.equal(dispatched.at(-1).expectedUserKey, userKeyOf(alice));
        assert.equal((await f.repo.listLedger(userKeyOf(alice))).filter(row => row.type.endsWith('_debit')).length, 1);
      } else {
        assert.equal(ops.hasPending(storageKind, payload, userKeyOf(alice)), false);
      }
    });
  }
}
