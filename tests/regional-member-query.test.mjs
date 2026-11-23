import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, fakeFetch, userContext, userKeyOf } from './helpers/fixture.mjs';
import { marketMembership } from './helpers/market-membership.mjs';
import { COLLECTIONS } from '../cloudfunctions/gxs_api/lib/collections.js';
import { runScheduled } from '../cloudfunctions/gxs_api/lib/engine/scheduled.js';

const targets = {
  JP: { store: 'R128', part: 'MJR54J/A' },
  TW: { store: 'R694', part: 'MJY04ZP/A' },
  HK: { store: 'R409', part: 'MJRP4ZA/A' },
};
const closed = { JP: false, TW: false, HK: false };
const launchPeriod = '2026-09-19T00:00:00Z';
function setup(start = launchPeriod) {
  return createFixture({
    start,
    fetchImpl: fakeFetch(() => ({ display: 'available' })),
    config: {
      query: { sharedFreshnessSeconds: 15 },
      internationalMarkets: closed,
      internationalMonitoring: closed,
      internationalNotifications: closed,
      collector: { enabled: true },
      notifications: { enabled: true },
      internationalQueryLimits: { maxRequestsPerMinute: 1, maxRequestsPerDay: 2 },
    },
  });
}
function ok(response) {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.data;
}
async function customer(f, openid, plan, remainingMs) {
  const actor = userContext(openid);
  const key = userKeyOf(openid);
  ok(await f.call('user.bootstrap', {}, actor));
  if (plan) await f.repo.updateUser(key, { membership: marketMembership(f.state.now, plan, remainingMs) });
  return { actor, key };
}
function check(f, { actor, key }, market, id, maxCost = 0) {
  const { store, part } = targets[market];
  return f.call('market.pickup', { market, expectedUserKey: key, queryId: id, partNumber: part, storeNumbers: [store], maxCost }, actor);
}
function seedFreshSample(f, market) {
  const { store, part } = targets[market];
  return f.repo.saveLatest({
    _id: [market, store, part].join('|'), market, storeNumber: store, partNumber: part,
    status: 'available', observedAt: f.state.now.toISOString(),
  });
}

test('monthly and annual customers can check each closed storefront during launch with no credit, no private preview and no background demand', async () => {
  const f = setup();
  const month = await customer(f, 'ordinary-monthly', 'member_30d');
  const year = await customer(f, 'ordinary-annual', 'member_365d');
  const catalog = ok(await f.call('market.catalog')).markets;
  assert.deepEqual(catalog.map(site => [site.enabled, site.monitorEnabled, site.notificationsEnabled]), Array(3).fill([false, false, false]));
  for (const user of [month, year]) {
    const boot = ok(await f.call('user.bootstrap', {}, user.actor));
    assert.deepEqual([...(boot.regionalMemberQueryMarkets || [])].sort(), Object.keys(targets).sort());
    assert.ok(!boot.regionalQueryPreview && !boot.membership.isTester);
    assert.equal(boot.quota.balance, 0);
  }
  for (const [market, { store, part }] of Object.entries(targets)) {
    const receipt = ok(await check(f, month, market, 'monthly-' + market));
    assert.deepEqual([receipt.ok, receipt.charged, receipt.balance, receipt.results[0].partNumber, receipt.results[0].storeNumber],
      [true, 0, 0, part, store]);
    const shared = ok(await check(f, year, market, 'annual-' + market));
    assert.deepEqual([shared.ok, shared.allShared, shared.charged, shared.results[0].observedAt], [true, true, 0, receipt.results[0].observedAt]);
    assert.equal(ok(await check(f, month, market, 'monthly-' + market)).replayed, true);
    const [latest] = await f.repo.getLatest([market + '|' + store + '|' + part]);
    assert.deepEqual([latest.source, latest.status], ['manual', 'available']);
  }
  assert.equal(f.state.fetchImpl.calls.length, 3);
  f.advance(16000);
  const exhausted = ok(await check(f, year, 'JP', 'annual-jp-limited'));
  assert.deepEqual([exhausted.reason, exhausted.charged, exhausted.budgetScope], ['upstream_budget_limited', 0, 'minute']);
  const runtime = await f.repo.getConfig();
  await f.repo.saveConfig({ ...runtime, internationalMonitoring: { JP: true, TW: true, HK: true } });
  const deliveries = [];
  await runScheduled({ repo: f.repo, clock: () => f.state.now, fetchImpl: f.state.fetchImpl,
    log: { info() {}, warn() {}, error() {} }, sendImpl: async message => { deliveries.push(message); return { errcode: 0 }; } });
  assert.equal(f.state.fetchImpl.calls.length, 3);
  assert.equal(deliveries.length, 0);
  for (const name of ['follows', 'notifications', 'ledger']) assert.equal(await f.repo.count(COLLECTIONS[name]), 0, name);
});

test('private tester access does not advertise a paid membership to an account with no paid pass', async t => {
  const f = setup();
  const tester = await customer(f, 'regional-preview-only');
  const previous = process.env.GXS_TEST_ADMIN_USER_KEY;
  process.env.GXS_TEST_ADMIN_USER_KEY = tester.key;
  t.after(() => {
    if (previous === undefined) delete process.env.GXS_TEST_ADMIN_USER_KEY;
    else process.env.GXS_TEST_ADMIN_USER_KEY = previous;
  });
  await f.repo.saveConfig({ ...await f.repo.getConfig(), adminUserKeys: [tester.key] });
  const boot = ok(await f.call('user.bootstrap', {}, tester.actor));
  assert.equal(boot.membership.isTester, true);
  assert.deepEqual([...(boot.regionalQueryPreview || [])].sort(), Object.keys(targets).sort());
  assert.equal(boot.regionalMemberQueryMarkets?.length || 0, 0);
});

test('weekly and free customers follow the public gate and local launch window; an expired monthly pass cannot fetch again', async () => {
  const f = setup();
  const month = await customer(f, 'expiring-monthly', 'member_30d', 1);
  const week = await customer(f, 'weekly-public', 'member_7d');
  const free = await customer(f, 'free-public');
  const trial = await customer(f, 'trial-public', 'member_trial');
  const oldGrant = await customer(f, 'legacy-grant');
  await f.repo.updateUser(oldGrant.key, { membership: { expiresAt: '2027-09-20T00:00:00Z', planId: 'member_365d' } });
  ok(await f.call('quota.signin', {}, free.actor));
  for (const user of [free, trial, week, oldGrant]) {
    const boot = ok(await f.call('user.bootstrap', {}, user.actor));
    assert.equal(boot.regionalMemberQueryMarkets?.length || 0, 0);
    assert.equal((await check(f, user, 'TW', 'closed-week-free', 1)).error.code, 'market_disabled');
  }
  const receipt = ok(await check(f, month, 'TW', 'before-expiry'));
  assert.equal(receipt.ok, true);
  f.advance(1);
  assert.equal((await check(f, month, 'TW', 'after-expiry')).error.code, 'market_disabled');
  assert.equal(ok(await check(f, month, 'TW', 'before-expiry')).replayed, true);
  const cfg = await f.repo.getConfig();
  await f.repo.saveConfig({ ...cfg, internationalMarkets: { ...closed, JP: true } });
  assert.equal(ok(await check(f, week, 'JP', 'weekly-new-launch')).charged, 0);
  const early = ok(await check(f, free, 'JP', 'free-new-launch', 1));
  assert.deepEqual([early.reason, early.balance], ['new_product_restricted', 1]);
  f.advance(Date.parse('2026-10-17T15:00:00.000Z') - f.state.now.getTime());
  const eligible = ok(await check(f, free, 'JP', 'free-day-31', 1));
  assert.deepEqual([eligible.ok, eligible.charged, eligible.balance], [true, 1, 0]);
  assert.equal(f.state.fetchImpl.calls.length, 3);
});

for (const phase of ['beginQuery', 'claimQueryTarget', 'consumeCollectorBudget']) {
  test('a monthly-to-weekly downgrade before ' + phase + ' cannot open a closed market or charge the customer', async () => {
    const f = setup();
    const user = await customer(f, 'changing-customer', 'member_30d');
    if (phase === 'claimQueryTarget') await seedFreshSample(f, 'HK');
    const original = f.repo[phase].bind(f.repo);
    let ran = false;
    f.repo[phase] = async args => {
      f.repo[phase] = original;
      ran = true;
      await f.repo.updateUser(user.key, { membership: marketMembership(f.state.now, 'member_7d') });
      return original(args);
    };
    const response = await check(f, user, 'HK', 'renewal-downgrade');
    assert.equal(ran, true, phase);
    assert.equal(response.ok ? response.data.reason : response.error.code, 'market_disabled');
    assert.equal(f.state.fetchImpl.calls.length, 0);
    assert.equal(await f.repo.count(COLLECTIONS.config, { kind: 'market_budget' }), 0);
    assert.deepEqual(await f.repo.listLedger(user.key), []);
    if (phase === 'consumeCollectorBudget') {
      const other = await customer(f, 'unaffected-annual', 'member_365d');
      const receipt = ok(await check(f, other, 'HK', 'unaffected-annual-query'));
      assert.deepEqual([receipt.ok, receipt.charged, f.state.fetchImpl.calls.length], [true, 0, 1]);
    }
  });

  test('a monthly pass expiring while ' + phase + ' waits cannot start work or return a cached sample', async () => {
    const f = setup();
    const user = await customer(f, 'last-millisecond-customer', 'member_30d', 1);
    if (phase === 'claimQueryTarget') await seedFreshSample(f, 'TW');
    const original = f.repo[phase].bind(f.repo);
    f.repo[phase] = async args => {
      f.advance(1);
      return original(args);
    };
    const response = await check(f, user, 'TW', 'waiting-across-expiry');
    assert.equal(response.ok ? response.data.reason : response.error.code, 'market_disabled');
    assert.equal(f.state.fetchImpl.calls.length, 0);
    assert.equal(await f.repo.count(COLLECTIONS.config, { kind: 'market_budget' }), 0);
    if (phase === 'beginQuery') assert.equal(await f.repo.count(COLLECTIONS.queries), 0);
  });
}

for (const phase of ['claimQueryTarget', 'consumeCollectorBudget']) {
  test('a public credit reserved before ' + phase + ' is returned when the market closes and the customer upgrades', async () => {
    const f = setup('2026-11-24T01:00:00Z');
    const user = await customer(f, 'upgrading-customer');
    const config = await f.repo.getConfig();
    await f.repo.saveConfig({ ...config, internationalMarkets: { ...closed, HK: true } });
    ok(await f.call('quota.signin', {}, user.actor));
    if (phase === 'claimQueryTarget') await seedFreshSample(f, 'HK');
    const original = f.repo[phase].bind(f.repo);
    f.repo[phase] = async args => {
      f.repo[phase] = original;
      assert.equal((await f.repo.getUser(user.key)).quota.balance, 0);
      await f.repo.saveConfig(config);
      await f.repo.updateUser(user.key, { membership: marketMembership(f.state.now, 'member_30d') });
      return original(args);
    };
    const receipt = ok(await check(f, user, 'HK', 'interrupted-upgrade', 1));
    assert.deepEqual([receipt.ok, receipt.reason, receipt.charged, receipt.refunded, receipt.balance], [false, 'market_disabled', 1, 1, 1]);
    assert.equal(f.state.fetchImpl.calls.length, 0);
    const replay = ok(await check(f, user, 'HK', 'interrupted-upgrade'));
    assert.deepEqual([replay.replayed, replay.balance], [true, 1]);
    const fresh = ok(await check(f, user, 'HK', 'upgraded-member-query'));
    assert.deepEqual([fresh.ok, fresh.charged, fresh.balance], [true, 0, 1]);
  });
}
