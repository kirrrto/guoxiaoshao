// Compile the public storefront selections into the directory shipped with
// both cloud functions. Only the selected options, labels and dates reach the app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import schema from '../../miniprogram/utils/market-catalog.js';
import membershipWindow from '../../cloudfunctions/gxs_api/lib/rules/new-product.js';

const root = new URL('../../', import.meta.url);
const sources = new URL('catalog/markets/', root);
const output = new URL('cloudfunctions/gxs_api/lib/market-products.json', root);
const { PRODUCT_FIELDS } = schema;
const { RESTRICTION_DAYS } = membershipWindow;
const byPart = JSON.parse(fs.readFileSync(new URL('catalog/products.json', root))).products;
const artwork = new Set(byPart.map(product => product.partNumber));
const categories = new Set(['iphone', 'ipad', 'mac', 'airpods', 'homepod']);
const clean = value => typeof value === 'string' && value.trim().length > 0;

function officialLink(value, code) {
  const link = new URL(value);
  assert.equal(link.protocol, 'https:');
  assert.ok(['www.apple.com', 'support.apple.com', 'images.apple.com'].includes(link.hostname));
  if (code === 'US') {
    assert.ok(!/^\/[a-z]{2}(?:\/|$)/.test(link.pathname.toLowerCase()), 'Wrong US storefront: ' + link);
  } else {
    assert.ok(link.pathname.toLowerCase().includes(code.toLowerCase()), 'Wrong storefront: ' + link);
  }
}
function usPacificOffsetHours(utcProbeMs) {
  const std = -8;
  const year = new Date(utcProbeMs + std * 3600000).getUTCFullYear();
  const marStart = Date.UTC(year, 2, 8 + ((7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7), 2 - std);
  const novEnd = Date.UTC(year, 10, 1 + ((7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7), 2 - (std + 1));
  return utcProbeMs >= marStart && utcProbeMs < novEnd ? std + 1 : std;
}
function localMidnight(date, code) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  const stamp = new Date(date + 'T00:00:00Z');
  assert.equal(stamp.toISOString().slice(0, 10), date);
  if (code === 'US') {
    const [y, m, d] = date.split('-').map(Number);
    const offset = usPacificOffsetHours(Date.UTC(y, m - 1, d, 8, 0, 0));
    return Date.UTC(y, m - 1, d, -offset, 0, 0);
  }
  stamp.setUTCHours(code === 'JP' ? -9 : -8);
  return stamp.getTime();
}
function addCalendarDays(date, days) {
  const stamp = new Date(date + 'T00:00:00Z');
  stamp.setUTCDate(stamp.getUTCDate() + days);
  return stamp.toISOString().slice(0, 10);
}
function directoryProduct(row, family, code) {
  const partNumber = row.partNumber || null;
  assert.ok(partNumber, family.familyKey + ' must contain only retail SKUs');
  assert.match(partNumber, /^[A-Z0-9]{5,16}\/A$/);
  assert.ok(clean(row.title) && clean(row.titleEn), family.familyKey + ' needs distinct, bilingual options');
  assert.ok(row.querySupported !== false && row.monitorSupported !== false, partNumber + ' must support query and monitoring');
  if (row.artworkPart) assert.ok(artwork.has(row.artworkPart), 'Unknown packaged visual ' + row.artworkPart);
  const date = row.releaseDate || row.availableBy || family.releaseDate || family.availableBy;
  let releaseAt, freeQueryStartsAt;
  if (date) {
    officialLink(row.releaseSource || family.releaseSource, code);
    const start = localMidnight(date, code);
    if (row.releaseDate || (!row.availableBy && family.releaseDate)) releaseAt = new Date(start).toISOString();
    freeQueryStartsAt = new Date(localMidnight(addCalendarDays(date, RESTRICTION_DAYS), code)).toISOString();
  }
  return {
    ...row, partNumber, id: undefined,
    category: family.category, familyKey: family.familyKey, familyName: family.model,
    model: row.model || family.model, releaseAt, freeQueryStartsAt, supported: true, querySupported: true, monitorSupported: true,
  };
}
export function buildMarketCatalog() {
  const values = [null], indices = new Map([[null, 0]]), regions = {};
  function valueIndex(value) {
    if (value === undefined || value === '') return 0;
    if (!indices.has(value)) { indices.set(value, values.length); values.push(value); }
    return indices.get(value);
  }
  for (const code of ['JP', 'TW', 'HK', 'US']) {
    const {code:declared,families} = JSON.parse(fs.readFileSync(new URL(code.toLowerCase()+'.json', sources)));
    assert.equal(code,declared);
    const ids = new Set(), coverage = new Set();
    const rows = [];
    for (const family of families) {
      officialLink(family.sourceUrl,code);
      assert.ok(categories.has(family.category) && family.products.length && clean(family.model),family.familyKey);
      coverage.add(family.category);
      for (const row of family.products) {
        const product = directoryProduct(row,family,code);
        const id = product.id || product.partNumber;
        assert.ok(!ids.has(id),code+' duplicate configuration '+id);
        ids.add(id);
        const packed = PRODUCT_FIELDS.map(key=>valueIndex(product[key]));
        while (packed.at(-1)===0) packed.pop();
        rows.push(packed);
      }
    }
    assert.deepEqual(coverage,categories,'Incomplete category coverage in '+code);
    regions[code] = rows;
  }
  return {format:'compact-v1',values,regions};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = buildMarketCatalog();
  const text = JSON.stringify(catalog)+'\n';
  const helperTarget = new URL('cloudfunctions/gxs_api/lib/market-catalog.js',root);
  const helper = fs.readFileSync(new URL('miniprogram/utils/market-catalog.js',root),'utf8');
  if (process.argv.includes('--check')) {
    assert.ok(fs.readFileSync(output,'utf8') === text,'Rebuild the regional directory');
    assert.equal(fs.readFileSync(helperTarget,'utf8'),helper,'Rebuild the regional catalog decoder');
  } else {
    fs.writeFileSync(output,text);
    fs.writeFileSync(helperTarget,helper);
  }
  console.log(Object.fromEntries(Object.entries(catalog.regions).map(([code,rows])=>[code,rows.length])));
}
