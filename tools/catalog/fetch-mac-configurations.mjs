#!/usr/bin/env node
// Resolve every permitted Mac Studio hardware candidate, without cart/account
// calls. This writes evidence only; a complete validated capture can be imported.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedGet, sleep } from './lib/http.mjs';
import { configurationRequestUrl, parseExactMacConfiguration, configurationIdentity, responseHash } from './lib/mac-cto-configurations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const day = arg('--day') || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('invalid_evidence_day');
const dir = resolve(root, 'evidence/catalog', day);
const rawDir = resolve(root, 'evidence/raw', day, 'mac-studio-configurations');
const source = JSON.parse(await readFile(resolve(dir, 'mac-studio-cto-research.json'), 'utf8'));
const outFile = resolve(dir, 'mac-studio-configurations.json');
await mkdir(rawDir, { recursive: true });
let previous = null;
try { previous = JSON.parse(await readFile(outFile, 'utf8')); } catch {}
const cached = [...(source.configurationResponses || []), source.selectedConfigurationSample,
  ...(previous?.configurations || [])].filter(Boolean);
const candidates = source.compatibility.flatMap(chip => chip.memory.flatMap(memory => chip.storage.map(storage => ({ chip: chip.chip, memory, storage }))));
if (candidates.length > 64 || new Set(candidates.map(configurationIdentity)).size !== candidates.length) throw Error('invalid_cto_candidate_set');
const report = { schemaVersion: 1, familyKey: 'mac-studio', checkedAt: new Date().toISOString(), collection: 'MACSTUDIO_2026_COLLECTION',
  sourceUrl: source.sourceUrl, candidateCount: candidates.length, complete: false, networkRequestCount: 0, cachedCount: 0, configurations: [], errors: [] };
for (const expected of candidates) {
  const identity = configurationIdentity(expected);
  let capture;
  for (const saved of cached) {
    if (saved.request?.httpStatus !== 200) continue;
    try { parseExactMacConfiguration(saved.response, expected); capture = saved; break; } catch {}
  }
  if (!capture) {
    if (args.includes('--offline')) { report.errors.push({ identity, reason: 'configuration_not_captured' }); break; }
    await sleep(2000);
    const result = await boundedGet(configurationRequestUrl(report.collection, expected));
    report.networkRequestCount++;
    await writeFile(resolve(rawDir, identity + '.json'), result.body);
    // boundedGet records no request cookies, authorization or account tokens.
    capture = { request: result.record, sourceFile: `evidence/raw/${day}/mac-studio-configurations/${identity}.json` };
    if (result.record.httpStatus === 200) {
      try { capture.response = JSON.parse(result.text); } catch {}
    }
    if (result.record.httpStatus !== 200) {
      report.errors.push({ identity, reason: 'configuration_http_error', request: result.record });
      break; // No retries, endpoint switching or replacement identities.
    }
  } else report.cachedCount++;
  try {
    const exact = parseExactMacConfiguration(capture.response, expected);
    report.configurations.push({ expected, exact, sourceFile: capture.sourceFile,
      request: capture.request, response: capture.response, canonicalResponseSha256: responseHash(JSON.stringify(capture.response)) });
    console.log(JSON.stringify({ completed: report.configurations.length, total: candidates.length, identity, retailPartNumber: exact.retailPartNumber, cached: report.networkRequestCount === 0 }));
  } catch (error) { report.errors.push({ identity, reason: error.message, request: capture.request }); break; }
  await writeFile(outFile, JSON.stringify(report, null, 2) + '\n');
}
report.complete = report.errors.length === 0 && report.configurations.length === candidates.length;
report.checkedAt = new Date().toISOString();
await writeFile(outFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, configurations: undefined }));
if (!report.complete) process.exitCode = 1;
