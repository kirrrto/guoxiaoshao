'use strict';
const { createHash } = require('node:crypto');

const FEATURE_KEYS = ['contextualCheckout', 'resultNextAction', 'activationJourney', 'targetEvidence', 'growthEvents', 'experimentAssignments', 'launchGuide'];
const UI_FEATURES = FEATURE_KEYS.slice(0, 4);
const EVENTS = ['session_started', 'target_committed', 'offer_viewed', 'offer_cta_clicked', 'checkout_blocked', 'cashier_invoked', 'cashier_result', 'activation_viewed', 'purchase_feedback'];
const REASONS = ['payment_product_id_missing', 'payment_plan_disabled', 'payment_not_enabled', 'payment_server_not_ready', 'payment_devtools', 'payment_ios_disabled', 'payment_ios_version_low', 'payment_wechat_version_low', 'payment_api_unavailable', 'payment_capability_unknown', 'payment_runtime_unsupported', 'cashier_cancelled', 'cashier_result_unknown', 'feedback_no_need', 'feedback_bought', 'feedback_price_duration', 'feedback_unclear', 'feedback_trust', 'feedback_payment', 'feedback_other', 'unknown'];
const ENTRY_POINTS = ['member', 'mine', 'query', 'result', 'query_selection', 'query_result', 'follow', 'checkout', 'activation', 'share', 'unknown'];
const PLANS = ['member_7d', 'member_30d', 'member_365d'];
const EVENT_RETENTION_DAYS = 30;
const INTENT_DETAIL_DAYS = 90;
const accountKey = userKey => createHash('sha256').update(`gxs-growth-v1\n${userKey}`).digest('hex');

/** Fixed account buckets; one explicitly named experiment, never prices or entitlements. */
function runtimeFor(config, userKey) {
  const features = Object.fromEntries(FEATURE_KEYS.map(key => [key, config.features && config.features[key] === true]));
  const e = config.growthExperiment || {};
  let experiment = null;
  const active = ['aa', 'ab'].includes(e.mode) && UI_FEATURES.includes(e.feature);
  if (active && (!features.experimentAssignments || !features.growthEvents || !userKey)) features[e.feature] = false;
  if (features.experimentAssignments && features.growthEvents && userKey && active) {
    const digest = createHash('sha256').update(`${e.id}\n${e.assignmentVersion}\n${userKey}`).digest('hex');
    const bucket = parseInt(digest.slice(0, 8), 16) % 10000;
    if (bucket < e.allocationPercent * 100) {
      const variant = parseInt(digest.slice(8, 16), 16) % 2 ? 'variant' : 'control';
      experiment = { id: e.id, assignmentVersion: e.assignmentVersion, variant, mode: e.mode };
      // A/A exposes the same baseline in both arms. Master feature OFF always wins.
      features[e.feature] = features[e.feature] && e.mode === 'ab' && variant === 'variant';
    } else features[e.feature] = false;
  }
  return { features, experiment };
}

module.exports = { FEATURE_KEYS, UI_FEATURES, EVENTS, REASONS, ENTRY_POINTS, PLANS, EVENT_RETENTION_DAYS, INTENT_DETAIL_DAYS, accountKey, runtimeFor };
