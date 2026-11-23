import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userContext, userKeyOf } from './helpers/fixture.mjs';
import { marketMembership } from './helpers/market-membership.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { guardedPickup } = require('../cloudfunctions/gxs_api/lib/engine/guarded-pickup');
const { findMarket } = require('../cloudfunctions/gxs_api/lib/markets');
const { targetKeyOf } = require('../cloudfunctions/gxs_api/lib/engine/events');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { dayKey } = require('../cloudfunctions/gxs_api/lib/time');
const log = { info() {}, warn() {}, error() {} };

test('automatic callers without a watch check cannot reserve capacity or send a request', async () => {
  const upstream = fakeFetch(() => ({ display: 'available' }));
  const f = createFixture({ fetchImpl: upstream, config: { collector: { enabled: true } } });
  const config = await f.repo.getConfig();
  const result = await guardedPickup({ source: 'auto', config, repo: f.repo, fetchImpl: upstream,
    clock: () => f.state.now, storeNumber: 'R577', partNumbers: ['MJYH4CH/A'] });
  assert.equal(result.record.error.message, 'watch_check_unavailable');
  assert.equal(upstream.calls.length, 0);
  assert.equal(f.repo.tables.get(C.config).has('collector_budget_' + dayKey(f.state.now)), false);
});

async function setup(market, mode, response = () => ({ display: 'available' })) {
  const upstream = fakeFetch(response);
  const f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60 }, internationalMonitoring: { TW: true } }, fetchImpl: upstream });
  const owners = [userContext(), userContext('other-member')];
  for (const actor of owners) {
    await f.call('user.bootstrap', {}, actor);
    await f.repo.updateUser(userKeyOf(actor.FROM_OPENID), { membership: marketMembership(f.state.now, 'member_30d') });
  }
  const parts = market === 'CN' ? ['MJYH4CH/A', 'MXXX1CH/A'] : findMarket(market).products.filter(p => p.monitorSupported).slice(0, 2).map(p => p.partNumber);
  const store = market === 'CN' ? 'R577' : 'R694';
  const add = async (partNumber, actor = owners[0]) => {
    const result = await f.call(market === 'CN' ? 'follow.upsert' : 'market.watch', {
      expectedUserKey: userKeyOf(actor.FROM_OPENID), followId: 'demand-' + parts.indexOf(partNumber), market, partNumber, storeNumbers: [store],
    }, actor);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data.follow.followId;
  };
  const change = async (followId, status) => {
    const action = market === 'CN' ? (status === 'paused' ? 'follow.pause' : 'follow.remove') : 'market.watchStatus';
    const result = await f.call(action, { market, expectedUserKey: userKeyOf(), followId, status });
    assert.equal(result.ok, true, JSON.stringify(result.error));
  };
  const collector = createCollector({ repo: f.repo, clock: () => f.state.now, mode, log, fetchImpl: upstream });
  const tick = async () => {
    await collector.lease.renew();
    await Promise.all((market === 'CN' ? collector.scheduler : collector.marketMonitor).tick());
  };
  return { f, parts, store, owners, add, change, collector, upstream, tick };
}

for (const [market, mode] of [['CN','resident'], ['TW','scheduled']]) {
  test(market + ' rechecks each watched SKU after admission and never polls a paused or removed last watch', async () => {
    const { f, parts, store, add, change, collector, upstream, tick } = await setup(market, mode);
    const removed = await add(parts[0]), paused = await add(parts[1]);
    await collector.refreshTargets();
    const admit = f.repo.consumeCollectorBudget.bind(f.repo);
    f.repo.consumeCollectorBudget = async args => {
      f.repo.consumeCollectorBudget = admit;
      await change(removed, 'removed');
      return admit(args);
    };
    await tick();
    assert.deepEqual(upstream.calls.map(c => c.parts), [[parts[1]]]);
    assert.deepEqual(await f.repo.getLatest([targetKeyOf(store, parts[0], market)]), []);
    f.advance(120000);
    await change(paused, 'paused');
    await tick(); // Dispatch the old queue again, without rebuilding its groups.
    assert.equal(upstream.calls.length, 1);
    assert.equal((await f.repo.getLatest([targetKeyOf(store, parts[1], market)]))[0].status, 'available');
  });

  test(market + ' keeps a shared target live if another member replaces its original watcher during admission', async () => {
    const { f, parts, owners, add, change, collector, upstream, tick } = await setup(market, mode);
    const old = await add(parts[0]);
    await collector.refreshTargets();
    const admit = f.repo.consumeCollectorBudget.bind(f.repo);
    f.repo.consumeCollectorBudget = async args => {
      f.repo.consumeCollectorBudget = admit;
      await change(old, 'removed');
      await add(parts[0], owners[1]);
      return admit(args);
    };
    await tick();
    assert.deepEqual(upstream.calls.map(c => c.parts), [[parts[0]]]);
  });

  test(market + ' a cancelled last watch or an unreadable watch consumes neither the final minute slot nor a half-open probe', async () => {
    const { f, parts, add, change, collector, upstream, tick } = await setup(market, mode);
    const old = await add(parts[0]);
    const prefix = market === 'CN' ? '' : 'market_' + market + '_';
    const table = f.repo.tables.get(C.config);
    const breaker = { _id: prefix + 'upstream_breaker', generation: 2, trips: 1, until: f.state.now.getTime() - 1000 };
    table.set(breaker._id, breaker);
    const cfg = await f.repo.getConfig();
    await f.repo.saveConfig({ ...cfg, collector: { ...cfg.collector, maxRequestsPerMinute: 1 },
      internationalQueryLimits: { ...cfg.internationalQueryLimits, maxRequestsPerMinute: 1 } });
    await collector.refreshTargets();
    const budgetId = prefix + 'collector_budget_' + dayKey(f.state.now);
    await change(old, 'removed');
    await tick();
    assert.equal(upstream.calls.length, 0);
    assert.equal(table.has(budgetId), false);
    assert.deepEqual(table.get(breaker._id), breaker);
    await add(parts[0]);
    await collector.refreshTargets();
    const admit = f.repo.consumeCollectorBudget.bind(f.repo);
    f.repo.consumeCollectorBudget = args => admit({ ...args, selectWatchedParts: async () => { throw Error('watch read unavailable'); } });
    f.advance(3000); await tick();
    assert.equal(upstream.calls.length, 0);
    assert.equal(table.has(budgetId), false);
    assert.deepEqual(table.get(breaker._id), breaker);
    f.repo.consumeCollectorBudget = admit;
    f.advance(3000); await tick();
    assert.deepEqual(upstream.calls.map(c => c.parts), [[parts[0]]]);
    assert.equal(table.get(budgetId).autoCount, 1);
    assert.equal(table.get(breaker._id).until, null);
  });
}
