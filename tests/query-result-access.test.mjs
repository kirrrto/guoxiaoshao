import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const now = Date.parse('2026-10-11T06:00:00Z');
const boot = (userKey = 'account:alice', member = true, extra = {}) => ({ identity: { userKey }, membership: { active: member },
  quota: { balance: 4, queryCost: 1, signedInToday: true }, limits: { queryMaxStores: 3 }, followCount: 0,
  collector: { state: 'running' }, newProductWindows: [], features: {}, ...extra });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(rt) {
  const catalog = rt.load('utils/store.js').currentCatalog();
  const product = catalog.products.find(p => p.supported && !p.comingSoon);
  const store = catalog.stores[0];
  const selection = { partNumber: product.partNumber, product, storeNumbers: [store.storeNumber], stores: [store] };
  const snapshot = { accountUserKey: 'account:alice', ok: true, product, queriedAt: new Date(now).toISOString(),
    quotaRevision: 1, balance: 4, results: [{ storeNumber: store.storeNumber, status: 'available', observedAt: new Date(now).toISOString() }] };
  return { catalog, product, selection, snapshot };
}
function seed(rt, values) {
  rt.storage.set('gxs_query_selection_v1', values.selection);
  rt.storage.set('gxs_query_result_v1', values.snapshot);
}

test('cold cached stock waits for current account verification while public catalog and target load immediately', async t => {
  t.mock.method(Date, 'now', () => now);
  let resolve;
  const rt = runtime(action => action === 'user.bootstrap' ? new Promise(done => { resolve = done; }) : { unchanged: true });
  const values = fixture(rt); seed(rt, values);
  const page = rt.instance('pages/query/index.js'), loading = page.onLoad();
  await settle();
  assert.equal(page.data.ready, true);
  assert.equal(page.selection.partNumber, values.product.partNumber);
  assert.equal(page.data.selectionCanCollapse, true);
  assert.equal(page.data.accountReady, false);
  assert.equal(page.data.liveResultRestricted, true);
  assert.match(page.data.resultAccessNotice, /核验/);
  assert.equal(page.data.evidenceCard, null);
  assert.equal(page.data.storeChoices.length, 0);
  resolve(boot()); await loading;
  assert.equal(page.data.liveResultRestricted, false, 'same account with confirmed membership may read its original cached observation');
  assert.equal(page.data.result.results[0].statusLabel, '可取货');
  assert.equal(rt.calls.some(call => call.action === 'query.pickup'), false);
  page.onUnload();
});

test('offline account verification retains target and an explicit retry without inventing unavailable stock', async () => {
  const rt = runtime(action => action === 'user.bootstrap' ? Promise.reject(Error('offline')) : { unchanged: true });
  const values = fixture(rt); seed(rt, values);
  const page = rt.instance('pages/query/index.js'); await page.onLoad();
  assert.equal(page.data.ready, true);
  assert.equal(page.selection.partNumber, values.product.partNumber);
  assert.deepEqual(Array.from(page.selection.storeNumbers), values.selection.storeNumbers);
  assert.equal(page.data.liveResultRestricted, true);
  assert.match(page.data.accountError, /重试/);
  assert.match(page.data.resultAccessNotice, /核验/);
  assert.doesNotMatch(page.data.resultAccessNotice, /无货|没有可取货/);
  assert.equal(page.data.nextAction, null);
  page.onUnload();
});

test('unowned legacy caches and another account caches preserve only the target after verification', async t => {
  t.mock.method(Date, 'now', () => now);
  for (const owner of [undefined, 'account:bob']) {
    const rt = runtime(action => action === 'user.bootstrap' ? boot('account:alice', true, { features: { resultNextAction: true, targetEvidence: true } }) : { unchanged: true });
    const values = fixture(rt); values.snapshot.accountUserKey = owner;
    values.snapshot.results[0].status = 'unavailable'; seed(rt, values);
    const page = rt.instance('pages/query/index.js'); await page.onLoad();
    assert.equal(page.data.liveResultRestricted, true);
    assert.match(page.data.resultAccessNotice, /重新查询/);
    assert.equal(page.data.nextAction, null, 'hidden stock cannot produce an out-of-stock sales claim');
    assert.equal(page.data.evidenceCard, null);
    assert.equal(page.selection.partNumber, values.product.partNumber);
    page.onUnload();
  }
});

test('free restricted inventory is hidden even with every experiment disabled', async t => {
  t.mock.method(Date, 'now', () => now);
  let account;
  const rt = runtime(action => action === 'user.bootstrap' ? account : { unchanged: true });
  const values = fixture(rt); seed(rt, values);
  account = boot('account:alice', false, { newProductWindows: [{ partNumbers: [values.product.partNumber], releaseAt: '2026-10-01T00:00:00Z' }] });
  const page = rt.instance('pages/query/index.js'); await page.onLoad();
  assert.equal(page.data.accountReady, true);
  assert.equal(page.data.liveResultRestricted, true);
  assert.equal(page.data.nextAction, null);
  assert.equal(page.data.evidenceCard, null);
  assert.equal(page.data.storeChoices.length, 0);
  assert.equal(page.data.alternativeCanRead, false);
  assert.match(page.data.resultAccessNotice, /暂不可查看/);
  page.onUnload();
});

test('returning to the page masks retained member stock and follow observations while a refresh is offline', async t => {
  t.mock.method(Date, 'now', () => now);
  let reject;
  const rt = runtime(action => action === 'user.bootstrap' ? new Promise((_, fail) => { reject = fail; }) : { unchanged: true });
  const values = fixture(rt), page = rt.instance('pages/query/index.js');
  page.catalog = values.catalog; page.selection = values.selection;
  page.querySnapshot = values.snapshot; page.querySnapshotOwner = 'account:alice';
  Object.assign(page.data, { ready: true, result: values.snapshot }); page.applyBoot(boot());
  assert.equal(page.data.liveResultRestricted, false);
  page.followSnapshot = [{ status: 'active', stores: [] }]; page.data.followTargets = [{ statusLabel: '可取货' }];
  const showing = page.onShow();
  assert.equal(page.data.liveResultRestricted, true);
  assert.equal(page.data.followTargets.length, 0);
  reject(Error('offline')); await showing;
  assert.equal(page.data.liveResultRestricted, true);
  assert.equal(page.data.evidenceCard, null);
  assert.match(page.data.accountError, /权限尚未核验/);
  page.onUnload();
});

test('switching accounts retires old stock permissions and late charged-query responses while retaining selection', async t => {
  t.mock.method(Date, 'now', () => now);
  let resolve;
  const rt = runtime(() => new Promise(done => { resolve = done; }));
  const values = fixture(rt), page = rt.instance('pages/query/index.js');
  page.catalog = values.catalog; page.selection = values.selection;
  page.querySnapshot = values.snapshot; page.querySnapshotOwner = 'account:alice';
  Object.assign(page.data, { ready: true, result: values.snapshot }); page.applyBoot(boot());
  const querying = page.performQuery(values.selection);
  page.followSnapshot = [{ status: 'active', stores: [] }];
  page.applyBoot(boot('account:bob'));
  assert.equal(page.data.liveResultRestricted, true);
  assert.equal(page.followSnapshot, null);
  assert.equal(page.selection.partNumber, values.product.partNumber);
  resolve({ ...values.snapshot, queryId: 'old-account-response' }); await querying;
  assert.equal(page.data.liveResultRestricted, true);
  assert.notEqual(page.querySnapshot.queryId, 'old-account-response');
  assert.equal(rt.storage.has('gxs_query_result_v1'), false, 'an old account response cannot overwrite the cache');
});

test('new successful query caches record the verified owner and only requery unlocks a legacy result', async t => {
  t.mock.method(Date, 'now', () => now);
  let values;
  const rt = runtime(() => values.snapshot); values = fixture(rt);
  const page = rt.instance('pages/query/index.js'); page.catalog = values.catalog; page.selection = values.selection;
  page.querySnapshot = values.snapshot; page.querySnapshotNeedsRequery = true;
  Object.assign(page.data, { ready: true, result: values.snapshot }); page.applyBoot(boot());
  assert.equal(page.data.liveResultRestricted, true);
  await page.performQuery(values.selection);
  assert.equal(page.data.liveResultRestricted, false);
  assert.equal(rt.storage.get('gxs_query_result_v1').accountUserKey, 'account:alice');
});

test('coming-soon selection with valid stores explains service availability while incomplete scope still asks for repair', () => {
  const rt = runtime(), values = fixture(rt), page = rt.instance('pages/query/index.js');
  const product = { ...values.product, comingSoon: true, supported: false };
  page.catalog = { ...values.catalog, productByPart: { ...values.catalog.productByPart, [product.partNumber]: product } };
  const complete = page.selectionView({ ...values.selection, product });
  assert.equal(complete.selectionCanCollapse, false);
  assert.match(complete.selectionNotice, /尚未开放取货查询/);
  const incomplete = page.selectionView({ ...values.selection, product, storeNumbers: [] });
  assert.match(incomplete.selectionNotice, /补全或核对/);
});

test('inventory rows, observation time and evidence all obey the independent access mask in the actual template', () => {
  const template = fs.readFileSync(new URL('../miniprogram/pages/query/index.wxml', import.meta.url), 'utf8');
  assert.match(template, /wx:for="\{\{liveResultRestricted \? \[\] : result\.results\}\}"/);
  assert.match(template, /wx:if="\{\{!liveResultRestricted\}\}"[^>]*>查询时间/);
  assert.match(template, /wx:if="\{\{!liveResultRestricted && evidenceCard\}\}"/);
  assert.match(template, /liveResultRestricted && resultAccessNotice/);
});
