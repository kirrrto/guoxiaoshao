// The directory arrives once per refresh. Repeated model names, specifications
// and eligibility dates share a string table across regions.
const PRODUCT_FIELDS = [
  'partNumber', 'id', 'category', 'familyKey', 'familyName', 'model', 'modelEn',
  'title', 'titleEn', 'color', 'colorEn', 'capacity', 'configuration', 'configurationEn',
  'artworkPart', 'releaseAt', 'freeQueryStartsAt', 'supported', 'querySupported', 'monitorSupported', 'reason',
];

function unpackProducts(rows, values) {
  if (!Array.isArray(rows) || !Array.isArray(values) || values[0] !== null) throw Error('Invalid regional catalog');
  return rows.map(row => {
    if (!Array.isArray(row) || row.length > PRODUCT_FIELDS.length) throw Error('Invalid regional configuration');
    const product = {};
    for (let i = 0; i < row.length; i++) {
      const index = row[i];
      if (!Number.isInteger(index) || index < 0 || index >= values.length) throw Error('Invalid regional catalog value');
      if (index) product[PRODUCT_FIELDS[i]] = values[index];
    }
    product.partNumber = product.partNumber || null;
    product.id = product.id || product.partNumber;
    if (!product.id || !product.model || !product.title) throw Error('Incomplete regional configuration');
    return product;
  });
}
function decodeMarketCatalog(response) {
  if (response?.format !== 'compact-v1') return response;
  const markets = response.markets.map(({ productRows, ...market }) => ({
    ...market, products: unpackProducts(productRows, response.values),
  }));
  return { markets };
}
const FIXED_ZONE_OFFSETS = { 'Asia/Tokyo': 9, 'Asia/Taipei': 8, 'Asia/Hong_Kong': 8, 'Pacific/Honolulu': -10, 'America/Phoenix': -7 };
const US_DST_ZONE_OFFSETS = { 'America/Anchorage': -9, 'America/Los_Angeles': -8, 'America/Denver': -7, 'America/Chicago': -6, 'America/New_York': -5 };
const hasKey = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Shared with the cloud directory. The mini program runtime need not support Intl time zones.
function zoneOffsetHours(stamp, timeZone) {
  if (hasKey(FIXED_ZONE_OFFSETS, timeZone)) return FIXED_ZONE_OFFSETS[timeZone];
  if (!hasKey(US_DST_ZONE_OFFSETS, timeZone)) return 0;
  const std = US_DST_ZONE_OFFSETS[timeZone];
  const year = new Date(stamp + std * 3600000).getUTCFullYear();
  const marStart = Date.UTC(year, 2, 8 + ((7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7), 2 - std);
  const novEnd = Date.UTC(year, 10, 1 + ((7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7), 2 - (std + 1));
  return stamp >= marStart && stamp < novEnd ? std + 1 : std;
}

// The directory encodes a calendar date as midnight in the site's default zone.
// Resolve that same date in the selected store's zone, including on DST change days.
function storeFreeQueryStartsAt(iso, siteZone, storeZone) {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp) || !siteZone || !storeZone || siteZone === storeZone) return iso;
  const date = new Date(stamp + zoneOffsetHours(stamp, siteZone) * 3600000).toISOString().slice(0, 10);
  return new Date(localMidnightMs(date, storeZone)).toISOString();
}

function localMidnightMs(date, zone) {
  const utcDate = Date.parse(date + 'T00:00:00Z');
  const estimate = utcDate - zoneOffsetHours(utcDate, zone) * 3600000;
  return utcDate - zoneOffsetHours(estimate, zone) * 3600000;
}

module.exports = { PRODUCT_FIELDS, unpackProducts, decodeMarketCatalog, zoneOffsetHours, localMidnightMs, storeFreeQueryStartsAt };
