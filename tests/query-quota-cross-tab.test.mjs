import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, fakeFetch, operatorContext, userKeyOf } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };

for (const kind of ['query', 'history']) {
  for (const firstCommit of ['query', 'signin']) {
    test(`${kind}: reversed ${firstCommit}-first responses retain balance and signin metadata across open tabs`, async t => {
      const now = Date.parse('2026-10-05T02:00:00Z');
      t.mock.method(Date, 'now', () => now);
      const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
      const f = createFixture({ start: new Date(now).toISOString(), config: { tasks: [] },
        fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
      ok(await f.call('user.bootstrap'));
      ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'cross-tab-initial-credit', amount: 2 }, operatorContext()));
      await f.repo.recordObservation({ observation: { ...target, storeNumber: 'R577', status: 'available',
        observedAt: new Date(now - 1000).toISOString(), source: 'auto' } });

      const queryAction = kind === 'query' ? 'query.pickup' : 'history.list';
      const held = { query: deferred(), signin: deferred() }, entered = { query: deferred(), signin: deferred() }, responses = {};
      const rt = runtime(async (action, payload) => {
        const result = ok(await f.call(action, payload));
        const key = action === queryAction ? 'query' : action === 'quota.signin' ? 'signin' : null;
        if (!key) return result;
        responses[key] = result; entered[key].resolve();
        return held[key].promise;
      });
      rt.storage.set('gxs_query_selection_v1', target);
      rt.storage.set('gxs_history_selection_v1', target);
      const store = rt.load('utils/store.js');
      await store.getCatalog({ force: true });
      const live = rt.instance('pages/query/index.js'); await live.onLoad();
      const history = rt.instance('pages/history/index.js'); await history.onLoad();
      const mine = rt.instance('pages/mine/index.js'); await mine.onLoad();
      await settle();
      const page = kind === 'query' ? live : history;
      const assertBalance = expected => {
        assert.equal(live.data.boot.balance, expected, 'live-query tab');
        assert.equal(history.data.boot.balance, expected, 'history tab');
        assert.equal(mine.data.quota.balance, expected, 'account tab');
      };
      assertBalance(2);
      const initialBootReads = rt.calls.filter(call => call.action === 'user.bootstrap').length;
      const actions = {};
      if (firstCommit === 'query') {
        actions.query = page.onQuery(); await entered.query.promise;
        actions.signin = mine.onSignin(); await entered.signin.promise;
      } else {
        actions.signin = mine.onSignin(); await entered.signin.promise;
        actions.query = page.onQuery(); await entered.query.promise;
      }
      const newer = firstCommit === 'query' ? 'signin' : 'query';
      held[newer].resolve(responses[newer]); await actions[newer];
      assertBalance(2);
      held[firstCommit].resolve(responses[firstCommit]); await actions[firstCommit];
      assertBalance(2);
      assert.equal(mine.data.quota.signedInToday, true);
      assert.equal(live.data.boot.signedInToday, true);
      assert.equal(store.currentQuota().signedInToday, true);
      assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 2);
      assert.equal(rt.calls.filter(call => call.action === queryAction).length, 1);
      assert.equal(rt.calls.filter(call => call.action === 'quota.signin').length, 1);
      assert.equal(rt.calls.filter(call => call.action === 'user.bootstrap').length, initialBootReads,
        'versioned responses settle all tabs without compatibility refetches');
      assert.ok(page.data.result, 'the confirmed query result remains displayed');
      live.onUnload(); history.onUnload(); mine.onUnload();
    });
  }
}

for (const kind of ['query', 'history']) {
  for (const refreshOutcome of ['success', 'failure']) {
    test(`${kind}: legacy query results survive one delayed compatibility refresh (${refreshOutcome})`, async t => {
      const now = Date.parse('2026-10-05T02:00:00Z');
      t.mock.method(Date, 'now', () => now);
      const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
      const f = createFixture({ start: new Date(now).toISOString(), config: { tasks: [] },
        fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
      ok(await f.call('user.bootstrap'));
      ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'legacy-query-initial-credit', amount: 2 }, operatorContext()));
      await f.repo.recordObservation({ observation: { partNumber: target.partNumber, storeNumber: 'R577', status: 'available',
        observedAt: new Date(now - 1000).toISOString(), source: 'auto' } });
      const queryAction = kind === 'query' ? 'query.pickup' : 'history.list';
      const refresh = deferred();
      let queried = false, refreshReads = 0, refreshedAccount;
      const rt = runtime(async (action, payload) => {
        const result = ok(await f.call(action, payload));
        if (action === queryAction) {
          queried = true;
          const { quotaRevision, ...legacy } = result;
          return legacy;
        }
        if (action === 'user.bootstrap' && queried) {
          refreshReads++; refreshedAccount = result;
          return refresh.promise;
        }
        return result;
      });
      rt.storage.set(`gxs_${kind}_selection_v1`, target);
      const store = rt.load('utils/store.js');
      await store.getCatalog({ force: true });
      const page = rt.instance(`pages/${kind}/index.js`); await page.onLoad(); await settle();
      assert.equal(page.data.boot.balance, 2);
      await page.onQuery(); await settle();
      assert.ok(page.data.result, 'confirmed results are available while the account refresh is pending');
      assert.equal(page.data.result.product.partNumber, target.partNumber);
      assert.equal(page.data.boot.balance, 2, 'keep the last observed account balance until refresh confirms ordering');
      assert.equal(refreshReads, 1);
      if (refreshOutcome === 'success') refresh.resolve(refreshedAccount);
      else refresh.reject(Object.assign(Error('account refresh offline'), { code: 'call_failed' }));
      await settle();
      assert.equal(page.data.boot.balance, refreshOutcome === 'success' ? 1 : 2);
      assert.ok(page.data.result, 'refresh failure cannot discard confirmed query results');
      assert.equal(page.data.result.product.partNumber, target.partNumber);
      assert.equal(refreshReads, 1, 'the compatibility path does not loop');
      assert.equal(rt.calls.filter(call => call.action === queryAction).length, 1, 'account refresh never repeats the charged query');
      assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
      page.onUnload();
    });
  }
}
