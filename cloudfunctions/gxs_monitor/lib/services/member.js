'use strict';
const { ApiError } = require('../errors');
const { membershipSnapshot } = require('../rules/membership');
const { ensureUser } = require('./users');
const { hashCode } = require('../member-redemption');

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

async function status(ctx) {
  const user = await ensureUser(ctx);
  const orders = await ctx.repo.listOrders(user._id, 10);
  return {
    membership: membershipSnapshot(user, ctx.now),
    product: { ...ctx.config.memberProduct, enabled: false, paymentReady: false, paymentReason: '会员购买暂未开放' },
    payment: { ready: false, reason: '会员购买暂未开放', provider: null },
    orders: orders.map(publicOrder),
  };
}

/**
 * Create a membership order. Payment collection is intentionally disabled
 * until subject verification, filing and a later payment integration complete.
 * No unpaid placeholder order is created during this deferred phase.
 */
async function createOrder(ctx, payload) {
  await ensureUser(ctx);
  // Opening payment is deferred until subject verification and filing complete.
  // A runtime flag alone must never expose an unfinished purchase flow.
  const product = { ...ctx.config.memberProduct, enabled: false };
  const orderId = typeof payload.orderId === 'string' && ID_PATTERN.test(payload.orderId) ? payload.orderId : null;
  if (!orderId) throw new ApiError('invalid_order_id', 'orderId 需为 8–64 位字母数字标识');
  return { ok: false, reason: 'payment_not_enabled', product: { id: product.id, title: product.title, priceFen: product.priceFen, days: product.days, enabled: false, paymentReady: false } };
}

function publicOrder(order) {
  return { orderId: order.orderId, status: order.status, amountFen: order.amountFen, days: order.days, createdAt: order.createdAt, paidAt: order.paidAt || null, fulfilledAt: order.fulfilledAt || null, type: order.type || (order.productId === 'admin_grant' ? 'admin_grant' : 'membership_order'), source: order.source || (order.productId === 'admin_grant' ? 'admin_grant' : null), campaignId: order.campaignId || null };
}

async function redeemCode(ctx, payload) {
  const user = await ensureUser(ctx);
  // Only the trusted caller identity reaches the transaction. The submitted
  // code is neither persisted nor echoed in a response or error.
  const result = await ctx.repo.redeemMembershipCode({ userKey: user._id, codeHash: hashCode(payload.code), nowIso: ctx.nowIso });
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

module.exports = { status, createOrder, redeemCode, fulfilOrder, publicOrder };
