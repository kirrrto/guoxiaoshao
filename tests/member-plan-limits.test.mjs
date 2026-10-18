import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, PRODUCTS, STORES, fakeFetch } from './helpers/fixture.mjs';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';
import { alternativesFixture, tablesSnapshot, BASE, SILVER, BLACK, QUERY_ID } from './helpers/query-alternatives-fixture.mjs';

const require = createRequire(import.meta.url);
const { membershipSnapshot } = require('../cloudfunctions/gxs_api/lib/rules/membership');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { buildTasks, sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { loadFollowUsers } = require('../cloudfunctions/gxs_api/lib/rules/follow-access');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const DAY = 86400000;
const FIVE_STORES = [...STORES, { _id: 'R765', storeNumber: 'R765', name: '万象城', city: '合肥', province: '安徽' }];
const SIX_STORES = [...FIVE_STORES, { _id: 'R580', storeNumber: 'R580', name: '测试门店', city: '上海', province: '上海' }];
const fiveNumbers = FIVE_STORES.map(store => store.storeNumber);
const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response.data; };
const now = f => f.state.now.toISOString();
const plans = { member_7d: [7, 700], member_30d: [30, 1990], member_365d: [365, 20000] };
const fixture = async (config, stores = STORES) => {
  const f = createFixture({ config: { collector: { enabled: true }, notifications: { enabled: true, templateIds: { restock: 'TPL' } }, ...config },
    products: PRODUCTS.map(product => ({ ...product, supported: true })), stores });
  ok(await f.call('user.bootstrap'));
  return f;
};
async function purchase(f, id, planId) {
  const user = await f.repo.getUser(userKeyOf()), [days, amountFen] = plans[planId];
  const order = { _id: id, orderId: id, userKey: user._id, appid: user.appid, openid: user.openid, provider: 'wechat_virtual_payment',
    type: 'membership_order', productId: `test_${planId}`, planId, days, amountFen, status: 'paid', paidAt: now(f), createdAt: now(f),
    paymentSnapshot: { version: 2, provider: 'wechat_virtual_payment', appid: user.appid, planId, productId: `test_${planId}`, days, priceFen: amountFen,
      currency: 'CNY', env: 0, buyQuantity: 1 } };
  await f.repo.createOrderIfAbsent(order);
  await f.repo.fulfilMembershipOrder({ orderId: id, source: 'virtual_payment', nowIso: now(f) });
  return order;
}
const boot = async f => ok(await f.call('user.bootstrap'));
const follow = (f, index, stores = STORES.map(store => store.storeNumber)) => f.call('follow.upsert', {
  followId: `follow-${index}`, partNumber: PRODUCTS[index].partNumber, storeNumbers: stores });
const refund = (f, order, amount = order.amountFen) => f.repo.markOrderRefunded({ orderId: order._id, nowIso: now(f), refundFen: amount });
const snapshot = async f => membershipSnapshot(await f.repo.getUser(userKeyOf()), f.state.now);

test('paid annual exposes 5×5, monthly 4×4 while weekly, gifts and expiry-only membership stay 3×3', async () => {
  for (const planId of Object.keys(plans)) {
    const f = await fixture(); await purchase(f, `plan-${planId}`, planId);
    const expected = planId === 'member_365d' ? 5 : planId === 'member_7d' ? 3 : 4;
    const configurations = planId === 'member_365d' ? 5 : expected;
    const b = await boot(f), listing = ok(await f.call('follow.list'));
    assert.equal(b.membership.planId, planId);
    assert.equal(b.limits.maxFollows, configurations); assert.equal(b.limits.maxStoresPerFollow, expected);
    assert.equal(b.limits.queryMaxStores, expected); assert.equal(b.limits.alternativeMaxColors, Math.min(4, expected));
    assert.equal(listing.limits.maxFollows, configurations);
    assert.deepEqual(b.memberProducts.map(p => [p.limits.maxFollows, p.limits.maxStoresPerFollow]), [[3, 3], [4, 4], [5, 5]]);
    const result = await follow(f, 0);
    assert.equal(result.ok, expected >= 4);
    if (expected === 3) assert.equal(result.error.code, 'too_many_stores');
  }
  for (const source of ['legacy', 'redemption_code', 'admin_grant']) {
    const f = await fixture();
    await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: new Date(f.state.now.getTime() + 365 * DAY).toISOString(), source } });
    assert.equal((await boot(f)).limits.maxFollows, 3);
  }
});

test('existing annual receipts gain five configurations and stores on read without changing price, expiry, quota or order', async () => {
  const f = await fixture(); const order = await purchase(f, 'existing-year', 'member_365d');
  const original = await f.repo.getUser(userKeyOf());
  const receipt = await f.repo.getOrder(order._id);
  const current = await boot(f);
  assert.equal(current.limits.maxFollows, 5); assert.equal(current.limits.maxStoresPerFollow, 5);
  assert.equal(current.membership.annualExpiresAt, original.membership.expiresAt);
  const after = await f.repo.getUser(userKeyOf());
  assert.deepEqual(after.membership, original.membership);
  assert.deepEqual(after.quota, original.quota);
  assert.deepEqual(await f.repo.getOrder(order._id), receipt);
});

test('annual fifth configuration and fifth store participate in monitoring and actual notification sending', async () => {
  const f = await fixture(undefined, SIX_STORES); await purchase(f, 'annual-fifth', 'member_365d');
  const extraPart = 'M6666CH/A';
  await f.repo.replaceCatalog({ products: [{ ...PRODUCTS[0], _id: extraPart, partNumber: extraPart }], stores: [], meta: { version: 'six-configs' } });
  for (let i = 0; i < 4; i++) ok(await follow(f, i, fiveNumbers));
  const fifth = () => follow(f, 4, fiveNumbers);
  const sixth = () => f.call('follow.upsert', { followId: 'follow-sixth', partNumber: extraPart, storeNumbers: fiveNumbers });
  const results = await Promise.all([fifth(), sixth()]);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.equal(results.find(row => !row.ok).error.code, 'too_many_follows');
  const saved = await f.repo.listFollows(userKeyOf());
  assert.equal(saved.length, 5);
  const collector = createCollector({ repo: f.repo, clock: () => f.state.now, fetchImpl: f.state.fetchImpl, log: { info() {}, warn() {}, error() {} } });
  await collector.refreshTargets();
  assert.equal(collector.scheduler.snapshot().targets.reduce((count, target) => count + target.partNumbers.length, 0), 25);
  await f.repo.updateUser(userKeyOf(), { subscriptions: { TPL: { credits: 10 } } });
  const follows = await f.repo.listActiveFollows(), users = await loadFollowUsers(f.repo, follows, f.state.now);
  const events = [{ _id: 'annual-fifth-event', type: 'restock_confirmed', detectedAt: now(f), storeNumber: FIVE_STORES[4].storeNumber, partNumber: saved[4].partNumber }];
  const tasks = buildTasks({ events, follows, users, config: mergeConfig(await f.repo.getConfig()), now: f.state.now });
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'pending');
  const task = tasks[0]; await f.repo.saveNotification(task); await seedNotificationObservation(f.repo, task);
  let sends = 0;
  const sent = await sendTask({ task, repo: f.repo, config: mergeConfig(await f.repo.getConfig()), sendImpl: async () => { sends++; return { errcode: 0 }; },
    now: f.state.now, clock: () => f.state.now, ownerId: 'annual-fifth-test' });
  assert.equal(sends, 1); assert.equal(sent.status, 'accepted');
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 9);
});

test('annual expiry and refund stop fifth configuration and store while preserving monthly rights and all saved targets', async () => {
  for (const mode of ['expire', 'refund']) {
    const f = await fixture(undefined, FIVE_STORES); const year = await purchase(f, `annual-${mode}`, 'member_365d');
    await purchase(f, `monthly-after-${mode}`, 'member_30d');
    for (let i = 0; i < 5; i++) ok(await follow(f, i, fiveNumbers));
    const full = await snapshot(f);
    assert.equal(full.limits.maxFollows, 5);
    assert.equal(full.annualExpiresAt, new Date(f.state.now.getTime() + 365 * DAY).toISOString());
    assert.equal(full.enhancedExpiresAt, new Date(f.state.now.getTime() + 395 * DAY).toISOString());
    if (mode === 'expire') f.advance(365 * DAY); else await refund(f, year);
    const downgraded = await snapshot(f);
    assert.equal(downgraded.planId, 'member_30d'); assert.equal(downgraded.limits.maxFollows, 4);
    assert.equal(downgraded.limits.maxStoresPerFollow, 4); assert.equal(downgraded.annualExpiresAt, null);
    const listed = ok(await f.call('follow.list'));
    assert.equal(listed.follows.length, 5);
    assert.deepEqual(listed.follows.map(row => row.limitPaused), [false, false, false, false, true]);
    assert.deepEqual(listed.follows[0].stores.map(row => row.limitPaused), [false, false, false, false, true]);
    const saved = await f.repo.listFollows(userKeyOf());
    assert.ok(saved.every(row => row.storeNumbers.length === 5));
    assert.equal((await f.call('follow.resume', { followId: saved[4]._id })).error.code, 'plan_limit');
    const collector = createCollector({ repo: f.repo, clock: () => f.state.now, fetchImpl: f.state.fetchImpl, log: { info() {}, warn() {}, error() {} } });
    await collector.refreshTargets();
    assert.equal(collector.scheduler.snapshot().targets.reduce((count, target) => count + target.partNumbers.length, 0), 16);
    const follows = await f.repo.listActiveFollows(), users = await loadFollowUsers(f.repo, follows, f.state.now);
    const events = [{ _id: 'annual-store-five', partNumber: PRODUCTS[0].partNumber, storeNumber: FIVE_STORES[4].storeNumber },
      { _id: 'annual-config-five', partNumber: PRODUCTS[4].partNumber, storeNumber: STORES[0].storeNumber }]
      .map(event => ({ ...event, type: 'restock_confirmed', detectedAt: now(f) }));
    assert.deepEqual(buildTasks({ events, follows, users, config: mergeConfig(await f.repo.getConfig()), now: f.state.now }).map(task => task.reason), ['plan_limit', 'plan_limit']);
    await purchase(f, `annual-restored-${mode}`, 'member_365d'); await collector.refreshTargets();
    assert.equal(collector.scheduler.snapshot().targets.reduce((count, target) => count + target.partNumbers.length, 0), 25);
  }
});

test('legacy paid segment migration uses hidden confirmed orders and never changes days or unrelated account data', async () => {
  const f = await fixture(); const order = await purchase(f, 'old-month', 'member_30d');
  let user = await f.repo.getUser(userKeyOf());
  delete user.membership.entitlements.planMetadataVersion;
  delete user.membership.entitlements.segments[0].planId;
  await f.repo.updateUser(user._id, { membership: user.membership });
  await f.repo.updateOrder(order._id, { userHiddenAt: now(f) });
  const expiry = user.membership.expiresAt, oldQuota = user.quota;
  const first = await boot(f), second = await boot(f);
  assert.equal(first.limits.maxFollows, 4); assert.equal(second.limits.maxFollows, 4);
  user = await f.repo.getUser(user._id);
  assert.equal(user.membership.expiresAt, expiry); assert.deepEqual(user.quota, oldQuota);
  assert.equal(user.membership.entitlements.segments[0].remainingMs, 30 * DAY);
  assert.equal(user.membership.entitlements.segments[0].planId, 'member_30d');
});

test('cross-account, unconfirmed, mismatched and missing order evidence cannot upgrade legacy segments', async () => {
  for (const patch of [{ userKey: 'other-account' }, { status: 'created', fulfilledAt: null, entitlementFulfilled: false },
    { amountFen: 1 }, { planId: 'member_365d' }, { provider: 'admin_grant' }]) {
    const f = await fixture(); const order = await purchase(f, 'untrusted-month', 'member_30d');
    const user = await f.repo.getUser(userKeyOf());
    delete user.membership.entitlements.planMetadataVersion;
    delete user.membership.entitlements.segments[0].planId;
    await f.repo.updateUser(user._id, { membership: user.membership }); await f.repo.updateOrder(order._id, patch);
    assert.equal((await boot(f)).limits.maxFollows, 3, JSON.stringify(patch));
  }
  const missing = await fixture();
  await missing.repo.updateUser(userKeyOf(), { membership: { expiresAt: new Date(missing.state.now.getTime() + 30 * DAY).toISOString(),
    entitlements: { version: 1, settledAt: now(missing), segments: [{ orderId: 'absent-order', source: 'virtual_payment', remainingMs: 30 * DAY }] } } });
  assert.equal((await boot(missing)).limits.maxFollows, 3);
});

test('mixed renewals upgrade immediately and only the unconsumed monthly/yearly segments keep the extra slots', async () => {
  const f = await fixture(); await purchase(f, 'month-first', 'member_30d'); await purchase(f, 'week-next', 'member_7d');
  assert.equal((await snapshot(f)).enhanced, true);
  f.advance(30 * DAY);
  const weekOnly = await snapshot(f);
  assert.equal(weekOnly.active, true); assert.equal(weekOnly.enhanced, false); assert.equal(weekOnly.limits.maxFollows, 3);
  const year = await purchase(f, 'year-later', 'member_365d');
  assert.equal((await snapshot(f)).enhanced, true, 'upgrade applies before the old weekly balance is consumed');
  await refund(f, year, 10000); assert.equal((await snapshot(f)).enhanced, true);
  await refund(f, year); const afterRefund = await snapshot(f);
  assert.equal(afterRefund.enhanced, false); assert.equal(afterRefund.remainingMs, 7 * DAY);
  await refund(f, year); assert.deepEqual(await snapshot(f), afterRefund);
});

test('concurrent new follows cannot exceed four and downgrade keeps data while enforcing stable slot ownership', async () => {
  const f = await fixture(); const monthly = await purchase(f, 'month-slots', 'member_30d'); await purchase(f, 'week-slots', 'member_7d');
  for (let i = 0; i < 3; i++) ok(await follow(f, i));
  const results = await Promise.all([follow(f, 3), follow(f, 4)]);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.equal(results.find(row => !row.ok).error.code, 'too_many_follows');
  const before = await f.repo.listFollows(userKeyOf());
  // Editing the first slot changes followIndex insertion order, not its ownership.
  ok(await follow(f, 0));
  await refund(f, monthly);
  let listed = ok(await f.call('follow.list'));
  assert.equal(listed.follows.length, 4);
  assert.equal(listed.follows[0].limitPaused, false);
  assert.equal(listed.follows[3].limitPaused, true);
  assert.equal(listed.follows[0].stores.length, 4);
  assert.deepEqual(listed.follows[0].stores.map(store => store.limitPaused), [false, false, false, true]);
  const blocked = await f.call('follow.resume', { followId: before[3]._id });
  assert.equal(blocked.error.code, 'plan_limit');
  ok(await follow(f, 0, STORES.slice(0, 3).map(s => s.storeNumber)));
  await purchase(f, 'month-restored', 'member_30d');
  listed = ok(await f.call('follow.list'));
  assert.equal(listed.follows[3].limitPaused, false);
  assert.equal(listed.follows[3].eligibleStoreNumbers.length, 4);
});

test('collector and planning exclude downgraded fourth configuration and store without deleting saved targets', async () => {
  const f = await fixture(); const monthly = await purchase(f, 'month-monitor', 'member_30d'); await purchase(f, 'week-monitor', 'member_7d');
  for (let i = 0; i < 4; i++) ok(await follow(f, i));
  await f.repo.updateUser(userKeyOf(), { subscriptions: { TPL: { credits: 10 } } });
  const collector = createCollector({ repo: f.repo, clock: () => f.state.now, fetchImpl: f.state.fetchImpl, log: { info() {}, warn() {}, error() {} } });
  await collector.refreshTargets();
  assert.equal(collector.scheduler.snapshot().targets.reduce((n, t) => n + t.partNumbers.length, 0), 16);
  await refund(f, monthly);
  await collector.refreshTargets();
  assert.equal(collector.scheduler.snapshot().targets.reduce((n, t) => n + t.partNumbers.length, 0), 9);
  const follows = await f.repo.listActiveFollows(), users = await loadFollowUsers(f.repo, follows);
  const events = [{ _id: 'event-store-four', storeNumber: STORES[3].storeNumber, partNumber: PRODUCTS[0].partNumber },
    { _id: 'event-config-four', storeNumber: STORES[0].storeNumber, partNumber: PRODUCTS[3].partNumber }]
    .map(e => ({ ...e, type: 'restock_confirmed', detectedAt: now(f) }));
  const tasks = buildTasks({ events, follows, users, config: mergeConfig(await f.repo.getConfig()), now: f.state.now });
  assert.deepEqual(tasks.map(task => task.reason), ['plan_limit', 'plan_limit']);
  assert.equal((await f.repo.listFollows(userKeyOf())).length, 4);
});

test('a refund after subscription reservation prevents sending the fourth-store alert and returns the credit', async () => {
  const f = await fixture(); const monthly = await purchase(f, 'month-send', 'member_30d'); await purchase(f, 'week-send', 'member_7d');
  ok(await follow(f, 0)); await f.repo.updateUser(userKeyOf(), { subscriptions: { TPL: { credits: 2 } } });
  const [saved] = await f.repo.listFollows(userKeyOf());
  const task = { _id: 'fourth-store-send', userKey: userKeyOf(), followId: saved._id, eventId: 'confirmed-fourth-store', eventType: 'restock_confirmed',
    partNumber: saved.partNumber, storeNumber: STORES[3].storeNumber, templateId: 'TPL', status: 'pending', attempts: 0, createdAt: now(f), detectedAt: now(f) };
  await f.repo.saveNotification(task); await seedNotificationObservation(f.repo, task);
  const reserve = f.repo.reserveSubscriptionCredit;
  f.repo.reserveSubscriptionCredit = async args => { const result = await reserve(args); await refund(f, monthly); return result; };
  let sent = 0;
  const result = await sendTask({ task, repo: f.repo, config: mergeConfig(await f.repo.getConfig()), sendImpl: async () => { sent++; return { errcode: 0 }; },
    now: f.state.now, clock: () => f.state.now, ownerId: 'plan-test' });
  assert.equal(sent, 0); assert.equal(result.reason, 'plan_limit');
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
});

test('four-store queries use server-owned membership limits and respect a tighter operational cap', async () => {
  for (const maxStores of [2, 3]) {
    const f = await fixture({ query: { maxStores } }); await purchase(f, `month-query-${maxStores}`, 'member_30d');
    const result = await f.call('query.pickup', { queryId: `four-stores-${maxStores}`, partNumber: PRODUCTS[0].partNumber,
      storeNumbers: STORES.map(s => s.storeNumber), maxStores: 999, planId: 'member_365d' });
    assert.equal(result.ok, maxStores === 3);
    if (maxStores === 2) { assert.equal(result.error.code, 'too_many_stores'); assert.equal(f.state.fetchImpl.calls.length, 0); }
    else assert.equal(ok(result).results.length, 4);
  }
});

test('annual accepts five stores but rejects six while monthly and weekly cannot forge the annual allowance', async () => {
  for (const [planId, limit] of [['member_7d', 3], ['member_30d', 4], ['member_365d', 5]]) {
    const f = await fixture(undefined, SIX_STORES); await purchase(f, `store-cap-${planId}`, planId);
    ok(await follow(f, 0, SIX_STORES.slice(0, limit).map(store => store.storeNumber)));
    const excessive = await f.call('follow.upsert', { followId: 'over-store-cap', partNumber: PRODUCTS[1].partNumber,
      storeNumbers: SIX_STORES.slice(0, limit + 1).map(store => store.storeNumber), planId: 'member_365d', maxStoresPerFollow: 99 });
    assert.equal(excessive.ok, false); assert.equal(excessive.error.code, 'too_many_stores');
    assert.equal((await f.repo.listFollows(userKeyOf())).length, 1);
  }
});

test('annual five-store queries work without changing the operational cap or alternative-color allowance', async () => {
  for (const [planId, operationalCap, allowed] of [['member_365d', 3, true], ['member_365d', 2, false], ['member_30d', 3, false], ['member_7d', 3, false]]) {
    const f = await fixture({ query: { maxStores: operationalCap } }, FIVE_STORES); await purchase(f, `query-${planId}-${operationalCap}`, planId);
    f.state.fetchImpl = fakeFetch(() => ({ display: 'available' }));
    const response = await f.call('query.pickup', { queryId: `annual-five-${planId}-${operationalCap}`, partNumber: PRODUCTS[0].partNumber,
      storeNumbers: fiveNumbers, maxStores: 999, planId: 'member_365d' });
    assert.equal(response.ok, allowed);
    if (allowed) {
      assert.equal(response.data.results.length, 5); assert.equal(f.state.fetchImpl.calls.length, 5);
      assert.equal((await boot(f)).limits.alternativeMaxColors, 4);
    } else { assert.equal(response.error.code, 'too_many_stores'); assert.equal(f.state.fetchImpl.calls.length, 0); }
  }
});

test('annual refund between validation and save cannot persist a fifth store under monthly rights', async () => {
  const f = await fixture(undefined, FIVE_STORES); const annual = await purchase(f, 'annual-save-race', 'member_365d');
  await purchase(f, 'monthly-save-race', 'member_30d');
  const mutate = f.repo.mutateFollow;
  f.repo.mutateFollow = async args => { await refund(f, annual); return mutate(args); };
  const result = await follow(f, 0, fiveNumbers);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'too_many_stores');
  assert.deepEqual(await f.repo.listFollows(userKeyOf()), []);
});

test('annual refund after reserving a fifth-store notification blocks sending and returns its authorization', async () => {
  const f = await fixture(undefined, FIVE_STORES); const annual = await purchase(f, 'annual-send-race', 'member_365d');
  await purchase(f, 'monthly-send-race', 'member_30d'); ok(await follow(f, 0, fiveNumbers));
  await f.repo.updateUser(userKeyOf(), { subscriptions: { TPL: { credits: 2 } } });
  const [saved] = await f.repo.listFollows(userKeyOf());
  const task = { _id: 'fifth-store-send', userKey: userKeyOf(), followId: saved._id, eventId: 'confirmed-fifth-store', eventType: 'restock_confirmed',
    partNumber: saved.partNumber, storeNumber: FIVE_STORES[4].storeNumber, templateId: 'TPL', status: 'pending', attempts: 0, createdAt: now(f), detectedAt: now(f) };
  await f.repo.saveNotification(task); await seedNotificationObservation(f.repo, task);
  const reserve = f.repo.reserveSubscriptionCredit;
  f.repo.reserveSubscriptionCredit = async args => { const result = await reserve(args); await refund(f, annual); return result; };
  let sent = 0;
  const result = await sendTask({ task, repo: f.repo, config: mergeConfig(await f.repo.getConfig()), sendImpl: async () => { sent++; return { errcode: 0 }; },
    now: f.state.now, clock: () => f.state.now, ownerId: 'annual-plan-test' });
  assert.equal(sent, 0); assert.equal(result.reason, 'plan_limit');
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
});

test('monthly alternatives accept four colors and stores through read-only evidence, weekly callers cannot forge that scope', async () => {
  const f = await alternativesFixture({ query: false }); await purchase(f, 'month-alternatives', 'member_30d');
  const base = await f.repo.getProduct(BASE), fourth = 'MXXX9CH/A';
  await f.repo.replaceCatalog({ products: [{ ...base, _id: fourth, partNumber: fourth, attributes: { ...base.attributes, color: '蓝色' } }], stores: [], meta: { version: 'four-colors' } });
  ok(await f.call('query.pickup', { queryId: QUERY_ID, partNumber: BASE, storeNumbers: ['R577'] }));
  const parts = [BASE, SILVER, BLACK, fourth], stores = ['R578', 'R579', 'R580', 'R581'];
  for (const part of parts) for (const store of stores) await f.observe(part, store);
  const before = tablesSnapshot(f.repo), fetches = f.fetchImpl.calls.length;
  assert.equal(ok(await f.read({ partNumbers: parts, storeNumbers: stores })).results.length, 16);
  assert.equal(tablesSnapshot(f.repo), before); assert.equal(f.fetchImpl.calls.length, fetches);
  const weekly = await alternativesFixture({ member: true });
  assert.equal((await weekly.read({ partNumbers: parts, storeNumbers: stores, planId: 'member_365d', maxStores: 4 })).error.code, 'invalid_alternative_scope');
});

test('annual alternative evidence accepts five stores without extra upstream requests', async () => {
  const f = await alternativesFixture({ query: false }); await purchase(f, 'annual-alternatives', 'member_365d');
  ok(await f.call('query.pickup', { queryId: QUERY_ID, partNumber: BASE, storeNumbers: ['R577'] }));
  const numbers = ['R577', 'R578', 'R579', 'R580', 'R581'];
  for (const number of numbers) await f.observe(BASE, number);
  const before = tablesSnapshot(f.repo), fetches = f.fetchImpl.calls.length;
  assert.equal(ok(await f.read({ partNumbers: [BASE], storeNumbers: numbers })).results.length, 5);
  assert.equal(tablesSnapshot(f.repo), before); assert.equal(f.fetchImpl.calls.length, fetches);
});

test('a downgrade between service validation and the follow transaction cannot save a fourth store', async () => {
  const f = await fixture(); const monthly = await purchase(f, 'month-race', 'member_30d'); await purchase(f, 'week-race', 'member_7d');
  const mutate = f.repo.mutateFollow;
  f.repo.mutateFollow = async args => { await refund(f, monthly); return mutate(args); };
  const result = await follow(f, 0);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'too_many_stores');
  assert.deepEqual(await f.repo.listFollows(userKeyOf()), []);
});

test('ordinary and enhanced indexed accounts avoid per-user follow scans while paused slots retain their order after downgrade', async () => {
  const f = await fixture(); await purchase(f, 'month-indexed', 'member_30d'); await purchase(f, 'week-indexed', 'member_7d');
  for (let i = 0; i < 4; i++) ok(await follow(f, i));
  const saved = await f.repo.listFollows(userKeyOf());
  ok(await f.call('follow.pause', { followId: saved[0]._id }));
  let scans = 0; const list = f.repo.listFollows;
  f.repo.listFollows = async (...args) => { scans++; return list(...args); };
  const collector = createCollector({ repo: f.repo, clock: () => f.state.now, fetchImpl: f.state.fetchImpl, log: { info() {}, warn() {}, error() {} } });
  await collector.refreshTargets();
  assert.equal(collector.scheduler.snapshot().targets.reduce((n, t) => n + t.partNumbers.length, 0), 12);
  f.advance(30 * DAY); await collector.refreshTargets();
  assert.equal(collector.scheduler.snapshot().targets.reduce((n, t) => n + t.partNumbers.length, 0), 6, 'paused first slot does not silently transfer its ownership to the fourth configuration');
  assert.equal(scans, 0, 'member differentiation adds no follow collection query per account on each collector refresh');
  const rows = await list(userKeyOf());
  assert.equal(rows.length, 4); assert.equal(rows[0].status, 'paused'); assert.equal(rows[3].status, 'active');
});

test('concurrent metadata migration and refund cannot resurrect monthly slots or overwrite weekly balance', async () => {
  for (const migrationFirst of [true, false]) {
    const f = await fixture(); const month = await purchase(f, 'month-migrate-race', 'member_30d'); await purchase(f, 'week-migrate-race', 'member_7d');
    const user = await f.repo.getUser(userKeyOf());
    delete user.membership.entitlements.planMetadataVersion;
    for (const segment of user.membership.entitlements.segments) delete segment.planId;
    await f.repo.updateUser(user._id, { membership: user.membership });
    const migrate = () => f.repo.ensureMemberPlanMetadata({ userKey: user._id });
    await Promise.all(migrationFirst ? [migrate(), refund(f, month)] : [refund(f, month), migrate()]);
    const result = await boot(f);
    assert.equal(result.membership.enhanced, false); assert.equal(result.membership.remainingMs, 7 * DAY);
    assert.equal(result.limits.maxFollows, 3);
  }
});
