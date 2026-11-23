import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildCatalogNames } from '../tools/catalog/build-english-names.mjs';

const require = createRequire(import.meta.url);
const { products } = require('../catalog/products.json');
const { stores } = require('../catalog/stores.json');
const locations = require('../miniprogram/i18n/catalog-locations');
const { presentStore } = require('../miniprogram/utils/store-label');
const { storeMatches } = require('../miniprogram/utils/catalog-order');
const { english } = require('../miniprogram/i18n/dictionary');
const { text, options } = require('../miniprogram/i18n/translate');
const chinese = /[\u3400-\u9fff]/;

test('all mainland catalog SKUs, picker variants and result subtitles have English display labels', () => {
  assert.deepEqual(buildCatalogNames(), require('../tools/i18n/source/catalog-titles'));
  const dictionary = english(), labels = new Map();
  for (const product of products) {
    const title = text(dictionary, product.title), attributes = product.attributes;
    assert.ok(title && !chinese.test(title), product.title);
    assert.ok(!labels.has(title), 'Separate SKUs must retain distinct labels: '+title);
    labels.set(title,product.partNumber);
    if (product.category === 'mac') {
      if (attributes.memory) assert.ok(title.includes(attributes.memory), title);
      if (attributes.capacity) assert.ok(title.includes(attributes.capacity), title);
      if (attributes.chipName) assert.ok(title.includes(attributes.chipName), title);
    }
    const normalized = product.title.replace(/\s+/g,' ').trim();
    if (normalized.startsWith(product.model+' ')) assert.doesNotMatch(text(dictionary,normalized.slice(product.model.length).trim()),chinese);
    if (attributes.color && normalized.endsWith(' '+attributes.color)) assert.doesNotMatch(text(dictionary,normalized.slice(0,-attributes.color.length).trim()),chinese);
    for (const attribute of ['color','screensize','chip','finish','connection','charging']) {
      const value = attributes[attribute];
      if (value) assert.doesNotMatch(text(dictionary,value),chinese);
    }
  }
  assert.deepEqual(options(dictionary,['上海（7）','北京（6）']), ['Shanghai (7)','Beijing (6)']);
});
test('English city, province and store search returns the same store numbers as Chinese labels', () => {
  for (const original of stores) {
    const store = presentStore(original), name = locations[store.name], city = locations[store.city], province = locations[store.province];
    assert.ok(name && city && province, store.storeNumber);
    assert.ok(storeMatches(store,[city,name].join(' ')), [city,name,store.storeNumber].join(' '));
    assert.ok(storeMatches(store,province),province);
    assert.ok(storeMatches(store,store.name),store.name);
    assert.equal(store.storeNumber,original.storeNumber);
  }
});
