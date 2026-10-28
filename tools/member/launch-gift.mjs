import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createOfflineLaunchGiftRepo } from '../lib/launch-gift-offline-repo.mjs';
const require = createRequire(import.meta.url);
const { scanLaunchGiftManifest, runLaunchGiftBatch } = require('../../cloudfunctions/gxs_api/lib/services/launch-gift-task');
const { SUGGESTED_CUTOFF_EXCLUSIVE } = require('../../cloudfunctions/gxs_api/lib/rules/launch-gift');
const usage = `Local-only V3.4.3 launch gift rehearsal (no network; default dry-run)
node tools/member/launch-gift.mjs --input frozen-export.json --out output/launch-gift [options]
  --cutoff ISO       Exclusive payment cutoff; default 2026-10-28T16:00:00.000Z is a proposal
  --now ISO          Actual execution/rehearsal time (default current clock)
  --page-size 1..100 Stable order-scan page size (default 100)
  --max-pages N     Limit scan pages this invocation; --resume continues
  --max-accounts N  Limit account processing, 1..100 (default 20)
  --resume          Resume same source/manifest and checkpoint
  --apply-local     Mutate only output/local-state.json; requires explicit --cutoff
Export: { metadata:{environmentId,snapshotAt,ordersComplete:true}, collections:{gxs_users:[],gxs_orders:[],gxs_config:[]} }
Private manifests/checkpoints contain account IDs. Only report.json is redacted.
No production apply mode exists. Keep input exports outside Git.`;
if (process.argv.includes('--help')) { console.log(usage); process.exit(0); }
const args = {};
const flags = new Set(['--resume', '--apply-local']);
const values = new Set(['--input', '--out', '--cutoff', '--now', '--page-size', '--max-pages', '--max-accounts']);
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (flags.has(key)) args[key] = true;
  else if (values.has(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[key] = process.argv[++i];
  else throw new Error(`unknown_or_missing_argument:${key}`);
}
if (!args['--input'] || !args['--out'] || args['--apply-local'] && !args['--cutoff']) throw new Error(usage);
const input = path.resolve(args['--input']), out = path.resolve(args['--out']);
if (input === path.join(out, 'local-state.json')) throw new Error('input_must_remain_immutable');
const text = await fs.readFile(input, 'utf8'), source = JSON.parse(text);
const fingerprint = createHash('sha256').update(text).digest('hex');
if (!source.metadata?.environmentId || !source.metadata?.snapshotAt || source.metadata.ordersComplete !== true) throw new Error('complete_frozen_export_required');
await fs.mkdir(out, { recursive: true });
const read = async name => { try { return JSON.parse(await fs.readFile(path.join(out, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const write = async (name, value) => {
  const target = path.join(out, name), temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
};
const dryRun = !args['--apply-local'];
const cutoffExclusive = args['--cutoff'] || SUGGESTED_CUTOFF_EXCLUSIVE;
const session = { fingerprint, environmentId: source.metadata.environmentId, snapshotAt: source.metadata.snapshotAt, cutoffExclusive, dryRun };
const prior = await read('session.json');
if (prior && (!args['--resume'] || JSON.stringify(prior) !== JSON.stringify(session))) throw new Error('output_already_exists_or_resume_boundary_changed');
if (!prior) await write('session.json', session);
const savedState = args['--resume'] && !dryRun ? await read('local-state.json') : null;
const repo = createOfflineLaunchGiftRepo(savedState || source, { onCommit: value => write('local-state.json', value) });
const scan = await scanLaunchGiftManifest(repo, { ...session, cutoffConfirmed: Boolean(args['--cutoff']), sourceFingerprint: fingerprint,
  pageSize: Number(args['--page-size'] || 100), maxPages: args['--max-pages'] ? Number(args['--max-pages']) : Infinity,
  checkpoint: args['--resume'] ? await read('scan-checkpoint.json') : null, onCheckpoint: value => write('scan-checkpoint.json', value) });
await write('scan-checkpoint.json', scan.checkpoint);
if (!scan.manifest) {
  console.log(JSON.stringify({ localOnly: true, dryRun, scanComplete: false, scannedOrders: scan.checkpoint.scannedOrders, resumeRequired: true }));
} else {
  await write('manifest.json', scan.manifest);
  const batch = await runLaunchGiftBatch(repo, scan.manifest, { dryRun, expectedEnvironmentId: session.environmentId,
    nowIso: args['--now'] || new Date().toISOString(), maxAccounts: Number(args['--max-accounts'] || 20),
    checkpoint: args['--resume'] ? await read('batch-checkpoint.json') : null, onCheckpoint: value => write('batch-checkpoint.json', value) });
  await write('batch-checkpoint.json', batch.checkpoint);
  await write('report.json', { localOnly: true, productionGrants: 0, ...batch.report });
  console.log(JSON.stringify({ localOnly: true, productionGrants: 0, dryRun, processingComplete: batch.report.processingComplete,
    distribution: batch.report.distribution, reconciliation: batch.report.reconciliation, report: path.join(out, 'report.json') }));
}
