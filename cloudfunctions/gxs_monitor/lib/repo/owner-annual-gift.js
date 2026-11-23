'use strict';
const { ApiError } = require('../errors');
const { COLLECTIONS: C } = require('../collections');
const { membershipSnapshot } = require('../rules/membership');
const { grant } = require('../rules/membership-entitlements');
const { GIFT_ID, GIFT_SOURCE, ANNUAL_PLAN, ANNUAL_DAYS, ANNUAL_MS,
  giftRecordId, isConsumerTarget, verifiedGiftPlan } = require('../rules/owner-annual-gift');

async function grantOwnerAnnualPassIn(tx, { userKey, nowIso }, hydrateMemberPlansIn) {
  if (!isConsumerTarget(userKey)) throw new ApiError('gift_not_configured', '赠送账号尚未配置');
  const conflict = () => new ApiError('owner_gift_conflict', '年卡赠送记录需要核对');
  // A single global decision also prevents an environment-variable change
  // or simultaneous calls from redirecting this campaign to a second account.
  const decision = await tx.get(C.config, GIFT_ID);
  if (decision && decision.userKey !== userKey) throw conflict();
  const user = await tx.get(C.users, userKey);
  if (!user) throw new ApiError('unknown_user', '赠送账号不存在');
  if (user._id !== userKey || user.appid + ':' + user.openid !== userKey) throw conflict();
  const id = giftRecordId(userKey);
  const order = await tx.get(C.orders, id);
  await hydrateMemberPlansIn(tx, user);
  const result = status => {
    const membership = membershipSnapshot(user, new Date(nowIso));
    return { status, membership, canWatchMarkets: membership.enhanced };
  };
  if (decision) {
    if (decision.status === 'already_annual' && !order) return result('already_annual');
    if (decision.status !== 'granted' || !verifiedGiftPlan(order, user)) throw conflict();
    return result('already_granted');
  }
  if (order || user.membership?.entitlements?.segments?.some(segment => segment.orderId === id)
    || Date.parse(user.membership?.entitlements?.settledAt || user.membership?.updatedAt) > Date.parse(nowIso)) throw conflict();
  if (result('already_annual').membership.planId === ANNUAL_PLAN) {
    await tx.put(C.config, { _id: GIFT_ID, userKey, status: 'already_annual', decidedAt: nowIso });
    return result('already_annual');
  }
  const membership = grant(user.membership || {}, { orderId: id, source: GIFT_SOURCE,
    planId: ANNUAL_PLAN, milliseconds: ANNUAL_MS, nowIso });
  // Consume the 365 gifted days first. Existing monthly or gifted time resumes
  // afterwards and never expands the annual tier or loses refund attribution.
  const segments = membership.entitlements.segments;
  segments.unshift(segments.pop());
  membership.entitlements.planMetadataVersion = 1;
  user.membership = { ...membership, lastOrderId: GIFT_ID };
  await tx.put(C.users, user);
  await tx.put(C.orders, { _id: id, orderId: GIFT_ID, userKey, type: GIFT_SOURCE, source: 'admin_grant',
    productId: 'admin_grant', planId: ANNUAL_PLAN, days: ANNUAL_DAYS, amountFen: 0, status: 'fulfilled',
    createdAt: nowIso, paidAt: null, fulfilledAt: nowIso, entitlementFulfilled: true,
    entitlementSourceId: id, entitlementGrantedMs: ANNUAL_MS });
  await tx.put(C.config, { _id: GIFT_ID, userKey, status: 'granted', decidedAt: nowIso });
  return result('granted');
}

module.exports = { grantOwnerAnnualPassIn };
