'use strict';
/**
 * Event recognition state machine.
 *
 * Input: the previous `latest` record for one store×SKU target (or null) and a
 * new observation from the pickup adapter. Output: the updated record plus the
 * events this observation proves. Pure and deterministic; the caller persists.
 *
 * Principles (docs/MVP.md):
 *  - the status only changes on a *known* observation; `unknown` outcomes are
 *    recorded as coverage gaps, never as "unavailable";
 *  - an available result after an uninterrupted non-available streak is a
 *    confirmed restock; after a coverage gap it is only a recovery, because we
 *    cannot prove what happened in between;
 *  - observations older than the record are stale and ignored (out-of-order
 *    delivery from parallel collectors or manual queries).
 */

const KNOWN = new Set(['available', 'unavailable', 'ineligible', 'pending']);
const DEFAULT_OPTIONS = Object.freeze({ continuityGapMs: 5 * 60 * 1000 });

const targetKeyOf = (storeNumber, partNumber) => `${storeNumber}|${partNumber}`;

function emptyLatest(observation) {
  return {
    _id: targetKeyOf(observation.storeNumber, observation.partNumber),
    storeNumber: observation.storeNumber,
    partNumber: observation.partNumber,
    status: null,
    statusSince: null,
    observedAt: null,
    knownAt: null,
    unknownSince: null,
    unknownCount: 0,
    lastReason: null,
    pickupDisplay: null,
    quote: null,
    productTitle: null,
    storeName: null,
    sampleCount: 0,
    source: null,
  };
}

function makeEvent(latest, observation, type, extra) {
  return {
    _id: `${latest._id}|${type}|${observation.observedAt}`,
    targetKey: latest._id,
    storeNumber: latest.storeNumber,
    partNumber: latest.partNumber,
    type,
    detectedAt: observation.observedAt,
    status: observation.status,
    previousStatus: latest.status,
    previousKnownAt: latest.knownAt,
    quote: observation.quote || null,
    productTitle: observation.productTitle || latest.productTitle || null,
    storeName: observation.storeName || latest.storeName || null,
    source: observation.source || null,
    dayKey: null,
    ...extra,
  };
}

function applyObservation(previous, observation, options) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const latest = previous ? { ...previous } : emptyLatest(observation);
  const observedMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedMs)) throw new TypeError('observation.observedAt must be a valid ISO timestamp');
  const lastMs = latest.observedAt ? Date.parse(latest.observedAt) : -Infinity;
  if (observedMs < lastMs) return { latest: previous, events: [], outcome: 'stale' };
  if (observedMs === lastMs) return { latest: previous, events: [], outcome: 'duplicate' };

  latest.observedAt = observation.observedAt;
  latest.sampleCount = (latest.sampleCount || 0) + 1;
  latest.source = observation.source || latest.source || null;
  if (observation.storeName) latest.storeName = observation.storeName;
  if (observation.productTitle) latest.productTitle = observation.productTitle;

  if (!KNOWN.has(observation.status)) {
    latest.unknownSince = latest.unknownSince || observation.observedAt;
    latest.unknownCount = (latest.unknownCount || 0) + 1;
    latest.lastReason = observation.reason || { code: 'unknown', message: null };
    return { latest, events: [], outcome: 'unknown' };
  }

  const events = [];
  const hadGap = Boolean(latest.unknownSince) || (latest.knownAt && observedMs - Date.parse(latest.knownAt) > opts.continuityGapMs);
  const gapMs = latest.knownAt ? observedMs - Date.parse(latest.knownAt) : null;
  const previousStatus = latest.status;

  if (previousStatus === null) {
    if (observation.status === 'available') events.push(makeEvent(latest, observation, 'first_seen_available', { gapMs: null }));
    latest.statusSince = observation.observedAt;
  } else if (previousStatus !== observation.status) {
    if (observation.status === 'available') {
      events.push(makeEvent(latest, observation, hadGap ? 'recovered_available' : 'restock_confirmed', {
        gapMs,
        unknownCount: latest.unknownCount || 0,
        nonAvailableSince: latest.statusSince,
      }));
    } else if (previousStatus === 'available') {
      events.push(makeEvent(latest, observation, 'became_unavailable', {
        gapMs,
        availableSince: latest.statusSince,
        availableDurationMs: latest.statusSince ? observedMs - Date.parse(latest.statusSince) : null,
        coverageGap: hadGap,
      }));
    } else {
      events.push(makeEvent(latest, observation, 'status_changed', { gapMs, coverageGap: hadGap }));
    }
    latest.statusSince = observation.observedAt;
  }

  latest.status = observation.status;
  latest.knownAt = observation.observedAt;
  latest.pickupDisplay = observation.pickupDisplay || null;
  latest.quote = observation.quote || null;
  latest.unknownSince = null;
  latest.unknownCount = 0;
  latest.lastReason = null;
  return { latest, events, outcome: events.length ? 'changed' : (previousStatus === null ? 'initial' : 'unchanged') };
}

/** Event types that mean "you can go buy it now"; the notifier decides wording per type. */
const NOTIFIABLE_TYPES = new Set(['first_seen_available', 'restock_confirmed', 'recovered_available']);
// Events the notifier plans: restocks, plus sell-outs (sent only with a sold-out template).
const ALERT_TYPES = new Set([...NOTIFIABLE_TYPES, 'became_unavailable']);

module.exports = { KNOWN_STATUSES: KNOWN, DEFAULT_OPTIONS, NOTIFIABLE_TYPES, ALERT_TYPES, targetKeyOf, applyObservation };
