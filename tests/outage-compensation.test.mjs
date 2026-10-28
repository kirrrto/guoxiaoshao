import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { loadFollowUsers } = require('../cloudfunctions/gxs_api/lib/rules/follow-access');
const { OUTAGE_COMPENSATION_NOTICE, withOutageCompensationNotice } = require('../miniprogram/utils/query-notice.js');

const DAY = 86400000;
const OUTAGE_TIME = '2026-10-21T04:00:00.000Z'; // 2026-10-21 12:00:00+08:00
const BEFORE_OUTAGE = '2026-10-20T12:00:00.000Z'; // 2026-10-20 20:00:00+08:00
const AFTER_OUTAGE_DAY = '2026-10-21T16:00:00.000Z'; // 2026-10-22 00:00:00+08:00

const ok = response => {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.data;
};

const plans = { member_7d: [7, 700], member_30d: [30, 1990], member_365d: [365, 20000] };

async function purchase(f, id, planId) {
  const user = await f.repo.getUser(userKeyOf());
  const [days, amountFen] = plans[planId];
  const nowIso = f.state.now.toISOString();
  const order = {
    _id: `${user._id}|${id}`,
    orderId: id,
    userKey: user._id,
    appid: user.appid,
    openid: user.openid,
    provider: 'wechat_virtual_payment',
    type: 'membership_order',
    productId: `test_${planId}`,
    planId,
    days,
    amountFen,
    status: 'paid',
    paidAt: nowIso,
    createdAt: nowIso,
    paymentSnapshot: {
      version: 2,
      provider: 'wechat_virtual_payment',
      appid: user.appid,
      planId,
      productId: `test_${planId}`,
      days,
      priceFen: amountFen,
      currency: 'CNY',
      env: 0,
      buyQuantity: 1,
    },
  };
  await f.repo.createOrderIfAbsent(order);
  await f.repo.fulfilMembershipOrder({ orderId: order._id, source: 'virtual_payment', nowIso });
  return order;
}

test('paid active members automatically receive +1 day extension on 2026-10-21 while preserving plan tier and enhanced slots', async () => {
  for (const [planId, expectedSlots] of [['member_7d', 3], ['member_30d', 4], ['member_365d', 5]]) {
    const f = createFixture({ start: BEFORE_OUTAGE });
    ok(await f.call('user.bootstrap'));
    await purchase(f, `paid-${planId}`, planId);
    const before = ok(await f.call('user.bootstrap'));
    const beforeExpiry = Date.parse(before.membership.expiresAt);

    // Advance into 2026-10-21 Beijing day
    f.state.now = new Date(OUTAGE_TIME);
    const after = ok(await f.call('user.bootstrap'));
    assert.equal(after.membership.active, true);
    assert.equal(after.membership.planId, planId);
    assert.equal(Date.parse(after.membership.expiresAt), beforeExpiry + DAY);
    assert.equal(after.limits.maxFollows, expectedSlots);
    assert.equal(after.limits.maxStoresPerFollow, expectedSlots);
    if (planId === 'member_30d') {
      assert.equal(Date.parse(after.membership.enhancedExpiresAt), beforeExpiry + DAY);
    }
    if (planId === 'member_365d') {
      assert.equal(Date.parse(after.membership.annualExpiresAt), beforeExpiry + DAY);
    }

    // Repeated bootstrap and status calls on 2026-10-21 are strictly idempotent
    const again = ok(await f.call('user.bootstrap'));
    assert.equal(Date.parse(again.membership.expiresAt), beforeExpiry + DAY);
    const status = ok(await f.call('member.status'));
    const compOrders = status.orders.filter(o => o.orderId === 'grant_outage_20261021');
    assert.equal(compOrders.length, 1);
    assert.equal(compOrders[0].source, 'service_compensation');
    assert.equal(compOrders[0].days, 1);
  }
});

test('previously paid member whose membership expired during the outage gets +1 day restored on 2026-10-21', async () => {
  const f = createFixture({ start: '2026-09-20T14:00:00.000Z' });
  ok(await f.call('user.bootstrap'));
  await purchase(f, 'paid-30d-expired', 'member_30d');

  // Membership expired at 2026-10-20T14:00:00.000Z (22:00 Beijing time on Oct 20)
  f.state.now = new Date(OUTAGE_TIME);
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.membership.active, true);
  assert.equal(boot.membership.planId, 'member_30d');
  assert.equal(boot.limits.maxFollows, 4);
  assert.equal(Date.parse(boot.membership.expiresAt), Date.parse(OUTAGE_TIME) + DAY);
});

test('background monitor loadFollowUsers also extends member duration on 2026-10-21 before user opens the app', async () => {
  const f = createFixture({ start: BEFORE_OUTAGE });
  ok(await f.call('user.bootstrap'));
  await purchase(f, 'paid-7d-monitor', 'member_7d');
  ok(await f.call('follow.upsert', {
    followId: 'follow-1',
    partNumber: PRODUCTS[0].partNumber,
    storeNumbers: [STORES[0].storeNumber],
  }));
  const beforeUser = await f.repo.getUser(userKeyOf());
  const beforeExpiry = Date.parse(beforeUser.membership.expiresAt);

  f.state.now = new Date(OUTAGE_TIME);
  const follows = await f.repo.listActiveFollows();
  const users = await loadFollowUsers(f.repo, follows, f.state.now);
  const compensated = users.get(userKeyOf());
  assert.equal(Date.parse(compensated.membership.expiresAt), beforeExpiry + DAY);

  // Subsequent user.bootstrap does not double-grant
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(Date.parse(boot.membership.expiresAt), beforeExpiry + DAY);
});

test('free users opening the app on 2026-10-21 automatically receive 1-day trial membership and can upgrade cleanly', async () => {
  const f = createFixture({ start: OUTAGE_TIME });
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.membership.active, true);
  assert.equal(boot.membership.planId, 'member_trial');
  assert.equal(boot.membership.remainingMs, DAY);
  assert.equal(boot.limits.maxFollows, 3);
  assert.equal(boot.limits.maxStoresPerFollow, 3);

  // Free user with trial membership can save a follow on 2026-10-21
  const saved = ok(await f.call('follow.upsert', {
    followId: 'trial-follow-1',
    partNumber: PRODUCTS[0].partNumber,
    storeNumbers: [STORES[0].storeNumber, STORES[1].storeNumber],
  }));
  assert.equal(saved.follow.status, 'active');

  // Mine page renders 体验会员 and 1 天体验会员 · 故障补偿
  const status = ok(await f.call('member.status'));
  const rt = runtime(async action => {
    if (action === 'member.status') return status;
    return boot;
  });
  const mine = rt.instance('pages/mine/index.js');
  mine.applyBoot(boot);
  assert.equal(mine.data.membership.planLabel, '体验会员');
  assert.equal(mine.data.membership.daysLeft, 1);
  mine.setOrderRecords(status.orders);
  assert.equal(mine.data.orders[0].titleText, '1 天体验会员 · 故障补偿');

  // Purchasing a monthly plan preserves the remaining 1-day trial time and upgrades planId to member_30d
  await purchase(f, 'upgrade-from-trial', 'member_30d');
  const upgraded = ok(await f.call('user.bootstrap'));
  assert.equal(upgraded.membership.planId, 'member_30d');
  assert.equal(upgraded.limits.maxFollows, 4);
  assert.equal(upgraded.membership.remainingMs, 31 * DAY);
});

test('outage compensation and notice are active on 2026-10-21 and inactive on other dates', async t => {
  const before = createFixture({ start: BEFORE_OUTAGE });
  const bootBefore = ok(await before.call('user.bootstrap'));
  assert.equal(bootBefore.membership.active, false);
  assert.equal(bootBefore.announcement, null);
  assert.equal(bootBefore.notices.length, 0);

  const during = createFixture({ start: OUTAGE_TIME, config: { collector: { enabled: true } } });
  const bootDuring = ok(await during.call('user.bootstrap'));
  assert.equal(bootDuring.membership.active, true);
  assert.equal(bootDuring.announcement.kind, 'recovery');
  assert.equal(bootDuring.announcement.title, '服务恢复与会员时长补偿');
  assert.match(bootDuring.announcement.text, /顺延 1 天会员时长/);
  assert.match(bootDuring.announcement.text, /1 天体验会员/);

  // A dated recovery announcement is not evidence that a worker is healthy.
  // This fixture initially has no collector checkpoint, so the actual service
  // warning takes priority while the notice remains available on its board.
  let nowMs = Date.parse(OUTAGE_TIME);
  t.mock.method(Date, 'now', () => nowMs);
  const rt = runtime(async () => ({ ...bootDuring, announcement: null, notices: [] }));
  const queryPage = rt.instance('pages/query/index.js');
  queryPage.applyBoot(withOutageCompensationNotice({ ...bootDuring, announcement: null, notices: [] }, nowMs));
  assert.equal(bootDuring.collector.state, 'not_deployed');
  assert.equal(queryPage.data.queryNotice.source, 'collector');
  assert.equal(queryPage.data.queryNotice.tone, 'warn');
  assert.doesNotMatch(queryPage.data.queryNotice.text, /已恢复/);

  await during.repo.saveCollectorStatus({ state: 'running', updatedAt: OUTAGE_TIME });
  const recoveredBoot = ok(await during.call('user.bootstrap'));
  assert.equal(recoveredBoot.collector.state, 'running');
  queryPage.applyBoot(withOutageCompensationNotice({ ...recoveredBoot, announcement: null, notices: [] }, nowMs));
  assert.equal(queryPage.data.queryNotice.source, 'announcement');
  assert.equal(queryPage.data.queryNotice.tone, 'ok');
  assert.match(queryPage.data.queryNotice.text, /顺延 1 天会员时长/);

  // A new failure supersedes an older recovery message immediately.
  await during.repo.saveCollectorStatus({ state: 'error', updatedAt: OUTAGE_TIME });
  const failedAgain = ok(await during.call('user.bootstrap'));
  queryPage.applyBoot(failedAgain);
  assert.equal(queryPage.data.queryNotice.source, 'collector');
  assert.equal(queryPage.data.queryNotice.action, 'refresh');

  const boardPage = rt.instance('pages/notice-board/index.js');
  await boardPage.onLoad();
  assert.equal(boardPage.data.items.length, 1);
  assert.equal(boardPage.data.items[0].title, '服务恢复与会员时长补偿');
  boardPage.onUnload();

  // After 2026-10-21 23:59:59+08:00, neither compensation nor notice is active
  const after = createFixture({ start: AFTER_OUTAGE_DAY });
  const bootAfter = ok(await after.call('user.bootstrap'));
  assert.equal(bootAfter.membership.active, false);
  assert.equal(bootAfter.announcement, null);
  assert.equal(bootAfter.notices.length, 0);
});
