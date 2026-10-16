// A recoverable selection, never an order, entitlement or inventory snapshot.
// The target signature is a deterministic comparison key, not a security token.
const STORAGE_PREFIX = 'gxs_checkout_context_v1:';
const TTL_MS = 24 * 60 * 60 * 1000;
let lastRevision = 0;
const ENTRY_POINTS = ['query', 'result', 'query_result', 'query_selection', 'follow', 'mine'];
const { storeLabelWithCity } = require('./store-label');
const accountKey = identity => identity && typeof identity.userKey === 'string' && identity.userKey.length <= 256 ? identity.userKey : '';
const storesOf = value => Array.isArray(value) && value.length >= 1 && value.length <= 4
  && value.every(item => typeof item === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(item)) && new Set(value).size === value.length ? value.slice().sort() : null;
function targetSignature(target) {
  const stores = storesOf(target && target.storeNumbers);
  return stores && target && typeof target.partNumber === 'string' && /^[A-Za-z0-9_/-]{1,64}$/.test(target.partNumber)
    ? `${target.partNumber}|${stores.join(',')}` : '';
}
const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null;
function presentTarget(target, catalog) {
  const product = catalog && (own(catalog.productByPart, target.partNumber)
    || (catalog.products || []).find(item => item.partNumber === target.partNumber));
  const stores = target.storeNumbers.map(number => catalog && (own(catalog.storeByNumber, number)
    || (catalog.stores || []).find(item => item.storeNumber === number)));
  if (!product || product.supported !== true || product.comingSoon || stores.some(item => !item || item.enabled === false)) return null;
  return { ...target, title: product.title || product.model || product.partNumber, imageUrl: product.imageUrl || '',
    storeNames: stores.map(item => storeLabelWithCity(item.storeNumber, item.name, item.city)),
    storeText: stores.map(item => storeLabelWithCity(item.storeNumber, item.name, item.city)).join('、') };
}
function createCheckoutContext({ wx: wxApi, now = Date.now }) {
  const key = identity => STORAGE_PREFIX + encodeURIComponent(accountKey(identity));
  return {
    save(identity, target, catalog, { entryPoint = 'query' } = {}) {
      if (!accountKey(identity)) return { ok: false, reason: 'account_required' };
      const signature = targetSignature(target);
      if (!signature || !catalog || typeof catalog.version !== 'string' || !catalog.version || !presentTarget(target, catalog)) return { ok: false, reason: 'invalid_target' };
      try {
        const previous = wxApi.getStorageSync(key(identity));
        const createdAt = now();
        const previousRevision = previous && Number.isSafeInteger(previous.revision) && previous.revision > 0 && previous.revision < Number.MAX_SAFE_INTEGER ? previous.revision : 0;
        const revision = Math.max(createdAt, previousRevision + 1, lastRevision + 1);
        lastRevision = revision;
        const context = { schemaVersion: 1, revision, targetSignature: signature, partNumber: target.partNumber,
          storeNumbers: storesOf(target.storeNumbers), catalogVersion: catalog.version, createdAt, expiresAt: createdAt + TTL_MS,
          entryPoint: ENTRY_POINTS.includes(entryPoint) ? entryPoint : 'query' };
        wxApi.setStorageSync(key(identity), context);
        const saved = wxApi.getStorageSync(key(identity));
        if (!saved || JSON.stringify(saved) !== JSON.stringify(context)) return { ok: false, reason: 'storage_failed' };
        return { ok: true, context: presentTarget(context, catalog) };
      } catch (_) { return { ok: false, reason: 'storage_failed' }; }
    },
    read(identity) {
      if (!accountKey(identity)) return Promise.resolve(null);
      const storageKey = key(identity);
      if (typeof wxApi.getStorage === 'function') {
        return new Promise(resolve => {
          try {
            wxApi.getStorage({ key: storageKey, success: result => resolve(result && result.data), fail: () => resolve(null) });
          } catch (_) { resolve(undefined); }
        });
      }
      try { return Promise.resolve(wxApi.getStorageSync(storageKey) ?? null); }
      catch (_) { return Promise.resolve(undefined); }
    },
    restore(identity, catalog, stored) {
      if (!accountKey(identity)) return { status: 'empty' };
      let value;
      if (arguments.length >= 3) value = stored;
      else {
        try { value = wxApi.getStorageSync(key(identity)); } catch (_) { return { status: 'storage_failed' }; }
      }
      if (!value) return { status: 'empty' };
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
        || !targetSignature(value) || value.targetSignature !== targetSignature(value) || !ENTRY_POINTS.includes(value.entryPoint)
        || typeof value.catalogVersion !== 'string' || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt)
        || value.expiresAt - value.createdAt !== TTL_MS || value.createdAt > now()) return { status: 'invalid' };
      if (now() >= value.expiresAt) return { status: 'expired' };
      if (!catalog || value.catalogVersion !== catalog.version) return { status: 'catalog_changed' };
      // Copy only the allowed business fields; storage must never supply UI text.
      const context = presentTarget({ schemaVersion: 1, revision: value.revision, targetSignature: value.targetSignature,
        partNumber: value.partNumber, storeNumbers: storesOf(value.storeNumbers), catalogVersion: value.catalogVersion,
        createdAt: value.createdAt, expiresAt: value.expiresAt, entryPoint: value.entryPoint }, catalog);
      return context ? { status: 'ready', context } : { status: 'catalog_changed' };
    },
    clear(identity, expectedRevision) {
      if (!accountKey(identity)) return false;
      try {
        const value = wxApi.getStorageSync(key(identity));
        if (expectedRevision !== undefined && (!value || value.revision !== expectedRevision)) return false;
        wxApi.removeStorageSync(key(identity));
        return true;
      } catch (_) { return false; }
    },
  };
}
module.exports = { createCheckoutContext, targetSignature, TTL_MS, STORAGE_PREFIX };
