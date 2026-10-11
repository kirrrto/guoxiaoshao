import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userContext, userKeyOf, operatorContext, PRODUCTS } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { runtimeFor, accountKey, EVENTS, REASONS } = require('../cloudfunctions/gxs_api/lib/growth-policy');
const { classifyOrder, buildReport } = require('../cloudfunctions/gxs_api/lib/services/growth');
const { runRetentionIfDue } = require('../cloudfunctions/gxs_api/lib/engine/retention');
const client = require('../miniprogram/utils/conversion-events');
const DAY = 86400000;
const config = { features: { growthEvents: true } };
const event = (f, name = 'offer_viewed', id = 'event-first') => ({ eventId: id, sessionId: 'session-first', eventName: name,
  occurredAt: f.state.now.toISOString(), appVersion: '2.0.0', platform: 'ios', entryPoint: 'query_result' });
const cash = (id, userKey, at, patch = {}) => ({ _id: id, orderId: id, userKey, provider: 'wechat_virtual_payment', outTradeNo: `trade-${id}`,
  transactionId: `wx-${id}`, amountFen: 700, days: 7, status: 'fulfilled', paidAt: at, fulfilledAt: at,
  payment: { providerData: { amountFen: 700, provider: 'wechat_virtual_payment' } }, ...patch });

test('growth defaults stay off, account buckets are stable, AA preserves baseline and rollback touches no ledger', async () => {
  const cfg = mergeConfig({});
  assert.ok(Object.values(runtimeFor(cfg, userKeyOf()).features).every(value => !value));
  const enabled = mergeConfig({ features: { growthEvents: true, experimentAssignments: true, contextualCheckout: true },
    growthExperiment: { id: 'e01', assignmentVersion: 1, mode: 'aa', feature: 'contextualCheckout', allocationPercent: 100 } });
  validateConfig(enabled);
  const a = runtimeFor(enabled, userKeyOf());
  assert.deepEqual(runtimeFor(enabled, userKeyOf()), a);
  assert.equal(a.features.contextualCheckout, false);
  assert.ok(['control', 'variant'].includes(a.experiment.variant));
  const paused = mergeConfig({ features: { contextualCheckout: true }, growthExperiment: { mode: 'ab' } });
  validateConfig(paused);
  assert.equal(runtimeFor(paused, userKeyOf()).features.contextualCheckout, false);
  assert.equal(runtimeFor(paused, userKeyOf()).experiment, null);
  assert.throws(() => validateConfig(mergeConfig({ features: { unknownFlag: true } })), /features/);
  const fixture = createFixture();
  const boot = await fixture.call('user.bootstrap');
  assert.equal(boot.data.features.launchGuide, false);
  const before = structuredClone([...fixture.repo.tables.get(C.users).values()]);
  await fixture.call('growth.ingest', { events: [event(fixture)] });
  assert.deepEqual([...fixture.repo.tables.get(C.users).values()], before);
  assert.equal(fixture.repo.tables.get(C.growthAccounts).size, 0);
});

test('ingest trusts SDK identity, strips secrets, validates targets and deduplicates replay', async () => {
  const f = createFixture({ config });
  await f.call('user.bootstrap');
  const input = { ...event(f, 'target_committed'), target: { partNumber: PRODUCTS[0].partNumber, storeNumbers: ['R577'] },
    openid: 'secret-openid', userKey: 'forged-account', signData: 'payment-secret', loginCode: 'secret-code', reasonCode: 'private error text' };
  assert.equal((await f.call('growth.ingest', { events: [input] })).data.accepted, 1);
  assert.equal((await f.call('growth.ingest', { events: [input] })).data.duplicate, 1);
  const saved = [...f.repo.tables.get(C.growthEvents).values()][0];
  assert.equal(saved.accountKey, accountKey(userKeyOf()));
  assert.equal(saved.entryPoint, 'query_result');
  assert.equal(saved.reasonCode, null);
  assert.doesNotMatch(JSON.stringify(saved), /secret|forged|oUSER/);
  const account = f.repo.tables.get(C.growthAccounts).get(saved.accountKey);
  const firstIntent = structuredClone(account.firstIntent);
  f.advance(5000);
  await f.call('growth.ingest', { events: [{ ...event(f, 'target_committed', 'event-second'), target: { partNumber: PRODUCTS[1].partNumber, storeNumbers: ['R639'] } }] });
  assert.deepEqual(f.repo.tables.get(C.growthAccounts).get(saved.accountKey).firstIntent, firstIntent);
  const invalid = await f.call('growth.ingest', { events: [{ ...event(f, 'target_committed', 'event-third'), target: { partNumber: PRODUCTS[4].partNumber, storeNumbers: ['R577'] } }] });
  assert.equal(invalid.data.rejected, 1);
  const another = userContext('oOTHER00000000000000000001');
  await f.call('user.bootstrap', {}, another);
  assert.equal((await f.call('growth.ingest', { events: [input] }, another)).data.accepted, 1);
  assert.equal(f.repo.tables.get(C.growthEvents).size, 3);
});

test('event allowlist rejects financial claims and write volume is capped per authenticated account', async () => {
  const f = createFixture({ config });
  await f.call('user.bootstrap');
  assert.equal((await f.call('growth.ingest', { events: [event(f, 'payment_verified')] })).data.accepted, 0);
  const malformed = await f.call('growth.ingest', { events: Array(11).fill(event(f)) });
  assert.equal(malformed.error.code, 'invalid_growth_batch');
  for (let batch = 0; batch < 7; batch++) {
    await f.call('growth.ingest', { events: Array.from({ length: 10 }, (_, i) => event(f, 'offer_viewed', `event-${batch}-${i}`)) });
  }
  assert.equal(f.repo.tables.get(C.growthEvents).size, 60);
  for (let i = 0; i < 5; i++) await f.call('growth.ingest', { events: [event(f, 'offer_viewed', `event-extra-${i}`)] });
  assert.equal((await f.call('growth.ingest', { events: [event(f)] })).data.rateLimited, true);
  f.advance(60000);
  assert.equal((await f.call('growth.ingest', { events: [event(f, 'offer_viewed', 'event-new-minute')] })).data.accepted, 1);
});

test('cash classification separates verified receipts, redemption, gifts, unknown payment and refunds', () => {
  const at = '2026-09-20T00:00:00.000Z';
  const order = cash('one', userKeyOf(), at);
  assert.equal(classifyOrder(order).kind, 'cash');
  assert.equal(classifyOrder({ ...order, payment: null }).kind, 'unknown');
  assert.equal(classifyOrder({ ...order, transactionId: null }).kind, 'unknown');
  assert.equal(classifyOrder({ ...order, paidAt: null, fulfilledAt: null, status: 'cancelled', transactionId: null }).kind, 'unpaid');
  assert.equal(classifyOrder({ ...order, orderId: 'redeem_campaign', amountFen: 0 }).kind, 'non_cash');
  assert.equal(classifyOrder({ ...order, productId: 'admin_grant', amountFen: 0 }).kind, 'non_cash');
  assert.equal(classifyOrder({ ...order, test: true }).kind, 'non_cash');
  assert.equal(classifyOrder({ ...order, status: 'refunded', refundFen: 700 }).refundFen, null);
  assert.equal(classifyOrder({ ...order, refundFen: -100 }).refundFen, null);
  assert.equal(classifyOrder({ ...order, status: 'partially_refunded', refundFen: 200,
    refund: { source: 'query_order', transactionId: order.transactionId }, refundUpdatedAt: at }).refundFen, 200);
});

test('mature D7 cohort uses first intent and excludes prior real payers, pending intents and late payment', () => {
  const at = '2026-09-20T00:00:00.000Z';
  const until = new Date(Date.parse(at) + 7 * DAY).toISOString();
  const accounts = ['a', 'b', 'old', 'pending'].map(name => ({ _id: accountKey(name), firstIntent: { at: name === 'pending' ? until : at, experiment: null } }));
  const orders = [cash('a', 'a', until), cash('old', 'old', '2026-09-19T00:00:00.000Z'), cash('b', 'b', new Date(Date.parse(until) + 1).toISOString())];
  const report = buildReport({ orders, accounts, events: [], complete: true, since: at, until, config: mergeConfig(config) });
  assert.equal(report.cohort.mature, 2);
  assert.equal(report.cohort.firstPaidD7, 1);
  assert.equal(report.cohort.rate, 0.5);
  assert.equal(report.cohort.pending, 1);
  assert.equal(report.cohort.existingPayers, 1);
  assert.equal(report.activation.rate, null);
  const partial = buildReport({ orders, accounts, events: [], complete: false, since: at, until, config: mergeConfig(config) });
  assert.equal(partial.cohort.rate, null);
  const unknown = buildReport({ orders: [...orders, { _id: 'unknown', userKey: 'b', status: 'fulfilled' }], accounts, events: [], complete: true, since: at, until, config: mergeConfig(config) });
  assert.equal(unknown.cohort.unknownHistory, 1);
  assert.equal(unknown.cohort.rate, null);
});

test('hidden verified refunded orders remain in cash ledger; duplicates cannot inflate receipts', () => {
  const at = '2026-09-20T00:00:00.000Z';
  const order = cash('one', 'account', at, { userHiddenAt: at });
  order.status = 'refunded'; order.refundFen = 700; order.refundUpdatedAt = at;
  order.refund = { source: 'query_order', transactionId: order.transactionId };
  const report = buildReport({ orders: [order, { ...order, _id: 'duplicate' }], accounts: [], events: [], complete: true, since: at, until: at, config: mergeConfig(config) });
  assert.equal(report.finance.cashOrders, 1);
  assert.equal(report.finance.grossFen, 700);
  assert.equal(report.finance.refundsFen, 700);
  assert.equal(report.finance.hiddenCashOrders, 1);
  assert.equal(report.finance.duplicateTransactions, 1);
  assert.equal(report.finance.netFen, null);
});

test('growth report is admin only and truncation visibly suppresses rates', async () => {
  const f = createFixture({ config });
  assert.equal((await f.call('admin.growth', {})).error.code, 'forbidden');
  const report = await f.call('admin.growth', { days: 30 }, operatorContext());
  assert.equal(report.ok, true);
  assert.equal(report.data.since, '2026-08-16T16:00:00.000Z');
  assert.equal(report.data.coverage.complete, true);
  for (let i = 0; i < 2001; i++) f.repo.tables.get(C.orders).set(`order-${i}`, { _id: `order-${i}`, status: 'created' });
  const truncated = await f.call('admin.growth', {}, operatorContext());
  assert.equal(truncated.data.coverage.complete, false);
  assert.equal(truncated.data.coverage.orders, 2000);
  assert.equal(truncated.data.cohort.rate, null);
});

test('client telemetry stays best effort, bounded, allowlisted and clears on account change', async () => {
  assert.deepEqual(client.EVENTS, EVENTS);
  assert.deepEqual(client.REASONS, REASONS);
  const calls = [], timers = [];
  let fail = true, sequence = 0;
  const tracker = client.createTracker({ call: async (action, payload) => { calls.push({ action, payload }); if (fail) throw new Error('offline'); },
    now: () => Date.parse('2026-09-20T00:00:00.000Z'), makeId: prefix => `${prefix}-${++sequence}`, device: () => ({ platform: 'ios' }),
    schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {} });
  assert.equal(tracker.track('offer_viewed'), false);
  tracker.configure({ identity: { userKey: 'account-a' }, features: { growthEvents: true } });
  tracker.track('checkout_blocked', { reasonCode: 'payment_api_unavailable', signData: 'secret', rawError: 'private error' });
  await tracker.flush();
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /secret|private error|account-a/);
  tracker.configure({ identity: { userKey: 'account-b' }, features: { growthEvents: true } });
  fail = false;
  await tracker.flush();
  assert.equal(calls[1].payload.events.length, 1);
  assert.equal(calls[1].payload.events[0].eventName, 'session_started');
  for (let i = 0; i < 60; i++) tracker.track('cashier_result', { result: 'unknown' });
  assert.equal(tracker.track('cashier_result'), false);
  tracker.configure(null);
  await tracker.flush();
  assert.equal(calls.length, 2);
});

test('daily growth retention expires UI logs and idle guards, compacts detail but preserves first-intent and financial anchors', async () => {
  const f = createFixture({ config, start: '2026-10-11T00:30:00.000Z' });
  const tables = f.repo.tables;
  const put = (collection, row) => tables.get(collection).set(row._id, row);
  put(C.growthEvents, { _id: 'old-event', receivedAt: '2026-09-11T15:59:59.000Z' });
  put(C.growthEvents, { _id: 'kept-event', receivedAt: '2026-09-11T16:00:00.000Z' });
  put(C.growthAccounts, { _id: 'idle', firstIntent: null, updatedAt: '2026-09-11T15:59:59.000Z' });
  const account = accountKey(userKeyOf());
  const firstAt = '2026-07-01T00:00:00.000Z';
  put(C.growthAccounts, { _id: account, firstIntent: { at: firstAt, target: { partNumber: 'PRIVATE_TARGET' }, experiment: { id: 'old' }, platform: 'ios' }, updatedAt: firstAt });
  put(C.orders, cash('ancient-payment', userKeyOf(), '2026-06-01T00:00:00.000Z'));
  put(C.config, { _id: 'payment_receipt', kind: 'payment_receipt', createdAt: '2026-06-01T00:00:00.000Z' });
  const result = await runRetentionIfDue({ repo: f.repo, now: f.state.now, log: { error() {} } });
  assert.equal(result.growth.removedEvents, 1);
  assert.equal(result.growth.removedGuards, 1);
  assert.equal(result.growth.compactedIntents, 1);
  assert.equal(tables.get(C.growthEvents).has('kept-event'), true);
  assert.equal(tables.get(C.orders).has('ancient-payment'), true);
  assert.equal(tables.get(C.config).has('payment_receipt'), true);
  assert.equal(tables.get(C.growthAccounts).get(account).firstIntent.at, firstAt);
  assert.equal(tables.get(C.growthAccounts).get(account).firstIntent.target, null);
  await f.call('user.bootstrap');
  await f.call('growth.ingest', { events: [{ ...event(f, 'target_committed'), target: { partNumber: PRODUCTS[0].partNumber, storeNumbers: ['R577'] } }] });
  assert.equal(tables.get(C.growthAccounts).get(account).firstIntent.at, firstAt, 'an old account never re-enters the new cohort after cleanup');
});
