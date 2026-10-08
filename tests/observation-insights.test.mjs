import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { historyInsights, availableStoreChoices } = require('../miniprogram/utils/observation-insights.js');
const seed = require('../miniprogram/config/catalog-seed.js');
const product = seed.products.find(item => item.supported);
const now = Date.parse('2026-10-05T10:00:00Z');
const iso = offset => new Date(now + offset).toISOString();
const copy = value => JSON.parse(JSON.stringify(value));
const catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: Object.fromEntries(seed.stores.map(store => [store.storeNumber, store])) };
const account = { membership: { active: false }, newProductWindows: [] };
const response = () => ({ ok: true, product, queriedAt: iso(0), balance: 2, quotaRevision: 1, results: [
  { storeNumber: 'R577', status: 'available', observedAt: iso(-15000) },
  { storeNumber: 'R639', status: 'available', observedAt: iso(-30000) },
  { storeNumber: 'R320', status: 'unavailable', observedAt: iso(-5000) },
] });

test('one-day history digest separates full counters, loaded events and actual sample time coverage', () => {
  const history = { dayKey: '2026-10-05', summary: { restocks: 7 }, pagination: { total: 9, hasMore: true, snapshotAt: '2026-10-05T14:00:00Z' }, events: [
    { id: 'morning', type: 'restock_confirmed', detectedAt: '2026-10-05T01:00:00Z', storeNumber: 'R577' },
    { id: 'evening', type: 'restock_confirmed', detectedAt: '2026-10-05T12:00:00Z', storeNumber: 'R639' },
    { id: 'recovery', type: 'recovered_available', detectedAt: '2026-10-05T13:00:00Z', storeNumber: 'R577' },
  ], observationCoverage: { stores: [{ storeNumber: 'R577', firstObservedAt: '2026-10-04T17:00:00Z', lastObservedAt: '2026-10-05T13:00:00Z' }] } };
  const insight = historyInsights(history, { storeNumbers: ['R577', 'R639'] }, catalog);
  assert.match(insight.scopeText, /2026-10-05.*2 家.*单日/);
  assert.equal(insight.recordedText, '该日期已记录确认补货 7 次');
  assert.match(insight.pageText, /已加载 3 \/ 9/);
  assert.deepEqual(insight.timeBands.map(item => item.count), [0, 1, 0, 1]);
  assert.match(insight.sampleWindowText, /01:00:00 — 21:00:00.*不代表连续观测/);
  assert.match(insight.lastRestockText, /20:00:00/);
  assert.doesNotMatch(JSON.stringify(insight), /概率|预测|未来|近 7 天/);
});

test('history insights reject cross-date, cross-store, post-snapshot and duplicate event rows', () => {
  const event = { id: 'same', type: 'restock_confirmed', detectedAt: '2026-10-05T01:00:00Z', storeNumber: 'R577' };
  const insight = historyInsights({ dayKey: '2026-10-05', summary: {}, pagination: { total: 1, snapshotAt: '2026-10-05T02:00:00Z' }, events: [event, event,
    { ...event, id: 'old', detectedAt: '2026-10-04T01:00:00Z' }, { ...event, id: 'future', detectedAt: '2026-10-05T03:00:00Z' },
    { ...event, id: 'other-store', storeNumber: 'R639' }, { ...event, id: 'invalid', detectedAt: 'invalid' }],
    observationCoverage: { stores: [{ storeNumber: 'R577', firstObservedAt: '2026-10-04T01:00:00Z', lastObservedAt: '2026-10-04T02:00:00Z' }] },
  }, { storeNumbers: ['R577'] }, catalog);
  assert.match(insight.pageText, /已加载 1 \/ 1/);
  assert.equal(insight.timeBands.reduce((sum, item) => sum + item.count, 0), 1);
  assert.match(insight.sampleWindowText, /缺少有效/);
});

test('empty or untracked history never turns missing evidence into zero restocks or seven-day coverage', () => {
  const insight = historyInsights({ dayKey: '2026-10-05', summary: { restocks: 0 }, events: [], pagination: { total: 0 } }, { storeNumbers: [] });
  assert.equal(insight.recordedText, '尚无可汇总的确认补货记录');
  assert.equal(insight.timeBands.length, 0);
  assert.match(insight.scopeText, /各地已有记录，未限定门店/);
  assert.match(insight.noRestockText, /不代表当天没有补货/);
  assert.match(insight.sampleWindowText, /无法判断全天覆盖/);
});

test('store alternatives use only catalog-valid recent available observations from the same response', () => {
  const snapshot = response();
  snapshot.results.push({ storeNumber: 'R999', status: 'available', observedAt: iso(0) },
    { storeNumber: 'R401', status: 'available', observedAt: iso(-120001) },
    { storeNumber: 'R320', status: 'available', observedAt: iso(1000) });
  assert.deepEqual(availableStoreChoices(snapshot, catalog, account, now).map(item => item.storeNumber), ['R577', 'R639']);
  for (const patch of [{ isStale: true }, { unknownSince: iso(-1000) }, { status: 'unknown' }, { restricted: true }, { knownAt: iso(-130000) }]) {
    const changed = response(); changed.results = [{ ...changed.results[0], ...patch }];
    assert.equal(availableStoreChoices(changed, catalog, account, now).length, 0);
  }
  assert.equal(availableStoreChoices(snapshot, { ...catalog, productByPart: {} }, account, now).length, 0);
});

test('store alternatives respect member expiry and configured family or SKU release restrictions', () => {
  for (const window of [{ familyKey: product.familyKey, releaseAt: iso(-86400000) }, { partNumbers: [product.partNumber], releaseAt: iso(-86400000) }]) {
    const restricted = { ...account, newProductWindows: [window] };
    assert.equal(availableStoreChoices(response(), catalog, restricted, now).length, 0);
    assert.equal(availableStoreChoices(response(), catalog, { ...restricted, membership: { active: true, expiresAt: iso(86400000) } }, now).length, 2);
    assert.equal(availableStoreChoices(response(), catalog, { ...restricted, membership: { active: true, expiresAt: iso(-1) } }, now).length, 0);
  }
  assert.equal(availableStoreChoices(response(), catalog, { membership: { active: false } }, now).length, 0, 'missing restriction data cannot grant a new recommendation');
});

async function queried(t, { cached = false } = {}) {
  let time = now;
  t.mock.method(Date, 'now', () => time);
  const rt = runtime(async action => {
    if (action === 'user.bootstrap') return { ...account, quota: { balance: 3, queryCost: 1, signedInToday: true, revision: 0 },
      limits: { queryMaxStores: 3 }, collector: { state: 'running' }, followCount: 0 };
    if (action === 'catalog.get') return { unchanged: true };
    if (action === 'query.pickup') return response();
    throw Error(action);
  });
  const saved = { partNumber: product.partNumber, storeNumbers: ['R577', 'R639', 'R320'] };
  rt.storage.set('gxs_query_selection_v1', saved);
  if (cached) rt.storage.set('gxs_query_result_v1', response());
  const page = rt.instance('pages/query/index.js');
  await page.onLoad();
  if (!cached) await page.onQuery();
  return { rt, page, advance: ms => { time += ms; } };
}

test('user explicitly chooses acceptable observed stores without requests, debits or automatic follows', async t => {
  const { rt, page } = await queried(t);
  assert.equal(page.data.storeChoices.length, 2);
  assert.deepEqual(copy(page.data.acceptedStoreNumbers), []);
  const calls = rt.calls.length, original = copy(page.selection.storeNumbers);
  page.onToggleAcceptableStore({ currentTarget: { dataset: { store: 'R639' } } });
  assert.deepEqual(copy(page.selection.storeNumbers), original, 'checking alone does not change the query target');
  page.onUseAcceptableStores();
  assert.deepEqual(copy(page.selection.storeNumbers), ['R639']);
  assert.equal(page.data.result.results.length, 3, 'the existing result keeps its original scope');
  assert.equal(page.data.resultTargetDifferent, true);
  assert.match(page.data.alternativeNotice, /尚未查询或扣次/);
  assert.equal(rt.calls.length, calls);
  assert.deepEqual(copy(rt.storage.get('gxs_query_selection_v1').storeNumbers), ['R639']);
  page.onUnload();
});

test('expired observations are rechecked at the tap and never silently replace the selection', async t => {
  const { rt, page, advance } = await queried(t);
  page.onToggleAcceptableStore({ currentTarget: { dataset: { store: 'R577' } } });
  const original = copy(page.selection.storeNumbers), calls = rt.calls.length;
  advance(120001);
  page.onUseAcceptableStores();
  assert.deepEqual(copy(page.selection.storeNumbers), original);
  assert.equal(page.data.storeChoices.length, 0);
  assert.equal(rt.calls.length, calls);
  assert.match(rt.messages.at(-1), /过期/);
  page.onUnload();
});

test('a cached result never opens a new alternative-store recommendation', async t => {
  const { rt, page } = await queried(t, { cached: true });
  assert.equal(page.data.resultIsCache, true);
  assert.equal(page.data.storeChoices.length, 0);
  assert.equal(rt.calls.some(call => call.action === 'query.pickup'), false);
  page.onUnload();
});
