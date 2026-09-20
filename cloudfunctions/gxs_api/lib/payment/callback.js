'use strict';
const { createHash, createDecipheriv, timingSafeEqual } = require('node:crypto');
const { fail } = require('./errors');
const { MAX_BODY_BYTES, utf8, decodeBody, parseXml } = require('./xml');

const scalar = value => typeof value === 'string' && value.length <= 1024 ? value : null;
const integer = value => typeof value === 'string' && /^-?\d{1,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const money = value => { const parsed = integer(value); return parsed !== null && parsed >= 0 ? parsed : null; };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : Object.create(null);
const sha1 = values => createHash('sha1').update(values.sort().join('')).digest('hex');

function validSignature(actual, expected) {
  return typeof actual === 'string' && /^[a-fA-F0-9]{40}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

function normalizeAesKey(key) {
  return typeof key === 'string' ? key.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') : key;
}

function validAesKey(key) {
  const normalized = normalizeAesKey(key);
  return typeof normalized === 'string' && /^[A-Za-z0-9+/]{43}$/.test(normalized)
    && Buffer.from(`${normalized}=`, 'base64').length === 32;
}

function decrypt(encrypted, aesKey, expectedAppid) {
  if (typeof encrypted !== 'string' || encrypted.length > Math.ceil(MAX_BODY_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encrypted)) fail('payment_callback_invalid_ciphertext');
  const ciphertext = Buffer.from(encrypted, 'base64');
  if (!ciphertext.length || ciphertext.length % 16 || ciphertext.toString('base64') !== encrypted) fail('payment_callback_invalid_ciphertext');
  const key = Buffer.from(`${aesKey}=`, 'base64');
  let padded;
  try {
    const cipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    padded = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
  } catch { fail('payment_callback_invalid_ciphertext'); }
  const count = padded[padded.length - 1];
  if (!count || count > 32 || !padded.subarray(padded.length - count).every(value => value === count)) fail('payment_callback_invalid_padding');
  const full = padded.subarray(0, padded.length - count);
  if (full.length < 20) fail('payment_callback_invalid_ciphertext');
  const length = full.readUInt32BE(16);
  if (length > MAX_BODY_BYTES || length > full.length - 20) fail('payment_callback_invalid_ciphertext');
  const appid = utf8(full.subarray(20 + length));
  if (appid !== expectedAppid) fail('payment_callback_appid_mismatch');
  return utf8(full.subarray(20, 20 + length));
}

function normalizeEvent(data, appid, encrypted) {
  if (data.MsgType !== 'event' || typeof data.Event !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(data.Event)) fail('payment_callback_invalid_event');
  const goods = object(data.GoodsInfo); const pay = object(data.WeChatPayInfo);
  const refund = data.Event === 'xpay_refund_notify';
  const delivery = data.Event === 'xpay_goods_deliver_notify';
  const needsDeliveryQuery = delivery && (!scalar(pay.MchOrderNo) || !scalar(goods.ProductId)
    || money(goods.Quantity) === null || money(goods.OrigPrice) === null || money(goods.ActualPrice) === null || integer(data.Env) === null);
  return {
    kind: 'event', event: data.Event, evidenceScope: 'callback', authenticatedAppid: appid,
    encrypted, requiresOrderQuery: !encrypted || needsDeliveryQuery,
    recipientOriginalId: scalar(data.ToUserName), openid: scalar(data.OpenId),
    outTradeNo: scalar(refund ? data.MchOrderId : data.OutTradeNo),
    transactionId: scalar(refund ? data.WxOrderId : pay.MchOrderNo),
    channelTransactionId: scalar(refund ? data.WxTransactionId : pay.TransactionId),
    productId: scalar(goods.ProductId), quantity: money(goods.Quantity),
    amountFen: money(goods.OrigPrice), paidAmountFen: money(goods.ActualPrice),
    currency: null, env: integer(data.Env), paidAtSeconds: money(pay.PaidTime),
    attach: scalar(refund ? data.Attach : goods.Attach),
    refundId: scalar(data.WxRefundId), merchantRefundId: scalar(data.MchRefundId),
    refundAmountFen: money(data.RefundFee), refundResultCode: integer(data.RetCode),
    refundedAtSeconds: money(data.RefundSuccTimestamp),
  };
}

function createCallbackVerifier({ appid, expectedAppid, token, aesKey, mode = 'safe', originalId }) {
  const tokenValue = typeof token === 'string' ? token.trim() : token;
  const aesValue = normalizeAesKey(aesKey);
  function reason(method) {
    if (!/^wx[A-Za-z0-9]{16}$/.test(expectedAppid || '') || appid !== expectedAppid) return 'payment_consumer_appid_mismatch';
    if (typeof tokenValue !== 'string' || !/^[A-Za-z0-9]{3,32}$/.test(tokenValue)) return 'payment_callback_token_missing';
    // WeChat URL verification is GET + Token signature only. EncodingAESKey is
    // required later for safe-mode POST decrypt and checkout readiness.
    if (mode === 'safe' && method !== 'GET' && !validAesKey(aesValue)) return 'payment_callback_aes_key_missing';
    if (mode === 'plaintext' && (typeof originalId !== 'string' || !/^gh_[A-Za-z0-9]+$/.test(originalId))) return 'payment_callback_original_id_missing';
    if (!['safe', 'plaintext'].includes(mode)) return 'payment_callback_mode_invalid';
    return null;
  }
  function verify({ method, query = {}, body, isBase64Encoded = false }) {
    const problem = reason(method); if (problem) fail(problem);
    if (!query || typeof query !== 'object' || Array.isArray(query)) fail('payment_callback_invalid_query');
    const { timestamp, nonce } = query;
    if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) || typeof nonce !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(nonce)) fail('payment_callback_invalid_query');
    // Do not expire legitimate delayed payment/refund retries by CreateTime.
    // Duplicate processing is fenced by the host's persisted order/refund IDs.
    if (method === 'GET') {
      if (!validSignature(query.signature, sha1([tokenValue, timestamp, nonce]))) fail('payment_callback_invalid_signature');
      if (typeof query.echostr !== 'string' || Buffer.byteLength(query.echostr, 'utf8') > 1024) fail('payment_callback_invalid_query');
      return { kind: 'challenge', echo: query.echostr };
    }
    if (method !== 'POST') fail('payment_callback_method_not_allowed');
    const envelope = parseXml(decodeBody(body, isBase64Encoded));
    let data; let encrypted = false;
    if (mode === 'safe') {
      if (typeof envelope.Encrypt !== 'string' || !validSignature(query.msg_signature, sha1([tokenValue, timestamp, nonce, envelope.Encrypt]))) fail('payment_callback_invalid_signature');
      data = parseXml(decrypt(envelope.Encrypt, aesValue, expectedAppid)); encrypted = true;
      if (envelope.ToUserName && data.ToUserName && envelope.ToUserName !== data.ToUserName) fail('payment_callback_recipient_mismatch');
      if (originalId && data.ToUserName !== originalId) fail('payment_callback_recipient_mismatch');
    } else {
      if (envelope.Encrypt !== undefined || query.encrypt_type === 'aes' || !validSignature(query.signature, sha1([tokenValue, timestamp, nonce]))) fail('payment_callback_invalid_signature');
      data = envelope;
      if (data.ToUserName !== originalId) fail('payment_callback_recipient_mismatch');
    }
    return normalizeEvent(data, expectedAppid, encrypted);
  }
  return { verify, reason };
}

// Both the virtual-payment and message-push docs explicitly allow an unencrypted
// plain success response. Call only AFTER durable, validated delivery handling.
const callbackSuccess = () => 'success';
module.exports = { createCallbackVerifier, callbackSuccess };
