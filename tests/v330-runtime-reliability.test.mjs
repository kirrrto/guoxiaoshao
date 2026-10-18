import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const copy = value => JSON.parse(JSON.stringify(value));
const account = userKey => ({ identity: { userKey }, membership: { active: true }, quota: { balance: 5, revision: 1, queryCost: 1, historyCost: 1, tasksDoneToday: [] }, collector: { state: 'running' }, limits: { queryMaxStores: 4 }, followCount: 0 });

function pageFixture(name, handler) {
  const rt = runtime(handler), catalog = rt.load('utils/store.js').currentCatalog();
  const product = catalog.products.find(p => p.supported && !p.comingSoon), store = catalog.stores[0];
  const page = rt.instance(`pages/${name}/index.js`);
  page.catalog = catalog; page.data.ready = true;
  page.selection = { partNumber: product.partNumber, product, storeNumbers: [store.storeNumber], stores: [store] };
  page.applyBoot(account('alice'));
  return { rt, page, product, store };
}

test('safe concurrent reads share one request, while a session reset permits an independent read', async () => {
  const rt = runtime(undefined, { realApi: true }), requests = [];
  rt.app.ensureCloud = async () => ({ callFunction: () => { const request = deferred(); requests.push(request); return request.promise; } });
  const api = rt.load('utils/api.js');
  const first = api.call('notify.list', { limit: 10 }), second = api.call('notify.list', { limit: 10 });
  assert.equal(first, second);
  await settle(); assert.equal(requests.length, 1);
  rt.load('utils/store.js').resetSession();
  const current = api.call('notify.list', { limit: 10 });
  await settle(); assert.equal(requests.length, 2);
  requests[1].resolve({ result: { ok: true, data: ['new'] } });
  requests[0].resolve({ result: { ok: true, data: ['old'] } });
  assert.deepEqual(await current, ['new']); assert.deepEqual(await first, ['old']);
});

test('known offline requests fail immediately without contacting cloud or losing an uncertain operation ID', async () => {
  const rt = runtime(undefined, { realApi: true }); let cloudCalls = 0;
  rt.wx.getNetworkType = ({ success }) => success({ networkType: 'none' });
  rt.app.ensureCloud = async () => { cloudCalls++; };
  const api = rt.load('utils/api.js'), operation = rt.load('utils/operation.js');
  const payload = { partNumber: 'SKU', storeNumbers: ['R001'] }, id = operation.begin('q', payload);
  await assert.rejects(api.call('query.pickup', { queryId: id, ...payload }), error => error.code === 'offline' && operation.uncertain(error));
  assert.equal(cloudCalls, 0); assert.equal(rt.timers.size, 0);
  assert.equal(operation.begin('q', payload), id);
});

test('a picker parent echo terminates, and the next real selection still emits once', async () => {
  const rt = runtime(), picker = rt.instance('components/target-picker/index.js', { maxStores: 4, supportedOnly: false });
  let events = 0;
  picker.triggerEvent = (_name, selection) => { events++; picker.onValue(copy(selection)); };
  picker.lifetimes.attached.call(picker);
  for (let turns = 0; turns < 10 && rt.timers.size; turns++) await rt.nextTimer();
  assert.equal(events, 1, 'echoing the same value is not another user change');
  assert.equal(rt.timers.size, 0, 'no endless render/event feedback loop');
  picker.onStoreTap({ currentTarget: { dataset: { store: picker.allStores[0].storeNumber } } });
  for (let turns = 0; turns < 10 && rt.timers.size; turns++) await rt.nextTimer();
  assert.equal(events, 2); assert.equal(rt.timers.size, 0);
});

test('sheet observers never re-enter another component render and closing before detach releases its bar', () => {
  let inParentRender = false;
  const ticks = [], bar = { data: { sheetHidden: false }, setData(patch) {
    assert.equal(inParentRender, false, 'cross-component updates must wait for the current render');
    Object.assign(this.data, patch);
  } };
  const rt = runtime(undefined, { getCurrentPages: () => [{ getTabBar: () => bar }] });
  rt.wx.nextTick = fn => ticks.push(fn);
  const sheet = rt.instance('components/config-sheet/index.js', { visible: true });
  inParentRender = true; sheet.onVisible(true); inParentRender = false;
  while (ticks.length) ticks.shift()();
  assert.equal(bar.data.sheetHidden, true);
  inParentRender = true; sheet.data.visible = false; sheet.onVisible(false); sheet.lifetimes.detached.call(sheet); inParentRender = false;
  while (ticks.length) ticks.shift()();
  assert.equal(bar.data.sheetHidden, false);
});

for (const name of ['query', 'history']) {
  test(`${name} shows bounded slow-request feedback and repeated clicks do not duplicate a request`, async () => {
    const pending = deferred();
    const f = pageFixture(name, () => pending.promise);
    const request = f.page.onQuery();
    await f.page.onQuery();
    assert.equal(f.rt.calls.length, 1);
    assert.equal(f.page.data.querying, true);
    const timer = [...f.rt.timers.entries()].find(([, value]) => value.ms === 6000);
    f.rt.timers.delete(timer[0]); timer[1].fn();
    assert.equal(f.page.data.requestSlow, true); assert.match(f.page.data.requestProgressText, /请勿重复点击/);
    pending.resolve({ ok: false, reason: 'query_in_progress' }); await request;
    assert.equal(f.page.data.querying, false); assert.equal(f.page.data.requestSlow, false);
    assert.equal(f.rt.calls.length, 1);
  });
}

for (const result of ['success', 'failure']) {
  test(`history ignores the previous account's late ${result}, including balances`, async () => {
    const pending = deferred(), f = pageFixture('history', () => pending.promise);
    const request = f.page.onQuery();
    f.page.applyBoot(account('bob'));
    f.page.setData({ queryFailureMessage: 'current account notice' });
    if (result === 'failure') pending.reject(Object.assign(Error('old request'), { code: 'call_failed' }));
    else pending.resolve({ ok: false, reason: 'insufficient_credits', balance: 0, quotaRevision: 99 });
    await request;
    assert.equal(f.page.data.boot.balance, 5);
    assert.equal(f.page.data.queryFailureMessage, 'current account notice');
    assert.equal(f.page.data.result, null);
    assert.equal(f.rt.load('utils/store.js').currentQuota(), null, 'old balances were not published globally');
  });
}

test('history ignores an old account browse reward and records', async () => {
  const pending = deferred(), f = pageFixture('history', () => pending.promise);
  const request = f.page.loadBrowse();
  f.page.applyBoot(account('bob'));
  pending.resolve({ recentViews: [{ partNumber: f.product.partNumber, storeNumbers: [] }], task: { quota: { balance: 90, revision: 99 } } });
  await request;
  assert.equal(f.page.data.browse, null); assert.equal(f.page.data.boot.balance, 5);
  assert.equal(f.rt.load('utils/store.js').currentQuota(), null);
});

test('follow-to-query intent preserves the target and does not issue a paid query', () => {
  const f = pageFixture('query', () => ({}));
  f.rt.app.globalData.pendingSharedTarget = { partNumber: f.product.partNumber, storeNumbers: [f.store.storeNumber], source: 'follow' };
  f.page.consumePendingSharedTarget();
  assert.equal(f.page.data.sharedTargetSource, 'follow');
  assert.equal(f.page.data.sharedSelection, true);
  assert.equal(f.page.selection.partNumber, f.product.partNumber);
  assert.equal(f.rt.calls.length, 0);
});

test('runtime reporting cannot recurse when the native logger raises another error, and retains version and safe route', () => {
  const rt = runtime(undefined, { getCurrentPages: () => [{ route: 'pages/history/index?private=value' }] });
  const records = [];
  rt.load('app.js');
  rt.wx.getRealtimeLogManager = () => ({ error: (...args) => {
    records.push(args); rt.app.onError('native logger error');
  } });
  assert.doesNotThrow(() => rt.app.onError('RangeError: Maximum call stack size exceeded'));
  assert.equal(records.length, 1);
  assert.equal(records[0][2].route, 'pages/history/index');
  assert.equal(records[0][2].version, rt.load('config/version.js').VERSION);
  assert.doesNotMatch(JSON.stringify(records), /private=value/);
  const inaccessible = {}; Object.defineProperty(inaccessible, 'stack', { get() { throw Error('native property inaccessible'); } });
  assert.doesNotThrow(() => rt.app.onUnhandledRejection({ reason: inaccessible }));
  assert.equal(records.length, 2, 'one failed report cannot disable future reports');
});
