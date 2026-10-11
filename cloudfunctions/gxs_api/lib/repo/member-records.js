'use strict';
const { ApiError } = require('../errors');
const { COLLECTIONS: C } = require('../collections');

const hasTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Hiding a receipt must never remove the only visible recovery for a payment. */
function canClearRecord(order) {
  if (!order) return false;
  if (['fulfilled', 'refunded'].includes(order.status)) return true;
  if (order.status === 'cancelled') return !order.transactionId && !order.paidAt && !order.fulfilledAt && order.entitlementFulfilled !== true;
  // Partial refund may be an intermediate transaction before the remaining
  // entitlement is granted. Wait until the durable grant has completed.
  if (order.status === 'partially_refunded') return order.entitlementFulfilled === true || hasTime(order.fulfilledAt);
  if (order.status !== 'created' || !hasTime(order.abandonedAt) || order.provider !== 'wechat_virtual_payment'
    || order.transactionId || order.paidAt || order.fulfilledAt || order.entitlementFulfilled === true
    || !hasTime(order.lastReconciledAt)) return false;
  // abandonPurchase confirms an unpaid provider status, or that no payment
  // parameters were ever issued. A late payment remains reconcilable by ID.
  return [0, 1].includes(order.providerStatus) || (order.providerStatus == null && !order.paymentPreparedAt);
}

function memberRecordMethods(transaction) {
  return {
    hideMemberRecords: ({ userKey, records, nowIso }) => transaction(async tx => {
      if (!Array.isArray(records) || records.length < 1 || records.length > 10) throw new ApiError('invalid_order_ids', '请选择 1 至 10 条订单记录');
      const selected = [];
      // Read and validate every target before any mutation. Keys are derived
      // by the service from this caller, not accepted from client payloads.
      for (const { orderId, keys } of records) {
        const found = [];
        for (const key of keys) {
          const order = await tx.get(C.orders, key);
          if (!order) continue;
          if (order.userKey !== userKey || order.orderId !== orderId || order._id !== key) throw new ApiError('unknown_order', '订单不存在');
          found.push(order);
        }
        if (!found.length) throw new ApiError('unknown_order', '订单不存在');
        if (found.length > 1) throw new ApiError('order_record_conflict', '订单记录需要核对，请稍后再试');
        selected.push(found[0]);
      }
      const hiddenOrderIds = [], retained = [];
      let newlyHiddenCount = 0;
      for (const order of selected) {
        if (order.userHiddenAt) { hiddenOrderIds.push(order.orderId); continue; }
        if (!canClearRecord(order)) {
          retained.push({ orderId: order.orderId, status: order.status || 'unknown', reason: 'payment_unconfirmed' });
          continue;
        }
        await tx.put(C.orders, { ...order, userHiddenAt: nowIso });
        hiddenOrderIds.push(order.orderId); newlyHiddenCount++;
      }
      return { hiddenOrderIds, hiddenCount: hiddenOrderIds.length, newlyHiddenCount, retained, retainedCount: retained.length };
    }),
  };
}

module.exports = { canClearRecord, memberRecordMethods };
