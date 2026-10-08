import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { alternativesFixture, ok, tablesSnapshot, BASE, SILVER, BLACK } from './helpers/query-alternatives-fixture.mjs';
import { userKeyOf } from './helpers/fixture.mjs';
const copy = value => JSON.parse(JSON.stringify(value));
const event = (kind, value) => ({ currentTarget: { dataset: { kind, value } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function queried(t, intercept, fixtureOptions = {}) {
  const f = await alternativesFixture({ query: false, ...fixtureOptions });
  t.mock.method(Date, 'now', () => f.state.now.getTime());
  const rt = runtime(async (action, payload) => {
    const response = ok(await f.call(action, payload));
    return intercept ? intercept(action, response) : response;
  });
  const page = rt.instance('pages/query/index.js'); await page.onLoad();
  page.applyCatalog(await rt.load('utils/store.js').getCatalog({ force: true }));
  await page.onShow();
  page.onPickerChange({ detail: { partNumber: BASE, product: page.catalog.productByPart[BASE], storeNumbers: ['R577'], stores: [page.catalog.storeByNumber.R577] } });
  await page.onQuery(); await f.observe();
  return { f, rt, page };
}
async function match(t, intercept) {
  const context = await queried(t, intercept), { page } = context;
  page.onToggleAlternative(event('part', SILVER)); page.onToggleAlternative(event('store', 'R578'));
  await page.onReadAlternatives();
  return context;
}

test('actual page explicitly selects a different acceptable color and a store outside the original query without side effects', async t => {
  const { f, rt, page } = await queried(t);
  assert.deepEqual(copy(page.data.alternativeColorChoices.map(item => item.partNumber)), [BASE, SILVER, BLACK]);
  assert.deepEqual(copy(page.data.alternativeStoreChoices.map(item => item.storeNumber)), ['R577', 'R578', 'R579', 'R580']);
  assert.match(page.data.alternativeStoreChoices[1].relationText, /同城门店/);
  assert.deepEqual(copy(page.data.alternativeParts), []); assert.deepEqual(copy(page.data.alternativeStores), ['R577']);
  const before = tablesSnapshot(f.repo), calls = f.fetchImpl.calls.length, target = copy(page.selection);
  page.onToggleAlternative(event('part', SILVER)); page.onToggleAlternative(event('store', 'R578'));
  assert.deepEqual(copy(page.selection), target); assert.equal(rt.calls.filter(call => call.action === 'query.alternatives').length, 0);
  await page.onReadAlternatives();
  assert.equal(page.data.alternativeMatches.length, 1); const row = page.data.alternativeMatches[0];
  assert.equal(row.partNumber, SILVER); assert.equal(row.storeNumber, 'R578'); assert.match(row.observedText, /2026-/);
  assert.equal(tablesSnapshot(f.repo), before); assert.equal(f.fetchImpl.calls.length, calls);
  assert.equal(rt.calls.filter(call => call.action === 'follow.upsert').length, 0);
  await page.onPrepareAlternative({ currentTarget: { dataset: { key: row.key } } });
  assert.equal(page.selection.partNumber, SILVER); assert.deepEqual(copy(page.selection.storeNumbers), ['R578']);
  assert.match(page.data.alternativePreparedNotice, /尚未查询或扣次/); assert.equal(page.data.result.product.partNumber, BASE);
  assert.equal(tablesSnapshot(f.repo), before); assert.equal(f.fetchImpl.calls.length, calls);
  assert.equal(rt.calls.filter(call => call.action === 'query.alternatives').length, 2);
  assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 1);
  page.onUnload();
});

test('changed explicit choices clear the prior match and make no read until another button tap', async t => {
  const { rt, page } = await match(t);
  assert.equal(page.data.alternativeMatches.length, 1);
  const reads = rt.calls.filter(call => call.action === 'query.alternatives').length;
  page.onToggleAlternative(event('part', SILVER)); page.onToggleAlternative(event('part', BLACK));
  assert.equal(page.data.alternativeMatches.length, 0); assert.equal(page.data.alternativeRead, false);
  assert.equal(rt.calls.filter(call => call.action === 'query.alternatives').length, reads);
  await page.onReadAlternatives();
  assert.equal(page.data.alternativeRead, true); assert.equal(page.data.alternativeMatches.length, 0);
  assert.equal(page.selection.partNumber, BASE); page.onUnload();
});

test('only a later explicit query tap samples and charges the prepared color/store target', async t => {
  const { f, rt, page } = await match(t);
  await page.onPrepareAlternative({ currentTarget: { dataset: { key: page.data.alternativeMatches[0].key } } });
  assert.equal(f.fetchImpl.calls.length, 1); assert.equal(page.data.boot.balance, 2);
  f.advance(1000); await page.onQuery();
  assert.equal(f.fetchImpl.calls.length, 2); assert.equal(page.data.boot.balance, 1);
  const queries = rt.calls.filter(call => call.action === 'query.pickup');
  assert.equal(queries.length, 2); assert.equal(queries[1].payload.partNumber, SILVER);
  assert.deepEqual(copy(queries[1].payload.storeNumbers), ['R578']);
  assert.equal(page.data.alternativeRead, false); assert.equal(page.data.alternativeMatches.length, 0); page.onUnload();
});

test('an expired match is locally rejected before any additional request or target replacement', async t => {
  const { f, rt, page } = await match(t); const key = page.data.alternativeMatches[0].key, target = copy(page.selection), calls = rt.calls.length;
  f.advance(120000);
  await page.onPrepareAlternative({ currentTarget: { dataset: { key } } });
  assert.equal(page.data.alternativeMatches.length, 0); assert.equal(page.data.alternativeColorChoices.length, 3);
  assert.equal(page.data.alternativeCanRead, false, 'the observation window closes but manual conditions remain');
  assert.deepEqual(copy(page.selection), target); assert.equal(rt.calls.length, calls); assert.match(rt.messages.at(-1), /过期/); page.onUnload();
});

test('a newer unknown observation prevents preparation even while the original displayed match is fresh', async t => {
  const { f, rt, page } = await match(t); const key = page.data.alternativeMatches[0].key, target = copy(page.selection);
  await f.observe(SILVER, 'R578', { unknownSince: f.state.now.toISOString() });
  const calls = f.fetchImpl.calls.length;
  await page.onPrepareAlternative({ currentTarget: { dataset: { key } } });
  assert.deepEqual(copy(page.selection), target); assert.equal(page.data.alternativeMatches.length, 0);
  assert.match(rt.messages.at(-1), /过期或发生变化/); assert.equal(f.fetchImpl.calls.length, calls); page.onUnload();
});

for (const transition of ['hide', 'selection', 'sheet', 'querying', 'signing']) test(`late preparation cannot replace the user's selection after ${transition}`, async t => {
  const waiting = deferred(), release = deferred(); let calls = 0;
  const { page } = await match(t, async (action, response) => {
    if (action === 'query.alternatives' && ++calls === 2) { waiting.resolve(); await release.promise; }
    return response;
  });
  const target = copy(page.selection), key = page.data.alternativeMatches[0].key;
  const pending = page.onPrepareAlternative({ currentTarget: { dataset: { key } } }); await waiting.promise;
  if (transition === 'hide') page.onHide();
  else if (transition === 'selection') page.onSelectionInteraction();
  else page.setData({ [transition === 'sheet' ? 'sheetVisible' : transition]: true });
  release.resolve(); await pending;
  assert.deepEqual(copy(page.selection), target); assert.equal(page.data.alternativePreparedNotice, ''); page.onUnload();
});

test('cached or fully refunded results preserve manual choices without exposing the observation read endpoint', async t => {
  const { f, rt, page } = await queried(t);
  page.setData({ resultIsCache: true }); page.refreshAlternativeChoices();
  assert.equal(page.data.alternativeColorChoices.length, 3); assert.equal(page.data.alternativeCanRead, false); await page.onReadAlternatives();
  assert.equal(rt.calls.some(call => call.action === 'query.alternatives'), false);
  page.setData({ resultIsCache: false }); page.querySnapshot = { ...page.querySnapshot, refunded: 1 };
  page.refreshAlternativeChoices(); assert.equal(page.data.alternativeColorChoices.length, 3); assert.equal(page.data.alternativeCanRead, false);
  assert.equal(f.fetchImpl.calls.length, 1); page.onUnload();
});

test('checking a color shows its query action immediately and an empty observation result still leads to a real explicit query', async t => {
  const { f, rt, page } = await queried(t);
  page.onToggleAlternative(event('part', BLACK));
  assert.deepEqual(copy(page.data.alternativeStores), ['R577'], 'the original store is selected by default');
  assert.deepEqual(copy(page.data.alternativeSelectedColors.map(item => item.partNumber)), [BLACK]);
  assert.match(page.data.alternativeSelectionSummary, /黑色.*1 家门店/);
  assert.equal(rt.calls.filter(item => item.action === 'query.pickup').length, 1, 'checking is not querying');
  await page.onReadAlternatives();
  assert.equal(page.data.alternativeMatches.length, 0);
  assert.equal(page.data.alternativeRead, true);
  await page.onQueryAlternative({ currentTarget: { dataset: { part: BLACK } } });
  const queries = rt.calls.filter(item => item.action === 'query.pickup');
  assert.equal(queries.length, 2);
  assert.equal(queries[1].payload.partNumber, BLACK);
  assert.deepEqual(copy(queries[1].payload.storeNumbers), ['R577']);
  assert.equal(page.data.result.product.partNumber, BLACK);
  assert.equal(page.data.boot.balance, 1);
  assert.equal(f.fetchImpl.calls.length, 2);
  page.onUnload();
});

test('observation expiry keeps chosen colors and stores and permits only the explicit charged query', async t => {
  const { f, rt, page } = await queried(t);
  page.onToggleAlternative(event('part', SILVER)); page.onToggleAlternative(event('store', 'R578'));
  f.advance(121000); page.refreshAlternativeChoices();
  assert.equal(page.data.alternativeCanRead, false);
  assert.deepEqual(copy(page.data.alternativeParts), [SILVER]);
  assert.deepEqual(copy(page.data.alternativeStores), ['R577', 'R578']);
  await page.onReadAlternatives();
  assert.equal(rt.calls.filter(item => item.action === 'query.alternatives').length, 0);
  await page.onQueryAlternative({ currentTarget: { dataset: { part: SILVER } } });
  const queries = rt.calls.filter(item => item.action === 'query.pickup');
  assert.equal(queries.length, 2);
  assert.deepEqual(copy(queries[1].payload.storeNumbers), ['R577', 'R578']);
  assert.equal(page.selection.partNumber, SILVER);
  assert.equal(page.data.boot.balance, 1);
  page.onUnload();
});

test('an uncertain manual alternative query retries the same operation without another debit', async t => {
  let queries = 0;
  const { f, rt, page } = await queried(t, (action, response) => {
    if (action === 'query.pickup' && ++queries === 2) throw Object.assign(Error('response lost after debit'), { code: 'call_failed' });
    return response;
  });
  page.onToggleAlternative(event('part', BLACK));
  const tap = { currentTarget: { dataset: { part: BLACK } } };
  await page.onQueryAlternative(tap);
  assert.equal(page.data.querying, false);
  assert.match(page.data.restriction, /不重复扣次/);
  f.advance(121000);
  await page.onQueryAlternative(tap);
  const calls = rt.calls.filter(item => item.action === 'query.pickup');
  assert.equal(calls[1].payload.queryId, calls[2].payload.queryId);
  assert.equal(page.data.result.replayed, true);
  assert.equal(page.data.boot.balance, 1);
  assert.equal(f.fetchImpl.calls.length, 2);
  page.onUnload();
});

test('manual alternatives require an explicitly selected color and valid store count and never bypass account readiness', async t => {
  const { rt, page } = await queried(t);
  const start = rt.calls.length, tap = part => ({ currentTarget: { dataset: { part } } });
  await page.onQueryAlternative(tap(BLACK));
  page.onToggleAlternative(event('part', BLACK));
  page.onToggleAlternative(event('store', 'R577'));
  await page.onQueryAlternative(tap(BLACK));
  page.onToggleAlternative(event('store', 'R577'));
  page.onToggleAlternative(event('store', 'R578')); page.onToggleAlternative(event('store', 'R579')); page.onToggleAlternative(event('store', 'R580'));
  assert.equal(page.data.alternativeStores.length, 3);
  page.setData({ accountReady: false });
  await page.onQueryAlternative(tap(BLACK));
  assert.equal(rt.calls.length, start);
  page.onUnload();
});

test('members use the same explicit manual query without spending finite credits', async t => {
  const { f, page } = await queried(t, null, { member: true });
  page.onToggleAlternative(event('part', BLACK));
  const balance = page.data.boot.balance;
  await page.onQueryAlternative({ currentTarget: { dataset: { part: BLACK } } });
  assert.equal(page.data.result.product.partNumber, BLACK);
  assert.equal(page.data.boot.balance, balance);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, balance);
  page.onUnload();
});

for (const denied of ['insufficient_credits', 'new_product_restricted']) {
  test(`manual alternative queries keep the server's ${denied} gate and show its reason beside the action`, async t => {
    const { f, rt, page } = await queried(t, null, denied === 'new_product_restricted'
      ? { config: { newProductWindows: [{ partNumbers: [BLACK], releaseAt: '2026-09-15T00:00:00.000Z' }] } } : {});
    if (denied === 'insufficient_credits') await f.repo.updateUser(userKeyOf(), { quota: { balance: 0 } });
    page.onToggleAlternative(event('part', BLACK));
    const samples = f.fetchImpl.calls.length;
    await page.onQueryAlternative({ currentTarget: { dataset: { part: BLACK } } });
    assert.equal(rt.calls.filter(item => item.action === 'query.pickup').length, 2);
    assert.equal(page.data.restrictionReason, denied);
    assert.equal(page.data.alternativeQueryNote, page.data.restriction);
    assert.ok(page.data.alternativeQueryNote.length > 0);
    assert.equal(f.fetchImpl.calls.length, samples);
    assert.equal(page.data.result.product.partNumber, BASE, 'denial retains the confirmed original result');
    page.onUnload();
  });
}

test('repeated manual alternative taps while a query is pending make one request', async t => {
  const entered = deferred(), release = deferred(); let queries = 0;
  const { rt, page } = await queried(t, async (action, response) => {
    if (action === 'query.pickup' && ++queries === 2) { entered.resolve(); await release.promise; }
    return response;
  });
  page.onToggleAlternative(event('part', BLACK));
  const tap = { currentTarget: { dataset: { part: BLACK } } };
  const pending = page.onQueryAlternative(tap); await entered.promise;
  assert.equal(page.data.alternativeQueryPart, BLACK);
  await page.onQueryAlternative(tap);
  assert.equal(rt.calls.filter(item => item.action === 'query.pickup').length, 2);
  release.resolve(); await pending;
  assert.equal(page.data.querying, false);
  assert.equal(page.data.alternativeQueryPart, '');
  page.onUnload();
});

test('a delayed result from the old query cannot appear under a newly completed query', async t => {
  const waiting = deferred(), release = deferred();
  const { f, page } = await queried(t, async (action, response) => {
    if (action === 'query.alternatives') { waiting.resolve(); await release.promise; }
    return response;
  });
  page.onToggleAlternative(event('part', SILVER)); page.onToggleAlternative(event('store', 'R578'));
  const pending = page.onReadAlternatives(); await waiting.promise;
  page.querySnapshot = { ...page.querySnapshot, queryId: 'a-new-completed-query' };
  page.alternativeResponse = null; page.setData({ alternativeRead: false });
  release.resolve(); await pending;
  assert.equal(page.data.alternativeMatches.length, 0); assert.equal(page.data.alternativeRead, false);
  assert.equal(f.fetchImpl.calls.length, 1); page.onUnload();
});
