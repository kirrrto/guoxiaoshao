import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, operatorContext } from './helpers/fixture.mjs';

test('invalid runtime values cannot corrupt quota, collector limits or notification mappings', async () => {
  const f = createFixture();
  for (const patch of [
    { quota: { queryCost: -1 } }, { quota: { balanceCap: '10' } },
    { collector: { intervalSeconds: 0 } }, { collector: { maxConcurrency: 999 } },
    { notifications: { enabled: true } },
    { notifications: { templateFields: { product: 'time1' } } },
    { notifications: { templateFields: { product: 'thing2' } } },
    { query: { maxStores: 999 } }, { tasks: [{ id: 'x', title: '任务', reward: -1 }] },
    { newProductWindows: [{ familyKey: 'x', releaseAt: 'invalid' }] },
    { adminUserKeys: ['anybody'] }, { announcement: {} },
  ]) {
    const result = await f.call('admin.updateConfig', { patch }, operatorContext());
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(await f.repo.getConfig(), null, 'invalid changes never persist');
  }
});

test('partial configuration patches preserve previously configured siblings', async () => {
  const f = createFixture({ config: { quota: { queryCost: 2, balanceCap: 12 }, collector: { intervalSeconds: 10 }, notifications: { templateFields: { product: 'thing5' } } } });
  const result = await f.call('admin.updateConfig', { patch: { quota: { balanceCap: 20 }, collector: { maxConcurrency: 1 }, notifications: { templateFields: { time: 'time6' } } } }, operatorContext());
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data.config.quota.queryCost, 2);
  assert.equal(result.data.config.quota.balanceCap, 20);
  assert.equal(result.data.config.collector.intervalSeconds, 10);
  assert.equal(result.data.config.collector.maxConcurrency, 1);
  assert.equal(result.data.config.notifications.templateFields.product, 'thing5');
  assert.equal(result.data.config.notifications.templateFields.time, 'time6');
});

test('concurrent unrelated config patches cannot reopen redemption or erase each other', async () => {
  for (const disableFirst of [true, false]) {
    const f = createFixture({ config: { memberRedemption: { enabled: true } } });
    const staleRouterConfig = await f.repo.getConfig();
    // Both requests authenticated from the old configuration. A later patch
    // must merge against the transaction's runtime, never this earlier read.
    const getConfig = f.repo.getConfig;
    f.repo.getConfig = async () => structuredClone(staleRouterConfig);
    const disable = () => f.call('admin.updateConfig', { patch: { memberRedemption: { enabled: false }, collector: { intervalSeconds: 12 } } }, operatorContext());
    const announce = () => f.call('admin.updateConfig', { patch: { announcement: '更新公告', collector: { maxConcurrency: 3 } } }, operatorContext());
    const results = await Promise.all(disableFirst ? [disable(), announce()] : [announce(), disable()]);
    assert.ok(results.every(r => r.ok), JSON.stringify(results));
    f.repo.getConfig = getConfig;
    const config = await f.repo.getConfig();
    assert.equal(config.memberRedemption.enabled, false);
    assert.equal(config.announcement, '更新公告');
    assert.deepEqual(config.collector, { intervalSeconds: 12, maxConcurrency: 3 });
    assert.equal((await f.call('member.redeemCode', { code: 'hbw666' })).error.code, 'redemption_disabled');
  }
});

test('invalid or failed atomic config patches leave the complete runtime unchanged', async () => {
  const f = createFixture({ config: { memberRedemption: { enabled: false }, announcement: '保留公告' } });
  const before = await f.repo.getConfig();
  for (const patch of [null, [], { forbidden: true }, { collector: { intervalSeconds: 0 } }]) {
    assert.equal((await f.call('admin.updateConfig', { patch }, operatorContext())).ok, false);
    assert.deepEqual(await f.repo.getConfig(), before);
  }
  f.repo.transactionWriteHook = async (_table, doc) => { if (doc._id === 'runtime') throw new Error('config unavailable'); };
  assert.equal((await f.call('admin.updateConfig', { patch: { announcement: '不可落盘' } }, operatorContext())).error.code, 'internal_error');
  f.repo.transactionWriteHook = null;
  assert.deepEqual(await f.repo.getConfig(), before);
});

test('deferred payment cannot be enabled by a runtime flag or a direct client order call', async () => {
  const f = createFixture({ config: { memberProduct: { enabled: true } } });
  const status = await f.call('member.status');
  assert.equal(status.data.product.paymentReady, false);
  assert.equal(status.data.product.enabled, false);
  const result = await f.call('member.createOrder', { orderId: 'order-000001', priceFen: 1, days: 9999 });
  assert.equal(result.data.ok, false);
  assert.equal(result.data.reason, 'payment_not_enabled');
  const after = await f.call('member.status');
  assert.equal(after.data.membership.active, false);
  assert.equal(after.data.orders.length, 0);
  const configure = await f.call('admin.updateConfig', { patch: { memberProduct: { enabled: true } } }, operatorContext());
  assert.equal(configure.error.code, 'payment_deferred');
});
