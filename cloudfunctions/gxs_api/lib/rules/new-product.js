'use strict';
const { toDate, addDays, dayKey } = require('../time');

const RESTRICTION_DAYS = 30;

/**
 * Release windows are configured by the operator per family or per SKU:
 *   { familyKey?: string, partNumbers?: string[], releaseAt: ISO string }
 * A product is "new" for RESTRICTION_DAYS from its release instant.
 */
function findWindow(product, windows) {
  if (!product || !Array.isArray(windows)) return null;
  return windows.find(window => (Array.isArray(window.partNumbers) && window.partNumbers.includes(product.partNumber))
    || (window.familyKey && !window.partNumbers && window.familyKey === product.familyKey)) || null;
}

function restrictionEndsAt(window) {
  return addDays(toDate(window.releaseAt), RESTRICTION_DAYS);
}

/** Free users cannot query the live status of a new product during its window. */
function isLiveRestricted(product, windows, now) {
  const window = findWindow(product, windows);
  if (!window) return { restricted: false, window: null, endsAt: null };
  const release = toDate(window.releaseAt).getTime();
  const end = restrictionEndsAt(window).getTime();
  const time = toDate(now).getTime();
  const restricted = time >= release && time < end;
  return { restricted, window, endsAt: new Date(end).toISOString(), releaseAt: new Date(release).toISOString(), notYetReleased: time < release };
}

/**
 * Free users may read a new product's history for yesterday and earlier, but
 * not today's detail (and therefore not today's live statistics).
 */
function isHistoryRestricted(product, windows, requestedDayKey, now) {
  const live = isLiveRestricted(product, windows, now);
  if (!live.restricted) return { ...live, restricted: false };
  const today = dayKey(now);
  return { ...live, restricted: requestedDayKey >= today };
}

module.exports = { RESTRICTION_DAYS, findWindow, isLiveRestricted, isHistoryRestricted };
