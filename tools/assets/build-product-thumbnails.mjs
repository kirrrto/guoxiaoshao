#!/usr/bin/env node
// Rebuild exact-SKU display assets from verified original bytes, never guessed CDN renditions.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { boundedGet, sleep } from '../catalog/lib/http.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url), args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const catalog = JSON.parse(await readFile(resolve(root, 'catalog/products.json'), 'utf8'));
const report = JSON.parse(await readFile(resolve(root, `evidence/catalog/${catalog.imagesGeneratedAt.slice(0, 10)}/images.verification.json`), 'utf8'));
const destinations = { manifest: 'evidence/assets/product-thumbnails.manifest.json', mapping: 'miniprogram/config/product-thumbnails.js' };
// A backend catalog/source change must ship together with regenerated, verified
// display assets. Do not synthesize a color/model match from URL substrings.
for (const product of catalog.products) {
  const verified = report.entries.find(entry => entry.imageUrl === product.imageUrl && entry.products.some(item => item.partNumber === product.partNumber));
  if (!verified) throw Error(`catalog_image_not_verified:${product.partNumber}`);
}
if (args.includes('--check')) {
  const manifest = JSON.parse(await readFile(resolve(root, destinations.manifest), 'utf8'));
  const mapping = require(resolve(root, destinations.mapping));
  if (manifest.catalogSha256 !== hash(await readFile(resolve(root, 'catalog/products.json')))) throw Error('thumbnail_catalog_changed');
  if (manifest.mappingSha256 !== hash(await readFile(resolve(root, destinations.mapping)))) throw Error('thumbnail_mapping_changed');
  let totalBytes = 0;
  // Packaged renditions must be phone-decodable: WeChat documents <image webp>
  // for network resources only, and packaged WebP failed in phone previews.
  const signatures = { PNG: ['.png', bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
    JPEG: ['.jpg', bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff] };
  for (const entry of manifest.assets) for (const rendition of entry.renditions) {
    const bytes = await readFile(resolve(root, 'miniprogram', rendition.path.slice(1)));
    const [extension, matches] = signatures[rendition.format] || [];
    if (!matches || !rendition.path.endsWith(extension) || !matches(bytes) || rendition.format !== (rendition.hasTransparency ? 'PNG' : 'JPEG')) throw Error(`unsupported_thumbnail_format:${rendition.path}`);
    if (hash(bytes) !== rendition.sha256 || bytes.length !== rendition.bytes) throw Error(`invalid_thumbnail:${rendition.path}`);
    const poster = rendition.variant === 'poster';
    if (bytes.length > (poster ? 65536 : 12288) || Math.max(rendition.width, rendition.height) > (poster ? 720 : 216)) throw Error(`thumbnail_budget:${rendition.path}`);
    totalBytes += bytes.length;
  }
  if (totalBytes !== manifest.totalBytes || totalBytes > 750000) throw Error('thumbnail_package_budget');
  for (const product of catalog.products) {
    const asset = mapping.assets[mapping.byPart[product.partNumber]];
    if (!asset || asset.source !== product.imageUrl || !asset.card) throw Error(`missing_thumbnail:${product.partNumber}`);
  }
  const packageBytes = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => entry.isDirectory() ? packageBytes(resolve(directory, entry.name)) : (await stat(resolve(directory, entry.name))).size))).reduce((sum, bytes) => sum + bytes, 0);
  const packagedWebp = (await readdir(resolve(root, 'miniprogram'), { recursive: true })).filter(file => /\.webp$/i.test(file));
  if (packagedWebp.length) throw Error(`packaged_webp:${packagedWebp[0]}`);
  const mainPackageRawBytes = await packageBytes(resolve(root, 'miniprogram'));
  if (mainPackageRawBytes >= 2 * 1024 * 1024) throw Error(`main_package_budget:${mainPackageRawBytes}`);
  console.log(JSON.stringify({ checked: manifest.assets.length, skus: Object.keys(mapping.byPart).length, totalBytes, mainPackageRawBytes }));
} else {
  const cache = resolve(root, 'output/product-image-sources');
  await mkdir(cache, { recursive: true });
  const sourceDirs = [value('--source-dir'), resolve(root, report.assetDirectory), cache].filter(Boolean);
  const posterUrls = new Set(require(resolve(root, 'miniprogram/config/product-launches.js')).map(entry => entry.imageUrl).filter(Boolean));
  const entries = [];
  for (const entry of report.entries) {
    let sourcePath;
    for (const dir of sourceDirs) {
      const candidate = resolve(dir, entry.assetFile);
      try { if (hash(await readFile(candidate)) === entry.record.sha256) { sourcePath = candidate; break; } } catch (_) {}
    }
    if (!sourcePath) {
      if (!args.includes('--download')) throw Error(`missing_original:${entry.assetFile}; pass --source-dir or --download`);
      const result = await boundedGet(entry.imageUrl, { accept: 'image/png,image/jpeg,image/webp', timeoutMs: 15000 });
      if (result.record.httpStatus !== 200 || hash(result.body) !== entry.record.sha256) throw Error(`original_not_verified:${entry.imageKey}:${result.record.httpStatus}`);
      sourcePath = resolve(cache, entry.assetFile);
      await writeFile(sourcePath, result.body);
      await writeFile(resolve(cache, entry.assetFile + '.json'), JSON.stringify(result.record, null, 2) + '\n');
      await sleep(150);
    }
    entries.push({ sourcePath, source: entry.imageUrl, sourceSha256: entry.record.sha256, sourceWidth: entry.decoded.width, sourceHeight: entry.decoded.height,
      parts: entry.products.map(product => product.partNumber).sort(), poster: posterUrls.has(entry.imageUrl) });
    if (entries.length % 20 === 0) console.log(`Verified ${entries.length}/${report.entries.length} originals`);
  }
  for (const url of posterUrls) if (!entries.some(entry => entry.source === url)) throw Error('poster_missing_verified_original');
  entries.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
  const planPath = resolve(cache, 'build-plan.json');
  await writeFile(planPath, JSON.stringify({ root, destinations, catalogSha256: hash(await readFile(resolve(root, 'catalog/products.json'))), entries }));
  const python = value('--python') || process.env.PYTHON || 'python';
  const built = spawnSync(python, [resolve(root, 'tools/assets/encode-product-thumbnails.py'), planPath], { stdio: 'inherit', windowsHide: true });
  if (built.error) throw built.error;
  if (built.status !== 0) process.exitCode = built.status || 1;
}
