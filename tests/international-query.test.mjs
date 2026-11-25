import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appleBody, createFixture as fixture, fakeFetch, operatorContext, userContext, userKeyOf } from './helpers/fixture.mjs';
import { marketMembership } from './helpers/market-membership.mjs';
const require = createRequire(import.meta.url);
const { mergeConfig, patchConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { buildPickupUrl } = require('../cloudfunctions/gxs_api/lib/apple-pickup');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const samples = {
  JP: ['R128', 'MJR54J/A'], TW: ['R713', 'MJRP4ZP/A'], HK: ['R409', 'MJRP4ZA/A'], US: ['R077', 'MJQ34LL/A'],
};
const enabled = { JP: true, TW: true, HK: true, US: true };
const createFixture = options => fixture({ start: '2026-11-23T02:00:00Z', ...options });
const ok = reply => { assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.data; };
function payload(market, id = 'market-query-01') {
  const [storeNumber, partNumber] = samples[market];
  return { market, partNumber, storeNumbers: [storeNumber], queryId: id, expectedUserKey: userKeyOf(), maxCost: 1 };
}

test('each region unlocks credits at local midnight on day 31 and ignores mainland prices and release windows', async () => {
  const config = { internationalMarkets: enabled, quota: { queryCost: 6 },
    newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-10-17T00:00:00Z' }] };
  for (const [market, endsAt] of [['JP','2026-10-17T15:00:00.000Z'], ['TW','2026-10-17T16:00:00.000Z'], ['HK','2026-10-17T16:00:00.000Z'], ['US','2026-10-18T07:00:00.000Z']]) {
    const [store] = samples[market];
    const fetchImpl = fakeFetch({ [store]: { display: 'available' } });
    const f = createFixture({ config, start: new Date(Date.parse(endsAt) - 1).toISOString(), fetchImpl });
    await Promise.all([f.call('quota.signin'), f.call('quota.signin')]).then(replies => replies.forEach(ok));
    assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
    const catalog = ok(await f.call('market.catalog')).markets.find(s => s.code === market);
    assert.equal(catalog.products.find(p => p.partNumber === samples[market][1]).freeQueryStartsAt, endsAt);
    const before = ok(await f.call('market.pickup', payload(market)));
    assert.deepEqual([before.reason, before.restrictionEndsAt, before.balance, fetchImpl.calls.length], ['new_product_restricted', endsAt, 1, 0]);
    f.advance(1);
    const after = ok(await f.call('market.pickup', payload(market)));
    assert.deepEqual([after.ok, after.charged, after.balance, fetchImpl.calls.length], [true, 1, 0, 1]);
    assert.equal(ok(await f.call('market.pickup', payload(market))).replayed, true);
  }
});

test('regional early access checks actual plan benefits rather than time remaining; trial members keep normal-period free checks', async () => {
  for (const [plan, qualifies] of [['member_7d',true], ['member_30d',true], ['member_365d',true], ['member_trial',false], ['legacy',false]]) {
    const f = createFixture({ config: { internationalMarkets: enabled }, start: '2026-09-16T18:00:00Z', fetchImpl: fakeFetch({ R128: { display: 'available' } }) });
    ok(await f.call('user.bootstrap'));
    await f.repo.updateUser(userKeyOf(), { membership: plan === 'legacy' ? { expiresAt: '2027-09-16T00:00:00Z', planId: 'member_365d' }
      : marketMembership(f.state.now, plan, qualifies ? 2000 : 31536000000) });
    const reply = ok(await f.call('market.pickup', payload('JP')));
    assert.equal(reply.ok, qualifies, plan);
    assert.equal(f.state.fetchImpl.calls.length, qualifies ? 1 : 0);
    if (qualifies) {
      assert.equal(reply.charged, 0);
      f.advance(2000);
      assert.equal(ok(await f.call('market.pickup', payload('JP'))).replayed, true, 'completed receipt remains readable at expiry');
      assert.equal(ok(await f.call('market.pickup', payload('JP', 'new-after-expiry'))).reason, 'new_product_restricted');
    } else {
      assert.equal(reply.reason, 'new_product_restricted');
      f.advance(40 * 86400000);
      assert.equal(ok(await f.call('market.pickup', payload('JP'))).charged, 0);
    }
  }
  const { decideMarketQuery } = require('../cloudfunctions/gxs_api/lib/rules/access');
  const denied = decideMarketQuery({ user: { quota: { balance: 9 } }, product: { supported: true }, now: new Date() });
  assert.deepEqual([denied.reason, denied.restrictionEndsAt, denied.cost], ['new_product_restricted', null, 0]);
});

test('recovering an old pending regional debit after a permission change refunds once and never fetches or spends twice', async () => {
  const f = createFixture({ config: { internationalMarkets: enabled }, start: '2026-09-19T00:00:00Z' });
  ok(await f.call('quota.signin'));
  const request = payload('JP','legacy-pending-debit');
  const id = userKeyOf() + '|' + request.queryId;
  // A receipt charged under the previous policy, before regional dates were known.
  const original = await f.repo.beginQuery({ record: { _id: id, userKey: userKeyOf(), kind: 'market', ...request },
    product: { supported: true, freeQueryStartsAt: '2020-01-01T00:00:00Z' }, config: mergeConfig(null), ownerId: 'prior', nowIso: f.state.now.toISOString() });
  assert.equal(original.record.charged, 1);
  f.advance(30000);
  const attempts = await Promise.all([f.call('market.pickup', request), f.call('market.pickup', request)]);
  for (const result of attempts.map(ok)) assert.deepEqual([result.reason,result.refunded,result.balance], ['new_product_restricted',1,1]);
  assert.equal(f.state.fetchImpl.calls.length, 0);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(r => r.type === 'query_refund').length, 1);
});

test('four market catalogs expose verified local SKUs and stores even while rollout is closed', async () => {
  const f = createFixture();
  const { markets } = ok(await f.call('market.catalog', {}));
  assert.deepEqual(markets.map(m => m.code), ['JP', 'TW', 'HK', 'US']);
  assert.deepEqual(markets.map(m => m.stores.length), [11, 2, 6, 269]);
  const categories = ['airpods', 'homepod', 'ipad', 'iphone', 'mac'];
  for (const site of markets) {
    const [store, sku] = samples[site.code];
    assert.equal(site.enabled, false);
    assert.equal(site.monitorEnabled, false);
    assert.equal(site.notificationsEnabled, false);
    assert.ok(site.stores.some(s => s.storeNumber === store && s.timeZone === site.timeZone));
    assert.ok(site.products.some(p => p.partNumber === sku && p.titleEn && p.capacity));
    assert.deepEqual([...new Set(site.products.map(p => p.category))].sort(), categories);
    assert.equal(new Set(site.products.map(p => p.id)).size,site.products.length);
    assert.ok(site.products.filter(p => p.familyKey === 'iphone-18-pro').length >= 32);
    const result = await f.call('market.pickup', payload(site.code));
    assert.equal(result.error.code, 'market_disabled');
  }
  assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
  assert.equal(f.state.fetchImpl.calls.length, 0);
  assert.throws(() => patchConfig({}, { internationalMarkets: { UK: true } }), { code: 'invalid_config' });
  assert.throws(() => patchConfig({}, { internationalMonitoring: { TW: 'true' } }), { code: 'invalid_config' });
  assert.throws(() => patchConfig({}, { internationalQueryLimits: { maxRequestsPerMinute: 0 } }), { code: 'invalid_config' });
  assert.throws(() => patchConfig({}, { notifications: { templateIds: { restock: 'zh-id', restockEn: 'zh-id' } } }), { code: 'invalid_config' });
});

test('market queries require the active user and exact market, SKU and store before charging or access', async () => {
  const f = createFixture({ config: { internationalMarkets: enabled } });
  for (const [patch, code] of [[{ market: 'CN' }, 'unknown_market'], [{ market: { code: 'JP' } }, 'unknown_market'],
    [{ expectedUserKey: userKeyOf('different') }, 'query_account_changed'], [{ partNumber: samples.TW[1] }, 'invalid_market_target'],
    [{ storeNumbers: ['R577'] }, 'invalid_market_target'], [{ storeNumbers: ['R128', 'R128'] }, 'invalid_market_target'],
    [{ maxCost: -1 }, 'invalid_payload'], [{ queryId: 'a' }, 'invalid_query_id']]) {
    const reply = await f.call('market.pickup', { ...payload('JP'), ...patch });
    assert.equal(reply.error.code, code);
  }
  assert.throws(() => buildPickupUrl('R128', [samples.JP[1]], [], 'https://example.org'), /invalid_market_target/);
  assert.equal(f.state.fetchImpl.calls.length, 0);
  assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
});

for (const [market, display, status] of [['JP', 'available', 'available'], ['HK', 'default', 'pending'], ['TW', 'ineligible', 'ineligible']]) {
  test(market + ' uses the official storefront, exact local SKU and a single debit for retries', async () => {
    const [store, sku] = samples[market];
    const fetchImpl = fakeFetch({ [store]: { display } });
    const f = createFixture({ config: { internationalMarkets: enabled }, fetchImpl });
    ok(await f.call('quota.signin'));
    const request = payload(market);
    const result = ok(await f.call('market.pickup', request));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.charged, 1);
    assert.equal(result.refunded, 0);
    assert.equal(result.market, market);
    assert.equal(result.results[0].market, market);
    assert.equal(result.results[0].partNumber, sku);
    assert.equal(result.results[0].status, status);
    assert.equal(result.results[0].observedAt, f.state.now.toISOString());
    const url = new URL(fetchImpl.calls[0].href);
    assert.equal(url.origin, 'https://www.apple.com');
    assert.equal(url.pathname, '/' + market.toLowerCase() + '/shop/retail/pickup-message');
    assert.equal(url.searchParams.get('parts.0'), sku);
    assert.equal(url.searchParams.get('store'), store);
    f.advance(100000);
    const replay = ok(await f.call('market.pickup', request));
    assert.equal(replay.replayed, true);
    assert.equal(replay.results[0].observedAt, result.results[0].observedAt);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal((await f.call('market.pickup', payload(market === 'TW' ? 'JP' : 'TW'))).error.code, 'query_id_conflict');
    assert.equal((await f.call('query.pickup', { queryId: request.queryId, partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] })).error.code, 'query_id_conflict');
    assert.deepEqual(ok(await f.call('query.recent')).queries, []);
    await f.repo.saveConfig({ internationalMarkets: {} });
    assert.equal(ok(await f.call('market.pickup', request)).replayed, true);
    assert.equal(fetchImpl.calls.length, 1);
  });
}

test('failed overseas requests refund credits, open only their regional breaker and never report no stock', async () => {
  for (const status of [429, 503, 541]) {
    const fetchImpl = fakeFetch({ R128: { status }, R713: { display: 'unavailable' }, R577: { display: 'available' } });
    const f = createFixture({ config: { internationalMarkets: enabled }, fetchImpl });
    ok(await f.call('quota.signin'));
    const failure = ok(await f.call('market.pickup', payload('JP')));
    assert.deepEqual([failure.ok, failure.results[0].status, failure.refunded, failure.balance], [false, 'unknown', 1, 1]);
    const paused = ok(await f.call('market.pickup', payload('JP', 'market-jp-again')));
    assert.equal(paused.reason, 'upstream_paused');
    assert.equal(paused.charged, paused.refunded);
    const tw = ok(await f.call('market.pickup', payload('TW', 'market-tw-again')));
    assert.equal(tw.results[0].status, 'unavailable');
    ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 1, grantId: 'cn-after-local-failure' }, operatorContext()));
    const cn = ok(await f.call('query.pickup', { queryId: 'cn-still-independent', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
    assert.equal(cn.results[0].status, 'available');
    assert.deepEqual(fetchImpl.calls.map(call => call.storeNumber), ['R128', 'R713', 'R577']);
  }
});

test('missing store, mismatched SKU and unreadable upstream replies remain unknown in every locale', async () => {
  for (const body of [appleBody('R409', 'Causeway Bay', { [samples.JP[1]]: 'available' }),
    appleBody('R128', '新宿', { [samples.HK[1]]: 'available' }), '<html>利用できません</html>']) {
    const f = createFixture({ config: { internationalMarkets: enabled }, fetchImpl: fakeFetch({ R128: { body } }) });
    ok(await f.call('quota.signin'));
    const reply = ok(await f.call('market.pickup', payload('JP')));
    assert.deepEqual([reply.ok, reply.results[0].status, reply.charged, reply.refunded], [false, 'unknown', 1, 1]);
  }
});

test('only a fresh known sample with the same market and target can replace a billed refresh', async () => {
  const fetchImpl = fakeFetch({ R128: { display: 'available' } });
  const f = createFixture({ config: { internationalMarkets: enabled, query: { sharedFreshnessSeconds: 10 } }, fetchImpl });
  ok(await f.call('quota.signin'));
  const request = payload('JP');
  await f.repo.saveLatest({ _id: request.storeNumbers[0] + '|' + request.partNumber, storeNumber: 'R128', partNumber: request.partNumber,
    status: 'unavailable', observedAt: f.state.now.toISOString() });
  const first = ok(await f.call('market.pickup', request));
  assert.equal(first.results[0].status, 'available');
  f.advance(5000);
  const other = userContext('second-user');
  ok(await f.call('quota.signin', {}, other));
  const second = ok(await f.call('market.pickup', { ...request, queryId: 'fresh-another-user', expectedUserKey: userKeyOf('second-user') }, other));
  assert.equal(second.results[0].observedAt, first.results[0].observedAt);
  assert.equal(second.allShared, true);
  assert.equal(second.balance, 1);
  assert.equal(fetchImpl.calls.length, 1);
  f.advance(5000);
  const newSample = ok(await f.call('market.pickup', { ...request, queryId: 'expired-another-user', expectedUserKey: userKeyOf('second-user') }, other));
  assert.equal(newSample.allShared, false);
  assert.equal(newSample.charged, 1);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal((await f.repo.getLatest(['JP|R128|' + request.partNumber]))[0].market, 'JP');
});

test('a stopped site can settle an abandoned market debit; an unpublished site never creates a request', async () => {
  const f = createFixture({ config: { internationalMarkets: enabled } });
  ok(await f.call('quota.signin'));
  const { market, queryId, partNumber, storeNumbers } = payload('JP');
  const id = userKeyOf() + '|' + queryId;
  await f.repo.beginQuery({ record: { _id: id, userKey: userKeyOf(), kind: 'market', market, queryId, partNumber, storeNumbers },
    product: require('../cloudfunctions/gxs_api/lib/markets').findMarket(market).products.find(p => p.partNumber === partNumber),
    config: mergeConfig(null), ownerId: 'lost', nowIso: f.state.now.toISOString() });
  await f.repo.saveConfig({ internationalMarkets: {} });
  assert.equal(ok(await f.call('market.pickup', payload('JP'))).reason, 'query_in_progress');
  f.advance(30000);
  const expired = ok(await f.call('market.pickup', payload('JP')));
  assert.equal(expired.reason, 'query_expired');
  assert.equal(expired.refunded, 1);
  assert.equal(expired.balance, 1);
  assert.equal(f.state.fetchImpl.calls.length, 0);
  assert.equal(await f.repo.count(C.queries), 1);
});

test('delisted regional products and stores preserve only their owner’s exact receipt and refund an expired lease once', async () => {
  for (const withdrawn of [{partNumber:'MFHE4J/A'}, {storeNumbers:['R999']}]) {
    const f = createFixture({ config: { internationalMarkets: enabled } });
    const userKey = userKeyOf();
    ok(await f.call('quota.signin'));
    const request = { ...payload('JP','before-delisting'), ...withdrawn };
    const id = userKey+'|'+request.queryId;
    const previous = await f.repo.beginQuery({ record: { _id:id, userKey, kind:'market', ...request },
      product:{ supported:true, freeQueryStartsAt:'2020-01-01T00:00:00Z' }, config:mergeConfig(null),
      ownerId:'old-worker', nowIso:f.state.now.toISOString() });
    assert.equal(previous.record.charged,1);
    assert.equal(ok(await f.call('market.pickup',request)).reason,'query_in_progress');
    assert.equal((await f.call('market.pickup',{...request,queryId:'different-id'})).error.code,'invalid_market_target');
    assert.equal((await f.call('market.pickup',{...request,market:'TW'})).error.code,'invalid_market_target');
    const differentUser = userContext('other');
    assert.equal((await f.call('market.pickup',{...request,expectedUserKey:userKeyOf('other')},differentUser)).error.code,'invalid_market_target');
    f.advance(30000);
    const receipts = await Promise.all([f.call('market.pickup',request),f.call('market.pickup',request)]);
    for (const receipt of receipts.map(ok)) {
      assert.deepEqual([receipt.replayed,receipt.reason,receipt.refunded,receipt.balance],[true,'query_expired',1,1]);
    }
    assert.equal((await f.repo.listLedger(userKey)).filter(r=>r.type==='query_refund').length,1);
    assert.equal(await f.repo.count(C.queries),1);
    assert.equal(f.state.fetchImpl.calls.length,0);
  }
});

test('regional and mainland manual actions share an account concurrency cap even for members', async () => {
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const source = fakeFetch({ R128: {} });
  const f = createFixture({ config: { internationalMarkets: enabled },
    fetchImpl: async (...args) => { enter(); await gate; return source(...args); } });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00.000Z' } });
  const request = payload('JP');
  const first = f.call('market.pickup', request);
  await started;
  try {
    const retry = ok(await f.call('market.pickup', request));
    assert.equal(retry.reason, 'query_in_progress');
    const other = ok(await f.call('query.pickup', { queryId: 'cn-during-market-query', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] }));
    assert.equal(other.reason, 'query_concurrency_limited');
  } finally { release(); }
  const result = ok(await first);
  assert.equal(result.member, true);
  assert.equal(result.charged, 0);
  assert.equal(source.calls.length, 1);
});

test('regional quota changes and last-minute rollout shutdown cannot debit a new customer request', async () => {
  const f = createFixture({ config: { internationalMarkets: enabled } });
  ok(await f.call('quota.signin'));
  const stalePrice = await f.call('market.pickup', { ...payload('TW'), maxCost: 0 });
  assert.equal(stalePrice.error.code, 'query_cost_changed');
  const reserve = f.repo.consumeCollectorBudget;
  f.repo.consumeCollectorBudget = async args => {
    await f.repo.saveConfig({ internationalMarkets: { TW: false } });
    return reserve(args);
  };
  const stopped = ok(await f.call('market.pickup', payload('TW', 'closing-from-console')));
  assert.equal(stopped.reason, 'market_disabled');
  assert.equal(stopped.charged, stopped.refunded);
  assert.equal(stopped.balance, 1);
  assert.equal(f.state.fetchImpl.calls.length, 0);
  assert.equal((await f.repo.getLatest(['TW|R713|' + samples.TW[1]])).length, 0);
});

test('the regional daily and minute budget is bounded separately from other markets and from CN', async () => {
  const fetchImpl = fakeFetch({ R128: {}, R713: {} });
  const f = createFixture({ config: { internationalMarkets: enabled, internationalQueryLimits: { maxRequestsPerMinute: 1, maxRequestsPerDay: 2 } }, fetchImpl });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00.000Z' } });
  assert.equal(ok(await f.call('market.pickup', payload('JP'))).ok, true);
  const limited = ok(await f.call('market.pickup', payload('JP', 'second-jp-query')));
  assert.equal(limited.reason, 'upstream_budget_limited');
  assert.equal(limited.budgetScope, 'minute');
  assert.equal(ok(await f.call('market.pickup', payload('TW', 'first-tw-query'))).ok, true);
  f.advance(60000);
  assert.equal(ok(await f.call('market.pickup', payload('JP', 'third-jp-query'))).ok, true);
  f.advance(60000);
  assert.equal(ok(await f.call('market.pickup', payload('JP', 'fourth-jp-query'))).budgetScope, 'daily');
  assert.deepEqual(fetchImpl.calls.map(c => c.storeNumber), ['R128', 'R713', 'R128']);
  assert.equal(f.repo.tables.get(C.config).has('collector_budget_2026-11-23'), false);
});

test('Chinese and English readiness require separate valid templates and a running configuration', async () => {
  const config = { internationalMonitoring: { JP: true }, internationalNotifications: { JP: true },
    collector: { enabled: true }, notifications: { enabled: true, templateIds: { restock: 'zh-template' } } };
  const f = createFixture({ config });
  const get = async () => ok(await f.call('market.catalog')).markets[0];
  assert.equal((await get()).monitorEnabled, true);
  assert.equal((await get()).notificationsEnabled, true);
  assert.equal((await get()).notificationsEnabledEn, false);
  await f.repo.saveConfig({ ...config, notifications: { enabled: true, templateIds: { restock: 'zh-template', restockEn: 'en-template' } } });
  assert.equal((await get()).notificationsEnabledEn, true);
  await f.repo.saveConfig({ ...config, collector: { enabled: false } });
  assert.equal((await get()).monitorEnabled, false);
  assert.equal((await get()).notificationsEnabled, false);
});

test('a slow Japanese budget transaction cannot queue mainland or Taiwan admission behind it', async () => {
  const { guardedPickup } = require('../cloudfunctions/gxs_api/lib/engine/guarded-pickup');
  const fetchImpl = fakeFetch({ R128: {}, R577: {}, R713: {} });
  const f = createFixture({ fetchImpl, config: { internationalMarkets: enabled } });
  const config = mergeConfig(await f.repo.getConfig());
  let entered, release, timer;
  const start = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const reserve = f.repo.consumeCollectorBudget;
  f.repo.consumeCollectorBudget = async args => {
    if (args.market === 'JP') { entered(); await gate; }
    return reserve(args);
  };
  const source = (market, storeNumber, partNumber) => guardedPickup({ market, repo: f.repo, config, clock: () => f.state.now, fetchImpl,
    storeNumber, partNumbers: [partNumber], timeoutMs: 5000 });
  const jp = source('JP', ...samples.JP);
  await start;
  try {
    await Promise.race([Promise.all([source(null, 'R577', 'MXXX1CH/A'), source('TW', ...samples.TW)]),
      new Promise((unused, reject) => { timer = setTimeout(() => reject(new Error('independent admissions stalled')), 1200); })]);
    assert.deepEqual(fetchImpl.calls.map(c => c.storeNumber).sort(), ['R577', 'R713']);
  } finally { clearTimeout(timer); release(); await jp; }
});

test('manual demand cannot consume the 80% daily reservation for a monitored regional market', async () => {
  const f = createFixture({ config: { internationalMarkets: enabled, internationalMonitoring: { JP: true }, collector: { enabled: true } } });
  const admit = source => f.repo.consumeCollectorBudget({ now: f.state.now.toISOString(), maxRequestsPerMinute: 20,
    maxRequestsPerDay: 5, budgetMode: 'daily', source, autoShare: 0.8, market: 'JP' });
  assert.equal((await admit('manual')).allowed, true);
  assert.equal((await admit('manual')).reason, 'daily_budget');
  for (let i = 0; i < 4; i++) assert.equal((await admit('auto')).allowed, true);
  assert.equal((await admit('auto')).reason, 'daily_budget');
  const stored = f.repo.tables.get(C.config).get('market_JP_collector_budget_2026-11-23');
  assert.deepEqual([stored.manualCount, stored.autoCount, stored.dayCount], [1, 4, 5]);
});

test('catalog publishes regional cadence and timestamp only as station-wide health, out-of-date heartbeats stay stale', async () => {
  const f = createFixture({ config: { internationalMonitoring: { JP: true }, collector: { enabled: true } } });
  const read = async () => ok(await f.call('market.catalog')).markets[0];
  assert.equal((await read()).monitorStale, true);
  const observed = f.state.now.toISOString();
  const row = { _id: 'collector_status', state: 'running', updatedAt: observed, markets: { JP: {
    state: 'running', intervalMs: 120000, lastSuccessAt: observed, health: { state: 'healthy' },
    scheduler: { targets: ['private-target'] },
  } } };
  f.repo.insert(C.config, row);
  const live = await read();
  assert.deepEqual([live.monitorIntervalMs, live.monitorLastSuccessAt, live.monitorStale], [120000, observed, false]);
  assert.equal(JSON.stringify(live).includes('private-target'), false);
  f.advance(60000);
  assert.equal((await read()).monitorStale, true);
  assert.equal((await read()).monitorLastSuccessAt, observed);
});

test('a new execution cannot spend or refund a historical debit whose receipt was removed by retention', async () => {
  const fetchImpl = fakeFetch({ R128: { display: 'available' } });
  const f = createFixture({ config: { internationalMarkets: enabled }, fetchImpl });
  const request = payload('JP', 'retained-debit-once');
  ok(await f.call('quota.signin'));
  assert.equal(ok(await f.call('market.pickup', request)).charged, 1);
  f.advance(12 * 86400000);
  const cleanup = await f.repo.purgeExpiredData({ firstDay: '2026-11-26', cutoffIso: '2026-11-25T16:00:00.000Z' });
  assert.equal(cleanup.removed.queries, 1);
  ok(await f.call('quota.signin'));
  f.state.fetchImpl = fakeFetch({ R128: { status: 503 } });
  const replay = await f.call('market.pickup', request);
  assert.equal(replay.error.code, 'query_id_conflict');
  assert.equal(f.state.fetchImpl.calls.length, 0);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
  assert.equal((await f.repo.listLedger(userKeyOf())).filter(row => row.type === 'query_refund').length, 0);
});

test('compact regional directories round trip with every current product and no mainland SKU substitution', async () => {
  const f = createFixture();
  const compressed = ok(await f.call('market.catalog', { format: 'compact-v1' }));
  const expanded = ok(await f.call('market.catalog'));
  const { decodeMarketCatalog } = require('../miniprogram/utils/market-catalog');
  assert.deepEqual(decodeMarketCatalog(compressed), expanded);
  assert.equal(decodeMarketCatalog(expanded), expanded);
  assert.ok(Buffer.byteLength(JSON.stringify(compressed)) < Buffer.byteLength(JSON.stringify(expanded)) / 2);
  for (const site of expanded.markets) {
    const queryable = site.products.filter(p => p.querySupported);
    // A series disappearing from an Apple selector needs an explicit catalog review.
    const minimumCoverage = { iphone:73, ipad:156, mac:104, airpods:8, homepod:7 };
    for (const [category, count] of Object.entries(minimumCoverage)) {
      assert.ok(queryable.filter(product => product.category === category).length >= count,
        site.code+' lost previously verified '+category+' configurations');
    }
    const phones = new Set(queryable.filter(p => p.category === 'iphone').map(p => p.model));
    for (const model of ['iPhone 16','iPhone 17','iPhone 17e','iPhone Air','iPhone Duo','iPhone 18 Pro','iPhone 18 Pro Max']) assert.ok(phones.has(model),site.code+' '+model);
    const activeModels = new Set(queryable.map(product => product.category));
    for (const category of ['iphone','ipad','mac','airpods','homepod']) assert.ok(activeModels.has(category),site.code+' '+category);
    assert.equal(site.products.some(p => !p.querySupported || !p.partNumber), false, site.code + ' publishes only retail SKUs');
  }
});

test('local retail configurations of each queryable category execute through the pickup API; invalid or unverified SKUs never spend', async () => {
  const { MARKETS, zoneOffsetHours } = require('../cloudfunctions/gxs_api/lib/markets');
  const { observationDayKey } = require('../cloudfunctions/gxs_api/lib/engine/observation-day');
  assert.equal(observationDayKey('2026-07-15T06:30:00.000Z', 'US'), '2026-07-14');
  assert.equal(observationDayKey('2026-07-15T07:30:00.000Z', 'US'), '2026-07-15');
  assert.equal(observationDayKey('2026-11-23T07:30:00.000Z', 'US'), '2026-11-22');
  assert.equal(observationDayKey('2026-11-23T08:30:00.000Z', 'US'), '2026-11-23');
  assert.equal(observationDayKey('2026-07-15T03:30:00.000Z', 'US', 'R095'), '2026-07-14');
  assert.equal(observationDayKey('2026-07-15T04:30:00.000Z', 'US', 'R095'), '2026-07-15');
  assert.equal(observationDayKey('2026-07-15T09:30:00.000Z', 'US', 'R073'), '2026-07-14');
  assert.equal(observationDayKey('2026-07-15T10:30:00.000Z', 'US', 'R073'), '2026-07-15');
  assert.deepEqual(
    [
      zoneOffsetHours(Date.parse('2026-07-15T12:00:00Z'), 'America/Denver'),
      zoneOffsetHours(Date.parse('2026-11-23T12:00:00Z'), 'America/Denver'),
      zoneOffsetHours(Date.parse('2026-07-15T12:00:00Z'), 'America/Phoenix'),
      zoneOffsetHours(Date.parse('2026-11-23T12:00:00Z'), 'America/Phoenix'),
      zoneOffsetHours(Date.parse('2026-07-15T12:00:00Z'), 'America/Anchorage'),
      zoneOffsetHours(Date.parse('2026-11-23T12:00:00Z'), 'America/Anchorage'),
    ],
    [-6, -7, -7, -7, -8, -9],
  );
  for (const site of MARKETS) {
    const storeNumber = site.stores[0].storeNumber, userKey = userKeyOf();
    const fetchImpl = fakeFetch({ [storeNumber]: {display:'available'} });
    const f = createFixture({ config: {internationalMarkets:enabled,internationalMonitoring:enabled}, fetchImpl });
    ok(await f.call('user.bootstrap'));
    await f.repo.updateUser(userKey,{membership:marketMembership(f.state.now,'member_30d',7*86400000)});
    for (const category of ['iphone','ipad','mac','airpods','homepod']) {
      const p = site.products.find(p=>p.category === category && p.querySupported && p.familyKey !== 'iphone-18-pro');
      const request = {market:site.code,partNumber:p.partNumber,storeNumbers:[storeNumber],queryId:'full-category-'+category,maxCost:0,expectedUserKey:userKey};
      const result = ok(await f.call('market.pickup',request));
      const url = new URL(fetchImpl.calls.at(-1).href);
      if (site.code === 'US') assert.equal(url.pathname, '/shop/retail/pickup-message');
      assert.equal(url.searchParams.get('parts.0'),p.partNumber);
      assert.equal(result.results[0].status,'available');
      assert.equal(result.charged,0);
      f.advance(61000);
    }
    const count = fetchImpl.calls.length;
    for (const partNumber of ['reference/watch-ultra', 'M0000LL/A']) {
      const input={market:site.code,partNumber,storeNumbers:[storeNumber],queryId:'reference-' + partNumber.replace(/[^a-z0-9]/gi, '-'),expectedUserKey:userKey};
      assert.equal((await f.call('market.pickup',input)).error.code,'invalid_market_target');
      assert.equal((await f.call('market.watch',input)).error.code,'unknown_product');
    }
    assert.equal(fetchImpl.calls.length,count);
    assert.equal((await f.repo.listLedger(userKey)).length,0);
  }
});
