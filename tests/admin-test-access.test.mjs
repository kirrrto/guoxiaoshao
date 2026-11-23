import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userContext, userKeyOf, RESOURCE_APPID, PRODUCTS, STORES } from './helpers/fixture.mjs';
import { notificationFixture, ok, REQUEST } from './helpers/notification-test-fixture.mjs';

const require = createRequire(import.meta.url);
const { hasAdminTestAccess, isMember } = require('../cloudfunctions/gxs_api/lib/rules/membership');
const owner = userKeyOf();
const other = 'oOTHER00000000000000000001';

function bindOwner(t) {
  const previous = process.env.GXS_TEST_ADMIN_USER_KEY;
  process.env.GXS_TEST_ADMIN_USER_KEY = owner;
  t.after(() => {
    if (previous === undefined) delete process.env.GXS_TEST_ADMIN_USER_KEY;
    else process.env.GXS_TEST_ADMIN_USER_KEY = previous;
  });
}

test('only the server-bound consumer administrator gets non-expiring test access and no paid order', async t => {
  bindOwner(t);
  const f = createFixture({ config: { adminUserKeys: [owner, userKeyOf(other), userKeyOf(undefined, RESOURCE_APPID)] } });
  const me = ok(await f.call('user.bootstrap'));
  assert.deepEqual([me.membership.active, me.membership.isTester, me.membership.enhanced, me.membership.planId,
    me.membership.expiresAt, me.membership.limits.maxFollows, me.limits.queryMaxStores], [true, true, true, null, null, 5, 5]);
  assert.deepEqual(ok(await f.call('member.status')).membership, me.membership);
  const user = await f.repo.getUser(owner);
  assert.equal(isMember(user, f.state.now), false);
  assert.deepEqual(await f.repo.listOrders(owner), []);
  assert.equal(hasAdminTestAccess({ ...user, openid: other }, await f.repo.getConfig()), false);
  for (const ctx of [userContext(other), userContext(undefined, RESOURCE_APPID)]) {
    const result = ok(await f.call('user.bootstrap', { isTester: true, userKey: owner }, ctx));
    assert.equal(result.identity.isAdmin, true);
    assert.equal(result.membership.active, false);
    assert.equal(result.membership.isTester, undefined);
  }
  f.advance(366 * 86400000);
  assert.equal(ok(await f.call('user.bootstrap')).membership.isTester, true);
  await f.repo.saveConfig({ ...await f.repo.getConfig(), adminUserKeys: [] });
  assert.equal(ok(await f.call('user.bootstrap')).membership.active, false);
  assert.deepEqual((await f.repo.getUser(owner)).membership, user.membership);
});

test('tester can query and watch new products at zero balance; revocation and site switches still apply', async t => {
  bindOwner(t);
  const fetchImpl = fakeFetch(() => ({ display: 'available' }));
  const f = createFixture({ fetchImpl, config: { adminUserKeys: [owner], internationalMarkets: { JP: true },
    newProductWindows: [{ familyKey: PRODUCTS[0].familyKey, releaseAt: '2026-09-15T00:00:00Z' }] } });
  ok(await f.call('user.bootstrap'));
  const china = { partNumber: PRODUCTS[0].partNumber, storeNumbers: ['R577'] };
  const jp = { market: 'JP', expectedUserKey: owner, partNumber: 'MJR54J/A', storeNumbers: ['R128'] };
  const local = ok(await f.call('query.pickup', { ...china, queryId: 'tester-cn-query', maxCost: 0 }));
  assert.deepEqual([local.ok, local.charged, local.balance], [true, 0, 0]);
  f.advance(60000);
  const region = ok(await f.call('market.pickup', { ...jp, queryId: 'tester-jp-query', maxCost: 0 }));
  assert.deepEqual([region.ok, region.charged, region.balance], [true, 0, 0]);
  assert.ok(ok(await f.call('follow.upsert', { ...china, followId: 'test-cn-watch' })).follow);
  assert.equal(ok(await f.call('market.watch', jp)).follow.status, 'active');
  assert.equal(ok(await f.call('market.follows')).canWatch, true);
  const runtime = await f.repo.getConfig();
  await f.repo.saveConfig({ ...runtime, adminUserKeys: [] });
  assert.equal(ok(await f.call('market.follows')).canWatch, false);
  assert.equal((await f.call('market.watch', jp)).error.code, 'market_watch_plan_required');
  await f.repo.saveConfig({ ...runtime, internationalMarkets: { JP: false } });
  assert.equal((await f.call('market.watch', jp)).error.code, 'market_monitoring_disabled');
  assert.deepEqual(await f.repo.listLedger(owner), []);
});

test('test message still requires single-use authorization; free testing never debits or refunds, including revocation', async t => {
  bindOwner(t);
  const f = await notificationFixture({ credits: 0 });
  const runtime = await f.repo.getConfig();
  await f.repo.saveConfig({ ...runtime, adminUserKeys: [owner] });
  assert.equal(ok(await f.call('notificationTest.status')).cost, 0);
  assert.equal((await f.call('notificationTest.send', { requestId: REQUEST, maxCost: 0 })).error.code, 'test_not_found');
  await f.authorize();
  await f.repo.saveConfig({ ...runtime, adminUserKeys: [] });
  assert.equal((await f.call('notificationTest.send', { requestId: REQUEST, maxCost: 0 })).error.code, 'query_cost_changed');
  assert.equal(f.messages.length, 0);
  await f.repo.saveConfig({ ...runtime, adminUserKeys: [owner] });
  const sent = ok(await f.call('notificationTest.send', { requestId: REQUEST, maxCost: 0 }));
  assert.deepEqual([sent.test.status, sent.test.charged, sent.balance], ['accepted', 0, 0]);
  await f.call('notificationTest.send', { requestId: REQUEST, maxCost: 0 });
  assert.equal(f.messages.length, 1);
  const opened = ok(await f.call('notificationTest.status', { requestId: REQUEST, presented: true }));
  assert.ok(opened.test.firstPresentedAt);
  assert.deepEqual(await f.repo.listLedger(owner), []);
});

test('failed free sends never credit the account; legacy sends retain their previously agreed cost', async t => {
  bindOwner(t);
  const f = await notificationFixture({ credits: 0, send: async () => ({ errcode: 43101 }) });
  await f.repo.saveConfig({ ...await f.repo.getConfig(), adminUserKeys: [owner] });
  await f.authorize();
  const failed = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
  assert.deepEqual([failed.test.status, failed.test.charged, failed.test.refunded, failed.balance], ['failed', 0, 0, 0]);
  assert.deepEqual(await f.repo.listLedger(owner), []);
});

test('a revoked tester cannot reuse a stale configuration or renew a free pending query', async t => {
  bindOwner(t);
  const f = createFixture({ config: { adminUserKeys: [owner] } });
  ok(await f.call('user.bootstrap'));
  const config = await f.repo.getConfig();
  const record = { _id: owner + '|stale-query', userKey: owner, queryId: 'stale-query', kind: 'live', partNumber: PRODUCTS[1].partNumber, storeNumbers: ['R577'] };
  const query = { record, product: PRODUCTS[1], config, ownerId: 'worker-old', nowIso: f.state.now.toISOString(), maxCost: 0 };
  const begun = await f.repo.beginQuery(query);
  assert.deepEqual([begun.record.isTester, begun.record.charged], [true, 0]);
  await f.repo.saveConfig({ ...config, adminUserKeys: [] });
  f.advance(60000);
  const resumed = await f.repo.beginQuery({ ...query, nowIso: f.state.now.toISOString(), ownerId: 'worker-new' });
  assert.equal(resumed.record.response.ok, false);
  const anotherRecord = { ...record, _id: owner + '|after-revoke', queryId: 'after-revoke' };
  const fresh = await f.repo.beginQuery({ ...query, record: anotherRecord, nowIso: f.state.now.toISOString() });
  assert.equal(fresh.denied.reason, 'insufficient_credits');
  assert.deepEqual(await f.repo.listLedger(owner), []);
});

test('revocation restores a real member’s three-store allowance before a five-store test query can resume', async t => {
  bindOwner(t);
  const stores = [...STORES, { _id: 'R555', storeNumber: 'R555', name: '第五店', city: '广州' }];
  const storeNumbers = stores.map(store => store.storeNumber);
  const fetchImpl = fakeFetch(() => ({ display: 'available' }));
  const f = createFixture({ stores, fetchImpl, config: { adminUserKeys: [owner] } });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(owner, { membership: { expiresAt: '2027-01-01T00:00:00.000Z', source: 'admin_grant' } });
  const partNumber = PRODUCTS[1].partNumber;
  const completedId = 'five-completed-test';
  const receipt = ok(await f.call('query.pickup', { queryId: completedId, partNumber, storeNumbers, maxCost: 0 }));
  assert.equal(receipt.ok, true);
  f.advance(60000);
  const queryId = 'five-pending-test';
  const runtime = await f.repo.getConfig();
  const begun = await f.repo.beginQuery({ record: { _id: owner + '|' + queryId, userKey: owner, queryId, kind: 'live', partNumber, storeNumbers },
    product: PRODUCTS[1], config: runtime, ownerId: 'old-worker', nowIso: f.state.now.toISOString(), maxCost: 0 });
  assert.equal(begun.record.isTester, true);
  await f.repo.saveConfig({ ...runtime, adminUserKeys: [] });
  f.advance(60000);
  const me = ok(await f.call('user.bootstrap'));
  assert.deepEqual([me.membership.active, me.membership.isTester, me.limits.queryMaxStores], [true, undefined, 3]);
  const calls = fetchImpl.calls.length;
  const resume = { queryId, kind: 'live', mode: 'resume', partNumber, storeNumbers, expectedUserKey: owner };
  const blocked = ok(await f.call('query.resumeLegacy', resume));
  assert.deepEqual([blocked.ok, blocked.reason, blocked.charged, blocked.refunded], [false, 'too_many_stores', 0, 0]);
  const completed = ok(await f.call('query.resumeLegacy', { ...resume, queryId: completedId }));
  assert.equal(completed.replayed, true);
  assert.deepEqual(completed.results, receipt.results);
  assert.equal(fetchImpl.calls.length, calls);
  assert.deepEqual(await f.repo.listLedger(owner), []);
});

test('domestic pickup and history respect a zero-cost confirmation after tester access is revoked', async t => {
  bindOwner(t);
  const fetchImpl = fakeFetch(() => ({ display: 'available' }));
  const f = createFixture({ fetchImpl, config: { adminUserKeys: [owner] } });
  const me = ok(await f.call('user.bootstrap'));
  assert.equal(me.membership.isTester, true);
  ok(await f.call('quota.signin'));
  await f.repo.saveConfig({ ...await f.repo.getConfig(), adminUserKeys: [] });
  const target = { partNumber: PRODUCTS[1].partNumber, storeNumbers: ['R577'], expectedUserKey: owner };
  const ledgerBefore = await f.repo.listLedger(owner);
  for (const [action, request] of [
    ['query.pickup', { queryId: 'cn-confirmed-free' }],
    ['history.list', { historyQueryId: 'history-confirmed-free' }],
  ]) {
    const payload = { ...target, ...request };
    assert.equal((await f.call(action, { ...payload, maxCost: 0 })).error.code, 'query_cost_changed');
    assert.equal((await f.call(action, { ...payload, maxCost: '0' })).error.code, 'invalid_payload');
  }
  assert.deepEqual(await f.repo.listLedger(owner), ledgerBefore);
  assert.equal((await f.repo.getUser(owner)).quota.balance, 1);
  assert.equal(fetchImpl.calls.length, 0);
  const legacy = ok(await f.call('query.pickup', { ...target, queryId: 'legacy-omitted-price' }));
  assert.deepEqual([legacy.ok, legacy.charged, legacy.balance], [true, 1, 0]);
});
