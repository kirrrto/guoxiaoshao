'use strict';

// Logical plan IDs are independent of the merchant's published goods IDs.
// Price/duration pairs are server-owned and never supplied by checkout clients.
const PLANS = Object.freeze([
  Object.freeze({ id: 'member_7d', title: '果小哨会员 · 7 天', days: 7, priceFen: 700 }),
  Object.freeze({ id: 'member_30d', title: '果小哨会员 · 30 天', days: 30, priceFen: 3000 }),
  Object.freeze({ id: 'member_365d', title: '果小哨会员 · 365 天', days: 365, priceFen: 36000 }),
]);
const DEFAULT_PLAN_ID = PLANS[0].id;
// Historical v3 receipts keep their original cutoff; new prices have no scheduled end.
const PROMOTION_ENDS_AT = '2026-11-30T16:00:00.000Z';
const QUOTE_TTL_MS = 10 * 60 * 1000;
const PROMOTIONAL_PRICES = Object.freeze({ member_30d: 1499, member_365d: 12900 });
const HISTORICAL_PRICES = Object.freeze({ member_7d: 700, member_30d: 1990, member_365d: 20000 });
const findPlan = id => PLANS.find(plan => plan.id === id) || null;
// Historical receipts retain their original terms across pricing changes.
const planForTerms = (days, priceFen) => Number.isSafeInteger(priceFen) && PLANS.find(plan => plan.days === days
  && [plan.priceFen, HISTORICAL_PRICES[plan.id], PROMOTIONAL_PRICES[plan.id]].includes(priceFen)) || null;
const planIdOfOrder = order => order && (order.planId || order.paymentSnapshot && order.paymentSnapshot.planId
  || (order.days === 7 && order.amountFen === 700 ? DEFAULT_PLAN_ID : null));

function pricedPlan(id, now) {
  const plan = findPlan(id);
  if (!plan) return null;
  const active = Object.hasOwn(PROMOTIONAL_PRICES, id);
  return { ...plan, standardPriceFen: plan.priceFen, priceFen: active ? PROMOTIONAL_PRICES[id] : plan.priceFen,
    promotion: id === DEFAULT_PLAN_ID ? null : { active, endsAt: null, timezone: 'Asia/Shanghai' } };
}

function snapshotTermsValid(order) {
  const s = order && order.paymentSnapshot;
  const plan = order && planForTerms(order.days, order.amountFen);
  if (!s || !plan) return false;
  if (s.version === 1) return plan.id === DEFAULT_PLAN_ID && order.amountFen === 700;
  if (s.version === 2) return order.amountFen === HISTORICAL_PRICES[plan.id];
  if (![3, 4].includes(s.version) || plan.id === DEFAULT_PLAN_ID) return false;
  const created = Date.parse(order.createdAt), expires = Date.parse(order.quoteExpiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires > created + QUOTE_TTL_MS) return false;
  // Current signing uses the charged amount as goodsPrice and never sends
  // activitySellingPrice. Issued legacy promo snapshots kept the standard
  // goodsPrice plus activitySellingPrice and stay valid for recovery.
  const promo = order.amountFen === PROMOTIONAL_PRICES[plan.id];
  const charged = s.goodsPrice === order.amountFen && s.activitySellingPrice == null;
  // New ongoing-price receipts have a finite quote lifetime, not an offer deadline.
  // Keep v3's historical amount/date checks below unchanged for issued orders.
  if (s.version === 4) return promo && charged && s.promotionEndsAt === null;
  const legacyPromo = promo && s.goodsPrice === plan.priceFen && s.activitySellingPrice === order.amountFen;
  if (!charged && !legacyPromo) return false;
  if (promo) return s.promotionEndsAt === PROMOTION_ENDS_AT && created < Date.parse(PROMOTION_ENDS_AT) && expires <= Date.parse(PROMOTION_ENDS_AT);
  return order.amountFen === plan.priceFen && s.activitySellingPrice == null && s.promotionEndsAt == null
    && created >= Date.parse(PROMOTION_ENDS_AT);
}

module.exports = { PLANS, DEFAULT_PLAN_ID, findPlan, pricedPlan, planForTerms, planIdOfOrder, snapshotTermsValid, PROMOTION_ENDS_AT, QUOTE_TTL_MS };
