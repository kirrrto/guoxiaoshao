import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userContext, userKeyOf, operatorContext, RESOURCE_APPID } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const { attemptsId, CAMPAIGN, CLAIMS_ID } = require('../cloudfunctions/gxs_api/lib/member-redemption.js');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const redeem = (f, code = 'hbw666', extra = {}, context) => f.call('member.redeemCode', { code, ...extra }, context);
const attempts = f => f.repo.tables.get(C.config).get(attemptsId(userKeyOf()));

test('redemption activates the real membership and records one zero-amount redemption order without enabling payment', async () => {
  const f = createFixture();
  const result = ok(await redeem(f, '  HbW666\n', { days: 9999, expiresAt: '2099-01-01T00:00:00.000Z', amountFen: 1 }));
  assert.equal(result.redeemed, true); assert.equal(result.alreadyRedeemed, false);
  assert.equal(result.membership.active, true); assert.equal(result.membership.expiresAt, '2026-10-15T02:00:00.000Z');
  assert.deepEqual(ok(await f.call('user.bootstrap')).membership, result.membership);
  const status = ok(await f.call('member.status'));
  assert.deepEqual(status.membership, result.membership);
  assert.equal(status.product.paymentReady, false); assert.equal(status.payment.ready, false);
  assert.equal(status.orders.length, 1);
  assert.deepEqual({ type: status.orders[0].type, source: status.orders[0].source, days: status.orders[0].days, amount: status.orders[0].amountFen, status: status.orders[0].status }, { type: 'membership_redemption', source: 'redemption_code', days: 30, amount: 0, status: 'fulfilled' });
  assert.equal(status.orders[0].paidAt, null);
  const records = JSON.stringify([...f.repo.tables.values()].flatMap(table => [...table.values()]));
  assert.ok(!records.toLowerCase().includes('hbw666'), 'submitted codes are never persisted');
  assert.equal(ok(await f.call('member.createOrder', { orderId: 'still-closed' })).reason, 'payment_not_enabled');
  assert.equal((await f.repo.listOrders(userKeyOf(), 20)).length, 1);
});

test('concurrent request IDs redeem a campaign once and retries after expiry never reactivate it', async () => {
  const f = createFixture();
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => redeem(f, 'hbw666', { requestId: `request-${i}` })));
  assert.equal(results.filter(r => !ok(r).alreadyRedeemed).length, 1);
  assert.ok(results.every(r => r.data.membership.expiresAt === '2026-10-15T02:00:00.000Z'));
  assert.equal((await f.repo.listOrders(userKeyOf())).length, 1);
  f.advance(31 * 86400000);
  const retry = ok(await redeem(f));
  assert.equal(retry.alreadyRedeemed, true); assert.equal(retry.membership.active, false);
  assert.equal(retry.membership.expiresAt, '2026-10-15T02:00:00.000Z');
});

test('redemption preserves remaining membership days and serializes with another membership fulfilment', async () => {
  for (const expiry of ['2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']) {
    const f = createFixture(); ok(await f.call('user.bootstrap'));
    await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: expiry } });
    const result = ok(await redeem(f));
    const base = Math.max(f.state.now.getTime(), Date.parse(expiry));
    assert.equal(result.membership.expiresAt, new Date(base + 30 * 86400000).toISOString());
  }
  const f = createFixture(); ok(await f.call('user.bootstrap'));
  await f.repo.createOrderIfAbsent({ _id: 'another-membership', orderId: 'another-membership', userKey: userKeyOf(), days: 30, status: 'paid', amountFen: 0, createdAt: f.state.now.toISOString() });
  const results = await Promise.all([redeem(f), f.repo.fulfilMembershipOrder({ orderId: 'another-membership', source: 'admin_grant', nowIso: f.state.now.toISOString() })]);
  ok(results[0]); assert.equal(results[1].applied, true);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, '2026-11-14T02:00:00.000Z');
  assert.equal(ok(await redeem(f)).membership.expiresAt, '2026-11-14T02:00:00.000Z');
});

test('redemption binds to trusted appid/openid and rejects anonymous or untrusted callers', async () => {
  const f = createFixture(); ok(await f.call('user.bootstrap'));
  for (const context of [{}, operatorContext(), { ...userContext(), FROM_OPENID: undefined }]) {
    assert.equal((await redeem(f, 'hbw666', { userKey: userKeyOf() }, context)).error.code, 'user_required');
  }
  assert.equal((await redeem(f, 'hbw666', {}, userContext('intruder', 'wx1111111111111111'))).error.code, 'app_not_allowed');
  const other = ok(await redeem(f, 'hbw666', { userKey: userKeyOf(), openid: userContext().FROM_OPENID }, userContext('another')));
  assert.equal(other.membership.active, true); assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, null);
  const first = ok(await redeem(f));
  assert.equal(first.alreadyRedeemed, false);
  const sameOpenidOtherApp = ok(await redeem(f, 'hbw666', {}, userContext(userContext().FROM_OPENID, RESOURCE_APPID)));
  assert.equal(sameOpenidOtherApp.alreadyRedeemed, false, 'separate allowed mini-program identities do not collide');
  assert.equal(await f.repo.count(C.orders), 3);
});

test('five concurrent invalid guesses lock only that account for exactly fifteen minutes', async () => {
  const f = createFixture();
  const failures = await Promise.all(Array.from({ length: 8 }, (_, i) => redeem(f, `wrong-${i}`)));
  assert.equal(failures.filter(r => r.error.code === 'invalid_redemption_code').length, 4);
  assert.equal(failures.filter(r => r.error.code === 'redemption_rate_limited').length, 4);
  assert.equal(attempts(f).failures, 5);
  const locked = await redeem(f);
  assert.equal(locked.error.code, 'redemption_rate_limited'); assert.equal(locked.error.details.retryAfterSeconds, 900);
  assert.equal((await f.repo.listOrders(userKeyOf())).length, 0);
  assert.equal(ok(await redeem(f, 'hbw666', {}, userContext('another'))).membership.active, true);
  f.advance(15 * 60000 - 1);
  assert.equal((await redeem(f)).error.details.retryAfterSeconds, 1);
  f.advance(1);
  assert.equal(ok(await redeem(f)).alreadyRedeemed, false);
  assert.equal(attempts(f).failures, 0); assert.equal(attempts(f).lockedUntil, null);
});

test('malformed codes consume guessing attempts and successful verification resets consecutive failures', async () => {
  const f = createFixture();
  for (const [i, code] of [null, {}, '', 'x'.repeat(129)].entries()) {
    const failed = await redeem(f, code);
    assert.equal(failed.error.code, 'invalid_redemption_code'); assert.equal(failed.error.details.remainingAttempts, 4 - i);
  }
  ok(await redeem(f)); assert.equal(attempts(f).failures, 0);
  assert.equal((await redeem(f, 'still-wrong')).error.details.remainingAttempts, 4);
  assert.equal(ok(await redeem(f)).alreadyRedeemed, true); assert.equal(attempts(f).failures, 0);
});

test('runtime disabling is authoritative inside the transaction and cannot be bypassed with client config', async () => {
  const f = createFixture();
  for (const memberRedemption of [{ enabled: 'true' }, { enabled: true, days: 999 }, { code: 'replacement' }]) {
    assert.equal((await f.call('admin.updateConfig', { patch: { memberRedemption } }, operatorContext())).error.code, 'invalid_config');
  }
  ok(await f.call('admin.updateConfig', { patch: { memberRedemption: { enabled: false } } }, operatorContext()));
  assert.equal((await redeem(f, 'hbw666', { memberRedemption: { enabled: true }, config: { enabled: true } })).error.code, 'redemption_disabled');
  assert.equal(await f.repo.count(C.orders), 0);
  ok(await f.call('admin.updateConfig', { patch: { memberRedemption: { enabled: true } } }, operatorContext()));
  const getConfig = f.repo.getConfig;
  f.repo.getConfig = async () => {
    const earlier = await getConfig();
    await f.repo.saveConfig({ ...earlier, memberRedemption: { enabled: false } });
    return earlier;
  };
  assert.equal((await redeem(f)).error.code, 'redemption_disabled', 'disable after router config read still wins');
  f.repo.getConfig = getConfig;
  ok(await f.call('admin.updateConfig', { patch: { memberRedemption: { enabled: true } } }, operatorContext()));
  assert.equal(ok(await redeem(f)).alreadyRedeemed, false);
});

test('failed order persistence rolls back membership and failed-attempt reset so retry safely succeeds once', async () => {
  const f = createFixture();
  await redeem(f, 'wrong');
  f.repo.transactionWriteHook = async table => { if (table === C.orders) throw new Error('order unavailable'); };
  assert.equal((await redeem(f)).error.code, 'internal_error');
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, null);
  assert.equal(attempts(f).failures, 1); assert.equal(await f.repo.count(C.orders), 0);
  f.repo.transactionWriteHook = null;
  assert.equal(ok(await redeem(f)).alreadyRedeemed, false);
  assert.equal(ok(await redeem(f)).alreadyRedeemed, true);
  const [order] = await f.repo.listOrders(userKeyOf());
  assert.equal(order.campaignId, CAMPAIGN.id); assert.equal(order.fulfilledAt, f.state.now.toISOString());
});

test('the campaign closes after 20 accounts in total, counting redemptions granted before the cap existed', async () => {
  const f = createFixture();
  const account = i => userContext(`oCAP${String(i).padStart(22, '0')}`);
  for (let i = 0; i < 5; i++) ok(await redeem(f, 'hbw666', {}, account(i)));
  // Earlier deployments redeemed without a counter; the next claim must seed from those orders.
  f.repo.tables.get(C.config).delete(CLAIMS_ID);
  for (let i = 5; i < 20; i++) assert.equal(ok(await redeem(f, 'hbw666', {}, account(i))).alreadyRedeemed, false);
  assert.equal(f.repo.tables.get(C.config).get(CLAIMS_ID).claimed, 20);
  const soldOut = await redeem(f, 'hbw666', {}, account(20));
  assert.equal(soldOut.error.code, 'redemption_sold_out');
  assert.equal(await f.repo.count(C.orders, { type: 'membership_redemption' }), 20);
  assert.equal(ok(await redeem(f, 'hbw666', {}, account(3))).alreadyRedeemed, true, 'an account that already redeemed keeps its answer');
  assert.equal((await redeem(f, 'wrong-code', {}, account(21))).error.code, 'invalid_redemption_code', 'the code is still checked before the cap');
});

test('concurrent claims never exceed an operator-set cap', async () => {
  const f = createFixture();
  ok(await f.call('admin.updateConfig', { patch: { memberRedemption: { maxClaims: 3 } } }, operatorContext()));
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => redeem(f, 'hbw666', {}, userContext(`oRACE${String(i).padStart(21, '0')}`))));
  assert.equal(results.filter(r => r.ok).length, 3);
  assert.ok(results.filter(r => !r.ok).every(r => r.error.code === 'redemption_sold_out'));
  assert.equal(f.repo.tables.get(C.config).get(CLAIMS_ID).claimed, 3);
  for (const maxClaims of [-1, 1.5, '20']) assert.equal((await f.call('admin.updateConfig', { patch: { memberRedemption: { maxClaims } } }, operatorContext())).error.code, 'invalid_config');
});
