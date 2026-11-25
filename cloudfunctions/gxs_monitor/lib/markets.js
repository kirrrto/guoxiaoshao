'use strict';
const stores = require('./market-stores.json');
const catalog = require('./market-products.json');
const { unpackProducts } = require('./market-catalog');

const regions = [
  { code: 'JP', name: '日本', nameEn: 'Japan', timeZone: 'Asia/Tokyo' },
  { code: 'TW', name: '台湾', nameEn: 'Taiwan', timeZone: 'Asia/Taipei' },
  { code: 'HK', name: '香港', nameEn: 'Hong Kong', timeZone: 'Asia/Hong_Kong' },
  { code: 'US', name: '美国', nameEn: 'United States', shortNameEn: 'US', timeZone: 'America/Los_Angeles' },
];
const FIXED_OFFSETS = { 'Asia/Tokyo': 9, 'Asia/Taipei': 8, 'Asia/Hong_Kong': 8, 'Pacific/Honolulu': -10, 'America/Phoenix': -7 };
const US_DST_OFFSETS = { 'America/Anchorage': -9, 'America/Los_Angeles': -8, 'America/Denver': -7, 'America/Chicago': -6, 'America/New_York': -5 };
function zoneOffsetHours(stamp, timeZone) {
  if (Object.hasOwn(FIXED_OFFSETS, timeZone)) return FIXED_OFFSETS[timeZone];
  if (!Object.hasOwn(US_DST_OFFSETS, timeZone)) return 0;
  const std = US_DST_OFFSETS[timeZone];
  const year = new Date(stamp + std * 3600000).getUTCFullYear();
  const marStart = Date.UTC(year, 2, 8 + ((7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7), 2 - std);
  const novEnd = Date.UTC(year, 10, 1 + ((7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7), 2 - (std + 1));
  return stamp >= marStart && stamp < novEnd ? std + 1 : std;
}
const MARKETS = regions.map(site => ({ ...site, stores: stores[site.code],
  products: unpackProducts(catalog.regions[site.code], catalog.values) }));
const byRegion = new Map(MARKETS.map(site => [site.code, site]));
const retailParts = new Map(MARKETS.map(site => [site.code,
  new Map(site.products.filter(product => product.partNumber).map(product => [product.partNumber, product]))]));
const findMarket = code => byRegion.get(code);
const findMarketProduct = (code, partNumber) => retailParts.get(code)?.get(partNumber);
module.exports = { MARKETS, findMarket, findMarketProduct, zoneOffsetHours, catalog };
