'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ApiError } = require('../errors');
const { coordinates } = require('../rules/query-alternatives');

const BUNDLED_DIR = path.resolve(__dirname, '..', '..', 'catalog');

function readBundled(name) {
  const file = path.join(BUNDLED_DIR, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Shape stored per SKU; the client gets the same fields. */
function toProductDoc(product, family) {
  return {
    _id: product.partNumber,
    partNumber: product.partNumber,
    category: product.category,
    familyKey: product.familyKey,
    familyName: family ? family.displayName : product.familyKey,
    model: product.model,
    title: product.upstreamTitle || product.title,
    catalogTitle: product.title,
    upstreamTitle: product.upstreamTitle || null,
    attributes: Object.fromEntries(Object.entries(product.attributes || {}).filter(([key]) => !key.endsWith('Detail'))),
    priceCny: product.priceCny,
    comingSoon: Boolean(product.comingSoon),
    supported: Boolean(family && family.supported && family.pickupVerification && family.pickupVerification.verified) && !product.comingSoon,
    verificationStatus: family && family.pickupVerification ? family.pickupVerification.status : null,
    sourceUrl: product.sourceUrl,
    imageUrl: product.imageUrl || null,
    imageAlt: product.imageAlt || null,
    imageWidth: product.imageWidth || null,
    imageHeight: product.imageHeight || null,
    imageSource: product.imageSource || null,
    imageSourceUrl: product.imageSourceUrl || null,
  };
}

function toStoreDoc(store) {
  return {
    _id: store.storeNumber,
    storeNumber: store.storeNumber,
    name: store.name,
    city: store.city,
    province: store.province,
    address: store.address,
    phone: store.phone,
    slug: store.slug,
    ...(coordinates(store) ? { latitude: store.latitude, longitude: store.longitude } : {}),
  };
}

/** Build catalog documents from the bundled JSON produced by tools/catalog. */
function buildFromBundled() {
  const stores = readBundled('stores.json');
  const products = readBundled('products.json');
  if (!stores || !products) throw new ApiError('catalog_bundle_missing', '云函数包内缺少目录文件');
  const familyByKey = new Map(products.families.map(f => [f.familyKey, f]));
  const version = `${products.generatedAt}|${stores.source.fetchedAt}|${products.imagesGeneratedAt || 'no-images'}`;
  return {
    stores: stores.stores.map(toStoreDoc),
    products: products.products.map(p => toProductDoc(p, familyByKey.get(p.familyKey))),
    meta: {
      _id: 'catalog',
      version,
      storesFetchedAt: stores.source.fetchedAt,
      productsGeneratedAt: products.generatedAt,
      imagesGeneratedAt: products.imagesGeneratedAt || null,
      families: products.families.map(f => ({ familyKey: f.familyKey, category: f.category, displayName: f.displayName, supported: f.supported, verified: Boolean(f.pickupVerification && f.pickupVerification.verified), productCount: f.productCount, models: f.models || [] })),
      excludedFamilies: products.excludedFamilies || [],
      seededAt: null,
    },
  };
}

async function get(ctx, payload) {
  const meta = await ctx.repo.getCatalogMeta();
  if (payload && payload.ifVersion && meta && payload.ifVersion === meta.version) return { unchanged: true, version: meta.version };
  const [stores, products] = await Promise.all([ctx.repo.listStores(), ctx.repo.listProducts()]);
  if (!stores.length || !products.length) throw new ApiError('catalog_empty', '目录尚未初始化，请稍后再试');
  const orderCategory = ['iphone', 'ipad', 'mac', 'watch', 'airpods', 'vision', 'homepod'];
  products.sort((a, b) => orderCategory.indexOf(a.category) - orderCategory.indexOf(b.category) || a.familyKey.localeCompare(b.familyKey) || (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'));
  stores.sort((a, b) => (a.province || '').localeCompare(b.province || '', 'zh-Hans-CN') || (a.city || '').localeCompare(b.city || '', 'zh-Hans-CN') || a.storeNumber.localeCompare(b.storeNumber));
  return {
    version: meta ? meta.version : null,
    families: meta ? meta.families : [],
    excludedFamilies: meta ? meta.excludedFamilies : [],
    stores,
    products,
  };
}

/** Operator action: (re)load the bundled catalog into the database. */
async function seed(ctx) {
  const built = buildFromBundled();
  built.meta.seededAt = ctx.nowIso;
  await ctx.repo.replaceCatalog(built);
  return { version: built.meta.version, stores: built.stores.length, products: built.products.length, supportedProducts: built.products.filter(p => p.supported).length };
}

module.exports = { get, seed, buildFromBundled, toProductDoc, toStoreDoc };
