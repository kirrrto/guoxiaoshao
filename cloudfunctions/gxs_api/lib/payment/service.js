'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { ApiError } = require('../errors');
const { membershipSnapshot, LIMITS, ENHANCED_LIMITS } = require('../rules/membership');
const { createVirtualPaymentProvider, PaymentProtocolError } = require('./virtual-payment');
const { PLANS, DEFAULT_PLAN_ID, findPlan, pricedPlan, planForTerms, planIdOfOrder, snapshotTermsValid, QUOTE_TTL_MS } = require('./plans');

const PROVIDER = 'wechat_virtual_payment';
let sharedProviders = new Map();
let sharedProviderKey = null;
const nowOf = ctx => typeof ctx.clock === 'function' ? ctx.clock() : ctx.now || new Date();
const orderKey = (userKey, clientId) => `G${createHash('sha256').update(`${userKey}|${clientId}`).digest('hex').slice(0, 31)}`;
const conflict = () => { throw new ApiError('payment_evidence_mismatch', '支付凭证与订单不一致，请联系客服核对'); };

function configuredProduct(ctx, planId = DEFAULT_PLAN_ID) {
  const plan = pricedPlan(planId, nowOf(ctx));
  if (!plan) throw new ApiError('invalid_member_plan', '请选择有效的会员套餐');
  if (planId === DEFAULT_PLAN_ID) return { ...ctx.config.memberProduct, standardPriceFen: plan.standardPriceFen, promotion: null,
    id: planId, planId, productId: ctx.config.virtualPayment.productId };
  const mapping = ctx.config.memberPlans && ctx.config.memberPlans[planId] || {};
  return { ...plan, planId, productId: mapping.productId || '', enabled: mapping.enabled === true,
    note: `一次性虚拟服务，一经售出不予退款。一次购买 ${plan.days} 天，已有会员按剩余有效期顺延，不自动续费。` };
}

function paymentProviderFor(ctx, planId = DEFAULT_PLAN_ID) {
  if (ctx.paymentProvider) return ctx.paymentProvider;
  const product = configuredProduct(ctx, planId);
  const env = ctx.paymentEnv || process.env;
  const config = { ...ctx.config.virtualPayment, productId: product.productId, priceFen: product.priceFen,
    // goodsPrice is the actual charged unit price. Strikethrough "standard"
    // prices are UI-only and must not enter the WeChat signature.
    goodsPrice: product.priceFen,
    activitySellingPrice: null,
    days: product.days, enabled: product.enabled };
  // Include effective terms so a warm invocation cannot retain the promotion
  // across its deadline. At most one cached provider per logical plan.
  const termsKey = JSON.stringify(config);
  const local = ctx._paymentProviders && ctx._paymentProviders.get(planId);
  if (local && local.termsKey === termsKey) return local.provider;
  const expectedAppid = ctx.config.notifications.consumerAppId;
  const useShared = ctx.paymentCacheAllowed === true && env === process.env && ctx.fetchImpl === globalThis.fetch;
  // Bounded by the three plans. Credential/config rotation replaces the cache.
  // This key contains secrets and is never exposed, persisted or logged.
  const key = useShared ? JSON.stringify([ctx.config.virtualPayment, ctx.config.memberProduct, ctx.config.memberPlans, expectedAppid, ...[
    'GXS_CONSUMER_APPID', 'GXS_CONSUMER_APPSECRET', 'GXS_VIRTUAL_PAYMENT_APPKEY',
    'GXS_PAYMENT_CALLBACK_TOKEN', 'GXS_PAYMENT_CALLBACK_AES_KEY', 'GXS_CONSUMER_ORIGINAL_ID',
  ].map(name => env[name] || null)]) : null;
  if (useShared && key !== sharedProviderKey) { sharedProviderKey = key; sharedProviders = new Map(); }
  const shared = useShared && sharedProviders.get(planId);
  let provider = shared && shared.termsKey === termsKey && shared.provider;
  if (!provider) {
    provider = createVirtualPaymentProvider({ config, expectedAppid, env,
      fetchImpl: ctx.fetchImpl, clock: useShared ? () => new Date() : ctx.clock });
    if (useShared) sharedProviders.set(planId, { termsKey, provider });
  }
  if (!ctx._paymentProviders) ctx._paymentProviders = new Map();
  ctx._paymentProviders.set(planId, { termsKey, provider });
  return provider;
}

function presentProduct(ctx, planId) {
  const configured = configuredProduct(ctx, planId), plan = findPlan(planId);
  const payment = paymentProviderFor(ctx, planId).getReadiness();
  const matches = configured.standardPriceFen === plan.priceFen && configured.days === plan.days
    && (planId !== DEFAULT_PLAN_ID || configured.priceFen === plan.priceFen)
    && (planId !== DEFAULT_PLAN_ID || ctx.config.memberProduct.id === configured.productId);
  const ready = configured.enabled === true && payment.ready === true && matches;
  const limits = planId === DEFAULT_PLAN_ID ? LIMITS : ENHANCED_LIMITS;
  return { id: planId, planId, productId: configured.productId, title: configured.title, priceFen: configured.priceFen,
    standardPriceFen: configured.standardPriceFen, promotion: configured.promotion, days: configured.days,
    limits: { maxFollows: limits.maxFollows, maxStoresPerFollow: limits.maxStoresPerFollow },
    benefitText: `${limits.maxFollows} 个配置 · 每配置 ${limits.maxStoresPerFollow} 家门店`,
    note: configured.note, enabled: ready, paymentReady: ready,
    paymentReason: ready ? null : !matches ? 'payment_product_terms_mismatch' : !configured.productId ? 'payment_product_id_missing'
      : planId !== DEFAULT_PLAN_ID && configured.enabled !== true ? 'payment_plan_disabled' : payment.reason || 'payment_not_enabled',
    iosEnabled: ctx.config.virtualPayment.iosEnabled === true };
}
function paymentProducts(ctx) { return PLANS.map(plan => presentProduct(ctx, plan.id)); }
function paymentProduct(ctx) { return { ...presentProduct(ctx, DEFAULT_PLAN_ID), id: ctx.config.memberProduct.id }; }

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
  if (cancelledIntent(ctx, order)) return;
  const s = order && order.paymentSnapshot;
  const plan = order && planForTerms(order.days, order.amountFen);
  if (!order || order.provider !== PROVIDER || !s || !snapshotTermsValid(order) || s.provider !== PROVIDER
    || order.appid !== ctx.config.notifications.consumerAppId || s.appid !== order.appid
    || order.userKey !== `${order.appid}:${order.openid}` || order._id !== order.outTradeNo
    || order.outTradeNo !== orderKey(order.userKey, order.orderId)
    || s.productId !== order.productId || s.priceFen !== order.amountFen || s.days !== order.days
    || s.env !== 0 || s.currency !== 'CNY' || s.buyQuantity !== 1
    || !plan || planIdOfOrder(order) !== plan.id
    || (s.version === 1 ? plan.id !== DEFAULT_PLAN_ID : s.planId !== plan.id || order.planId !== plan.id)
    || typeof s.productId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(s.productId)
    || typeof s.offerId !== 'string' || !/^\d{1,20}$/.test(s.offerId)) conflict();
}

// A user may cancel after local persistence but before login/create completed.
// This terminal record fences a delayed create of that same client intent.
function cancelledIntent(ctx, order) {
  return Boolean(order && order.type === 'membership_cancelled_intent' && order.status === 'cancelled'
    && order.provider === PROVIDER && order.appid === ctx.config.notifications.consumerAppId
    && order.userKey === `${order.appid}:${order.openid}` && order._id === order.outTradeNo
    && order._id === orderKey(order.userKey, order.orderId) && order.amountFen === 0 && order.days === 0
    && order.paymentSnapshot === null && order.paymentPreparedAt === null && !order.transactionId && !order.fulfilledAt);
}

const unpreparedQuote = order => Boolean(order && order.status === 'created' && !order.paymentPreparedAt
  && !order.transactionId && !order.fulfilledAt && order.providerStatus == null);
const cancelledQuote = order => Boolean(order && order.status === 'cancelled' && order.quoteCancelledAt
  && !order.paymentPreparedAt && !order.transactionId && !order.fulfilledAt);
function quoteIssue(order, product, expectedPriceFen, now) {
  if (order && order.quoteExpiresAt && now.getTime() >= Date.parse(order.quoteExpiresAt)) return 'quote_expired';
  if (order && order.amountFen !== product.priceFen) return 'price_changed';
  if (expectedPriceFen === undefined && product.planId === DEFAULT_PLAN_ID) return null;
  if (!Number.isSafeInteger(expectedPriceFen)) return 'confirmation_required';
  return expectedPriceFen === product.priceFen ? null : 'price_changed';
}
async function rejectQuote(ctx, order, clientId, product, reason) {
  // Caller holds the lease and has proved that no signature has escaped. A
  // durable cancellation fences delayed retries of this same client intent.
  if (order) {
    const nowIso = nowOf(ctx).toISOString();
    await ctx.repo.updateOrder(order._id, { status: 'cancelled', cancelledAt: nowIso, quoteCancelledAt: nowIso, paymentPreparedAt: null });
  }
  throw new ApiError('payment_price_changed', '价格或报价有效期已更新，请确认后重新购买',
    { product, orderId: clientId, canDiscardIntent: true, reason });
}

async function withOrderLease(ctx, id, work) {
  const ownerId = randomUUID(); const now = nowOf(ctx);
  const lease = await ctx.repo.acquireLease({ id: `pay_order_${id}`, ownerId, now: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString() });
  if (!lease.acquired) throw new ApiError('payment_pending', '这笔订单正在确认中，请稍后查询');
  try { return await work(); }
  finally {
    // Cleanup must not replace a durable fulfilment or the actual payment
    // error. A failed release remains fenced until the existing lease expires.
    try { await ctx.repo.releaseLease({ id: `pay_order_${id}`, ownerId }); }
    catch {
      try { if (ctx.log && typeof ctx.log.warn === 'function') ctx.log.warn('[payment] order lease cleanup failed'); }
      catch { /* Logging is also noncritical after the order work completes. */ }
    }
  }
}

async function resultOf(ctx, order, providerState, canPrepare = false) {
  const user = await ctx.repo.getUser(order.userKey);
  if (!user) throw new ApiError('user_missing', '用户不存在');
  return { order, membership: membershipSnapshot(user, nowOf(ctx)), providerState, canPrepare };
}

async function reconcileLocked(ctx, inputOrder, { acknowledge = true, permitUnprepared = false } = {}) {
  let order = await ctx.repo.getOrder(inputOrder._id);
  validateOrder(ctx, order);
  if (cancelledIntent(ctx, order) || cancelledQuote(order)) return resultOf(ctx, order, 'cancelled');
  if (unpreparedQuote(order) && order.quoteExpiresAt && nowOf(ctx).getTime() >= Date.parse(order.quoteExpiresAt)) {
    const nowIso = nowOf(ctx).toISOString();
    order = await ctx.repo.updateOrder(order._id, { status: 'cancelled', cancelledAt: nowIso, quoteCancelledAt: nowIso });
    return resultOf(ctx, order, 'cancelled');
  }
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

/** Checking and abandoning share the same fence as payment callbacks. */
async function abandonPurchase(ctx, user, clientId) {
  const id = orderKey(user._id, clientId);
  try {
    return await withOrderLease(ctx, id, async () => {
      const existing = await ctx.repo.getOrder(id);
      if (!existing) {
        const nowIso = nowOf(ctx).toISOString();
        const result = await ctx.repo.createOrderIfAbsent({ _id: id, outTradeNo: id, orderId: clientId,
          userKey: user._id, appid: user.appid, openid: user.openid, type: 'membership_cancelled_intent',
          provider: PROVIDER, productId: null, amountFen: 0, days: 0, status: 'cancelled',
          paymentSnapshot: null, paymentPreparedAt: null, paidAt: null, fulfilledAt: null,
          createdAt: nowIso, cancelledAt: nowIso, lastReconciledAt: nowIso });
        validateOrder(ctx, result.order);
        return resultOf(ctx, result.order, 'cancelled');
      }
      if (existing.userKey !== user._id || existing.orderId !== clientId) conflict();
      let result;
      try {
        result = await reconcileLocked(ctx, existing, { permitUnprepared: true });
      } catch (error) {
        // Verification outages must not trap an unpaid checkout forever.
        // Contradictory evidence and in-flight payment leases still block.
        // A late payment of an abandoned order remains fulfillable.
        const code = error && error.code;
        const openUnpaid = existing.status === 'created' && !existing.transactionId && !existing.fulfilledAt && !existing.abandonedAt;
        const verificationOutage = error instanceof PaymentProtocolError
          || ['payment_check_pending', 'payment_timeout', 'payment_invalid_order_response', 'payment_transport_unavailable',
            'payment_consumer_appid_mismatch', 'payment_consumer_secret_missing', 'payment_appkey_missing',
            'payment_access_token_failed'].includes(code);
        if (!openUnpaid || !verificationOutage || code === 'payment_evidence_mismatch' || code === 'payment_pending') throw error;
        const nowIso = nowOf(ctx).toISOString();
        const order = await ctx.repo.updateOrder(existing._id, { abandonedAt: nowIso, lastReconciledAt: nowIso });
        return resultOf(ctx, order, 'abandoned_unverified');
      }
      let order = result.order;
      // A failed query is not proof that nothing was paid. Only a successful
      // reconciliation (or an intent that never issued signatures) gets here.
      if (order.status === 'created' && !order.transactionId && !order.abandonedAt) {
        order = await ctx.repo.updateOrder(order._id, { abandonedAt: nowOf(ctx).toISOString() });
      }
      return resultOf(ctx, order, result.providerState);
    });
  } catch (error) { throw protocolError(error); }
}

async function createPurchase(ctx, user, clientId, loginCode, requestedPlanId, expectedPriceFen) {
  const id = orderKey(user._id, clientId);
  try {
    return await withOrderLease(ctx, id, async () => {
      let order = await ctx.repo.getOrder(id);
      if (order) {
        if (order.userKey !== user._id || order.orderId !== clientId) conflict();
        validateOrder(ctx, order);
        if (unpreparedQuote(order)) {
          const product = presentProduct(ctx, planIdOfOrder(order));
          const reason = quoteIssue(order, product, expectedPriceFen, nowOf(ctx));
          if (reason) await rejectQuote(ctx, order, clientId, product, reason);
        }
        const reconciled = await reconcileLocked(ctx, order, { acknowledge: true, permitUnprepared: true });
        order = reconciled.order;
        // Unpaid open checkouts may re-enter the cashier on the same order id
        // when the platform never confirmed a payment status. Paid, pending
        // (status 0/1) and abandoned orders never receive a new signature.
        const reopenCashier = (reconciled.canPrepare || (order.status === 'created' && !order.transactionId
          && !order.fulfilledAt && order.providerStatus == null)) && !order.abandonedAt;
        if (!reopenCashier) return { ...reconciled, payment: null,
          pending: !order.abandonedAt && ['created', 'pending'].includes(reconciled.providerState) };
      }
      // Reusing an existing intent always retains its immutable plan, even if
      // the caller selected another plan since opening the original checkout.
      const planId = order ? planIdOfOrder(order) : requestedPlanId === undefined ? DEFAULT_PLAN_ID : requestedPlanId;
      const product = presentProduct(ctx, planId);
      if (!product.paymentReady) return { disabled: true, product };
      const reason = quoteIssue(order, product, expectedPriceFen, nowOf(ctx));
      if (reason) await rejectQuote(ctx, order, clientId, product, reason);
      if (!order) {
        const nowIso = nowOf(ctx).toISOString();
        const vp = ctx.config.virtualPayment;
        const snapshot = { version: planId === DEFAULT_PLAN_ID ? 1 : 4,
          ...(planId === DEFAULT_PLAN_ID ? {} : { planId }), provider: PROVIDER, appid: user.appid, offerId: vp.offerId,
          productId: product.productId, priceFen: product.priceFen, days: product.days, currency: 'CNY', env: 0, buyQuantity: 1,
          // goodsPrice is the charged unit price. Standard/strikethrough prices
          // stay UI-only and never enter the signed snapshot.
          ...(planId === DEFAULT_PLAN_ID ? {} : { goodsPrice: product.priceFen,
            activitySellingPrice: null,
            promotionEndsAt: product.promotion.active ? product.promotion.endsAt : null }) };
        const promotionEnd = product.promotion && product.promotion.active ? Date.parse(product.promotion.endsAt) : NaN;
        const quoteExpiresAt = new Date(Math.min(Date.parse(nowIso) + QUOTE_TTL_MS,
          Number.isFinite(promotionEnd) ? promotionEnd : Infinity)).toISOString();
        const created = await ctx.repo.createOrderIfAbsent({ _id: id, outTradeNo: id, orderId: clientId,
          userKey: user._id, appid: user.appid, openid: user.openid, productId: product.productId, planId,
          type: 'membership_order', provider: PROVIDER, source: 'virtual_payment',
          amountFen: product.priceFen, days: product.days, paymentSnapshot: snapshot, status: 'created', createdAt: nowIso, quoteExpiresAt,
          paidAt: null, fulfilledAt: null, providerStatus: null, paymentPreparedAt: null,
          lastReconciledAt: '1970-01-01T00:00:00.000Z', providerAcknowledgedAt: null });
        order = created.order;
      }
      validateOrder(ctx, order);
      // Existing snapshots cannot silently change into a different product.
      if (order.paymentSnapshot.offerId !== ctx.config.virtualPayment.offerId || order.productId !== product.productId) conflict();
      const payment = await paymentProviderFor(ctx, planId).preparePayment({ outTradeNo: order.outTradeNo, openid: order.openid, appid: order.appid, loginCode });
      // code2Session may cross the quote/promotion boundary. Never return the
      // now-stale signature, even if it was valid before that network wait.
      const current = presentProduct(ctx, planId);
      const changed = quoteIssue(order, current, expectedPriceFen, nowOf(ctx));
      if (changed) await rejectQuote(ctx, order, clientId, current, changed);
      // Persist BEFORE returning any usable payment signature to the client.
      order = await ctx.repo.updateOrder(order._id, { paymentPreparedAt: nowOf(ctx).toISOString() });
      const prepared = await resultOf(ctx, order, 'prepared');
      const latest = presentProduct(ctx, planId);
      const expiredWhilePersisting = quoteIssue(order, latest, expectedPriceFen, nowOf(ctx));
      if (expiredWhilePersisting) await rejectQuote(ctx, order, clientId, latest, expiredWhilePersisting);
      return { ...prepared, payment, pending: false };
    });
  } catch (error) { throw protocolError(error); }
}

module.exports = { paymentProviderFor, paymentProduct, paymentProducts, reconcileOrder, abandonPurchase, createPurchase, orderKey, protocolError, PROVIDER, planIdOfOrder };
