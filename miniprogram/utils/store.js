/**
 * Tiny session store: bootstrap (identity/quota/membership) and the catalog.
 * Catalog is cached in local storage and refreshed by version.
 */
const { call } = require('./api');
const PRODUCT_IMAGES = require('../config/product-images');
const CATALOG_SEED = require('../config/catalog-seed');
const { sortFamilies } = require('./catalog-order');

const CATALOG_KEY = 'gxs_catalog_v1';
const CATEGORY_ORDER = ['iphone', 'ipad', 'mac', 'watch', 'airpods', 'vision', 'homepod'];
const CATEGORY_NAME = { iphone: 'iPhone', ipad: 'iPad', mac: 'Mac', watch: 'Watch', airpods: 'AirPods', vision: 'Vision Pro', homepod: 'HomePod' };

let bootstrapPromise = null;
let bootstrapGeneration = 0;
let bootstrapFetchedAt = 0;
let latestQuota = null;
let catalogPromise = null;
let catalogGeneration = 0;
let catalogCheckedAt = 0;
const catalogListeners = new Set();
const quotaListeners = new Set();
const subscriptionListeners = new Set();
const BOOTSTRAP_TTL_MS = 30000;
const CATALOG_TTL_MS = 5 * 60000;
let followSnapshot = null;
let followPromise = null;
let followFetchedAt = 0;
let followGeneration = 0;

function invalidateFollows() { followGeneration += 1; followSnapshot = null; followPromise = null; }
function resetSession() {
  invalidateBootstrap(); invalidateFollows();
  latestQuota = null;
  bootstrapFetchedAt = 0; catalogCheckedAt = 0; catalogPromise = null; catalogGeneration += 1;
  const app = getApp(); app.globalData.catalog = null; app.globalData.lastQuery = null; app.globalData.pendingFollow = null;
}
async function getFollows({ force = false } = {}) {
  if (!force && followSnapshot && Date.now() - followFetchedAt < 15000) return followSnapshot;
  if (followPromise) return followPromise;
  const generation = followGeneration;
  const pending = call('follow.list').then(value => { if (generation === followGeneration) { followSnapshot = value; followFetchedAt = Date.now(); } return value; });
  followPromise = pending;
  try { return await pending; } finally { if (followPromise === pending) followPromise = null; }
}

async function refreshBootstrap() {
  if (bootstrapPromise) return bootstrapPromise;
  const app = getApp();
  const generation = bootstrapGeneration;
  const pending = call('user.bootstrap').then(data => {
    if (generation !== bootstrapGeneration) return getBootstrap();
    if (data.quota) {
      if (isOlderQuota(data.quota)) data = { ...data, quota: latestQuota };
      else latestQuota = data.quota;
    }
    app.globalData.bootstrap = data; bootstrapFetchedAt = Date.now();
    return data;
  });
  bootstrapPromise = pending;
  try { return await pending; }
  finally { if (bootstrapPromise === pending) bootstrapPromise = null; }
}

function invalidateBootstrap() {
  bootstrapGeneration += 1;
  bootstrapPromise = null;
  getApp().globalData.bootstrap = null;
}

function isOlderQuota(quota) {
  if (!latestQuota) return false;
  const revision = Number.isInteger(quota.revision) ? quota.revision : 0;
  const latestRevision = Number.isInteger(latestQuota.revision) ? latestQuota.revision : 0;
  return revision < latestRevision || (revision === latestRevision && quota.dayKey && latestQuota.dayKey && quota.dayKey < latestQuota.dayKey);
}

function publishQuota(quota) {
  if (isOlderQuota(quota)) return false;
  latestQuota = quota;
  // Cancel older account reads so returning to Mine cannot repaint a pre-reward
  // balance. Broadcast even when no complete bootstrap is currently cached.
  bootstrapGeneration += 1;
  bootstrapPromise = null;
  const app = getApp();
  if (app.globalData.bootstrap) app.globalData.bootstrap = { ...app.globalData.bootstrap, quota };
  for (const listener of quotaListeners) { try { listener(quota); } catch (e) { console.error('[gxs] quota listener', e); } }
  return true;
}

/** Apply confirmed reminder credits to the cached account and open pages without a refetch. */
function publishSubscriptions(subscriptions) {
  if (!subscriptions || typeof subscriptions !== 'object') return;
  const app = getApp();
  if (app.globalData.bootstrap) app.globalData.bootstrap = { ...app.globalData.bootstrap, subscriptions };
  for (const listener of subscriptionListeners) { try { listener(subscriptions); } catch (e) { console.error('[gxs] subscription listener', e); } }
}

function subscribeSubscriptions(listener) {
  subscriptionListeners.add(listener);
  return () => subscriptionListeners.delete(listener);
}

function getQuotaGeneration() { return bootstrapGeneration; }

function subscribeQuota(listener) {
  quotaListeners.add(listener);
  return () => quotaListeners.delete(listener);
}

async function getBootstrap({ force = false } = {}) {
  const app = getApp();
  const cached = app.globalData.bootstrap;
  const now = Date.now();
  const beijingDay = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const expiry = cached && cached.membership && Date.parse(cached.membership.expiresAt);
  const expired = cached && cached.membership && cached.membership.active && Number.isFinite(expiry) && now >= expiry;
  const changedDay = cached && cached.quota && cached.quota.dayKey && cached.quota.dayKey !== beijingDay;
  if (!force && cached && now - bootstrapFetchedAt < BOOTSTRAP_TTL_MS && !expired && !changedDay) return cached;
  if (!force && bootstrapPromise) return bootstrapPromise;
  return refreshBootstrap();
}

function indexCatalog(raw) {
  const stores = raw.stores || [];
  const familyNames = Object.fromEntries((raw.families || []).map(f => [f.familyKey, f.displayName || f.name || f.familyKey]));
  const familyMetadata = Object.fromEntries((raw.families || []).map((f, catalogOrder) => [f.familyKey, { ...f, catalogOrder }]));
  const products = (raw.products || []).map(source => {
    // Only send fields used by the UI through setData. Indexed lookup maps
    // repeat each product, so provenance/unused upstream metadata can exceed
    // WeChat's one-update payload limit when images are added.
    const product = {};
    for (const key of ['partNumber', 'category', 'familyKey', 'familyName', 'model', 'title', 'attributes', 'priceCny', 'comingSoon', 'supported', 'verificationStatus', 'imageUrl', 'imageAlt']) {
      if (source[key] !== undefined) product[key] = source[key];
    }
    const fallback = PRODUCT_IMAGES[product.partNumber];
    return fallback && !product.imageUrl ? { ...product, ...fallback } : product;
  });
  const cities = [];
  const cityMap = new Map();
  for (const store of stores) {
    const key = store.city || '未知';
    if (!cityMap.has(key)) {
      cityMap.set(key, { city: key, province: store.province || '', stores: [] });
      cities.push(cityMap.get(key));
    }
    cityMap.get(key).stores.push(store);
  }
  const storeByNumber = {};
  for (const store of stores) storeByNumber[store.storeNumber] = store;

  const categories = [];
  const categoryMap = new Map();
  for (const product of products) {
    if (!categoryMap.has(product.category)) {
      categoryMap.set(product.category, { key: product.category, name: CATEGORY_NAME[product.category] || product.category, families: [], familyMap: new Map() });
      categories.push(categoryMap.get(product.category));
    }
    const category = categoryMap.get(product.category);
    if (!category.familyMap.has(product.familyKey)) {
      const family = { ...(familyMetadata[product.familyKey] || {}), familyKey: product.familyKey, name: product.familyName || familyNames[product.familyKey] || product.familyKey, products: [], supported: false };
      category.familyMap.set(product.familyKey, family);
      category.families.push(family);
    }
    const family = category.familyMap.get(product.familyKey);
    family.products.push(product);
    if (product.supported) family.supported = true;
  }
  categories.sort((a, b) => CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key));
  for (const category of categories) { category.families = sortFamilies(category.families); delete category.familyMap; }
  const productByPart = {};
  for (const product of products) productByPart[product.partNumber] = product;
  return { version: raw.version, families: raw.families || [], excludedFamilies: raw.excludedFamilies || [], stores, cities, storeByNumber, categories, products, productByPart };
}

function validCatalog(raw) { return raw && Array.isArray(raw.products) && Array.isArray(raw.stores); }

// The indexed catalog lives only in JavaScript memory. Pages bind its version
// and target-picker reads it here, so products never cross the render bridge.
function currentCatalog() {
  const app = getApp();
  if (!app.globalData.catalog) app.globalData.catalog = indexCatalog(cachedCatalog() || CATALOG_SEED);
  return app.globalData.catalog;
}

function subscribeCatalog(listener) {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

function cachedCatalog() {
  try { const value = wx.getStorageSync(CATALOG_KEY); return validCatalog(value) ? value : null; }
  catch (e) { return null; }
}

async function refreshCatalog({ force = false } = {}) {
  if (catalogPromise) return catalogPromise;
  const generation = catalogGeneration;
  const app = getApp();
  const current = app.globalData.catalog;
  const raw = cachedCatalog() || CATALOG_SEED;
  const version = current ? current.version : raw.version;
  const pending = call('catalog.get', version ? { ifVersion: version } : {}).then(response => {
    // An earlier request may finish after this session has been invalidated.
    // Its result must not publish, persist or reset the new session's timers.
    if (generation !== catalogGeneration) return app.globalData.catalog || indexCatalog(cachedCatalog() || CATALOG_SEED);
    catalogCheckedAt = Date.now();
    if (response.unchanged) return app.globalData.catalog || indexCatalog(raw);
    if (!validCatalog(response)) throw new Error('商品目录暂时不可用，请稍后刷新');
    const indexed = indexCatalog(response);
    app.globalData.catalog = indexed;
    if (typeof wx.setStorage === 'function') wx.setStorage({ key: CATALOG_KEY, data: response, fail() {} });
    else { try { wx.setStorageSync(CATALOG_KEY, response); } catch (e) { /* in-memory catalog remains usable */ } }
    if (!current || current.version !== indexed.version) {
      for (const listener of catalogListeners) { try { listener(indexed); } catch (e) { console.error('[gxs] catalog listener', e); } }
    }
    return indexed;
  });
  catalogPromise = pending;
  try { return await pending; }
  catch (error) { if (generation === catalogGeneration) catalogCheckedAt = Date.now() - CATALOG_TTL_MS + 30000; throw error; }
  finally { if (catalogPromise === pending) catalogPromise = null; }
}

async function getCatalog({ force = false } = {}) {
  const app = getApp();
  const catalog = currentCatalog();
  if (force) return refreshCatalog({ force: true });
  const expected = app.globalData.bootstrap && app.globalData.bootstrap.catalogVersion;
  if ((expected && expected !== catalog.version) || Date.now() - catalogCheckedAt >= CATALOG_TTL_MS) {
    // Browse immediately; the server still validates supported SKU and limits.
    refreshCatalog().catch(() => {});
  }
  return catalog;
}

module.exports = { getBootstrap, refreshBootstrap, invalidateBootstrap, publishQuota, subscribeQuota, publishSubscriptions, subscribeSubscriptions, getQuotaGeneration, getCatalog, refreshCatalog, currentCatalog, subscribeCatalog, getFollows, invalidateFollows, resetSession, CATEGORY_NAME };
