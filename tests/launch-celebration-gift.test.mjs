import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFixture, userKeyOf, userContext, operatorContext } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { CAMPAIGN_ID, DAY_MS, SUGGESTED_CUTOFF_EXCLUSIVE, paymentOrderId, paymentReceiptId } = require('../cloudfunctions/gxs_api/lib/rules/launch-gift');
const { scanLaunchGiftManifest, runLaunchGiftBatch } = require('../cloudfunctions/gxs_api/lib/services/launch-gift-task');
const { membershipSnapshot } = require('../cloudfunctions/gxs_api/lib/rules/membership');
const BEFORE = '2026-10-27T04:00:00.000Z', DURING = '2026-10-28T04:00:00.000Z', AFTER = '2026-10-30T04:00:00.000Z';
const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response.data; };
const plans = { member_7d: [7, 700], member_30d: [30, 1990], member_365d: [365, 20000] };
async function purchase(f, { id = 'paid-history', openid, planId = 'member_7d', fulfil = true, refundFen = 0 } = {}) {
  const ctx = userContext(openid), key = userKeyOf(openid);
  ok(await f.call('user.bootstrap', {}, ctx));
  const user = await f.repo.getUser(key), [days, amountFen] = plans[planId], nowIso = f.state.now.toISOString();
  const _id = paymentOrderId(key, id);
  await f.repo.createOrderIfAbsent({ _id, outTradeNo: _id, orderId: id, userKey: key, appid: user.appid, openid: user.openid,
    provider: 'wechat_virtual_payment', type: 'membership_order', productId: `product_${planId}`, planId, days, amountFen,
    status: 'created', createdAt: nowIso, paymentSnapshot: { version: 2, provider: 'wechat_virtual_payment', appid: user.appid,
      productId: `product_${planId}`, planId, days, priceFen: amountFen, currency: 'CNY', env: 0, buyQuantity: 1 } });
  await f.repo.markOrderPaid({ orderId: _id, transactionId: `transaction_${openid || 'default'}_${id}`, nowIso,
    providerData: { provider: 'wechat_virtual_payment', amountFen } });
  if (fulfil) await f.repo.fulfilMembershipOrder({ orderId: _id, source: 'virtual_payment', nowIso });
  if (refundFen) await f.repo.markOrderRefunded({ orderId: _id, refundFen, nowIso, providerData: { source: 'query_order', transactionId: `transaction_${openid || 'default'}_${id}` } });
  return f.repo.getOrder(_id);
}
async function manifestFor(f, extra = {}) {
  return (await scanLaunchGiftManifest(f.repo, { environmentId: 'offline-tests', snapshotAt: AFTER,
    cutoffExclusive: SUGGESTED_CUTOFF_EXCLUSIVE, cutoffConfirmed: true, ...extra })).manifest;
}
const batch = (f, manifest, extra = {}) => runLaunchGiftBatch(f.repo, manifest, { expectedEnvironmentId: 'offline-tests', nowIso: AFTER, ...extra });
const gift = (f, openid) => f.repo.getOrder(`${userKeyOf(openid)}|${CAMPAIGN_ID}`);

test('A19/A21/A24: paid full/partial refunds, even before fulfilment, receive one background day without visit or follow', async () => {
  for (const [planId, fulfil, refundFen] of [['member_7d', false, 700], ['member_30d', true, 1990], ['member_365d', true, 10000]]) {
    const f = createFixture({ start: BEFORE });
    const order = await purchase(f, { planId, fulfil, refundFen });
    const frozenOrder = structuredClone(order), userBefore = await f.repo.getUser(userKeyOf());
    const manifest = await manifestFor(f);
    const dry = await batch(f, manifest);
    assert.equal(dry.report.distribution.pending, 1);
    assert.equal(await gift(f), null);
    assert.deepEqual(await f.repo.getUser(userKeyOf()), userBefore);
    const applied = await batch(f, manifest, { dryRun: false });
    assert.equal(applied.report.reconciliation.successful, 1);
    assert.equal(applied.report.allEligibleGranted, true);
    assert.deepEqual(await f.repo.getOrder(order._id), frozenOrder);
    const receipt = await gift(f);
    assert.equal(receipt.createdAt, AFTER);
    assert.equal(receipt.campaignDay, '2026-10-28');
    assert.equal(receipt.entitlementGrantedMs, DAY_MS);
    assert.equal(receipt.planId, planId);
    const beforeExpiry = Date.parse(userBefore.membership.expiresAt) || 0;
    assert.equal(Date.parse((await f.repo.getUser(userKeyOf())).membership.expiresAt), Math.max(beforeExpiry, Date.parse(AFTER)) + DAY_MS);
  }
});

test('A20: free admin gifts, redemption and trial never qualify; historical payer with a later gift still qualifies', async () => {
  const f = createFixture({ start: BEFORE });
  for (const openid of ['only-admin', 'only-redemption', 'only-trial']) {
    ok(await f.call('user.bootstrap', {}, userContext(openid)));
    ok(await f.call('admin.grantMembership', { userKey: userKeyOf(openid), grantId: `free_${openid}`, days: 30 }, operatorContext()));
    if (openid !== 'only-admin') {
      const row = [...f.repo.tables.get(C.orders).values()].find(o => o.userKey === userKeyOf(openid));
      await f.repo.saveOrder({ ...row, type: openid === 'only-redemption' ? 'membership_redemption' : 'membership_trial',
        source: openid === 'only-redemption' ? 'redemption_code' : 'trial_compensation' });
    }
  }
  await purchase(f, { openid: 'paid-and-gifted' });
  ok(await f.call('admin.grantMembership', { userKey: userKeyOf('paid-and-gifted'), grantId: 'old_other_activity', days: 2 }, operatorContext()));
  f.state.now = new Date(DURING);
  for (const openid of ['only-admin', 'only-redemption', 'only-trial']) {
    ok(await f.call('user.bootstrap', {}, userContext(openid)));
    assert.equal(await gift(f, openid), null);
  }
  const result = await batch(f, await manifestFor(f), { dryRun: false });
  assert.equal(result.report.distribution.ineligible, 3);
  assert.equal(result.report.distribution.granted, 1);
  assert.ok(await gift(f, 'paid-and-gifted'));
});

test('A22: access and multiple background executors share the old campaign key; repeated payments grant one day', async () => {
  const f = createFixture({ start: BEFORE });
  await purchase(f, { id: 'payment-one' }); await purchase(f, { id: 'payment-two' });
  const manifest = await manifestFor(f, { snapshotAt: DURING }), before = await f.repo.getUser(userKeyOf());
  f.state.now = new Date(DURING);
  await Promise.all([f.call('user.bootstrap'), batch(f, manifest, { nowIso: DURING, dryRun: false }), batch(f, manifest, { nowIso: DURING, dryRun: false })]);
  assert.equal(Date.parse((await f.repo.getUser(userKeyOf())).membership.expiresAt), Date.parse(before.membership.expiresAt) + DAY_MS);
  assert.equal([...f.repo.tables.get(C.orders).values()].filter(row => row.orderId === CAMPAIGN_ID).length, 1);
});

test('A22/A25: legacy marker, incomplete receipt and old unproven grant are review-only and never deducted or regranted', async () => {
  for (const conflict of ['marker-only', 'unfulfilled-receipt', 'old-wrong-grant']) {
    const f = createFixture({ start: BEFORE });
    const paid = await purchase(f);
    if (conflict === 'marker-only') await f.repo.updateUser(userKeyOf(), { 'membership.launch20261028GiftedAt': DURING });
    if (conflict === 'unfulfilled-receipt') await f.repo.createOrderIfAbsent({ _id: `${userKeyOf()}|${CAMPAIGN_ID}`, userKey: userKeyOf(), orderId: CAMPAIGN_ID, status: 'paid', days: 1, amountFen: 0 });
    if (conflict === 'old-wrong-grant') {
      f.state.now = new Date(DURING); ok(await f.call('user.bootstrap'));
      f.repo.tables.get(C.config).delete(paymentReceiptId(paid.transactionId));
    }
    const before = structuredClone([...f.repo.tables.get(C.users).values()]);
    const result = await batch(f, await manifestFor(f), { dryRun: false });
    assert.equal(result.report.distribution.review, 1);
    assert.equal(result.report.allEligibleGranted, false);
    assert.deepEqual([...f.repo.tables.get(C.users).values()], before);
  }
});

test('A23: fixed-ID keyset scan resumes bounded pages and ignores later insertions while retaining malformed old evidence', async () => {
  const f = createFixture({ start: BEFORE });
  for (let i = 0; i < 5; i++) await purchase(f, { id: `order-${i}`, openid: `account-${i}` });
  const calls = [], original = f.repo.scanLaunchGiftOrders;
  f.repo.scanLaunchGiftOrders = args => { calls.push(args); return original(args); };
  let saved;
  const options = { environmentId: 'offline-tests', snapshotAt: DURING, cutoffExclusive: SUGGESTED_CUTOFF_EXCLUSIVE, cutoffConfirmed: true, pageSize: 2, maxPages: 1 };
  const first = await scanLaunchGiftManifest(f.repo, { ...options, onCheckpoint: value => { saved = value; } });
  assert.equal(first.manifest, null); assert.equal(saved.scannedOrders, 2);
  const bound = saved.throughId;
  await f.repo.createOrderIfAbsent({ _id: 'zz-after-watermark', userKey: userKeyOf('new-account'), status: 'paid' });
  let result = first;
  while (!result.manifest) result = await scanLaunchGiftManifest(f.repo, { ...options, checkpoint: result.checkpoint });
  assert.equal(result.manifest.entries.length, 5);
  assert.ok(calls.every(call => call.limit === 2 && call.throughId === bound));
  const priorCalls = calls.length;
  await scanLaunchGiftManifest(f.repo, { ...options, checkpoint: result.checkpoint });
  assert.equal(calls.length, priorCalls);
  await assert.rejects(scanLaunchGiftManifest(f.repo, { ...options, checkpoint: result.checkpoint, cutoffExclusive: AFTER }), /boundary_changed/);
});

test('A23: lost success response resumes through receipt; finished task stops reads and writes', async () => {
  const f = createFixture({ start: BEFORE }); await purchase(f);
  const manifest = await manifestFor(f), apply = f.repo.applyLaunchCelebrationGift;
  let calls = 0;
  f.repo.applyLaunchCelebrationGift = async args => { calls++; await apply(args); throw new Error('response lost after commit'); };
  const failed = await batch(f, manifest, { dryRun: false });
  assert.equal(failed.report.distribution.failed, 1);
  assert.equal(failed.report.reconciliation.initialPending, 1);
  const expiry = (await f.repo.getUser(userKeyOf())).membership.expiresAt;
  f.repo.applyLaunchCelebrationGift = apply;
  const resumed = await batch(f, manifest, { dryRun: false, checkpoint: failed.checkpoint });
  assert.equal(resumed.report.reconciliation.successful, 1);
  assert.equal(resumed.report.reconciliation.retryable, 0);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, expiry);
  f.repo.assessLaunchCelebrationGift = () => { throw new Error('completed task must not read'); };
  const repeated = await batch(f, manifest, { dryRun: false, checkpoint: resumed.checkpoint });
  assert.equal(repeated.report.allEligibleGranted, true); assert.equal(calls, 1);
});

test('A23: transaction fault rolls back marker, entitlement and gift receipt; retry applies exactly once', async () => {
  const f = createFixture({ start: BEFORE }); await purchase(f);
  const manifest = await manifestFor(f), before = await f.repo.getUser(userKeyOf());
  f.repo.transactionWriteHook = (name, doc) => { if (name === C.orders && doc.orderId === CAMPAIGN_ID) throw new Error('write failure'); };
  const failed = await batch(f, manifest, { dryRun: false });
  assert.equal(failed.report.distribution.failed, 1);
  assert.deepEqual(await f.repo.getUser(userKeyOf()), before); assert.equal(await gift(f), null);
  f.repo.transactionWriteHook = null;
  const resumed = await batch(f, manifest, { dryRun: false, checkpoint: failed.checkpoint });
  assert.equal(resumed.report.distribution.granted, 1);
});

test('failure before assessment enters the pending reconciliation cohort when retry later proves eligibility', async () => {
  const f = createFixture({ start: BEFORE }); await purchase(f);
  const manifest = await manifestFor(f), assess = f.repo.assessLaunchCelebrationGift;
  f.repo.assessLaunchCelebrationGift = () => { throw new Error('read unavailable'); };
  const failed = await batch(f, manifest, { dryRun: false });
  assert.equal(failed.report.unresolvedBeforeAssessment, 1);
  f.repo.assessLaunchCelebrationGift = assess;
  const resumed = await batch(f, manifest, { dryRun: false, checkpoint: failed.checkpoint });
  assert.equal(resumed.report.unresolvedBeforeAssessment, 0);
  assert.equal(resumed.report.reconciliation.initialPending, 1);
  assert.equal(resumed.report.reconciliation.successful, 1);
});

test('A24: midnight access stops; background uses actual clock and fixed campaign/cutoff, not notice expiry', async () => {
  const f = createFixture({ start: BEFORE }); await purchase(f, { fulfil: false, refundFen: 700 });
  f.state.now = new Date(SUGGESTED_CUTOFF_EXCLUSIVE); ok(await f.call('user.bootstrap'));
  assert.equal(await gift(f), null);
  const manifest = await manifestFor(f);
  await batch(f, manifest, { dryRun: false });
  assert.equal(Date.parse((await f.repo.getUser(userKeyOf())).membership.expiresAt), Date.parse(AFTER) + DAY_MS);
  assert.equal((await gift(f)).createdAt, AFTER);
});

test('A25: missing receipts/late first payments/ownership conflicts remain distinct from non-cash', async () => {
  for (const issue of ['receipt', 'snapshot', 'owner', 'late', 'zero-cash', 'ambiguous-time']) {
    const f = createFixture({ start: issue === 'late' ? AFTER : BEFORE }); const order = await purchase(f);
    if (issue === 'receipt') f.repo.tables.get(C.config).delete(paymentReceiptId(order.transactionId));
    if (issue === 'snapshot') await f.repo.saveOrder({ ...order, paymentSnapshot: { ...order.paymentSnapshot, env: 1 } });
    if (issue === 'owner') await f.repo.saveOrder({ ...order, openid: 'someone-else' });
    if (issue === 'zero-cash') await f.repo.saveOrder({ ...order, amountFen: 0 });
    if (issue === 'ambiguous-time') await f.repo.saveOrder({ ...order, paidAt: '2026-10-27 12:00:00' });
    const result = await batch(f, await manifestFor(f), { dryRun: false });
    assert.equal(result.report.distribution.review, 1); assert.equal(await gift(f), null);
  }
});

test('malformed historical order without userKey is an account anomaly, not a whole-scan failure', async () => {
  const f = createFixture({ start: BEFORE }); await purchase(f);
  await f.repo.createOrderIfAbsent({ _id: 'orphan-order', type: 'membership_order', amountFen: 700, status: 'paid' });
  const manifest = await manifestFor(f);
  assert.equal(manifest.entries.length, 2);
  const result = await batch(f, manifest);
  assert.equal(result.report.distribution.pending, 1);
  assert.equal(result.report.distribution.account_missing, 1);
});

test('routine payment reconciliation after the manifest snapshot does not change historical paid eligibility', async () => {
  const f = createFixture({ start: BEFORE }); const order = await purchase(f);
  const manifest = await manifestFor(f, { snapshotAt: DURING });
  await f.repo.markOrderPaid({ orderId: order._id, transactionId: order.transactionId, nowIso: AFTER,
    providerData: { provider: 'wechat_virtual_payment', amountFen: order.amountFen } });
  assert.equal((await f.repo.getOrder(order._id)).paidAt, BEFORE);
  const result = await batch(f, manifest, { dryRun: false });
  assert.equal(result.report.distribution.granted, 1);
});

async function offsetPaymentHistory() {
  const f = createFixture({ start: '2026-09-15T04:30:00.000Z' });
  const early = await purchase(f, { id: 'earlier-monthly', planId: 'member_30d' });
  await f.repo.saveOrder({ ...early, paidAt: '2026-09-15T12:30:00+08:00' });
  f.state.now = new Date('2026-09-15T05:00:00.000Z');
  const later = await purchase(f, { id: 'later-weekly', planId: 'member_7d' });
  assert.ok(Date.parse((await f.repo.getUser(userKeyOf())).membership.expiresAt) < Date.parse(DURING));
  return { f, early, later };
}

test('frozen background list picks the latest real payment instant across different ISO timezone offsets', async () => {
  const { f, later } = await offsetPaymentHistory();
  const manifest = await manifestFor(f);
  assert.equal(manifest.entries[0].evidenceOrderId, later._id);
  await batch(f, manifest, { dryRun: false });
  assert.equal((await gift(f)).planId, 'member_7d');
});

test('access-path gift restores the last verified plan by real time, not ISO string order', async () => {
  const { f, later } = await offsetPaymentHistory();
  f.state.now = new Date(DURING);
  const bootstrap = ok(await f.call('user.bootstrap'));
  assert.equal(bootstrap.membership.planId, 'member_7d');
  assert.equal((await gift(f)).evidenceOrderId, later._id);
  assert.equal((await gift(f)).planId, 'member_7d');
});

test('A26: annual gift inserted before queued monthly time adds one day to tier cutoffs, not an entire queued month', async () => {
  const f = createFixture({ start: BEFORE });
  await purchase(f, { id: 'annual', planId: 'member_365d' });
  await purchase(f, { id: 'monthly', planId: 'member_30d' });
  const before = membershipSnapshot(await f.repo.getUser(userKeyOf()), new Date(AFTER));
  await batch(f, await manifestFor(f), { dryRun: false });
  const after = membershipSnapshot(await f.repo.getUser(userKeyOf()), new Date(AFTER));
  assert.equal(Date.parse(after.expiresAt), Date.parse(before.expiresAt) + DAY_MS);
  assert.equal(Date.parse(after.annualExpiresAt), Date.parse(before.annualExpiresAt) + DAY_MS);
  assert.equal(Date.parse(after.enhancedExpiresAt), Date.parse(before.enhancedExpiresAt) + DAY_MS);
  assert.equal(after.planId, 'member_365d');
});

test('A26: concurrent purchase/refund and grant preserve original financial state and all attributable remaining time', async () => {
  const f = createFixture({ start: BEFORE });
  const first = await purchase(f, { id: 'annual', planId: 'member_365d' });
  const second = await purchase(f, { id: 'monthly', planId: 'member_30d', fulfil: false });
  const manifest = await manifestFor(f);
  await Promise.all([
    batch(f, manifest, { dryRun: false }),
    f.repo.markOrderRefunded({ orderId: first._id, refundFen: first.amountFen, nowIso: AFTER, providerData: { source: 'query_order', transactionId: first.transactionId } }),
    f.repo.fulfilMembershipOrder({ orderId: second._id, source: 'virtual_payment', nowIso: AFTER }),
  ]);
  assert.equal((await f.repo.getOrder(first._id)).status, 'refunded');
  assert.equal((await f.repo.getOrder(second._id)).status, 'fulfilled');
  const user = await f.repo.getUser(userKeyOf());
  assert.equal(Date.parse(user.membership.expiresAt), Date.parse(AFTER) + 31 * DAY_MS);
  assert.equal(user.membership.entitlements.segments.find(s => s.orderId === `${user._id}|${CAMPAIGN_ID}`).remainingMs, DAY_MS);
});

test('A26: gift restores only eligible active targets and separates one-time SDK actions from ongoing collection load', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); } catch { t.skip('Pinned SDK missing; one-time database action measurement remains unverified'); return; }
  const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
  const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
  const f = createFixture({ start: '2026-10-01T04:00:00.000Z', config: { collector: { enabled: true, intervalSeconds: 60, burstIntervalSeconds: 0, availableIntervalSeconds: 0 } } });
  for (const openid of ['restore-active-a', 'restore-active-b', 'keep-paused', 'keep-retired']) await purchase(f, { openid });
  ok(await f.call('user.bootstrap', {}, userContext('never-paid')));
  const followedAt = f.state.now.toISOString();
  for (const [openid, partNumber, status, storeNumbers] of [
    ['restore-active-a', 'MXXX1CH/A', 'active', ['R577', 'R639']],
    ['restore-active-b', 'MXXX1CH/A', 'active', ['R577', 'R639']],
    ['keep-paused', 'MYYY2CH/A', 'paused', ['R320']],
    ['keep-retired', 'MDE14CH/A', 'active', ['R577']],
    ['never-paid', 'MZZZ3CH/A', 'active', ['R448']],
  ]) await f.repo.saveFollow({ _id: `${userKeyOf(openid)}|follow`, userKey: userKeyOf(openid), followId: 'follow', partNumber, status, storeNumbers, createdAt: followedAt });
  f.state.now = new Date(AFTER); // Long-expired subscriptions; no activity-day access grant.
  const frozenFollows = structuredClone([...f.repo.tables.get(C.follows).values()]);
  const frozenPayments = structuredClone([...f.repo.tables.get(C.orders).values()]);
  let upstreamCalls = 0, sends = 0;
  const collector = createCollector({ repo: f.repo, clock: () => new Date(f.state.now), log: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => { upstreamCalls++; throw Error('This experiment must never dispatch upstream'); }, sendImpl: async () => { sends++; throw Error('This experiment must never send'); } });
  await collector.refreshTargets(); const before = collector.scheduler.snapshot();
  assert.equal(before.groupCount, 0); assert.equal(before.intervalMs, 60000);

  // Real repository + pinned SDK, entirely offline transport. Eligibility uses
  // the same memory-backed production collector before and after the commit.
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV; process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk'); cloud.init({ env: 'offline-gift-restoration-load' });
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson'); const copy = value => EJSON.parse(EJSON.stringify(value));
  let committed = Object.fromEntries([...f.repo.tables].map(([name, rows]) => [name, Object.fromEntries(rows)]));
  const transactions = new Map(), calls = []; let sequence = 0, busy = false;
  const matches = (row, query) => Object.entries(query).every(([key, expected]) => key === '$and' ? expected.every(part => matches(row, part))
    : expected && typeof expected === 'object' ? Object.entries(expected).every(([op, value]) => op === '$lte' ? row[key] <= value : op === '$gt' ? row[key] > value : false) : row[key] === expected);
  Database.reqClass = class OfflineTransport {
    async send(action, args = {}) {
      assert.equal(busy, false, 'transaction reads/writes must remain serial'); busy = true;
      try {
        await Promise.resolve(); calls.push({ action, collection: args.collectionName || null });
        if (action === 'database.startTransaction') { const id = `tx-${++sequence}`; transactions.set(id, copy(committed)); return { transactionId: id }; }
        if (action === 'database.commitTransaction') { committed = transactions.get(args.transactionId); transactions.delete(args.transactionId); return {}; }
        if (action === 'database.abortTransaction') { transactions.delete(args.transactionId); return {}; }
        if (action === 'database.getDocument' && !args.transactionId) {
          assert.equal(args.collectionName, C.orders); assert.equal(args.offset || 0, 0);
          const query = args.query ? EJSON.parse(args.query) : {};
          const direction = Object.keys(query).length ? 1 : -1;
          const rows = Object.values(committed[C.orders]).filter(row => matches(row, query)).sort((a, b) => (a._id < b._id ? -1 : 1) * direction).slice(0, args.limit);
          return { data: { list: rows.map(row => EJSON.stringify(row)) } };
        }
        assert.ok(args.transactionId);
        const rows = transactions.get(args.transactionId)[args.collectionName] ||= {};
        if (action === 'database.getDocument') { const id = EJSON.parse(args.query)._id; return { data: { list: rows[id] ? [EJSON.stringify(rows[id])] : [] } }; }
        if (action === 'database.modifyDocument') { assert.equal(args.merge, false); const id = EJSON.parse(args.query)._id; rows[id] = { _id: id, ...EJSON.parse(args.data) }; return { data: { updated: 1 } }; }
        if (action === 'database.insertDocument') { const docs = args.data.map(value => EJSON.parse(value)); for (const doc of docs) rows[doc._id] = doc; return { data: { insertedIds: docs.map(doc => doc._id) } }; }
        throw Error(`Unexpected offline SDK action: ${action}`);
      } finally { busy = false; }
    }
  };
  const count = rows => ({ actions: rows.length, starts: rows.filter(r => r.action === 'database.startTransaction').length,
    reads: rows.filter(r => r.action === 'database.getDocument').length, writes: rows.filter(r => /modifyDocument|insertDocument/.test(r.action)).length,
    commits: rows.filter(r => r.action === 'database.commitTransaction').length });
  let scanCounts, grantCounts, replayCounts;
  try {
    const measured = createCloudbaseRepo(db);
    const scanned = await scanLaunchGiftManifest(measured, { environmentId: 'offline-tests', snapshotAt: AFTER, cutoffExclusive: SUGGESTED_CUTOFF_EXCLUSIVE, cutoffConfirmed: true });
    assert.equal(scanned.manifest.entries.length, 4); scanCounts = count(calls); calls.length = 0;
    const applied = await runLaunchGiftBatch(measured, scanned.manifest, { expectedEnvironmentId: 'offline-tests', nowIso: AFTER, dryRun: false });
    assert.equal(applied.report.reconciliation.successful, 4); grantCounts = count(calls); calls.length = 0;
    await runLaunchGiftBatch(measured, scanned.manifest, { expectedEnvironmentId: 'offline-tests', nowIso: AFTER, dryRun: false, checkpoint: applied.checkpoint });
    replayCounts = count(calls); assert.equal(replayCounts.actions, 0);
  } finally { Database.reqClass = previousRequest; if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV; else process.env.TENCENTCLOUD_RUNENV = previousRuntime; }
  assert.deepEqual(scanCounts, { actions: 22, starts: 4, reads: 14, writes: 0, commits: 4 });
  assert.deepEqual(grantCounts, { actions: 56, starts: 8, reads: 32, writes: 8, commits: 8 });
  for (const [name, rows] of Object.entries(committed)) { f.repo.tables.get(name).clear(); for (const [id, row] of Object.entries(rows)) f.repo.tables.get(name).set(id, structuredClone(row)); }
  assert.deepEqual([...f.repo.tables.get(C.follows).values()], frozenFollows, 'gift must never toggle saved active/paused/retired choices');
  for (const order of frozenPayments) assert.deepEqual(await f.repo.getOrder(order._id), order);
  assert.equal(membershipSnapshot(await f.repo.getUser(userKeyOf('never-paid')), new Date(AFTER)).active, false);
  await collector.refreshTargets(); const after = collector.scheduler.snapshot();
  const targets = after.targets.flatMap(group => group.partNumbers.map(part => `${group.storeNumber}|${part}`)).sort();
  assert.deepEqual(targets, ['R577|MXXX1CH/A', 'R639|MXXX1CH/A']);
  assert.equal(after.intervalMs, 60000); assert.equal(upstreamCalls, 0); assert.equal(sends, 0);
  t.diagnostic(JSON.stringify({ experiment: 'A26_gift_restore_targets', scope: 'synthetic memory collector plus pinned SDK offline transport',
    expiredPaidAccounts: 4, neverPaidAccounts: 1, grantedAccounts: 4, beforeUniqueTargets: 0, afterUniqueTargets: 2,
    activeFollowOwnersRestored: 2, pausedFollowUnchanged: true, retiredTargetExcluded: true, neverPaidExcluded: true,
    regularIntervalMs: after.intervalMs, oneTimeScan: scanCounts, oneTimeAssessAndGrant: grantCounts, completedCheckpointReplay: replayCounts,
    steadyStateModel: { acceptedSamplesPerHealthyRegularRound: 2, legacyObservationActions: 14, embeddedObservationActionsIfSeparatelyMigrated: 10,
      excludes: ['request budget and health', 'lease/status outside sample transactions', 'event and notification work', 'frontend reads', 'migration and archives'] },
    productionRequests: 0, productionGrants: 0, productionNotifications: 0 }));
});

test('frozen manifests bind environment, cutoff, source and mode; no apply with suggested-only boundary', async () => {
  const f = createFixture({ start: BEFORE }); await purchase(f);
  const manifest = await manifestFor(f, { cutoffConfirmed: false });
  assert.equal(manifest.cutoffIsSuggestion, true);
  await assert.rejects(batch(f, manifest, { dryRun: false }), /boundary_unconfirmed/);
  await assert.rejects(batch(f, { ...manifest, environmentId: 'production' }), /invalid_launch_gift_manifest/);
  const dry = await batch(f, manifest);
  await assert.rejects(batch(f, await manifestFor(f), { dryRun: false, checkpoint: dry.checkpoint }), /checkpoint_mismatch/);
  assert.equal(JSON.stringify(dry.report).includes(userKeyOf()), false);
});

test('local CLI defaults to no mutation and resumes bounded scan/apply from immutable export', async t => {
  const f = createFixture({ start: BEFORE });
  await purchase(f, { openid: 'cli-one' }); await purchase(f, { openid: 'cli-two' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gxs-launch-gift-'));
  t.after(async () => { if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('gxs-launch-gift-')) await fs.rm(directory, { recursive: true, force: true }); });
  const input = path.join(directory, 'frozen.json');
  const data = { metadata: { environmentId: 'offline-cli', snapshotAt: DURING, ordersComplete: true },
    collections: Object.fromEntries([...f.repo.tables].map(([name, rows]) => [name, [...rows.values()]])) };
  const raw = JSON.stringify(data); await fs.writeFile(input, raw);
  const command = (...args) => {
    const result = spawnSync(process.execPath, ['tools/member/launch-gift.mjs', '--input', input, '--now', AFTER, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout);
  };
  const dryOut = path.join(directory, 'dry');
  const dry = command('--out', dryOut);
  assert.equal(dry.dryRun, true); assert.equal(dry.productionGrants, 0);
  assert.equal((await fs.readdir(dryOut)).includes('local-state.json'), false);
  const out = path.join(directory, 'apply');
  const base = ['--out', out, '--apply-local', '--cutoff', SUGGESTED_CUTOFF_EXCLUSIVE, '--page-size', '1', '--max-pages', '1', '--max-accounts', '1'];
  assert.equal(command(...base).scanComplete, false);
  let progress = command(...base, '--resume');
  while (!progress.processingComplete) progress = command(...base, '--resume');
  assert.equal(progress.reconciliation.successful, 2);
  const repeated = command(...base, '--resume');
  assert.equal(repeated.reconciliation.successful, 2);
  const state = JSON.parse(await fs.readFile(path.join(out, 'local-state.json'), 'utf8'));
  assert.equal(state.collections[C.orders].filter(row => row.orderId === CAMPAIGN_ID).length, 2);
  assert.equal(await fs.readFile(input, 'utf8'), raw);
  assert.equal((await fs.readFile(path.join(out, 'report.json'), 'utf8')).includes('cli-one'), false);
});
