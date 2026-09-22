'use strict';
const { ApiError } = require('../errors');

const count = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new ApiError('invalid_subscription_state', '授权记录状态异常，请稍后重试'); };

/**
 * Legacy credits have no individual identities, and accepted may be missing.
 * Keep them in a separate bucket. Every newly recorded consent gets a ticket
 * from this ledger's own monotonic sequence, independent of the accepted metric.
 */
function readLedger(subscription = {}) {
  const saved = subscription.creditLedger;
  if (!saved) return { version: 1, sequence: 0, legacyCredits: count(subscription.credits) ? subscription.credits : 0, legacyInvalidated: false, invalidatedThrough: 0, available: [] };
  if (saved.version !== 1 || !count(saved.sequence) || !count(saved.legacyCredits) || typeof saved.legacyInvalidated !== 'boolean' || !count(saved.invalidatedThrough) || saved.invalidatedThrough > saved.sequence || !Array.isArray(saved.available) || (saved.legacyInvalidated && saved.legacyCredits)) invalid();
  let previous = saved.invalidatedThrough;
  const available = saved.available.map(range => {
    if (!Array.isArray(range) || range.length !== 2 || !count(range[0]) || !count(range[1]) || range[0] <= previous || range[1] < range[0] || range[1] > saved.sequence) invalid();
    previous = range[1];
    return [...range];
  });
  const ledger = { ...saved, available };
  balance(ledger);
  return ledger;
}

function balance(ledger) {
  const total = ledger.available.reduce((sum, [start, end]) => sum + (end - start + 1), ledger.legacyCredits);
  if (!count(total)) invalid();
  return total;
}

function writeLedger(subscription, ledger, now) {
  return { ...subscription, credits: balance(ledger), creditLedger: ledger, updatedAt: now };
}

/** Merge neighbouring ranges so repeated grants do not grow the stored list. */
function addTicket(ledger, ticket) {
  if (ledger.available.some(([start, end]) => start <= ticket && ticket <= end)) return false;
  const ranges = [...ledger.available, [ticket, ticket]].sort((a, b) => a[0] - b[0]);
  ledger.available = [];
  for (const range of ranges) {
    const last = ledger.available[ledger.available.length - 1];
    if (last && range[0] - last[1] <= 1) last[1] = Math.max(last[1], range[1]);
    else ledger.available.push([...range]);
  }
  return true;
}

function grantCredit(subscription, tickets = 1) {
  const ledger = readLedger(subscription);
  const times = Number.isSafeInteger(tickets) && tickets > 0 ? tickets : 1;
  for (let i = 0; i < times; i += 1) {
    if (ledger.sequence === Number.MAX_SAFE_INTEGER) invalid();
    addTicket(ledger, ++ledger.sequence);
  }
  return ledger;
}

function reserveCredit(subscription) {
  const ledger = readLedger(subscription);
  const highWater = ledger.sequence;
  if (ledger.legacyCredits) {
    ledger.legacyCredits -= 1;
    return { ledger, reserved: true, ticket: 0, highWater };
  }
  if (!ledger.available.length) return { ledger, reserved: false };
  const range = ledger.available[0], ticket = range[0];
  if (range[0] === range[1]) ledger.available.shift();
  else range[0] += 1;
  return { ledger, reserved: true, ticket, highWater };
}

function reservationInvalid(ledger, task) {
  const ticket = task.subscriptionCreditSequence;
  return count(ticket) && ticket > 0 ? ticket <= ledger.invalidatedThrough || ticket > ledger.sequence : ledger.legacyInvalidated;
}

function refundCredit(subscription, task) {
  const ledger = readLedger(subscription);
  if (reservationInvalid(ledger, task)) return { ledger, refunded: false };
  const ticket = task.subscriptionCreditSequence;
  if (count(ticket) && ticket > 0) return { ledger, refunded: addTicket(ledger, ticket) };
  // Reservations made by the old implementation are also legacy credits. Once
  // the legacy bucket is invalidated, no late failure may replenish it.
  if (ledger.legacyCredits === Number.MAX_SAFE_INTEGER) invalid();
  ledger.legacyCredits += 1;
  return { ledger, refunded: true };
}

function invalidateCredits(subscription, task) {
  const ledger = readLedger(subscription);
  const highWater = task.subscriptionCreditHighWater;
  // An old reservation has no ticket high-water mark. It can only invalidate
  // legacy credits; consents recorded by the new ledger must be preserved.
  const through = count(highWater) ? Math.min(highWater, ledger.sequence) : 0;
  ledger.invalidatedThrough = Math.max(ledger.invalidatedThrough, through);
  ledger.legacyCredits = 0;
  ledger.legacyInvalidated = true;
  ledger.available = ledger.available.filter(([, end]) => end > ledger.invalidatedThrough)
    .map(([start, end]) => [Math.max(start, ledger.invalidatedThrough + 1), end]);
  return ledger;
}

module.exports = { readLedger, balance, writeLedger, grantCredit, reserveCredit, reservationInvalid, refundCredit, invalidateCredits };
