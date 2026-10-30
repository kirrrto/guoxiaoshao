'use strict';

const { targetKeyOf } = require('./events');

// These are observations of current availability, not invented restock events.
// Their identity stays fixed for the whole availability episode, while the
// displayed time is the fresh sample which actually justified the reminder.
function currentAvailabilityEvent(latest, config, now) {
  if (!latest || latest.status !== 'available' || latest.unknownSince) return null;
  const observedAt = Date.parse(latest.observedAt);
  const knownAt = Date.parse(latest.knownAt);
  const since = Date.parse(latest.statusSince);
  const streak = Date.parse(latest.knownStreakSince || latest.statusSince);
  const maxAgeMs = Math.min(config.collector.continuityGapMs,
    (config.notifications.maxEventAgeSeconds || 120) * 1000);
  if (![observedAt, knownAt, since, streak].every(Number.isFinite)
    || observedAt > now.getTime() || knownAt > observedAt || since > streak
    || knownAt <= streak || now.getTime() - knownAt > maxAgeMs) return null;
  const targetKey = targetKeyOf(latest.storeNumber, latest.partNumber);
  const availabilityEpisodeSince = latest.availabilityEpisodeSince || latest.statusSince;
  return { _id: `${targetKey}|current_available|${availabilityEpisodeSince}`, targetKey, availabilityEpisodeSince,
    type: 'current_available', status: 'available', stockStatusSince: latest.statusSince,
    detectedAt: latest.knownAt, storeNumber: latest.storeNumber, partNumber: latest.partNumber,
    storeName: latest.storeName || null, productTitle: latest.productTitle || null };
}

module.exports = { currentAvailabilityEvent };
