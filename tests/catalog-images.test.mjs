import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { imageFromDescriptor, imagePlan, isOfficialImageUrl } from '../tools/catalog/lib/product-images.mjs';
import { resolveProductImages } from '../tools/catalog/lib/resolve-images.mjs';
import { parseBuyPage } from '../tools/catalog/lib/parse-buy-page.mjs';

const require = createRequire(import.meta.url);
const catalogService = require('../cloudfunctions/gxs_api/lib/services/catalog.js');
const catalogFile = new URL('../catalog/products.json', import.meta.url);
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const sourceUrl = 'https://www.apple.com.cn/shop/buy-mac/macbook-air';
const imageUrl = 'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/macbook-air-13inch-skyblue?wid=5120&hei=3280&fmt=p-jpg&qlt=80&.v=originalSignature&traceId=1';
const descriptor = (key = 'macbook-air-13inch-skyblue', url = imageUrl) => ({ imageName: key,
  alt: '天蓝色 13 英寸 MacBook Air', width: 2560, height: 1640, sources: [{ type: 'image/jpeg', srcSet: url }] });
const makeGallery = (required = ['chassis-dimensionScreensize', 'chassis-dimensionColor']) => ({
  productGalleryUrl: '/shop/api/kit-product-gallery?fae=true&node=home/shop_mac/family/macbook_air/select',
  productGalleryData: { summary: { warmStateImageSetRules: required,
    coldStateGalleries: [{ asset: { image: descriptor('multi-color-family') } }] } },
});

test('every catalog SKU has a sourced official image, with no unresolved image request', async () => {
  assert.equal(catalog.imageCount, catalog.products.length);
  assert.ok(catalog.imagesGeneratedAt);
  assert.equal(new Set(catalog.products.map(p => p.partNumber)).size, catalog.products.length);
  for (const p of catalog.products) {
    assert.ok(isOfficialImageUrl(p.imageUrl), p.partNumber);
    assert.equal(p.imageUrl, p.imageOriginalUrl, `${p.partNumber}: preserve signed rendition`);
    assert.ok(p.imageAlt && p.imageKey && p.imageWidth > 0 && p.imageHeight > 0, p.partNumber);
    assert.equal(new URL(p.imageSourceUrl).hostname, 'www.apple.com.cn');
    assert.ok(['apple-selector', 'apple-gallery', 'apple-family-summary'].includes(p.imageSource));
    assert.equal(p.imageRequest, undefined, p.partNumber);
    assert.equal(p.imageUnavailableReason, undefined, p.partNumber);
    if (p.imageSource === 'apple-gallery') {
      const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const [dim, value] of Object.entries(p.imageMatchDimensions)) {
        assert.equal(new URL(p.imageSourceUrl).searchParams.get(`dm.${dim}`), value);
        if (/dimensionColor|dimensionScreensize/.test(dim)) assert.ok(normalize(p.imageKey).includes(normalize(value)), p.partNumber);
      }
    }
  }
  assert.deepEqual(await readFile(new URL('../cloudfunctions/gxs_api/catalog/products.json', import.meta.url)), await readFile(catalogFile));
});

test('selector parsing uses each retail SKU imageKey and preserves signed source parameters', () => {
  const silverUrl = imageUrl.replace('skyblue', 'silver');
  const data = { sections: [{ formFieldName: 'dimensionColor' }],
    products: [{ partNumber: 'AAAA1CH/A', dimensionColor: 'skyblue', imageKey: 'blue-image' },
      { partNumber: 'AAAA2CH/A', dimensionColor: 'silver', imageKey: 'silver-image' }],
    displayValues: { dimensionColor: { skyblue: '天蓝色', silver: '银色' } },
    imageDictionary: { 'blue-image': descriptor('blue-image'), 'silver-image': descriptor('silver-image', silverUrl) } };
  const html = `<title>MacBook Air - Apple</title><script>window.PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: ${JSON.stringify(data)} };</script>`;
  const parsed = parseBuyPage(html, { category: 'mac', familyKey: 'macbook-air', familySlug: 'macbook-air', sourceUrl });
  const byPart = new Map(parsed.products.map(p => [p.partNumber, p]));
  assert.equal(byPart.get('AAAA1CH/A').imageUrl, imageUrl);
  assert.equal(byPart.get('AAAA2CH/A').imageUrl, silverUrl);
  assert.equal(byPart.get('AAAA1CH/A').imageKey, 'blue-image');
  assert.equal(byPart.get('AAAA2CH/A').imageKey, 'silver-image');
  assert.equal(imageFromDescriptor(descriptor()).imageWidth, 5120);
  assert.equal(imageFromDescriptor(descriptor('bad', 'https://example.com/fake.jpg')), null);
});

test('configurator images require selected dimensions; cold family collage is not a color fallback', () => {
  const result = imagePlan({ data: {}, gallery: makeGallery(), raw: {}, sourceUrl,
    dimensionValues: { 'chassis-dimensionScreensize': '13inch', 'chassis-dimensionColor': 'skyblue' } });
  assert.equal(result.image, null);
  const query = new URL(result.request.url).searchParams;
  assert.equal(query.get('dm.chassis-dimensionColor'), 'skyblue');
  assert.equal(query.get('dm.chassis-dimensionScreensize'), '13inch');
  assert.equal(query.has('dm'), false);
  assert.equal(query.has('case'), false);
  const unknown = imagePlan({ data: {}, gallery: null, raw: {}, sourceUrl, dimensionValues: { dimensionColor: 'purple' } });
  assert.deepEqual(unknown, { image: null, request: null });
  const noColor = imagePlan({ data: {}, gallery: makeGallery([]), raw: {}, sourceUrl, dimensionValues: { dimensionCapacity: '512gb' } });
  assert.equal(noColor.image.imageSource, 'apple-family-summary');
});

test('iMac adds the fixed standard stand only when both retail container and official enum prove it', () => {
  const args = { gallery: makeGallery(['chassis-dimensionColor', 'chassis-dimensionStandType']),
    raw: { aosContainerPartNumber: 'IMAC_ROC_STAND_PINK_G' }, sourceUrl,
    dimensionValues: { 'chassis-dimensionColor': 'pink' },
    data: { configDisplayValues: { 'chassis-dimensionStandType': { desktop: { header: '支架' } } } } };
  assert.equal(new URL(imagePlan(args).request.url).searchParams.get('dm.chassis-dimensionStandType'), 'desktop');
  assert.equal(new URL(imagePlan({ ...args, raw: {} }).request.url).searchParams.has('dm.chassis-dimensionStandType'), false);
  assert.equal(new URL(imagePlan({ ...args, data: {} }).request.url).searchParams.has('dm.chassis-dimensionStandType'), false);
});

test('gallery resolution deduplicates SKU requests, verifies color and replays cached evidence offline', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gxs-image-test-'));
  try {
    const request = imagePlan({ data: {}, gallery: makeGallery(), raw: {}, sourceUrl,
      dimensionValues: { 'chassis-dimensionScreensize': '13inch', 'chassis-dimensionColor': 'skyblue' } }).request;
    let fetches = 0;
    const fetcher = async () => { fetches++; return { record: { httpStatus: 200, sha256: 'test-sha', finishedAt: '2026-09-15T00:00:00.000Z' },
      text: JSON.stringify({ head: { status: 200 }, body: { summary: [{ asset: { image: descriptor() } }] } }) }; };
    const products = ['AAAA1CH/A', 'AAAA2CH/A'].map(partNumber => ({ partNumber, imageRequest: request }));
    const result = await resolveProductImages(products, { cacheDir, fetcher, intervalMs: 0 });
    assert.equal(fetches, 1);
    assert.deepEqual(result.missing, []);
    assert.equal(products[0].imageUrl, imageUrl);
    assert.equal(products[1].imageUrl, imageUrl);
    const replay = [{ partNumber: 'AAAA1CH/A', imageRequest: request }];
    await resolveProductImages(replay, { cacheDir, offline: true, fetcher });
    assert.equal(fetches, 1);
    assert.equal(replay[0].imageUrl, imageUrl);
    const wrongColor = { ...request, identity: 'new-pink-selection', matchDimensions: { 'chassis-dimensionColor': 'pink' } };
    await assert.rejects(resolveProductImages([{ partNumber: 'AAAA3CH/A', imageRequest: wrongColor }], { cacheDir, fetcher }), /gallery_image_dimension_mismatch/);
    const stale = [{ partNumber: 'AAAA4CH/A', imageUrl, imageAlt: 'old color', imageRequest: { ...request, identity: 'uncached-selection' } }];
    assert.deepEqual((await resolveProductImages(stale, { cacheDir, offline: true })).missing, ['AAAA4CH/A']);
    assert.equal(stale[0].imageUrl, undefined);
    assert.equal(stale[0].imageUnavailableReason, 'gallery_not_cached');
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('catalog API forwards image fields and changes cache version when images are added', () => {
  const built = catalogService.buildFromBundled();
  assert.equal(built.meta.imagesGeneratedAt, catalog.imagesGeneratedAt);
  assert.ok(built.meta.version.endsWith(`|${catalog.imagesGeneratedAt}`));
  for (const p of catalog.products) {
    const doc = built.products.find(row => row.partNumber === p.partNumber);
    for (const field of ['imageUrl', 'imageAlt', 'imageSource', 'imageSourceUrl', 'imageWidth', 'imageHeight']) assert.equal(doc[field], p[field]);
  }
});

test('retained HTTP and decode evidence covers every unique URL and every SKU in this catalog', async () => {
  const day = catalog.imagesGeneratedAt.slice(0, 10);
  const report = JSON.parse(await readFile(new URL(`../evidence/catalog/${day}/images.verification.json`, import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL(`../evidence/catalog/${day}/images.manifest.json`, import.meta.url), 'utf8'));
  const unique = new Set(catalog.products.map(p => p.imageUrl));
  assert.equal(report.catalogImagesGeneratedAt, catalog.imagesGeneratedAt);
  assert.equal(report.totalSkus, catalog.products.length);
  assert.equal(report.uniqueImages, unique.size);
  assert.equal(report.validHttpImages, unique.size);
  assert.equal(report.decodeVerified, true);
  assert.deepEqual(new Set(report.entries.map(e => e.imageUrl)), unique);
  assert.deepEqual(new Set(report.entries.flatMap(e => e.products.map(p => p.partNumber))), new Set(catalog.products.map(p => p.partNumber)));
  for (const entry of report.entries) {
    assert.equal(entry.record.httpStatus, 200);
    assert.match(entry.record.headers['content-type'], /^image\//);
    assert.match(entry.record.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.decoded.width > 0 && entry.decoded.height > 0);
    assert.equal(entry.decodeError, undefined);
  }
  assert.equal(manifest.generatedAt, catalog.imagesGeneratedAt);
  assert.equal(manifest.mapped, catalog.products.length);
  assert.ok(manifest.galleries.every(g => g.matched && g.httpStatus === 200));
  assert.deepEqual(new Set(manifest.sources.map(s => s.familyKey)), new Set(catalog.families.map(f => f.familyKey)));
});
