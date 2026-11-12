import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, fakeFetch, userContext, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';
import { COLLECTIONS } from '../cloudfunctions/gxs_api/lib/collections.js';

const owner = 'oSTORELIMITOWNER00000000001', other = 'oSTORELIMITOTHER00000000002';
const queryId = 'recovered-live-store-limit';
const payload = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577', 'R639'] };
const fingerprint = JSON.stringify(payload);
const key = 'gxs_pending_q_v1';
const unwrap = envelope => {
  if (!envelope.ok) throw Object.assign(Error(envelope.error.message), envelope.error);
  return envelope.data;
};

async function loweredLimit() {
  const fetchImpl = fakeFetch({ R577: { display: 'available' }, R639: { display: 'available' } });
  const f = createFixture({ fetchImpl });
  for (const who of [owner, other]) unwrap(await f.call('quota.signin', {}, userContext(who)));
  const paid = unwrap(await f.call('query.pickup', { ...payload, queryId }, userContext(owner)));
  assert.equal(paid.charged, 1);
  assert.equal(paid.balance, 0);
  f.repo.tables.get(COLLECTIONS.config).get('runtime').query.maxStores = 1;
  return { f, fetchImpl };
}

async function client(f, who, pending) {
  const rt = runtime(async (action, data) => unwrap(await f.call(action, data, userContext(who))));
  if (pending) rt.storage.set(key, { id: queryId, fingerprint, ...pending });
  rt.wx.showModal = () => assert.fail('An over-limit target cannot offer a new purchase');
  const page = rt.instance('pages/query/index.js');
  const product = PRODUCTS.find(item => item.partNumber === payload.partNumber);
  page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: Object.fromEntries(STORES.map(s => [s.storeNumber, s])) };
  page.selection = { ...payload, product };
  page.applyBoot(unwrap(await f.call('user.bootstrap', {}, userContext(who))));
  return { rt, page };
}

for (const owned of [false, true]) {
  test((owned ? 'current' : 'legacy') + ' pending live query replays its original paid stores after the current limit falls', async () => {
    const { f, fetchImpl } = await loweredLimit();
    const calls = fetchImpl.calls.length;
    const { rt, page } = await client(f, owner, owned ? { owner: userKeyOf(owner), currentFormat: true } : {});
    assert.equal(page.data.selectionCanCollapse, false);
    assert.equal(page.data.limitedQueryRecovery, true);
    assert.match(page.data.selectionNotice, /最多查询 1 家门店/);
    assert.match(page.data.selectionSummary.storeLabel, /天环广场、珠江新城/);
    await page.onQuery();
    assert.deepEqual(rt.calls.map(item => item.action), owned ? ['query.resumeLegacy'] : ['query.recovery', 'query.resumeLegacy']);
    assert.equal(rt.calls.at(-1).payload.mode, 'resume');
    assert.equal(page.data.result.replayed, true);
    assert.deepEqual(Array.from(page.data.result.results, row => row.storeNumber), payload.storeNumbers);
    assert.equal(fetchImpl.calls.length, calls);
    assert.equal((await f.repo.listLedger(userKeyOf(owner))).filter(row => row.type === 'query_debit').length, 1);
    assert.equal(page.data.limitedQueryRecovery, false);
    await page.onQuery();
    assert.equal(rt.calls.at(-1).action, 'query.resumeLegacy');
  });
}

test('a dropped limit never starts an over-limit purchase for a missing, foreign or changed request', async () => {
  const { f, fetchImpl } = await loweredLimit(), calls = fetchImpl.calls.length;
  const b = await client(f, other, {});
  assert.equal(b.page.data.limitedQueryRecovery, true);
  await b.page.onQuery();
  assert.deepEqual(b.rt.calls.map(item => item.action), ['query.recovery']);
  assert.match(b.page.data.queryFailureMessage, /当前账号未查到.*未扣次/);
  assert.equal(b.rt.storage.get(key).id, queryId);
  const fresh = await client(f, other);
  assert.equal(fresh.page.data.limitedQueryRecovery, false);
  await fresh.page.onQuery();
  assert.deepEqual(fresh.rt.calls, []);

  const scope = { ...payload, queryId, expectedUserKey: userKeyOf(owner), kind: 'live', mode: 'resume' };
  for (const [patch, who, expected] of [
    [{}, other, 'query_recovery_account'],
    [{ expectedUserKey: userKeyOf(other) }, other, 'query_recovery_missing'],
    [{ storeNumbers: ['R577', 'R320'] }, owner, 'query_id_conflict'],
    [{ storeNumbers: [...payload.storeNumbers, 'invalid'] }, owner, 'invalid_query_id'],
    [{ queryId: 'never-recover-new-charge', mode: 'start', maxCost: 1 }, owner, 'too_many_stores'],
  ]) {
    const response = await f.call('query.resumeLegacy', { ...scope, ...patch }, userContext(who));
    assert.equal(response.error.code, expected);
  }
  assert.equal((await f.call('query.pickup', { ...payload, queryId: 'new-live-query-still-limited' }, userContext(other))).error.code, 'too_many_stores');
  assert.equal(fetchImpl.calls.length, calls);
  assert.equal((await f.repo.getUser(userKeyOf(other))).quota.balance, 1);
  assert.equal((await f.repo.listLedger(userKeyOf(other))).filter(row => row.type === 'query_debit').length, 0);
});

test('an ordinary retry on a still-open page with the old cached limit can replay only the existing ID', async () => {
  const { f, fetchImpl } = await loweredLimit(), calls = fetchImpl.calls.length;
  const { rt, page } = await client(f, owner, { owner: userKeyOf(owner), currentFormat: true });
  const boot = unwrap(await f.call('user.bootstrap', {}, userContext(owner)));
  page.applyBoot({ ...boot, limits: { ...boot.limits, queryMaxStores: 3 } });
  assert.equal(page.data.selectionCanCollapse, true);
  await page.onQuery();
  assert.equal(rt.calls.at(-1).action, 'query.pickup');
  assert.equal(page.data.result.replayed, true);
  assert.equal(fetchImpl.calls.length, calls);
  assert.equal((await f.repo.listLedger(userKeyOf(owner))).filter(row => row.type === 'query_debit').length, 1);
});

test('the native live query action offers original recovery ahead of the over-limit edit action', () => {
  const wxml = fs.readFileSync(new URL('../miniprogram/pages/query/index.wxml', import.meta.url), 'utf8');
  assert.match(wxml, /wx:elif="{{limitedQueryRecovery}}"[^>]*disabled="{{!accountReady \|\| querying \|\| signing}}"[^>]*bindtap="onQuery"[^>]*>[\s\S]*?核对上次查询[^<]*<\/button>\s*<button wx:elif="{{selectionSummary && !selectionCanCollapse}}"/);
});
