import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const componentPath = path.join(root, 'miniprogram/components/target-picker/index.js');
const { compareCapacities, capacityBytes, sortFamilies, sortModels, storeMatches, CITY_ALIASES, FAMILY_RELEASES } = require('../miniprogram/utils/catalog-order');
const products = JSON.parse(fs.readFileSync(path.join(root, 'catalog/products.json'), 'utf8'));
const stores = JSON.parse(fs.readFileSync(path.join(root, 'catalog/stores.json'), 'utf8')).stores;
const plain = value => JSON.parse(JSON.stringify(value));

function catalog() {
  const categories = [];
  for (const meta of products.families.filter(f => f.productCount > 0)) {
    let category = categories.find(c => c.key === meta.category);
    if (!category) { category = { key: meta.category, name: meta.category, families: [] }; categories.push(category); }
    category.families.push({ familyKey: meta.familyKey, name: meta.displayName, supported: true, catalogOrder: products.families.indexOf(meta), products: products.products.filter(p => p.familyKey === meta.familyKey).map(p => ({ ...p, supported: true })) });
  }
  const cities = [];
  for (const store of stores) {
    let city = cities.find(c => c.city === store.city);
    if (!city) { city = { city: store.city, province: store.province, stores: [] }; cities.push(city); }
    city.stores.push(store);
  }
  return { categories, cities, version: 'picker-fixture' };
}

function picker(value = null, options = {}) {
  let definition; const toasts = [], updates = [], c = options.catalog || catalog();
  vm.runInNewContext(fs.readFileSync(componentPath, 'utf8'), { Component: d => { definition = d; }, require: createRequire(componentPath), console, setTimeout,
    wx: { showToast: data => toasts.push(data), nextTick: fn => fn() } }, { filename: componentPath });
  const instance = { ...definition.methods, data: { ...plain(definition.data), catalog: c, value, maxStores: 3, supportedOnly: Boolean(options.supportedOnly) },
    setData(data) { updates.push(plain(data)); Object.assign(this.data, data); }, triggerEvent(name, detail) { this.lastEvent = plain({ name, detail }); } };
  instance.onCatalog(c);
  return { instance, c, toasts, updates };
}
const tapStore = (picker, storeNumber) => picker.onStoreTap({ currentTarget: { dataset: { store: storeNumber } } });
const search = (picker, value) => picker.onSearchInput({ detail: { value } });

test('storage uses numeric units across GB and TB rather than SKU or lexical order', () => {
  assert.deepEqual(['1TB', '256GB', '2TB', '512GB'].sort(compareCapacities), ['256GB', '512GB', '1TB', '2TB']);
  assert.deepEqual(['标准配置', '2 TB', '64GB', '1.5TB', '1024 GB', '512gb'].sort(compareCapacities), ['64GB', '512gb', '1024 GB', '1.5TB', '2 TB', '标准配置']);
  assert.equal(capacityBytes('1 TB'), capacityBytes('1024GB'));
  assert.equal(capacityBytes('标准配置'), null);
});

test('current iPhone and Mac families show newer official announcements first', () => {
  const c = catalog();
  const iphone = sortFamilies([...c.categories.find(c => c.key === 'iphone').families].reverse());
  assert.deepEqual(iphone.map(f => f.familyKey), ['iphone-18-pro', 'iphone-duo', 'iphone-17e', 'iphone-air', 'iphone-17', 'iphone-16']);
  const mac = sortFamilies(c.categories.find(c => c.key === 'mac').families);
  assert.deepEqual(mac.slice(0, 3).map(f => f.familyKey), ['mac-mini', 'mac-studio', 'macbook-neo']);
  const ipad = sortFamilies(c.categories.find(c => c.key === 'ipad').families);
  assert.deepEqual(ipad.map(f => f.familyKey), ['ipad-air', 'ipad-pro', 'ipad', 'ipad-mini']);
  for (const key of new Set(products.products.map(p => p.familyKey))) assert.ok(FAMILY_RELEASES[key], `missing maintained announcement evidence: ${key}`);
});

test('explicit catalog dates override bundled compatibility dates and do not mutate input', () => {
  const input = [{ familyKey: 'ipad-pro', name: 'iPad Pro', releaseDate: '2027-01-01' }, { familyKey: 'ipad-air', name: 'iPad Air', releaseDate: '2026-03-02' }];
  const before = plain(input);
  assert.equal(sortFamilies(input)[0].familyKey, 'ipad-pro');
  assert.deepEqual(input, before);
  assert.deepEqual(sortModels(['MacBook Pro 16 英寸', 'MacBook Pro 14 英寸']), ['MacBook Pro 14 英寸', 'MacBook Pro 16 英寸']);
  assert.deepEqual(sortModels(['iPhone 16', 'iPhone 18 Pro Max', 'iPhone 18 Pro', 'iPhone 17']), ['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone 17', 'iPhone 16']);
  assert.deepEqual(sortFamilies([{ familyKey: 'iphone-16', name: 'iPhone 16' }, { familyKey: 'iphone-18-pro', name: 'iPhone 18 Pro' }, { familyKey: 'iphone-19', name: 'iPhone 19' }]).map(f => f.familyKey), ['iphone-19', 'iphone-18-pro', 'iphone-16']);
});

test('picker sorts all current capacities and restores exact SKU after catalog order changes', () => {
  const saved = products.products.find(p => p.model === 'iPhone 18 Pro Max' && p.attributes.capacity === '2TB' && p.attributes.color === '银色');
  const { instance: p, c } = picker({ partNumber: saved.partNumber, storeNumbers: ['R577', 'R359'] });
  assert.equal(p.data.product.partNumber, saved.partNumber);
  assert.deepEqual(plain(p.data.capacities), ['256GB', '512GB', '1TB', '2TB']);
  c.categories.forEach(c => c.families.reverse()); p.onCatalog(c);
  assert.equal(p.data.product.partNumber, saved.partNumber);
  assert.deepEqual(p.lastEvent.detail.storeNumbers, ['R577', 'R359']);
  for (let ci = 0; ci < p.catalogCategories.length; ci++) {
    p.selectCategory(ci);
    for (let fi = 0; fi < p.catalogCategories[ci].families.length; fi++) {
      p.selectFamily(fi);
      for (const model of p.data.models) {
        p.updateFilters({ model });
        const bytes = p.data.capacities.map(capacityBytes).filter(n => n !== null);
        assert.ok(bytes.every((n, i) => !i || bytes[i - 1] <= n), `${model} has unsorted capacities`);
      }
    }
  }
});

test('search matches Chinese city/store/province plus city pinyin and initials without a network call', () => {
  const guangzhou = stores.find(s => s.storeNumber === 'R577');
  for (const term of ['广州', '天环', '广东', 'guangzhou', 'GZ', 'gz 天环', 'parccentral']) assert.equal(storeMatches(guangzhou, term), true, term);
  assert.equal(storeMatches(guangzhou, '北京'), false);
  for (const city of new Set(stores.map(s => s.city))) assert.ok(CITY_ALIASES[city], `missing city pinyin: ${city}`);
  const { instance: p } = picker();
  search(p, 'gz'); assert.equal(p.data.searchResults.length, 2); assert.ok(p.data.searchResults.every(s => s.city === '广州'));
  search(p, '广东'); assert.equal(p.data.searchResults.length, 5);
  search(p, 'sz'); assert.ok(p.data.searchResults.some(s => s.city === '深圳')); assert.ok(p.data.searchResults.some(s => s.city === '苏州'));
});

test('search selection is shared across cities, enforces max stores, and survives clear/reset', () => {
  const { instance: p, toasts } = picker();
  search(p, '广州'); tapStore(p, 'R577');
  search(p, '北京'); tapStore(p, 'R320');
  search(p, '上海'); tapStore(p, 'R359'); tapStore(p, 'R389');
  assert.deepEqual(p.lastEvent.detail.storeNumbers, ['R577', 'R320', 'R359']);
  assert.equal(toasts.length, 1); assert.match(toasts[0].title, /最多选择 3/);
  assert.equal(p.data.searchResults.find(s => s.storeNumber === 'R359').on, true);
  tapStore(p, 'R359'); assert.equal(p.data.searchResults.find(s => s.storeNumber === 'R359').on, false);
  p.onClearSearch(); assert.equal(p.data.searchActive, false);
  assert.deepEqual(p.lastEvent.detail.storeNumbers, ['R577', 'R320']);
  search(p, '不存在的门店'); assert.equal(p.data.searchResults.length, 0); assert.equal(p.data.searchActive, true);
  search(p, '   '); assert.equal(p.data.searchActive, false);
});

test('lookup maps and duplicate full products are kept out of component updates', () => {
  const { instance: p, updates } = picker();
  assert.ok(p.productByPart[products.products[0].partNumber]); assert.ok(p.storeByNumber.R577);
  assert.ok(updates.every(patch => !patch.productByPart && !patch.storeByNumber && !patch.catalog));
  assert.ok(p.data.families.every(f => !f.products));
  assert.ok(p.data.candidates.every(c => !c.imageUrl && !c.attributes));
  assert.ok(Math.max(...updates.map(data => Buffer.byteLength(JSON.stringify(data)))) < 20 * 1024);
});

test('switching models keeps available capacity and color and selects the new exact SKU image', () => {
  const saved = products.products.find(p => p.model === 'iPhone 18 Pro' && p.attributes.capacity === '512GB' && p.attributes.color === '银色');
  const expected = products.products.find(p => p.model === 'iPhone 18 Pro Max' && p.attributes.capacity === '512GB' && p.attributes.color === '银色');
  const { instance: p } = picker({ partNumber: saved.partNumber, storeNumbers: ['R577', 'R359'] });
  p.onModelChange({ detail: { value: p.data.models.indexOf(expected.model) } });
  assert.equal(p.data.product.partNumber, expected.partNumber);
  assert.equal(p.data.product.imageUrl, expected.imageUrl);
  assert.equal(p.data.product.attributes.capacity, '512GB');
  assert.equal(p.data.product.attributes.color, '银色');
  assert.equal(p.data.selectionNote, '');
  assert.deepEqual(p.lastEvent.detail.storeNumbers, ['R577', 'R359']);
});

test('model changes explain unavailable attributes and clear the note after an explicit color choice', () => {
  const c = catalog();
  const family = c.categories.find(c => c.key === 'iphone').families.find(f => f.familyKey === 'iphone-18-pro');
  family.products = family.products.filter(p => p.model !== 'iPhone 18 Pro Max' || p.attributes.capacity === '256GB');
  const saved = family.products.find(p => p.model === 'iPhone 18 Pro' && p.attributes.capacity === '512GB' && p.attributes.color === '银色');
  const { instance: p } = picker({ partNumber: saved.partNumber, storeNumbers: ['R577'] }, { catalog: c });
  p.onModelChange({ detail: { value: p.data.models.indexOf('iPhone 18 Pro Max') } });
  assert.equal(p.data.product.attributes.capacity, '256GB');
  assert.equal(p.data.product.attributes.color, '银色', 'preserve the still-available color despite a capacity fallback');
  assert.match(p.data.selectionNote, /256GB/);
  assert.match(p.data.selectionNote, /请核对/);
  p.onColorTap({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(p.data.selectionNote, '');
});

test('supported-only selection removes unavailable SKUs and empty groups without mutating the shared catalog', () => {
  const c = catalog();
  const firstFamily = c.categories[0].families[0];
  const removedPart = firstFamily.products[0].partNumber;
  firstFamily.products[0].supported = false;
  const removedFamily = c.categories[0].families[1];
  removedFamily.products.forEach(p => { p.supported = false; });
  const removedCategory = c.categories[c.categories.length - 1];
  removedCategory.families.forEach(f => f.products.forEach(p => { p.supported = false; }));
  const before = plain(c);
  const { instance: p } = picker(null, { catalog: c, supportedOnly: true });
  assert.equal(p.productByPart[removedPart], undefined);
  assert.ok(!p.catalogCategories.find(category => category.key === removedCategory.key));
  assert.ok(!p.catalogCategories.flatMap(category => category.families).some(f => f.familyKey === removedFamily.familyKey));
  assert.ok(Object.values(p.productByPart).every(product => product.supported));
  assert.deepEqual(c, before, 'the query picker must retain the original full catalog');
  const ordinary = picker(null, { catalog: c }).instance;
  assert.ok(ordinary.productByPart[removedPart]);
});

test('an unavailable saved follow stays unselected across refreshes until the user chooses another configuration', () => {
  const c = catalog(), firstFamily = c.categories[0].families[0];
  const saved = firstFamily.products[0];
  saved.supported = false;
  const { instance: p } = picker({ partNumber: saved.partNumber, storeNumbers: ['R577', 'REMOVED'] }, { catalog: c, supportedOnly: true });
  assert.equal(p.data.product, null);
  assert.equal(p.lastEvent.detail.partNumber, null);
  assert.match(p.data.selectionNote, /暂未开放关注/);
  assert.match(p.data.selectionNote, /门店/);
  assert.deepEqual(p.lastEvent.detail.storeNumbers, ['R577']);
  p.onCatalog(c);
  assert.equal(p.lastEvent.detail.partNumber, null, 'a refresh must not silently substitute the first supported SKU');
  p.onModelChange({ detail: { value: 0 } });
  assert.ok(p.data.product && p.data.product.supported);
  assert.notEqual(p.lastEvent.detail.partNumber, saved.partNumber);
  assert.equal(p.data.selectionNote, '');
});

test('supported-only mode handles an entirely unavailable catalog and a live availability change', () => {
  const c = catalog();
  const { instance: p } = picker(null, { catalog: c });
  tapStore(p, 'R577');
  c.categories.forEach(category => category.families.forEach(f => f.products.forEach(product => { product.supported = false; })));
  p.data.supportedOnly = true;
  p.onSupportedOnlyChange();
  assert.equal(p.data.product, null);
  assert.equal(p.lastEvent.detail.partNumber, null);
  assert.equal(p.data.categories.length, 0);
  assert.equal(p.data.families.length, 0);
  assert.equal(p.data.models.length, 0);
  assert.equal(p.data.capacities.length, 0);
  assert.match(p.data.selectionNote, /暂无可关注/);
  assert.deepEqual(p.lastEvent.detail.storeNumbers, ['R577']);
  p.onCatalog(c);
  assert.equal(p.lastEvent.detail.partNumber, null);
});

test('a locally chosen SKU becoming unavailable does not silently switch on the next catalog refresh', () => {
  const c = catalog();
  const { instance: p } = picker(null, { catalog: c, supportedOnly: true });
  tapStore(p, 'R577');
  const selected = p.data.product.partNumber;
  for (const category of c.categories) for (const f of category.families) for (const product of f.products) {
    if (product.partNumber === selected) product.supported = false;
  }
  p.onCatalog(c);
  assert.equal(p.lastEvent.detail.partNumber, null);
  tapStore(p, 'R359');
  p.onCatalog(c);
  assert.equal(p.lastEvent.detail.partNumber, null);
  assert.match(p.data.selectionNote, /暂未开放关注/);
  assert.deepEqual(p.lastEvent.detail.storeNumbers, ['R577', 'R359']);
});

test('an unavailable color on another model falls back explicitly while retaining available capacity', () => {
  const c = catalog();
  const family = c.categories.find(c => c.key === 'iphone').families.find(f => f.familyKey === 'iphone-18-pro');
  family.products = family.products.filter(p => p.model !== 'iPhone 18 Pro Max' || p.attributes.color !== '银色');
  const saved = family.products.find(p => p.model === 'iPhone 18 Pro' && p.attributes.capacity === '512GB' && p.attributes.color === '银色');
  const { instance: p } = picker({ partNumber: saved.partNumber, storeNumbers: ['R577'] }, { catalog: c });
  p.onModelChange({ detail: { value: p.data.models.indexOf('iPhone 18 Pro Max') } });
  assert.equal(p.data.product.attributes.capacity, '512GB');
  assert.notEqual(p.data.product.attributes.color, '银色');
  assert.ok(p.data.selectionNote.includes(p.data.product.attributes.color));
  assert.match(p.data.selectionNote, /请核对/);
});
