const fmt = require('./format');
const { storeLabel, storeLabelWithCity } = require('./store-label');

const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const own = (values, key) => values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;

/** Summarize only the selected day's saved records; never infer future stock. */
function historyInsights(response, request = {}, catalog = {}) {
  const day = response.dayKey;
  const coverage = response.observationCoverage || {};
  const requested = request && Array.isArray(request.storeNumbers) ? request.storeNumbers
    : Array.isArray(coverage.requestedStoreNumbers) ? coverage.requestedStoreNumbers : [];
  const scope = [...new Set(requested)];
  const snapshot = Date.parse(response.pagination && response.pagination.snapshotAt);
  const seen = new Set();
  const events = (response.events || []).filter(event => {
    const time = Date.parse(event.detectedAt);
    if (!Number.isFinite(time) || fmt.fmtDate(time) !== day || (Number.isFinite(snapshot) && time > snapshot)
      || (scope.length && !scope.includes(event.storeNumber))) return false;
    if (event.id && seen.has(event.id)) return false;
    if (event.id) seen.add(event.id);
    return true;
  });
  const restocks = events.filter(event => event.type === 'restock_confirmed').sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  const bands = ['00–06 时', '06–12 时', '12–18 时', '18–24 时'].map(label => ({ label, count: 0 }));
  for (const event of restocks) bands[Math.floor(new Date(Date.parse(event.detectedAt) + 8 * 3600000).getUTCHours() / 6)].count++;
  const sampleTimes = [];
  const sampledStores = new Set();
  for (const sample of Array.isArray(coverage.stores) ? coverage.stores : []) {
    const first = Date.parse(sample.firstObservedAt), last = Date.parse(sample.lastObservedAt);
    if ((scope.length && !scope.includes(sample.storeNumber)) || !Number.isFinite(first) || !Number.isFinite(last)
      || first > last || fmt.fmtDate(first) !== day || fmt.fmtDate(last) !== day) continue;
    sampleTimes.push(first, last); sampledStores.add(sample.storeNumber);
  }
  const total = count(response.pagination && response.pagination.total);
  const recordedRestocks = count(response.summary && response.summary.restocks);
  const recent = restocks[0], recentStore = recent && own(catalog.storeByNumber, recent.storeNumber);
  return {
    scopeText: `${day} · ${scope.length ? `${scope.length} 家所选门店` : '各地已有记录，未限定门店'} · 单日记录`,
    recordedText: !events.length && !(total > 0) ? '尚无可汇总的确认补货记录'
      : recordedRestocks === null ? `已加载记录中有 ${restocks.length} 条确认补货` : `该日期已记录确认补货 ${recordedRestocks} 次`,
    pageText: `已加载 ${events.length}${total === null ? '' : ' / ' + total} 条变化事件；下方只汇总已加载的确认补货。`,
    sampleWindowText: sampleTimes.length ? `${sampledStores.size} 家门店留存的采样首末时间：${fmt.fmtTime(Math.min(...sampleTimes))} — ${fmt.fmtTime(Math.max(...sampleTimes))}。首末之间不代表连续观测。`
      : '缺少有效的当日采样时间范围，无法判断全天覆盖。',
    lastRestockText: recent ? `已加载记录中最近确认补货：${fmt.fmtTime(recent.detectedAt)} · ${storeLabel(recent.storeNumber, recentStore && recentStore.name || recent.storeName)}` : '',
    timeBands: restocks.length ? bands : [],
    noRestockText: restocks.length ? '' : '已加载记录中没有确认补货事件；不代表当天没有补货。',
  };
}

/** Presentation guard using the same configured 30-day windows as the server. */
function canOfferLiveChoices(product, account, now) {
  if (!account || !account.membership) return false;
  const membership = account.membership, expiry = Date.parse(membership.expiresAt);
  if (membership.active && (!Number.isFinite(expiry) || now < expiry)) return true;
  if (!Array.isArray(account.newProductWindows)) return false;
  const window = account.newProductWindows.find(item => (Array.isArray(item.partNumbers) && item.partNumbers.includes(product.partNumber))
    || (item.familyKey && !item.partNumbers && item.familyKey === product.familyKey));
  if (!window) return true;
  const release = Date.parse(window.releaseAt);
  return Number.isFinite(release) && (now < release || now >= release + 30 * 86400000);
}

/** Same-SKU store choices from an existing response; this helper performs no I/O. */
function availableStoreChoices(snapshot, catalog = {}, account, now = Date.now()) {
  const partNumber = snapshot && snapshot.product && snapshot.product.partNumber;
  const product = own(catalog.productByPart, partNumber);
  if (!snapshot || snapshot.ok !== true || snapshot.latestRestricted || !product || !product.supported
    || !canOfferLiveChoices(product, account, now)) return [];
  const seen = new Set();
  return (snapshot.results || []).reduce((choices, record) => {
    const store = own(catalog.storeByNumber, record.storeNumber), observed = Date.parse(record.observedAt), age = now - observed;
    const knownAge = record.knownAt ? now - Date.parse(record.knownAt) : age;
    if (!store || !/^R\d{3}$/.test(record.storeNumber) || seen.has(record.storeNumber) || record.status !== 'available'
      || record.isStale || record.unknownSince || record.restricted || !Number.isFinite(age) || age < 0 || age > 120000
      || !Number.isFinite(knownAge) || knownAge < 0 || knownAge > 120000) return choices;
    seen.add(record.storeNumber);
    choices.push({ storeNumber: record.storeNumber, label: storeLabelWithCity(record.storeNumber, store.name, store.city),
      observedText: fmt.fmtDateTime(record.observedAt), ageText: fmt.relative(record.observedAt, now) });
    return choices;
  }, []);
}

module.exports = { historyInsights, availableStoreChoices, canOfferLiveChoices };
