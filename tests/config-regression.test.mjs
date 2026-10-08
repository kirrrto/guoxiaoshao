import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFixture, operatorContext } from './helpers/fixture.mjs';

test('invalid runtime values cannot corrupt quota, collector limits or notification mappings', async () => {
  const f = createFixture();
  const before = await f.repo.getConfig();
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
    assert.deepEqual(await f.repo.getConfig(), before, 'invalid changes never persist');
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
    assert.deepEqual(config.collector, { ...staleRouterConfig.collector, intervalSeconds: 12, maxConcurrency: 3 });
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

test('the runtime payment flag cannot enable checkout without server credentials and valid fixed product terms', async () => {
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
  assert.equal(configure.ok, true);
  assert.equal((await f.call('member.status')).data.product.paymentReady, false);
  for (const patch of [
    { memberProduct: { enabled: true, priceFen: 1 } },
    { memberProduct: { enabled: true, days: 9999 } },
    { memberProduct: { enabled: true, id: 'wrong-product' } },
    { memberProduct: { note: '' } },
    { memberProduct: { note: 'x'.repeat(201) } },
    { virtualPayment: { offerId: 1450655203 } },
    { virtualPayment: { appKey: 'must-not-store-secrets-in-runtime' } },
  ]) {
    assert.equal((await f.call('admin.updateConfig', { patch }, operatorContext())).error.code, 'invalid_config');
  }
});

test('additional member plan mappings are explicit, validated, mergeable and safely audited', async () => {
  const f = createFixture();
  const update = patch => f.call('admin.updateConfig', { patch }, operatorContext());
  const configure = await update({ memberPlans: { member_30d: { productId: 'test-private-month-goods', enabled: false } } });
  assert.equal(configure.ok, true);
  const enabled = await update({ memberPlans: { member_30d: { enabled: true } } });
  assert.equal(enabled.ok, true);
  assert.deepEqual(enabled.data.config.memberPlans.member_30d, { productId: 'test-private-month-goods', enabled: true });
  assert.deepEqual(enabled.data.config.memberPlans.member_365d, { productId: 'vip888', enabled: true }, 'year plan ships enabled and is untouched by a month-only patch');
  const before = await f.repo.getConfig();
  for (const memberPlans of [
    { unknown: { productId: 'test-unknown', enabled: true } },
    { member_365d: { productId: '', enabled: true } },
    { member_365d: { productId: 'vip666', enabled: true } },
    { member_365d: { productId: 'test-private-month-goods', enabled: true } },
    { member_30d: { days: 365 } }, { member_30d: { priceFen: 1 } },
    { member_30d: { productId: 'bad goods id' } }, { member_30d: null },
    { member_30d: { enabled: 'true' } }, [],
  ]) {
    const response = await update({ memberPlans });
    assert.equal(response.error.code, 'invalid_config', JSON.stringify(memberPlans));
    assert.deepEqual(await f.repo.getConfig(), before);
  }
  const auditRows = [...f.repo.tables.values()].flatMap(table => [...table.values()]).filter(row => row.kind === 'runtime_config_audit');
  assert.equal(auditRows.length, 2);
  assert.deepEqual(auditRows[0].changedKeys, ['memberPlans']);
  assert.doesNotMatch(JSON.stringify(auditRows), /test-private-month-goods/);
});

test('published membership mapping patch enables only month and year and preserves existing payment controls', async () => {
  const patch = JSON.parse(fs.readFileSync(new URL('../config/member-plans.runtime-patch.json', import.meta.url), 'utf8'));
  assert.deepEqual(patch, { memberPlans: {
    member_30d: { productId: 'vip777', enabled: true }, member_365d: { productId: 'vip888', enabled: true },
  } });
  for (const weekEnabled of [false, true]) {
    const f = createFixture({ config: { memberProduct: { enabled: weekEnabled }, virtualPayment: { iosEnabled: false },
      memberPlans: { member_30d: { productId: '', enabled: false }, member_365d: { productId: '', enabled: false } }, announcement: '保留原配置' } });
    const before = (await f.call('admin.getConfig', {}, operatorContext())).data;
    const result = await f.call('admin.updateConfig', { patch, expectedRevision: before.revision }, operatorContext());
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.config.memberPlans, patch.memberPlans);
    assert.deepEqual(result.data.config.memberProduct, before.config.memberProduct);
    assert.deepEqual(result.data.config.virtualPayment, before.config.virtualPayment);
    assert.deepEqual(result.data.config.notifications, before.config.notifications);
    assert.equal(result.data.config.announcement, '保留原配置');
    const boot = (await f.call('user.bootstrap')).data;
    assert.equal(boot.memberProducts.every(product => product.paymentReady === false), true, 'enabled plans still require real server credentials');
  }
});
