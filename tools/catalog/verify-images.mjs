#!/usr/bin/env node
// Fetch each unique official image once, retaining its bytes and HTTP/hash
// evidence. Full decode verification is done by verify-image-decode.py.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boundedGet, sleep } from './lib/http.mjs';
import { isOfficialImageUrl } from './lib/product-images.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalog = JSON.parse(await readFile(resolve(root, 'catalog/products.json'), 'utf8'));
const day = catalog.imagesGeneratedAt.slice(0, 10);
const outDir = resolve(root, 'evidence/raw', day, 'image-files');
const reportDir = resolve(root, 'evidence/catalog', day);
await mkdir(outDir, { recursive: true });
await mkdir(reportDir, { recursive: true });
const byUrl = new Map();
for (const p of catalog.products) {
  if (!isOfficialImageUrl(p.imageUrl)) throw new Error(`invalid_image_url:${p.partNumber}`);
  const entry = byUrl.get(p.imageUrl) || { imageUrl: p.imageUrl, imageKey: p.imageKey, alt: p.imageAlt, products: [] };
  entry.products.push({ partNumber: p.partNumber, familyKey: p.familyKey, title: p.title, color: p.attributes.color || null });
  byUrl.set(p.imageUrl, entry);
}
const entries = [...byUrl.values()];
let cursor = 0; let stopped = false; let completed = 0;
async function worker() {
  while (cursor < entries.length && !stopped) {
    const index = cursor++; const entry = entries[index];
    const key = createHash('sha256').update(entry.imageUrl).digest('hex').slice(0, 20);
    const recordFile = resolve(outDir, `${key}.json`);
    let saved;
    try { saved = JSON.parse(await readFile(recordFile, 'utf8')); } catch {}
    if (saved && saved.record.httpStatus === 200) {
      const bytes = await readFile(resolve(outDir, saved.assetFile));
      if (createHash('sha256').update(bytes).digest('hex') !== saved.record.sha256) throw new Error(`cached_image_hash_mismatch:${key}`);
      // Cache only the downloaded bytes/HTTP proof. SKU membership and labels
      // belong to the current catalog and may have changed since that download.
      entry.assetFile = saved.assetFile; entry.record = saved.record; completed++; continue;
    }
    const result = await boundedGet(entry.imageUrl, { accept: 'image/png,image/jpeg,image/webp', timeoutMs: 15000 });
    const type = result.record.headers && result.record.headers['content-type'] || '';
    const ext = /^image\/png/i.test(type) ? 'png' : /^image\/jpe?g/i.test(type) ? 'jpg' : /^image\/webp/i.test(type) ? 'webp' : null;
    if ([403, 429, 541].includes(result.record.httpStatus)) stopped = true;
    if (result.record.httpStatus !== 200 || !ext || !result.body.length) {
      entry.error = 'not_successful_image'; entry.record = result.record;
    } else {
      entry.assetFile = `${key}.${ext}`; entry.record = result.record;
      await writeFile(resolve(outDir, entry.assetFile), result.body);
      await writeFile(recordFile, JSON.stringify(entry, null, 2) + '\n');
    }
    completed++;
    if (completed % 10 === 0 || entry.error) console.log(JSON.stringify({ completed, total: entries.length, last: entry.imageKey, status: result.record.httpStatus, bytes: result.body.length, error: entry.error || null }));
    await sleep(150);
  }
}
await Promise.all([worker(), worker(), worker()]);
const report = { checkedAt: new Date().toISOString(), catalogImagesGeneratedAt: catalog.imagesGeneratedAt, totalSkus: catalog.products.length,
  assetDirectory: `evidence/raw/${day}/image-files`,
  uniqueImages: entries.length, checked: completed, stopped, totalBytes: entries.reduce((n, e) => n + (e.record && e.record.bytes || 0), 0),
  validHttpImages: entries.filter(e => e.assetFile && !e.error).length, decodeVerified: false, entries };
await writeFile(resolve(reportDir, 'images.verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, entries: undefined }));
if (report.validHttpImages !== entries.length) process.exitCode = 1;
