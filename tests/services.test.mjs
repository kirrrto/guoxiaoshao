import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFixture, fakeFetch, appleBody, userContext, operatorContext, userKeyOf } from './helpers/fixture.mjs';

const ok = result => {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
};
const failWith = (result, code) => {
  assert.equal(result.ok, false, 'expected failure');
  assert.equal(result.error.code, code);
  return result.error;
};

test('ping works without a user; user actions require a mini-program identity', async () => {
  const f = createFixture();
  const ping = ok(await f.call('system.ping', {}, operatorContext()));
  assert.equal(ping.hasUser, false);
  assert.equal(ping.isAdmin, true);
  assert.equal(ping.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  failWith(await f.call('user.bootstrap', {}, operatorContext()), 'user_required');
  failWith(await f.call('nope.nothing', {}), 'unknown_action');
  failWith(await f.call('system.ping', {}, userContext('oX', 'wxSOMEONEELSE')), 'app_not_allowed');
});

test('bootstrap lazily creates the user keyed by appid:openid and reports quota/membership', async () => {
  const f = createFixture();
  const data = ok(await f.call('user.bootstrap'));
  assert.equal(data.identity.appid, 'wxe96ad9e77b602f1b');
  assert.equal(data.identity.crossAccount, true);
  assert.equal(data.identity.openidMasked, 'oUSE…0001');
  assert.equal(data.membership.active, false);
  assert.equal(data.quota.balance, 0);
  assert.equal(data.followCount, 0);
  assert.equal(data.catalogVersion, 'test|v1');
  assert.ok(await f.repo.getUser(userKeyOf()));
});

test('account creation ignores unused UnionID identifiers supplied by WeChat', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap', {}, { ...userContext(), UNIONID: 'resource-union-id', FROM_UNIONID: 'consumer-union-id' }));
  const user = await f.repo.getUser(userKeyOf());
  assert.equal(Object.hasOwn(user, 'unionid'), false);
  assert.equal(user.openid, userContext().FROM_OPENID);
});

test('sign-in grants once per Beijing day and respects caps', async () => {
  const f = createFixture({ config: { quota: { historyCost: 0 } } });
  const first = ok(await f.call('quota.signin'));
  assert.equal(first.granted, 1);
  assert.equal(first.quota.balance, 1);
  const second = ok(await f.call('quota.signin'));
  assert.equal(second.granted, 0);
  assert.equal(second.reason, 'already_signed_in');
  assert.equal(ok(await f.call('history.list', { historyQueryId: 'reward-history-01', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] })).ok, true);
  const task = ok(await f.call('quota.completeTask', { taskId: 'view_history' }));
  assert.equal(task.granted, 1);
  assert.equal(task.quota.balance, 2);
  assert.equal(task.quota.grantedToday, 2);
  failWith(await f.call('quota.completeTask', { taskId: 'made_up' }), 'unknown_task');
  f.advance(24 * 60 * 60 * 1000);
  const nextDay = ok(await f.call('quota.signin'));
  assert.equal(nextDay.granted, 1);
  assert.equal(nextDay.quota.balance, 3);
});

test('live query: free user pays once per queryId, replays are free, empty balance is refused', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available', storeName: '天环广场' }, R639: { display: 'unavailable', storeName: '珠江新城' } });
  const f = createFixture({ fetchImpl });
  ok(await f.call('quota.signin'));
  const payload = { queryId: 'q-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'] };
  const first = ok(await f.call('query.pickup', payload));
  assert.equal(first.ok, true);
  assert.equal(first.charged, 1);
  assert.equal(first.balance, 0);
  assert.equal(first.member, false);
  assert.deepEqual(first.results.map(r => [r.storeNumber, r.status, r.storeName]), [['R577', 'available', '天环广场'], ['R639', 'unavailable', '珠江新城']]);
  assert.deepEqual(first.results[0].events.map(e => e.type), ['first_seen_available']);
  assert.equal(fetchImpl.calls.length, 2);

  const replay = ok(await f.call('query.pickup', payload));
  assert.equal(replay.replayed, true);
  assert.equal(replay.charged, 1);
  assert.equal(fetchImpl.calls.length, 2, 'replay must not hit upstream again');

  const refused = ok(await f.call('query.pickup', { ...payload, queryId: 'q-0002-bbbb' }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'insufficient_credits');
  assert.equal(fetchImpl.calls.length, 2);
  const ledger = ok(await f.call('quota.ledger'));
  assert.deepEqual(ledger.entries.map(e => e.type).sort(), ['query_debit', 'signin_reward']);
  assert.equal(ledger.balance, 0);
});

test('live query: upstream failure on every store refunds the credit and never records unavailable', async () => {
  const fetchImpl = fakeFetch({ R577: { error: 'fetch failed' }, R639: { status: 503, body: 'upstream down' } });
  const f = createFixture({ fetchImpl });
  ok(await f.call('quota.signin'));
  const result = ok(await f.call('query.pickup', { queryId: 'q-fail-0001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'] }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream_unavailable');
  assert.equal(result.charged, 1);
  assert.equal(result.refunded, 1);
  assert.equal(result.balance, 1);
  assert.deepEqual(result.results.map(r => r.status), ['unknown', 'unknown']);
  assert.equal(result.results[0].reason.code, 'transport_error');
  assert.equal(result.results[1].reason.code, 'http_error');
  const latest = await f.repo.getLatest(['R577|MJYH4CH/A']);
  assert.equal(latest[0].status, null);
  assert.equal(latest[0].unknownCount, 1);
  const bootstrap = ok(await f.call('user.bootstrap'));
  assert.equal(bootstrap.quota.balance, 1);
  assert.equal(bootstrap.quota.grantedToday, 1, 'refunds do not count as grants');
});

test('live query: partial upstream failure keeps the charge and reports per-store reasons', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' }, R639: { error: 'timeout' } });
  const f = createFixture({ fetchImpl });
  ok(await f.call('quota.signin'));
  const result = ok(await f.call('query.pickup', { queryId: 'q-part-0001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'] }));
  assert.equal(result.ok, true);
  assert.equal(result.refunded, 0);
  assert.equal(result.balance, 0);
  assert.equal(result.results[1].status, 'unknown');
});

test('live query validation: part number, store list size and catalog membership', async () => {
  const f = createFixture({ config: { query: { maxStores: 2 } } });
  failWith(await f.call('query.pickup', { queryId: 'short', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }), 'invalid_query_id');
  failWith(await f.call('query.pickup', { queryId: 'q-valid-0001', partNumber: 'nope', storeNumbers: ['R577'] }), 'invalid_part_number');
  failWith(await f.call('query.pickup', { queryId: 'q-valid-0001', partNumber: 'MJYH4CH/A', storeNumbers: [] }), 'no_stores');
  failWith(await f.call('query.pickup', { queryId: 'q-valid-0001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639', 'R320'] }), 'too_many_stores');
  failWith(await f.call('query.pickup', { queryId: 'q-valid-0001', partNumber: 'MJYH4CH/A', storeNumbers: ['R999'] }), 'unknown_store');
  failWith(await f.call('query.pickup', { queryId: 'q-valid-0001', partNumber: 'MNOPECH/A', storeNumbers: ['R577'] }), 'unknown_product');
  const unsupported = ok(await f.call('query.pickup', { queryId: 'q-valid-0001', partNumber: 'MWWW4CH/A', storeNumbers: ['R577'] }));
  assert.equal(unsupported.reason, 'unsupported_product');
});

test('new products are blocked for free users for 30 days and open to members', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'default' } });
  const f = createFixture({ fetchImpl, config: { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-11T00:00:00.000Z', label: 'iPhone 18 Pro 首发' }] } });
  ok(await f.call('quota.signin'));
  ok(await f.call('user.bootstrap'));
  const blocked = ok(await f.call('query.pickup', { queryId: 'q-new-00001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'new_product_restricted');
  assert.equal(blocked.restrictionEndsAt, '2026-10-11T00:00:00.000Z');
  assert.equal(blocked.balance, 1, 'a refused query is never charged');

  const grant = ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'test-grant-1' }, operatorContext()));
  assert.equal(grant.applied, true);
  const again = ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'test-grant-1' }, operatorContext()));
  assert.equal(again.applied, false, 'same grantId is idempotent');
  assert.equal(again.expiresAt, grant.expiresAt);

  const allowed = ok(await f.call('query.pickup', { queryId: 'q-new-00001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.member, true);
  assert.equal(allowed.charged, 0);
  assert.equal(allowed.results[0].status, 'pending');
  assert.equal(allowed.balance, 1);
});

test('history: one credit per historyQueryId, re-reads are free, events from live queries are visible', async () => {
  let display = 'unavailable';
  const fetchImpl = fakeFetch(() => ({ display }));
  const f = createFixture({ fetchImpl });
  failWith(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 5, grantId: 'seed-credits' }, operatorContext()), 'unknown_user');
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 5, grantId: 'seed-credits' }, operatorContext()));
  const repeated = ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 5, grantId: 'seed-credits' }, operatorContext()));
  assert.equal(repeated.applied, false);
  assert.equal(repeated.balance, 5);
  ok(await f.call('query.pickup', { queryId: 'q-hist-0001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
  f.advance(60 * 1000);
  display = 'available';
  ok(await f.call('query.pickup', { queryId: 'q-hist-0002', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));

  const first = ok(await f.call('history.list', { historyQueryId: 'h-0001-aaaa', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
  assert.equal(first.charged, 1);
  assert.equal(first.balance, 2);
  assert.equal(first.dayKey, '2026-09-15');
  assert.deepEqual(first.events.map(e => e.type), ['restock_confirmed']);
  assert.equal(first.summary.restocks, 1);
  assert.equal(first.latest[0].status, 'available');

  const again = ok(await f.call('history.list', { historyQueryId: 'h-0001-aaaa', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
  assert.equal(again.charged, 1);
  assert.equal(again.balance, 2, 'same history id is not charged twice');
  const otherDay = ok(await f.call('history.list', { historyQueryId: 'h-0002-bbbb', partNumber: 'MXXX1CH/A', dayKey: '2026-09-14' }));
  assert.equal(otherDay.balance, 1);
  assert.equal(otherDay.events.length, 0);
});

test('history: today of a restricted new product is closed to free users, yesterday is open', async () => {
  const f = createFixture({ config: { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-11T00:00:00.000Z' }] } });
  ok(await f.call('quota.signin'));
  const today = ok(await f.call('history.list', { historyQueryId: 'h-new-00001', partNumber: 'MJYH4CH/A' }));
  assert.equal(today.ok, false);
  assert.equal(today.reason, 'new_product_history_restricted');
  const yesterday = ok(await f.call('history.list', { historyQueryId: 'h-new-00002', partNumber: 'MJYH4CH/A', dayKey: '2026-09-14' }));
  assert.equal(yesterday.ok, true);
  assert.equal(yesterday.charged, 1);
});

test('follows: members only, 3 SKUs × 3 stores, no duplicate SKU, pause/resume/remove', async () => {
  const f = createFixture();
  failWith(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }), 'member_required');
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'grant-0001' }, operatorContext()));

  failWith(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639', 'R320', 'R448'] }), 'too_many_stores');
  failWith(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MWWW4CH/A', storeNumbers: ['R577'] }), 'unsupported_product');
  const a = ok(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R577', 'R639'] }));
  assert.deepEqual(a.follow.stores.map(s => s.storeNumber), ['R577', 'R639']);
  assert.equal(a.follow.stores[0].storeName, '天环广场');
  assert.equal(a.follow.status, 'active');
  failWith(await f.call('follow.upsert', { followId: 'f-0002-bbbb', partNumber: 'MJYH4CH/A', storeNumbers: ['R320'] }), 'duplicate_part_number');
  ok(await f.call('follow.upsert', { followId: 'f-0002-bbbb', partNumber: 'MXXX1CH/A', storeNumbers: ['R320'] }));
  ok(await f.call('follow.upsert', { followId: 'f-0003-cccc', partNumber: 'MYYY2CH/A', storeNumbers: ['R448'] }));
  failWith(await f.call('follow.upsert', { followId: 'f-0004-dddd', partNumber: 'MZZZ3CH/A', storeNumbers: ['R448'] }), 'too_many_follows');

  const edited = ok(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R320'] }));
  assert.deepEqual(edited.follow.stores.map(s => s.storeNumber), ['R320'], 'editing an existing follow does not count against limits');

  const paused = ok(await f.call('follow.pause', { followId: 'f-0002-bbbb' }));
  assert.equal(paused.follow.status, 'paused');
  const resumed = ok(await f.call('follow.resume', { followId: 'f-0002-bbbb' }));
  assert.equal(resumed.follow.status, 'active');
  ok(await f.call('follow.remove', { followId: 'f-0003-cccc' }));
  failWith(await f.call('follow.pause', { followId: 'f-0003-cccc' }), 'unknown_follow');
  const list = ok(await f.call('follow.list'));
  assert.deepEqual(list.follows.map(x => x.followId.split('|')[1]), ['f-0001-aaaa', 'f-0002-bbbb']);
  const bootstrap = ok(await f.call('user.bootstrap'));
  assert.equal(bootstrap.followCount, 2);
  const added = ok(await f.call('follow.upsert', { followId: 'f-0004-dddd', partNumber: 'MZZZ3CH/A', storeNumbers: ['R448'] }));
  assert.equal(added.follow.partNumber, 'MZZZ3CH/A');
});

test('membership expiry closes follow resume; renewals extend from the current expiry', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  const g1 = ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'grant-0001' }, operatorContext()));
  ok(await f.call('follow.upsert', { followId: 'f-0001-aaaa', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }));
  const g2 = ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 30, grantId: 'grant-0002' }, operatorContext()));
  assert.equal(Date.parse(g2.expiresAt) - Date.parse(g1.expiresAt), 30 * 24 * 60 * 60 * 1000);
  f.advance(61 * 24 * 60 * 60 * 1000);
  const status = ok(await f.call('member.status'));
  assert.equal(status.membership.active, false);
  assert.equal(status.orders.length, 2);
  ok(await f.call('follow.pause', { followId: 'f-0001-aaaa' }));
  failWith(await f.call('follow.resume', { followId: 'f-0001-aaaa' }), 'member_required');
  const order = ok(await f.call('member.createOrder', { orderId: 'o-0001-aaaa' }));
  assert.equal(order.ok, false);
  assert.equal(order.reason, 'payment_not_enabled');
});

test('admin: config patches are whitelisted and non-admins are rejected', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  failWith(await f.call('admin.getConfig', {}), 'forbidden');
  failWith(await f.call('admin.updateConfig', { patch: { evil: true } }, operatorContext()), 'invalid_config_key');
  failWith(await f.call('admin.updateConfig', { patch: { newProductWindows: [{ familyKey: 'x', releaseAt: 'bad' }] } }, operatorContext()), 'invalid_release_window');
  const updated = ok(await f.call('admin.updateConfig', { patch: { quota: { balanceCap: 20 }, adminUserKeys: [userKeyOf()] } }, operatorContext()));
  assert.equal(updated.config.quota.balanceCap, 20);
  assert.equal(updated.config.quota.queryCost, 1, 'defaults survive partial patches');
  const asPromotedUser = ok(await f.call('admin.getConfig', {}));
  assert.deepEqual(asPromotedUser.config.adminUserKeys, [userKeyOf()]);
  const stats = ok(await f.call('admin.stats', {}, operatorContext()));
  assert.equal(stats.users, 1);
  failWith(await f.call('admin.lookupUser', { userKey: 'nobody' }, operatorContext()), 'unknown_user');
});

test('subscription results are counted per template; only accepts add send credits', async () => {
  const f = createFixture({ config: { notifications: { templateIds: { restock: 'TPL_A', other: 'TPL_B', third: 'TPL_C' } } } });
  const data = ok(await f.call('notify.recordSubscription', { requestId: 'subscription-0001', results: { TPL_A: 'accept', TPL_B: 'reject', TPL_C: 'ban' } }));
  assert.deepEqual(data.accepted, ['TPL_A']);
  assert.equal(data.subscriptions.TPL_A.credits, 1);
  assert.equal(data.subscriptions.TPL_B.credits, 0);
  const again = ok(await f.call('notify.recordSubscription', { requestId: 'subscription-0002', results: { TPL_A: 'accept' } }));
  assert.equal(again.subscriptions.TPL_A.credits, 2);
  failWith(await f.call('notify.recordSubscription', {}), 'invalid_payload');
});

test('unexpected repository failures become internal_error and are logged, not leaked', async () => {
  const f = createFixture();
  f.repo.getProduct = async () => { throw new Error('boom: connection string'); };
  const result = await f.call('query.pickup', { queryId: 'q-boom-0001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] });
  failWith(result, 'internal_error');
  assert.equal(result.error.message.includes('connection string'), false);
  assert.equal(f.logs.length, 1);
});

test('catalog.get serves the seeded catalog with version short-circuit', async () => {
  const f = createFixture();
  const unchanged = ok(await f.call('catalog.get', { ifVersion: 'test|v1' }));
  assert.equal(unchanged.unchanged, true);
  const full = ok(await f.call('catalog.get', {}));
  assert.equal(full.stores.length, 4);
  assert.equal(full.products.length, 5);
  assert.equal(full.products[0].category, 'iphone');
  assert.ok(appleBody('R577', '天环广场', { 'MJYH4CH/A': 'available' }).includes('今天可取货'));
});
