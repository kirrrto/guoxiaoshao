'use strict';
const { createHmac } = require('node:crypto');
const { fail, PaymentProtocolError } = require('./errors');
const { requestJson, withDeadline, createAccessTokenProvider } = require('./transport');
const { createCallbackVerifier, callbackSuccess } = require('./callback');
const { planForTerms } = require('./plans');

// Protocol checked 2026-09-20 against these primary sources:
// /miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html
// /miniprogram/dev/server/API/VirtualPayment/api_query_order
// /miniprogram/dev/server/API/VirtualPayment/api_notify_provide_goods
// /miniprogram/dev/framework/server-ability/message-push.html
const API_ORIGIN = 'https://api.weixin.qq.com';
const stringValue = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const orderIdValid = value => typeof value === 'string' && /^(?!_)[A-Za-z0-9_-]{8,32}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const responseText = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const signPayment = (appKey, uri, rawBody) => createHmac('sha256', appKey).update(`${uri}&${rawBody}`).digest('hex');
const signUser = (sessionKey, rawBody) => createHmac('sha256', sessionKey).update(rawBody).digest('hex');

function normalizeOrder(result, requestedOpenid, requestedOutTradeNo, appid) {
  const order = result.order;
  if (!order || typeof order !== 'object' || Array.isArray(order)) fail('payment_invalid_order_response');
  const envType = integer(order.env_type);
  // query_order does not return buyer/product/quantity/currency. Request scope
  // is carried separately, never represented as provider-returned evidence.
  return {
    evidenceScope: 'query_order', authenticatedAppid: appid,
    requestedOpenid, requestedOutTradeNo,
    openid: null, productId: null, quantity: null, currency: null,
    outTradeNo: responseText(order.order_id), transactionId: responseText(order.wx_order_id),
    channelTransactionId: responseText(order.wxpay_order_id),
    status: integer(order.status), orderType: integer(order.order_type),
    envType, env: envType === 1 ? 0 : envType === 2 ? 1 : null,
    amountFen: integer(order.order_fee), paidAmountFen: integer(order.paid_fee),
    refundAmountFen: integer(order.refund_fee), remainingAmountFen: integer(order.left_fee),
    paidAtSeconds: integer(order.paid_time), providedAtSeconds: integer(order.provide_time),
  };
}

function createVirtualPaymentProvider({ config = {}, expectedAppid, env = process.env,
  fetchImpl = globalThis.fetch, clock = () => new Date(), timeoutMs = 5000 }) {
  const appid = env.GXS_CONSUMER_APPID;
  const appSecret = env.GXS_CONSUMER_APPSECRET;
  const appKey = env.GXS_VIRTUAL_PAYMENT_APPKEY;
  const settings = { ...config };
  const timeout = Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 15000 ? timeoutMs : 5000;
  const tokenProvider = createAccessTokenProvider({ appid, appSecret, fetchImpl, clock, timeoutMs: timeout });
  const callbacks = createCallbackVerifier({ appid, expectedAppid,
    token: env.GXS_PAYMENT_CALLBACK_TOKEN, aesKey: env.GXS_PAYMENT_CALLBACK_AES_KEY,
    mode: settings.callbackMode || 'safe', originalId: env.GXS_CONSUMER_ORIGINAL_ID });

  function credentialReason() {
    if (!/^wx[A-Za-z0-9]{16}$/.test(expectedAppid || '') || appid !== expectedAppid) return 'payment_consumer_appid_mismatch';
    if (!stringValue(appSecret)) return 'payment_consumer_secret_missing';
    if (!stringValue(appKey)) return 'payment_appkey_missing';
    if (typeof fetchImpl !== 'function') return 'payment_transport_unavailable';
    return null;
  }
  function productReason() {
    if (typeof settings.offerId !== 'string' || !/^\d{1,20}$/.test(settings.offerId)) return 'payment_offer_id_missing';
    if (!stringValue(settings.productId)) return 'payment_product_id_missing';
    if (!planForTerms(settings.days, settings.priceFen)) return 'payment_product_terms_mismatch';
    return null;
  }
  function getReadiness() {
    const reason = credentialReason() || productReason() || callbacks.reason() || (settings.enabled !== true ? 'payment_disabled' : null);
    return { ready: !reason, configured: !credentialReason() && !productReason() && !callbacks.reason(),
      verified: false, reason, provider: 'wechat_virtual_payment', mode: 'short_series_goods',
      offerId: settings.offerId || null, productId: settings.productId || null,
      priceFen: settings.priceFen, days: settings.days, currency: 'CNY', env: 0 };
  }
  function requireCredentials() { const reason = credentialReason(); if (reason) fail(reason); }
  function checkOrderInput(openid, outTradeNo) {
    if (!stringValue(openid) || !/^[A-Za-z0-9_-]+$/.test(openid)) fail('payment_invalid_openid');
    if (!orderIdValid(outTradeNo)) fail('payment_invalid_order_id');
  }

  async function preparePayment({ outTradeNo, openid, appid: callerAppid, loginCode }) {
    const readiness = getReadiness(); if (!readiness.ready) fail(readiness.reason);
    if (callerAppid !== expectedAppid) fail('payment_consumer_appid_mismatch');
    checkOrderInput(openid, outTradeNo);
    if (!stringValue(loginCode)) fail('payment_login_code_missing');
    return withDeadline(timeout, async signal => {
      const params = new URLSearchParams({ appid, secret: appSecret, js_code: loginCode, grant_type: 'authorization_code' });
      const session = await requestJson(fetchImpl, `${API_ORIGIN}/sns/jscode2session?${params}`, { method: 'GET' }, signal);
      if (session.openid !== openid) fail('payment_openid_mismatch');
      if (typeof session.session_key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(session.session_key)
          || Buffer.from(session.session_key, 'base64').length !== 16) fail('payment_invalid_session');
      const signData = JSON.stringify({ offerId: settings.offerId, buyQuantity: 1, env: 0, currencyType: 'CNY',
        productId: settings.productId, goodsPrice: settings.priceFen, outTradeNo, attach: outTradeNo });
      return { mode: 'short_series_goods', signData,
        paySig: signPayment(appKey, 'requestVirtualPayment', signData), signature: signUser(session.session_key, signData) };
    });
  }

  async function xpay(path, payload, { signed = true, allowEmpty = false } = {}) {
    requireCredentials();
    return withDeadline(timeout, async signal => {
      const accessToken = await tokenProvider.get();
      if (signal.aborted) fail('payment_timeout');
      const body = JSON.stringify(payload);
      const query = new URLSearchParams({ access_token: accessToken });
      if (signed) query.set('pay_sig', signPayment(appKey, path, body));
      try { return await requestJson(fetchImpl, `${API_ORIGIN}${path}?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      }, signal, allowEmpty); }
      catch (error) {
        if (error.details && [40001, 40014, 42001].includes(error.details.wechatCode)) tokenProvider.invalidate();
        throw error;
      }
    });
  }

  async function queryOrder({ openid, outTradeNo }) {
    checkOrderInput(openid, outTradeNo);
    const result = await xpay('/xpay/query_order', { openid, env: 0, order_id: outTradeNo });
    if (result.errcode !== 0) fail('payment_invalid_order_response');
    return normalizeOrder(result, openid, outTradeNo, expectedAppid);
  }

  // Only call after durable recovery delivery. Normal successful callback
  // handling already acknowledges delivery and does not need this API call.
  async function acknowledgeDelivery({ outTradeNo }) {
    if (!orderIdValid(outTradeNo)) fail('payment_invalid_order_id');
    await xpay('/xpay/notify_provide_goods', { order_id: outTradeNo, env: 0 }, { signed: false, allowEmpty: true });
    return { acknowledged: true };
  }

  return { getReadiness, preparePayment, queryOrder, acknowledgeDelivery,
    verifyCallback: callbacks.verify, callbackSuccess };
}

module.exports = { createVirtualPaymentProvider, signPayment, signUser, PaymentProtocolError, callbackSuccess };
