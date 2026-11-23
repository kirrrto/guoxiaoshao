'use strict';
const { consumerAppid } = require('../connection');

const GIFT_ID = 'owner_annual_pass_v1';
const GIFT_SOURCE = 'owner_annual_gift';
const ANNUAL_PLAN = 'member_365d';
const ANNUAL_DAYS = 365;
const ANNUAL_MS = ANNUAL_DAYS * 86400000;

function isConsumerTarget(userKey) {
  if (typeof userKey !== 'string') return false;
  const parts = userKey.split(':');
  return parts.length === 2 && parts[0] === consumerAppid && /^[a-zA-Z0-9_-]{16,128}$/.test(parts[1]);
}

const giftRecordId = userKey => userKey + '|' + GIFT_ID;

// The zero-price gift has its own receipt. It never provides payment evidence.
function verifiedGiftPlan(order, user) {
  if (!order || !user || !isConsumerTarget(user._id) || user.appid !== consumerAppid
    || user._id !== user.appid + ':' + user.openid) return null;
  const id = giftRecordId(user._id);
  return order._id === id && order.orderId === GIFT_ID && order.userKey === user._id
    && order.type === GIFT_SOURCE && order.source === 'admin_grant' && order.productId === 'admin_grant'
    && order.planId === ANNUAL_PLAN && order.days === ANNUAL_DAYS && order.amountFen === 0
    && !order.paidAt && !order.provider && !order.transactionId && order.status === 'fulfilled'
    && Number.isFinite(Date.parse(order.fulfilledAt)) && order.entitlementFulfilled === true
    && order.entitlementSourceId === id && order.entitlementGrantedMs === ANNUAL_MS ? ANNUAL_PLAN : null;
}

module.exports = { GIFT_ID, GIFT_SOURCE, ANNUAL_PLAN, ANNUAL_DAYS, ANNUAL_MS, giftRecordId, isConsumerTarget, verifiedGiftPlan };
