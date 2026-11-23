'use strict';
const stores = require('./market-stores.json');
const catalog = require('./market-products.json');
const { unpackProducts } = require('./market-catalog');

const regions = [
  { code: 'JP', name: '日本', nameEn: 'Japan', timeZone: 'Asia/Tokyo' },
  { code: 'TW', name: '台湾', nameEn: 'Taiwan', timeZone: 'Asia/Taipei' },
  { code: 'HK', name: '香港', nameEn: 'Hong Kong', timeZone: 'Asia/Hong_Kong' },
];
const MARKETS = regions.map(site => ({ ...site, stores: stores[site.code],
  products: unpackProducts(catalog.regions[site.code], catalog.values) }));
const byRegion = new Map(MARKETS.map(site => [site.code, site]));
const retailParts = new Map(MARKETS.map(site => [site.code,
  new Map(site.products.filter(product => product.partNumber).map(product => [product.partNumber, product]))]));
const findMarket = code => byRegion.get(code);
const findMarketProduct = (code, partNumber) => retailParts.get(code)?.get(partNumber);
module.exports = { MARKETS, findMarket, findMarketProduct, catalog };
