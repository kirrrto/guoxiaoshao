/** Explicitly scoped inventory migration runner. Defaults to a read-only dry run. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { MIGRATION_LEASE_ID } = require('../../cloudfunctions/gxs_api/lib/repo/observation-storage.js');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runInventoryMigration({ repo, targetKeys, envId, action = 'migrate', dryRun = true, checkpoint = null,
  onCheckpoint = async () => {}, clock = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), delayMs = 25 }) {
  if (!envId || !Array.isArray(targetKeys) || !targetKeys.length || targetKeys.length > 10000
      || targetKeys.some(id => typeof id !== 'string' || !/^R\d{3}\|[A-Z0-9]{5}CH\/A$/.test(id))
      || !['migrate', 'rollback', 'archive'].includes(action) || !Number.isFinite(delayMs) || delayMs < 0) throw Error('Explicit environment, 1-10000 target IDs, valid action and delay are required');
  const targets = [...new Set(targetKeys)].sort();
  const identity = { envId, action, dryRun, targetsHash: digest(targets) };
  if (checkpoint && (checkpoint.schemaVersion !== 1 || Object.keys(identity).some(key => checkpoint[key] !== identity[key]))) throw Error('Checkpoint belongs to another environment, action, mode or target set');
  const state = checkpoint ? structuredClone(checkpoint) : { schemaVersion: 1, ...identity, cursor: null, results: [], completed: false };
  if (!Array.isArray(state.results) || (state.cursor ? !targets.includes(state.cursor) || state.results.length !== targets.indexOf(state.cursor) + 1 : state.results.length !== 0)
      || state.results.some((row, index) => row.targetKey !== targets[index])) throw Error('Invalid checkpoint');
  const ownerId = `inventory-migration-${randomUUID()}`;
  for (const targetKey of targets) {
    if (state.cursor && targetKey <= state.cursor) continue;
    const now = clock(), nowIso = now.toISOString();
    if (!dryRun) {
      const lease = await repo.acquireLease({ id: MIGRATION_LEASE_ID, ownerId, now: nowIso, expiresAt: new Date(now.getTime() + 30000).toISOString() });
      if (!lease.acquired) throw Error('Another inventory migration holds the lease');
    }
    let result;
    try { result = await repo.transitionObservationStorage({ targetKey, action, dryRun, nowIso: clock().toISOString(), migrationLease: dryRun ? undefined : { ownerId } }); }
    finally { if (!dryRun) await repo.releaseLease({ id: MIGRATION_LEASE_ID, ownerId }); }
    state.results.push(result); state.cursor = targetKey; state.updatedAt = nowIso;
    await onCheckpoint(structuredClone(state));
    if (delayMs) await sleep(delayMs);
  }
  state.completed = true; state.finishedAt = clock().toISOString();
  state.counts = state.results.reduce((counts, result) => ({ ...counts, [result.status]: (counts[result.status] || 0) + 1 }), {});
  state.productionWrites = !dryRun && envId !== 'offline';
  await onCheckpoint(structuredClone(state));
  return state;
}

const HELP = `Inventory daily-summary migration (no collection deletion or upstream collection).

Offline default dry-run:
  node tools/db/observation-storage.mjs --snapshot snapshot.json --targets targets.json --out report.json
Offline apply / rollback rehearsal:
  node tools/db/observation-storage.mjs --snapshot snapshot.json --targets targets.json --env offline --apply --action migrate --out report.json --state-out migrated.json
  node tools/db/observation-storage.mjs --snapshot migrated.json --targets targets.json --env offline --apply --action rollback --out rollback.json --state-out rolled-back.json
Explicit remote dry-run / separately authorized application:
  node tools/db/observation-storage.mjs --env ENV_ID --region REGION --targets targets.json --out report.json
  node tools/db/observation-storage.mjs --env ENV_ID --region REGION --targets targets.json --apply --readiness reviewed.json --out report.json

Options: --action migrate|rollback|archive (default migrate); --resume checkpoint.json;
--checkpoint FILE (default OUT.checkpoint.json); --delay-ms 25 (between targets).
Snapshot: object mapping collection names to complete document arrays. Target file:
explicit frozen JSON array of Rxxx|SKU IDs, never inferred from active follows.
Remote apply requires reviewed readiness JSON with matching envId and nonempty
evidence references for compatibleApi, compatibleMonitor, compatibleRunner,
oldWritersDrained, serverTransactions, indexes and backup. Offline apply requires
--state-out distinct from the input; resume using the last saved state snapshot.
This command does not deploy compatible writers, collect live stock or send notifications.`;

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, file);
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log(HELP); return; }
  const allowed = new Set(['--snapshot', '--targets', '--env', '--region', '--apply', '--action', '--out', '--state-out', '--readiness', '--resume', '--checkpoint', '--delay-ms']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || Object.hasOwn(options, key)) throw Error(`Unknown/duplicate option: ${key}`);
    if (key === '--apply') options[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value: ${key}`); options[key] = args[++i]; }
  }
  if (!options['--targets'] || !options['--out']) throw Error('Both --targets and --out are required. Use --help.');
  const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const checkpointPath = options['--checkpoint'] || `${options['--out']}.checkpoint.json`;
  const outputs = [options['--out'], options['--state-out'], checkpointPath].filter(Boolean).map(canonical);
  if (new Set(outputs).size !== outputs.length) throw Error('Report, checkpoint and state output paths must be distinct');
  for (const key of ['--snapshot', '--targets', '--readiness', '--resume']) if (options[key]) {
    const input = canonical(options[key]);
    if (outputs.some(output => output === input && !(key === '--resume' && output === canonical(checkpointPath)))) throw Error('An output path would overwrite an input file');
  }
  const offline = Boolean(options['--snapshot']), dryRun = !options['--apply'];
  const envId = options['--env'] || (offline && dryRun ? 'offline' : null);
  if (!envId || (offline && envId !== 'offline') || (!offline && (envId === 'offline' || !options['--region']))) throw Error('Provide an explicit target environment/region; offline apply requires --env offline');
  if (offline && !dryRun && (!options['--state-out'] || path.resolve(options['--state-out']) === path.resolve(options['--snapshot']))) throw Error('Offline apply requires a separate --state-out file');
  if (!offline && !dryRun) {
    if (!options['--readiness']) throw Error('Remote apply requires reviewed --readiness evidence and separate production authorization');
    const readiness = JSON.parse(await fs.readFile(options['--readiness'], 'utf8'));
    if (readiness.envId !== envId || ['compatibleApi', 'compatibleMonitor', 'compatibleRunner', 'oldWritersDrained', 'serverTransactions', 'indexes', 'backup'].some(key => typeof readiness[key] !== 'string' || !readiness[key].trim())) throw Error('Readiness must bind all required evidence references to this environment');
  }
  const targetKeys = JSON.parse(await fs.readFile(options['--targets'], 'utf8'));
  const checkpoint = options['--resume'] ? JSON.parse(await fs.readFile(options['--resume'], 'utf8')) : null;
  let repo, offlineInputHash;
  if (offline) {
    const { createMemoryRepo } = await import('../../tests/helpers/memory-repo.mjs');
    const snapshot = JSON.parse(await fs.readFile(options['--snapshot'], 'utf8'));
    offlineInputHash = digest(snapshot);
    if (checkpoint && checkpoint.offlineStateHash !== offlineInputHash) throw Error('Offline resume requires the saved --state-out snapshot matching the checkpoint hash, not the original input. If state was saved before a failed checkpoint, review that state and start a new idempotent batch without --resume.');
    repo = createMemoryRepo(snapshot);
  } else {
    const sdkRequire = createRequire(new URL('../../cloudfunctions/gxs_api/package.json', import.meta.url));
    const cloud = sdkRequire('wx-server-sdk');
    cloud.init({ env: envId, region: options['--region'], timeout: 8000 });
    const { createCloudbaseRepo } = require('../../cloudfunctions/gxs_api/lib/repo/cloudbase-repo.js');
    repo = createCloudbaseRepo(cloud.database());
  }
  const output = await runInventoryMigration({ repo, targetKeys, envId, dryRun, checkpoint, action: options['--action'] || 'migrate',
    delayMs: options['--delay-ms'] === undefined ? 25 : Number(options['--delay-ms']),
    onCheckpoint: async state => {
      // Save committed offline state before its checkpoint. On an uncertain
      // checkpoint write, replaying the target is safe and never adds samples.
      if (offline) {
        const snapshot = Object.fromEntries([...repo.tables].map(([name, rows]) => [name, [...rows.values()]]));
        if (!dryRun) await atomicJson(options['--state-out'], snapshot);
        state.offlineStateHash = dryRun ? offlineInputHash : digest(snapshot);
      }
      await atomicJson(checkpointPath, state);
    } });
  await atomicJson(options['--out'], output);
  console.log(JSON.stringify({ envId, dryRun, action: output.action, counts: output.counts, productionWrites: output.productionWrites, report: path.resolve(options['--out']) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
