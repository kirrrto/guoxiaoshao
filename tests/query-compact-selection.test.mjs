import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const seed = require('../miniprogram/config/catalog-seed.js');
const product = seed.products.find(p => p.model === 'iPhone 18 Pro' && p.attributes.capacity === '512GB' && p.attributes.color === '银色');
const otherProduct = seed.products.find(p => p.model === 'iPhone 18 Pro Max' && p.attributes.capacity === '512GB' && p.attributes.color === '银色');
const saved = () => ({ partNumber: product.partNumber, storeNumbers: ['R577', 'R639'] });
const boot = () => ({ membership: { active: false }, quota: { balance: 4, queryCost: 1, signedInToday: true },
  limits: { queryMaxStores: 3 }, collector: { state: 'running' }, followCount: 0 });
const copy = value => JSON.parse(JSON.stringify(value));
const response = payload => ({ ok: true, product: seed.products.find(p => p.partNumber === payload.partNumber), balance: 3,
  queriedAt: new Date().toISOString(), results: payload.storeNumbers.map(storeNumber => ({ storeNumber, status: 'available', observedAt: new Date().toISOString() })) });

async function opened({ value = saved(), cache, query = async payload => response(payload), getCurrentPages } = {}) {
  const rt = runtime(async (action, payload) => action === 'user.bootstrap' ? boot()
    : action === 'catalog.get' ? { unchanged: true } : action === 'query.pickup' ? query(payload) : {}, { getCurrentPages });
  if (value) rt.storage.set('gxs_query_selection_v1', value);
  if (cache) rt.storage.set('gxs_query_result_v1', cache);
  const page = rt.instance('pages/query/index.js');
  await page.onLoad();
  const ticks = [], scrolls = [];
  rt.wx.nextTick = callback => ticks.push(callback);
  rt.wx.pageScrollTo = options => scrolls.push(options);
  return { rt, page, ticks, scrolls };
}

function select(page, partNumber = otherProduct.partNumber, storeNumbers = ['R577']) {
  page.onPickerChange({ detail: { partNumber, product: page.catalog.productByPart[partNumber],
    storeNumbers, stores: storeNumbers.map(number => page.catalog.storeByNumber[number]) } });
}

test('valid saved selection opens as a compact exact-product and store summary without querying', async () => {
  const { rt, page, scrolls } = await opened();
  assert.equal(page.data.selectionExpanded, false);
  assert.equal(page.data.selectionCanCollapse, true);
  assert.equal(page.selection.partNumber, product.partNumber);
  assert.deepEqual(copy(page.selection.storeNumbers), ['R577', 'R639']);
  assert.equal(page.data.selectionSummary.title, product.title);
  assert.ok(page.data.selectionSummary.imageUrl);
  assert.equal(page.data.selectionSummary.cityLabel, '广州 · 2 家门店');
  assert.equal(page.data.selectionSummary.storeLabel, '天环广场、珠江新城');
  assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 0);
  assert.equal(scrolls.length, 0);
  page.onUnload();
});

test('first visit and invalid or incomplete saved selections stay expanded for review', async () => {
  const unsupported = seed.products.find(p => !p.supported);
  for (const value of [null, { partNumber: 'REMOVED', storeNumbers: ['R577'] },
    { partNumber: unsupported.partNumber, storeNumbers: ['R577'] },
    { partNumber: product.partNumber, storeNumbers: [] },
    { partNumber: product.partNumber, storeNumbers: ['REMOVED'] },
    { partNumber: product.partNumber, storeNumbers: ['R577', 'REMOVED'] }]) {
    const { rt, page } = await opened({ value });
    assert.equal(page.data.selectionExpanded, true, JSON.stringify(value));
    assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 0);
    page.onUnload();
  }
});

test('explicit editing retains the mounted picker value and catalog refresh never closes it', async () => {
  const { rt, page } = await opened();
  const pickerValue = copy(page.data.pickerValue);
  page.onEditSelection();
  assert.equal(page.data.selectionExpanded, true);
  select(page);
  page.applyCatalog({ ...page.catalog, version: `${page.catalog.version}-refresh` });
  assert.equal(page.data.selectionExpanded, true);
  assert.equal(page.selection.partNumber, otherProduct.partNumber);
  assert.deepEqual(copy(page.data.pickerValue), pickerValue, 'opening and closing must not reapply the original picker value');
  page.onDoneSelection();
  assert.equal(page.data.selectionExpanded, false);
  assert.equal(page.data.selectionSummary.title, otherProduct.title);
  assert.deepEqual(rt.storage.get('gxs_query_selection_v1'), { partNumber: otherProduct.partNumber, storeNumbers: ['R577'] });
  assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 0);
  page.onUnload();
});

test('a disappeared catalog SKU expands its summary and cannot be silently confirmed', async () => {
  const { page, rt } = await opened();
  const productByPart = { ...page.catalog.productByPart };
  delete productByPart[product.partNumber];
  page.applyCatalog({ ...page.catalog, productByPart, version: 'removed-sku' });
  assert.equal(page.data.selectionExpanded, true);
  assert.equal(page.data.selectionCanCollapse, false);
  page.onDoneSelection();
  assert.equal(page.data.selectionExpanded, true);
  assert.match(rt.messages.at(-1), /有效门店/);
  assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 0);
  page.onUnload();
});

test('old results are marked separately and their requery and follow retain their own targets', async () => {
  const original = saved();
  const { page, rt } = await opened({ cache: response(original) });
  assert.equal(page.data.resultTargetDifferent, false);
  select(page, product.partNumber, ['R639', 'R577']);
  assert.equal(page.data.resultTargetDifferent, false, 'store order alone does not make a different target');
  select(page);
  assert.equal(page.data.resultTargetDifferent, true);
  assert.equal(page.data.result.product.partNumber, product.partNumber);
  assert.deepEqual(copy(page.data.result.results.map(row => row.storeNumber)), original.storeNumbers);
  page.data.boot.member = true;
  page.onAddFollow();
  assert.deepEqual(copy(rt.app.globalData.pendingFollow), original);
  await page.onRequery();
  const call = rt.calls.find(call => call.action === 'query.pickup');
  assert.equal(call.payload.partNumber, original.partNumber);
  assert.deepEqual(call.payload.storeNumbers, original.storeNumbers);
  assert.equal(page.selection.partNumber, otherProduct.partNumber);
  assert.equal(page.data.resultTargetDifferent, true);
  page.onUnload();
});

test('only successful explicit queries schedule result focus; snapshots and polling keep position', async () => {
  const { page, rt, ticks, scrolls } = await opened({ cache: response(saved()) });
  page.visible = true;
  page.refreshQuerySnapshot();
  page.startFollowPolling();
  await rt.nextTimer();
  assert.equal(ticks.length, 0);
  assert.equal(scrolls.length, 0);
  await page.onQuery();
  assert.equal(ticks.length, 1);
  assert.equal(scrolls.length, 0);
  ticks.shift()();
  assert.equal(scrolls.length, 1);
  assert.equal(scrolls[0].selector, '#query-result');
  assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 1);
  page.onHide();
  page.onUnload();
});

test('editing while a query is pending preserves the new selection and cancels late result focus', async () => {
  let resolveQuery;
  const { page, ticks, scrolls } = await opened({ query: payload => new Promise(resolve => { resolveQuery = () => resolve(response(payload)); }) });
  page.visible = true;
  const pending = page.onQuery();
  page.onEditSelection();
  select(page);
  page.onDoneSelection();
  resolveQuery();
  await pending;
  ticks.splice(0).forEach(callback => callback());
  assert.equal(scrolls.length, 0);
  assert.equal(page.selection.partNumber, otherProduct.partNumber);
  assert.equal(page.data.selectionExpanded, false);
  assert.equal(page.data.result.product.partNumber, product.partNumber);
  assert.equal(page.data.resultTargetDifferent, true);
  page.onUnload();
});

test('leaving and returning during a query prevents its delayed result from moving the new viewport', async () => {
  let resolveQuery;
  const { page, ticks, scrolls } = await opened({ query: payload => new Promise(resolve => { resolveQuery = () => resolve(response(payload)); }) });
  page.visible = true;
  const pending = page.onQuery();
  page.onHide();
  await page.onShow();
  resolveQuery();
  await pending;
  ticks.splice(0).forEach(callback => callback());
  assert.equal(scrolls.length, 0);
  page.onHide();
  page.onUnload();
});

test('queued focus checks interaction and visibility again after the native render tick', async () => {
  for (const cancel of [page => page.onEditSelection(), page => page.onSelectionInteraction(), page => page.onHide()]) {
    const { page, ticks, scrolls } = await opened();
    page.visible = true;
    await page.onQuery();
    assert.equal(ticks.length, 1);
    cancel(page);
    ticks.shift()();
    assert.equal(scrolls.length, 0);
    page.onUnload();
  }
});

test('optional focus APIs missing or failing do not discard a successful query', async () => {
  for (const behavior of ['no-next-tick', 'no-scroll', 'scroll-throws', 'tick-throws']) {
    const { page, rt, ticks } = await opened();
    page.visible = true;
    if (behavior === 'no-next-tick') delete rt.wx.nextTick;
    if (behavior === 'no-scroll') delete rt.wx.pageScrollTo;
    if (behavior === 'scroll-throws') rt.wx.pageScrollTo = () => { throw Error('not available'); };
    if (behavior === 'tick-throws') rt.wx.nextTick = () => { throw Error('not available'); };
    await page.onQuery();
    ticks.splice(0).forEach(callback => callback());
    assert.equal(page.data.result.product.partNumber, product.partNumber);
    assert.equal(page.data.querying, false);
    assert.ok(rt.storage.get('gxs_query_result_v1'));
    assert.equal(rt.messages.length, 0);
    page.onUnload();
  }
});

test('denied queries never schedule focus or create a successful result', async () => {
  const { page, ticks, scrolls } = await opened({ query: async () => ({ ok: false, reason: 'quota_empty', balance: 0 }) });
  page.visible = true;
  await page.onQuery();
  assert.equal(page.data.result, null);
  assert.equal(ticks.length, 0);
  assert.equal(scrolls.length, 0);
  page.onUnload();
});

test('refunded upstream failures without a product keep the requested identity and show the real failure', async () => {
  for (const reason of ['query_failed', 'upstream_paused', 'upstream_budget_limited']) {
    const { page, rt, ticks } = await opened({ query: async () => ({ ok: false, reason, results: [],
      balance: 4, charged: 1, refunded: 1, retryAfterMs: 1201, queriedAt: new Date().toISOString() }) });
    page.visible = true;
    await page.onQuery();
    assert.equal(page.data.result.product.partNumber, product.partNumber, reason);
    assert.equal(page.data.result.ok, false);
    assert.equal(page.data.result.results.length, 0);
    assert.equal(page.data.boot.balance, 4);
    assert.equal(page.data.querying, false);
    assert.equal(rt.storage.has('gxs_pending_q_v1'), false, 'confirmed failed requests must not remain uncertain');
    assert.match(page.data.restriction, /2 秒后重试/);
    assert.doesNotMatch(page.data.restriction, /结果尚未确认/);
    assert.deepEqual(rt.messages, ['本次未取得有效结果，已返还次数']);
    assert.equal(ticks.length, 0, 'failed requests do not scroll as a success');
    assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 1);
    page.onUnload();
  }
});

test('a partially guarded response retains both store states and explains the retry delay without auto-querying', async () => {
  const { page, rt } = await opened({ query: async payload => ({ ...response(payload), partial: true, retryAfterMs: 9991,
    charged: 1, refunded: 0, results: [
      { storeNumber: 'R577', status: 'available', observedAt: new Date().toISOString() },
      { storeNumber: 'R639', status: 'unknown', observedAt: new Date().toISOString(), reason: { code: 'upstream_paused', message: '上游暂停' } },
    ] }) });
  await page.onQuery();
  assert.equal(page.data.result.ok, true);
  assert.deepEqual(page.data.result.results.map(row => row.status), ['available', 'unknown']);
  assert.match(page.data.restriction, /部分门店暂未查询成功/);
  assert.match(page.data.restriction, /10 秒后重试/);
  assert.equal(page.data.boot.balance, 3);
  assert.equal(page.data.querying, false);
  assert.equal(rt.storage.has('gxs_pending_q_v1'), false);
  assert.equal(rt.messages.length, 0);
  assert.equal(rt.calls.filter(call => call.action === 'query.pickup').length, 1, 'partial results must not initiate another charged query');
  page.onUnload();
});

test('a changed active route blocks queued focus even before its hide callback arrives', async () => {
  let route = 'pages/query/index';
  const { page, ticks, scrolls } = await opened({ getCurrentPages: () => [{ route }] });
  page.visible = true;
  await page.onQuery();
  route = 'pages/follow/index';
  ticks.shift()();
  assert.equal(scrolls.length, 0);
  page.onUnload();
});

test('an older queued query focus cannot run after a newer explicit query has finished', async () => {
  const { page, rt, ticks, scrolls } = await opened();
  page.visible = true;
  await page.onQuery();
  await page.onQuery();
  assert.equal(ticks.length, 2);
  ticks.shift()();
  assert.equal(scrolls.length, 0);
  ticks.shift()();
  assert.equal(scrolls.length, 1);
  const calls = rt.calls.filter(call => call.action === 'query.pickup');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].payload.queryId, calls[1].payload.queryId);
  page.onUnload();
});
