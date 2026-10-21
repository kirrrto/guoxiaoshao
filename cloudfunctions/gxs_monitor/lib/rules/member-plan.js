'use strict';
const { dayKey, toDate } = require('../time');
const { planForTerms, planIdOfOrder, snapshotTermsValid } = require('../payment/plans');

const OUTAGE_COMPENSATION_DAY = '2026-10-21';
const OUTAGE_COMPENSATION_ORDER_ID = 'grant_outage_20261021';

/** Only immutable, server-confirmed purchase terms can grant the extra slots. */
function purchasedPlan(order, user, granting = false) {
  const s = order && order.paymentSnapshot;
  const plan = order && planForTerms(order.days, order.amountFen);
  const fulfilled = order && (order.entitlementFulfilled === true || order.fulfilledAt || order.status === 'fulfilled');
  if (!order || !user || order.userKey !== user._id || order.provider !== 'wechat_virtual_payment'
    || order.type !== 'membership_order' || (!granting && !fulfilled)
    || !['paid', 'fulfilled', 'partially_refunded'].includes(order.status)
    || !s || !snapshotTermsValid(order) || s.provider !== order.provider
    || order.appid !== user.appid || order.openid !== user.openid || s.appid !== order.appid
    || s.productId !== order.productId || s.days !== order.days || s.priceFen !== order.amountFen
    || s.currency !== 'CNY' || s.env !== 0 || s.buyQuantity !== 1 || !plan || planIdOfOrder(order) !== plan.id
    || (s.version === 1 ? plan.id !== 'member_7d' : s.planId !== plan.id || order.planId !== plan.id)) return null;
  return plan.id;
}

function needsPlanMetadata(user) {
  const ledger = user && user.membership && user.membership.entitlements;
  return Boolean(ledger && ledger.planMetadataVersion !== 1);
}

async function resolvePlanMetadata(user, getOrder) {
  if (!needsPlanMetadata(user)) return user;
  const ledger = user.membership.entitlements;
  const segments = [];
  for (const segment of ledger.segments) {
    const { planId: existingPlanId, ...saved } = segment;
    const order = segment.source === 'virtual_payment' && segment.orderId ? await getOrder(segment.orderId) : null;
    const planId = segment.source === 'virtual_payment' ? purchasedPlan(order, user)
      : ['service_compensation', 'trial_compensation'].includes(segment.source) ? existingPlanId : null;
    segments.push({ ...saved, ...(planId ? { planId } : {}) });
  }
  return { ...user, membership: { ...user.membership, entitlements: { ...ledger, segments, planMetadataVersion: 1 } } };
}

/** Used by API and workers; the migration transaction rereads authoritative orders. */
async function ensurePlanMetadata(repo, user) {
  if (!needsPlanMetadata(user) || typeof repo.ensureMemberPlanMetadata !== 'function') return user;
  return await repo.ensureMemberPlanMetadata({ userKey: user._id }) || user;
}

function needsOutageCompensation(user, now) {
  if (!user || !user._id || !now) return false;
  const nowIso = toDate(now).toISOString();
  if (dayKey(nowIso) !== OUTAGE_COMPENSATION_DAY) return false;
  const membership = user.membership || {};
  if (membership.outage20261021CompensatedAt) return false;
  const recordId = `${user._id}|${OUTAGE_COMPENSATION_ORDER_ID}`;
  if (membership.lastOrderId === OUTAGE_COMPENSATION_ORDER_ID) return false;
  const segments = membership.entitlements && Array.isArray(membership.entitlements.segments) ? membership.entitlements.segments : [];
  return !segments.some(segment => segment && segment.orderId === recordId);
}

async function ensureOutageCompensation(repo, user, now) {
  if (!needsOutageCompensation(user, now) || typeof repo.ensureOutageCompensation !== 'function') return user;
  return await repo.ensureOutageCompensation({ userKey: user._id, nowIso: toDate(now).toISOString() }) || user;
}

module.exports = {
  OUTAGE_COMPENSATION_DAY,
  OUTAGE_COMPENSATION_ORDER_ID,
  purchasedPlan,
  needsPlanMetadata,
  ensurePlanMetadata,
  resolvePlanMetadata,
  needsOutageCompensation,
  ensureOutageCompensation,
};
