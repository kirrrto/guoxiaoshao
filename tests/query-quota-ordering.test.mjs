import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const quota = (balance, revision, extra = {}) => ({ balance, revision, signedInToday: false,
  tasksDoneToday: [], grantedToday: 0, queryCost: 1, historyCost: 1, dayKey: '2026-10-05', ...extra });
const boot = value => ({ quota: value, membership: { active: false } });

for (const arrival of ['query-first', 'signin-first']) {
  test(`${arrival}: full reward metadata and query balance merge without a rollback`, async () => {
    const serverQuota = quota(1, 3, { signedInToday: true, grantedToday: 1 });
    const rt = runtime(async () => boot(serverQuota)), store = rt.load('utils/store.js'), updates = [];
    store.subscribeQuota(value => updates.push(copy(value)));
    store.publishQuota(quota(1, 1));
    const signinQuota = quota(2, 2, { signedInToday: true, grantedToday: 1 });
    const query = () => store.publishQueryBalance({ balance: 1, quotaRevision: 3 });
    const signin = () => assert.equal(store.publishQuota(signinQuota), true);
    if (arrival === 'query-first') { query(); signin(); } else { signin(); query(); }

    const merged = store.currentQuota();
    assert.equal(merged.balance, 1);
    assert.equal(merged.signedInToday, true);
    assert.equal(merged.grantedToday, 1);
    assert.equal(merged.revision, 2, 'the query must not pretend it supplied newer full metadata');
    assert.equal(signinQuota.balance, 2, 'publishing never mutates the API response');
    assert.equal(updates.at(-1).balance, 1);
    assert.equal(updates.at(-1).signedInToday, true);

    const refreshed = await store.getBootstrap({ force: true });
    assert.equal(refreshed.quota.revision, 3, 'full metadata at the known balance revision remains acceptable');
    assert.equal(refreshed.quota.balance, 1);
    assert.equal(refreshed.quota.signedInToday, true);
    assert.deepEqual(copy(rt.app.globalData.bootstrap.quota), copy(refreshed.quota));
    assert.equal(rt.calls.length, 1);
  });
}

test('an older query cannot replace a newer reward or query balance', () => {
  const rt = runtime(), store = rt.load('utils/store.js');
  store.publishQuota(quota(3, 4, { signedInToday: true }));
  assert.deepEqual(copy(store.publishQueryBalance({ balance: 1, quotaRevision: 2 })), { balance: 3, accepted: false, needsRefresh: false });
  store.publishQueryBalance({ balance: 2, quotaRevision: 5 });
  assert.deepEqual(copy(store.publishQueryBalance({ balance: 3, quotaRevision: 4 })), { balance: 2, accepted: false, needsRefresh: false });
  assert.equal(store.currentQuota().balance, 2);
  assert.equal(store.currentQuota().revision, 4);
  assert.equal(store.currentQuota().signedInToday, true);
});

test('bootstrap metadata received after a newer query uses its own metadata and the newest balance', async () => {
  const rt = runtime(async () => boot(quota(2, 2, { signedInToday: true }))), store = rt.load('utils/store.js');
  store.publishQuota(quota(1, 1));
  store.publishQueryBalance({ balance: 1, quotaRevision: 3 });
  const refreshed = await store.getBootstrap({ force: true });
  assert.equal(refreshed.quota.balance, 1);
  assert.equal(refreshed.quota.revision, 2);
  assert.equal(refreshed.quota.signedInToday, true);
  assert.equal(rt.app.globalData.bootstrap.quota.balance, 1);
});

test('query publication updates cached bootstrap and open-page subscribers without another API call', async () => {
  const rt = runtime(async () => boot(quota(2, 2))), store = rt.load('utils/store.js'), updates = [];
  await store.getBootstrap();
  store.subscribeQuota(value => updates.push(copy(value)));
  assert.equal(store.publishQueryBalance({ balance: 1, quotaRevision: 3 }).accepted, true);
  assert.equal(rt.app.globalData.bootstrap.quota.balance, 1);
  assert.equal(rt.app.globalData.bootstrap.quota.revision, 2);
  assert.equal(updates.at(-1).balance, 1);
  assert.equal(rt.calls.length, 1);
});

test('legacy query balances preserve observed quota and request one refresh without hiding query data', async () => {
  let reads = 0;
  const rt = runtime(async () => boot(++reads === 1 ? quota(2, 2) : quota(1, 3))), store = rt.load('utils/store.js');
  await store.getBootstrap();
  const response = { ok: true, balance: 0, results: [{ status: 'available' }] };
  assert.deepEqual(copy(store.publishQueryBalance(response)), { balance: 2, accepted: false, needsRefresh: true });
  assert.equal(response.results[0].status, 'available');
  assert.equal(rt.calls.length, 1, 'the publisher itself does not initiate network requests');
  assert.equal(rt.app.globalData.bootstrap, null);
  assert.equal((await store.getBootstrap()).quota.balance, 1);
  assert.equal(rt.calls.length, 2);
});

test('missing or malformed query snapshots do not fabricate a balance', () => {
  const rt = runtime(), store = rt.load('utils/store.js');
  for (const response of [null, { balance: 5 }, { balance: -1, quotaRevision: 1 }, { balance: 1, quotaRevision: -1 }]) {
    assert.deepEqual(copy(store.publishQueryBalance(response)), { balance: null, accepted: false, needsRefresh: true });
  }
  store.publishQueryBalance({ balance: 0, quotaRevision: 5 });
  assert.equal(store.currentQuota(), null, 'a balance alone does not fabricate signin/task metadata');
  store.publishQuota(quota(1, 4, { signedInToday: true }));
  assert.equal(store.currentQuota().balance, 0);
  assert.equal(store.currentQuota().signedInToday, true);
});

test('session reset releases both balance and metadata revision history', () => {
  const rt = runtime(), store = rt.load('utils/store.js');
  store.publishQuota(quota(8, 10));
  store.publishQueryBalance({ balance: 7, quotaRevision: 11 });
  store.resetSession();
  assert.equal(store.currentQuota(), null);
  assert.equal(store.publishQuota(quota(0, 0)), true);
  assert.equal(store.currentQuota().balance, 0);
  assert.equal(store.publishQueryBalance({ balance: 1, quotaRevision: 1 }).balance, 1);
});
