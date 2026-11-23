import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, PRODUCTS, userKeyOf, userContext, fakeFetch } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { buildTasks, skipReason } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { guardedPickup } = require('../cloudfunctions/gxs_api/lib/engine/guarded-pickup');
const { isRetiredMainlandTarget } = require('../cloudfunctions/gxs_api/lib/rules/follow-access');

const evidence = require('../evidence/pickup-samples/2026-11-23/mainland-retirement.json');
function capturedParts(purpose) {
  return evidence.requests.filter(request => request.purpose === purpose)
    .flatMap(request => request.observations.map(row => row.partNumber));
}

const retiredPart = 'MJ2J3CH/A';
const ok = result => { assert.ok(result.ok, result.error?.code); return result.data; };

test('a mainland product retired after debit can only settle its original store list, even if the catalog row is gone', async () => {
  const f = createFixture({ start: '2026-11-23T01:00:00Z' });
  const request = { queryId: 'old-request', partNumber: retiredPart, storeNumbers: ['R577'] };
  const userKey = userKeyOf();
  const id = userKey + '|' + request.queryId;
  ok(await f.call('quota.signin'));
  const begun = await f.repo.beginQuery({
    record: { _id: id, kind: 'live', userKey, ...request }, product: { ...PRODUCTS[0], partNumber: retiredPart },
    nowIso: f.state.now.toISOString(), config: mergeConfig(null), ownerId: 'old-worker',
  });
  assert.equal(begun.record.charged, 1);
  assert.equal(ok(await f.call('query.pickup', request)).reason, 'query_in_progress');
  for (const change of [{ queryId: 'other-request' }, { storeNumbers: ['R578'] }, { storeNumbers: ['R577', 'R577'] }]) {
    assert.equal((await f.call('query.pickup', { ...request, ...change })).error.code, 'product_retired');
  }
  assert.equal((await f.call('query.pickup', request, userContext('other'))).error.code, 'product_retired');
  f.advance(30000);
  const recovered = await Promise.all([f.call('query.pickup', request), f.call('query.pickup', request)]);
  for (const response of recovered.map(ok)) {
    assert.deepEqual([response.reason, response.refunded, response.balance, response.replayed], ['query_expired', 1, 1, true]);
  }
  assert.equal((await f.repo.listLedger(userKey)).filter(row => row.type === 'query_refund').length, 1);
  assert.equal(f.state.fetchImpl.calls.length, 0);
});

test('retired mainland targets cannot spend an upstream reservation or create or send an earlier notification', async () => {
  const f = createFixture();
  const now = f.state.now;
  const config = mergeConfig({ notifications: { enabled: true, templateIds: { restock: 'RESTOCK' } } });
  const target = { storeNumber: 'R577', partNumber: retiredPart };
  assert.equal(isRetiredMainlandTarget(target), true);
  assert.equal(isRetiredMainlandTarget({ ...target, market: 'JP' }), false);
  let reservations = 0;
  f.repo.consumeCollectorBudget = () => { reservations++; throw Error('retired target reached admission'); };
  const run = await guardedPickup({ repo: f.repo, config, clock: () => now, fetchImpl: f.state.fetchImpl,
    storeNumber: target.storeNumber, partNumbers: [retiredPart], source: 'auto' });
  assert.equal(run.record.error.message, 'product_retired');
  assert.equal(reservations, 0);
  assert.equal(f.state.fetchImpl.calls.length, 0);
  const event = { ...target, type: 'restock_confirmed', detectedAt: now.toISOString() };
  const follow = { userKey: userKeyOf(), partNumber: retiredPart, storeNumbers: [target.storeNumber], status: 'active' };
  assert.deepEqual(buildTasks({ events: [event], follows: [follow], users: new Map(), config, now }), []);
  assert.equal(skipReason({ task: { ...event, eventType: event.type }, follow, config, now }), 'product_retired');
});

test('an existing missing or unsupported retail follow cannot be resumed but can still be removed', async () => {
  for (const products of [[], [{ ...PRODUCTS[0], supported: false, monitorSupported: false }]]) {
    const f = createFixture({ products });
    const userKey = userKeyOf(), followId = 'legacy-retail';
    ok(await f.call('user.bootstrap'));
    await f.repo.updateUser(userKey, { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
    await f.repo.saveFollow({ _id: userKey + '|' + followId, userKey, partNumber: PRODUCTS[0].partNumber,
      storeNumbers: ['R577'], status: 'paused', createdAt: f.state.now.toISOString() });
    assert.equal((await f.call('follow.resume', { followId })).error.code, 'unsupported_product');
    assert.equal(ok(await f.call('follow.remove', { followId })).removed, true);
    assert.equal(f.state.fetchImpl.calls.length, 0);
  }
});

test('five original HomePod mini finishes stop before a stale seed or saved watch reaches Apple; mini 2 keeps monitoring', async () => {
  const withdrawn = capturedParts('retired_homepod_individual');
  assert.equal(new Set(withdrawn).size, 5);
  const active = 'MGHK4CH/A';
  const products = [...withdrawn, active].map(partNumber => ({ ...PRODUCTS[0], _id: partNumber, partNumber }));
  const f = createFixture({ products, config: { collector: { enabled: true } }, fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
  const userKey = userKeyOf();
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKey, { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
  for (const partNumber of withdrawn) {
    const payload = { partNumber, storeNumbers: ['R577'] };
    assert.equal((await f.call('query.pickup', { ...payload, queryId: 'new-pickup' })).error.code, 'product_retired');
    assert.equal((await f.call('follow.upsert', { ...payload, followId: 'new-watch' })).error.code, 'product_retired');
  }
  const saved = { _id: userKey + '|old-watch', userKey, partNumber: retiredPart, storeNumbers: ['R577'], status: 'active',
    createdAt: f.state.now.toISOString(), updatedAt: f.state.now.toISOString() };
  await f.repo.saveFollow(saved);
  await f.repo.saveLatest({ _id: 'R577|' + retiredPart, partNumber: retiredPart, storeNumber: 'R577', status: 'available',
    observedAt: f.state.now.toISOString() });
  const row = ok(await f.call('follow.list')).follows[0];
  assert.equal(row.statusReason, 'product_retired');
  assert.equal(row.stores[0].status, null);
  assert.equal((await f.call('follow.resume', { followId: 'old-watch' })).error.code, 'product_retired');

  ok(await f.call('follow.upsert', { followId: 'new-watch', partNumber: active, storeNumbers: ['R577'] }));
  const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
  const worker = createCollector({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => f.state.now,
    log: { info() {}, warn() {}, error() {} } });
  const tick = await worker.step();
  await Promise.all(tick.started);
  assert.deepEqual(f.state.fetchImpl.calls.map(call => call.parts), [[active]]);
  assert.equal(ok(await f.call('follow.remove', { followId: 'old-watch' })).removed, true);
});

test('withdrawn mainland MacBook Pro part numbers cannot reactivate even when an earlier catalog still lists them', async () => {
  const withdrawn = capturedParts('retired_mac_individual');
  const current = capturedParts('new_macbook_pro');
  assert.equal(new Set(withdrawn).size, 13);
  assert.equal(new Set(current).size, 4);
  const f = createFixture({ products: [...withdrawn, ...current].map(partNumber => ({ ...PRODUCTS[0], _id: partNumber, partNumber })) });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
  for (const partNumber of withdrawn) {
    const request = { partNumber, storeNumbers: ['R577'] };
    assert.equal((await f.call('query.pickup', { ...request, queryId: 'retired-mac-query' })).error.code, 'product_retired');
    assert.equal((await f.call('follow.upsert', { ...request, followId: 'retired-mac-watch' })).error.code, 'product_retired');
  }
  assert.equal(f.state.fetchImpl.calls.length, 0);
  for (const partNumber of current) assert.equal(isRetiredMainlandTarget({ partNumber }), false);
});
