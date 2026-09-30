import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { productImageFit, withImageFit } = require('../miniprogram/utils/product-image-fit');
const images = require('../miniprogram/config/product-images');

test('only measured phone artwork receives a transparent-margin adjustment', () => {
  assert.equal(productImageFit(images['MJTA4CH/A'].imageUrl), 'product-image-fit-pro');
  assert.equal(productImageFit(images['MJYH4CH/A'].imageUrl), 'product-image-fit-max');
  for (const url of [undefined, '', 'https://example.com/iphone-18-pro-finish-select-glacier-202609',
    images['MJTA4CH/A'].imageUrl.replace('202609', '202709'),
    images['MJTA4CH/A'].imageUrl.replace('iphone-18-pro', 'macbook-pro')]) assert.equal(productImageFit(url), '');
});

test('image framing does not mutate cached product data or reuse an obsolete framing hint', () => {
  const cached = { partNumber: 'unknown', imageUrl: '', imageFitClass: 'product-image-fit-pro', title: 'Device' };
  const before = { ...cached };
  const output = withImageFit(cached);
  assert.deepEqual(cached, before);
  assert.equal(output.imageFitClass, '');
  assert.equal(output.title, 'Device');
});
