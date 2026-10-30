'use strict';
const { createHash } = require('node:crypto');
const { planForTerms, planIdOfOrder, snapshotTermsValid } = require('../payment/plans');

const CAMPAIGN_ID = 'grant_launch_20261028';
const CAMPAIGN_DAY = '2026-10-28';
const DAY_MS = 86400000;
// Implementation proposal, not a previously approved production list boundary.
const SUGGESTED_CUTOFF_EXCLUSIVE = '2026-10-28T16:00:00.000Z';
const time = value => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const paymentReceiptId = transactionId => `payment_${createHash('sha256').update(transactionId).digest('hex')}`;
const paymentOrderId = (userKey, orderId) => `G${createHash('sha256').update(`${userKey}|${orderId}`).digest('hex').slice(0, 31)}`;
const maskAccount = userKey => `account_${createHash('sha256').update(String(userKey)).digest('hex').slice(0, 16)}`;

/** Cash eligibility is separate from refundable purchased entitlements. */
function historicalPaymentFact(order, user, receipt, { cutoffExclusive, snapshotAt } = {}) {
  const result = (classification, reason, extra = {}) => ({ classification, reason, ...extra });
  if (!order) return result('review', 'payment_order_missing');
  if (!user || order.userKey !== user._id) return result('account_missing', 'payment_account_missing_or_mismatched');
  const source = order.source || order.payment && order.payment.source;
  if (order.test === true || order.productId === 'admin_grant'
    || ['membership_redemption', 'membership_compensation', 'membership_trial', 'membership_cancelled_intent'].includes(order.type)
    || ['admin', 'admin_grant', 'trial_compensation', 'service_compensation', 'redemption_code', 'gift', 'test'].includes(source)
    || /^(grant_|redeem_)/.test(order.orderId || '')) return result('ineligible', 'non_cash');
  const hasPaymentHint = order.paidAt || order.transactionId || order.fulfilledAt || order.entitlementFulfilled
    || ['paid', 'fulfilled', 'partially_refunded', 'refunded'].includes(order.status);
  if (!hasPaymentHint && ['created', 'cancelled'].includes(order.status)) return result('ineligible', 'unpaid');
  if (!time(cutoffExclusive) || !time(snapshotAt)) return result('review', 'invalid_list_boundary');
  const s = order.paymentSnapshot;
  const plan = planForTerms(order.days, order.amountFen);
  const provider = order.payment && order.payment.providerData;
  if (order.type !== 'membership_order' || order.provider !== 'wechat_virtual_payment'
    || !Number.isSafeInteger(order.amountFen) || order.amountFen <= 0
    || !['paid', 'fulfilled', 'partially_refunded', 'refunded'].includes(order.status)
    || !time(order.paidAt) || !time(order.createdAt) || Date.parse(order.paidAt) < Date.parse(order.createdAt)
    || typeof order.transactionId !== 'string' || !order.transactionId
    || order.appid !== user.appid || order.openid !== user.openid || user._id !== `${user.appid}:${user.openid}`
    || order._id !== order.outTradeNo || order._id !== paymentOrderId(user._id, order.orderId)
    || !s || !snapshotTermsValid(order) || s.provider !== order.provider || s.appid !== order.appid
    || s.productId !== order.productId || s.days !== order.days || s.priceFen !== order.amountFen
    || s.currency !== 'CNY' || s.env !== 0 || s.buyQuantity !== 1 || !plan || planIdOfOrder(order) !== plan.id
    || (s.version === 1 ? plan.id !== 'member_7d' : s.planId !== plan.id || order.planId !== plan.id)
    || !provider || provider.provider !== order.provider || provider.amountFen !== order.amountFen
    || !receipt || receipt.kind !== 'payment_receipt' || receipt.orderId !== order._id
    || receipt.transactionId !== order.transactionId || !time(receipt.createdAt)) {
    return result('review', 'payment_evidence_missing_or_conflicting');
  }
  // A late confirmation cannot silently expand the frozen historical list.
  if (Date.parse(order.paidAt) >= Date.parse(cutoffExclusive)) return result('review', 'payment_after_proposed_cutoff');
  // markOrderPaid refreshes receipt.createdAt on reconciliation. The order's
  // original paidAt is retained, so receipt time is not an eligibility clock.
  if (Date.parse(order.createdAt) > Date.parse(snapshotAt) || Date.parse(order.paidAt) > Date.parse(snapshotAt)) return result('review', 'payment_after_scan_snapshot');
  return result('eligible', 'verified_historical_payment', { planId: plan.id, paidAt: order.paidAt,
    orderId: order._id, transactionId: order.transactionId, refunded: ['partially_refunded', 'refunded'].includes(order.status) });
}

function previousGiftState(user, order) {
  const membership = user && user.membership || {};
  const marker = membership.launch20261028GiftedAt;
  const segment = (membership.entitlements && membership.entitlements.segments || []).find(item => item.orderId === `${user._id}|${CAMPAIGN_ID}`);
  const valid = order && order._id === `${user._id}|${CAMPAIGN_ID}` && order.userKey === user._id && order.orderId === CAMPAIGN_ID
    && order.amountFen === 0 && order.days === 1 && order.source === 'service_compensation'
    && order.type === 'membership_compensation' && order.status === 'fulfilled' && time(order.fulfilledAt) && time(order.createdAt)
    && Date.parse(order.fulfilledAt) >= Date.parse(order.createdAt)
    && order.entitlementFulfilled === true && order.entitlementGrantedMs === DAY_MS
    && order.entitlementSourceId === order._id;
  if (valid && (!marker || marker === order.fulfilledAt)) return { status: 'already_granted', reason: 'fulfilled_campaign_receipt', fulfilledAt: order.fulfilledAt };
  if (order || marker || segment || membership.lastOrderId === CAMPAIGN_ID) return { status: 'review', reason: 'campaign_receipt_or_marker_conflict' };
  return { status: 'absent' };
}

function touchEvidenceIds(user) {
  const membership = user.membership || {};
  const segments = membership.entitlements && membership.entitlements.segments || [];
  const ids = segments.filter(item => item.source === 'virtual_payment' && item.orderId).map(item => item.orderId);
  if (membership.lastOrderId && !/^(grant_|redeem_)/.test(membership.lastOrderId)) {
    ids.push(paymentOrderId(user._id, membership.lastOrderId), `${user._id}|${membership.lastOrderId}`, membership.lastOrderId);
  }
  // Access paths do not scan historical orders. The frozen background task covers older accounts.
  return [...new Set(ids)].slice(-32);
}

module.exports = { CAMPAIGN_ID, CAMPAIGN_DAY, DAY_MS, SUGGESTED_CUTOFF_EXCLUSIVE, historicalPaymentFact,
  previousGiftState, touchEvidenceIds, paymentReceiptId, paymentOrderId, maskAccount };
