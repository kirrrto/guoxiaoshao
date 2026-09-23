'use strict';
const { ApiError } = require('../errors');
const { membershipSnapshot } = require('../rules/membership');
const { ensureUser } = require('./users');
const { COLLECTIONS } = require('../collections');
const { CAMPAIGN, hashCode } = require('../member-redemption');
const paymentService = require('../payment/service');

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

async function status(ctx) {
  const user = await ensureUser(ctx);
  const orders = await ctx.repo.listOrders(user._id, 10);
  return {
    membership: membershipSnapshot(user, ctx.now),
    product: paymentService.paymentProduct(ctx),
    payment: paymentService.paymentProviderFor(ctx).getReadiness(),
    orders: orders.map(publicOrder),
  };
}

async function createOrder(ctx, payload) {
  const user = await ensureUser(ctx);
  const orderId = typeof payload.orderId === 'string' && ID_PATTERN.test(payload.orderId) ? payload.orderId : null;
  if (!orderId) throw new ApiError('invalid_order_id', 'orderId 需为 8–64 位字母数字标识');
  const result = await paymentService.createPurchase(ctx, user, orderId, payload.loginCode);
  if (result.disabled) return { ok: false, reason: 'payment_not_enabled', product: result.product };
  return { ok: !result.pending, reason: result.pending ? 'payment_pending' : null,
    order: publicOrder(result.order), payment: result.payment, membership: result.membership };
}

async function checkOrder(ctx, payload) {
  const user = await ensureUser(ctx);
  const orderId = typeof payload.orderId === 'string' && ID_PATTERN.test(payload.orderId) ? payload.orderId : null;
  if (!orderId) throw new ApiError('invalid_order_id', '订单编号无效');
  const order = await ctx.repo.getOrder(paymentService.orderKey(user._id, orderId));
  if (!order || order.userKey !== user._id || order.orderId !== orderId) throw new ApiError('unknown_order', '订单不存在');
  const result = await paymentService.reconcileOrder(ctx, order, { permitUnprepared: true });
  return { order: publicOrder(result.order), membership: result.membership };
}

/**
 * Walk away from an unpaid order, e.g. an iPhone whose Apple ID cannot pay in
 * CNY. The platform is asked first, so a completed payment is fulfilled as
 * usual. An abandoned order stays reconcilable: a late payment still activates
 * membership, while the client is free to start a new purchase.
 */
async function abandonOrder(ctx, payload) {
  const user = await ensureUser(ctx);
  const orderId = typeof payload.orderId === 'string' && ID_PATTERN.test(payload.orderId) ? payload.orderId : null;
  if (!orderId) throw new ApiError('invalid_order_id', '订单编号无效');
  let order = await ctx.repo.getOrder(paymentService.orderKey(user._id, orderId));
  if (!order || order.userKey !== user._id || order.orderId !== orderId) throw new ApiError('unknown_order', '订单不存在');
  try { order = (await paymentService.reconcileOrder(ctx, order, { permitUnprepared: true })).order; }
  catch { order = await ctx.repo.getOrder(order._id); /* Unreachable platform: reconciliation continues after abandoning. */ }
  if (order.status === 'created' && !order.transactionId && !order.abandonedAt) order = await ctx.repo.updateOrder(order._id, { abandonedAt: ctx.nowIso });
  return { order: publicOrder(order), membership: membershipSnapshot(await ctx.repo.getUser(user._id), ctx.now) };
}

function publicOrder(order) {
  return { orderId: order.orderId, status: order.status, amountFen: order.amountFen, days: order.days, createdAt: order.createdAt, paidAt: order.paidAt || null, fulfilledAt: order.fulfilledAt || null,
    refundFen: Number.isSafeInteger(order.refundFen) ? order.refundFen : 0,
    providerStatus: Number.isInteger(order.providerStatus) ? order.providerStatus : null,
    paymentPending: order.provider === paymentService.PROVIDER && order.status === 'created' && !order.abandonedAt && [0, 1].includes(order.providerStatus),
    abandoned: order.status === 'created' && Boolean(order.abandonedAt),
    type: order.type || (order.productId === 'admin_grant' ? 'admin_grant' : 'membership_order'), source: order.source || (order.productId === 'admin_grant' ? 'admin_grant' : null), campaignId: order.campaignId || null };
}

async function redeemCode(ctx, payload) {
  const user = await ensureUser(ctx);
  // Only the trusted caller identity reaches the transaction. The submitted
  // code is neither persisted nor echoed in a response or error.
  const request = { userKey: user._id, codeHash: hashCode(payload.code), nowIso: ctx.nowIso };
  let result = await ctx.repo.redeemMembershipCode(request);
  if (result.seedClaims) {
    // First redemption under the cap: start the counter from every account that
    // already redeemed. Concurrent seeders count the same total; one write wins.
    const claimed = await ctx.repo.count(COLLECTIONS.orders, { type: 'membership_redemption', campaignId: CAMPAIGN.id });
    await ctx.repo.seedRedemptionClaims({ claimed, nowIso: ctx.nowIso });
    result = await ctx.repo.redeemMembershipCode(request);
    if (result.seedClaims) throw new ApiError('redemption_unavailable', '兑换暂时无法完成，请稍后再试');
  }
  // Wrong attempts must commit before returning an API error; throwing inside
  // the transaction would roll back the anti-guessing counter.
  if (result.error) throw new ApiError(result.error.code, result.error.message, result.error.details);
  return { redeemed: true, alreadyRedeemed: result.alreadyRedeemed, membership: membershipSnapshot(result.user, ctx.now) };
}

/**
 * Fulfil a paid order exactly once: extends membership from the later of now
 * and the current expiry. Used by the payment callback and by admin grants.
 */
async function fulfilOrder(ctx, order, source) {
  return ctx.repo.fulfilMembershipOrder({ orderId: order._id, source, nowIso: ctx.nowIso });
}

module.exports = { status, createOrder, checkOrder, abandonOrder, redeemCode, fulfilOrder, publicOrder };
