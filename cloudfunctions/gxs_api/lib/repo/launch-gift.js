'use strict';
const { COLLECTIONS: C } = require('../collections');
const { dayKey } = require('../time');
const { planSnapshot } = require('../rules/membership');
const entitlements = require('../rules/membership-entitlements');
const { CAMPAIGN_ID, CAMPAIGN_DAY, DAY_MS, SUGGESTED_CUTOFF_EXCLUSIVE, historicalPaymentFact,
  previousGiftState, touchEvidenceIds, paymentReceiptId } = require('../rules/launch-gift');

function launchGiftMethods(run, { hydrateMemberPlansIn }) {
  async function inspectPayment(tx, orderId, options) {
    const order = await tx.get(C.orders, orderId);
    const user = order && typeof order.userKey === 'string' && order.userKey
      ? await tx.get(C.users, order.userKey) : null;
    const receipt = order && typeof order.transactionId === 'string' && order.transactionId
      ? await tx.get(C.config, paymentReceiptId(order.transactionId)) : null;
    return { userKey: order && order.userKey || null, ...historicalPaymentFact(order, user, receipt, options) };
  }
  async function process(tx, { userKey, nowIso, evidenceOrderId, cutoffExclusive = SUGGESTED_CUTOFF_EXCLUSIVE,
    snapshotAt = nowIso, apply = false, background = false, manifestHash = null }) {
    const user = await tx.get(C.users, userKey);
    if (!user) return { status: 'account_missing', reason: 'user_missing', user: null };
    const recordId = `${userKey}|${CAMPAIGN_ID}`;
    const existing = await tx.get(C.orders, recordId);
    const prior = previousGiftState(user, existing);
    const ids = evidenceOrderId ? [evidenceOrderId] : background ? [] : touchEvidenceIds(user);
    let proof = null, uncertain = false;
    for (const id of ids) {
      const fact = await inspectPayment(tx, id, { cutoffExclusive, snapshotAt });
      if (fact.classification === 'eligible' && fact.userKey === userKey
        && (!proof || Date.parse(fact.paidAt) > Date.parse(proof.paidAt)
          || Date.parse(fact.paidAt) === Date.parse(proof.paidAt) && fact.orderId > proof.orderId)) proof = fact;
      else if (fact.classification === 'review' || fact.classification === 'account_missing') uncertain = true;
    }
    if (prior.status === 'review') return { ...prior, user };
    if (prior.status === 'already_granted') return { ...prior, user, evidenceVerified: Boolean(proof),
      ...(background && !proof ? { status: 'review', reason: 'previous_gift_without_verified_payment' } : {}) };
    if (!proof) return { status: uncertain ? 'review' : 'ineligible', reason: uncertain ? 'payment_evidence_missing_or_conflicting' : 'no_verified_payment_in_candidates', user };
    if (!background && dayKey(nowIso) !== CAMPAIGN_DAY) return { status: 'outside_access_window', reason: 'background_frozen_list_required', user };
    if (background && (!/^[a-f0-9]{64}$/.test(manifestHash || '') || !evidenceOrderId)) return { status: 'review', reason: 'frozen_manifest_required', user };
    if (Date.parse(nowIso) < Date.parse(`${CAMPAIGN_DAY}T00:00:00+08:00`) || Date.parse(snapshotAt) > Date.parse(nowIso)) {
      return { status: 'review', reason: 'invalid_execution_time', user };
    }
    if (user.membership && user.membership.entitlements
      && Date.parse(user.membership.entitlements.settledAt) > Date.parse(nowIso)) {
      return { status: 'review', reason: 'membership_clock_ahead', user };
    }
    await hydrateMemberPlansIn(tx, user);
    const planId = planSnapshot(user, new Date(nowIso)).planId;
    const giftPlanId = planId && planId !== 'member_trial' ? planId : proof.planId;
    const preview = entitlements.grant(user.membership || {}, { orderId: recordId, source: 'service_compensation',
      milliseconds: DAY_MS, nowIso, planId: giftPlanId });
    // Appending annual time after queued monthly time would promote the entire
    // intervening month. Insert beside the current tier so its cutoff grows by
    // one day only; preserve every original segment and its remaining time.
    const segments = preview.entitlements.segments;
    if (planId && planId !== 'member_trial') {
      const gift = segments.pop();
      let index = -1;
      for (let i = 0; i < segments.length; i++) if (segments[i].planId === giftPlanId) index = i;
      segments.splice(index + 1, 0, gift);
    }
    const result = { status: 'pending', reason: 'verified_historical_payment', evidenceOrderId: proof.orderId,
      giftPlanId, beforeExpiresAt: user.membership && user.membership.expiresAt || null, afterExpiresAt: preview.expiresAt,
      milliseconds: DAY_MS, user };
    if (!apply) return result;
    const order = { _id: recordId, orderId: CAMPAIGN_ID, userKey, productId: 'admin_grant', type: 'membership_compensation',
      source: 'service_compensation', planId: giftPlanId, days: 1, amountFen: 0, status: 'paid', createdAt: nowIso,
      paidAt: nowIso, fulfilledAt: null, campaignDay: CAMPAIGN_DAY, evidenceOrderId: proof.orderId,
      eligibilityCutoffExclusive: cutoffExclusive, eligibilitySnapshotAt: snapshotAt, manifestHash,
      note: '2026-10-28 苹果新品发布会员赠礼' };
    preview.entitlements.planMetadataVersion = 1;
    user.membership = { ...preview, lastOrderId: CAMPAIGN_ID, launch20261028GiftedAt: nowIso };
    await tx.put(C.users, user);
    await tx.put(C.orders, { ...order, status: 'fulfilled', fulfilledAt: nowIso, entitlementFulfilled: true,
      entitlementGrantedMs: DAY_MS, entitlementSourceId: recordId });
    return { ...result, status: 'granted', fulfilledAt: user.membership.entitlements.settledAt, user };
  }
  return {
    inspectLaunchGiftPayment: args => run(tx => inspectPayment(tx, args.orderId, args)),
    assessLaunchCelebrationGift: args => run(tx => process(tx, { ...args, apply: false })),
    applyLaunchCelebrationGift: args => run(tx => process(tx, { ...args, apply: true })),
    ensureLaunchCelebrationGift: args => run(async tx => (await process(tx, { ...args, background: false, apply: true })).user),
  };
}

module.exports = { launchGiftMethods };
