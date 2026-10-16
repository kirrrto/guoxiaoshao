// Build catalog/products.json from the buy pages listed in tools/catalog/families.json.
// One bounded GET per included family, spaced ~2s apart. Raw pages go to the
// git-ignored evidence/raw/<day>/ directory; the tracked manifest keeps hashes.
// Usage: node tools/catalog/fetch-products.mjs [--only familyKey,familyKey] [--offline YYYY-MM-DD]
//   --offline reuses evidence/raw/<day>/*.html instead of requesting Apple again.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedGet, sleep } from './lib/http.mjs';
import { parseBuyPage } from './lib/parse-buy-page.mjs';
import { resolveProductImages } from './lib/resolve-images.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const offlineArg = process.argv.indexOf('--offline');
const offlineDay = offlineArg >= 0 ? process.argv[offlineArg + 1] : null;
const day = offlineDay ?? new Date().toISOString().slice(0, 10);
const evidenceDir = resolve(root, 'evidence', 'catalog', day);
const rawDir = resolve(root, 'evidence', 'raw', day);
const previousManifest = offlineDay
  ? JSON.parse(await readFile(resolve(evidenceDir, 'products.manifest.json'), 'utf8'))
  : null;
await mkdir(evidenceDir, { recursive: true });
await mkdir(rawDir, { recursive: true });
await mkdir(resolve(root, 'catalog'), { recursive: true });

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
const config = JSON.parse(await readFile(resolve(root, 'tools', 'catalog', 'families.json'), 'utf8'));
const families = config.families.filter(family => family.include && (!only || only.has(family.familyKey)));

const manifest = [];
const familyResults = [];
const products = [];
let stopped = false;
for (const [index, family] of families.entries()) {
  const rawFile = `${family.familyKey}.html`;
  let record;
  let text;
  if (offlineDay) {
    const previous = previousManifest.entries.find(entry => entry.familyKey === family.familyKey);
    if (!previous) {
      console.log(JSON.stringify({ family: family.familyKey, skipped: 'no_raw_capture' }));
      continue;
    }
    record = { ...previous.record, replayedFrom: `evidence/raw/${day}/${rawFile}` };
    text = record.httpStatus === 200 ? await readFile(resolve(rawDir, rawFile), 'utf8') : '';
  } else {
    if (index > 0) await sleep(2000);
    const fetched = await boundedGet(family.url, { accept: 'text/html' });
    record = fetched.record;
    text = fetched.text;
    await writeFile(resolve(rawDir, rawFile), fetched.body);
  }
  const entry = { familyKey: family.familyKey, category: family.category, rawFile, record };
  if (record.httpStatus !== 200) {
    entry.parse = { supported: false, reason: `http_${record.httpStatus ?? 'error'}` };
    manifest.push(entry);
    familyResults.push({ ...family, supported: false, reason: entry.parse.reason, productCount: 0 });
    console.log(JSON.stringify({ family: family.familyKey, status: record.httpStatus, error: record.error ?? null }));
    if ([403, 429, 541].includes(record.httpStatus)) {
      console.log('Access/rate-limit response; stopping without retry.');
      stopped = true;
      break;
    }
    continue;
  }
  const parsed = parseBuyPage(text, {
    category: family.category, familyKey: family.familyKey, familySlug: family.url.split('/').pop(), sourceUrl: family.url, displayName: family.displayName,
  });
  entry.parse = { supported: parsed.supported, reason: parsed.reason, layout: parsed.layout, pageTitle: parsed.pageTitle, dimensions: parsed.dimensions, productCount: parsed.products.length, rejected: parsed.rejected };
  manifest.push(entry);
  familyResults.push({
    ...family, supported: parsed.supported, reason: parsed.reason, layout: parsed.layout, pageTitle: parsed.pageTitle,
    dimensions: parsed.dimensions, productCount: parsed.products.length, ctoOnlyBases: parsed.rejected.filter(r => r.reason === 'cto_only_base').length,
    models: [...new Set(parsed.products.map(product => product.model))],
    fetchedAt: record.finishedAt, sha256: record.sha256,
  });
  products.push(...parsed.products);
  console.log(JSON.stringify({ family: family.familyKey, status: record.httpStatus, supported: parsed.supported, reason: parsed.reason, products: parsed.products.length, models: [...new Set(parsed.products.map(p => p.model))] }));
}

const duplicates = products.map(p => p.partNumber).filter((part, i, all) => all.indexOf(part) !== i);
if (duplicates.length) throw new Error(`Duplicate part numbers across families: ${[...new Set(duplicates)].join(', ')}`);
const images = await resolveProductImages(products, { cacheDir: resolve(rawDir, 'image-galleries'), offline: Boolean(offlineDay),
  onProgress: entry => console.log(JSON.stringify({ imageGallery: entry.identity, matched: entry.matched, status: entry.httpStatus })) });

const excluded = config.families.filter(family => !family.include).map(({ category, familyKey, displayName, url, excludeReason }) => ({ category, familyKey, displayName, url, excludeReason }));
const catalog = {
  schemaVersion: 1,
  kind: 'apple-standard-sku-catalog-cn',
  generatedAt: new Date().toISOString(),
  imagesGeneratedAt: new Date().toISOString(),
  imageCount: products.filter(p => p.imageUrl).length,
  note: '中国大陆官网在售的标准配置零售 SKU（…CH/A）。不含定制 Mac、镌刻与其他个性化组合。是否支持门店取货监测以抽样验证结果为准，见 pickupVerification 字段。',
  families: familyResults,
  excludedFamilies: excluded,
  count: products.length,
  products,
};
if (!only && !stopped) {
  await writeFile(resolve(root, 'catalog', 'products.json'), JSON.stringify(catalog, null, 2) + '\n');
} else {
  await writeFile(resolve(evidenceDir, `products.partial.${Date.now()}.json`), JSON.stringify(catalog, null, 2) + '\n');
}
await writeFile(resolve(evidenceDir, offlineDay ? 'products.manifest.replay.json' : 'products.manifest.json'), JSON.stringify({ generatedAt: catalog.generatedAt, stopped, offlineReplay: Boolean(offlineDay), entries: manifest, images }, null, 2) + '\n');
console.log(JSON.stringify({ ok: !stopped, families: familyResults.length, supported: familyResults.filter(f => f.supported).length, products: products.length }));
