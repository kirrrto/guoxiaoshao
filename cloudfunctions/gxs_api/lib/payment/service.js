'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { ApiError } = require('../errors');
const { membershipSnapshot } = require('../rules/membership');
const { createVirtualPaymentProvider, PaymentProtocolError } = require('./virtual-payment');

const PROVIDER = 'wechat_virtual_payment';
let sharedProvider = null;
let sharedProviderKey = null;
const nowOf = ctx => typeof ctx.clock === 'function' ? ctx.clock() : ctx.now || new Date();
const orderKey = (userKey, clientId) => `G${createHash('sha256').update(`${userKey}|${clientId}`).digest('hex').slice(0, 31)}`;
const conflict = () => { throw new ApiError('payment_evidence_mismatch', '支付凭证与订单不一致，请联系客服核对'); };

function paymentProviderFor(ctx) {
  if (ctx.paymentProvider) return ctx.paymentProvider;
  if (ctx._paymentProvider) return ctx._paymentProvider;
  const env = ctx.paymentEnv || process.env;
  const config = { ...ctx.config.virtualPayment, priceFen: ctx.config.memberProduct.priceFen,
    days: ctx.config.memberProduct.days, enabled: ctx.config.memberProduct.enabled };
  const expectedAppid = ctx.config.notifications.consumerAppId;
  const useShared = ctx.paymentCacheAllowed === true && env === process.env && ctx.fetchImpl === globalThis.fetch;
  // Single-entry, process-local cache. This key contains credentials and is
  // deliberately never exposed, persisted or logged. Rotation replaces it.
  const key = useShared ? JSON.stringify([config, expectedAppid, ...[
    'GXS_CONSUMER_APPID', 'GXS_CONSUMER_APPSECRET', 'GXS_VIRTUAL_PAYMENT_APPKEY',
    'GXS_PAYMENT_CALLBACK_TOKEN', 'GXS_PAYMENT_CALLBACK_AES_KEY', 'GXS_CONSUMER_ORIGINAL_ID',
  ].map(name => env[name] || null)]) : null;
  if (useShared && sharedProvider && key === sharedProviderKey) ctx._paymentProvider = sharedProvider;
  else {
    ctx._paymentProvider = createVirtualPaymentProvider({ config, expectedAppid, env,
      fetchImpl: ctx.fetchImpl, clock: useShared ? () => new Date() : ctx.clock });
    if (useShared) { sharedProviderKey = key; sharedProvider = ctx._paymentProvider; }
  }
  return ctx._paymentProvider;
}

function paymentProduct(ctx) {
  const configured = ctx.config.memberProduct;
  const payment = paymentProviderFor(ctx).getReadiness();
  const matches = configured.id === ctx.config.virtualPayment.productId && configured.priceFen === 700 && configured.days === 7;
  const ready = configured.enabled === true && payment.ready === true && matches;
  return { id: configured.id, title: configured.title, priceFen: configured.priceFen, days: configured.days,
    note: configured.note, enabled: ready, paymentReady: ready,
    paymentReason: ready ? null : !matches ? 'payment_product_terms_mismatch' : payment.reason || 'payment_not_enabled',
    iosEnabled: ctx.config.virtualPayment.iosEnabled === true };
}

function protocolError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof PaymentProtocolError) {
    const actionable = ['payment_login_code_missing', 'payment_invalid_session', 'payment_openid_mismatch', 'payment_consumer_appid_mismatch'];
    return new ApiError(actionable.includes(error.code) ? error.code : 'payment_check_pending',
      actionable.includes(error.code) ? '微信支付身份确认未完成，请重试或联系客服' : '支付结果暂未确认，请稍后查询，勿重复支付');
  }
  // The router must not log arbitrary fetch errors with credential-bearing URLs.
  return new ApiError('payment_check_pending', '支付结果暂未确认，请稍后查询，勿重复支付');
}

function validateOrder(ctx, order) {
  const s = order && order.paymentSnapshot;
  if (!order || order.provider !== PROVIDER || !s || s.version !== 1 || s.provider !== PROVIDER
    || order.appid !== ctx.config.notifications.consumerAppId || s.appid !== order.appid
    || order.userKey !== `${order.appid}:${order.openid}` || order._id !== order.outTradeNo
    || order.outTradeNo !== orderKey(order.userKey, order.orderId)
    || s.productId !== order.productId || s.priceFen !== order.amountFen || s.days !== order.days
    || s.env !== 0 || s.currency !== 'CNY' || s.buyQuantity !== 1
    || order.amountFen !== 700 || order.days !== 7 || typeof s.offerId !== 'string') conflict();
}

async function withOrderLease(ctx, id, work) {
  const ownerId = randomUUID(); const now = nowOf(ctx);
  const lease = await ctx.repo.acquireLease({ id: `pay_order_${id}`, ownerId, now: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString() });
  if (!lease.acquired) throw new ApiError('payment_pending', '这笔订单正在确认中，请稍后查询');
  try { return await work(); }
  finally { await ctx.repo.releaseLease({ id: `pay_order_${id}`, ownerId }); }
}

async function resultOf(ctx, order, providerState, canPrepare = false) {
  const user = await ctx.repo.getUser(order.userKey);
  if (!user) throw new ApiError('user_missing', '用户不存在');
  return { order, membership: membershipSnapshot(user, nowOf(ctx)), providerState, canPrepare };
}

async function reconcileLocked(ctx, inputOrder, { acknowledge = true, permitUnprepared = false } = {}) {
  let order = await ctx.repo.getOrder(inputOrder._id);
  validateOrder(ctx, order);
  const provider = paymentProviderFor(ctx);
  let evidence;
  try { evidence = await provider.queryOrder({ openid: order.openid, outTradeNo: order.outTradeNo }); }
  catch (error) {
    await ctx.repo.updateOrder(order._id, { lastReconciledAt: nowOf(ctx).toISOString() });
    // No published official error-code contract identifies "not found". Do not
    // guess from errmsg or general server errors and reopen a paid checkout.
    // A local order with no issued parameters cannot have reached the cashier.
    if (permitUnprepared && !order.paymentPreparedAt && !order.transactionId && order.status === 'created' && order.providerStatus == null) return resultOf(ctx, order, 'not_prepared', true);
    throw protocolError(error);
  }
  if (!evidence || evidence.evidenceScope !== 'query_order'
    || evidence.authenticatedAppid !== order.appid || evidence.requestedOpenid !== order.openid
    || evidence.requestedOutTradeNo !== order.outTradeNo || evidence.outTradeNo !== order.outTradeNo
    || evidence.env !== 0 || ![0, 7].includes(evidence.orderType) || evidence.amountFen !== order.amountFen) conflict();
  const nowIso = nowOf(ctx).toISOString();
  order = await ctx.repo.updateOrder(order._id, { lastReconciledAt: nowIso, providerStatus: evidence.status });
  if ([0, 1].includes(evidence.status)) return resultOf(ctx, order, 'created');
  if (evidence.status === 6) {
    if (!['created', 'cancelled'].includes(order.status) || order.transactionId || order.fulfilledAt) conflict();
    order = await ctx.repo.updateOrder(order._id, { status: 'cancelled', cancelledAt: nowIso });
    return resultOf(ctx, order, 'cancelled');
  }
  if (![2, 3, 4, 5, 7, 8].includes(evidence.status) || typeof evidence.transactionId !== 'string' || !evidence.transactionId
    || evidence.paidAmountFen !== order.amountFen) conflict();
  if (order.transactionId && order.transactionId !== evidence.transactionId) conflict();
  const remaining = evidence.remainingAmountFen;
  if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > order.amountFen) throw new ApiError('payment_check_pending', '支付及退款金额尚未确认，请稍后查询');
  // query_order.refund_fee belongs to a refund-type order, not the cumulative
  // refunds of this payment. Only original payment amount minus left_fee gives
  // the cumulative confirmed refund amount of the queried payment order.
  const cumulativeRefund = order.amountFen - remaining;
  if ([5, 8].includes(evidence.status) && cumulativeRefund === 0) conflict();
  // A full refund may arrive before a paid event. Never revive it by markPaid.
  if (cumulativeRefund >= order.amountFen) {
    if (!order.transactionId && order.status !== 'refunded') order = (await ctx.repo.markOrderPaid({ orderId: order._id, transactionId: evidence.transactionId, nowIso, providerData: { amountFen: order.amountFen, provider: PROVIDER } })).order;
    order = (await ctx.repo.markOrderRefunded({ orderId: order._id, nowIso, refundFen: cumulativeRefund, providerData: { source: 'query_order', transactionId: evidence.transactionId } })).order;
    return resultOf(ctx, order, 'refunded');
  }
  if (order.status === 'refunded') return resultOf(ctx, order, 'refunded');
  order = (await ctx.repo.markOrderPaid({ orderId: order._id, transactionId: evidence.transactionId, nowIso, providerData: { amountFen: order.amountFen, provider: PROVIDER } })).order;
  if (cumulativeRefund > 0) order = (await ctx.repo.markOrderRefunded({ orderId: order._id, nowIso, refundFen: cumulativeRefund, providerData: { source: 'query_order', transactionId: evidence.transactionId } })).order;
  order = (await ctx.repo.fulfilMembershipOrder({ orderId: order._id, source: 'virtual_payment', nowIso })).order;
  // Failure after durable grant must not obscure the user's confirmed access.
  // Leave providerAcknowledgedAt absent so the next reconciliation can retry.
  if (acknowledge && !order.providerAcknowledgedAt) {
    if (evidence.status === 4) order = await ctx.repo.updateOrder(order._id, { providerAcknowledgedAt: nowIso });
    else {
      try {
        await provider.acknowledgeDelivery({ outTradeNo: order.outTradeNo });
        order = await ctx.repo.updateOrder(order._id, { providerAcknowledgedAt: nowOf(ctx).toISOString() });
      } catch { /* Durable paid/fulfilled order remains available for retry. */ }
    }
  }
  return resultOf(ctx, order, order.status);
}

async function reconcileOrder(ctx, order, options = {}) {
  try { return await withOrderLease(ctx, order._id, () => reconcileLocked(ctx, order, options)); }
  catch (error) { throw protocolError(error); }
}

async function createPurchase(ctx, user, clientId, loginCode) {
  const id = orderKey(user._id, clientId);
  try {
    return await withOrderLease(ctx, id, async () => {
      let order = await ctx.repo.getOrder(id);
      if (order) {
        if (order.userKey !== user._id || order.orderId !== clientId) conflict();
        const reconciled = await reconcileLocked(ctx, order, { acknowledge: true, permitUnprepared: true });
        order = reconciled.order;
        if (!reconciled.canPrepare) return { ...reconciled, payment: null, pending: ['created', 'pending'].includes(reconciled.providerState) };
      }
      const product = paymentProduct(ctx);
      if (!product.paymentReady) return { disabled: true, product };
      if (!order) {
        const nowIso = nowOf(ctx).toISOString();
        const vp = ctx.config.virtualPayment;
        const snapshot = { version: 1, provider: PROVIDER, appid: user.appid, offerId: vp.offerId,
          productId: vp.productId, priceFen: 700, days: 7, currency: 'CNY', env: 0, buyQuantity: 1 };
        const created = await ctx.repo.createOrderIfAbsent({ _id: id, outTradeNo: id, orderId: clientId,
          userKey: user._id, appid: user.appid, openid: user.openid, productId: vp.productId,
          type: 'membership_order', provider: PROVIDER, source: 'virtual_payment',
          amountFen: 700, days: 7, paymentSnapshot: snapshot, status: 'created', createdAt: nowIso,
          paidAt: null, fulfilledAt: null, providerStatus: null, paymentPreparedAt: null,
          lastReconciledAt: '1970-01-01T00:00:00.000Z', providerAcknowledgedAt: null });
        order = created.order;
      }
      validateOrder(ctx, order);
      // Existing snapshots cannot silently change into a different product.
      if (order.paymentSnapshot.offerId !== ctx.config.virtualPayment.offerId || order.productId !== product.id) conflict();
      const payment = await paymentProviderFor(ctx).preparePayment({ outTradeNo: order.outTradeNo, openid: order.openid, appid: order.appid, loginCode });
      // Persist BEFORE returning any usable payment signature to the client.
      order = await ctx.repo.updateOrder(order._id, { paymentPreparedAt: nowOf(ctx).toISOString() });
      return { ...(await resultOf(ctx, order, 'prepared')), payment, pending: false };
    });
  } catch (error) { throw protocolError(error); }
}

module.exports = { paymentProviderFor, paymentProduct, reconcileOrder, createPurchase, orderKey, protocolError, PROVIDER };
