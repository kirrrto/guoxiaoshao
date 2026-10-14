import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { productImageFit, withImageFit, productThumbnailUrl } = require('../miniprogram/utils/product-image-fit');
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

test('Apple CDN thumbnails keep asset identity, query order and revision while bounding image pixels', () => {
  const original = images['MJYH4CH/A'].imageUrl;
  const thumb = productThumbnailUrl(original);
  assert.notEqual(thumb, original);
  assert.equal(new URL(thumb).searchParams.get('wid'), '420');
  assert.equal(new URL(thumb).searchParams.get('hei'), '497');
  assert.equal(new URL(thumb).searchParams.get('fmt'), new URL(original).searchParams.get('fmt'));
  assert.equal(new URL(thumb).searchParams.get('.v'), new URL(original).searchParams.get('.v'));
  assert.equal(productImageFit(thumb), 'product-image-fit-max');
  assert.equal(withImageFit({ imageUrl: original }).imageDisplayUrl, thumb);
});

test('unknown, signed non-Apple and already-small URLs remain byte-for-byte unchanged', () => {
  const cases = [
    '', undefined, 'https://example.com/image.png?wid=940&hei=1112',
    'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/test?wid=320&hei=400&fmt=png-alpha',
    'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/test?wid=940&fmt=png-alpha',
    'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/test?wid=wrong&hei=1112',
  ];
  for (const url of cases) assert.equal(productThumbnailUrl(url), url || '');
  const product = { imageUrl: 'https://example.com/image.png', title: 'Unchanged' };
  assert.equal(withImageFit(product).imageUrl, product.imageUrl);
  assert.deepEqual(product, { imageUrl: 'https://example.com/image.png', title: 'Unchanged' });
});
