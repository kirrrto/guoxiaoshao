const { sameVariant, storeChoices, freshAvailable, WINDOW_MS } = require('./alternative-rules');
const { canOfferLiveChoices } = require('./observation-insights');
const { storeLabelWithCity } = require('./store-label');
const fmt = require('./format');
const { selectionLimits } = require('./member-limits');
const own = (map, key) => map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
function options(snapshot, catalog = {}, account, now = Date.now()) {
  const base = snapshot && snapshot.product && own(catalog.productByPart, snapshot.product.partNumber);
  const finished = Date.parse(snapshot && snapshot.finishedAt), expires = Date.parse(snapshot && snapshot.alternativesExpiresAt);
  if (!snapshot || snapshot.ok !== true || !base || base.supported !== true) return { colors: [], stores: [], canRead: false, expiresText: '' };
  // Catalog choices remain useful after the optional observation window ends.
  // Only an explicit paid/member query can fetch current stock for them.
  const canRead = /^[A-Za-z0-9_-]{8,64}$/.test(snapshot.queryId || '')
    && (snapshot.member === true || Number.isSafeInteger(snapshot.charged) && snapshot.charged > (snapshot.refunded || 0))
    && Number.isFinite(finished) && finished <= now && Number.isFinite(expires) && expires <= finished + WINDOW_MS && expires > now
    && canOfferLiveChoices(base, account, now);
  const colors = Object.values(catalog.productByPart || {}).filter(product => sameVariant(base, product))
    .sort((a, b) => (b.partNumber === base.partNumber) - (a.partNumber === base.partNumber) || a.partNumber.localeCompare(b.partNumber))
    .map(product => ({ partNumber: product.partNumber, label: product.attributes && product.attributes.color || '本次配置', current: product.partNumber === base.partNumber }));
  const original = [...new Set((snapshot.results || []).map(row => row.storeNumber))];
  const stores = storeChoices(Object.values(catalog.storeByNumber || {}), original, selectionLimits(account).stores).map(choice => {
    const store = own(catalog.storeByNumber, choice.storeNumber), anchor = own(catalog.storeByNumber, choice.anchorStoreNumber);
    return { ...choice, label: storeLabelWithCity(store.storeNumber, store.name, store.city),
      relationText: choice.relation === 'original' ? '本次查询门店' : choice.relation === 'nearby'
        ? `距${anchor.name}约 ${choice.distanceKm.toFixed(1)} 公里（直线）` : '同城门店' };
  });
  return { colors, stores, canRead, expiresText: Number.isFinite(expires) ? fmt.fmtTime(expires) : '' };
}
function matches(response, snapshot, catalog, account, now = Date.now()) {
  const available = options(snapshot, catalog, account, now);
  const limits = selectionLimits(account);
  if (!available.canRead || !response || !snapshot || !snapshot.product || response.queryId !== snapshot.queryId || response.basePartNumber !== snapshot.product.partNumber
    || !Array.isArray(response.partNumbers) || !Array.isArray(response.storeNumbers) || response.partNumbers.length > limits.colors || response.storeNumbers.length > limits.stores
    || Date.parse(response.expiresAt) !== Date.parse(snapshot.alternativesExpiresAt) || !Number.isFinite(Date.parse(response.readAt)) || Date.parse(response.readAt) > now) return [];
  return (response.results || []).filter(row => available.colors.some(item => item.partNumber === row.partNumber)
    && available.stores.some(item => item.storeNumber === row.storeNumber) && response.partNumbers.includes(row.partNumber) && response.storeNumbers.includes(row.storeNumber) && freshAvailable(row, now)
    && canOfferLiveChoices(own(catalog.productByPart, row.partNumber), account, now)
    && Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) > now).map(row => ({ ...row,
    key: `${row.storeNumber}|${row.partNumber}`, productTitle: own(catalog.productByPart, row.partNumber).title,
    storeLabel: storeLabelWithCity(row.storeNumber, own(catalog.storeByNumber, row.storeNumber).name, own(catalog.storeByNumber, row.storeNumber).city),
    observedText: fmt.fmtDateTime(row.observedAt), ageText: fmt.relative(row.observedAt, now) }));
}
module.exports = { options, matches };
