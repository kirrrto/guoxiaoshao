'use strict';
const { dayKey } = require('../time');
const { KNOWN_STATUSES } = require('./events');

const observationDayId = (storeNumber, partNumber, date) => `${storeNumber}|${partNumber}|${date}`;

/** Counts accepted samples, not HTTP requests or continuous time coverage.
 * Called only inside the latest/event transaction, after stale/duplicate rejection.
 * Never derives previous samples from latest.sampleCount or collector health.
 */
function appendObservationDay(previous, observation) {
  const observedAt = new Date(observation.observedAt).toISOString();
  const date = dayKey(observedAt);
  const known = KNOWN_STATUSES.has(observation.status);
  const count = name => Number.isSafeInteger(previous && previous[name]) && previous[name] >= 0 ? previous[name] : 0;
  return {
    _id: observationDayId(observation.storeNumber, observation.partNumber, date),
    schemaVersion: 1,
    storeNumber: observation.storeNumber,
    partNumber: observation.partNumber,
    dayKey: date,
    sampleCount: count('sampleCount') + 1,
    knownCount: count('knownCount') + (known ? 1 : 0),
    unknownCount: count('unknownCount') + (known ? 0 : 1),
    manualCount: count('manualCount') + (observation.source === 'manual' ? 1 : 0),
    autoCount: count('autoCount') + (observation.source === 'auto' ? 1 : 0),
    firstObservedAt: previous && previous.firstObservedAt || observedAt,
    lastObservedAt: observedAt,
    firstKnownAt: previous && previous.firstKnownAt || (known ? observedAt : null),
    lastKnownAt: known ? observedAt : previous && previous.lastKnownAt || null,
  };
}

module.exports = { observationDayId, appendObservationDay };
