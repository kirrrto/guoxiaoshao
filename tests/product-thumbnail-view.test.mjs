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

test('query selection uses a packaged rendition and stops after a failed decode', () => {
  const page = runtime().instance('pages/query/index.js');
  page.setData({ selectionSummary: product(), selectionImageFailed: false });
  assert.match(page.data.selectionSummary.imageDisplayUrl, /^\/images\/products\/.+-card\.(?:png|jpg)$/);
  assert.equal(page.data.selectionSummary.imageUrl, original);
  page.onSelectionImageError();
  assert.equal(page.data.selectionImageFailed, true);
});

test('query result never repeats the same original URL after an image error', () => {
  const page = runtime().instance('pages/query/index.js');
  page.setData({ result: { product: product() } });
  page.onResultImageError();
  assert.equal(page.data.result.product.imageDisplayUrl, '');
  assert.equal(page.data.result.product.imageUrl, original);
});

test('picker displays the verified image rendition and handles an error once', () => {
  const picker = runtime().instance('components/target-picker/index.js');
  const item = picker.publicProduct({ ...product(), partNumber: 'TEST' });
  assert.match(item.imageDisplayUrl, /^\/images\/products\/.+-card\.(?:png|jpg)$/);
  assert.equal(item.imageUrl, original);
  picker.setData({ product: item, imageFailed: false });
  picker.onImageError();
  assert.equal(picker.data.imageFailed, true);
});

test('follow list clears only the failed rendition and retains source provenance', () => {
  const page = runtime().instance('pages/follow/index.js');
  const second = { imageUrl: 'https://example.com/other.png', imageDisplayUrl: 'https://example.com/other.png' };
  page.setData({ follows: [product(), second] });
  page.onFollowImageError({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.follows[0].imageDisplayUrl, '');
  assert.equal(page.data.follows[0].imageUrl, original);
  assert.deepEqual(page.data.follows[1], second);
  assert.doesNotThrow(() => page.onFollowImageError({ currentTarget: { dataset: { index: 99 } } }));
});

test('display surfaces never bind the unbudgeted original as a fallback', () => {
  for (const [file, snippet] of [
    ['pages/query/index.wxml', 'selectionSummary.imageDisplayUrl'],
    ['pages/query/index.wxml', 'result.product.imageDisplayUrl'],
    ['pages/follow/index.wxml', 'item.imageDisplayUrl'],
    ['components/target-picker/index.wxml', 'product.imageDisplayUrl'],
  ]) {
    const source = readFileSync(new URL('../miniprogram/' + file, import.meta.url), 'utf8');
    assert.ok(source.includes('src="{{' + snippet + '}}"'), file + ': image binding missing');
    assert.doesNotMatch(source, /src="\{\{[^}]*imageUrl/);
  }
});
