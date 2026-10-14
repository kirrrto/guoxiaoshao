import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { productThumbnailUrl } = require('../miniprogram/utils/product-image-fit');
const images = require('../miniprogram/config/product-images');
const original = images['MJYJ4CH/A'].imageUrl;
const product = () => ({ imageUrl: original, imageDisplayUrl: productThumbnailUrl(original), title: 'Official Apple SKU' });

test('query selection uses verified original and does not retry an identical failed rendition', () => {
  const page = runtime().instance('pages/query/index.js');
  page.setData({ selectionSummary: product(), selectionImageFailed: false });
  assert.equal(page.data.selectionSummary.imageDisplayUrl, original);
  page.onSelectionImageError();
  assert.equal(page.data.selectionImageFailed, true);
});

test('query result never repeats the same original URL after an image error', () => {
  const page = runtime().instance('pages/query/index.js');
  page.setData({ result: { product: product() } });
  page.onResultImageError();
  assert.equal(page.data.result.product.imageUrl, '');
});

test('picker displays the unchanged verified image and handles an error once', () => {
  const picker = runtime().instance('components/target-picker/index.js');
  const item = picker.publicProduct({ ...product(), partNumber: 'TEST' });
  assert.equal(item.imageDisplayUrl, original);
  picker.setData({ product: item, imageFailed: false });
  picker.onImageError();
  assert.equal(picker.data.imageFailed, true);
});

test('follow list shows original URL and only clears a failed item', () => {
  const page = runtime().instance('pages/follow/index.js');
  const second = { imageUrl: 'https://example.com/other.png', imageDisplayUrl: 'https://example.com/other.png' };
  page.setData({ follows: [product(), second] });
  page.onFollowImageError({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.follows[0].imageUrl, '');
  assert.deepEqual(page.data.follows[1], second);
  assert.doesNotThrow(() => page.onFollowImageError({ currentTarget: { dataset: { index: 99 } } }));
});

test('display surfaces retain valid original image fallback bindings', () => {
  for (const [file, snippet] of [
    ['pages/query/index.wxml', 'selectionSummary.imageDisplayUrl || selectionSummary.imageUrl'],
    ['pages/query/index.wxml', 'result.product.imageDisplayUrl || result.product.imageUrl'],
    ['pages/follow/index.wxml', 'item.imageDisplayUrl || item.imageUrl'],
    ['components/target-picker/index.wxml', 'product.imageDisplayUrl || product.imageUrl'],
  ]) {
    const source = readFileSync(new URL('../miniprogram/' + file, import.meta.url), 'utf8');
    assert.ok(source.includes(snippet), file + ': image binding missing');
  }
});
