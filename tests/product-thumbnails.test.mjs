import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapping = require('../miniprogram/config/product-thumbnails');
const { productThumbnailUrl, withImageFit } = require('../miniprogram/utils/product-image-fit');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'evidence/assets/product-thumbnails.manifest.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog/products.json'), 'utf8'));
const originals = JSON.parse(fs.readFileSync(path.join(root, `evidence/catalog/${catalog.imagesGeneratedAt.slice(0, 10)}/images.verification.json`), 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/product-image-policy.json'), 'utf8'));

// Packaged renditions must decode on phones: WeChat documents <image webp> for
// network resources only, and packaged WebP failed in v3.3.1 phone previews.
function imageSize(bytes, format) {
  if (format === 'PNG') {
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG signature');
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  assert.equal(format, 'JPEG');
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'JPEG SOI');
  for (let offset = 2; offset + 9 < bytes.length;) {
    assert.equal(bytes[offset], 0xff, 'JPEG marker');
    const marker = bytes[offset + 1], size = bytes.readUInt16BE(offset + 2);
    assert.notEqual(marker, 0xc2, 'baseline JPEG, not progressive');
    if (marker === 0xc0 || marker === 0xc1) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
    offset += 2 + size;
  }
  throw Error('Missing JPEG frame header');
}

test('every current SKU maps to a verified exact-source rendition without mutating catalog provenance', () => {
  assert.equal(manifest.catalogSha256, sha(fs.readFileSync(path.join(root, 'catalog/products.json'))));
  assert.equal(manifest.mappingSha256, sha(fs.readFileSync(path.join(root, 'miniprogram/config/product-thumbnails.js'))));
  assert.equal(Object.keys(mapping.byPart).length, catalog.products.length);
  for (const product of catalog.products) {
    const asset = mapping.assets[mapping.byPart[product.partNumber]];
    assert.equal(asset.source, product.imageUrl, product.partNumber);
    assert.equal(productThumbnailUrl(product.imageUrl), asset.card);
    assert.equal(withImageFit(product).imageUrl, product.imageOriginalUrl);
  }
  for (const asset of manifest.assets) {
    const original = originals.entries.find(entry => entry.imageUrl === asset.source);
    assert.equal(asset.sourceSha256, original.record.sha256);
    assert.deepEqual(asset.parts, original.products.map(product => product.partNumber).sort());
  }
});

test('actual packaged image headers, dimensions, byte budgets and source aspect ratios match the manifest', () => {
  let total = 0;
  for (const asset of manifest.assets) for (const rendition of asset.renditions) {
    const bytes = fs.readFileSync(path.join(root, 'miniprogram', rendition.path));
    assert.equal(sha(bytes), rendition.sha256);
    assert.equal(bytes.length, rendition.bytes);
    assert.deepEqual(imageSize(bytes, rendition.format), [rendition.width, rendition.height]);
    assert.equal(rendition.format, rendition.hasTransparency ? 'PNG' : 'JPEG', 'transparent art keeps alpha; opaque art uses JPEG');
    assert.ok(rendition.path.endsWith(rendition.format === 'PNG' ? '.png' : '.jpg'), rendition.path);
    const edge = rendition.variant === 'poster' ? policy.posterMaxEdge : policy.cardMaxEdge;
    assert.ok(Math.max(rendition.width, rendition.height) <= edge);
    assert.ok(Math.abs(rendition.width - rendition.height * asset.sourceWidth / asset.sourceHeight) <= 1.5, 'preserve uncropped proportions');
    assert.ok(bytes.length > 0 && bytes.length <= (rendition.variant === 'poster' ? policy.posterMaxBytes : policy.cardMaxBytes));
    total += bytes.length;
  }
  assert.equal(total, manifest.totalBytes);
  assert.ok(total > 0 && total <= policy.thumbnailMaxBytes);
  for (const field of ['cardMaxEdge', 'posterMaxEdge', 'cardMaxBytes', 'posterMaxBytes']) assert.equal(manifest[field], policy[field]);
  const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  assert.ok(files(path.join(root, 'miniprogram')).reduce((sum, file) => sum + fs.statSync(file).size, 0) < 2 * 1024 * 1024, 'raw main-package bytes must fit 2 MiB before compiler compression');
  assert.deepEqual(files(path.join(root, 'miniprogram')).filter(file => /\.webp$/i.test(file)), [], 'no packaged WebP: phone clients failed to render it');
  const white = manifest.assets.find(asset => asset.source.includes('iphone-duo-finish-select-star-white'));
  assert.ok(white.renditions[0].bytes < 684465 / 30, 'the cloud-audit image must actually shed its oversized payload');
  assert.equal(white.renditions[0].hasTransparency, true);
});

test('known SKU survives old or rotated source URLs while genuinely new SKUs require verified assets', () => {
  const partNumber = 'MK2M4CH/A', asset = mapping.assets[mapping.byPart[partNumber]];
  for (const imageUrl of ['https://example.com/old-cache.png', asset.source + '&new-signature=1', '']) {
    const result = withImageFit({ partNumber, imageUrl, imageDisplayUrl: 'https://example.com/old-display.png' });
    assert.equal(result.imageUrl, imageUrl);
    assert.equal(result.imageDisplayUrl, asset.card);
  }
  assert.equal(productThumbnailUrl('https://example.com/new.png', 'card', 'NEW-SKU'), '');
  assert.equal(productThumbnailUrl(asset.card), asset.card, 'restoring a display path is idempotent');
  const legacyWebpCard = asset.card.replace(/\.(?:png|jpg)$/, '.webp');
  assert.equal(productThumbnailUrl(legacyWebpCard), asset.card, 'migrates earlier v3.3.1 .webp card paths to packaged PNG/JPEG');
  assert.equal(withImageFit({ imageUrl: '', imageDisplayUrl: legacyWebpCard }).imageDisplayUrl, asset.card);
  const posterAsset = mapping.assets.find(item => item.poster);
  assert.equal(productThumbnailUrl(posterAsset.poster.replace(/\.(?:png|jpg)$/, '.webp'), 'poster'), posterAsset.poster, 'migrates earlier .webp poster paths');
});

test('old cached query results, selections and checkout targets resolve local images during restoration', async () => {
  const rt = runtime(action => action === 'user.bootstrap' ? {
    identity: { userKey: 'image-test' }, membership: { active: true }, quota: { balance: 1, queryCost: 1 }, limits: { queryMaxStores: 3 },
    collector: { state: 'running' }, features: {}, newProductWindows: [], followCount: 0,
  } : { unchanged: true });
  const indexed = rt.load('utils/store.js').currentCatalog(), product = indexed.productByPart['MK2M4CH/A'], store = indexed.stores[0];
  const selection = { partNumber: product.partNumber, storeNumbers: [store.storeNumber] };
  const snapshot = { product: { ...product, imageDisplayUrl: product.imageUrl }, accountUserKey: 'image-test', results: [], queriedAt: new Date().toISOString() };
  rt.storage.set('gxs_query_selection_v1', selection); rt.storage.set('gxs_query_result_v1', snapshot);
  const page = rt.instance('pages/query/index.js'); await page.onLoad();
  assert.match(page.data.selectionSummary.imageDisplayUrl, /-card\.(?:png|jpg)$/);
  assert.match(page.data.result.product.imageDisplayUrl, /-card\.(?:png|jpg)$/);
  assert.equal(page.data.result.product.imageUrl, product.imageUrl);
  const checkout = rt.load('utils/checkout-context.js').createCheckoutContext({ wx: rt.wx });
  checkout.save({ userKey: 'image-test' }, selection, indexed);
  assert.match(checkout.restore({ userKey: 'image-test' }, indexed).context.imageDisplayUrl, /-card\.(?:png|jpg)$/);
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3 }); picker.onCatalog(indexed); picker.onValue(selection);
  assert.match(picker.data.product.imageDisplayUrl, /-card\.(?:png|jpg)$/);
  page.onUnload();
});

test('product-image failures keep provenance but never fall back to the large network original', () => {
  const rt = runtime(), original = catalog.products.find(product => product.familyKey === 'iphone-duo').imageUrl;
  const image = withImageFit({ imageUrl: original });
  const query = rt.instance('pages/query/index.js');
  query.data.result = { product: clone(image) }; query.data.selectionSummary = clone(image);
  query.onResultImageError(); query.onSelectionImageError();
  assert.equal(query.data.result.product.imageDisplayUrl, ''); assert.equal(query.data.result.product.imageUrl, original);
  assert.equal(query.data.selectionImageFailed, true);
  const follow = rt.instance('pages/follow/index.js'); follow.data.follows = [clone(image)]; follow.onFollowImageError({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(follow.data.follows[0].imageDisplayUrl, ''); assert.equal(follow.data.follows[0].imageUrl, original);
  const picker = rt.instance('components/target-picker/index.js'); picker.data.product = clone(image); picker.onImageError(); assert.equal(picker.data.imageFailed, true);
  const mine = rt.instance('pages/mine/index.js'); mine.data.checkoutTarget = clone(image); mine.onCheckoutImageError(); assert.equal(mine.data.checkoutTarget.imageDisplayUrl, '');
});

test('all product image templates bind only display resources and opt into WeChat WebP decoding', () => {
  let images = 0;
  for (const name of ['pages/query', 'pages/follow', 'pages/history', 'pages/mine', 'pages/guide', 'components/target-picker']) {
    const template = fs.readFileSync(path.join(root, `miniprogram/${name}/index.wxml`), 'utf8');
    for (const match of template.matchAll(/<image\b[^>]*src="\{\{[^>]*>/g)) {
      assert.match(match[0], /src="\{\{[A-Za-z.]+imageDisplayUrl\}\}"/, name);
      assert.match(match[0], /webp="\{\{true\}\}"/, name);
      images++;
    }
  }
  assert.equal(images, 6);
  const calendar = require('../miniprogram/utils/launch-calendar').calendarView(require('../miniprogram/config/product-launches')[0]);
  assert.match(calendar.imageDisplayUrl, /-poster\.(?:png|jpg)$/);
});
