import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { productThumbnailUrl } = require('../miniprogram/utils/product-image-fit');
const images = require('../miniprogram/config/product-images');
const original = images['MJYH4CH/A'].imageUrl;
const thumbnail = productThumbnailUrl(original);
const product = () => ({ imageUrl: original, imageDisplayUrl: thumbnail, title: 'Official Apple SKU' });

test('query selection uses original Apple image once if its thumbnail fails, then shows placeholder', () => {
  const page = runtime().instance('pages/query/index.js');
  page.setData({ selectionSummary: product(), selectionImageFailed: false });
  page.onSelectionImageError();
  assert.equal(page.data.selectionSummary.imageDisplayUrl, original);
  assert.equal(page.data.selectionImageFailed, false);
  page.onSelectionImageError();
  assert.equal(page.data.selectionImageFailed, true);
  assert.equal(page.data.selectionSummary.imageUrl, original, 'retain original source in model data');
});

test('query result retries original once and only clears display on a second failure', () => {
  const page = runtime().instance('pages/query/index.js');
  page.setData({ result: { product: product() } });
  page.onResultImageError();
  assert.equal(page.data.result.product.imageDisplayUrl, original);
  assert.equal(page.data.result.product.imageUrl, original);
  page.onResultImageError();
  assert.equal(page.data.result.product.imageUrl, '');
});

test('product picker retries verified original before it gives up', () => {
  const picker = runtime().instance('components/target-picker/index.js');
  const item = picker.publicProduct({ ...product(), imageDisplayUrl: 'ignored', partNumber: 'TEST' });
  assert.equal(item.imageDisplayUrl, thumbnail, 'derive thumbnail from authoritative original URL');
  picker.setData({ product: item, imageFailed: false });
  picker.onImageError();
  assert.equal(picker.data.product.imageDisplayUrl, original);
  assert.equal(picker.data.imageFailed, false);
  picker.onImageError();
  assert.equal(picker.data.imageFailed, true);
});

test('follow list image fallback updates only the failed item', () => {
  const page = runtime().instance('pages/follow/index.js');
  const second = { imageUrl: 'https://example.com/other.png', imageDisplayUrl: 'https://example.com/other.png' };
  page.setData({ follows: [product(), second] });
  page.onFollowImageError({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.follows[0].imageDisplayUrl, original);
  assert.deepEqual(page.data.follows[1], second);
  page.onFollowImageError({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.follows[0].imageUrl, '');
  assert.doesNotThrow(() => page.onFollowImageError({ currentTarget: { dataset: { index: 99 } } }));
});

test('all thumbnail display surfaces bind the derived image and preserve the original fallback', () => {
  for (const [file, snippet] of [
    ['pages/query/index.wxml', 'selectionSummary.imageDisplayUrl || selectionSummary.imageUrl'],
    ['pages/query/index.wxml', 'result.product.imageDisplayUrl || result.product.imageUrl'],
    ['pages/follow/index.wxml', 'item.imageDisplayUrl || item.imageUrl'],
    ['components/target-picker/index.wxml', 'product.imageDisplayUrl || product.imageUrl'],
  ]) {
    const source = readFileSync(new URL('../miniprogram/' + file, import.meta.url), 'utf8');
    assert.ok(source.includes(snippet), file + ': expected thumbnail source fallback');
  }
});
