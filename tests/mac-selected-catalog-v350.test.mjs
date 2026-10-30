import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parseBuyPage, parseSelectedMacConfiguration } from '../tools/catalog/lib/parse-buy-page.mjs';
import { retainPrelaunchRestrictions, buildPickupVerification } from '../tools/catalog/lib/catalog-readiness.mjs';
import { clientCatalogSource } from '../tools/catalog/lib/client-catalog.mjs';
import { selectedMacLinks, collectSelectedMacPages, assertMacSkuCoverage } from '../tools/catalog/lib/selected-mac-pages.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/mac-selected-20261030.json', import.meta.url)));
const linkFixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/mac-selected-links-20261030.json', import.meta.url)));
const catalog = JSON.parse(fs.readFileSync(new URL('../catalog/products.json', import.meta.url)));
const seed = require('../miniprogram/config/catalog-seed');
const images = require('../miniprogram/config/product-images');
const thumbnails = require('../miniprogram/config/product-thumbnails');
const familyKey = 'macbook-pro-proled-xdr';
const html = fixture => `<script type="application/json" id="metrics">${JSON.stringify(fixture.metrics)}</script><script>window.PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: ${JSON.stringify(fixture.selection)} };</script>`;
const parsed = fixtures.map(f => parseSelectedMacConfiguration(html(f), f.context));

test('selected official pages recover all 15 ProLED retail SKUs including four absent from the cold BTR list', () => {
  const proled = parsed.filter(p => p && p.familyKey === familyKey);
  assert.equal(proled.length, 15);
  assert.equal(new Set(proled.map(p => p.partNumber)).size, 15);
  const missingCold = ['MMF54CH/A', 'MMF64CH/A', 'MMF94CH/A', 'MMFA4CH/A'];
  for (const part of missingCold) {
    const p = proled.find(p => p.partNumber === part);
    assert.equal(p.attributes.memory, '48GB');
    assert.equal(p.attributes.capacity, '1TB');
    assert.equal(p.attributes.chip, '18核CPU/20核GPU');
    assert.equal(p.attributes.chipName, 'M5 Pro');
  }
  for (const p of proled) {
    const shipped = catalog.products.find(row => row.partNumber === p.partNumber);
    assert.equal(shipped.title, p.title);
    assert.deepEqual(shipped.attributes, p.attributes);
    assert.equal(shipped.priceCny, p.priceCny);
  }
});

test('selected Mac parsing refuses CTO identifiers and unresolved memory labels', () => {
  const base = fixtures[0];
  const cto = structuredClone(base); cto.metrics.data.products[0].partNumber = 'Z1ABC';
  assert.equal(parseSelectedMacConfiguration(html(cto), cto.context), null);
  const missing = structuredClone(base); missing.selection.configDisplayValues['memory-dimensionMemory'] = {};
  assert.equal(parseSelectedMacConfiguration(html(missing), missing.context), null);
});

test('ProLED gallery, all catalog copies and pending pickup remain aligned without enabling query or monitoring', () => {
  const family = catalog.families.find(f => f.familyKey === familyKey);
  assert.equal(family.productCount, 15);
  assert.equal(family.pickupVerification.status, 'pending');
  assert.equal(family.pickupVerification.verified, false);
  const source = catalog.products.filter(p => p.familyKey === familyKey);
  assert.equal(source.length, 15);
  for (const p of source) {
    const client = seed.products.find(row => row.partNumber === p.partNumber);
    assert.equal(client.comingSoon, true);
    assert.equal(client.supported, false);
    assert.equal(client.verificationStatus, 'pending');
    assert.equal(client.title, p.title);
    assert.equal(images[p.partNumber].imageUrl, p.imageUrl);
    const asset = thumbnails.assets[thumbnails.byPart[p.partNumber]];
    assert.ok(asset && asset.card && fs.existsSync(new URL('../miniprogram' + asset.card, import.meta.url)));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../cloudfunctions/gxs_api/catalog/products.json', import.meta.url))), catalog);
});

test('Mac Studio exact current official standard retail configurations match the existing three catalog SKUs', () => {
  const studio = parsed.filter(p => p && p.familyKey === 'mac-studio');
  assert.equal(studio.length, 3);
  assert.deepEqual(studio.map(p => p.partNumber).sort(), ['MHL64CH/A', 'MHL74CH/A', 'MHQJ4CH/A']);
  for (const p of studio) {
    const shipped = catalog.products.find(row => row.partNumber === p.partNumber);
    for (const key of ['chipName', 'chip', 'memory', 'capacity']) assert.equal(shipped.attributes[key], p.attributes[key]);
    assert.equal(shipped.priceCny, p.priceCny);
  }
});

test('each prelaunch ProLED SKU remains individually selectable for browsing without gaining support', () => {
  for (const p of seed.products.filter(p => p.familyKey === familyKey)) {
    const rt = runtime(), source = rt.load('utils/store.js').currentCatalog();
    const picker = rt.instance('components/target-picker/index.js', { value: { partNumber: p.partNumber, storeNumbers: ['R577'] }, maxStores: 3 });
    picker.onCatalog(source);
    assert.equal(picker.data.product.partNumber, p.partNumber);
    assert.equal(picker.getSelection().product.supported, false);
    assert.equal(picker.data.product.attributes.memory, p.attributes.memory);
    assert.equal(new Set(picker.data.productTitles).size, picker.data.candidates.length);
  }
});

test('normal collector follows the captured official links and supplements cold ProLED 11 to 15 and Studio 2 to 3', async () => {
  for (const [key, folder, count] of [[familyKey, 'proled-research', 15], ['mac-studio', 'mac-studio-research', 3]]) {
    const family = catalog.families.find(f => f.familyKey === key);
    const capture = JSON.parse(fs.readFileSync(new URL(`../evidence/catalog/2026-10-30/${folder}/parsed.json`, import.meta.url)));
    const cold = capture.parsed || capture;
    assert.equal(cold.products.length, key === familyKey ? 11 : 2);
    const selected = fixtures.filter(f => f.context.familyKey === key);
    const markup = linkFixtures.find(f => f.familyKey === key).anchors.join('\n');
    const requests = [];
    const result = await collectSelectedMacPages(markup, family, structuredClone(cold), { intervalMs: 0,
      fetcher: async url => {
        requests.push(url);
        const fixture = selected.find(f => f.context.sourceUrl === url);
        assert.ok(fixture, 'only the captured official URLs may be fetched');
        return { record: { httpStatus: 200 }, text: html(fixture) };
      } });
    assert.equal(requests.length, count);
    assert.equal(result.products.length, count);
    assert.equal(result.selectedPageCount, count);
    assert.doesNotThrow(() => assertMacSkuCoverage(catalog.products.filter(p => p.targetType !== 'apple_cto'), result.products, [key]));
    for (const product of result.products) {
      const expected = parsed.find(p => p.partNumber === product.partNumber);
      assert.deepEqual(product.attributes, expected.attributes);
    }
  }
});

test('selected-page discovery stays within the exact official family and enforces a bounded request count', () => {
  const family = catalog.families.find(f => f.familyKey === familyKey);
  const valid = fixtures[0].context.sourceUrl;
  const links = [valid, valid, valid.replace('www.apple.com.cn', 'example.com'), valid.replace('https:', 'http:'),
    valid.replace(familyKey, 'mac-studio'), valid + '?tracking=1', valid + '#details', valid + '/customize'];
  const markup = links.map(url => `<a href="${url}">配置</a>`).join('') + `<a data-href="${fixtures[1].context.sourceUrl}">忽略</a>`;
  assert.deepEqual(selectedMacLinks(markup, family), [valid]);
  assert.deepEqual(selectedMacLinks(markup, { ...family, category: 'iphone' }), []);
  assert.throws(() => selectedMacLinks(`<a href="${valid}"></a><a href="${fixtures[1].context.sourceUrl}"></a>`, family, { maxPages: 1 }), /too_many_mac_configuration_links/);
});

test('selected-page HTTP failure or unresolved configuration stops immediately without retrying or dropping the SKU', async () => {
  const family = catalog.families.find(f => f.familyKey === familyKey);
  const selected = fixtures.filter(f => f.context.familyKey === familyKey);
  const markup = selected.map(f => `<a href="${f.context.sourceUrl}">配置</a>`).join('');
  const cold = { layout: 'configurator', products: [] };
  let calls = 0;
  await assert.rejects(collectSelectedMacPages(markup, family, cold, { intervalMs: 0,
    fetcher: async () => { calls++; return { record: { httpStatus: 429 }, text: '' }; } }), /mac_configuration_http:.*:429/);
  assert.equal(calls, 1);
  await assert.rejects(collectSelectedMacPages(markup, family, cold, { intervalMs: 0,
    fetcher: async () => ({ record: { httpStatus: 200 }, text: '<html>upstream changed</html>' }) }), /unresolved_mac_configuration/);
  assert.deepEqual(cold.products, []);
});

test('loss of a previously verified Mac SKU fails closed even when upstream selected links disappear', () => {
  const products = catalog.products.filter(p => p.familyKey === familyKey);
  assert.throws(() => assertMacSkuCoverage(catalog.products, products.filter(p => p.partNumber !== 'MMF54CH/A'), [familyKey]), /mac_catalog_removal_requires_review:.*MMF54CH\/A/);
  assert.doesNotThrow(() => assertMacSkuCoverage(catalog.products, products, [familyKey]));
  assert.doesNotThrow(() => assertMacSkuCoverage(catalog.products, [], ['iphone-18-pro']));
});

const { toProductDoc, buildFromBundled } = require('../cloudfunctions/gxs_api/lib/services/catalog');
function seedProducts(products, family) {
  const module = { exports: {} };
  vm.runInNewContext(clientCatalogSource({ products: products.map(p => toProductDoc(p, family)), stores: [],
    meta: { version: 'offline-readiness', families: [family] } }), { module });
  return module.exports.products;
}

test('root and selected-page merges never remove a known prelaunch restriction', async () => {
  const fixture = structuredClone(fixtures[0]);
  const partNumber = fixture.metrics.data.products[0].partNumber;
  fixture.selection.products = [{ btrOrFdPartNumber: partNumber, comingSoon: true }];
  const root = parseBuyPage(html(fixture), { ...fixture.context, category: 'mac' });
  assert.equal(root.products[0].comingSoon, true);
  const family = catalog.families.find(f => f.familyKey === familyKey);
  fixture.selection.products = [];
  const warm = await collectSelectedMacPages(`<a href="${fixture.context.sourceUrl}">配置</a>`, family, root, {
    intervalMs: 0, fetcher: async () => ({ record: { httpStatus: 200 }, text: html(fixture) }),
  });
  assert.equal(warm.products[0].comingSoon, true);
  assert.equal(warm.products[0].titleSource, 'selected_page_metrics_and_labels');
});

test('captured ProLED refresh, pending sampling and generated seed retain all 15 prelaunch restrictions after the release date', async () => {
  const family = catalog.families.find(f => f.familyKey === familyKey);
  const capture = JSON.parse(fs.readFileSync(new URL('../evidence/catalog/2026-10-30/proled-research/parsed.json', import.meta.url)));
  const pickup = JSON.parse(fs.readFileSync(new URL('../evidence/catalog/2026-10-30/proled-research/pickup.json', import.meta.url)));
  const selected = fixtures.filter(f => f.context.familyKey === familyKey);
  const refreshed = await collectSelectedMacPages(linkFixtures.find(f => f.familyKey === familyKey).anchors.join('\n'), family,
    structuredClone(capture.parsed || capture), { intervalMs: 0, fetcher: async url => ({ record: { httpStatus: 200 }, text: html(selected.find(f => f.context.sourceUrl === url)) }) });
  const products = retainPrelaunchRestrictions(refreshed.products, catalog.products);
  assert.equal(products.length, 15);
  assert.ok(products.every(p => p.comingSoon));
  const observation = pickup.observations.find(o => o.partNumber === products[0].partNumber);
  assert.equal(observation.status, 'pending');
  const verification = buildPickupVerification({ observation, storeNumber: 'R577', sampledPartNumber: observation.partNumber,
    checkedAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(verification.verified, false);
  assert.equal(verification.checkedAt, observation.observedAt, 'replay does not move the actual observation time');
  const generated = seedProducts(products, { ...family, pickupVerification: verification });
  assert.ok(generated.every(p => p.comingSoon && !p.supported && !p.querySupported && !p.monitorSupported));
  const validSample = buildPickupVerification({ observation: { ...observation, status: 'available' }, storeNumber: 'R577' });
  assert.ok(seedProducts(products, { ...family, pickupVerification: validSample }).every(p => !p.supported),
    'even a recognized family sample cannot retire an existing SKU restriction');
});

test('pending, unknown and absent samples cannot grant capabilities to new or unrestricted products', () => {
  const family = catalog.families.find(f => f.familyKey === familyKey);
  const product = parsed.find(p => p.familyKey === familyKey);
  const at = '2026-10-30T03:47:21.574Z';
  for (const status of ['pending', 'unknown', 'unexpected', null]) {
    const verification = buildPickupVerification({ observation: status ? { status, observedAt: at } : null,
      storeNumber: 'R577', checkedAt: '2030-01-01T00:00:00.000Z' });
    assert.equal(verification.verified, false);
    const [generated] = seedProducts([{ ...product, comingSoon: false }], { ...family, pickupVerification: verification });
    assert.equal(generated.querySupported, false);
    assert.equal(generated.monitorSupported, false);
  }
  for (const status of ['available', 'unavailable', 'ineligible']) {
    const verification = buildPickupVerification({ observation: { status, observedAt: at }, storeNumber: 'R577' });
    assert.equal(verification.verified, true);
    assert.equal(seedProducts([{ ...product, comingSoon: false }], { ...family, pickupVerification: verification })[0].supported, true);
  }
});

test('refresh restrictions stay SKU-specific and the pure seed generator preserves existing catalog behavior', () => {
  const previous = [{ partNumber: 'MTESTCH/A', familyKey: 'prelaunch', comingSoon: true }];
  const next = retainPrelaunchRestrictions([
    { ...previous[0], comingSoon: false },
    { partNumber: 'MTESTCH/A', familyKey: 'other', comingSoon: false },
    { partNumber: 'MNEW0CH/A', familyKey: 'prelaunch', comingSoon: false },
  ], previous);
  assert.deepEqual(next.map(p => p.comingSoon), [true, false, false]);
  const module = { exports: {} };
  vm.runInNewContext(clientCatalogSource(buildFromBundled()), { module });
  assert.deepEqual(JSON.parse(JSON.stringify(module.exports)), JSON.parse(JSON.stringify(seed)));
});
