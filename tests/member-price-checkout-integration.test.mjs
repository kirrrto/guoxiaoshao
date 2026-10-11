import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userContext, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const { orderKey } = require('../cloudfunctions/gxs_api/lib/payment/service');
const { PROMOTION_ENDS_AT } = require('../cloudfunctions/gxs_api/lib/payment/plans');
const OPENID = 'oUSER000000000000000000001';
const json = data => new Response(JSON.stringify(data), { status: 200 });

function checkout({ crossDuringLogin = false, losePreparedResponse = false } = {}) {
  const f = createFixture({ config: { memberProduct: { enabled: true } }, start: new Date(Date.parse(PROMOTION_ENDS_AT) - 2000).toISOString() });
  const remote = new Map(), network = [], cashiers = [], dialogs = [];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname, body = options.body && JSON.parse(options.body);
    network.push(route);
    if (route === '/sns/jscode2session') {
      if (crossDuringLogin) { f.advance(2000); crossDuringLogin = false; }
      return json({ openid: OPENID, session_key: '9hAb/NEYUlkaMBEsmFgzig==' });
    }
    if (route === '/cgi-bin/stable_token') return json({ access_token: 'fixture-token', expires_in: 7200 });
    if (route === '/xpay/query_order') return json(remote.get(body.order_id) || { errcode: -1, errmsg: 'unknown fixture state' });
    if (route === '/xpay/notify_provide_goods') return new Response('');
    throw Error(`Unexpected network route: ${route}`);
  };
  const handle = createHandler({ repo: f.repo, fetchImpl, clock: () => f.state.now,
    paymentEnv: { GXS_CONSUMER_APPID: CONSUMER_APPID, GXS_CONSUMER_APPSECRET: 'fixture-secret', GXS_VIRTUAL_PAYMENT_APPKEY: 'fixture-appkey',
      GXS_PAYMENT_CALLBACK_TOKEN: 'FixtureCallbackToken', GXS_PAYMENT_CALLBACK_AES_KEY: Buffer.alloc(32, 5).toString('base64').slice(0, -1) },
    log: { error() {}, warn() {} } });
  const rt = runtime(async (action, payload) => {
    const result = await handle({ action, payload }, userContext());
    if (!result.ok) throw result.error;
    if (losePreparedResponse && action === 'member.createOrder' && result.data.payment) { losePreparedResponse = false; throw { code: 'call_failed' }; }
    return result.data;
  });
  rt.wx.login = options => options.success({ code: 'fixture-login' });
  rt.wx.requestVirtualPayment = options => { cashiers.push(options); options.fail({ errMsg: 'cancel' }); };
  rt.wx.showModal = options => dialogs.push(options);
  const page = rt.instance('pages/mine/index.js');
  const select = planId => page.onSelectMemberProduct({ currentTarget: { dataset: { planId } } });
  const confirm = async () => { const promise = page.onBuyMembership(); assert.ok(dialogs.length); dialogs.at(-1).success({ confirm: true }); await promise; };
  const order = id => f.repo.getOrder(orderKey(userKeyOf(), id));
  const remotePaid = (id, amount) => remote.set(orderKey(userKeyOf(), id), { errcode: 0, order: {
    order_id: orderKey(userKeyOf(), id), env_type: 1, status: 2, order_type: 0, order_fee: amount, paid_fee: amount,
    left_fee: amount, wx_order_id: `fixture-${id}`, paid_time: Math.floor(f.state.now.getTime() / 1000),
  } });
  return { ...f, rt, page, select, confirm, order, cashiers, dialogs, network, remotePaid };
}

test('real server products preserve refund and renewal terms in each actual page confirmation', async () => {
  const f = checkout(); await f.page.onLoad();
  for (const id of ['member_7d', 'member_30d', 'member_365d']) {
    f.select(id);
    const buying = f.page.onBuyMembership(), dialog = f.dialogs.at(-1);
    assert.match(f.page.data.boot.purchaseNotice, /一次性虚拟服务.*一经售出不予退款/);
    assert.match(dialog.content, /一次性虚拟服务.*一经售出不予退款/);
    assert.match(dialog.content, /不自动续费/);
    dialog.success({ confirm: false }); await buying;
  }
  assert.equal(f.rt.calls.some(value => value.action === 'member.createOrder'), false);
  assert.equal(f.network.length, 0); assert.equal(f.cashiers.length, 0);
  f.page.onUnload();
});

test('real page and service discard an unissued expired quote, re-confirm standard price, then pass the exact new server signature', async () => {
  const f = checkout({ crossDuringLogin: true }); await f.page.onLoad(); f.select('member_30d');
  await f.confirm();
  const first = f.rt.calls.find(value => value.action === 'member.createOrder');
  assert.equal(first.payload.expectedPriceFen, 1499);
  assert.equal(f.cashiers.length, 0); assert.equal(f.page.data.paymentPendingId, '');
  assert.equal(f.page.data.boot.priceText, '¥30.00'); assert.match(f.page.data.paymentError, /重新确认/);
  const cancelled = await f.order(first.payload.orderId);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.paymentPreparedAt, null); assert.equal(cancelled.amountFen, 1499);
  await f.confirm();
  const creates = f.rt.calls.filter(value => value.action === 'member.createOrder');
  assert.equal(creates.length, 2); assert.notEqual(creates[1].payload.orderId, first.payload.orderId);
  assert.equal(creates[1].payload.expectedPriceFen, 3000);
  assert.match(f.dialogs.at(-1).content, /30 天会员 · ¥30\.00/);
  assert.doesNotMatch(f.dialogs.at(-1).content, /14\.99|优惠至/);
  assert.equal(f.cashiers.length, 1);
  const signed = JSON.parse(f.cashiers[0].signData);
  assert.equal(signed.goodsPrice, 3000); assert.equal(Object.hasOwn(signed, 'activitySellingPrice'), false);
  assert.equal((await f.order(creates[1].payload.orderId)).amountFen, 3000);
  f.page.onUnload();
});

test('a lost already-prepared response stays recoverable after the cutoff and grants only the original confirmed amount', async () => {
  const f = checkout({ losePreparedResponse: true }); await f.page.onLoad(); f.select('member_30d');
  await f.confirm();
  const id = f.page.data.paymentPendingId, created = await f.order(id);
  assert.ok(id); assert.ok(created.paymentPreparedAt); assert.equal(created.amountFen, 1499);
  assert.equal(created.paymentSnapshot.goodsPrice, 3000); assert.equal(created.paymentSnapshot.activitySellingPrice, 1499);
  f.advance(3000); await f.page.refresh({ quiet: true, force: true });
  assert.equal(f.page.data.boot.priceText, '¥30.00');
  await f.page.onCheckPayment();
  assert.equal(f.page.data.paymentPendingId, id); assert.equal(f.cashiers.length, 0);
  assert.equal(f.rt.calls.filter(value => value.action === 'member.createOrder').length, 1);
  assert.equal((await f.order(id)).status, 'created');
  f.remotePaid(id, 1499); await f.page.onCheckPayment();
  assert.equal(f.page.data.paymentPendingId, ''); assert.equal(f.page.data.membership.active, true);
  assert.equal((await f.order(id)).amountFen, 1499); assert.equal((await f.order(id)).status, 'fulfilled');
  assert.equal(f.cashiers.length, 0); assert.equal(f.network.filter(route => route === '/sns/jscode2session').length, 1);
  f.page.onUnload();
});
