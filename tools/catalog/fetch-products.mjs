// Build catalog/products.json from the buy pages listed in tools/catalog/families.json.
// One bounded GET per family and explicitly linked Mac configuration, spaced
// ~2s apart (at most 48 selected pages per Mac family). Raw pages go to the
// git-ignored evidence/raw/<day>/ directory; the tracked manifest keeps hashes.
// Usage: node tools/catalog/fetch-products.mjs [--only familyKey,familyKey] [--offline YYYY-MM-DD]
//   --offline reuses evidence/raw/<day>/*.html instead of requesting Apple again.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { boundedGet, sleep } from './lib/http.mjs';
import { parseBuyPage } from './lib/parse-buy-page.mjs';
import { resolveProductImages } from './lib/resolve-images.mjs';
import { collectSelectedMacPages, assertMacSkuCoverage } from './lib/selected-mac-pages.mjs';
import { applyMacConfigurationCapture } from './lib/apply-mac-configurations.mjs';
import { retainPrelaunchRestrictions } from './lib/catalog-readiness.mjs';

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
const currentCatalog = JSON.parse(await readFile(resolve(root, 'catalog', 'products.json'), 'utf8'));
const families = config.families.filter(family => family.include && (!only || only.has(family.familyKey)));

const manifest = [];
const familyResults = [];
let products = [];
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
  let parsed = parseBuyPage(text, {
    category: family.category, familyKey: family.familyKey, familySlug: family.url.split('/').pop(), sourceUrl: family.url, displayName: family.displayName,
  });
  entry.selectedPages = [];
  try {
    parsed = await collectSelectedMacPages(text, family, parsed, {
      intervalMs: offlineDay ? 0 : 2000,
      fetcher: async url => {
        const selectedRawFile = `${family.familyKey}.selected.${createHash('sha256').update(url).digest('hex').slice(0, 20)}.html`;
        let result;
        if (offlineDay) {
          const previous = previousManifest.entries.find(item => item.familyKey === family.familyKey)?.selectedPages?.find(item => item.sourceUrl === url);
          if (!previous) throw Error(`selected_mac_page_not_captured:${url}`);
          const body = await readFile(resolve(rawDir, selectedRawFile));
          if (createHash('sha256').update(body).digest('hex') !== previous.record.sha256) throw Error(`selected_mac_capture_hash_mismatch:${url}`);
          result = { record: { ...previous.record, replayedFrom: `evidence/raw/${day}/${selectedRawFile}` }, text: body.toString('utf8') };
        } else {
          result = await boundedGet(url, { accept: 'text/html' });
          await writeFile(resolve(rawDir, selectedRawFile), result.body);
        }
        entry.selectedPages.push({ sourceUrl: url, rawFile: selectedRawFile, record: result.record });
        return result;
      },
    });
  } catch (error) {
    entry.parse = { supported: false, reason: error.message };
    manifest.push(entry);
    stopped = true;
    console.log(JSON.stringify({ family: family.familyKey, stopped: error.message }));
    break;
  }
  entry.parse = { supported: parsed.supported, reason: parsed.reason, layout: parsed.layout, pageTitle: parsed.pageTitle, dimensions: parsed.dimensions, productCount: parsed.products.length, rejected: parsed.rejected };
  manifest.push(entry);
  familyResults.push({
    // Reviewed officialConfigurations lives in families.json. Keep its original
    // checkedAt when refreshing retail SKUs; this fetch does not reverify CTO.
    ...family, supported: parsed.supported, reason: parsed.reason, layout: parsed.layout, pageTitle: parsed.pageTitle,
    dimensions: parsed.dimensions, productCount: parsed.products.length, ctoOnlyBases: parsed.rejected.filter(r => r.reason === 'cto_only_base').length,
    models: [...new Set(parsed.products.map(product => product.model))],
    fetchedAt: record.finishedAt, sha256: record.sha256,
  });
  products.push(...parsed.products);
  console.log(JSON.stringify({ family: family.familyKey, status: record.httpStatus, supported: parsed.supported, reason: parsed.reason, products: parsed.products.length, models: [...new Set(parsed.products.map(p => p.model))] }));
}

products = retainPrelaunchRestrictions(products, currentCatalog.products);

// Exact CTO targets come only from a complete independently resolved capture.
// This root-page refresh retains its original verification time; it does not
// infer configurations from option ranges or perform additional CTO requests.
if (!stopped) for (const family of familyResults.filter(f => f.configurationCapture)) {
  try {
    if (!/^evidence\/catalog\/\d{4}-\d{2}-\d{2}\/mac-studio-configurations\.json$/.test(family.configurationCapture)) throw Error('invalid_configuration_capture_path');
    const capture = JSON.parse(await readFile(resolve(root, family.configurationCapture), 'utf8'));
    const merged = applyMacConfigurationCapture({ families: [family], products: products.filter(p => p.familyKey === family.familyKey) }, capture);
    const index = products.findIndex(p => p.familyKey === family.familyKey);
    products = products.filter(p => p.familyKey !== family.familyKey);
    products.splice(index, 0, ...merged.products);
    Object.assign(family, merged.families[0]);
  } catch (error) {
    manifest.push({ familyKey: family.familyKey, configurationCapture: family.configurationCapture, parse: { supported: false, reason: error.message } });
    stopped = true; console.log(JSON.stringify({ family: family.familyKey, stopped: error.message })); break;
  }
}
const duplicates = products.map(p => p.partNumber).filter((part, i, all) => all.indexOf(part) !== i);
if (duplicates.length) throw new Error(`Duplicate part numbers across families: ${[...new Set(duplicates)].join(', ')}`);
let coverageError = null;
if (!stopped) {
  try { assertMacSkuCoverage(currentCatalog.products, products, families.map(family => family.familyKey)); }
  catch (error) { coverageError = error.message; stopped = true; console.log(JSON.stringify({ stopped: coverageError })); }
}
const images = stopped ? { fetched: 0, evidence: [], missing: [] } : await resolveProductImages(products, { cacheDir: resolve(rawDir, 'image-galleries'), offline: Boolean(offlineDay),
  onProgress: entry => console.log(JSON.stringify({ imageGallery: entry.identity, matched: entry.matched, status: entry.httpStatus })) });

const excluded = config.families.filter(family => !family.include).map(({ category, familyKey, displayName, url, excludeReason }) => ({ category, familyKey, displayName, url, excludeReason }));
const catalog = {
  schemaVersion: 1,
  kind: products.some(product => product.targetType === 'apple_cto') ? 'apple-product-target-catalog-cn' : 'apple-standard-sku-catalog-cn',
  generatedAt: new Date().toISOString(),
  imagesGeneratedAt: new Date().toISOString(),
  imageCount: products.filter(p => p.imageUrl).length,
  note: '中国大陆官网标准零售 SKU 与独立完整采集记录中的精确 Mac Studio 定制配置。定制配置不得从范围列表推断；官网定制 Mac 不支持 Apple Store 店内取货，定制项仅作配置参考，不进入取货查询或自动关注。',
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
await writeFile(resolve(evidenceDir, offlineDay ? 'products.manifest.replay.json' : 'products.manifest.json'), JSON.stringify({ generatedAt: catalog.generatedAt, stopped, coverageError, offlineReplay: Boolean(offlineDay), entries: manifest, images }, null, 2) + '\n');
console.log(JSON.stringify({ ok: !stopped, families: familyResults.length, supported: familyResults.filter(f => f.supported).length, products: products.length }));
if (stopped) process.exitCode = 1;
