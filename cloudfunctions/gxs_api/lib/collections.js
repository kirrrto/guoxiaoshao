'use strict';
/** All 果小哨 collections live in the shared environment under the `gxs_` prefix. */
const COLLECTIONS = Object.freeze({
  users: 'gxs_users',
  ledger: 'gxs_quota_ledger',
  queries: 'gxs_queries',
  follows: 'gxs_follows',
  latest: 'gxs_latest',
  observationDays: 'gxs_observation_days',
  events: 'gxs_events',
  health: 'gxs_target_health',
  orders: 'gxs_orders',
  growthEvents: 'gxs_growth_events',
  growthAccounts: 'gxs_growth_accounts',
  notifications: 'gxs_notifications',
  notificationTests: 'gxs_notification_tests',
  config: 'gxs_config',
  catalogStores: 'gxs_catalog_stores',
  catalogProducts: 'gxs_catalog_products',
});

/** Index plan used by tools/db/create-collections and documented in docs/DATA_MODEL.md. */
const INDEX_PLAN = Object.freeze({
  [COLLECTIONS.latest]: [
    { name: 'part_id', keys: { partNumber: 1, _id: 1 }, unique: false },
  ],
  [COLLECTIONS.growthEvents]: [
    { name: 'received_id', keys: { receivedAt: -1, _id: -1 }, unique: false },
    { name: 'account_received_id', keys: { accountKey: 1, receivedAt: -1, _id: -1 }, unique: false },
  ],
  [COLLECTIONS.growthAccounts]: [
    { name: 'empty_intent_updated', keys: { firstIntent: 1, updatedAt: 1 }, unique: false },
    { name: 'intent_compacted_at', keys: { 'firstIntent.compacted': 1, 'firstIntent.at': 1 }, unique: false },
  ],
  [COLLECTIONS.notificationTests]: [
    { name: 'user_created', keys: { userKey: 1, createdAt: -1 }, unique: false },
    { name: 'status_created', keys: { status: 1, createdAt: -1 }, unique: false },
  ],
  [COLLECTIONS.ledger]: [
    { name: 'user_day_created_id', keys: { userKey: 1, dayKey: 1, createdAt: -1, _id: -1 }, unique: false },
    { name: 'user_created_id', keys: { userKey: 1, createdAt: -1, _id: -1 }, unique: false },
  ],
  [COLLECTIONS.queries]: [
    { name: 'user_created_id', keys: { userKey: 1, createdAt: -1, _id: -1 }, unique: false },
    { name: 'user_status_lease_id', keys: { userKey: 1, status: 1, leaseUntil: 1, _id: 1 }, unique: false },
    { name: 'user_history_finished_id', keys: { userKey: 1, kind: 1, status: 1, finishedAt: -1, _id: -1 }, unique: false },
  ],
  [COLLECTIONS.follows]: [
    { name: 'user_status', keys: { userKey: 1, status: 1 }, unique: false },
    { name: 'status_part', keys: { status: 1, partNumber: 1 }, unique: false },
    { name: 'user_created_id_status', keys: { userKey: 1, createdAt: 1, _id: 1, status: 1 }, unique: false },
    { name: 'status_id', keys: { status: 1, _id: 1 }, unique: false },
  ],
  [COLLECTIONS.events]: [
    { name: 'target_detected', keys: { targetKey: 1, detectedAt: -1 }, unique: false },
    { name: 'part_day_detected_id', keys: { partNumber: 1, dayKey: 1, detectedAt: -1, _id: -1 }, unique: false },
    { name: 'part_day_store_detected_id', keys: { partNumber: 1, dayKey: 1, storeNumber: 1, detectedAt: -1, _id: -1 }, unique: false },
    { name: 'part_day_type_detected', keys: { partNumber: 1, dayKey: 1, type: 1, detectedAt: -1 }, unique: false },
    { name: 'part_day_store_type_detected', keys: { partNumber: 1, dayKey: 1, storeNumber: 1, type: 1, detectedAt: -1 }, unique: false },
    { name: 'notify_planning', keys: { notificationPlannedAt: 1, detectedAt: 1, _id: 1, type: 1 }, unique: false },
  ],
  [COLLECTIONS.health]: [
    { name: 'target_bucket', keys: { targetKey: 1, bucket: -1 }, unique: false },
    { name: 'recorded_at', keys: { recordedAt: 1 }, unique: false },
  ],
  [COLLECTIONS.observationDays]: [
    { name: 'part_day_store', keys: { partNumber: 1, dayKey: 1, storeNumber: 1 }, unique: false },
    { name: 'part_day_id', keys: { partNumber: 1, dayKey: 1, _id: 1 }, unique: false },
  ],
  [COLLECTIONS.orders]: [
    { name: 'user_created', keys: { userKey: 1, createdAt: -1 }, unique: false },
    { name: 'payment_out_trade_no', keys: { outTradeNo: 1 }, unique: false },
    { name: 'payment_reconcile', keys: { provider: 1, lastReconciledAt: 1, _id: 1 }, unique: false },
  ],
  [COLLECTIONS.notifications]: [
    { name: 'user_created_id_view', keys: { userKey: 1, createdAt: -1, _id: -1, userHiddenAt: 1, viewSequence: 1 }, unique: false },
    { name: 'user_view_sequence', keys: { userKey: 1, viewSequence: 1 }, unique: false },
    { name: 'status_created_id', keys: { status: 1, createdAt: 1, _id: 1 }, unique: false },
    { name: 'status_lease', keys: { status: 1, leaseUntil: 1 }, unique: false },
    { name: 'status_detected_reserved', keys: { status: 1, detectedAt: 1, subscriptionReserved: 1 }, unique: false },
  ],
  [COLLECTIONS.catalogProducts]: [
    { name: 'family', keys: { familyKey: 1 }, unique: false },
  ],
});

module.exports = { COLLECTIONS, INDEX_PLAN };
