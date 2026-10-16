import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const seed = require('../miniprogram/config/catalog-seed.js');
const product = seed.products.find(item => item.supported);
const other = seed.products.find(item => item.supported && item.partNumber !== product.partNumber);
const copy = value => JSON.parse(JSON.stringify(value));
const quota = (extra = {}) => ({ balance: 0, queryCost: 1, signedInToday: false, revision: 0, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

async function opened({ signin, query, catalog, options, saved, cached, realApp = false, member = false, accountQuota = quota() } = {}) {
  const rt = runtime(async (action, payload) => {
    if (action === 'user.bootstrap') return { membership: { active: member }, quota: copy(accountQuota),
      limits: { queryMaxStores: 3 }, collector: { state: 'running' }, followCount: 0 };
    if (action === 'catalog.get') return catalog ? catalog(payload) : { unchanged: true };
    if (action === 'quota.signin') return signin(payload);
    if (action === 'query.pickup') return query(payload);
    throw Error(`Unexpected action: ${action}`);
  });
  if (realApp) rt.load('app.js');
  if (saved) rt.storage.set('gxs_query_selection_v1', saved);
  if (cached) rt.storage.set('gxs_query_result_v1', cached);
  const page = rt.instance('pages/query/index.js');
  await page.onLoad(options);
  return { rt, page };
}

test('home signin needs an explicit tap, deduplicates taps, keeps selection and publishes confirmed quota', async () => {
  const pending = deferred();
  const saved = { partNumber: product.partNumber, storeNumbers: ['R577'] };
  const { rt, page } = await opened({ saved, signin: () => pending.promise });
  const store = rt.load('utils/store.js'), received = [];
  store.subscribeQuota(value => received.push(value));
  assert.equal(rt.calls.filter(item => item.action === 'quota.signin').length, 0);
  page.setData({ restriction: '次数不足', restrictionReason: 'insufficient_credits' });
  const first = page.onSignin();
  await page.onSignin();
  assert.equal(page.data.signing, true);
  assert.equal(rt.calls.filter(item => item.action === 'quota.signin').length, 1);
  pending.resolve({ granted: 1, quota: quota({ balance: 1, revision: 1, signedInToday: true }) });
  await first;
  assert.equal(page.data.boot.balance, 1);
  assert.equal(page.data.boot.signedInToday, true);
  assert.equal(page.data.restriction, null);
  assert.equal(page.data.signing, false);
  assert.equal(received.length, 1);
  assert.equal(rt.app.globalData.bootstrap.quota.balance, 1);
  assert.equal(page.selection.partNumber, saved.partNumber);
  assert.deepEqual(copy(page.selection.storeNumbers), saved.storeNumbers);
  assert.equal(rt.calls.some(item => item.action === 'query.pickup'), false);
});

test('home signin failure remains recoverable and never invents a reward', async () => {
  let attempt = 0;
  const { rt, page } = await opened({ signin: async () => {
    if (++attempt === 1) throw { code: 'call_failed', message: 'request timeout' };
    return { granted: 0, reason: 'already_signed_in', quota: quota({ balance: 1, revision: 1, signedInToday: true }) };
  } });
  await page.onSignin();
  assert.equal(page.data.boot.balance, 0);
  assert.equal(page.data.signing, false);
  assert.match(page.data.signinError, /重试/);
  await page.onSignin();
  assert.equal(page.data.boot.balance, 1);
  assert.equal(page.data.signinError, null);
  assert.equal(attempt, 2);
  assert.equal(rt.messages.some(item => /签到成功/.test(item.title || '')), false);
});

test('home signin cannot overwrite a later quota revision or mutate an unloaded page', async () => {
  const pending = deferred();
  const { rt, page } = await opened({ signin: () => pending.promise });
  const store = rt.load('utils/store.js');
  const action = page.onSignin();
  store.publishQuota(quota({ balance: 2, revision: 2, signedInToday: true }));
  pending.resolve({ granted: 1, quota: quota({ balance: 1, revision: 1, signedInToday: true }) });
  await action;
  assert.equal(page.data.boot.balance, 2);
  page.onUnload();
  const snapshot = copy(page.data);
  store.publishQuota(quota({ balance: 3, revision: 3, signedInToday: true }));
  assert.deepEqual(copy(page.data), snapshot);
});

test('membership and already-signed-in states cannot trigger home rewards', async () => {
  for (const state of [{ member: true }, { accountQuota: quota({ signedInToday: true }) }]) {
    const { rt, page } = await opened(state);
    await page.onSignin();
    assert.equal(rt.calls.some(item => item.action === 'quota.signin'), false);
  }
});

test('friend share restores the exact public target without querying or replacing a saved target', async () => {
  const saved = { partNumber: other.partNumber, storeNumbers: ['R639'] };
  const { rt, page } = await opened({ saved });
  page.onPickerChange({ detail: { partNumber: product.partNumber, product,
    storeNumbers: ['R577', 'R639'], stores: [] } });
  rt.app.globalData.bootstrap.secret = 'PRIVATE-ACCOUNT-DATA';
  const share = page.onShareAppMessage();
  assert.doesNotMatch(share.path, /PRIVATE|balance|openid|available|queryId/);
  const options = Object.fromEntries(new URLSearchParams(share.path.split('?')[1]));
  const recipient = await opened({ options, saved, cached: { product: other, queriedAt: '2026-10-01T00:00:00Z',
    results: [{ storeNumber: 'R639', status: 'available', observedAt: '2026-10-01T00:00:00Z' }] } });
  assert.equal(recipient.page.selection.partNumber, product.partNumber);
  assert.deepEqual(copy(recipient.page.selection.storeNumbers), ['R577', 'R639']);
  assert.equal(recipient.page.data.sharedSelection, true);
  assert.equal(recipient.page.data.resultTargetDifferent, true);
  assert.deepEqual(copy(recipient.rt.storage.get('gxs_query_selection_v1')), saved);
  assert.equal(recipient.rt.calls.some(item => ['query.pickup', 'quota.signin', 'follow.save'].includes(item.action)), false);
});

test('encoded share parameters work and malformed, unknown or duplicate targets keep the local choice', async () => {
  const saved = { partNumber: other.partNumber, storeNumbers: ['R639'] };
  const valid = await opened({ saved, options: { gxsPart: encodeURIComponent(product.partNumber), gxsStores: 'R577%2CR639' } });
  assert.equal(valid.page.selection.partNumber, product.partNumber);
  for (const options of [
    { gxsPart: '%E0%A4%A', gxsStores: 'R577' },
    { gxsPart: '__proto__', gxsStores: 'R577' },
    { gxsPart: product.partNumber, gxsStores: 'R000' },
    { gxsPart: product.partNumber, gxsStores: 'R577,R577' },
    { gxsPart: product.partNumber, gxsStores: 'R577,R639,R401,R320' },
    { gxsPart: product.partNumber, gxsStores: ['R577'] },
  ]) {
    const { page } = await opened({ saved, options });
    assert.equal(page.selection.partNumber, other.partNumber);
    assert.equal(page.data.sharedSelection, false);
  }
});

test('home signin blocks all query entry points until its quota response is applied', async () => {
  const pending = deferred();
  const saved = { partNumber: product.partNumber, storeNumbers: ['R577'] };
  const { rt, page } = await opened({ saved, signin: () => pending.promise,
    cached: { product, results: [{ storeNumber: 'R577' }] },
    query: async () => ({ ok: true, balance: 0, quotaRevision: 2, product, queriedAt: new Date().toISOString(), results: [] }) });
  const signing = page.onSignin();
  await page.onQuery(); await page.onRequery(); await page.performQuery(page.selection);
  assert.equal(rt.calls.some(item => item.action === 'query.pickup'), false);
  pending.resolve({ granted: 1, quota: quota({ balance: 1, revision: 1, signedInToday: true }) });
  await signing;
  assert.equal(page.data.boot.balance, 1);
  await page.onQuery();
  assert.equal(page.data.boot.balance, 0);
  assert.equal(rt.calls.filter(item => item.action === 'query.pickup').length, 1);
});

test('an in-flight query also blocks signin until its response settles', async () => {
  const pending = deferred();
  const { rt, page } = await opened({ saved: { partNumber: product.partNumber, storeNumbers: ['R577'] },
    accountQuota: quota({ balance: 1 }), query: () => pending.promise });
  const querying = page.onQuery();
  await page.onSignin();
  assert.equal(rt.calls.some(item => item.action === 'quota.signin'), false);
  pending.resolve({ ok: true, balance: 0, quotaRevision: 1, product, queriedAt: new Date().toISOString(), results: [] });
  await querying;
  assert.equal(page.data.querying, false);
});

test('App captures a warm share for an existing tab once without a query or local-choice overwrite', async () => {
  const saved = { partNumber: other.partNumber, storeNumbers: ['R639'] };
  const { rt, page } = await opened({ realApp: true, saved });
  rt.app.onShow({ path: 'pages/query/index', query: { gxsPart: product.partNumber, gxsStores: 'R577' } });
  await page.onShow();
  assert.equal(page.selection.partNumber, product.partNumber);
  assert.equal(page.data.sharedSelection, true);
  assert.equal(rt.app.globalData.pendingSharedTarget, null);
  assert.deepEqual(copy(rt.storage.get('gxs_query_selection_v1')), saved);
  page.onPickerChange({ detail: { ...saved, product: other, stores: [] } });
  rt.app.onShow({ path: 'pages/query/index', query: {} });
  await page.onShow();
  assert.equal(page.selection.partNumber, other.partNumber, 'normal re-entry does not replay the old share');
  assert.equal(rt.calls.some(item => ['query.pickup', 'quota.signin'].includes(item.action)), false);
  page.onUnload();
});

test('App accepts valid cold share targets and ignores malformed or unrelated route targets', () => {
  const rt = runtime(); rt.load('app.js');
  const options = { scene: 1154, path: 'pages/query/index', query: { gxsPart: product.partNumber, gxsStores: 'R577' } };
  rt.app.onLaunch(options);
  assert.equal(rt.app.globalData.pendingSharedTarget.partNumber, product.partNumber);
  rt.app.globalData.pendingSharedTarget = null;
  rt.app.onShow({ ...options, path: 'pages/follow/index' });
  rt.app.onShow({ ...options, query: { gxsPart: '%bad', gxsStores: 'R577' } });
  assert.equal(rt.app.globalData.pendingSharedTarget, null);
});

test('a warm share arriving during editing or querying waits for an explicit switch', async () => {
  for (const mode of ['editing', 'querying']) {
    const response = deferred(), saved = { partNumber: other.partNumber, storeNumbers: ['R639'] };
    const { rt, page } = await opened({ realApp: true, saved, accountQuota: quota({ balance: 1 }), query: () => response.promise });
    let querying;
    if (mode === 'editing') page.onEditSelection();
    else querying = page.onQuery();
    rt.app.onShow({ path: 'pages/query/index', query: { gxsPart: product.partNumber, gxsStores: 'R577' } });
    await page.onShow();
    assert.equal(page.selection.partNumber, other.partNumber, mode);
    assert.equal(page.data.sharedTargetPending, true, mode);
    await page.onLoadSharedTarget();
    assert.equal(page.selection.partNumber, other.partNumber, 'busy work cannot be replaced');
    if (mode === 'editing') page.onCloseSelection();
    else {
      response.resolve({ ok: true, balance: 0, quotaRevision: 1, product: other, queriedAt: new Date().toISOString(), results: [] });
      await querying;
    }
    assert.equal(page.selection.partNumber, other.partNumber, 'finishing the action does not switch automatically');
    const before = rt.calls.filter(item => item.action === 'query.pickup').length;
    await page.onLoadSharedTarget();
    assert.equal(page.selection.partNumber, product.partNumber, mode);
    assert.equal(page.data.sharedTargetPending, false);
    assert.equal(rt.calls.filter(item => item.action === 'query.pickup').length, before);
    page.onUnload();
  }
});

test('a new shared product resolves after the catalog arrives only while the user has not interacted', async () => {
  const newProduct = { ...product, partNumber: 'SHAREDNEW/A', title: 'New shared product' };
  const newCatalog = { ...copy(seed), version: 'new-share-catalog', products: [...copy(seed.products), newProduct] };
  for (const interacted of [false, true]) {
    const pending = deferred(), saved = { partNumber: other.partNumber, storeNumbers: ['R639'] };
    const { rt, page } = await opened({ saved, catalog: () => pending.promise,
      options: { gxsPart: newProduct.partNumber, gxsStores: 'R577' } });
    assert.equal(page.selection.partNumber, other.partNumber);
    assert.equal(page.data.sharedTargetPending, true);
    assert.equal(page.data.sharedTargetReady, false);
    if (interacted) { page.onEditSelection(); page.onCloseSelection(); }
    pending.resolve(newCatalog); await settle();
    assert.equal(page.selection.partNumber, interacted ? other.partNumber : newProduct.partNumber);
    if (interacted) {
      assert.equal(page.data.sharedTargetReady, true);
      await page.onLoadSharedTarget();
      assert.equal(page.selection.partNumber, newProduct.partNumber);
    }
    assert.deepEqual(copy(rt.storage.get('gxs_query_selection_v1')), saved);
    assert.equal(rt.calls.some(item => item.action === 'query.pickup'), false);
    page.onUnload();
  }
});

test('an explicit share-directory retry stays deferred if the user starts editing before it finishes', async () => {
  const newProduct = { ...product, partNumber: 'LATESHARE/A', title: 'Late shared product' };
  const pending = deferred(), saved = { partNumber: other.partNumber, storeNumbers: ['R639'] };
  let reads = 0;
  const { page } = await opened({ saved, catalog: () => ++reads === 1 ? { unchanged: true } : pending.promise,
    options: { gxsPart: newProduct.partNumber, gxsStores: 'R577' } });
  const retrying = page.onLoadSharedTarget();
  page.onEditSelection();
  pending.resolve({ ...copy(seed), version: 'late-share-catalog', products: [...copy(seed.products), newProduct] });
  await retrying;
  assert.equal(page.selection.partNumber, other.partNumber);
  assert.equal(page.data.sheetVisible, true);
  assert.equal(page.data.sharedTargetPending, true);
  page.onCloseSelection();
  page.onDismissSharedTarget();
  await page.onLoadSharedTarget();
  assert.equal(page.selection.partNumber, other.partNumber);
  assert.equal(page.data.sharedTargetPending, false);
  page.onUnload();
});
