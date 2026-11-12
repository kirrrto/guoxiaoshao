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

test('switching accounts after invalidation clears both quota revisions and confirmed follow snapshots', async () => {
  let owner = 'alice';
  const values = { alice: quota(9, 20, { signedInToday: true }), bob: quota(0, 1) };
  const rt = runtime(async action => action === 'follow.list' ? { follows: [owner] } : { ...boot(values[owner]), identity: { userKey: owner } });
  const store = rt.load('utils/store.js');
  await store.getBootstrap();
  assert.deepEqual(copy((await store.getFollows()).follows), ['alice']);
  store.publishQueryBalance({ balance: 8, quotaRevision: 21 }, owner);
  store.invalidateBootstrap();
  owner = 'bob';
  assert.deepEqual(copy((await store.getBootstrap()).quota), values.bob);
  assert.deepEqual(copy((await store.getFollows()).follows), ['bob']);
  assert.equal(store.invalidateBootstrap('alice'), false);
  assert.equal(store.publishQuota(quota(10, 22), 'alice'), false);
  assert.equal(store.publishQueryBalance({ balance: 7, quotaRevision: 23 }, 'alice').accepted, false);
  assert.deepEqual(copy(rt.app.globalData.bootstrap.quota), values.bob);
});

test('an old-account quota update during a forced identity read cannot serve its cached account', async () => {
  const dayKey = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const snapshot = (owner, balance) => ({ ...boot(quota(balance, 1, { dayKey })), identity: { userKey: owner } });
  let owner = 'alice', unblock;
  const rt = runtime(async action => {
    if (action === 'follow.list') return { follows: [owner] };
    const response = snapshot(owner, owner === 'alice' ? 5 : 0);
    if (owner === 'bob' && !unblock) await new Promise(resolve => { unblock = resolve; });
    return response;
  });
  const store = rt.load('utils/store.js');
  await store.getBootstrap();
  await store.getFollows();
  owner = 'bob';
  const checking = store.getBootstrap({ force: true });
  store.publishQuota(quota(6, 2, { dayKey }), 'alice');
  unblock();
  assert.equal((await checking).identity.userKey, 'bob');
  assert.equal(store.currentQuota().balance, 0);
  assert.equal(rt.app.globalData.bootstrap.identity.userKey, 'bob');
  assert.deepEqual(copy((await store.getFollows()).follows), ['bob']);
  assert.equal(store.publishQuota(quota(7, 3, { dayKey }), 'alice'), false);
});

test('a retired identity read joins the newer in-flight read before returning an account', async () => {
  const dayKey = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const account = owner => ({ ...boot(quota(1, 1, { dayKey })), identity: { userKey: owner } });
  const pending = [];
  const rt = runtime(() => new Promise(resolve => pending.push(resolve)));
  const store = rt.load('utils/store.js');
  const initial = store.getBootstrap();
  pending[0](account('alice'));
  await initial;
  const older = store.getBootstrap({ force: true });
  store.publishQueryBalance({ balance: 0, quotaRevision: 2 }, 'alice');
  const newer = store.getBootstrap({ force: true });
  pending[1](account('alice'));
  await new Promise(resolve => setImmediate(resolve));
  pending[2](account('bob'));
  assert.deepEqual((await Promise.all([older, newer])).map(value => value.identity.userKey), ['bob', 'bob']);
  assert.equal(pending.length, 3);
});

test('a failed identity refresh after a quota update does not confirm the cached account', async () => {
  const dayKey = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  let calls = 0, fail;
  const rt = runtime(async () => {
    if (++calls === 1) return { ...boot(quota(1, 1, { dayKey })), identity: { userKey: 'alice' } };
    if (calls === 2) return new Promise((resolve, reject) => { fail = reject; });
    throw Error('account offline');
  });
  const store = rt.load('utils/store.js');
  await store.getBootstrap();
  const checking = store.getBootstrap({ force: true });
  store.publishQuota(quota(2, 2, { dayKey }), 'alice');
  fail(Error('account offline'));
  await assert.rejects(checking, /account offline/);
  assert.equal(calls, 3);
});
