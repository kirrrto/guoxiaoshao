import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const baseTime = Date.parse('2026-09-16T02:00:00.000Z');
const observedAt = new Date(baseTime).toISOString();
const product = (partNumber = 'SKU-A') => ({ partNumber, title: partNumber, supported: true });
const catalog = () => ({ productByPart: { 'SKU-A': product() }, storeByNumber: { R001: { name: '天环广场', city: '广州' } } });
const selection = (partNumber = 'SKU-A', storeNumbers = ['R001']) => ({ partNumber, product: product(partNumber), storeNumbers });
const response = (results = [{ storeNumber: 'R001', status: 'available', observedAt, statusSince: observedAt }]) => ({
  ok: true, product: product(), queriedAt: observedAt, balance: 4, results,
});
const boot = () => ({ membership: { active: false }, quota: { balance: 4, queryCost: 1, signedInToday: true },
  limits: { queryMaxStores: 3 }, followCount: 0, collector: { state: 'running' } });
const copy = value => JSON.parse(JSON.stringify(value));

async function queriedPage(handler) {
  const rt = runtime(async (action, payload) => action === 'query.pickup' ? response() : handler ? handler(action, payload) : boot());
  const page = rt.instance('pages/query/index.js');
  Object.assign(page.data, { ready: true, boot: { member: false, followCount: 0 }, selection: selection() }); page.catalog = catalog();
  page.catalog = catalog();
  await page.onQuery();
  return { rt, page };
}

test('cold cached manual query shows expired results as pending update without changing their timestamps', async t => {
  t.mock.method(Date, 'now', () => baseTime + 180000);
  const rt = runtime(async action => action === 'user.bootstrap' ? boot() : { unchanged: true });
  rt.storage.set('gxs_query_result_v1', response());
  const page = rt.instance('pages/query/index.js');
  await page.onLoad();
  const row = page.data.result.results[0];
  assert.equal(page.data.resultIsCache, true);
  assert.equal(row.statusLabel, '待更新');
  assert.equal(row.statusCls, 'unknown');
  assert.equal(row.observationState, 'stale');
  assert.match(row.lastKnownText, /上次有效结果：可取货/);
  assert.equal(row.sinceText, null);
  assert.equal(row.observedAt, observedAt);
  assert.equal(page.data.result.queriedAt, observedAt);
  assert.equal(rt.calls.filter(c => c.action === 'query.pickup').length, 0);
  page.onUnload();
});

test('retained manual snapshot ages before pending account refresh settles on returning to the query page', async t => {
  let now = baseTime, rejectAccount;
  t.mock.method(Date, 'now', () => now);
  const { rt, page } = await queriedPage(action => action === 'user.bootstrap'
    ? new Promise((resolve, reject) => { rejectAccount = reject; }) : { unchanged: true });
  assert.equal(page.data.result.results[0].statusLabel, '可取货');
  now += 180000;
  const showing = page.onShow();
  assert.equal(page.data.result.results[0].statusLabel, '待更新');
  assert.equal(page.data.result.results[0].observedAt, observedAt);
  rejectAccount(Error('offline'));
  await showing;
  assert.equal(rt.calls.filter(c => c.action === 'query.pickup').length, 1);
  page.onHide();
  assert.equal(rt.timers.size, 0);
});

test('visible manual snapshots age locally for free users and stop updating when hidden without new requests', async t => {
  let now = baseTime;
  t.mock.method(Date, 'now', () => now);
  const { rt, page } = await queriedPage();
  page.visible = true;
  page.startFollowPolling();
  assert.equal(page.data.result.results[0].statusLabel, '可取货');
  assert.equal(page.data.result.results[0].sinceText, null, 'an initial sample does not claim zero seconds of observed duration');
  const callsBeforeTimer = rt.calls.length;
  now += 180000;
  await rt.nextTimer();
  assert.equal(page.data.result.results[0].statusLabel, '待更新');
  assert.equal(page.data.result.results[0].observedAt, observedAt);
  assert.equal(rt.calls.length, callsBeforeTimer, 'local aging must not request stock, follows or charge query credits');
  page.onHide();
  assert.equal(rt.timers.size, 0);
});

test('a manual query with missing or unknown observations cannot show a positive current-stock badge', async t => {
  t.mock.method(Date, 'now', () => baseTime);
  const rt = runtime(async () => response([
    { storeNumber: 'R001', status: 'available', observedAt: null },
    { storeNumber: 'R002', status: 'unknown', observedAt, lastKnownStatus: 'available', isStale: true },
  ]));
  const page = rt.instance('pages/query/index.js');
  Object.assign(page.data, { boot: { member: true }, selection: selection() }); page.catalog = catalog();
  await page.onQuery();
  const [missing, unknown] = page.data.result.results;
  assert.equal(missing.statusLabel, '等待首次观测');
  assert.equal(unknown.statusLabel, '状态待确认');
  assert.notEqual(unknown.statusCls, 'ok');
  assert.match(unknown.lastKnownText, /上次有效结果/);
});

test('selected-target follow uses current selection while result-card follow keeps its original query target', () => {
  const rt = runtime(), page = rt.instance('pages/query/index.js'), navigations = [];
  rt.wx.switchTab = value => navigations.push(value.url);
  Object.assign(page.data, { boot: { member: true }, selection: selection('SKU-B', ['R002']), result: response() });
  page.onFollowSelection();
  assert.deepEqual(copy(rt.app.globalData.pendingFollow), { partNumber: 'SKU-B', storeNumbers: ['R002'] });
  page.data.selection.storeNumbers.push('R003');
  assert.deepEqual(copy(rt.app.globalData.pendingFollow.storeNumbers), ['R002'], 'the editor receives a copy of the selected stores');
  page.onAddFollow();
  assert.deepEqual(copy(rt.app.globalData.pendingFollow), { partNumber: 'SKU-A', storeNumbers: ['R001'] });
  assert.deepEqual(navigations, ['/pages/follow/index', '/pages/follow/index']);
  assert.equal(rt.calls.length, 0, 'adding a follow must not first perform a charged stock query');
});

test('free users are guided to membership without silently querying or creating a pending follow', () => {
  const rt = runtime(), page = rt.instance('pages/query/index.js'), navigations = [];
  rt.wx.switchTab = value => navigations.push(value.url);
  Object.assign(page.data, { boot: { member: false }, selection: selection() });
  page.onFollowSelection();
  assert.equal(rt.app.globalData.pendingFollow, null);
  assert.equal(rt.messages[0].title, '会员功能');
  assert.equal(navigations.length, 0);
  rt.messages[0].success({ confirm: true });
  assert.deepEqual(navigations, ['/pages/mine/index']);
  assert.equal(rt.calls.length, 0);
});

test('incomplete or unsupported selections do not navigate to the follow editor', () => {
  for (const current of [
    { partNumber: null, product: null, storeNumbers: [] },
    selection('SKU-A', []),
    { ...selection(), product: { ...product(), supported: false } },
    { ...selection(), product: null },
  ]) {
    const rt = runtime(), page = rt.instance('pages/query/index.js'), navigations = [];
    rt.wx.switchTab = value => navigations.push(value.url);
    Object.assign(page.data, { boot: { member: true }, selection: current });
    page.onFollowSelection();
    assert.equal(navigations.length, 0);
    assert.equal(rt.app.globalData.pendingFollow, null);
    assert.equal(rt.calls.length, 0);
    assert.equal(rt.messages.length, 1);
  }
});
