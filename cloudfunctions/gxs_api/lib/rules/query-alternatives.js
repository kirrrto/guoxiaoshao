'use strict';
// Keep the pure catalog guards in sync with miniprogram/utils/alternative-rules.js.
// Neither copy infers variants or coordinates from a title/address.
const WINDOW_MS = 120000;
const MAX_CHOICES = 3;
// Avoid relying on Array.prototype.flatMap on older mini-program JS engines.
const flatMap = (items, map) => items.reduce((out, item) => out.concat(map(item)), []);
const text = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
function sameVariant(base, candidate) {
  if (!base || !candidate || candidate.supported !== true || candidate.comingSoon) return false;
  if (base.partNumber === candidate.partNumber) return true;
  if (!text(base.model) || !text(base.familyKey) || !text(base.category)
    || ['model', 'familyKey', 'category'].some(key => text(base[key]) !== text(candidate[key]))) return false;
  const a = base.attributes || {}, b = candidate.attributes || {};
  if (!text(a.capacity) || !text(a.color) || !text(b.color) || text(a.color) === text(b.color)) return false;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => key !== 'color' && !key.endsWith('Detail'));
  return keys.every(key => text(a[key]) && text(a[key]) === text(b[key]));
}
function coordinates(store) {
  return store && typeof store.latitude === 'number' && typeof store.longitude === 'number'
    && Number.isFinite(store.latitude) && Math.abs(store.latitude) <= 90
    && Number.isFinite(store.longitude) && Math.abs(store.longitude) <= 180
    ? [store.latitude, store.longitude] : null;
}
function distanceKm(a, b) {
  const rad = Math.PI / 180, lat = (b[0] - a[0]) * rad, lng = (b[1] - a[1]) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(lng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function storeChoices(stores, originalNumbers, maxChoices = MAX_CHOICES) {
  const valid = stores.filter(store => store && /^R\d{3}$/.test(store.storeNumber));
  const anchors = originalNumbers.map(number => valid.find(store => store.storeNumber === number)).filter(Boolean);
  const original = anchors.map(store => ({ storeNumber: store.storeNumber, relation: 'original', anchorStoreNumber: store.storeNumber, distanceKm: null }));
  const others = flatMap(valid.filter(store => !originalNumbers.includes(store.storeNumber)), store => {
    const relationships = flatMap(anchors, anchor => {
      const a = coordinates(anchor), b = coordinates(store);
      if (a && b) {
        const distance = distanceKm(a, b);
        return distance <= 50 ? [{ relation: 'nearby', anchorStoreNumber: anchor.storeNumber, distanceKm: distance }] : [];
      }
      return text(anchor.city) && text(anchor.city) === text(store.city) && text(anchor.province) === text(store.province)
        ? [{ relation: 'same_city', anchorStoreNumber: anchor.storeNumber, distanceKm: null }] : [];
    }).sort((a, b) => (a.distanceKm === null) - (b.distanceKm === null) || (a.distanceKm || 0) - (b.distanceKm || 0));
    return relationships.length ? [{ storeNumber: store.storeNumber, ...relationships[0] }] : [];
  }).sort((a, b) => (a.distanceKm === null) - (b.distanceKm === null) || (a.distanceKm || 0) - (b.distanceKm || 0) || a.storeNumber.localeCompare(b.storeNumber));
  return [...original, ...others.slice(0, maxChoices)];
}
function freshAvailable(row, now) {
  const observed = Date.parse(row && row.observedAt), known = row && row.knownAt ? Date.parse(row.knownAt) : observed;
  return Boolean(row && row.status === 'available' && !row.unknownSince && !row.isStale && !row.restricted
    && Number.isFinite(observed) && observed <= now && now - observed < WINDOW_MS
    && Number.isFinite(known) && known <= observed && now - known < WINDOW_MS);
}
module.exports = { WINDOW_MS, MAX_CHOICES, sameVariant, coordinates, storeChoices, freshAvailable };
