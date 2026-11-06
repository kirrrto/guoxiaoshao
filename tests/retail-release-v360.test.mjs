import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { exactRetailSummary, retainPrelaunchRestrictions } from '../tools/catalog/lib/catalog-readiness.mjs';
import { createFixture, fakeFetch, userKeyOf, operatorContext, appleBody } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { parseApplePickup } = require('../cloudfunctions/gxs_api/lib/apple-pickup');
const { buildFromBundled, toProductDoc, get } = require('../cloudfunctions/gxs_api/lib/services/catalog');
const { isRetiredPartNumber } = require('../cloudfunctions/gxs_api/lib/rules/follow-access');
const catalog = require('../catalog/products.json');
const seed = require('../miniprogram/config/catalog-seed');
const captureDir = new URL('../evidence/pickup-samples/2026-11-06/', import.meta.url);
const read = name => readFileSync(new URL(name, captureDir));
const summary = JSON.parse(read('release-readiness.json'));

function replay(file) {
  const { record, observations, sha256, bodyFile } = JSON.parse(read(file));
  const body = read(bodyFile);
  assert.equal(createHash('sha256').update(body).digest('hex'), sha256);
  const url = new URL(record.requestUrl);
  assert.equal(url.origin + url.pathname, 'https://www.apple.com.cn/shop/retail/pickup-message');
  assert.equal(url.searchParams.get('store'), summary.storeNumber);
  const targets = record.partNumbers.map((partNumber, index) => {
    assert.equal(url.searchParams.get(`parts.${index}`), partNumber);
    return { partNumber, storeNumber: summary.storeNumber };
  });
  assert.deepEqual(parseApplePickup({ httpStatus: record.httpStatus, body: body.toString(), targets,
    observedAt: record.finishedAt }), observations);
  return observations;
}

test('all 29 previously pending retail identities replay and match individual bundled and seed capabilities', () => {
  const built = buildFromBundled();
  const current = new Set();
  for (const group of summary.families) {
    const expected = catalog.products.filter(p => p.familyKey === group.familyKey && p.targetType !== 'apple_cto');
    const observed = group.requests.flatMap(replay);
    assert.equal(observed.length, expected.length);
    for (const p of expected) {
      const o = observed.find(o => o.partNumber === p.partNumber);
      assert.ok(o && ['available', 'unavailable', 'ineligible'].includes(o.status));
      assert.equal(p.pickupVerification.checkedAt, o.observedAt);
      for (const docs of [built.products, seed.products]) {
        const doc = docs.find(row => row.partNumber === p.partNumber);
        assert.ok(doc.querySupported && doc.monitorSupported && !doc.comingSoon);
        assert.equal(doc.verificationStatus, o.status);
      }
      current.add(p.partNumber);
    }
  }
  assert.equal(current.size, 29);
  assert.equal(seed.products.filter(p => p.querySupported).length, 355);
  assert.equal(seed.products.filter(p => p.targetType === 'apple_cto' && !p.querySupported && !p.monitorSupported).length, 42);
});

test('44 replacement SKUs already in service replay by exact identity and remain separate from retired products', () => {
  const observations = summary.alreadySupportedReplacements.flatMap(group => replay(group.receipt));
  assert.equal(new Set(observations.map(o => o.partNumber)).size, 44);
  for (const o of observations) {
    const p = seed.products.find(row => row.partNumber === o.partNumber);
    assert.ok(!isRetiredPartNumber(o.partNumber) && p.querySupported && p.monitorSupported);
    assert.ok(['available', 'unavailable', 'ineligible'].includes(o.status));
  }
});

test('new or mismatched SKU in an individually reviewed family cannot inherit another SKU’s verification', () => {
  const family = catalog.families.find(f => f.familyKey === 'macbook-pro-proled-xdr');
  const source = catalog.products.find(p => p.familyKey === family.familyKey);
  const { pickupVerification, ...specs } = source;
  const fresh = { ...specs, partNumber: 'MTESTCH/A' };
  const [existing, added] = retainPrelaunchRestrictions([specs, fresh], [source]);
  assert.equal(existing.pickupVerification.checkedAt, pickupVerification.checkedAt);
  assert.deepEqual(exactRetailSummary([existing, added]), { ...pickupVerification, sampledPartNumbers: [existing.partNumber], reason: null });
  assert.equal(exactRetailSummary([added]), null);
  for (const product of [added, { ...added, pickupVerification }, { ...source, comingSoon: true },
    { ...source, pickupVerification: { ...pickupVerification, status: 'pending' } },
    { ...source, pickupVerification: { ...pickupVerification, status: 'unknown' } }]) {
    const doc = toProductDoc(product, family);
    assert.equal(doc.querySupported, false);
    assert.equal(doc.monitorSupported, false);
  }
});

test('public catalog reads never reseed production and stay retryable until the operator completes the import', async () => {
  const built = buildFromBundled();
  const f = createFixture();
  await f.repo.replaceCatalog({ products: [], stores: [], meta: { _id: 'catalog', version: '2026-10-30T07:12:46.858Z|old' } });
  const replace = f.repo.replaceCatalog.bind(f.repo);
  let writes = 0;
  f.repo.replaceCatalog = async () => { writes++; throw Error('interrupted'); };
  const ctx = { repo: f.repo, nowIso: '2026-11-06T08:00:00.000Z' };
  await assert.rejects(get(ctx, { ifVersion: built.meta.version }), { code: 'catalog_updating' });
  assert.equal((await f.call('admin.seedCatalog')).error.code, 'forbidden');
  assert.equal(writes, 0);
  assert.equal((await f.call('admin.seedCatalog', {}, operatorContext())).ok, false);
  await assert.rejects(get(ctx, {}), { code: 'catalog_updating' });
  assert.equal(writes, 1);
  f.repo.replaceCatalog = replace;
  assert.equal((await f.call('admin.seedCatalog', {}, operatorContext())).ok, true);
  const updated = await get(ctx, {});
  assert.equal(updated.version, built.meta.version);
  assert.equal(updated.products.find(p => p.partNumber === 'MJ2K4CH/A').querySupported, true);
});

test('a timestamped server reply newer than the app seed but older than the cached catalog cannot roll back a client', async () => {
  const afterSeed = new Date(Date.parse(catalog.generatedAt) + 60000).toISOString();
  const stillNewer = new Date(Date.parse(afterSeed) + 60000).toISOString();
  const response = { ...seed, version: afterSeed + '|server' };
  const cached = { ...seed, version: stillNewer + '|cache' };
  const rt = runtime(async () => response);
  rt.wx.setStorageSync('gxs_catalog_v1', cached);
  const store = rt.load('utils/store.js');
  assert.equal((await store.getCatalog({ force: true })).version, cached.version);
  assert.equal(rt.wx.getStorageSync('gxs_catalog_v1').version, cached.version);
});

test('routine sampling skips SKU-reviewed families, and replay or incomplete captures cannot overwrite the catalog', t => {
  const root = mkdtempSync(join(tmpdir(), 'gxs-catalog-sample-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['tools/catalog/sample-pickup.mjs', 'tools/catalog/lib/http.mjs', 'tools/catalog/lib/catalog-readiness.mjs',
    'cloudfunctions/gxs_api/lib/apple-pickup.js', 'cloudfunctions/gxs_api/lib/rules/product-target.js', 'catalog/stores.json']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(new URL('../' + file, import.meta.url), join(root, file));
  }
  const snapshot = structuredClone(catalog);
  const keys = new Set(['homepod-mini-2', 'homepod']);
  snapshot.families = snapshot.families.filter(f => keys.has(f.familyKey));
  snapshot.products = snapshot.products.filter(p => keys.has(p.familyKey));
  const source = join(root, 'catalog/products.json');
  writeFileSync(source, JSON.stringify(snapshot));
  const firstHomePod = snapshot.products.find(p => p.familyKey === 'homepod');
  const body = appleBody('R577', '天环广场', { [firstHomePod.partNumber]: 'available' });
  const preload = join(root, 'mock.mjs');
  writeFileSync(preload, 'globalThis.fetch = async () => new Response(' + JSON.stringify(body) + ');');
  const run = (...args) => spawnSync(process.execPath, ['--import', './mock.mjs', 'tools/catalog/sample-pickup.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const live = run();
  assert.equal(live.status, 0, live.stderr);
  const applied = readFileSync(source, 'utf8'), updated = JSON.parse(applied);
  const exact = c => c.families.find(f => f.familyKey === 'homepod-mini-2');
  assert.deepEqual(exact(updated), exact(snapshot));
  assert.deepEqual(updated.products.filter(p => p.familyKey === 'homepod-mini-2'), snapshot.products.filter(p => p.familyKey === 'homepod-mini-2'));
  assert.notEqual(updated.generatedAt, snapshot.generatedAt);
  const replay = run('--replay', updated.pickupVerification.day);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(readFileSync(source, 'utf8'), applied);
  writeFileSync(preload, 'globalThis.fetch = async () => new Response("", {status: 429});');
  assert.equal(run().status, 1);
  assert.equal(readFileSync(source, 'utf8'), applied);
  assert.equal(run('--replay', updated.pickupVerification.day).status, 0, 'previous successful response bodies remain replayable');
});

test('a released SKU enters the normal query, quota and member follow services', async () => {
  const { products, stores } = buildFromBundled();
  const fetchImpl = fakeFetch({ R577: { display: 'available', storeName: '天环广场' } });
  const f = createFixture({ products, stores, fetchImpl });
  const selection = { partNumber: 'MJ2K4CH/A', storeNumbers: ['R577'] };
  assert.equal((await f.call('quota.signin')).ok, true);
  const result = await f.call('query.pickup', { ...selection, queryId: 'released-mbp-0001' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(fetchImpl.calls.map(call => call.parts), [[selection.partNumber]]);
  const freeFollow = await f.call('follow.upsert', selection);
  assert.equal(freeFollow.error.code, 'member_required');
  assert.equal((await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 7, grantId: 'offline-grant-v360' }, operatorContext())).ok, true);
  const memberFollow = await f.call('follow.upsert', { ...selection, followId: 'follow-v360-proled' });
  assert.equal(memberFollow.ok, true, JSON.stringify(memberFollow.error));
  assert.equal(memberFollow.data.follow.partNumber, selection.partNumber);
  assert.equal(memberFollow.data.follow.status, 'active');
});
