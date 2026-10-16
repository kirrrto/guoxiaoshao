import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { alternativesFixture, ok, tablesSnapshot, BASE, SILVER, BLACK, QUERY_ID, stores } from './helpers/query-alternatives-fixture.mjs';
import { userContext, userKeyOf } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { storeChoices } = require('../cloudfunctions/gxs_api/lib/rules/query-alternatives');
const { toStoreDoc } = require('../cloudfunctions/gxs_api/lib/services/catalog');
const originKey = `${userKeyOf()}|${QUERY_ID}`;

for (const member of [false, true]) test(`${member ? 'member' : 'paid free-user'} alternatives read ≤9 fresh targets without any collection writes, upstream requests or debit`, async () => {
  const f = await alternativesFixture({ member });
  assert.equal(f.origin.ok, true); assert.equal(f.origin.charged, member ? 0 : 1); assert.equal(f.origin.refunded, 0);
  for (const part of [BASE, SILVER, BLACK]) for (const store of ['R578', 'R579', 'R580']) await f.observe(part, store);
  const before = tablesSnapshot(f.repo), calls = f.fetchImpl.calls.length;
  const response = ok(await f.read({ partNumbers: [BASE, SILVER, BLACK], storeNumbers: ['R578', 'R579', 'R580'] }));
  assert.equal(response.results.length, 9); assert.equal(response.queryId, QUERY_ID); assert.equal(response.basePartNumber, BASE);
  assert.equal(response.expiresAt, f.origin.alternativesExpiresAt);
  assert.ok(response.results.every(row => row.status === 'available' && row.observedAt && row.expiresAt));
  assert.equal(response.results.find(row => row.partNumber === SILVER).color, '银色');
  await f.read({ partNumbers: [BLACK], storeNumbers: ['R577', 'R578'] });
  assert.equal(f.fetchImpl.calls.length, calls); assert.equal(tablesSnapshot(f.repo), before);
});

test('origin proof is own-account, live, successful and actually charged or a member query', async () => {
  const f = await alternativesFixture(); await f.observe();
  const original = await f.repo.getQuery(originKey);
  const before = tablesSnapshot(f.repo);
  assert.equal((await f.read({}, userContext('oOTHER00000000000000000001'))).error.code, 'alternatives_query_required');
  assert.equal(tablesSnapshot(f.repo), before, 'a caller without a query does not create a user or any other state');
  for (const patch of [{ kind: 'history' }, { status: 'pending' }, { status: 'failed' }, { response: { ...original.response, ok: false } },
    { response: { ...original.response, refunded: original.charged } }, { charged: 0 }, { userKey: 'another-user' }]) {
    await f.repo.saveQuery({ ...original, ...patch });
    assert.equal((await f.read()).error.code, 'alternatives_query_required');
  }
});

test('same family is insufficient: model, capacity and every other attribute must match', async () => {
  const f = await alternativesFixture();
  for (const part of ['MXXX4CH/A', 'MXXX5CH/A', 'MXXX6CH/A', 'MXXX7CH/A']) {
    assert.equal((await f.read({ partNumbers: [part], basePartNumber: part })).error.code, 'alternative_variant_mismatch');
  }
  assert.equal((await f.read({ partNumbers: ['MXXX8CH/A'] })).error.code, 'alternatives_restricted');
  assert.equal((await f.read({ partNumbers: ['ABCDECH/A'] })).error.code, 'alternatives_restricted');
});

test('current SKU restrictions are checked for the original and every accepted color', async () => {
  const f = await alternativesFixture(); await f.observe();
  const initial = await f.repo.getConfig();
  for (const partNumbers of [[SILVER], [BASE]]) {
    await f.repo.saveConfig({ ...initial, newProductWindows: [{ partNumbers, releaseAt: f.state.now.toISOString() }] });
    assert.equal((await f.read()).error.code, 'alternatives_restricted');
  }
  const member = await alternativesFixture({ member: true, config: { newProductWindows: [{ partNumbers: [BASE, SILVER], releaseAt: '2026-09-15T00:00:00.000Z' }] } });
  await member.observe(); assert.equal(ok(await member.read()).results.length, 1);
  await member.repo.updateUser(userKeyOf(), { membership: { expiresAt: member.state.now.toISOString() } });
  assert.equal((await member.read()).error.code, 'alternatives_restricted');
});

test('accepted selections are bounded, strict and limited to three catalog neighboring stores', async () => {
  const f = await alternativesFixture();
  for (const patch of [{ partNumbers: [] }, { storeNumbers: [] }, { partNumbers: [BASE, SILVER, BLACK, 'MXXX4CH/A'] },
    { storeNumbers: ['R577', 'R578', 'R579', 'R580'] }, { partNumbers: [SILVER, SILVER] }, { storeNumbers: ['R578', 'R578'] },
    { partNumbers: ['invalid'] }, { storeNumbers: [577] }]) assert.equal((await f.read(patch)).error.code, 'invalid_alternative_scope');
  assert.equal((await f.read({ storeNumbers: ['R581'] })).error.code, 'alternative_store_mismatch', 'fourth extra same-city store is outside the finite universe');
  assert.equal((await f.read({ storeNumbers: ['R320'] })).error.code, 'alternative_store_mismatch');
  assert.deepEqual(storeChoices(stores, ['R577']).map(item => item.storeNumber), ['R577', 'R578', 'R579', 'R580']);
  assert.ok(storeChoices(stores, ['R577']).slice(1).every(item => item.relation === 'same_city' && item.distanceKm === null));
});

test('nearby ranking uses only valid catalog coordinates and never invents GPS distances', () => {
  const geo = stores.map((store, i) => ({ ...store, latitude: 23.1, longitude: 113.3 + i * 0.01 }));
  geo[4].longitude = 113.305; geo[5].longitude = 120;
  const choices = storeChoices(geo, ['R577']);
  assert.deepEqual(choices.map(item => item.storeNumber), ['R577', 'R581', 'R578', 'R579']);
  assert.ok(choices.slice(1).every(item => item.relation === 'nearby' && item.distanceKm > 0 && item.distanceKm <= 50));
  assert.equal(toStoreDoc(geo[0]).latitude, 23.1);
  assert.equal(toStoreDoc({ ...geo[0], latitude: '23.1' }).latitude, undefined);
  assert.equal(toStoreDoc({ ...geo[0], latitude: 999 }).latitude, undefined);
});

test('stale, unknown, future, invalid and restricted observations never become alternatives', async () => {
  const f = await alternativesFixture();
  const iso = delta => new Date(f.state.now.getTime() + delta).toISOString();
  for (const patch of [{ observedAt: iso(-120000) }, { knownAt: iso(-120000) }, { observedAt: iso(1) }, { knownAt: iso(1) },
    { observedAt: 'invalid' }, { knownAt: 'invalid' }, { observedAt: iso(-60000), knownAt: iso(-1000) }, { status: 'unknown' }, { status: 'unavailable' }, { unknownSince: iso(-100) }, { isStale: true }, { restricted: true }]) {
    await f.observe(SILVER, 'R578', patch); assert.equal(ok(await f.read()).results.length, 0, JSON.stringify(patch));
  }
  await f.observe(SILVER, 'R578', { observedAt: iso(-119999), knownAt: iso(-119999) });
  assert.equal(ok(await f.read()).results.length, 1);
});

test('origin expiry cannot be extended by replay, fresh shared stock or repeated choices', async () => {
  const f = await alternativesFixture(); await f.observe();
  f.advance(119999); assert.equal(ok(await f.read()).results.length, 1);
  const replay = ok(await f.call('query.pickup', { queryId: QUERY_ID, partNumber: BASE, storeNumbers: ['R577'] }));
  assert.equal(replay.alternativesExpiresAt, f.origin.alternativesExpiresAt); assert.equal(replay.finishedAt, f.origin.finishedAt);
  f.advance(1); await f.observe();
  assert.equal((await f.read()).error.code, 'alternatives_expired'); assert.equal(f.fetchImpl.calls.length, 1);
});

test('the server rechecks the origin window after a slow latest read', async () => {
  const f = await alternativesFixture(); await f.observe();
  const get = f.repo.getLatest.bind(f.repo);
  f.repo.getLatest = async keys => { const rows = await get(keys); f.advance(120000); return rows; };
  assert.equal((await f.read()).error.code, 'alternatives_expired');
});

test('client and server pure variant/geography guards stay identical', () => {
  assert.equal(fs.readFileSync(new URL('../miniprogram/utils/alternative-rules.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../cloudfunctions/gxs_api/lib/rules/query-alternatives.js', import.meta.url), 'utf8'));
});
