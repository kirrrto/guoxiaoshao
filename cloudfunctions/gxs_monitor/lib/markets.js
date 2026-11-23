'use strict';
const stores = require('./market-stores.json');
const products = require('./market-products.json');
// Only verified local retail targets. Never derive a regional SKU from another region.
const MARKETS = [
  { code: 'JP', name: '日本', nameEn: 'Japan', timeZone: 'Asia/Tokyo' },
  { code: 'TW', name: '台湾', nameEn: 'Taiwan', timeZone: 'Asia/Taipei' },
  { code: 'HK', name: '香港', nameEn: 'Hong Kong', timeZone: 'Asia/Hong_Kong' },
].map(({ code, name, nameEn, timeZone }) => ({
  code, name, nameEn, timeZone,
  products: products[code].map(product => ({ ...product, category: 'iphone', familyKey: 'iphone-18-pro',
    familyName: 'iPhone 18 Pro / Pro Max', supported: true, querySupported: true, monitorSupported: true })),
  stores: stores[code],
}));
const findMarket = code => MARKETS.find(market => market.code === code);
module.exports = { MARKETS, findMarket };
