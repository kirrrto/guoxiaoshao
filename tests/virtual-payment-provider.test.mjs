import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv, createHash, createHmac } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createVirtualPaymentProvider, signPayment, signUser, callbackSuccess } = require('../cloudfunctions/gxs_api/lib/payment/virtual-payment');
const APPID = 'wxe96ad9e77b602f1b';
const OPENID = 'o-test-consumer';
const ORDER = 'GXS20260920abcdefgh1234';
const APPKEY = 'test-only-production-key';
const SECRET = 'test-only-consumer-secret';
const TOKEN = 'AAAAA';
const SESSION = '9hAb/NEYUlkaMBEsmFgzig==';
const AES_KEY = Buffer.alloc(32, 42).toString('base64').slice(0, -1);
const config = { offerId: '1450655203', productId: 'published-week-membership', priceFen: 700, days: 7, enabled: true };
const environment = { GXS_CONSUMER_APPID: APPID, GXS_CONSUMER_APPSECRET: SECRET,
  GXS_VIRTUAL_PAYMENT_APPKEY: APPKEY, GXS_PAYMENT_CALLBACK_TOKEN: TOKEN, GXS_PAYMENT_CALLBACK_AES_KEY: AES_KEY };
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tokenResponse = () => json({ access_token: 'test-token-no-real-account', expires_in: 7200 });
const validOrder = () => ({ errcode: 0, order: { order_id: ORDER, status: 2, order_type: 0,
  order_fee: 700, paid_fee: 700, left_fee: 700, env_type: 1, wx_order_id: 'platform-order-001',
  paid_time: 1790000000, token: 'provider-secret-must-not-leak', biz_meta: '{"untrusted":"not-a-contract"}' } });
function provider(options = {}) {
  return createVirtualPaymentProvider({ config, env: environment, expectedAppid: APPID,
    fetchImpl: async () => { throw new Error('unexpected network request'); }, ...options });
}
const errorCode = code => error => error.code === code;
const hash = parts => createHash('sha1').update(parts.sort().join('')).digest('hex');
const queryBase = { timestamp: '1790000000', nonce: '1234567' };

// Independent fixture encryption, without calling production encryption code.
function encryptFixture(message, receiver = APPID, transform = bytes => bytes) {
  const key = Buffer.from(`${AES_KEY}=`, 'base64');
  const data = Buffer.from(message); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const unpadded = Buffer.concat([Buffer.alloc(16, 7), length, data, Buffer.from(receiver)]);
  const padding = 32 - unpadded.length % 32;
  const plaintext = transform(Buffer.concat([unpadded, Buffer.alloc(padding, padding)]));
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
}
function requestFor(xml, { receiver = APPID, transform, outer = null } = {}) {
  const encrypted = encryptFixture(xml, receiver, transform);
  return { method: 'POST', query: { ...queryBase, encrypt_type: 'aes', msg_signature: hash([TOKEN, queryBase.timestamp, queryBase.nonce, encrypted]) },
    body: outer || `<xml><ToUserName>gh_consumer</ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` };
}
function deliveryXml(extra = '', pay = '<WeChatPayInfo><MchOrderNo>platform-order-001</MchOrderNo><TransactionId>wxpay-001</TransactionId><PaidTime>1790000000</PaidTime></WeChatPayInfo>') {
  return `<xml><ToUserName>gh_consumer</ToUserName><FromUserName>official-not-buyer</FromUserName><MsgType>event</MsgType><Event>xpay_goods_deliver_notify</Event><OpenId>${OPENID}</OpenId><OutTradeNo>${ORDER}</OutTradeNo><Env>0</Env>${pay}<GoodsInfo><ProductId>${config.productId}</ProductId><Quantity>1</Quantity><OrigPrice>700</OrigPrice><ActualPrice>700</ActualPrice><Attach>${ORDER}</Attach></GoodsInfo>${extra}</xml>`;
}

test('HMAC matches both independent official WeChat fixed test vectors', () => {
  const body = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}';
  assert.equal(signPayment('12345', '/xpay/query_user_balance', body), 'c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5');
  assert.equal(signUser(SESSION, body), '089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7');
});

test('missing unpublished product or credentials prevents checkout before any network request', async () => {
  let calls = 0;
  const noProduct = provider({ config: { ...config, productId: '' }, fetchImpl: async () => { calls++; } });
  assert.equal(noProduct.getReadiness().reason, 'payment_product_id_missing');
  await assert.rejects(noProduct.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: APPID, loginCode: 'code' }), errorCode('payment_product_id_missing'));
  assert.equal(calls, 0);
  assert.equal(provider({ env: { ...environment, GXS_VIRTUAL_PAYMENT_APPKEY: '' } }).getReadiness().reason, 'payment_appkey_missing');
  assert.equal(provider({ config: { ...config, priceFen: 900 } }).getReadiness().reason, 'payment_product_terms_mismatch');
  assert.equal(provider({ config: { ...config, offerId: 1450655203 } }).getReadiness().reason, 'payment_offer_id_missing');
  assert.equal(provider({ config: { ...config, enabled: false } }).getReadiness().reason, 'payment_disabled');
  const ready = provider().getReadiness();
  assert.equal(ready.ready, true); assert.equal(ready.configured, true); assert.equal(ready.verified, false);
  assert.doesNotMatch(JSON.stringify(ready), /test-only|AAAAA|session_key/);
});

test('checkout binds code2Session to the trusted buyer and signs exact server-owned one-time product terms', async () => {
  const requests = [];
  const payment = provider({ fetchImpl: async (url, init) => { requests.push({ url, init }); return json({ openid: OPENID, session_key: SESSION }); } });
  const result = await payment.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: APPID, loginCode: 'fresh-login-code', priceFen: 1, days: 999, productId: 'forged' });
  assert.equal(requests.length, 1);
  const request = requests[0]; const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
  assert.equal(url.searchParams.get('appid'), APPID); assert.equal(url.searchParams.get('js_code'), 'fresh-login-code');
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.method, 'GET');
  assert.equal(result.mode, 'short_series_goods');
  assert.deepEqual(JSON.parse(result.signData), { offerId: '1450655203', buyQuantity: 1, env: 0, currencyType: 'CNY',
    productId: config.productId, goodsPrice: 700, outTradeNo: ORDER, attach: ORDER });
  assert.equal(result.paySig, createHmac('sha256', APPKEY).update('requestVirtualPayment&' + result.signData).digest('hex'));
  assert.equal(result.signature, createHmac('sha256', SESSION).update(result.signData).digest('hex'));
  assert.doesNotMatch(JSON.stringify(result), /test-only|session_key|9hAb/);
});

test('wrong application, buyer, malformed session and invalid platform order numbers never yield payment signatures', async () => {
  let calls = 0;
  const payment = provider({ fetchImpl: async () => { calls++; return json({ openid: 'another-buyer', session_key: SESSION }); } });
  await assert.rejects(payment.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: 'wx0000000000000000', loginCode: 'code' }), errorCode('payment_consumer_appid_mismatch'));
  assert.equal(calls, 0);
  for (const outTradeNo of ['_notvalid123', 'a'.repeat(33), 'short', 'bad query?']) {
    await assert.rejects(payment.preparePayment({ outTradeNo, openid: OPENID, appid: APPID, loginCode: 'code' }), errorCode('payment_invalid_order_id'));
  }
  assert.equal(calls, 0);
  await assert.rejects(payment.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: APPID, loginCode: 'code' }), errorCode('payment_openid_mismatch'));
  const invalidSession = provider({ fetchImpl: async () => json({ openid: OPENID, session_key: 'invalid-key' }) });
  await assert.rejects(invalidSession.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: APPID, loginCode: 'code' }), errorCode('payment_invalid_session'));
});

test('query signs actual raw body and preserves provider evidence apart from authenticated request scope', async () => {
  const calls = [];
  const payment = provider({ fetchImpl: async (url, init) => { calls.push({ url, init }); return url.includes('stable_token') ? tokenResponse() : json(validOrder()); } });
  const result = await payment.queryOrder({ openid: OPENID, outTradeNo: ORDER });
  assert.equal(calls.length, 2);
  const call = calls[1]; const url = new URL(call.url);
  assert.equal(url.pathname, '/xpay/query_order');
  assert.deepEqual(JSON.parse(call.init.body), { openid: OPENID, env: 0, order_id: ORDER });
  assert.equal(url.searchParams.get('pay_sig'), createHmac('sha256', APPKEY).update('/xpay/query_order&' + call.init.body).digest('hex'));
  assert.equal(result.amountFen, 700); assert.equal(result.paidAmountFen, 700); assert.equal(result.remainingAmountFen, 700);
  assert.equal(result.envType, 1); assert.equal(result.env, 0); assert.equal(result.status, 2);
  assert.equal(result.transactionId, 'platform-order-001');
  assert.equal(result.authenticatedAppid, APPID); assert.equal(result.requestedOpenid, OPENID);
  for (const absent of ['openid', 'productId', 'quantity', 'currency']) assert.equal(result[absent], null, absent);
  assert.doesNotMatch(JSON.stringify(result), /provider-secret|biz_meta|test-only|test-token/);
});

test('query missing money, identifiers and unknown environment remain null; no synthetic paid success is invented', async () => {
  const payment = provider({ fetchImpl: async url => url.includes('stable_token') ? tokenResponse() : json({ errcode: 0,
    order: { status: 0, env_type: 0, order_fee: '700', paid_fee: -1, wx_order_id: '' } }) });
  const result = await payment.queryOrder({ openid: OPENID, outTradeNo: ORDER });
  assert.equal(result.amountFen, null); assert.equal(result.paidAmountFen, null);
  assert.equal(result.env, null); assert.equal(result.transactionId, null); assert.equal(result.outTradeNo, null);
  assert.equal(result.status, 0); assert.equal(result.orderType, null);
  assert.equal('paid' in result, false);
});

test('concurrent queries coalesce token refresh; expired token refreshes once and never leaks through response', async () => {
  let now = Date.parse('2026-09-20T00:00:00Z'); let tokens = 0; let queries = 0;
  const payment = provider({ clock: () => new Date(now), fetchImpl: async url => {
    if (url.includes('stable_token')) { tokens++; await new Promise(resolve => setTimeout(resolve, 5)); return tokenResponse(); }
    queries++; return json(validOrder());
  } });
  await Promise.all([payment.queryOrder({ openid: OPENID, outTradeNo: ORDER }), payment.queryOrder({ openid: OPENID, outTradeNo: ORDER })]);
  assert.equal(tokens, 1); assert.equal(queries, 2);
  now += 7200 * 1000;
  await payment.queryOrder({ openid: OPENID, outTradeNo: ORDER }); assert.equal(tokens, 2);
});

test('invalid access token invalidates cache without replaying the query; next explicit attempt refreshes', async () => {
  let tokens = 0; let queries = 0;
  const payment = provider({ fetchImpl: async url => {
    if (url.includes('stable_token')) { tokens++; return tokenResponse(); }
    queries++; return queries === 1 ? json({ errcode: 42001, errmsg: `secret ${APPKEY}` }) : json(validOrder());
  } });
  await assert.rejects(payment.queryOrder({ openid: OPENID, outTradeNo: ORDER }), error => {
    assert.equal(error.code, 'payment_wechat_error'); assert.deepEqual(error.details, { wechatCode: 42001 });
    assert.doesNotMatch(String(error) + JSON.stringify(error), /test-only|secret/); return true;
  });
  assert.equal(queries, 1); assert.equal(tokens, 1);
  await payment.queryOrder({ openid: OPENID, outTradeNo: ORDER });
  assert.equal(queries, 2); assert.equal(tokens, 2);
});

test('network errors containing secrets and signed URLs are redacted', async () => {
  const payment = provider({ fetchImpl: async () => { throw new Error(`https://example.test/?secret=${SECRET}&appkey=${APPKEY}`); } });
  await assert.rejects(payment.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: APPID, loginCode: 'secret-login-code' }), error => {
    assert.equal(error.code, 'payment_transport_error'); assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /https|test-only|login-code/); return true;
  });
});

test('hard deadlines bound both a hanging fetch and a hanging response body without automatic retries', async () => {
  for (const phase of ['fetch', 'body']) {
    let calls = 0; let signal;
    const payment = provider({ timeoutMs: 20, fetchImpl: async (url, init) => {
      calls++; signal = init.signal;
      return phase === 'fetch' ? new Promise(() => {}) : { ok: true, text: () => new Promise(() => {}) };
    } });
    await assert.rejects(payment.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: APPID, loginCode: 'code' }), errorCode('payment_timeout'));
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});

test('HTTP failures, malformed JSON and oversized responses are controlled errors', async () => {
  const cases = [
    [() => new Response('secret', { status: 503 }), 'payment_http_error'],
    [() => new Response('<html>upstream-secret</html>'), 'payment_invalid_response'],
    [() => new Response('a'.repeat(262145)), 'payment_response_too_large'],
  ];
  for (const [response, code] of cases) {
    const payment = provider({ fetchImpl: async () => response() });
    await assert.rejects(payment.preparePayment({ outTradeNo: ORDER, openid: OPENID, appid: APPID, loginCode: 'code' }), errorCode(code));
  }
});

test('recovery acknowledgement uses access_token only, accepts empty response and does not resubmit checkout', async () => {
  const calls = [];
  const payment = provider({ fetchImpl: async (url, init) => {
    calls.push({ url, init }); return url.includes('stable_token') ? tokenResponse() : new Response('', { status: 200 });
  } });
  assert.deepEqual(await payment.acknowledgeDelivery({ outTradeNo: ORDER }), { acknowledged: true });
  const call = calls[1]; const url = new URL(call.url);
  assert.equal(url.pathname, '/xpay/notify_provide_goods'); assert.equal(url.searchParams.has('pay_sig'), false);
  assert.deepEqual(JSON.parse(call.init.body), { order_id: ORDER, env: 0 });
  assert.equal(calls.length, 2);
});

test('GET challenge matches the official fixed signature vector and rejects tampering', () => {
  const query = { signature: 'f464b24fc39322e44b38aa78f5edd27bd1441696', echostr: '4375120948345356249', timestamp: '1714036504', nonce: '1514711492' };
  assert.deepEqual(provider().verifyCallback({ method: 'GET', query }), { kind: 'challenge', echo: query.echostr });
  assert.throws(() => provider().verifyCallback({ method: 'GET', query: { ...query, nonce: 'changed' } }), errorCode('payment_callback_invalid_signature'));
});

test('GET URL verification uses Token only; invalid EncodingAESKey still blocks POST and readiness', () => {
  const query = { signature: 'f464b24fc39322e44b38aa78f5edd27bd1441696', echostr: '4375120948345356249', timestamp: '1714036504', nonce: '1514711492' };
  const broken = provider({ env: { ...environment, GXS_PAYMENT_CALLBACK_AES_KEY: 'not-a-valid-encoding-aes-key!!' } });
  assert.deepEqual(broken.verifyCallback({ method: 'GET', query }), { kind: 'challenge', echo: query.echostr });
  assert.equal(broken.getReadiness().reason, 'payment_callback_aes_key_missing');
  assert.throws(() => broken.verifyCallback(requestFor(deliveryXml())), errorCode('payment_callback_aes_key_missing'));
  const padded = provider({ env: { ...environment, GXS_PAYMENT_CALLBACK_TOKEN: ` ${TOKEN} ` } });
  assert.deepEqual(padded.verifyCallback({ method: 'GET', query }), { kind: 'challenge', echo: query.echostr });
});

test('EncodingAESKey accepts 43-character keys that Node would not round-trip as canonical base64', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(AES_KEY[42]);
  const nonCanonical = `${AES_KEY.slice(0, 42)}${alphabet[last + 1]}`;
  assert.equal(Buffer.from(`${nonCanonical}=`, 'base64').length, 32);
  assert.notEqual(Buffer.from(`${nonCanonical}=`, 'base64').toString('base64'), `${nonCanonical}=`);
  const payment = provider({ env: { ...environment, GXS_PAYMENT_CALLBACK_AES_KEY: ` ${nonCanonical}\n` } });
  assert.equal(payment.verifyCallback(requestFor(deliveryXml())).outTradeNo, ORDER);
});

test('safe XML callback verifies ciphertext signature, consumer AppID and nested payment fields', () => {
  const evidence = provider().verifyCallback(requestFor(deliveryXml()));
  assert.equal(evidence.authenticatedAppid, APPID); assert.equal(evidence.encrypted, true);
  assert.equal(evidence.event, 'xpay_goods_deliver_notify'); assert.equal(evidence.openid, OPENID);
  assert.notEqual(evidence.openid, 'official-not-buyer'); assert.equal(evidence.outTradeNo, ORDER);
  assert.equal(evidence.transactionId, 'platform-order-001'); assert.equal(evidence.channelTransactionId, 'wxpay-001');
  assert.equal(evidence.productId, config.productId); assert.equal(evidence.quantity, 1);
  assert.equal(evidence.amountFen, 700); assert.equal(evidence.paidAmountFen, 700); assert.equal(evidence.env, 0);
  assert.equal(evidence.requiresOrderQuery, false); assert.equal(evidence.currency, null);
  assert.equal(callbackSuccess(), 'success');
});

test('iOS callback without WeChatPayInfo preserves missing transaction data for authoritative query fallback', () => {
  const evidence = provider().verifyCallback(requestFor(deliveryXml('', '')));
  assert.equal(evidence.transactionId, null); assert.equal(evidence.paidAtSeconds, null);
  assert.equal(evidence.requiresOrderQuery, true);
  assert.equal(evidence.productId, config.productId); assert.equal(evidence.outTradeNo, ORDER);
});

test('refund callbacks use original payment IDs, real refund amount/result, and do not invent a missing Env', () => {
  const xml = `<xml><ToUserName>gh_consumer</ToUserName><MsgType>event</MsgType><Event>xpay_refund_notify</Event><OpenId>${OPENID}</OpenId><WxRefundId>refund-01</WxRefundId><MchRefundId>merchant-refund-01</MchRefundId><WxOrderId>platform-order-001</WxOrderId><MchOrderId>${ORDER}</MchOrderId><RefundFee>100</RefundFee><RetCode>0</RetCode><RefundSuccTimestamp>1790000500</RefundSuccTimestamp></xml>`;
  const result = provider().verifyCallback(requestFor(xml));
  assert.equal(result.outTradeNo, ORDER); assert.equal(result.transactionId, 'platform-order-001');
  assert.equal(result.refundId, 'refund-01'); assert.equal(result.refundAmountFen, 100);
  assert.equal(result.refundResultCode, 0); assert.equal(result.env, null); assert.equal(result.amountFen, null);
  const failed = provider().verifyCallback(requestFor(xml.replace('<RetCode>0</RetCode>', '<RetCode>3</RetCode>')));
  assert.equal(failed.refundResultCode, 3);
});

test('a resource-app ciphertext is rejected even with a valid shared token and signature', () => {
  assert.throws(() => provider().verifyCallback(requestFor(deliveryXml(), { receiver: 'wx0000000000000000' })), errorCode('payment_callback_appid_mismatch'));
  assert.throws(() => provider({ env: { ...environment, GXS_CONSUMER_APPID: 'wx0000000000000000' } }).verifyCallback(requestFor(deliveryXml())), errorCode('payment_consumer_appid_mismatch'));
});

test('normal signature cannot replace ciphertext msg_signature and forged ciphertext is rejected', () => {
  const request = requestFor(deliveryXml());
  delete request.query.msg_signature;
  request.query.signature = hash([TOKEN, queryBase.timestamp, queryBase.nonce]);
  assert.throws(() => provider().verifyCallback(request), errorCode('payment_callback_invalid_signature'));
  const changed = requestFor(deliveryXml()); changed.query.msg_signature = '0'.repeat(40);
  assert.throws(() => provider().verifyCallback(changed), errorCode('payment_callback_invalid_signature'));
});

test('wrong padding, wrong recipient, duplicate XML fields and DTD/entity declarations are rejected', () => {
  const invalidPadding = requestFor(deliveryXml(), { transform: bytes => { bytes[bytes.length - 1] = 0; return bytes; } });
  assert.throws(() => provider().verifyCallback(invalidPadding), errorCode('payment_callback_invalid_padding'));
  const duplicate = deliveryXml('<OpenId>different</OpenId>');
  assert.throws(() => provider().verifyCallback(requestFor(duplicate)), errorCode('payment_callback_duplicate_field'));
  const duplicateNested = deliveryXml().replace('<Quantity>1</Quantity>', '<Quantity>1</Quantity><Quantity>99</Quantity>');
  assert.throws(() => provider().verifyCallback(requestFor(duplicateNested)), errorCode('payment_callback_duplicate_field'));
  const dtd = '<!DOCTYPE xml [<!ENTITY steal SYSTEM "file:///secrets">]>' + deliveryXml();
  assert.throws(() => provider().verifyCallback(requestFor(dtd)), errorCode('payment_callback_invalid_xml'));
  const mismatch = requestFor(deliveryXml().replace('gh_consumer', 'gh_other'));
  assert.throws(() => provider().verifyCallback(mismatch), errorCode('payment_callback_recipient_mismatch'));
});

test('ambiguous outer Encrypt elements, malformed trees and oversize bodies are rejected before business use', () => {
  const normal = requestFor(deliveryXml());
  normal.body = normal.body.replace('</xml>', '<Encrypt>other</Encrypt></xml>');
  assert.throws(() => provider().verifyCallback(normal), errorCode('payment_callback_duplicate_field'));
  for (const invalid of [deliveryXml() + '<xml></xml>', deliveryXml().replace('</GoodsInfo>', '</WrongTag>'), deliveryXml().replace('<Quantity>', '<Quantity attr="x">')]) {
    assert.throws(() => provider().verifyCallback(requestFor(invalid)), errorCode('payment_callback_invalid_xml'));
  }
  assert.throws(() => provider().verifyCallback({ ...requestFor(deliveryXml()), body: 'x'.repeat(65537) }), errorCode('payment_callback_too_large'));
  assert.throws(() => provider().verifyCallback({ ...requestFor(deliveryXml()), body: Buffer.from([0xff, 0xfe]) }), errorCode('payment_callback_invalid_encoding'));
});

test('base64 HTTP transport and XML numeric entities decode deterministically', () => {
  const request = requestFor(deliveryXml().replace(config.productId, 'published-week-membersh&#105;p'));
  request.body = Buffer.from(request.body).toString('base64'); request.isBase64Encoded = true;
  assert.equal(provider().verifyCallback(request).productId, config.productId);
});

test('plain callbacks require explicit mode, configured original ID, signed query and authoritative order lookup', () => {
  const query = { ...queryBase, signature: hash([TOKEN, queryBase.timestamp, queryBase.nonce]) };
  const request = { method: 'POST', query, body: deliveryXml() };
  assert.throws(() => provider().verifyCallback(request), errorCode('payment_callback_invalid_signature'));
  const configPlain = { ...config, callbackMode: 'plaintext' };
  assert.throws(() => provider({ config: configPlain }).verifyCallback(request), errorCode('payment_callback_original_id_missing'));
  const plain = provider({ config: configPlain, env: { ...environment, GXS_CONSUMER_ORIGINAL_ID: 'gh_consumer' } });
  const evidence = plain.verifyCallback(request);
  assert.equal(evidence.encrypted, false); assert.equal(evidence.requiresOrderQuery, true);
  assert.throws(() => plain.verifyCallback({ ...request, body: deliveryXml().replace('gh_consumer', 'gh_other') }), errorCode('payment_callback_recipient_mismatch'));
  assert.throws(() => plain.verifyCallback({ ...request, query: { ...query, signature: 'bad' } }), errorCode('payment_callback_invalid_signature'));
});

test('paused checkout does not disable callback verification or order reconciliation', async () => {
  const payment = provider({ config: { ...config, enabled: false }, fetchImpl: async url => url.includes('stable_token') ? tokenResponse() : json(validOrder()) });
  assert.equal(payment.getReadiness().ready, false);
  assert.equal(payment.verifyCallback(requestFor(deliveryXml())).outTradeNo, ORDER);
  assert.equal((await payment.queryOrder({ openid: OPENID, outTradeNo: ORDER })).transactionId, 'platform-order-001');
});
