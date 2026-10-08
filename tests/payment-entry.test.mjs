import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFixture, userKeyOf, CONSUMER_APPID, userContext } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createPaymentEntry, isTrustedPaymentTimer, TRIGGER_NAME, LEASE_ID } = require('../cloudfunctions/gxs_api/lib/payment/entry');
const { createVirtualPaymentProvider } = require('../cloudfunctions/gxs_api/lib/payment/virtual-payment');
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const APPID = CONSUMER_APPID, OPENID = userContext().FROM_OPENID;
const OUT = `G${createHash('sha256').update(`${userKeyOf()}|checkout-0001`).digest('hex').slice(0, 31)}`;
const TOKEN = 'EntryTestToken';
const AES = Buffer.alloc(32, 29).toString('base64').slice(0, -1);
const env = { GXS_CONSUMER_APPID: APPID, GXS_CONSUMER_APPSECRET: 'offline-test-secret', GXS_VIRTUAL_PAYMENT_APPKEY: 'offline-app-key',
  GXS_PAYMENT_CALLBACK_TOKEN: TOKEN, GXS_PAYMENT_CALLBACK_AES_KEY: AES, GXS_ENABLE_PAYMENT_RECONCILE: 'true' };
const providerConfig = { enabled: false, offerId: '1450655203', productId: 'vip666', priceFen: 700, days: 7 };
const timerEvent = () => ({ Type: 'Timer', TriggerName: TRIGGER_NAME });
const timerContext = () => ({ SOURCE: 'wx_trigger' });
const hash = parts => createHash('sha1').update(parts.sort().join('')).digest('hex');
const query = { timestamp: '1790000000', nonce: '98765' };
function callbackRequest({ overrides = {}, innerAppid = APPID, refund = false, ios = false } = {}) {
  const fields = { openid: OPENID, outTradeNo: OUT, product: 'vip666', amount: '700', quantity: '1', env: '0', attach: OUT, refundId: 'refund-one', refundAmount: '350', refundResult: '0', ...overrides };
  const pay = ios ? '' : '<WeChatPayInfo><MchOrderNo>platform-order-001</MchOrderNo><TransactionId>wxpay-001</TransactionId></WeChatPayInfo>';
  const xml = refund
    ? `<xml><MsgType>event</MsgType><Event>xpay_refund_notify</Event><OpenId>${fields.openid}</OpenId><MchOrderId>${fields.outTradeNo}</MchOrderId><WxOrderId>platform-order-001</WxOrderId><WxRefundId>${fields.refundId}</WxRefundId><RefundFee>${fields.refundAmount}</RefundFee><RetCode>${fields.refundResult}</RetCode></xml>`
    : `<xml><MsgType>event</MsgType><Event>xpay_goods_deliver_notify</Event><OpenId>${fields.openid}</OpenId><OutTradeNo>${fields.outTradeNo}</OutTradeNo><Env>${fields.env}</Env>${pay}<GoodsInfo><ProductId>${fields.product}</ProductId><OrigPrice>${fields.amount}</OrigPrice><ActualPrice>${fields.amount}</ActualPrice><Quantity>${fields.quantity}</Quantity><Attach>${fields.attach}</Attach></GoodsInfo></xml>`;
  const key = Buffer.from(`${AES}=`, 'base64'), payload = Buffer.from(xml), length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
  const raw = Buffer.concat([Buffer.alloc(16, 23), length, payload, Buffer.from(innerAppid)]), padding = 32 - raw.length % 32;
  const encryptor = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); encryptor.setAutoPadding(false);
  const encrypted = Buffer.concat([encryptor.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), encryptor.final()]).toString('base64');
  return { path: '/payment/callback', httpMethod: 'POST', queryStringParameters: { ...query, encrypt_type: 'aes', msg_signature: hash([TOKEN, query.timestamp, query.nonce, encrypted]) }, body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` };
}
async function harness(options = {}) {
  const f = createFixture(); await f.call('user.bootstrap');
  const order = { _id: OUT, orderId: 'checkout-0001', outTradeNo: OUT, type: 'membership_order', provider: 'wechat_virtual_payment', source: 'virtual_payment',
    userKey: userKeyOf(), appid: APPID, openid: OPENID, status: 'created', amountFen: 700, days: 7, productId: 'vip666', createdAt: f.state.now.toISOString(), lastReconciledAt: '1970-01-01T00:00:00.000Z',
    paymentSnapshot: { version: 1, provider: 'wechat_virtual_payment', appid: APPID, offerId: '1450655203', productId: 'vip666', priceFen: 700, days: 7, currency: 'CNY', env: 0, buyQuantity: 1 } };
  await f.repo.saveOrder(order);
  const calls = [], actions = [], logs = [];
  const provider = createVirtualPaymentProvider({ config: providerConfig, expectedAppid: APPID, env, fetchImpl: async () => { throw new Error('unexpected network call'); } });
  const reconcileOrderImpl = options.realService ? undefined : options.reconcile || (async (ctx, row, opts) => {
    calls.push({ id: row._id, opts, nowIso: ctx.nowIso });
    await ctx.repo.markOrderPaid({ orderId: row._id, nowIso: ctx.nowIso, transactionId: `platform-${row._id}`, providerData: { amountFen: 700 } });
    await ctx.repo.fulfilMembershipOrder({ orderId: row._id, nowIso: ctx.nowIso, source: 'virtual_payment' });
    return { order: await ctx.repo.getOrder(row._id), providerState: 'fulfilled' };
  });
  const entry = createPaymentEntry({ repo: f.repo, clock: () => new Date(f.state.now), env: { ...env, ...options.env }, paymentProvider: provider, reconcileOrderImpl,
    log: { warn: (...args) => logs.push(args) }, handleAction: async (...args) => { actions.push(args); return { normal: true }; } });
  return { ...f, entry, order, calls, actions, logs, provider };
}

test('malformed raw query encoding returns a denied HTTP response without touching orders or ordinary actions', async () => {
  const f = await harness();
  for (const field of ['queryStringParameters', 'queryString', 'query', 'multiValueQueryStringParameters']) {
    for (const httpMethod of ['GET', 'POST']) {
      for (const query of ['signature=%', 'nonce=%E0%A4%A', '%=x']) {
        const result = await f.entry({ path: '/payment/callback', httpMethod, [field]: query });
        assert.equal(result.statusCode, 403);
        assert.equal(result.body, 'forbidden');
      }
    }
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.actions.length, 0);
  assert.equal((await f.repo.getOrder(OUT)).status, 'created');
});

test('HTTP only exposes the exact callback path and never routes action/body fields to admin or user handlers', async () => {
  const f = await harness();
  for (const event of [
    { httpMethod: 'POST', path: '/', action: 'admin.updateConfig' },
    { httpMethod: 'POST', path: '/payment/callback/', action: 'member.createOrder' },
    { httpMethod: '', action: 'admin.grantMembership' },
    { requestContext: {}, action: 'system.ping' },
    { rawPath: '/payment/callback', path: '/other', httpMethod: 'POST', action: 'admin.updateConfig' },
    { ...callbackRequest(), body: JSON.stringify({ action: 'admin.updateConfig', payload: {} }) },
  ]) assert.equal((await f.entry(event, {}, { SOURCE: 'wx_devtools' })).statusCode, 403);
  assert.equal(f.actions.length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.entry({ path: '/payment/callback', httpMethod: 'PUT' })).statusCode, 405);
});

test('GET returns only a correctly signed echo and never performs order work even when purchases are disabled', async () => {
  const f = await harness(), valid = { ...query, echostr: 'exact-echo', signature: hash([TOKEN, query.timestamp, query.nonce]) };
  const result = await f.entry({ path: '/payment/callback', httpMethod: 'GET', queryStringParameters: valid });
  assert.equal(result.statusCode, 200); assert.equal(result.body, 'exact-echo'); assert.equal(f.calls.length, 0);
  assert.equal((await f.entry({ path: '/payment/callback', httpMethod: 'GET', queryStringParameters: { ...valid, signature: '0'.repeat(40) } })).statusCode, 403);
  assert.equal((await f.entry({ path: '/payment/callback', httpMethod: 'get', queryString: { timestamp: 1790000000, nonce: '98765', echostr: 'exact-echo', signature: valid.signature } })).body, 'exact-echo');
  assert.equal((await f.entry({ path: '/payment/callback?echostr=ignored', httpMethod: 'GET', queryStringParameters: valid })).body, 'exact-echo');
  const denied = await f.entry({ path: '/payment/callback', httpMethod: 'GET', queryString: { timestamp: '1790000000', nonce: '98765', echostr: 'exact-echo', Signature: '0'.repeat(40) } });
  assert.equal(denied.statusCode, 403);
  assert.equal(f.logs.at(-1)[1].stage, 'verification');
  assert.equal(f.logs.at(-1)[1].code, 'payment_callback_invalid_signature');
  assert.deepEqual(f.logs.at(-1)[1].queryFields, ['signature', 'timestamp', 'nonce', 'echostr']);
  assert.equal(JSON.stringify(f.logs.at(-1)[1]).includes('exact-echo'), false);
});

test('GET echo succeeds when EncodingAESKey is invalid because URL verification only uses Token', async () => {
  const f = await harness();
  const broken = createVirtualPaymentProvider({
    config: providerConfig, expectedAppid: APPID, env: { ...env, GXS_PAYMENT_CALLBACK_AES_KEY: 'invalid' },
    fetchImpl: async () => { throw new Error('unexpected network call'); },
  });
  const entry = createPaymentEntry({
    repo: f.repo, clock: () => new Date(f.state.now), env, paymentProvider: broken,
    log: { warn: (...args) => f.logs.push(args) }, handleAction: async () => ({ normal: true }),
  });
  const valid = { ...query, echostr: 'exact-echo', signature: hash([TOKEN, query.timestamp, query.nonce]) };
  const echoed = await entry({ path: '/payment/callback', httpMethod: 'GET', queryStringParameters: valid });
  assert.equal(echoed.statusCode, 200); assert.equal(echoed.body, 'exact-echo');
  assert.equal((await entry(callbackRequest())).statusCode, 403);
  assert.equal(f.logs.at(-1)[1].code, 'payment_callback_aes_key_missing');
});

test('an authentic safe-mode delivery calls authoritative reconciliation and acknowledges only after durable fulfilment', async () => {
  const f = await harness();
  const result = await f.entry(callbackRequest());
  assert.equal(result.statusCode, 200); assert.equal(result.body, 'success'); assert.match(result.headers['Content-Type'], /text\/plain/);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].opts, { acknowledge: false });
  assert.equal((await f.repo.getOrder(OUT)).status, 'fulfilled');
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, '2026-09-22T02:00:00.000Z');
  assert.equal(f.provider.getReadiness().ready, false, 'disabling checkout does not disable in-flight notifications');
});

for (const [planId, days, amount] of [['member_30d', 30, 1990], ['member_365d', 365, 20000]]) {
  test(`authenticated callbacks fulfil ${planId} from its immutable snapshot even when checkout is disabled`, async () => {
    const f = await harness();
    const productId = `test-callback-goods-${days}`;
    await f.repo.saveOrder({ ...f.order, planId, amountFen: amount, days, productId,
      paymentSnapshot: { ...f.order.paymentSnapshot, version: 2, planId, priceFen: amount, days, productId } });
    let queries = 0;
    const entry = createPaymentEntry({ repo: f.repo, env, clock: () => new Date(f.state.now),
      fetchImpl: async url => {
        if (url.includes('/cgi-bin/stable_token')) return new Response(JSON.stringify({ access_token: 'test-callback-token', expires_in: 7200 }));
        assert.ok(url.includes('/xpay/query_order')); queries++;
        return new Response(JSON.stringify({ errcode: 0, order: { order_id: OUT, wx_order_id: 'platform-order-001', status: 2,
          order_type: 0, env_type: 1, order_fee: amount, paid_fee: amount, left_fee: amount } }));
      }, log: { warn() {} }, handleAction: async () => { throw new Error('unexpected user action'); } });
    const request = callbackRequest({ overrides: { product: productId, amount: String(amount) } });
    assert.equal((await entry(request)).body, 'success');
    assert.equal((await entry(request)).body, 'success');
    assert.equal(queries, 2);
    assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, new Date(f.state.now.getTime() + days * 86400000).toISOString());
    assert.equal((await f.repo.getOrder(OUT)).amountFen, amount);
  });
}

test('signature, decrypted appid, buyer, merchant order, goods and snapshot mismatches cannot reach reconciliation', async () => {
  const f = await harness(), request = callbackRequest(); request.queryStringParameters.msg_signature = '0'.repeat(40);
  for (const bad of [request, callbackRequest({ innerAppid: 'wx0000000000000000' }),
    ...[{ openid: 'another-buyer' }, { outTradeNo: 'Gnotfound1234' }, { product: 'other' }, { amount: '1' }, { quantity: '2' }, { env: '1' }, { attach: 'other' }].map(overrides => callbackRequest({ overrides }))]) {
    assert.equal((await f.entry(bad)).statusCode, 403);
  }
  await f.repo.updateOrder(OUT, { userKey: `${APPID}:other` });
  assert.equal((await f.entry(callbackRequest())).statusCode, 403);
  assert.equal(f.calls.length, 0); assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, null);
});

test('iOS delivery without WeChatPayInfo and refunds without goods fields still require authoritative reconciliation', async () => {
  const f = await harness({ reconcile: async (ctx, row, opts) => {
    assert.equal(opts.acknowledge, false);
    await ctx.repo.markOrderPaid({ orderId: row._id, transactionId: 'platform-order-001', nowIso: ctx.nowIso, providerData: { amountFen: 700 } });
    await ctx.repo.fulfilMembershipOrder({ orderId: row._id, source: 'virtual_payment', nowIso: ctx.nowIso });
    return { order: await ctx.repo.getOrder(row._id), providerState: 'fulfilled' };
  } });
  assert.equal((await f.entry(callbackRequest({ ios: true }))).statusCode, 200);
  await f.repo.markOrderRefunded({ orderId: OUT, refundFen: 350, nowIso: f.state.now.toISOString() });
  assert.equal((await f.entry(callbackRequest({ refund: true }))).statusCode, 200);
});

test('refund success waits for query-confirmed money and distinct refund IDs cannot share the same confirmed amount', async () => {
  let confirmed = 0;
  const f = await harness({ reconcile: async (ctx, row) => {
    await ctx.repo.markOrderPaid({ orderId: row._id, transactionId: 'platform-order-001', nowIso: ctx.nowIso, providerData: { amountFen: 700 } });
    await ctx.repo.fulfilMembershipOrder({ orderId: row._id, source: 'virtual_payment', nowIso: ctx.nowIso });
    if (confirmed) await ctx.repo.markOrderRefunded({ orderId: row._id, refundFen: confirmed, nowIso: ctx.nowIso });
    return { order: await ctx.repo.getOrder(row._id) };
  } });
  const first = callbackRequest({ refund: true }), second = callbackRequest({ refund: true, overrides: { refundId: 'refund-two' } });
  assert.equal((await f.entry(first)).statusCode, 503, 'query has not yet reflected the signed refund');
  assert.equal((await f.repo.getOrder(OUT)).refundCallbacks, undefined);
  confirmed = 350;
  assert.equal((await f.entry(first)).body, 'success');
  assert.equal((await f.entry(first)).body, 'success', 'same refund ID replays without counting money twice');
  assert.equal((await f.entry(second)).statusCode, 503, 'a second 350 fen callback cannot reuse the first refund coverage');
  assert.equal((await f.repo.getOrder(OUT)).refundCallbacks.length, 1);
  confirmed = 700;
  assert.equal((await f.entry(second)).body, 'success');
  assert.equal((await f.repo.getOrder(OUT)).refundCallbacks.length, 2);
});

test('failed refund events synchronize payment but do not record successful refund money or revoke membership', async () => {
  const f = await harness({ reconcile: async (ctx, row) => {
    await ctx.repo.markOrderPaid({ orderId: row._id, transactionId: 'platform-order-001', nowIso: ctx.nowIso, providerData: { amountFen: 700 } });
    await ctx.repo.fulfilMembershipOrder({ orderId: row._id, source: 'virtual_payment', nowIso: ctx.nowIso });
    return { order: await ctx.repo.getOrder(row._id) };
  } });
  assert.equal((await f.entry(callbackRequest({ refund: true, overrides: { refundResult: '-1' } }))).body, 'success');
  const order = await f.repo.getOrder(OUT);
  assert.equal(order.refundCallbacks, undefined); assert.equal(order.refundFen, undefined);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, '2026-09-22T02:00:00.000Z');
});

test('refund receipt accounting is atomic, rejects changed IDs and rolls back a failed receipt write', async () => {
  const f = await harness(), nowIso = f.state.now.toISOString();
  await f.repo.updateOrder(OUT, { status: 'partially_refunded', refundFen: 350 });
  const confirm = (id, amount = 350) => f.repo.confirmPaymentRefundCallback({ orderId: OUT, refundId: id, refundFen: amount, nowIso });
  const results = await Promise.all([confirm('one'), confirm('two')]);
  assert.equal(results.filter(row => row.confirmed).length, 1);
  await assert.rejects(confirm('one', 175), error => error.code === 'payment_refund_callback_conflict');
  await f.repo.updateOrder(OUT, { status: 'refunded', refundFen: 700 });
  f.repo.transactionWriteHook = async table => { if (table === C.orders) throw new Error('storage unavailable'); };
  await assert.rejects(confirm('two'), /storage unavailable/);
  assert.equal((await f.repo.getOrder(OUT)).refundCallbacks.length, 1);
  f.repo.transactionWriteHook = null;
  assert.equal((await confirm('two')).confirmed, true);
  assert.equal((await confirm('two')).replayed, true);
  for (const [id, amount] of [['x'.repeat(257), 1], ['zero', 0], ['negative', -1], ['fraction', 0.5]]) {
    await assert.rejects(confirm(id, amount), error => error.code === 'invalid_refund_callback');
  }
  assert.equal((await confirm('extra-money', 1)).confirmed, false, 'completed refund amount cannot back any additional ID');
  assert.equal((await f.repo.getOrder(OUT)).refundCallbacks.length, 2);
});

test('duplicate callbacks query again but cannot grant twice, while query or persistence failures return retry without leaking details', async () => {
  const f = await harness();
  const request = callbackRequest({ ios: true });
  assert.equal((await f.entry(request)).body, 'success'); assert.equal((await f.entry(request)).body, 'success');
  assert.equal(f.calls.length, 2); assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, '2026-09-22T02:00:00.000Z');
  const broken = await harness({ reconcile: async () => { throw new Error('https://secret?access_token=private OPENID test-secret'); } });
  const retry = await broken.entry(callbackRequest());
  assert.equal(retry.statusCode, 503); assert.equal(retry.body, 'retry');
  assert.doesNotMatch(JSON.stringify({ retry, logs: broken.logs }), /access_token|OPENID|private|test-secret/);
  assert.equal((await broken.repo.getUser(userKeyOf())).membership.expiresAt, null);
});

test('unpaid and absent query evidence is not acknowledged as delivery, but a confirmed fully refunded order is terminal', async () => {
  for (const state of ['created', 'not_found', 'pending']) {
    const f = await harness({ reconcile: async (_, row) => ({ order: row, providerState: state }) });
    assert.equal((await f.entry(callbackRequest())).statusCode, 503);
  }
  const f = await harness({ reconcile: async (ctx, row) => {
    await ctx.repo.markOrderRefunded({ orderId: row._id, refundFen: 700, nowIso: ctx.nowIso });
    return { order: await ctx.repo.getOrder(row._id), providerState: 'refunded' };
  } });
  assert.equal((await f.entry(callbackRequest())).body, 'success');
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, null);
});

test('trusted timer markers are restricted to SDK and invocation context, never caller event or user-origin source chains', async () => {
  const event = timerEvent();
  assert.equal(isTrustedPaymentTimer(event, { SOURCE: 'wx_trigger' }), true);
  assert.equal(isTrustedPaymentTimer(event, { SOURCE: 'wx_trigger,scf' }), true);
  assert.equal(isTrustedPaymentTimer(event, {}, { TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF', invocationScoped: true }), true);
  assert.equal(isTrustedPaymentTimer(event, {}, { TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF' }), false, 'process.env TRIGGER_SRC alone never grants trust');
  for (const source of ['wx_client', 'wx_client,scf', 'wx_devtools', 'wx_localdebug', 'scf', 'wx_trigger,wx_client']) {
    assert.equal(isTrustedPaymentTimer(event, { SOURCE: source }, { TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF', TCB_SOURCE: 'wx_trigger', invocationScoped: true }), false);
  }
  for (const field of ['OPENID', 'FROM_OPENID', 'FROM_APPID']) assert.equal(isTrustedPaymentTimer(event, { SOURCE: 'wx_trigger', [field]: 'user' }), false);
  for (const field of ['WX_OPENID', 'WX_FROM_OPENID', 'WX_FROM_APPID', 'FROM_OPENID', 'FROM_APPID']) assert.equal(isTrustedPaymentTimer(event, { SOURCE: 'wx_trigger' }, { [field]: 'user' }), false);
  assert.equal(isTrustedPaymentTimer({ ...event, TriggerName: 'other' }, timerContext()), false);
  assert.equal(isTrustedPaymentTimer({ ...event, httpMethod: '' }, timerContext()), false);
  assert.equal(isTrustedPaymentTimer(event, {}, { invalidContext: true }), false);
  const f = await harness();
  for (const forged of [event, { ...event, SOURCE: 'wx_trigger', TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF' }]) assert.equal((await f.entry(forged)).reason, 'timer_only');
  assert.equal(f.calls.length, 0); assert.equal(f.actions.length, 0);
});

test('invocation-specific runtime overrides stale environment markers and disabled reconcile performs no scan', async () => {
  const f = await harness({ env: { TCB_SOURCE: 'wx_trigger', TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF' } });
  const rejected = await f.entry(timerEvent(), { environment: JSON.stringify({ TCB_SOURCE: 'wx_client', TRIGGER_SRC: 'client' }) });
  assert.equal(rejected.reason, 'timer_only'); assert.equal(f.calls.length, 0);
  const disabled = await harness({ env: { GXS_ENABLE_PAYMENT_RECONCILE: 'false' } });
  assert.equal((await disabled.entry(timerEvent(), {}, timerContext())).state, 'process_disabled');
  assert.equal(disabled.calls.length, 0);
  assert.equal(disabled.repo.tables.get(C.config).has(LEASE_ID), false);
});

test('warm invocation rereads a replaced process.env object and cannot inherit an earlier client identity or enable flag', async () => {
  const previous = process.env, f = await harness();
  try {
    process.env = { TCB_SOURCE: 'wx_client', WX_OPENID: 'earlier-client', GXS_ENABLE_PAYMENT_RECONCILE: 'true' };
    const entry = createPaymentEntry({ repo: f.repo, clock: () => new Date(f.state.now), paymentProvider: f.provider,
      log: { warn() {} }, handleAction: async () => ({}) });
    process.env = { TCB_SOURCE: 'wx_trigger', TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF', GXS_ENABLE_PAYMENT_RECONCILE: 'false' };
    const result = await entry(timerEvent(), {}, { SOURCE: 'wx_trigger' });
    assert.equal(result.state, 'process_disabled');
    assert.equal(f.repo.tables.get(C.config).has(LEASE_ID), false);
    // A later real client must not inherit the previous timer's authorization.
    process.env = { TCB_SOURCE: 'wx_client', TRIGGER_SRC: 'client', WX_OPENID: 'current-client', GXS_ENABLE_PAYMENT_RECONCILE: 'false' };
    assert.equal((await entry(timerEvent(), {}, { SOURCE: 'wx_client', OPENID: 'current-client' })).reason, 'timer_only');
  } finally { process.env = previous; }
});

test('disabled timer rejection diagnostics expose only allowlisted classes, names and identity-presence booleans', async () => {
  const f = await harness({ env: { GXS_ENABLE_PAYMENT_RECONCILE: 'false' } });
  const context = { request_id: 'secret-request-value', customSecretName: 'secret-value', environment: JSON.stringify({
    TCB_SOURCE: 'unexpected-source-secret', TRIGGER_SRC: 'unexpected-trigger-secret', TENCENTCLOUD_RUNENV: 'unexpected-runtime-secret',
    WX_OPENID: 'secret-openid', WX_FROM_APPID: 'secret-appid', GXS_CONSUMER_APPSECRET: 'secret-credential',
  }) };
  assert.equal((await f.entry(timerEvent(), context, { SOURCE: 'wx_client', FROM_OPENID: 'secret-sdk-openid' })).reason, 'timer_only');
  assert.equal(f.logs.length, 1);
  const diagnostic = f.logs[0][1];
  assert.equal(diagnostic.sdkSource, 'wx_client'); assert.equal(diagnostic.runtimeSource, 'other');
  assert.equal(diagnostic.sdkHasFromOpenid, true); assert.equal(diagnostic.runtimeHasOpenid, true); assert.equal(diagnostic.runtimeHasFromAppid, true);
  assert.equal(diagnostic.triggerSource, 'other'); assert.equal(diagnostic.runEnvironment, 'other');
  assert.deepEqual(diagnostic.contextKeys, ['request_id', 'environment']);
  assert.ok(diagnostic.environmentKeys.includes('TCB_SOURCE'));
  assert.doesNotMatch(JSON.stringify(f.logs), /secret|GXS_CONSUMER_APPSECRET|customSecretName/);
  const enabled = await harness();
  assert.equal((await enabled.entry(timerEvent(), context)).reason, 'timer_only');
  assert.deepEqual(enabled.logs, [], 'production enabled path does not emit diagnostic metadata');
});

test('an explicit per-invocation timer marker clears prior admin SDK and environment identities in a mixed warm container', async () => {
  const f = await harness({ env: { GXS_ENABLE_PAYMENT_RECONCILE: 'false', TCB_SOURCE: 'wx_devtools',
    TRIGGER_SRC: 'client', TENCENTCLOUD_RUNENV: 'SCF', WX_FROM_OPENID: 'previous-admin-openid', WX_FROM_APPID: 'previous-consumer-app' } });
  const staleSdk = { SOURCE: 'wx_devtools', FROM_OPENID: 'previous-admin-openid', FROM_APPID: 'previous-consumer-app' };
  for (const context of [
    { environment: { TRIGGER_SRC: 'timer' }, environ: 'TRIGGER_SRC=timer' },
    { environment: JSON.stringify({ TRIGGER_SRC: 'timer' }) },
    { environ: 'TRIGGER_SRC=timer' },
  ]) {
    assert.equal((await f.entry(timerEvent(), context, staleSdk)).state, 'process_disabled');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.repo.tables.get(C.config).has(LEASE_ID), false);
  assert.equal((await f.entry({ ...timerEvent(), TRIGGER_SRC: 'timer', environment: { TRIGGER_SRC: 'timer' } }, {}, staleSdk)).reason, 'timer_only', 'event fields cannot become platform invocation context');
});

test('an anonymous cloud-API invocation cannot inherit the preceding real timer marker left in a warm process.env', async () => {
  // Observed on 2026-09-20: after a real trigger ran, process.env kept
  // TRIGGER_SRC=timer and a console/API invoke carried no identity at all.
  const f = await harness({ env: { GXS_ENABLE_PAYMENT_RECONCILE: 'false', TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF' } });
  const anonymousSdk = { SOURCE: undefined, OPENID: undefined, FROM_OPENID: undefined, FROM_APPID: undefined };
  for (const context of [{}, { request_id: 'api-call' }, { environment: '{}' }, { environment: {} }, { environ: '' }, { environment: JSON.stringify({ TENCENTCLOUD_RUNENV: 'SCF' }) }]) {
    assert.equal((await f.entry(timerEvent(), context, anonymousSdk)).reason, 'timer_only');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.repo.tables.get(C.config).has(LEASE_ID), false);
  assert.ok(f.logs.length >= 1); assert.equal(f.logs[0][1].invocationScoped, false); assert.equal(f.logs[0][1].triggerSource, 'timer');
  // The very same warm environment still serves the next real trigger.
  assert.equal((await f.entry(timerEvent(), { environment: JSON.stringify({ TRIGGER_SRC: 'timer' }) }, anonymousSdk)).state, 'process_disabled');
});

test('per-invocation marker does not allow explicit user identities, client sources, conflicting formats or non-SCF execution', async () => {
  const f = await harness({ env: { GXS_ENABLE_PAYMENT_RECONCILE: 'false', TCB_SOURCE: 'wx_trigger', TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF' } });
  for (const markers of [
    { TRIGGER_SRC: 'client' }, { TRIGGER_SRC: 'timer', TCB_SOURCE: 'wx_client' }, { TRIGGER_SRC: 'timer', SOURCE: 'wx_client' },
    { TRIGGER_SRC: 'timer', WX_OPENID: 'current-user' }, { TRIGGER_SRC: 'timer', OPENID: 'current-user' },
    { TRIGGER_SRC: 'timer', WX_FROM_OPENID: 'current-user' }, { TRIGGER_SRC: 'timer', FROM_OPENID: 'current-user' },
    { TRIGGER_SRC: 'timer', WX_FROM_APPID: 'current-app' }, { TRIGGER_SRC: 'timer', FROM_APPID: 'current-app' },
    { TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'LOCAL' },
  ]) assert.equal((await f.entry(timerEvent(), { environment: markers }, { SOURCE: 'wx_trigger' })).reason, 'timer_only');
  for (const context of [
    { environment: { TRIGGER_SRC: 'timer' }, environ: 'TRIGGER_SRC=client' },
    { environment: { TRIGGER_SRC: 'timer' }, environ: 'TCB_SOURCE=wx_client' },
    { environment: '{broken', environ: 'TRIGGER_SRC=timer' },
    { environment: { TRIGGER_SRC: 'timer' }, environ: 'TRIGGER_SRC=timer;TRIGGER_SRC=client' },
  ]) assert.equal((await f.entry(timerEvent(), context, {})).reason, 'timer_only');
  assert.equal(f.calls.length, 0);
});

test('timer holds a global lease, prevents concurrent scans, and acknowledges recovered deliveries', async () => {
  let unblock, enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const waiting = new Promise(resolve => { unblock = resolve; });
  const f = await harness({ reconcile: async (_, __, opts) => { assert.equal(opts.acknowledge, true); enteredResolve(); await waiting; return {}; } });
  const first = f.entry(timerEvent(), {}, timerContext()); await entered;
  const second = await f.entry(timerEvent(), {}, timerContext());
  assert.equal(second.state, 'standby'); assert.equal(second.scanned, 0);
  unblock(); const result = await first;
  assert.equal(result.scanned, 1); assert.equal(result.reconciled, 1);
  assert.equal(f.repo.tables.get(C.config).get(LEASE_ID).expiresAt, '1970-01-01T00:00:00.000Z');
});

test('timer limits work by count and available call budget, rotates failed orders and releases its lease', async () => {
  const f = await harness({ reconcile: async ctx => { ctx.clock(); f.advance(14000); throw new Error('upstream-private-details'); } });
  await f.repo.saveOrder({ ...f.order, _id: `${OUT}b`, outTradeNo: 'Ganotherorder123' });
  const result = await f.entry(timerEvent(), {}, timerContext());
  assert.equal(result.scanned, 1); assert.equal(result.failed, 1); assert.equal(result.deadlineReached, true);
  assert.equal((await f.repo.getOrder(OUT)).lastReconciledAt, f.state.now.toISOString());
  assert.equal(f.repo.tables.get(C.config).get(LEASE_ID).expiresAt, '1970-01-01T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(f.logs), /upstream-private-details/);
  const many = await harness({ reconcile: async () => ({}) });
  for (let i = 0; i < 30; i++) await many.repo.saveOrder({ ...many.order, _id: `extra-${String(i).padStart(2, '0')}`, outTradeNo: `Gextraorder${i}` });
  assert.equal((await many.entry(timerEvent(), {}, timerContext())).scanned, 10);
});

test('normal mini-program actions retain only SDK identity and request context through the real index adapter', async () => {
  const f = await harness(), event = { action: 'user.bootstrap', payload: { SOURCE: 'wx_trigger' } }, trusted = userContext(), runtime = { request_id: 'request-test' };
  assert.deepEqual(await f.entry(event, runtime, trusted), { normal: true });
  assert.deepEqual(f.actions[0], [event, trusted, runtime]);
  const exports = {}, received = [];
  vm.runInNewContext(fs.readFileSync(new URL('../cloudfunctions/gxs_api/index.js', import.meta.url), 'utf8'), {
    exports, globalThis: { fetch: () => {} }, require: name => {
      if (name === 'wx-server-sdk') return { init() {}, database: () => ({}), getWXContext: () => trusted };
      if (name === './lib/repo/cloudbase-repo') return { createCloudbaseRepo: () => ({}) };
      if (name === './lib/request-budget') return require('../cloudfunctions/gxs_api/lib/request-budget');
      if (name === './lib/app') return { createHandler: () => () => ({ normal: true }) };
      if (name === './lib/payment/entry') return { createPaymentEntry: () => (...args) => { received.push(args); return 'entry-result'; } };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  assert.equal(await exports.main(event, runtime), 'entry-result');
  assert.deepEqual(received[0], [event, runtime, trusted]);
});

test('reconcile selection excludes nonpayment grants and terminal orders, includes partial refunds, and rotates oldest checks', async () => {
  const f = await harness(), nowIso = f.state.now.toISOString();
  for (const [id, patch] of [
    ['partial', { status: 'partially_refunded' }], ['paid', { status: 'paid' }],
    ['refund', { status: 'refunded' }], ['cancel', { status: 'cancelled' }],
    ['redeem', { provider: undefined, source: 'redemption_code', status: 'fulfilled' }],
    ['old-ack', { status: 'fulfilled', providerAcknowledgedAt: nowIso, fulfilledAt: '2026-01-01T00:00:00.000Z' }],
    ['old-unacked', { status: 'fulfilled', fulfilledAt: '2026-01-01T00:00:00.000Z' }],
    ['recent', { status: 'fulfilled', providerAcknowledgedAt: nowIso, fulfilledAt: nowIso, lastReconciledAt: nowIso }],
  ]) await f.repo.saveOrder({ ...f.order, _id: id, outTradeNo: `G-${id}`, ...patch });
  const rows = await f.repo.listReconcileOrders({ limit: 25, nowIso });
  assert.deepEqual(rows.map(row => row._id), [OUT, 'old-unacked', 'paid', 'partial', 'recent']);
  assert.equal((await f.repo.listReconcileOrders({ limit: 2, nowIso })).length, 2);
});

test('CloudBase reconcile selection sends a bounded sorted query without a full-table scan', async () => {
  const operations = [], node = (op, value) => ({ op, value });
  const db = { command: { and: value => node('and', value), or: value => node('or', value), in: value => node('in', value), eq: value => node('eq', value), exists: value => node('exists', value), gte: value => node('gte', value) },
    collection: name => { assert.equal(name, C.orders); const query = {
      where(value) { operations.push(['where', value]); return query; }, orderBy(...args) { operations.push(['orderBy', ...args]); return query; },
      skip(value) { operations.push(['skip', value]); return query; }, limit(value) { operations.push(['limit', value]); return query; },
      async get() { operations.push(['get']); return { data: [] }; },
    }; return query; } };
  await createCloudbaseRepo(db).listReconcileOrders({ limit: 10000, nowIso: '2026-09-20T00:00:00.000Z' });
  assert.deepEqual(operations.filter(row => row[0] === 'orderBy'), [['orderBy', 'lastReconciledAt', 'asc'], ['orderBy', '_id', 'asc']]);
  assert.deepEqual(operations.filter(row => row[0] === 'limit'), [['limit', 25]]);
  assert.equal(operations.filter(row => row[0] === 'get').length, 1);
  assert.match(JSON.stringify(operations[0]), /wechat_virtual_payment/); assert.match(JSON.stringify(operations[0]), /partially_refunded/);
});

test('real payment service integration recovers iOS delivery, timer acknowledgement and two separately confirmed partial refunds', async () => {
  const f = await harness({ realService: true });
  let left = 700, queries = 0, acknowledgements = 0;
  f.provider.queryOrder = async input => {
    queries++; assert.deepEqual(input, { openid: OPENID, outTradeNo: OUT });
    return { evidenceScope: 'query_order', authenticatedAppid: APPID, requestedOpenid: OPENID, requestedOutTradeNo: OUT,
      outTradeNo: OUT, transactionId: 'platform-order-001', status: left === 700 ? 2 : 5, orderType: 0,
      env: 0, amountFen: 700, paidAmountFen: 700, remainingAmountFen: left, refundAmountFen: 0 };
  };
  f.provider.acknowledgeDelivery = async ({ outTradeNo }) => { assert.equal(outTradeNo, OUT); acknowledgements++; };
  assert.equal((await f.entry(callbackRequest({ ios: true }))).body, 'success');
  assert.equal(queries, 1); assert.equal(acknowledgements, 0);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, '2026-09-22T02:00:00.000Z');
  const timer = await f.entry(timerEvent(), {}, timerContext());
  assert.equal(timer.reconciled, 1); assert.equal(acknowledgements, 1);
  assert.equal((await f.repo.getOrder(OUT)).providerAcknowledgedAt, f.state.now.toISOString());
  const first = callbackRequest({ refund: true }), second = callbackRequest({ refund: true, overrides: { refundId: 'second-refund' } });
  assert.equal((await f.entry(first)).statusCode, 503);
  left = 350;
  assert.equal((await f.entry(first)).body, 'success');
  assert.equal((await f.entry(first)).body, 'success');
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, '2026-09-18T14:00:00.000Z');
  assert.equal((await f.entry(second)).statusCode, 503);
  left = 0;
  assert.equal((await f.entry(second)).body, 'success');
  assert.equal((await f.entry(callbackRequest({ ios: true }))).body, 'success');
  const order = await f.repo.getOrder(OUT);
  assert.equal(order.status, 'refunded'); assert.equal(order.refundFen, 700); assert.equal(order.refundCallbacks.length, 2);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, f.state.now.toISOString());
});

test('real service rejects mismatched provider evidence and query failures without acknowledging or granting membership', async () => {
  const f = await harness({ realService: true });
  f.provider.queryOrder = async () => ({ evidenceScope: 'query_order', authenticatedAppid: APPID, requestedOpenid: OPENID, requestedOutTradeNo: OUT,
    outTradeNo: OUT, transactionId: 'platform-order-001', status: 2, orderType: 0, env: 0, amountFen: 1, paidAmountFen: 1, remainingAmountFen: 1 });
  assert.equal((await f.entry(callbackRequest())).statusCode, 503);
  assert.equal((await f.repo.getUser(userKeyOf())).membership.expiresAt, null);
  f.provider.queryOrder = async () => { throw new Error('https://api.weixin.qq.com?access_token=private-data'); };
  assert.equal((await f.entry(callbackRequest())).statusCode, 503);
  assert.equal((await f.repo.getOrder(OUT)).status, 'created');
  assert.doesNotMatch(JSON.stringify(f.logs), /access_token|private-data/);
});
