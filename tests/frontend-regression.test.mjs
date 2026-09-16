import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');
const require = createRequire(import.meta.url);
const copy = value => JSON.parse(JSON.stringify(value));
const boot = () => ({ identity: { isAdmin: false }, membership: { active: true, remainingMs: 86400000, expiresAt: '2027-01-01T00:00:00Z' },
  quota: { balance: 5, queryCost: 1, historyCost: 1, tasksDoneToday: [], dailyGrantCap: 2, balanceCap: 10, signedInToday: false },
  tasks: [], notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'template-A' } }, subscriptions: {}, collector: { state: 'running' },
  memberProduct: { enabled: false, paymentReady: false, paymentReason: '会员购买暂未开放', priceFen: 900, days: 30 },
  limits: { maxFollows: 3, maxStoresPerFollow: 3, queryMaxStores: 3 }, followCount: 1 });

import { runtime } from './helpers/miniprogram-runtime.mjs';

const product = (partNumber = 'SKU-A', extra = {}) => ({ partNumber, title: partNumber, supported: true, ...extra });
const catalog = () => ({ storeByNumber: { R001: { storeNumber: 'R001', name: '门店一', city: '上海' } }, productByPart: { 'SKU-A': product() } });
const queryResponse = payload => ({ ok: true, product: product(payload.partNumber), balance: 4, queriedAt: new Date().toISOString(), results: payload.storeNumbers.map(storeNumber => ({ storeNumber, status: 'available', observedAt: new Date().toISOString() })) });
const selection = partNumber => ({ partNumber, product: product(partNumber), storeNumbers: ['R001'], stores: [] });

test('bootstrap transient failure can retry and explicit invalidation fetches fresh data', async () => {
  let n = 0;
  const rt = runtime(async () => { n++; if (n === 1) throw Error('timeout'); return { generation: n }; });
  const store = rt.load('utils/store.js');
  await assert.rejects(store.getBootstrap(), /timeout/);
  assert.equal((await store.getBootstrap()).generation, 2);
  store.invalidateBootstrap();
  assert.equal((await store.getBootstrap()).generation, 3);
  assert.equal(n, 3);
});

test('cloud initialization recovers after a transient failure and shares an in-flight init', async () => {
  const rt = runtime(); let attempts = 0;
  rt.wx.cloud = { Cloud: class { async init() { attempts++; if (attempts === 1) throw Error('temporary'); } } };
  rt.load('app.js');
  await assert.rejects(rt.app.ensureCloud(), /temporary/);
  const a = rt.app.ensureCloud(), b = rt.app.ensureCloud();
  assert.equal(a, b); await a; assert.equal(attempts, 2); assert.equal(rt.app.globalData.cloudError, null);
});

test('result-card requery retains its displayed SKU and stores after picker changes', async () => {
  const rt = runtime(async (action, payload) => queryResponse(payload)); const page = rt.instance('pages/query/index.js');
  Object.assign(page.data, { boot: { member: true }, catalog: catalog(), selection: selection('SKU-A') });
  await page.onQuery(); page.onPickerChange({ detail: selection('SKU-B') }); await page.onRequery();
  assert.deepEqual(rt.calls.map(c => c.payload.partNumber), ['SKU-A', 'SKU-A']);
});

test('uncertain query retries reuse request ID; completed queries start a new ID', async () => {
  let count = 0;
  const rt = runtime(async (action, payload) => { if (++count === 1) throw Object.assign(Error('timeout'), { code: 'call_failed' }); return queryResponse(payload); });
  const page = rt.instance('pages/query/index.js'); Object.assign(page.data, { boot: { member: true }, catalog: catalog(), selection: selection('SKU-A') });
  await page.onQuery(); await page.onQuery(); await page.onQuery();
  assert.equal(rt.calls[0].payload.queryId, rt.calls[1].payload.queryId);
  assert.notEqual(rt.calls[1].payload.queryId, rt.calls[2].payload.queryId);
});

test('query guard prevents double taps from starting two paid operations', async () => {
  let resolve;
  const rt = runtime((action, payload) => new Promise(r => { resolve = () => r(queryResponse(payload)); }));
  const page = rt.instance('pages/query/index.js'); Object.assign(page.data, { boot: { member: true }, catalog: catalog(), selection: selection('SKU-A') });
  const first = page.onQuery(); await page.onQuery(); assert.equal(rt.calls.length, 1); resolve(); await first;
});

test('zero-balance recovery and store reordering retain the original uncertain query ID', async () => {
  let n = 0;
  const rt = runtime(async (action, payload) => { if (++n === 1) throw Object.assign(Error('lost response after debit'), { code: 'call_failed' }); return queryResponse(payload); });
  const page = rt.instance('pages/query/index.js'); Object.assign(page.data, { boot: { member: false, balance: 1, queryCost: 1 }, catalog: catalog(), selection: { ...selection('SKU-A'), storeNumbers: ['R002', 'R001'] } });
  await page.onQuery(); page.data.boot.balance = 0; page.data.selection.storeNumbers = ['R001', 'R002']; await page.onQuery();
  assert.equal(rt.calls.length, 2); assert.equal(rt.calls[0].payload.queryId, rt.calls[1].payload.queryId);
});

test('history pagination retains the original request and merges unique events', async () => {
  const response = (payload, next) => ({ ok: true, product: product(payload.partNumber), balance: 4, dayKey: payload.dayKey, latest: [], summary: { available: 2, restocks: 0, recoveries: 0, ended: 0 },
    events: [{ id: next ? 'e2' : 'e1', type: 'first_seen_available', detectedAt: new Date().toISOString(), storeNumber: 'R001' }], pagination: { nextCursor: next ? null : 'cursor1', hasMore: !next, total: 2 } });
  const rt = runtime(async (action, payload) => action === 'history.list' ? response(payload, Boolean(payload.cursor)) : {});
  const page = rt.instance('pages/history/index.js'); Object.assign(page.data, { boot: { member: true }, catalog: catalog(), selection: selection('SKU-A') });
  await page.onQuery(); page.onPickerChange({ detail: selection('SKU-B') }); await page.onLoadMore();
  const calls = rt.calls.filter(c => c.action === 'history.list');
  assert.equal(calls[0].payload.historyQueryId, calls[1].payload.historyQueryId); assert.equal(calls[1].payload.partNumber, 'SKU-A');
  assert.equal(page.data.result.events.length, 2); assert.equal(page.data.result.pagination.hasMore, false);
});

test('follow page refreshes while visible and stops polling when hidden', async () => {
  let status = 'available'; const b = boot();
  const rt = runtime(async action => action === 'user.bootstrap' ? b : action === 'catalog.get' ? { products: [], stores: [], version: 'test' } : { follows: [{ followId: 'f1', partNumber: 'SKU-A', status: 'active', stores: [{ storeNumber: 'R001', status, observedAt: new Date().toISOString() }] }], limits: b.limits });
  const page = rt.instance('pages/follow/index.js'); const loading = page.onLoad(); await page.onShow(); await loading;
  assert.equal(page.data.follows[0].stores[0].status, 'available'); status = 'unavailable'; await rt.nextTimer();
  assert.equal(page.data.follows[0].stores[0].status, 'unavailable'); page.onHide(); assert.equal(rt.timers.size, 0);
});

test('expired memberships and stale observations are not presented as active monitoring', async () => {
  const rt = runtime(async () => ({ follows: [{ followId: 'f1', status: 'expired', statusReason: 'membership_expired', stores: [{ status: 'unknown', observedAt: '2020-01-01T00:00:00Z' }] }], limits: {} }));
  const page = rt.instance('pages/follow/index.js'); page.data.boot = { member: false }; await page.loadFollows();
  assert.match(page.data.follows[0].statusLabel, /到期/); assert.equal(page.data.follows[0].stores[0].stale, true);
});

test('subscription retry reuses authorization request ID without prompting WeChat twice', async () => {
  let n = 0, prompts = 0;
  const rt = runtime(async action => { if (action === 'notify.recordSubscription') { if (++n === 1) throw Error('lost response'); return { accepted: ['template-A'], subscriptions: { 'template-A': { credits: 1 } } }; } return boot(); });
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'template-A': 'accept' }; };
  const page = rt.instance('pages/follow/index.js'); page.data.boot = { templateIds: ['template-A'] };
  await page.onSubscribe(); await page.onSubscribe();
  const calls = rt.calls.filter(c => c.action === 'notify.recordSubscription');
  assert.equal(prompts, 1); assert.equal(calls[0].payload.requestId, calls[1].payload.requestId); assert.equal(page.data.subscriptionPending, false);
});

test('a permanently rejected old subscription is cleared and a new template can be authorized', async () => {
  let prompts = 0;
  const b = boot(); b.notifications.templateIds = { restock: 'template-new' };
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.recordSubscription') {
      if (payload.results['template-old']) throw Object.assign(Error('template changed'), { code: 'invalid_subscription_result' });
      return { accepted: ['template-new'], subscriptions: { 'template-new': { credits: 1 } } };
    }
    return b;
  });
  rt.storage.set('gxs_subscription_pending_v1', { requestId: 'old-request-001', results: { 'template-old': 'accept' } });
  rt.wx.requestSubscribeMessage = async ({ tmplIds }) => { prompts++; assert.deepEqual(copy(tmplIds), ['template-new']); return { 'template-new': 'accept' }; };
  const page = rt.instance('pages/follow/index.js'); page.data.boot = { templateIds: ['template-old'] };
  await page.onSubscribe();
  assert.equal(prompts, 0); assert.equal(page.data.subscriptionPending, false); assert.equal(rt.storage.has('gxs_subscription_pending_v1'), false);
  await page.onSubscribe();
  assert.equal(prompts, 1); assert.equal(page.data.subscription.credits, 1);
});

test('SKU filters switch exact-color images and never borrow a missing color image', () => {
  const products = [product('red', { model: 'Phone', category: 'iphone', familyKey: 'phone', attributes: { capacity: '256GB', color: '红色' }, imageUrl: 'https://store.example/red.png' }),
    product('blue', { model: 'Phone', category: 'iphone', familyKey: 'phone', attributes: { capacity: '256GB', color: '蓝色' }, imageUrl: '' })];
  const c = { categories: [{ key: 'iphone', name: 'iPhone', families: [{ familyKey: 'phone', name: 'Phone', supported: true, products }] }], cities: [], storeByNumber: {}, productByPart: Object.fromEntries(products.map(p => [p.partNumber, p])) };
  const rt = runtime(), picker = rt.instance('components/target-picker/index.js', { catalog: c, maxStores: 3 });
  picker.onCatalog(c); assert.equal(picker.data.product.partNumber, 'red'); assert.match(picker.data.product.imageUrl, /red.png/);
  picker.onColorTap({ currentTarget: { dataset: { index: 1 } } }); assert.equal(picker.data.product.partNumber, 'blue'); assert.equal(picker.data.product.imageUrl, '');
  picker.applyValue({ partNumber: 'removed', storeNumbers: [] }); assert.equal(picker.data.product, null); assert.match(picker.data.selectionNote, /移除/);
});

test('payment is intentionally unavailable and no checkout/query-order API is reachable', () => {
  const rt = runtime(), page = rt.instance('pages/mine/index.js'); const b = boot(); b.memberProduct.paymentReady = true;
  page.applyBoot(b); assert.equal(page.data.boot.paymentReady, false);
  const source = fs.readFileSync(path.join(root, 'pages/mine/index.js'), 'utf8');
  assert.doesNotMatch(source, /member\.(createOrder|queryOrder)|requestVirtualPayment|wx\.login/);
});

test('abandoned refunded query response clears pending request without requiring a product', async () => {
  const rt = runtime(async () => ({ ok: false, reason: 'query_expired', refunded: 1, balance: 1 }));
  const page = rt.instance('pages/query/index.js'); Object.assign(page.data, { boot: { member: false, balance: 0 }, catalog: catalog(), selection: selection('SKU-A') });
  await page.onQuery(); assert.match(page.data.restriction, /返还/); assert.equal(rt.storage.has('gxs_pending_q_v1'), false); assert.equal(page.data.querying, false);
});

test('history uses server full-result last-hour count when only one page is loaded', async () => {
  const rt = runtime(async () => ({ ok: true, product: product(), balance: 1, dayKey: rt.load('utils/format.js').todayKey(), events: [], latest: [], summary: { lastHourRestocks: 123 }, pagination: { total: 500, hasMore: true, nextCursor: 'next' } }));
  const page = rt.instance('pages/history/index.js'); Object.assign(page.data, { boot: { member: true }, catalog: catalog(), selection: selection('SKU-A') });
  await page.onQuery(); assert.equal(page.data.result.lastHour, 123); assert.equal(page.data.result.lastHourComplete, true);
});

test('active saved follows separate the user switch from a missing collector', async () => {
  const rt = runtime(async () => ({ follows: [{ followId: 'f1', status: 'active', stores: [] }], limits: {} }));
  const page = rt.instance('pages/follow/index.js'); page.data.boot = { member: true }; page.data.collector = { state: 'not_deployed' };
  await page.loadFollows(); assert.equal(page.data.follows[0].statusLabel, '关注已开启'); assert.match(page.data.follows[0].monitoringText, /后台检测情况见上方/); assert.doesNotMatch(page.data.follows[0].statusLabel, /监测中|等待启动/);
});

test('pull-to-refresh formats follows using the newly fetched membership state', async () => {
  const b = boot(); b.membership.active = false;
  const rt = runtime(async action => action === 'user.bootstrap' ? b : action === 'catalog.get' ? { products: [], stores: [], version: 'fresh' } : { follows: [{ followId: 'f1', status: 'active', stores: [] }], limits: b.limits });
  const page = rt.instance('pages/follow/index.js'); page.data.boot = { member: true }; page.data.collector = { state: 'running' };
  await page.onPullDownRefresh(); assert.equal(page.data.boot.member, false); assert.equal(page.data.follows[0].statusLabel, '关注已开启'); assert.match(page.data.follows[0].monitoringText, /不参与自动检测/);
});

test('first-visit pending follow editor receives catalog and ready state before opening', async () => {
  const b = boot(), pending = { partNumber: 'SKU-A', storeNumbers: ['R001'] };
  const rt = runtime(async action => action === 'user.bootstrap' ? b : action === 'catalog.get' ? { products: [], stores: [], version: 'ready-catalog' } : { follows: [], limits: b.limits });
  rt.app.globalData.pendingFollow = pending;
  rt.storage.set('gxs_catalog_v1', { products: [], stores: [], version: 'ready-catalog' });
  const page = rt.instance('pages/follow/index.js'), open = page.openEditor;
  let opened = false;
  page.openEditor = function (value) { assert.equal(this.data.ready, true); assert.equal(this.data.catalog.version, 'ready-catalog'); opened = true; return open.call(this, value); };
  const loading = page.onLoad(); await page.onShow(); await loading;
  assert.equal(opened, true); assert.deepEqual(copy(page.data.editor.pickerValue), pending); page.onHide();
});

test('bundled image fallback exactly matches every current catalog SKU and preserves signed URLs', () => {
  const rt = runtime(), images = rt.load('config/product-images.js');
  const products = JSON.parse(fs.readFileSync(path.join(root, '../catalog/products.json'), 'utf8')).products;
  for (const p of products.filter(p => p.imageUrl)) { assert.equal(images[p.partNumber].imageUrl, p.imageUrl, p.partNumber); assert.equal(images[p.partNumber].imageAlt, p.imageAlt || p.title); }
  assert.equal(Object.keys(images).length, products.filter(p => p.imageUrl).length);
});

test('complete image-enabled catalog stays safely below the WeChat setData payload limit', async () => {
  const built = require('../cloudfunctions/gxs_api/lib/services/catalog.js').buildFromBundled();
  const rt = runtime(async () => ({ ...built.meta, stores: built.stores, products: built.products }));
  const store = rt.load('utils/store.js');
  const catalog = await store.getCatalog({ force: true });
  const bytes = Buffer.byteLength(JSON.stringify({ catalog: store.toViewCatalog(catalog) }));
  assert.ok(bytes < 350 * 1024, `catalog payload ${bytes} bytes must avoid duplicate render indexes`);
  assert.equal(catalog.products.length, built.products.length);
});

test('isolated picker styles contain only class selectors and no imported global selectors', () => {
  const css = fs.readFileSync(path.join(root, 'components/target-picker/index.wxss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /@import/);
  for (const match of css.matchAll(/([^{}]+)\{/g)) for (const selector of match[1].split(',')) { assert.match(selector.trim(), /^\./); assert.doesNotMatch(selector, /\[|#/); }
});

test('all page event handlers exist; WXML expressions have no XML entity operators; UTF-8 is valid', () => {
  for (const name of ['query', 'follow', 'history', 'mine', 'admin']) {
    const rt = runtime(), page = rt.instance(`pages/${name}/index.js`);
    const markup = fs.readFileSync(path.join(root, `pages/${name}/index.wxml`), 'utf8');
    for (const match of markup.matchAll(/(?:bind|catch)(?:tap|change|input|error)="([\w]+)"/g)) assert.equal(typeof page[match[1]], 'function', `${name}: ${match[1]}`);
  }
  const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const p = path.join(directory, entry.name); if (entry.isDirectory()) walk(p); else if (/\.(js|json|wxml|wxss)$/.test(p)) {
    const bytes = fs.readFileSync(p); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); assert.doesNotMatch(text, /\uFFFD/);
    if (p.endsWith('.wxml')) for (const expression of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) assert.doesNotMatch(expression[1], /&(?:amp|lt|gt);/, p);
  } } };
  walk(root);
});
