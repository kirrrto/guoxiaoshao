// Fetch official US Apple Store buy pages (read-only HTTP GET) and maintain catalog/markets/us.json.
// Usage: node tools/catalog/markets/fetch-us.mjs [--check | --sample-pickup]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extractProductSelectionData, extractMetricsProducts } from '../lib/parse-buy-page.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mainland = require('../../../catalog/products.json').products;
const families = require('../families.json').families;
const labels = require('../../i18n/source/catalog');
const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--sample-pickup') ? 'sample' : 'fetch';

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const news = 'https://www.apple.com/newsroom/';
const spring = '2026/03/macbook-neo-iphone-17e-ipad-air-with-m4-and-more-are-now-available/';
const autumn = '2026/09/get-ready-to-experience-iphone-18-pro-the-new-apple-watch-lineup-and-airpods-5/';
const iphone17 = '2025/09/get-ready-to-discover-the-next-generation-of-iphone-apple-watch-and-airpods/';
const m5 = '2025/10/new-ipad-pro-14-inch-macbook-pro-and-apple-vision-pro-now-available/';
const dates = [
  ['2026-03-11', spring, 'iphone-17e ipad-air macbook-air macbook-neo macbook-pro studio-display studio-display-xdr'],
  ['2026-09-18', autumn, 'iphone-18-pro airpods-5'],
  ['2026-09-22', '2026/09/the-new-mac-mini-and-mac-studio-are-available-today/', 'mac-mini mac-studio'],
  ['2026-10-23', '2026/09/apple-unveils-iphone-duo/', 'iphone-duo'],
  ['2025-09-19', iphone17, 'iphone-air iphone-17 airpods-pro-3'],
  ['2024-09-20', '2024/09/the-iphone-16-lineup-airpods-4-apple-watch-series-10-arrive-around-the-world/', 'iphone-16'],
  ['2025-10-22', m5, 'ipad-pro'],
  ['2026-11-06', '2026/10/apple-gives-ipad-mini-its-biggest-update-ever/', 'ipad-mini'],
  ['2025-03-12', '2025/03/apple-introduces-ipad-air-with-powerful-m3-chip-and-new-magic-keyboard/', 'ipad'],
  ['2026-11-06', '2026/10/apple-unveils-groundbreaking-macbook-pro-with-proled-xdr-display/', 'macbook-pro-proled-xdr'],
  ['2026-11-06', '2026/10/apple-unveils-new-imac-with-m6/', 'imac'],
  ['2023-02-03', '2023/01/apple-introduces-the-new-homepod-with-breakthrough-sound-and-intelligence/', 'homepod'],
  ['2026-10-30', '2026/10/apple-announces-the-next-generation-of-homepod-mini/', 'homepod-mini-2'],
];

const macColors = {
  skyblue: ['天蓝色', 'Sky Blue'], midnight: ['午夜色', 'Midnight'], starlight: ['星光色', 'Starlight'],
  silver: ['银色', 'Silver'], spaceblack: ['深空黑色', 'Space Black'], indigo: ['靛蓝色', 'Indigo'],
  citrus: ['柑橘黄色', 'Citrus'], blush: ['桃粉色', 'Blush'], green: ['绿色', 'Green'], pink: ['粉色', 'Pink'],
  blue: ['蓝色', 'Blue'], yellow: ['黄色', 'Yellow'], purple: ['紫色', 'Purple'], orange: ['橙色', 'Orange'],
};
const glassTypes = {
  standard: ['标准玻璃', 'Standard glass'], glossy: ['标准玻璃', 'Standard glass'],
  matte: ['纳米纹理玻璃', 'Nano-texture glass'], nano_texture: ['纳米纹理玻璃', 'Nano-texture glass'],
};

function english(text) {
  const normalized = normalize(text);
  if (!/[\u3400-\u9fff]/.test(normalized)) return normalized;
  if (!labels[normalized]) throw Error('Missing English label: ' + normalized);
  return labels[normalized];
}

function localDimensions(raw) {
  return raw.dimensions || Object.fromEntries(Object.entries(raw).filter(([key, value]) => /(?:^|-)dimension(?!Steporder)/.test(key) && typeof value === 'string'));
}

function matchMainland(familyKey, dims, artworkKey) {
  const candidates = mainland.filter(product => product.familyKey === familyKey && !product.partNumber.startsWith('CTO_')
    && Object.entries(dims).every(([key, value]) => product.dimensionValues[key] === value));
  if (candidates.length !== 1) throw Error('Ambiguous US configuration: ' + JSON.stringify([familyKey, dims, candidates.length]));
  const product = candidates[0];
  if (artworkKey && product.imageKey && artworkKey !== product.imageKey) {
    return { ...product, partNumber: undefined };
  }
  return product;
}

function catalogRow(product, partNumber) {
  const title = normalize(product.title);
  const titleEn = english(title);
  const color = product.attributes.color;
  const model = normalize(product.model).replace(/(\d+) 英寸/g, '$1″').replace('PROLED XDR 显示屏', 'PROLED XDR');
  const result = { partNumber, model, title, titleEn, ...(product.partNumber ? { artworkPart: product.partNumber } : {}) };
  if (color) Object.assign(result, { color, colorEn: english(color) });
  if (product.attributes.capacity) result.capacity = product.attributes.capacity;
  if (product.category === 'ipad') {
    const details = [product.attributes.connection, product.attributes.finish].filter(Boolean);
    result.configuration = details.join(' · ');
    result.configurationEn = details.map(english).join(' · ');
  }
  if (product.dimensionValues.dimensionCharging) {
    const charging = product.dimensionValues.dimensionCharging;
    const cases = { usbc: ['USB-C 充电盒', 'USB-C charging case'], wirelesscharging: ['无线充电盒', 'Wireless charging case'] };
    if (!cases[charging]) throw Error('Unrecognized charging case: ' + charging);
    [result.configuration, result.configurationEn] = cases[charging];
  }
  return result;
}

function monitorRow(family, raw, metric) {
  const glass = raw.dimensionFinish === 'matte' ? '纳米纹理玻璃' : '标准玻璃';
  const stand = { tiltadjuststand: '可调倾斜度支架', tiltheightadjuststand: '可调倾斜度和高度支架', vesa: 'VESA 转换器' }[raw.dimensionStandType];
  if (!stand || !['matte', 'glossy'].includes(raw.dimensionFinish) || !metric?.name) throw Error('Unknown US display configuration');
  const configuration = glass + ' · ' + stand;
  return {
    partNumber: raw.partNumber, model: family.displayName, title: family.displayName + ' ' + configuration,
    titleEn: normalize(metric.name), configuration, configurationEn: normalize(metric.name),
  };
}

function macProduct(family, partNumber, dim, chip) {
  const selectedColor = dim['chassis-dimensionColor'], color = macColors[selectedColor];
  const glass = dim['display-dimensionFinish'], finish = glassTypes[glass];
  if ((selectedColor && !color) || (glass && !finish)) throw Error('Unknown finish: ' + partNumber);
  const cores = dim['processor-dimensionChip-cpuCoreCount-gpuCoreCount'] || dim['processor-cpuCoreCount-gpuCoreCount'];
  const [cpu, gpu] = String(cores).split('-').slice(-2);
  const capacity = String(dim['storage-dimensionCapacity']).toUpperCase(), memory = String(dim['memory-dimensionMemory']).toUpperCase();
  if (!/^\d+(?:GB|TB)$/.test(capacity) || !/^\d+GB$/.test(memory) || !/^\d+$/.test(cpu) || !/^\d+$/.test(gpu)) throw Error('Incomplete hardware: ' + partNumber);
  const modelName = family.familyKey === 'macbook-pro-proled-xdr' ? 'MacBook Pro (PROLED XDR)' : family.displayName;
  const size = dim['chassis-dimensionScreensize']?.replace(/inch$/, '″');
  const model = [modelName, size].filter(Boolean).join(' ');
  const zh = [chip, cpu + ' 核 CPU／' + gpu + ' 核 GPU', memory + ' 内存', finish?.[0]].filter(Boolean).join(' · ');
  const en = [chip, cpu + '-core CPU / ' + gpu + '-core GPU', memory + ' memory', finish?.[1]].filter(Boolean).join(' · ');
  const row = {
    partNumber, model, title: [model, zh, capacity, color?.[0]].filter(Boolean).join(' · '),
    titleEn: [model, en, capacity, color?.[1]].filter(Boolean).join(' · '), capacity, configuration: zh, configurationEn: en,
  };
  if (color) Object.assign(row, { color: color[0], colorEn: color[1] });
  const image = mainland.find(p => p.familyKey === family.familyKey && !p.partNumber.startsWith('CTO_')
    && ['chassis-dimensionScreensize', 'chassis-dimensionColor'].every(k => p.dimensionValues[k] === dim[k]));
  if (image) row.artworkPart = image.partNumber;
  return row;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200) throw Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function canonical(html, expectedPrefix) {
  const href = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const url = new URL(href);
  if (url.origin !== 'https://www.apple.com' || !url.pathname.startsWith(expectedPrefix)) throw Error('Wrong US storefront URL: ' + url);
  return url.href;
}

async function mapLimit(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (i < items.length) { const at = i++; out[at] = await fn(items[at], at); }
  }));
  return out;
}

async function macDetails(family, url, fixedNeoMemory) {
  const html = await fetchHtml(url);
  const selectedUrl = canonical(html, '/shop/buy-mac/' + family.familyKey + '/');
  const block = html.match(/<script type="application\/json" id="metrics">([\s\S]*?)<\/script>/);
  const data = block && JSON.parse(block[1]).data, selected = data?.buyflow?.userSelections, items = data?.products;
  if (!selected || items?.length !== 1 || items[0].category !== 'mac') throw Error('Incomplete selected Mac: ' + url);
  const cpu = selected.PROCESSOR, chip = cpu?.dimensionChip;
  const dim = { 'storage-dimensionCapacity': selected.STORAGE.dimensionValue };
  if (selected.MEMORY) dim['memory-dimensionMemory'] = selected.MEMORY.dimensionValue;
  else if (family.familyKey === 'macbook-neo' && fixedNeoMemory) dim['memory-dimensionMemory'] = '8gb';
  else throw Error('Missing selected memory: ' + url);
  if (cpu?.cpuCoreCount && cpu?.gpuCoreCount) {
    const suffix = [cpu.cpuCoreCount, cpu.gpuCoreCount].join('-');
    if (chip) { dim['processor-dimensionChip'] = chip; dim['processor-dimensionChip-cpuCoreCount-gpuCoreCount'] = chip + '-' + suffix; }
    else dim['processor-cpuCoreCount-gpuCoreCount'] = suffix;
  }
  if (selected.CHASSIS_COLOR) dim['chassis-dimensionColor'] = selected.CHASSIS_COLOR;
  if (selected.SCREEN_SIZE) dim['chassis-dimensionScreensize'] = selected.SCREEN_SIZE;
  if (selected.DISPLAY_FINISH) dim['display-dimensionFinish'] = selected.DISPLAY_FINISH;
  const title = normalize(html.match(/<title>([^<]+)/)?.[1]);
  const namedChip = chip ? chip.toUpperCase().replace(/(PRO|MAX|ULTRA)$/, x => ' ' + x[0] + x.slice(1).toLowerCase())
    : title.match(/\bM[456]\b/i)?.[0] || (family.familyKey === 'macbook-neo' && /A18\s?Pro/i.test(neoSpecs) ? 'A18 Pro' : '');
  if (!namedChip) throw Error('Missing chip identity on ' + url);
  const row = macProduct(family, items[0].partNumber, dim, namedChip);
  row.sourceUrl = selectedUrl;
  if (family.familyKey === 'macbook-pro' && chip === 'm6') {
    Object.assign(row, { releaseDate: '2026-11-06', releaseSource: news + '2026/10/apple-introduces-the-new-14-inch-macbook-pro-with-m6/' });
  }
  return row;
}

function verifyOfflineUsCatalog() {
  const file = path.join(root, 'catalog/markets/us.json');
  const us = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(us.code, 'US');
  const expectedFamilies = families.filter(f => !['ipad-10-2', 'homepod-mini'].includes(f.familyKey) && !['watch', 'vision'].includes(f.category));
  assert.deepEqual(us.families.map(f => f.familyKey), expectedFamilies.map(f => f.familyKey));
  const mainlandParts = new Set(mainland.map(p => p.partNumber));
  const seenParts = new Set();
  const categories = new Set();
  for (const family of us.families) {
    assert.ok(['iphone', 'ipad', 'mac', 'airpods', 'homepod'].includes(family.category), family.category);
    categories.add(family.category);
    assert.match(family.sourceUrl || '', /^https:\/\/www\.apple\.com\/shop\/buy-/);
    assert.ok(Array.isArray(family.products) && family.products.length > 0, family.familyKey);
    for (const product of family.products) {
      assert.match(product.partNumber || '', /^[A-Z0-9]{5,12}\/A$/);
      assert.equal(seenParts.has(product.partNumber), false, 'Duplicate US SKU: ' + product.partNumber);
      seenParts.add(product.partNumber);
      assert.notEqual(product.querySupported, false);
      assert.notEqual(product.monitorSupported, false);
      assert.ok(product.title && product.titleEn && product.model, product.partNumber);
      if (product.artworkPart) assert.ok(mainlandParts.has(product.artworkPart), 'Unknown artworkPart: ' + product.artworkPart);
    }
  }
  assert.deepEqual([...categories].sort(), ['airpods', 'homepod', 'ipad', 'iphone', 'mac']);
  return { checked: true, code: 'US', families: us.families.length, products: seenParts.size };
}

async function sampleUsPickup() {
  const { MARKETS } = require('../../../cloudfunctions/gxs_api/lib/markets.js');
  const { fetchPickup } = require('../../../cloudfunctions/gxs_api/lib/apple-pickup.js');
  const us = MARKETS.find(site => site.code === 'US');
  assert.ok(us, 'US market must be compiled into market-products.json before sampling');
  const sampleParts = ['iphone', 'ipad', 'mac', 'airpods', 'homepod'].map(category => {
    const row = us.products.find(p => p.category === category && p.querySupported && !p.familyKey?.includes('studio-display'));
    assert.ok(row, 'Missing sample product for US category: ' + category);
    return { category, partNumber: row.partNumber, model: row.model };
  });
  const sampleStores = ['R077', 'R102', 'R073'].map(id => {
    const store = us.stores.find(s => s.storeNumber === id);
    assert.ok(store, 'Missing US sample store: ' + id);
    return store;
  });
  const requests = [];
  for (const store of sampleStores) {
    const partNumbers = sampleParts.map(item => item.partNumber);
    const { record, observations } = await fetchPickup({ market: 'US', storeNumber: store.storeNumber, partNumbers });
    assert.equal(record.httpStatus, 200, `US pickup HTTP ${record.httpStatus} for ${store.storeNumber}`);
    assert.equal(record.error, null, `US pickup error for ${store.storeNumber}: ${JSON.stringify(record.error)}`);
    const mapped = sampleParts.map(item => {
      const obs = observations.find(row => row.partNumber === item.partNumber);
      assert.ok(obs && ['available', 'unavailable', 'ineligible', 'pending'].includes(obs.status), JSON.stringify(obs));
      return { category: item.category, partNumber: item.partNumber, status: obs.status };
    });
    requests.push({
      market: 'US',
      state: store.state,
      storeNumber: store.storeNumber,
      storeName: store.name,
      timeZone: store.timeZone,
      requestUrl: record.requestUrl,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      elapsedMs: record.elapsedMs,
      httpStatus: record.httpStatus,
      bytes: record.bytes,
      contentKind: 'json',
      error: record.error,
      retryAfter: record.retryAfter,
      observations: mapped,
    });
  }
  const day = new Date().toISOString().slice(0, 10);
  const outDir = path.join(root, 'evidence/pickup-samples', day);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'us-regions.json');
  fs.writeFileSync(outFile, JSON.stringify({
    date: day,
    method: 'GET',
    scope: '开发机使用果小哨的取货适配器（fetchPickup），对美国免税州与夏威夷代表门店各发起一次 5 品类公开查询。请求无需账户，未访问生产云环境。',
    requests,
  }, null, 2) + '\n');
  return { sampled: true, file: path.relative(root, outFile), stores: requests.map(r => r.storeNumber), observations: requests.reduce((n, r) => n + r.observations.length, 0) };
}

if (mode === 'check') {
  console.log(JSON.stringify(verifyOfflineUsCatalog()));
  process.exit(0);
}
if (mode === 'sample') {
  console.log(JSON.stringify(await sampleUsPickup(), null, 2));
  process.exit(0);
}

const neoSpecs = await fetchHtml('https://www.apple.com/macbook-neo/specs/');
const fixedNeoMemory = /8GB\s+unified\s+memory/i.test(neoSpecs);

const usableFamilies = families.filter(f => !['ipad-10-2', 'homepod-mini'].includes(f.familyKey) && !['watch', 'vision'].includes(f.category));
const output = [];

for (const rawFamily of usableFamilies) {
  const family = { ...rawFamily };
  if (family.familyKey === 'studio-display-xdr') family.displayName = 'Studio Display XDR';
  const targetUrl = family.url.replace('https://www.apple.com.cn/', 'https://www.apple.com/');
  const html = await fetchHtml(targetUrl);
  const sourceUrl = canonical(html, '/shop/buy-');
  const selection = extractProductSelectionData(html);
  if (!selection?.products?.length) throw Error('Missing US selector: ' + sourceUrl);
  const metrics = new Map(extractMetricsProducts(html).map(item => [item.partNumber, item]));
  let products;
  if (family.familyKey.startsWith('studio-display')) {
    products = selection.products.filter(raw => raw.partNumber && !raw.comingSoon && !raw.isComingSoon)
      .map(raw => monitorRow(family, raw, metrics.get(raw.partNumber)));
  } else if (family.category === 'mac') {
    const linked = [...new Set([...html.matchAll(/<a\b[^>]*?\shref\s*=\s*(["'])([\s\S]*?)\1/gi)]
      .map(match => match[2].trim())
      .map(href => href.startsWith('/') ? 'https://www.apple.com' + href : href)
      .filter(href => href.startsWith(sourceUrl + '/') && !/[?#]/.test(href))
      .map(href => new URL(href).href))];
    products = await mapLimit(linked, 6, link => macDetails(family, link, fixedNeoMemory));
    const included = new Set(products.map(row => row.partNumber));
    assert.equal(included.size, products.length, 'Duplicate US Mac SKU: ' + family.familyKey);
    for (const raw of selection.products) {
      if (raw.btrOrFdPartNumber && !included.has(raw.btrOrFdPartNumber)) {
        throw Error('Missing US Mac retail configuration ' + raw.btrOrFdPartNumber + ' in ' + family.familyKey);
      }
    }
  } else {
    const seen = new Set();
    products = [];
    for (const raw of selection.products) {
      if (!raw.partNumber || raw.isCarrierDevice || raw.comingSoon || raw.isComingSoon) continue;
      if (raw.carrierPolicyType && raw.carrierPolicyType !== 'UNLOCKED') continue;
      if (seen.has(raw.partNumber)) continue;
      seen.add(raw.partNumber);
      const dims = localDimensions(raw), metric = metrics.get(raw.partNumber);
      if (family.category === 'iphone' && !dims.dimensionCapacity) {
        const capacity = metric?.name?.match(/\b(\d+(?:GB|TB))\b/i)?.[1];
        if (!capacity) throw Error('Missing capacity for ' + raw.partNumber);
        dims.dimensionCapacity = capacity.toLowerCase();
      }
      const sameHomePod = family.familyKey === 'homepod' && /HomePod\s*[（(]2nd generation[）)]/i.test(html)
        && ['midnight', 'white'].includes(dims.dimensionColor)
        && raw.imageKey === 'homepod-select-' + dims.dimensionColor + '-202610';
      const match = matchMainland(family.familyKey, dims, sameHomePod ? null : raw.imageKey);
      products.push(catalogRow(match, raw.partNumber));
    }
  }
  for (const product of products) {
    if (!product.partNumber || !/^[A-Z0-9]{5,12}\/A$/.test(product.partNumber)) {
      throw Error('Unverified US retail part: ' + product.partNumber);
    }
  }
  const date = dates.find(([, , keys]) => keys.split(' ').includes(family.familyKey));
  const familyRow = { familyKey: family.familyKey, category: family.category, model: family.displayName, sourceUrl };
  if (date) Object.assign(familyRow, { releaseDate: date[0], releaseSource: news + date[1] });
  if (family.familyKey === 'airpods-max-2') {
    Object.assign(familyRow, { availableBy: '2026-04-30', releaseSource: news + '2026/03/apple-introduces-airpods-max-2-powered-by-h2/' });
  }
  familyRow.products = products;
  output.push(familyRow);
  console.log('Fetched US family:', family.familyKey, 'products:', products.length);
}

const destination = new URL('../../../catalog/markets/us.json', import.meta.url);
fs.writeFileSync(destination, JSON.stringify({ code: 'US', families: output }, null, 2) + '\n');
console.log('Wrote catalog/markets/us.json · total products:', output.reduce((s, f) => s + f.products.length, 0));
