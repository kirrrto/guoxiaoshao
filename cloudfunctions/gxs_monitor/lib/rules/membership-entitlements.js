'use strict';
const { ApiError } = require('../errors');
const DAY_MS = 86400000;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new ApiError('invalid_membership_state', '会员权益记录状态异常，请联系客服核对'); };
const parseTime = value => { const ms = Date.parse(value); if (!Number.isFinite(ms)) invalid(); return ms; };
const iso = value => { if (!Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000) invalid(); return new Date(value).toISOString(); };

function durationMs(order) {
  const days = order.days || order.durationDays;
  if (!Number.isSafeInteger(days) || days <= 0 || !Number.isSafeInteger(days * DAY_MS)) throw new ApiError('invalid_order', '会员天数无效');
  return days * DAY_MS;
}

function refundDurationMs(order, refundFen) {
  if (!Number.isSafeInteger(order.amountFen) || order.amountFen <= 0 || !nonnegative(refundFen) || refundFen > order.amountFen) throw new ApiError('invalid_refund_amount', '累计退款金额无效');
  // Integer arithmetic avoids rounding a money ratio differently across
  // successive partial refunds. The full-refund endpoint is exactly all time.
  return Number(BigInt(durationMs(order)) * BigInt(refundFen) / BigInt(order.amountFen));
}

function materialize(membership, ledger) {
  const total = ledger.segments.reduce((sum, segment) => sum + segment.remainingMs, 0);
  if (!nonnegative(total)) invalid();
  const settledMs = parseTime(ledger.settledAt);
  const oldExpiry = Date.parse(membership.expiresAt);
  const expiresAt = total > 0 ? iso(settledMs + total)
    : Number.isFinite(oldExpiry) ? iso(Math.min(oldExpiry, settledMs)) : null;
  return { ...membership, expiresAt, entitlements: ledger, updatedAt: ledger.settledAt };
}

/** Settle elapsed time in grant order, never moving the accounting clock back. */
function settle(membership = {}, nowIso) {
  const requestedMs = parseTime(nowIso);
  let ledger;
  if (!membership.entitlements) {
    // Earlier expiry-only records cannot prove which order owns their time.
    // Keep it as an unattributed baseline; refunds must never deduct from it.
    const previousUpdate = Date.parse(membership.updatedAt);
    const at = Math.max(requestedMs, Number.isFinite(previousUpdate) ? previousUpdate : requestedMs);
    const expiry = Date.parse(membership.expiresAt);
    ledger = { version: 1, settledAt: iso(at), segments: Number.isFinite(expiry) && expiry > at ? [{ orderId: null, source: 'legacy', remainingMs: expiry - at }] : [] };
  } else {
    const saved = membership.entitlements;
    if (saved.version !== 1 || !Array.isArray(saved.segments)) invalid();
    const previousMs = parseTime(saved.settledAt);
    const at = Math.max(requestedMs, previousMs);
    let elapsed = at - previousMs;
    const seen = new Set(), segments = [];
    for (const segment of saved.segments) {
      if (!segment || !nonnegative(segment.remainingMs) || (segment.orderId !== null && (typeof segment.orderId !== 'string' || !segment.orderId)) || typeof segment.source !== 'string') invalid();
      if (seen.has(segment.orderId)) invalid();
      seen.add(segment.orderId);
      const consumed = Math.min(elapsed, segment.remainingMs);
      elapsed -= consumed;
      const remainingMs = segment.remainingMs - consumed;
      if (remainingMs) segments.push({ ...segment, remainingMs });
    }
    ledger = { version: 1, settledAt: iso(at), segments };
  }
  return materialize(membership, ledger);
}

function grant(membership, { orderId, source, milliseconds, nowIso }) {
  if (typeof orderId !== 'string' || !orderId || !nonnegative(milliseconds) || milliseconds === 0) invalid();
  const settled = settle(membership, nowIso), ledger = settled.entitlements;
  if (ledger.segments.some(segment => segment.orderId === orderId)) throw new ApiError('membership_entitlement_conflict', '该订单的会员权益已存在，请联系客服核对');
  ledger.segments.push({ orderId, source: source || 'membership_order', remainingMs: milliseconds });
  return { ...materialize(settled, ledger), source: source || 'membership_order' };
}

function revoke(membership, { orderId, milliseconds, nowIso }) {
  if (!nonnegative(milliseconds)) invalid();
  const settled = settle(membership, nowIso), ledger = settled.entitlements;
  const segment = ledger.segments.find(item => item.orderId === orderId);
  const removedMs = segment ? Math.min(segment.remainingMs, milliseconds) : 0;
  if (segment) segment.remainingMs -= removedMs;
  ledger.segments = ledger.segments.filter(item => item.remainingMs > 0);
  const updated = materialize(settled, ledger);
  if (removedMs) updated.source = 'refund';
  return { membership: updated, removedMs, attributed: Boolean(segment) };
}

module.exports = { durationMs, refundDurationMs, settle, grant, revoke };
