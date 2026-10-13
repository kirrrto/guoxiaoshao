#!/usr/bin/env node
// Keep the existing SKU/availability verification catalog, adding only images
// from the matching captured official page and its official gallery endpoint.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseBuyPage } from './lib/parse-buy-page.mjs';
import { resolveProductImages } from './lib/resolve-images.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dayArg = process.argv.indexOf('--day');
const day = dayArg >= 0 ? process.argv[dayArg + 1] : new Date().toISOString().slice(0, 10);
const offline = process.argv.includes('--offline');
const file = resolve(root, 'catalog/products.json');
const catalog = JSON.parse(await readFile(file, 'utf8'));
const rawDir = resolve(root, 'evidence/raw', day);
const sourceEvidence = [];
for (const family of catalog.families) {
  const html = await readFile(resolve(rawDir, `${family.familyKey}.html`), 'utf8');
  const parsed = parseBuyPage(html, { category: family.category, familyKey: family.familyKey, familySlug: family.url.split('/').pop(), sourceUrl: family.url, displayName: family.displayName });
  const byPart = new Map(parsed.products.map(p => [p.partNumber, p]));
  for (const product of catalog.products.filter(p => p.familyKey === family.familyKey)) {
    const matched = byPart.get(product.partNumber);
    if (!matched) throw new Error(`captured_page_missing_sku:${product.partNumber}`);
    // A previous catalog image must never hide a newly unresolved SKU mapping.
    for (const key of Object.keys(product)) if (key.startsWith('image')) delete product[key];
    for (const [key, value] of Object.entries(matched)) if (key.startsWith('image')) product[key] = value;
  }
  sourceEvidence.push({ familyKey: family.familyKey, sourceUrl: family.url, rawFile: `evidence/raw/${day}/${family.familyKey}.html`,
    sha256: createHash('sha256').update(html).digest('hex'), count: parsed.products.length });
}
const result = await resolveProductImages(catalog.products, { cacheDir: resolve(rawDir, 'image-galleries'), offline,
  onProgress: e => console.log(JSON.stringify({ gallery: e.identity, status: e.httpStatus, matched: e.matched })) });
if (result.missing.length) throw new Error(`Missing verified image mappings: ${result.missing.join(', ')}`);
catalog.imagesGeneratedAt = new Date().toISOString();
catalog.imageCount = catalog.products.filter(p => p.imageUrl).length;
await writeFile(file, JSON.stringify(catalog, null, 2) + '\n');
const imagesDir = resolve(root, 'evidence/catalog', catalog.imagesGeneratedAt.slice(0, 10));
await mkdir(imagesDir, { recursive: true });
await writeFile(resolve(imagesDir, 'images.manifest.json'), JSON.stringify({ generatedAt: catalog.imagesGeneratedAt,
  products: catalog.products.length, mapped: catalog.imageCount, sources: sourceEvidence, galleries: result.evidence }, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, mapped: catalog.imageCount, total: catalog.products.length, uniqueImages: new Set(catalog.products.map(p => p.imageUrl)).size, networkGalleryRequests: result.fetched }));
