import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryRepo } from './helpers/memory-repo.mjs';
import { runInventoryMigration, main as migrationCli } from '../tools/db/observation-storage.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { MIGRATION_LEASE_ID, selectObservationCoverage } = require('../cloudfunctions/gxs_api/lib/repo/observation-storage');
const PART = 'MXXX1CH/A', KEY = `R577|${PART}`, DAY = '2026-10-28';
const T0 = Date.parse('2026-10-28T15:58:00.000Z');
const iso = ms => new Date(T0 + ms).toISOString();
const obs = (ms, status = 'unavailable', extra = {}) => ({ partNumber: PART, storeNumber: 'R577', status, source: 'auto', observedAt: iso(ms), ...extra });
const record = (repo, ms, status = 'unavailable', extra = {}) => repo.recordObservation({ observation: obs(ms, status, extra), nowIso: iso(ms) });
const coverage = (repo, date = DAY) => repo.getObservationCoverage({ partNumber: PART, storeNumbers: ['R577'], dayKey: date });
const latest = repo => repo.tables.get(C.latest).get(KEY);
const strip = value => { const { observationStorage, ...rest } = value; return rest; };
async function transition(repo, action = 'migrate', targetKey = KEY, at = iso(0), dryRun = false) {
  if (!dryRun) await repo.acquireLease({ id: MIGRATION_LEASE_ID, ownerId: 'migration-test', now: at, expiresAt: new Date(Date.parse(at) + 30000).toISOString() });
  return repo.transitionObservationStorage({ targetKey, action, dryRun, nowIso: at, migrationLease: { ownerId: 'migration-test' } });
}

test('C13 default remains legacy; migration uses the last accepted Beijing day, never execution day or lifetime counts', async () => {
  const repo = createMemoryRepo();
  await record(repo, 0); await record(repo, 1000, 'unknown');
  const before = structuredClone(await coverage(repo));
  assert.equal(latest(repo).observationStorage, undefined);
  const dry = await transition(repo, 'migrate', KEY, iso(5 * 86400000), true);
  assert.equal(dry.baselineDate, DAY); assert.equal(dry.sampleCount, 2); assert.equal(dry.status, 'ready');
  assert.equal(latest(repo).observationStorage, undefined);
  assert.equal((await transition(repo, 'migrate', KEY, iso(5 * 86400000))).status, 'migrated');
  assert.deepEqual(await coverage(repo), before);
  assert.equal((await transition(repo, 'migrate', KEY, iso(5 * 86400000))).status, 'already_migrated');
  for (const mutate of [repo => repo.tables.get(C.observationDays).clear(), repo => { repo.tables.get(C.observationDays).values().next().value.lastObservedAt = iso(-1000); }]) {
    const legacy = createMemoryRepo(); await record(legacy, 0); mutate(legacy);
    assert.equal((await transition(legacy)).status, 'blocked');
    assert.equal(latest(legacy).observationStorage, undefined);
    await record(legacy, 1000);
    assert.equal((await transition(legacy, 'migrate', KEY, iso(1000))).status, 'blocked', 'a later genuine sample cannot launder a missing or contradictory baseline into a complete one');
    assert.equal(latest(legacy).observationStorage.mode, 'legacy');
  }
  const empty = createMemoryRepo();
  assert.equal((await transition(empty)).status, 'waiting_for_first_sample');
  assert.equal(latest(empty), undefined, 'a missing target does not get invented zero-count history');
});

test('inventory migration accepts exact CTO target identities and still rejects malformed keys', async () => {
  const cto = `CTO_${'A'.repeat(64)}`;
  const report = await runInventoryMigration({ repo: createMemoryRepo(), envId: 'offline', dryRun: true,
    targetKeys: [`R577|${cto}`], delayMs: 0 });
  assert.equal(report.counts.waiting_for_first_sample, 1);
  for (const targetKey of [`R577|CTO_${'A'.repeat(63)}`, `R577|${cto}X`, `XX|${cto}`, `R577|${cto}|extra`]) {
    await assert.rejects(runInventoryMigration({ repo: createMemoryRepo(), envId: 'offline', dryRun: true,
      targetKeys: [targetKey], delayMs: 0 }), /Explicit environment/);
  }
});

test('C05-C08 fixed sample replay preserves statuses, confirmation, events, all counts and stopped final days', async () => {
  const legacy = createMemoryRepo(), embedded = createMemoryRepo();
  await record(legacy, 0); await record(embedded, 0); await transition(embedded);
  const input = [[1000, 'available'], [2000, 'available'], [3000, 'unknown'], [4000, 'available'],
    [5000, 'unavailable'], [6000, 'unavailable'], [7000, 'available'], [8000, 'available'],
    [120000, 'unknown'], [121000, 'available'], [122000, 'unavailable']];
  for (const [ms, status] of input) {
    const a = await record(legacy, ms, status, { source: ms % 2000 ? 'auto' : 'manual' });
    const b = await record(embedded, ms, status, { source: ms % 2000 ? 'auto' : 'manual' });
    assert.deepEqual(strip(b.latest), a.latest); assert.deepEqual(b.events, a.events); assert.equal(b.outcome, a.outcome);
    for (const date of [DAY, '2026-10-29']) assert.deepEqual(await coverage(embedded, date), await coverage(legacy, date));
  }
  assert.deepEqual([...embedded.tables.get(C.events).values()], [...legacy.tables.get(C.events).values()]);
  for (const ms of [122000, 121000]) await record(embedded, ms, 'available');
  assert.deepEqual(await coverage(embedded, '2026-10-29'), await coverage(legacy, '2026-10-29'));
  assert.equal(embedded.tables.get(C.observationDays).has(`${KEY}|2026-10-29`), false, 'the final stopped day is still inside latest');
  const before = await coverage(embedded, '2026-10-29');
  await embedded.purgeExpiredData({ firstDay: '2026-12-01', cutoffIso: '2026-11-30T16:00:00.000Z' });
  assert.deepEqual(await coverage(embedded, '2026-10-29'), before, 'retention never deletes current or archived long-term daily totals');
  const archived = await transition(embedded, 'archive', KEY, iso(10 * 86400000));
  assert.equal(archived.status, 'archived'); assert.deepEqual(await coverage(embedded, '2026-10-29'), before);
  assert.equal((await transition(embedded, 'archive', KEY, iso(10 * 86400000))).status, 'already_archived');
});

test('C05 all transaction writes roll back together for migrated state changes, rollover and rollback flush', async () => {
  for (const [ms, status, table] of [[1000, 'available', C.latest], [1000, 'available', C.events], [120000, 'available', C.observationDays]]) {
    const repo = createMemoryRepo(); await record(repo, 0); await transition(repo);
    const before = structuredClone([...repo.tables].map(([k, v]) => [k, [...v]]));
    repo.transactionWriteHook = async name => { if (name === table) throw Error('injected write outage'); };
    await assert.rejects(record(repo, ms, status), /injected/);
    assert.deepEqual([...repo.tables].map(([k, v]) => [k, [...v]]), before);
    repo.transactionWriteHook = null;
    await record(repo, ms, status);
  }
  const repo = createMemoryRepo(); await record(repo, 0); await transition(repo); await record(repo, 1000);
  const before = structuredClone(latest(repo));
  repo.transactionWriteHook = async table => { if (table === C.latest) throw Error('flush mode write outage'); };
  await assert.rejects(transition(repo, 'rollback', KEY, iso(1000)), /flush mode/);
  assert.deepEqual(latest(repo), before);
  assert.equal(repo.tables.get(C.observationDays).get(`${KEY}|${DAY}`).sampleCount, 1, 'failed flush never partially replaces the old archive');
});

test('C09 manual and automatic writers serialize; stale lease cannot write; trusted future repair keeps embedded totals', async () => {
  const repo = createMemoryRepo(); await record(repo, 0); await transition(repo);
  await Promise.all([record(repo, 1000), record(repo, 2000, 'unknown', { source: 'manual' }), record(repo, 2000, 'unknown')]);
  assert.equal((await coverage(repo))[0].sampleCount, 3);
  await assert.rejects(repo.recordObservation({ observation: obs(3000), collectorLease: { ownerId: 'lost', nowIso: iso(3000) }, nowIso: iso(3000) }), error => error.code === 'collector_lease_lost');
  assert.equal((await coverage(repo))[0].sampleCount, 3);
  latest(repo).observedAt = iso(7 * 86400000);
  const repaired = await record(repo, 4000, 'available');
  assert.equal(repaired.outcome, 'repaired'); assert.deepEqual(repaired.events, []);
  assert.equal((await coverage(repo))[0].sampleCount, 4);
  assert.equal(latest(repo).observationStorage.mode, 'embedded');
  assert.equal((await transition(repo, 'rollback', KEY, iso(4000))).status, 'rolled_back');
  await transition(repo, 'migrate', KEY, iso(4000));
  await assert.rejects(repo.saveLatest({ ...latest(repo), observationStorage: undefined }), error => error.code === 'raw_latest_write_forbidden');
});

test('C11/C15 rollback flush is authoritative; three further samples survive re-migration with increasing revision', async () => {
  const repo = createMemoryRepo(); await record(repo, 0); await transition(repo); await record(repo, 1000);
  const old = structuredClone(latest(repo).observationStorage);
  const rolled = await transition(repo, 'rollback', KEY, iso(1000));
  assert.equal(rolled.status, 'rolled_back'); assert.equal(latest(repo).observationStorage.day, null);
  for (const ms of [2000, 3000, 4000]) await record(repo, ms);
  assert.equal((await coverage(repo))[0].sampleCount, 5);
  const prior = latest(repo).observationStorage.revision;
  assert.ok(prior > old.revision);
  // Even residual old embedded data in legacy mode must never win a read.
  latest(repo).observationStorage.day = old.day;
  assert.equal((await coverage(repo))[0].sampleCount, 5);
  await transition(repo, 'migrate', KEY, iso(4000));
  assert.equal((await coverage(repo))[0].sampleCount, 5);
  assert.ok(latest(repo).observationStorage.revision > prior);
  await record(repo, 5000); assert.equal((await coverage(repo))[0].sampleCount, 6);
});

test('C13 normal writes cannot launder a regressed embedded baseline; backward repair rejects invalid archived counts atomically', async () => {
  const repo = createMemoryRepo(); await record(repo, 0);
  const oldDay = structuredClone((await coverage(repo))[0]);
  await record(repo, 1000); await transition(repo, 'migrate', KEY, iso(1000));
  latest(repo).observationStorage.day = { ...oldDay, storageRevision: latest(repo).observationStorage.revision, storageMode: 'embedded' };
  const before = structuredClone(latest(repo));
  await assert.rejects(record(repo, 2000), error => error.code === 'observation_summary_invalid');
  assert.deepEqual(latest(repo), before);
  assert.equal((await transition(repo, 'migrate', KEY, iso(2000), true)).status, 'blocked');
  const backwards = createMemoryRepo(); await record(backwards, 0); await transition(backwards);
  await record(backwards, 120000);
  backwards.tables.get(C.observationDays).get(`${KEY}|${DAY}`).sampleCount = 900;
  const preserved = structuredClone([...backwards.tables].map(([name, rows]) => [name, [...rows]]));
  await assert.rejects(record(backwards, 60000), error => error.code === 'observation_summary_invalid');
  assert.deepEqual([...backwards.tables].map(([name, rows]) => [name, [...rows]]), preserved);
});

test('C07 reader selects complete revision snapshots across archive and rollback races without summing', async () => {
  const repo = createMemoryRepo(); await record(repo, 0); await transition(repo); await record(repo, 1000);
  const frozen = structuredClone(latest(repo));
  await record(repo, 2000); await transition(repo, 'rollback', KEY, iso(2000));
  const archived = [...repo.tables.get(C.observationDays).values()];
  const request = { partNumber: PART, storeNumbers: [], dayKey: DAY };
  assert.equal(selectObservationCoverage([frozen], archived, request)[0].sampleCount, 3);
  assert.equal(selectObservationCoverage([frozen], [{ ...archived[0], storageRevision: 0, sampleCount: 900 }], request)[0].sampleCount, 2);
});

test('C10 fixed target checkpoint resumes after a committed write with uncertain checkpoint and never increments samples', async () => {
  const repo = createMemoryRepo(), targets = ['R639', 'R577', 'R320'].map(store => `${store}|${PART}`);
  for (const storeNumber of ['R320', 'R577', 'R639']) await record(repo, 0, 'unavailable', { storeNumber });
  let checkpoint, calls = 0;
  const opts = { repo, envId: 'offline', targetKeys: targets, dryRun: false, clock: () => new Date(iso(0)), delayMs: 0 };
  await assert.rejects(runInventoryMigration({ ...opts, onCheckpoint: async state => { if (++calls === 2) throw Error('checkpoint interruption'); checkpoint = state; } }), /interruption/);
  const resumed = await runInventoryMigration({ ...opts, checkpoint });
  assert.equal(resumed.completed, true); assert.equal(resumed.results.length, 3);
  assert.equal(resumed.results[1].status, 'already_migrated');
  for (const row of repo.tables.get(C.latest).values()) assert.equal(row.observationStorage.day.sampleCount, 1);
  await assert.rejects(runInventoryMigration({ ...opts, checkpoint, envId: 'wrong-environment' }), /Checkpoint belongs/);
});

test('C10 offline CLI binds resume to its saved state and rejects input/output path collisions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gxs-inventory-resume-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const repo = createMemoryRepo(); await repo.recordObservation({ observation: obs(0, 'unavailable', { observedAt: '2020-01-01T00:00:00.000Z' }), nowIso: '2020-01-01T00:00:00.000Z' });
  const at = name => path.join(dir, name), snapshot = Object.fromEntries([...repo.tables].map(([name, rows]) => [name, [...rows.values()]]));
  await fs.writeFile(at('initial.json'), JSON.stringify(snapshot));
  await fs.writeFile(at('targets.json'), JSON.stringify([KEY]));
  const common = ['--targets', at('targets.json'), '--env', 'offline', '--apply', '--delay-ms', '0'];
  await migrationCli([...common, '--snapshot', at('initial.json'), '--state-out', at('state.json'), '--out', at('report.json')]);
  const checkpoint = at('report.json.checkpoint.json');
  await assert.rejects(migrationCli([...common, '--snapshot', at('initial.json'), '--resume', checkpoint, '--state-out', at('bad-state.json'), '--out', at('bad-report.json')]), /matching the checkpoint hash/);
  await migrationCli([...common, '--snapshot', at('state.json'), '--resume', checkpoint, '--state-out', at('resumed-state.json'), '--out', at('resumed-report.json')]);
  const resumed = JSON.parse(await fs.readFile(at('resumed-state.json'), 'utf8'));
  assert.equal(resumed[C.latest][0].observationStorage.mode, 'embedded');
  assert.equal(resumed[C.latest][0].observationStorage.day.sampleCount, 1);
  await assert.rejects(migrationCli([...common, '--snapshot', at('initial.json'), '--state-out', at('same.json'), '--out', at('same.json')]), /must be distinct/);
  await assert.rejects(migrationCli([...common, '--snapshot', at('initial.json'), '--state-out', at('separate.json'), '--out', at('initial.json')]), /overwrite an input/);
  assert.deepEqual(JSON.parse(await fs.readFile(at('initial.json'), 'utf8')), snapshot);
});

test('C14 production adapter keys all SKU targets, preserving later pages when earlier targets roll over', async () => {
  const source = createMemoryRepo();
  for (let n = 100; n < 230; n++) { const storeNumber = `R${n}`; await record(source, 0, 'unavailable', { storeNumber }); await transition(source, 'migrate', `${storeNumber}|${PART}`); }
  const calls = []; let moved = false;
  const command = { in: value => ({ op: 'in', value }), gt: value => ({ op: 'gt', value }) };
  const db = { command, collection: name => ({ where: filter => {
    let cap = 100, offset = 0;
    const q = { orderBy(field, direction) { assert.equal(field, '_id'); assert.equal(direction, 'asc'); return q; }, limit(n) { cap = n; return q; }, skip(n) { offset = n; return q; }, async get() {
      calls.push({ name, filter, offset }); assert.equal(offset, 0);
      const rows = [...source.tables.get(name).values()].filter(row => Object.entries(filter).every(([key, expected]) => expected && expected.op
        ? expected.op === 'in' ? expected.value.includes(row[key]) : row[key] > expected.value : row[key] === expected)).sort((a, b) => a._id < b._id ? -1 : 1).slice(0, cap).map(row => structuredClone(row));
      if (!moved && name === C.latest) {
        moved = true;
        for (let n = 100; n < 200; n++) await record(source, 120000, 'unknown', { storeNumber: `R${n}` });
      }
      return { data: rows };
    } }; return q;
  } }) };
  const repo = createCloudbaseRepo(db);
  const rows = await repo.getObservationCoverage({ partNumber: PART, storeNumbers: [], dayKey: DAY });
  assert.equal(rows.length, 130); assert.ok(rows.every(row => row.sampleCount === 1));
  assert.deepEqual(calls.slice(0, 2).map(row => row.name), [C.latest, C.latest]);
  assert.equal(calls[1].filter._id.value, `R199|${PART}`);
  assert.ok(!Object.hasOwn(calls[0].filter, 'observationStorage.day.dayKey'), 'target membership does not shrink when an embedded date moves');
});

test('C04 pinned SDK and production adapter measure steady automatic sample 7 to 5 actions with serial transaction operations', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); } catch { t.skip('Pinned wx-server-sdk dependency unavailable; real adapter transport count remains unverified'); return; }
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV; process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk'); cloud.init({ env: 'offline-observation-storage-contract' });
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson'); const copy = value => EJSON.parse(EJSON.stringify(value));
  let committed = {}, sequence = 0, busy = false, conflictReplacement = null; const transactions = new Map(), calls = [];
  Database.reqClass = class OfflineTransport {
    async send(action, args = {}) {
      assert.equal(busy, false, 'never overlap get/set within one shared transaction'); busy = true;
      try {
        await Promise.resolve(); calls.push({ action, collection: args.collectionName });
        if (action === 'database.startTransaction') { const id = `tx-${++sequence}`; transactions.set(id, copy(committed)); return { transactionId: id }; }
        if (action === 'database.commitTransaction') {
          if (conflictReplacement) { committed = conflictReplacement; conflictReplacement = null; return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'concurrent accepted sample committed' }; }
          committed = transactions.get(args.transactionId); transactions.delete(args.transactionId); return {};
        }
        if (action === 'database.abortTransaction') { transactions.delete(args.transactionId); return {}; }
        assert.ok(args.transactionId, 'this offline contract only handles transaction transport');
        const rows = transactions.get(args.transactionId)[args.collectionName] ||= {};
        if (action === 'database.getDocument') { const id = EJSON.parse(args.query)._id; return { data: { list: rows[id] ? [EJSON.stringify(rows[id])] : [] } }; }
        if (action === 'database.insertDocument') { const docs = args.data.map(data => EJSON.parse(data)); for (const doc of docs) rows[doc._id] = doc; return { data: { insertedIds: docs.map(d => d._id) } }; }
        if (action === 'database.modifyDocument') { assert.equal(args.merge, false); const id = EJSON.parse(args.query)._id; rows[id] = { _id: id, ...EJSON.parse(args.data) }; return { data: { updated: 1 } }; }
        throw Error(`Unexpected SDK action ${action}`);
      } finally { busy = false; }
    }
  };
  try {
    const repo = createCloudbaseRepo(db);
    await record(repo, 0);
    await repo.acquireLease({ id: 'collector_lease', ownerId: 'worker', now: iso(0), expiresAt: iso(100000) });
    const sample = ms => repo.recordObservation({ observation: obs(ms), nowIso: iso(ms), collectorLease: { ownerId: 'worker', nowIso: iso(ms) } });
    calls.length = 0; await sample(1000); const legacy = [...calls];
    await transition(repo, 'migrate', KEY, iso(1000));
    calls.length = 0; await sample(2000); const embedded = [...calls];
    assert.equal(legacy.length, 7); assert.equal(embedded.length, 5);
    assert.deepEqual(embedded.map(c => c.action), ['database.startTransaction', 'database.getDocument', 'database.getDocument', 'database.modifyDocument', 'database.commitTransaction']);
    assert.equal(committed[C.latest][KEY].observationStorage.day.sampleCount, 3);
    assert.equal(committed[C.observationDays][`${KEY}|${DAY}`].sampleCount, 2, 'old archive is not part of steady state writes');
    t.diagnostic(JSON.stringify({ scope: 'pinned SDK offline transport, not server or billing', legacyActions: legacy.length, embeddedActions: embedded.length,
      legacyReads: legacy.filter(c => c.action === 'database.getDocument').length, embeddedReads: embedded.filter(c => c.action === 'database.getDocument').length,
      legacyWrites: legacy.filter(c => /modifyDocument|insertDocument/.test(c.action)).length, embeddedWrites: embedded.filter(c => /modifyDocument|insertDocument/.test(c.action)).length,
      sampleIntervalUnchanged: true, productionRequests: 0 }));
    // Interleave a committed sample with each mode transition. The failed
    // transaction must abort, reread the current authority and retain it.
    const concurrentState = async ms => {
      const memory = createMemoryRepo(Object.fromEntries(Object.entries(committed).map(([name, rows]) => [name, Object.values(rows)])));
      await record(memory, ms);
      return Object.fromEntries([...memory.tables].map(([name, rows]) => [name, Object.fromEntries(rows)]));
    };
    await repo.acquireLease({ id: MIGRATION_LEASE_ID, ownerId: 'migration-test', now: iso(3000), expiresAt: iso(50000) });
    conflictReplacement = await concurrentState(3000);
    await repo.transitionObservationStorage({ targetKey: KEY, action: 'rollback', dryRun: false, nowIso: iso(3000), migrationLease: { ownerId: 'migration-test' } });
    assert.equal(committed[C.observationDays][`${KEY}|${DAY}`].sampleCount, 4);
    assert.equal(committed[C.latest][KEY].observationStorage.mode, 'legacy');
    conflictReplacement = await concurrentState(4000);
    await repo.transitionObservationStorage({ targetKey: KEY, action: 'migrate', dryRun: false, nowIso: iso(4000), migrationLease: { ownerId: 'migration-test' } });
    assert.equal(committed[C.latest][KEY].observationStorage.day.sampleCount, 5);
    assert.equal(transactions.size, 0);
  } finally { Database.reqClass = previousRequest; if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV; else process.env.TENCENTCLOUD_RUNENV = previousRuntime; }
});
