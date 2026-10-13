// Sample the pickup endpoint for each catalog family: one SKU per family,
// batched per category into a single store request. Records Apple's own
// product titles and marks families as pickup-verified in catalog/products.json.
// Bounded: ≤ 8 requests, ~2s apart, no retries. Stops on 403/429/541.
// Usage: node tools/catalog/sample-pickup.mjs [--store R577] [--max-parts 6] [--replay YYYY-MM-DD]
//   --replay re-parses the saved response bodies of that day instead of requesting Apple again.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sleep } from './lib/http.mjs';

const require = createRequire(import.meta.url);
const { fetchPickup, parseApplePickup } = require('../../cloudfunctions/gxs_api/lib/apple-pickup.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argValue = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
const storeNumber = argValue('--store', 'R577');
const maxParts = Number(argValue('--max-parts', '6'));
const replayDay = argValue('--replay', null);
const day = replayDay ?? new Date().toISOString().slice(0, 10);
const evidenceDir = resolve(root, 'evidence', 'pickup-samples', day);
await mkdir(evidenceDir, { recursive: true });
const replay = replayDay ? JSON.parse(await readFile(resolve(evidenceDir, 'samples.json'), 'utf8')) : null;

const catalogPath = resolve(root, 'catalog', 'products.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const stores = JSON.parse(await readFile(resolve(root, 'catalog', 'stores.json'), 'utf8')).stores;
const store = stores.find(s => s.storeNumber === storeNumber);
if (!store) throw new Error(`Unknown store ${storeNumber}`);

// One representative SKU per family (skip coming-soon SKUs, which cannot be picked up yet).
const picks = [];
for (const family of catalog.families.filter(f => f.supported)) {
  const candidates = catalog.products.filter(p => p.familyKey === family.familyKey && !p.comingSoon);
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
for (const [category, list] of batches) {
  for (let i = 0; i < list.length; i += maxParts) requests.push({ category, picks: list.slice(i, i + maxParts) });
}

const results = [];
let stopped = false;
for (const [index, request] of requests.entries()) {
  const partNumbers = request.picks.map(p => p.product.partNumber);
  let record;
  let observations;
  let bodyText = null;
  if (replay) {
    const previous = replay.results.find(r => r.category === request.category && r.record.partNumbers.join() === partNumbers.join());
    if (!previous) {
      console.log(JSON.stringify({ category: request.category, skipped: 'no_saved_response' }));
      continue;
    }
    record = { ...previous.record, replayed: true };
    bodyText = previous.record.bodyFile ? await readFile(resolve(evidenceDir, previous.record.bodyFile), 'utf8') : null;
    const targets = partNumbers.map(partNumber => ({ storeNumber, partNumber }));
    observations = parseApplePickup({ httpStatus: record.httpStatus, body: bodyText, targets, observedAt: record.finishedAt });
  } else {
    if (index > 0) await sleep(2000);
    ({ record, observations, bodyText } = await fetchPickup({ storeNumber, partNumbers, timeoutMs: 15000 }));
    const bodyFile = `pickup-${request.category}-${index}.body.json`;
    if (bodyText) await writeFile(resolve(evidenceDir, bodyFile), bodyText);
    record = { ...record, bodyFile: bodyText ? bodyFile : null };
  }
  results.push({ category: request.category, record, observations });
  console.log(JSON.stringify({ category: request.category, status: record.httpStatus, elapsedMs: record.elapsedMs, observations: observations.map(o => ({ part: o.partNumber, status: o.status, title: o.productTitle, reason: o.reason?.code ?? null })) }));
  if ([403, 429, 541].includes(record.httpStatus)) {
    console.log('Access/rate-limit response; stopping without retry.');
    stopped = true;
    break;
  }
}

// Fold verification results back into the catalog. A family is pickup-verified
// when its sampled SKU produced a recognised status (available/unavailable/ineligible).
const byPart = new Map();
for (const result of results) for (const observation of result.observations) byPart.set(observation.partNumber, observation);
for (const family of catalog.families) {
  const pick = picks.find(p => p.family.familyKey === family.familyKey);
  const observation = pick?.product ? byPart.get(pick.product.partNumber) : null;
  family.pickupVerification = {
    checkedAt: new Date().toISOString(),
    storeNumber,
    sampledPartNumber: pick?.product?.partNumber ?? null,
    status: observation ? observation.status : (pick?.skipped ?? 'not_sampled'),
    reason: observation?.reason?.code ?? null,
    verified: Boolean(observation && observation.status !== 'unknown'),
  };
}
for (const product of catalog.products) {
  const observation = byPart.get(product.partNumber);
  if (observation && observation.productTitle) {
    product.upstreamTitle = observation.productTitle;
    product.upstreamTitleCheckedAt = observation.observedAt;
  }
}
catalog.pickupVerification = { day, storeNumber, storeName: store.name, requests: results.length, stopped, note: '每个系列抽样 1 个 SKU，验证取货接口是否识别该 SKU；结果只说明接口可查询，不代表当前供货情况长期有效。pending 表示上游提示尚未开放取货。' };
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
await writeFile(resolve(evidenceDir, replay ? 'samples.replay.json' : 'samples.json'), JSON.stringify({ storeNumber, store: store.name, replayed: Boolean(replay), results, picks: picks.map(p => ({ family: p.family.familyKey, part: p.product?.partNumber ?? null, skipped: p.skipped ?? null })) }, null, 2) + '\n');
console.log(JSON.stringify({ ok: !stopped, requests: results.length, verifiedFamilies: catalog.families.filter(f => f.pickupVerification?.verified).length, totalSupportedFamilies: catalog.families.filter(f => f.supported).length }));
