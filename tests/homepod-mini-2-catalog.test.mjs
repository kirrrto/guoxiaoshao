import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { buildFromBundled } = require('../cloudfunctions/gxs_api/lib/services/catalog');

test('HomePod mini 2 appears first in the real offline picker with five distinct supported colors', () => {
  const rt = runtime();
  const catalog = rt.load('utils/store.js').currentCatalog();
  const category = catalog.categories.find(c => c.key === 'homepod');
  assert.equal(category.families[0].familyKey, 'homepod-mini-2');
  assert.ok(category.families.some(f => f.familyKey === 'homepod-mini'));
  const picker = rt.instance('components/target-picker/index.js');
  picker.data.supportedOnly = true;
  picker.data.catalog = catalog;
  picker.onCatalog(catalog);
  picker.selectCategory(picker.catalogCategories.findIndex(c => c.key === 'homepod'));
  picker.selectFamily(0);
  assert.deepEqual(new Set(picker.data.colors), new Set(['白色', '粉色', '蓝色', '绿色', '午夜色']));
  const products = category.families[0].products;
  for (const product of products) {
    picker.updateFilters({ model: 'HomePod mini 2', color: product.attributes.color });
    const selection = picker.getSelection();
    assert.equal(selection.partNumber, product.partNumber);
    assert.equal(selection.product.priceCny, 1099);
    assert.equal(selection.product.supported, true);
    assert.equal(selection.product.verificationStatus, 'pending');
    assert.ok(selection.product.imageUrl.includes('202610'));
  }
});

test('cloud bundle has sourced generation metadata and all HomePod mini 2 SKUs match pending pickup evidence', () => {
  const built = buildFromBundled();
  const family = built.meta.families.find(f => f.familyKey === 'homepod-mini-2');
  assert.equal(family.releaseDate, '2026-10-13');
  assert.ok(family.releaseSourceUrl.endsWith('/apple-announces-the-next-generation-of-homepod-mini/'));
  const observations = JSON.parse(readFileSync(new URL('../evidence/pickup-samples/2026-10-14/homepod-mini-2.json', import.meta.url), 'utf8')).observations;
  const products = built.products.filter(p => p.familyKey === 'homepod-mini-2');
  assert.equal(products.length, 5);
  assert.deepEqual(new Set(products.map(p => p.partNumber)), new Set(observations.map(o => o.partNumber)));
  assert.ok(observations.every(o => o.status === 'pending' && o.quote === '10 月 30 日可取货'));
  assert.ok(products.every(p => p.supported && !p.comingSoon && p.verificationStatus === 'pending'));
});
