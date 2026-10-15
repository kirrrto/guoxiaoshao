import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { resultNextAction, targetEvidence } = require('../miniprogram/utils/result-next-action');
const { activationStatus } = require('../miniprogram/utils/activation-status');
const { launchView } = require('../miniprogram/utils/product-launch');
const now = Date.parse('2026-10-11T06:00:00.000Z');
const product = { partNumber: 'SKU-A', title: '测试配置', supported: true, familyKey: 'iphone-18-pro' };
const catalog = { version: 'v2-test', productByPart: { 'SKU-A': product }, storeByNumber: { R001: { storeNumber: 'R001', name: '测试门店' } } };
const account = { identity: { userKey: 'test:alice' }, membership: { active: false }, newProductWindows: [], memberProduct: { days: 7, priceFen: 700 } };
const row = (status = 'unavailable', age = 1000) => ({ storeNumber: 'R001', status, observedAt: new Date(now - age).toISOString() });
const snapshot = rows => ({ ok: true, product, results: rows || [row()] });
const view = (data = {}) => resultNextAction({ snapshot: snapshot(), account, catalog, collector: { state: 'running' }, now, ...data });

test('fresh known unavailable and available observations produce different next actions', () => {
  assert.equal(view().action, 'offer');
  assert.match(view().label, /7 天.*¥7.00/);
  const available = view({ snapshot: snapshot([row('available')]) });
  assert.equal(available.action, 'guide');
  assert.equal(available.label, '查看下单指引');
  assert.match(available.detail, /Apple 官方渠道/);
  assert.equal(view({ account: { ...account, membership: { active: true } } }).action, 'follow');
});

test('unknown, stale, failed, future and partially unknown results never sell missing stock', () => {
  for (const rows of [[row('unknown')], [row('unavailable', 121000)], [row('available', -1000)], [row(), { ...row('unknown'), storeNumber: 'R002' }]]) {
    assert.equal(view({ snapshot: snapshot(rows) }).action, 'retry');
  }
  assert.equal(view({ snapshot: { ...snapshot(), ok: false } }).action, 'retry');
  assert.equal(view({ snapshot: snapshot([{ ...row(), unknownSince: new Date(now - 2000).toISOString() }]) }).action, 'retry');
  assert.equal(view({ snapshot: snapshot([{ ...row(), knownAt: new Date(now + 1000).toISOString() }]) }).action, 'retry');
});

test('service outages never claim a membership will restore stock service', () => {
  for (const state of ['disabled', 'error', 'stale', 'throttled']) assert.equal(view({ collector: { state } }).action, 'retry');
  assert.equal(view({ collector: { state: 'running', observationStale: true } }).action, 'retry');
  assert.equal(view({ collector: null }).action, 'retry');
});

test('restricted and removed products do not disclose evidence or manufacture inventory', () => {
  const denied = { ...account, newProductWindows: [{ familyKey: product.familyKey, releaseAt: '2026-10-01T00:00:00+08:00' }] };
  assert.equal(view({ account: denied }).action, 'offer');
  assert.equal(targetEvidence(snapshot(), denied, catalog, now), null);
  for (const blocked of [{ ...snapshot(), latestRestricted: true }, snapshot([{ ...row('available'), restricted: true }])]) {
    assert.equal(view({ snapshot: blocked }).action, 'account');
    assert.equal(targetEvidence(blocked, account, catalog, now), null);
  }
  assert.equal(view({ catalog: { productByPart: {} } }).action, 'edit');
  assert.equal(targetEvidence(snapshot(), null, catalog, now), null);
  assert.equal(targetEvidence(snapshot(), account, catalog, now).detail.includes('1 家门店'), true);
});

test('displayed action is rechecked at click time when an observation has expired', t => {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const rt = runtime(), page = rt.instance('pages/query/index.js');
  page.catalog = catalog; page.selection = { partNumber: product.partNumber, storeNumbers: ['R001'] };
  page.accountSnapshot = account; page.features = { resultNextAction: true };
  page.querySnapshot = snapshot([row('available')]);
  Object.assign(page.data, { boot: { member: false }, result: page.querySnapshot, accountReady: true, collector: { state: 'running' } });
  page.refreshJourney(); assert.equal(page.data.nextAction.action, 'guide');
  clock += 121000;
  page.onNextAction();
  assert.equal(page.data.nextAction.action, 'retry');
  assert.equal(rt.messages.some(message => /浏览器|官网链接/.test(JSON.stringify(message))), false);
  assert.equal(rt.calls.length, 0);
});

test('contextual entry saves account-scoped target and navigates without a redundant marketing modal', () => {
  const rt = runtime(), page = rt.instance('pages/query/index.js');
  const paths = []; rt.wx.switchTab = ({ url }) => paths.push(url);
  page.catalog = catalog; page.accountSnapshot = account; page.features = { contextualCheckout: true };
  page.data.boot = { member: false };
  page.navigateToFollow({ partNumber: product.partNumber, storeNumbers: ['R001'] });
  assert.deepEqual(paths, ['/pages/mine/index']);
  assert.equal(rt.messages.length, 0);
  const restored = page.checkoutStore().restore(account.identity, catalog);
  assert.equal(restored.status, 'ready');
  assert.equal(page.checkoutStore().restore({ userKey: 'test:bob' }, catalog).status, 'empty');
  assert.equal(rt.calls.length, 0, 'entering the offer does not query, pay or save a follow');
});

test('activation distinguishes paid, saved, authorized and observed states', () => {
  const context = { targetSignature: 'SKU-A|R001', title: product.title };
  const setup = args => activationStatus({ member: true, context, followsLoaded: true, follows: [], readiness: { ready: false }, now, ...args });
  assert.equal(setup({}).action, 'continue');
  const follow = { partNumber: 'SKU-A', status: 'active', stores: [row()] };
  assert.equal(setup({ follows: [follow] }).action, 'conditions');
  assert.equal(setup({ follows: [follow], readiness: { ready: true } }).action, 'tasks');
  assert.match(setup({ follows: [{ ...follow, stores: [{ storeNumber: 'R001' }] }], readiness: { ready: true } }).detail, /等待目标/);
  assert.equal(setup({ follows: [{ ...follow, status: 'paused' }], readiness: { ready: true } }).steps[2].done, false);
  assert.equal(setup({ follows: [{ ...follow, stores: [{ ...row(), limitPaused: true }] }], readiness: { ready: true } }).steps[2].done, false);
  assert.equal(setup({ context: null, contextStatus: 'expired', follows: [follow], readiness: { ready: true } }).action, 'choose');
  assert.equal(setup({ follows: [{ ...follow, partNumber: 'SKU-B' }], readiness: { ready: true } }).steps[1].done, false);
  assert.equal(setup({ followsLoaded: false }).action, '');
  assert.equal(activationStatus({ member: false }), null);
});

test('completed activation yields to follows, while an unfinished purchased target stays recoverable', t => {
  t.mock.method(Date, 'now', () => now);
  const rt = runtime(), page = rt.instance('pages/follow/index.js');
  page.catalog = catalog;
  page.features = { activationJourney: true };
  page.accountSnapshot = { ...account, membership: { active: true } };
  page.setData({ followsLoaded: true, follows: [{ partNumber: 'SKU-A', status: 'active', stores: [row()] }], readiness: { ready: true } });
  page.refreshActivation();
  assert.equal(page.data.activation, null, 'a completed checklist must not occupy the task list first screen');
  page.checkoutStore().save(account.identity, { partNumber: 'SKU-A', storeNumbers: ['R001'] }, catalog);
  page.setData({ follows: [] });
  page.refreshActivation();
  assert.equal(page.data.activation.action, 'continue', 'the paid target still has an explicit recovery path');
  assert.equal(rt.calls.length, 0);
});

test('resuming a checkout selection validates the current account, revision and expiration before opening the editor', t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const rt = runtime(), page = rt.instance('pages/follow/index.js');
  page.catalog = catalog; page.accountSnapshot = account;
  Object.assign(page.data, { ready: true, boot: { member: true } });
  const store = page.checkoutStore();
  const { context } = store.save(account.identity, { partNumber: 'SKU-A', storeNumbers: ['R001'] }, catalog);
  const pending = { partNumber: 'SKU-A', storeNumbers: ['R001'], checkoutRevision: context.revision, checkoutSignature: context.targetSignature };
  page.accountSnapshot = { ...account, identity: { userKey: 'test:bob' } };
  page.openPendingEditor(pending); assert.equal(page.data.editing, false);
  page.accountSnapshot = account;
  clock += 86400001;
  page.openPendingEditor(pending); assert.equal(page.data.editing, false);
  clock = now;
  store.save(account.identity, { partNumber: 'SKU-A', storeNumbers: ['R001'] }, catalog);
  page.openPendingEditor(pending); assert.equal(page.data.editing, false, 'old revision cannot open a newer saved selection');
});

test('late save from the previous account cannot insert its follow into the current account page', async () => {
  let resolve;
  const rt = runtime(() => new Promise(done => { resolve = done; }));
  const page = rt.instance('pages/follow/index.js');
  page.catalog = catalog; page.accountSnapshot = account; page.visible = false;
  Object.assign(page.data, { boot: { member: true }, editing: true, editor: { followId: 'follow-test-0001', isNew: true }, follows: [],
    limits: { maxStoresPerFollow: 3 }, subscription: { credits: 2 } });
  page.editorSelection = { partNumber: 'SKU-A', product, storeNumbers: ['R001'] };
  const saving = page.onSave();
  page.accountEpoch = 1; page.accountSnapshot = { ...account, identity: { userKey: 'test:bob' } };
  resolve({ follow: { followId: 'follow-test-0001', partNumber: 'SKU-A', stores: [{ storeNumber: 'R001' }], status: 'active' } });
  await saving;
  assert.equal(page.data.follows.length, 0);
});

test('launch calendar does not enable coming-soon SKUs when the preorder date passes', () => {
  const catalog = { productByPart: { DUO: { familyKey: 'iphone-duo', supported: false, comingSoon: true } } };
  const before = launchView(catalog, null, now);
  const after = launchView(catalog, null, Date.parse('2026-10-24T00:00:00Z'));
  assert.equal(before.status, '预购准备'); assert.equal(after.status, '新品选购');
  assert.match(after.availability, /尚未开放取货查询/);
  assert.equal(catalog.productByPart.DUO.supported, false);
  assert.match(before.officialUrl, /^https:\/\/www.apple.com.cn\//);
  assert.equal(launchView(catalog, null, Date.parse('2026-12-01T00:00:00Z')), null);
});
