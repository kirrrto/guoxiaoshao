'use strict';
const { dayKey } = require('../time');
const { KNOWN_STATUSES } = require('./events');

const observationDayId = (storeNumber, partNumber, date) => `${storeNumber}|${partNumber}|${date}`;
const AVAILABLE_TYPES = new Set(['first_seen_available', 'restock_confirmed', 'recovered_available']);

/** Counts accepted samples, not HTTP requests or continuous time coverage.
 * Called only inside the latest/event transaction, after stale/duplicate rejection.
 * Never derives previous samples from latest.sampleCount or collector health.
 */
function appendObservationDay(previous, observation, events = []) {
  const observedAt = new Date(observation.observedAt).toISOString();
  const date = dayKey(observedAt);
  const known = KNOWN_STATUSES.has(observation.status);
  const count = name => Number.isSafeInteger(previous && previous[name]) && previous[name] >= 0 ? previous[name] : 0;
  // Raw events are purged after 10 days; these per-day counters are kept long
  // term to show when stock became steady and which stores received it first.
  const eventCounts = { ...(previous && previous.eventCounts || {}) };
  let firstAvailableAt = previous && previous.firstAvailableAt || null;
  const windows = { count: 0, totalMs: 0, maxMs: 0, minMs: null, ...(previous && previous.availableWindows || {}) };
  for (const event of events) {
    eventCounts[event.type] = (Number.isSafeInteger(eventCounts[event.type]) ? eventCounts[event.type] : 0) + 1;
    if (AVAILABLE_TYPES.has(event.type) && !firstAvailableAt) firstAvailableAt = event.detectedAt;
    const duration = event.availableDurationMs;
    if (event.type === 'became_unavailable' && Number.isSafeInteger(duration) && duration >= 0) {
      windows.count += 1; windows.totalMs += duration; windows.maxMs = Math.max(windows.maxMs, duration);
      windows.minMs = windows.minMs === null ? duration : Math.min(windows.minMs, duration);
    }
  }
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
    eventCounts,
    firstAvailableAt,
    availableWindows: windows,
  };
}

module.exports = { observationDayId, appendObservationDay };
