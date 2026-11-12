import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, userContext, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import db from '../cloudfunctions/gxs_api/lib/collections.js';

const start = '2026-10-02T03:00:00Z', day = '2026-10-01';
const alice = 'oHISTORYOWNER000000000001', bob = 'oHISTORYOWNER000000000002';
const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], dayKey: day };
const legacyId = 'history-old-paid-page';
const ok = result => { if (!result.ok) throw Object.assign(Error(result.error.message), result.error); return result.data; };

async function open(t, legacy = false) {
  t.mock.method(Date, 'now', () => Date.parse(start));
  const f = createFixture({ start, config: { tasks: [] } });
  for (const who of [alice, bob]) ok(await f.call('quota.signin', {}, userContext(who)));
  await f.repo.saveEvents(Array.from({ length: 101 }, (_, i) => ({ _id: 'event' + i, type: 'status_changed', status: 'available',
    partNumber: target.partNumber, storeNumber: 'R577', dayKey: day, detectedAt: new Date(Date.parse(day + 'T02:00:00Z') + i).toISOString(), source: 'auto' })));
  const state = { who: alice };
  const rt = runtime(async (action, payload) => {
    if (state.oldCloud && action === 'history.page') throw Object.assign(Error('unknown action'), { code: 'unknown_action' });
    const data = ok(await f.call(action, payload, userContext(state.who)));
    if (action === 'history.page' && state.afterRead) await state.afterRead();
    return data;
  });
  if (legacy) {
    ok(await f.call('history.list', { ...target, historyQueryId: legacyId }, userContext(alice)));
    rt.storage.set('gxs_pending_h_v1', { id: legacyId, fingerprint: JSON.stringify({ dayKey: day, partNumber: target.partNumber, storeNumbers: target.storeNumbers }) });
  }
  const page = rt.instance('pages/history/index.js'), product = PRODUCTS.find(p => p.partNumber === target.partNumber);
  page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: Object.fromEntries(STORES.map(s => [s.storeNumber, s])) };
  page.selection = { ...target, product }; page.data.dayKey = day; page.dateExplicit = true;
  page.applyBoot(ok(await f.call('user.bootstrap', {}, userContext(alice))));
  await page.onQuery();
  assert.equal(page.data.result.events.length, 100);
  assert.equal(page.data.result.pagination.hasMore, true);
  assert.equal(page.historyRequest.expectedUserKey, userKeyOf(alice));
  assert.equal((await f.repo.getUser(userKeyOf(alice))).quota.balance, 0);
  return { f, page, rt, state };
}

for (const legacy of [false, true]) {
  test((legacy ? 'recovered' : 'ordinary') + ' paid history cannot debit another account or blend its events during pagination', async t => {
    const { f, page, rt, state } = await open(t, legacy);
    const request = { ...page.historyRequest, cursor: page.data.result.pagination.nextCursor };
    // The runtime already changed accounts while this tab still sees the old bootstrap.
    state.who = bob;
    await page.onLoadMore();
    assert.equal(rt.calls.at(-1).action, 'history.page');
    assert.equal(page.data.result, null);
    assert.equal((await f.repo.getUser(userKeyOf(bob))).quota.balance, 1);
    assert.equal((await f.repo.listLedger(userKeyOf(bob))).filter(r => r.type === 'history_debit').length, 0);
    assert.equal((await f.call('history.page', { ...request, expectedUserKey: userKeyOf(bob) }, userContext(bob))).error.code, 'history_page_missing');
    // The older client action is also prevented from creating a new paid request.
    const { expectedUserKey, ...older } = request;
    assert.equal((await f.call('history.list', older, userContext(bob))).error.code, 'history_page_missing');
    assert.equal(f.repo.tables.get(db.COLLECTIONS.queries).size, 1);
    assert.equal((await f.repo.getUser(userKeyOf(bob))).quota.balance, 1);
  });
}

test('a matching paid snapshot pages at zero balance; old cloud compatibility never falls back to new admission', async t => {
  const { f, page, rt, state } = await open(t);
  const requests = rt.calls.length;
  state.oldCloud = true;
  await page.onLoadMore();
  assert.deepEqual(rt.calls.slice(requests).map(item => item.action), ['history.page']);
  assert.equal(page.data.result.events.length, 100);
  assert.match(page.data.moreError, /续页服务暂不可用.*未扣次/);
  state.oldCloud = false;
  await page.onLoadMore();
  assert.equal(page.data.result.events.length, 101);
  assert.equal(page.data.result.pagination.hasMore, false);
  assert.equal((await f.repo.listLedger(userKeyOf(alice))).filter(r => r.type === 'history_debit').length, 1);
});

test('a confirmed switch after the page read but before delivery clears the prior snapshot and ignores the late events', async t => {
  const { f, page, rt, state } = await open(t);
  state.afterRead = async () => { rt.app.globalData.bootstrap = ok(await f.call('user.bootstrap', {}, userContext(bob))); };
  await page.onLoadMore();
  assert.equal(page.data.result, null);
  assert.equal(page.historySnapshot, null);
  assert.equal((await f.repo.getUser(userKeyOf(bob))).quota.balance, 1);
});

test('a known switch before the old tab applies bootstrap stops pagination without a native request', async t => {
  const { f, page, rt } = await open(t, true);
  rt.app.globalData.bootstrap = ok(await f.call('user.bootstrap', {}, userContext(bob)));
  const before = rt.calls.length;
  await page.onLoadMore();
  assert.equal(rt.calls.length, before);
  assert.equal(page.data.result, null);
  assert.equal((await f.repo.getUser(userKeyOf(bob))).quota.balance, 1);
});
