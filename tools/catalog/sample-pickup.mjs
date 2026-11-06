// Sample the pickup endpoint for each catalog family: one SKU per family,
// batched per category into a single store request. Records Apple's own
// product titles and marks families as pickup-verified in catalog/products.json.
// Requests are sequential, ~2s apart, without retries. Incomplete results
// remain diagnostic evidence and cannot replace the catalog.
// Usage: node tools/catalog/sample-pickup.mjs [--store R577] [--max-parts 6] [--replay YYYY-MM-DD]
//   --replay re-parses the saved response bodies of that day instead of requesting Apple again.
import { mkdir, mkdtemp, rename, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sleep } from './lib/http.mjs';
import { buildPickupVerification } from './lib/catalog-readiness.mjs';

const require = createRequire(import.meta.url);
const { fetchPickup, parseApplePickup } = require('../../cloudfunctions/gxs_api/lib/apple-pickup.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argValue = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
const maxParts = Number(argValue('--max-parts', '6'));
if (!Number.isInteger(maxParts) || maxParts < 1 || maxParts > 20) throw Error('max-parts must be an integer from 1 to 20');
const replayDay = argValue('--replay', null);
if (replayDay && !/^\d{4}-\d{2}-\d{2}$/.test(replayDay)) throw Error('invalid replay date');
const day = replayDay ?? new Date().toISOString().slice(0, 10);
const evidenceDir = resolve(root, 'evidence', 'pickup-samples', day);
await mkdir(evidenceDir, { recursive: true });
const replay = replayDay ? JSON.parse(await readFile(resolve(evidenceDir, 'samples.json'), 'utf8')) : null;
const storeNumber = argValue('--store', replay?.storeNumber || 'R577');
if (replay && storeNumber !== replay.storeNumber) throw Error('replay store mismatch');
const runDir = !replay ? await mkdtemp(resolve(evidenceDir, 'run-')) : null;

const catalogPath = resolve(root, 'catalog', 'products.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const stores = JSON.parse(await readFile(resolve(root, 'catalog', 'stores.json'), 'utf8')).stores;
const store = stores.find(s => s.storeNumber === storeNumber);
if (!store) throw new Error(`Unknown store ${storeNumber}`);

// One representative SKU per family (skip coming-soon SKUs, which cannot be picked up yet).
const picks = [];
for (const family of catalog.families.filter(f => f.supported && f.pickupVerificationScope !== 'sku')) {
  const candidates = catalog.products.filter(p => p.familyKey === family.familyKey && p.targetType !== 'apple_cto' && !p.comingSoon);
  if (candidates.length) picks.push({ family, product: candidates[0] });
  else picks.push({ family, product: null, skipped: 'all_coming_soon' });
}
const batches = new Map();
for (const pick of picks.filter(p => p.product)) {
  const list = batches.get(pick.family.category) ?? [];
  list.push(pick);
  batches.set(pick.family.category, list);
}
const requests = [];
if (replay) {
  for (const row of replay.results) requests.push({ category: row.category, partNumbers: row.record.partNumbers, previous: row.record });
} else for (const [category, list] of batches) {
  for (let i = 0; i < list.length; i += maxParts) requests.push({ category, partNumbers: list.slice(i, i + maxParts).map(p => p.product.partNumber) });
}

const results = [];
let stopped = false;
for (const [index, request] of requests.entries()) {
  const { partNumbers } = request;
  let record;
  let observations;
  let bodyText = null;
  if (replay) {
    record = { ...request.previous, replayed: true };
    bodyText = record.bodyFile ? await readFile(resolve(evidenceDir, record.bodyFile), 'utf8') : null;
    const targets = partNumbers.map(partNumber => ({ storeNumber, partNumber }));
    observations = parseApplePickup({ httpStatus: record.httpStatus, body: bodyText, targets, observedAt: record.finishedAt });
  } else {
    if (index > 0) await sleep(2000);
    ({ record, observations, bodyText } = await fetchPickup({ storeNumber, partNumbers, timeoutMs: 15000 }));
    const bodyFile = `${basename(runDir)}/pickup-${request.category}-${index}.body.json`;
    if (bodyText) await writeFile(resolve(evidenceDir, bodyFile), bodyText);
    record = { ...record, bodyFile: bodyText ? bodyFile : null };
  }
  results.push({ category: request.category, record, observations });
  console.log(JSON.stringify({ category: request.category, status: record.httpStatus, elapsedMs: record.elapsedMs, observations: observations.map(o => ({ part: o.partNumber, status: o.status, title: o.productTitle, reason: o.reason?.code ?? null })) }));
  if (record.error || record.httpStatus !== 200 || observations.some(o => o.status === 'unknown')) {
    console.log('Incomplete pickup response; stopping without retry or catalog update.');
    stopped = true;
    break;
  }
}

// Fold verification results back into the catalog. A family is pickup-verified
// when its sampled SKU produced a recognised status (available/unavailable/ineligible).
const byPart = new Map();
for (const result of results) for (const observation of result.observations) byPart.set(observation.partNumber, observation);
for (const pick of picks) {
  const family = pick.family;
  const observation = pick.product ? byPart.get(pick.product.partNumber) : null;
  family.pickupVerification = buildPickupVerification({
    observation, storeNumber, sampledPartNumber: pick.product?.partNumber ?? null,
    skipped: pick.skipped ?? 'not_sampled', checkedAt: new Date().toISOString(),
  });
}
for (const product of catalog.products) {
  const observation = byPart.get(product.partNumber);
  if (observation && observation.productTitle) {
    product.upstreamTitle = observation.productTitle;
    product.upstreamTitleCheckedAt = observation.observedAt;
  }
}
catalog.pickupVerification = { day, storeNumber, storeName: store.name, requests: results.length, stopped, note: '每个系列抽样 1 个 SKU，验证取货接口是否识别该 SKU；结果只说明接口可查询，不代表当前供货情况长期有效。pending 表示上游提示尚未开放取货。' };
const complete = requests.length > 0 && !stopped && results.length === requests.length && replay?.complete !== false;
const report = JSON.stringify({ storeNumber, store: store.name, replayed: Boolean(replay), complete, results,
  picks: replay?.picks || picks.map(p => ({ family: p.family.familyKey, part: p.product?.partNumber ?? null, skipped: p.skipped ?? null })) }, null, 2) + '\n';
await writeFile(resolve(runDir || evidenceDir, replay ? 'samples.replay.json' : 'samples.json'), report);
if (!replay && complete) {
  // Publish the index only after its immutable response bodies are complete.
  const indexFile = resolve(runDir, 'index.tmp');
  await writeFile(indexFile, report);
  await rename(indexFile, resolve(evidenceDir, 'samples.json'));
  catalog.generatedAt = new Date().toISOString();
  const pendingCatalog = catalogPath + '.' + basename(runDir) + '.tmp';
  await writeFile(pendingCatalog, JSON.stringify(catalog, null, 2) + '\n');
  await rename(pendingCatalog, catalogPath);
}
console.log(JSON.stringify({ ok: complete, catalogUpdated: !replay && complete, requests: results.length, verifiedFamilies: catalog.families.filter(f => f.pickupVerification?.verified).length, totalSupportedFamilies: catalog.families.filter(f => f.supported).length }));
if (!complete) process.exitCode = 1;
