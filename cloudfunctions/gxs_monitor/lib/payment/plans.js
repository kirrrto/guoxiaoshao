'use strict';

// Logical plan IDs are independent of the merchant's published goods IDs.
// Price/duration pairs are server-owned and never supplied by checkout clients.
const PLANS = Object.freeze([
  Object.freeze({ id: 'member_7d', title: '果小哨会员 · 7 天', days: 7, priceFen: 700 }),
  Object.freeze({ id: 'member_30d', title: '果小哨会员 · 30 天', days: 30, priceFen: 1990 }),
  Object.freeze({ id: 'member_365d', title: '果小哨会员 · 365 天', days: 365, priceFen: 20000 }),
]);
const DEFAULT_PLAN_ID = PLANS[0].id;
const findPlan = id => PLANS.find(plan => plan.id === id) || null;
const planForTerms = (days, priceFen) => PLANS.find(plan => plan.days === days && plan.priceFen === priceFen) || null;
const planIdOfOrder = order => order && (order.planId || order.paymentSnapshot && order.paymentSnapshot.planId
  || (order.days === 7 && order.amountFen === 700 ? DEFAULT_PLAN_ID : null));

module.exports = { PLANS, DEFAULT_PLAN_ID, findPlan, planForTerms, planIdOfOrder };
