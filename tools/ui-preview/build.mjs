/** Offline, deterministic WXML/WXSS layout preview. This is NOT the WeChat renderer. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminPreview = process.argv.includes('--admin-only');
if (adminPreview && process.argv.some(arg => /^--(?:reminders|stock|redemption|payment|monitoring|history-task|history-data)-only$/.test(arg))) throw Error('--admin-only cannot be combined with consumer scenarios');
const mini = path.join(project, adminPreview ? 'tools/admin-miniprogram/miniprogram' : 'miniprogram');
const appConfig = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'));
appConfig.tabBar = appConfig.tabBar || { custom: false, list: [] };
const outputAt = process.argv.indexOf('--out');
const out = path.resolve(outputAt >= 0 ? process.argv[outputAt + 1] : path.join(os.tmpdir(), 'guoxiaoshao-ui-preview'));
const allowRemoteImages = process.argv.includes('--remote-images');
const now = new Date('2026-09-15T07:00:00.000Z');
class PreviewDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
  static now() { return now.getTime(); }
}
const copy = value => JSON.parse(JSON.stringify(value));
const html = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function sandbox(handler, { paymentScenario } = {}) {
  const modules = new Map(), storage = new Map(); let captured, seq = 0;
  const app = { globalData: {} };
  const api = { call: handler, newId: p => `${p}-preview-${++seq}`, toast() {}, showError() {} };
  const wx = { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k), nextTick: fn => queueMicrotask(fn), showToast() {}, showModal: options => { if (options && typeof options.success === 'function') options.success({ confirm: true, cancel: false }); }, stopPullDownRefresh() {} };
  // These functions are local preview stubs, never connected to WeChat.
  Object.assign(wx, { getDeviceInfo: () => ({ platform: 'ios', system: paymentScenario === 'payment-old-ios' ? 'iOS 14.8' : 'iOS 18.0' }),
    getAppBaseInfo: () => ({ SDKVersion: '3.10.0', version: '8.0.68' }), canIUse: () => true,
    login: options => options.success({ code: 'offline-preview-login' }),
    requestVirtualPayment: options => paymentScenario === 'payment-cancelled' ? options.fail({ errMsg: 'requestVirtualPayment:fail cancel' }) : options.success({ errMsg: 'requestVirtualPayment:ok' }) });
  function load(filename) {
    if (filename === path.join(mini, 'utils/api.js')) return api;
    if (!allowRemoteImages && filename === path.join(mini, 'config/product-images.js')) return {};
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, wx, console, Date: PreviewDate, Set, Map, Promise, getApp: () => app,
      Page: value => { captured = value; }, Component: value => { captured = value; },
      setTimeout: () => 0, clearTimeout() {}, require: id => load(path.resolve(path.dirname(filename), id.endsWith('.js') ? id : id + '.js')) }, { filename });
    return module.exports;
  }
  function instantiate(relative, props = {}) {
    const filename = path.join(mini, relative); modules.delete(filename); load(filename);
    const definition = captured, p = { ...definition, ...(definition.methods || {}), data: { ...copy(definition.data || {}), ...props } };
    p.setData = patch => { for (const [key, value] of Object.entries(patch)) { const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = p.data; for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {}); target[parts.at(-1)] = value; } };
    p.triggerEvent = () => {};
    return p;
  }
  return { load: relative => load(path.join(mini, relative)), instantiate };
}

function parse(source) {
  const root = { name: 'block', attrs: {}, children: [] }, stack = [root];
  const tokens = /<!--[\s\S]*?-->|<\/?[\w-]+(?:[^"'<>]|"[^"]*"|'[^']*')*\/?>/g;
  let cursor = 0;
  for (const token of source.matchAll(tokens)) {
    if (token.index > cursor) stack.at(-1).children.push({ text: source.slice(cursor, token.index) });
    cursor = token.index + token[0].length;
    const text = token[0]; if (text.startsWith('<!--')) continue;
    if (text.startsWith('</')) { stack.pop(); continue; }
    const name = text.match(/^<([\w-]+)/)[1], attrs = {};
    for (const attr of text.slice(name.length + 1, text.endsWith('/>') ? -2 : -1).matchAll(/([:\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g)) attrs[attr[1]] = attr[2] ?? attr[3] ?? '';
    const node = { name, attrs, children: [] }; stack.at(-1).children.push(node); if (!text.endsWith('/>')) stack.push(node);
  }
  if (cursor < source.length) root.children.push({ text: source.slice(cursor) });
  if (stack.length !== 1) throw Error('Unbalanced WXML');
  return root;
}
const evaluationErrors = [];
const expr = (value, scope) => { try { return Function('scope', `with(scope) { return (${value}); }`)(scope); } catch (error) { evaluationErrors.push({ expression: value, message: error.message }); return ''; } };
const evaluate = (value, scope) => {
  const source = String(value), matches = [...source.matchAll(/\{\{([\s\S]*?)\}\}/g)];
  if (matches.length === 1 && matches[0][0] === source) return expr(matches[0][1], scope);
  return source.replace(/\{\{([\s\S]*?)\}\}/g, (_, code) => String(expr(code, scope) ?? ''));
};
const truth = (value, scope) => Boolean(evaluate(value, scope));
const pickerAst = adminPreview ? null : parse(fs.readFileSync(path.join(mini, 'components/target-picker/index.wxml'), 'utf8'));

function renderChildren(children, scope, context) {
  let previousIf = null, result = '';
  for (const node of children) {
    if ('text' in node) { result += html(evaluate(node.text, scope)); continue; }
    const attrs = node.attrs;
    if ('wx:if' in attrs) { previousIf = truth(attrs['wx:if'], scope); if (!previousIf) continue; }
    else if ('wx:elif' in attrs) { if (previousIf) continue; previousIf = truth(attrs['wx:elif'], scope); if (!previousIf) continue; }
    else if ('wx:else' in attrs) { if (previousIf) continue; previousIf = true; }
    else previousIf = null;
    if ('wx:for' in attrs) {
      const values = evaluate(attrs['wx:for'], scope) || [];
      result += Array.from(values).map((value, index) => renderNode(node, { ...scope, [attrs['wx:for-item'] || 'item']: value, [attrs['wx:for-index'] || 'index']: index }, context)).join('');
    } else result += renderNode(node, scope, context);
  }
  return result;
}
function renderNode(node, scope, context) {
  if (node.name === 'block') return renderChildren(node.children, scope, context);
  const attrs = node.attrs;
  if (node.name === 'target-picker') {
    const p = context.rt.instantiate('components/target-picker/index.js', { catalog: evaluate(attrs.catalog, scope), value: evaluate(attrs.value || '', scope), maxStores: Number(evaluate(attrs['max-stores'] || '3', scope)), storesOptional: truth(attrs['stores-optional'] || '', scope), supportedOnly: truth(attrs['supported-only'] || '', scope) });
    p.onCatalog(p.data.catalog); if (p.data.value) p.onValue(p.data.value);
    return `<div class="component-target-picker">${renderNode(pickerAst, p.data, context)}</div>`;
  }
  const tags = { view: 'div', text: 'span', 'scroll-view': 'div', picker: 'div', image: 'img', switch: 'input', input: 'input', textarea: 'textarea', button: 'button' };
  const tag = tags[node.name] || 'div';
  const classes = evaluate(attrs.class || '', scope);
  let renderedAttrs = classes ? ` class="${html(classes)}"` : '';
  let style = evaluate(attrs.style || '', scope);
  if (node.name === 'switch' && attrs.color) style += `;accent-color:${evaluate(attrs.color, scope)};`;
  if ('scroll-x' in attrs) style += ';overflow-x:auto;max-width:100%;';
  if ('scroll-y' in attrs) style += ';overflow-y:auto;';
  if (style) renderedAttrs += ` style="${html(style)}"`;
  if (node.name === 'image') {
    let src = evaluate(attrs.src || '', scope);
    if (src.startsWith('/')) { const local = path.join(mini, src); if (fs.existsSync(local)) src = `data:image/png;base64,${fs.readFileSync(local).toString('base64')}`; }
    renderedAttrs += ` src="${html(src)}" alt="${html(evaluate(attrs['aria-label'] || '', scope))}" style="object-fit:contain"`;
  }
  if (node.name === 'switch') renderedAttrs += ` type="checkbox" ${truth(attrs.checked || '', scope) ? 'checked' : ''}`;
  if (node.name === 'input') renderedAttrs += ` value="${html(evaluate(attrs.value || '', scope))}" placeholder="${html(evaluate(attrs.placeholder || '', scope))}"`;
  if (node.name === 'button' && truth(attrs.disabled || '', scope)) renderedAttrs += ' disabled';
  if (node.name === 'textarea') return `<textarea${renderedAttrs}>${html(evaluate(attrs.value || '', scope))}</textarea>`;
  if (['img', 'input'].includes(tag)) return `<${tag}${renderedAttrs}>`;
  return `<${tag}${renderedAttrs}>${renderChildren(node.children, scope, context)}</${tag}>`;
}

function cssFile(relative) {
  const file = path.join(mini, relative);
  return fs.readFileSync(file, 'utf8').replace(/@import\s+["']([^"']+)["'];/g, (_, imported) => cssFile(path.relative(mini, path.resolve(path.dirname(file), imported))));
}
const rawCatalog = JSON.parse(fs.readFileSync(path.join(project, 'catalog/products.json'), 'utf8'));
const rawStores = JSON.parse(fs.readFileSync(path.join(project, 'catalog/stores.json'), 'utf8'));
const baseProducts = (rawCatalog.products || rawCatalog).map(p => ({ ...p, supported: true, imageUrl: allowRemoteImages ? p.imageUrl || '' : '' }));
const stores = (rawStores.stores || rawStores).slice(0, 6);
const partAt = process.argv.indexOf('--part-number');
const sample = partAt >= 0 ? baseProducts.find(p => p.partNumber === process.argv[partAt + 1]) : baseProducts.find(p => p.category === 'iphone' && (p.attributes || {}).color) || baseProducts[0];
if (!sample) throw Error('Requested SKU does not exist in the catalog');
const reminderPreview = process.argv.includes('--reminders-only');
const stockPreview = process.argv.includes('--stock-only');
const redemptionPreview = process.argv.includes('--redemption-only');
const paymentPreview = process.argv.includes('--payment-only');
const monitoringPreview = process.argv.includes('--monitoring-only');
const historyTaskPreview = process.argv.includes('--history-task-only');
const historyDataPreview = process.argv.includes('--history-data-only');
const widths = [320, 375, 430], scenarios = adminPreview ? ['operator-ready', 'operator-denied', 'operator-loading', 'operator-error', 'operator-longcontent', 'operator-saving'] : historyTaskPreview ? ['history-member-reward', 'history-free-first', 'history-read-error', 'history-balance-cap', 'history-completed', 'history-longcontent', 'history-loading'] : monitoringPreview ? ['monitor-template-missing', 'monitor-ready-authorized', 'monitor-needs-authorization', 'monitor-stale', 'monitor-disabled', 'monitor-expired-paused'] : redemptionPreview ? ['redemption-input', 'redemption-loading', 'redemption-error', 'redemption-success', 'redemption-used', 'redemption-limited', 'redemption-empty'] : stockPreview ? ['stock-fresh', 'stock-old', 'stock-unknown', 'stock-missing', 'stock-restricted'] : reminderPreview ? ['reminders', 'reminder-empty', 'reminder-loading', 'reminder-deleting', 'reminder-clearing', 'reminder-error', 'reminder-more-error', 'longcontent'] : ['free', 'member', 'expired', 'empty', 'error', 'longcontent'];
if (historyDataPreview) scenarios.splice(0, scenarios.length, 'history-no-data', 'history-unknown-only', 'history-observed-no-events', 'history-events-only', 'history-observed-events', 'history-partial-stores');
if (paymentPreview) scenarios.splice(0, scenarios.length, 'payment-ready', 'payment-renew', 'payment-blocked', 'payment-old-ios', 'payment-pending', 'payment-cancelled', 'payment-error', 'payment-fulfilled', 'payment-partial-refund');
const names = adminPreview ? { admin: '运营工具' } : paymentPreview ? { mine: '我的' } : historyDataPreview ? { history: '历史' } : historyTaskPreview ? { history: '历史', mine: '我的' } : stockPreview || monitoringPreview ? { follow: '小哨提醒' } : reminderPreview || redemptionPreview ? { mine: '我的' } : { query: '查询', follow: '小哨提醒', history: '历史', mine: '我的' };
if (monitoringPreview) scenarios.push('monitor-no-follows', 'monitor-all-paused', 'monitor-user-disabled', 'monitor-dnd');
fs.mkdirSync(out, { recursive: true });
const manifest = [];

for (const scenario of scenarios) {
  const products = copy(baseProducts);
  if (scenario === 'longcontent' || scenario === 'history-longcontent') { const p = products.find(p => p.partNumber === sample.partNumber); p.title += ' · 超长商品名称与配置说明用于检查换行及小屏布局 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; }
  const p = products.find(p => p.partNumber === sample.partNumber), member = historyTaskPreview ? ['history-member-reward', 'history-longcontent'].includes(scenario) : monitoringPreview ? scenario !== 'monitor-expired-paused' : stockPreview ? scenario !== 'stock-restricted' : ['member', 'longcontent'].includes(scenario), expired = scenario === 'expired' || scenario === 'monitor-expired-paused';
  const bootstrap = { identity: { userKey: 'preview:offline-user', openidMasked: 'preview…0001', isAdmin: true }, membership: { active: member, remainingMs: member ? 18 * 86400000 : 0, expiresAt: member ? '2026-10-03T07:00:00Z' : expired ? '2026-09-10T07:00:00Z' : null },
    quota: { balance: member ? 5 : 0, revision: 0, grantedToday: 0, dailyGrantCap: 2, balanceCap: 10, queryCost: 1, historyCost: 1, signedInToday: false, tasksDoneToday: [], tasksViewedToday: [] }, tasks: [{ id: 'view_history', title: '浏览一次历史记录', reward: 1 }],
    collector: { state: scenario === 'expired' ? 'stale' : 'not_deployed' }, memberProduct: { id: 'vip666', title: '7 天会员', days: 7, priceFen: 700, enabled: paymentPreview && scenario !== 'payment-blocked', paymentReady: paymentPreview && scenario !== 'payment-blocked', iosEnabled: true, note: '该产品为一次性虚拟服务，一经售出不予退款。一次购买 7 天，已有会员按剩余有效期顺延，不自动续费。', paymentReason: '购买开放后可在此开通会员。' },
    notifications: { enabled: false, templateIds: {} }, subscriptions: {}, settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 1380, endMinute: 480 } },
    limits: { maxFollows: 3, maxStoresPerFollow: 3, queryMaxStores: 3 }, followCount: scenario === 'empty' ? 0 : 1, catalogVersion: 'offline-preview' };
  if (scenario === 'history-balance-cap') bootstrap.quota.balance = 10;
  if (scenario === 'payment-renew') bootstrap.membership = { active: true, remainingMs: 18 * 86400000, expiresAt: '2026-10-03T07:00:00Z' };
  const previewOrder = { orderId: '', productId: 'vip666', source: 'virtual_payment', type: 'membership', amountFen: 700, days: 7, createdAt: now.toISOString(),
    status: scenario === 'payment-partial-refund' ? 'partially_refunded' : scenario === 'payment-fulfilled' ? 'fulfilled' : 'created',
    paymentPending: scenario === 'payment-pending', fulfilledAt: ['payment-partial-refund', 'payment-fulfilled'].includes(scenario) ? now.toISOString() : null,
    refundFen: scenario === 'payment-partial-refund' ? 350 : 0 };
  const paidMembership = { active: true, expiresAt: scenario === 'payment-partial-refund' ? '2026-09-18T19:00:00Z' : '2026-09-22T07:00:00Z', remainingMs: (scenario === 'payment-partial-refund' ? 3.5 : 7) * 86400000 };
  if (scenario === 'history-completed') Object.assign(bootstrap.quota, { balance: 1, revision: 1, grantedToday: 1, tasksDoneToday: ['view_history'], tasksViewedToday: ['view_history'] });
  const ledgerEntries = scenario === 'history-completed' ? [{ id: 'preview-task-ledger', type: 'task_reward', delta: 1, createdAt: now.toISOString() }] : [];
  const completeHistoryTask = () => {
    let granted = 0, reason = 'already_completed';
    bootstrap.quota.tasksViewedToday = ['view_history'];
    if (!bootstrap.quota.tasksDoneToday.includes('view_history')) {
      if (bootstrap.quota.balance >= bootstrap.quota.balanceCap) reason = 'balance_cap_reached';
      else {
        granted = 1; reason = 'granted';
        bootstrap.quota = { ...bootstrap.quota, balance: bootstrap.quota.balance + 1, revision: bootstrap.quota.revision + 1, grantedToday: 1, tasksDoneToday: ['view_history'] };
        ledgerEntries.push({ id: 'preview-task-ledger', type: 'task_reward', delta: 1, createdAt: now.toISOString() });
      }
    }
    return { granted, reason, quota: copy(bootstrap.quota) };
  };
  const recentViews = ['empty', 'history-free-first'].includes(scenario) ? [] : Array.from({ length: scenario === 'history-longcontent' ? 3 : 1 }, (_, i) => ({
    partNumber: p.partNumber, dayKey: `2026-09-${String(14 - i).padStart(2, '0')}`, storeNumbers: i === 2 ? [] : stores.slice(0, i + 2).map(s => s.storeNumber), viewedAt: now.toISOString(),
  }));
  const raw = { products, stores, families: rawCatalog.families, version: 'offline-preview' };
  const event = { id: 'e1', type: 'restock_confirmed', detectedAt: now.toISOString(), storeNumber: stores[0].storeNumber, source: 'auto', quote: '模拟观测，仅用于排版检查' };
  const response = { ok: true, product: p, balance: 4, dayKey: '2026-09-15', queriedAt: now.toISOString(), latest: [],
    results: stores.slice(0, 2).map(s => ({ storeNumber: s.storeNumber, storeName: s.name, status: 'unknown', observedAt: now.toISOString(), quote: '模拟观测数据，非实时库存' })),
    events: scenario === 'empty' ? [] : [event, { ...event, id: 'e2', type: 'became_unavailable' }], summary: { available: 1, restocks: 1, recoveries: 0, ended: 1, lastHourRestocks: 1 }, pagination: { total: scenario === 'empty' ? 0 : 2, hasMore: false } };
  if (historyDataPreview) {
    const hasEvents = ['history-events-only', 'history-observed-events', 'history-partial-stores'].includes(scenario);
    response.summary.available = 0;
    if (!hasEvents) { response.events = []; response.summary = { available: 0, restocks: 0, recoveries: 0, ended: 0, lastHourRestocks: 0 }; response.pagination.total = 0; response.refunded = 1; }
    response.observationCoverage = { tracking: 'daily_samples_v1', requestedStoreNumbers: stores.slice(0, 2).map(s => s.storeNumber), checkedAt: now.toISOString(), stores: [] };
    if (!['history-no-data', 'history-events-only'].includes(scenario)) response.observationCoverage.stores = stores.slice(0, scenario === 'history-partial-stores' ? 1 : 2).map(s => ({ storeNumber: s.storeNumber, sampleCount: 30, knownCount: scenario === 'history-unknown-only' ? 0 : 28, unknownCount: scenario === 'history-unknown-only' ? 30 : 2, firstObservedAt: '2026-09-15T01:00:00Z', lastObservedAt: '2026-09-15T01:30:00Z' }));
    response.latest = [{ ...response.results[0], status: 'unavailable' }];
  }
  const follows = scenario === 'empty' || scenario === 'free' ? [] : [{ followId: 'f-preview', partNumber: p.partNumber, productTitle: p.title, status: expired ? 'expired' : 'active', statusReason: expired ? 'membership_expired' : null, stores: response.results }];
  if (monitoringPreview) {
    const templateId = 'offline-template-example';
    const collectorState = scenario === 'monitor-stale' ? 'stale' : scenario === 'monitor-disabled' ? 'disabled' : 'running';
    const ready = collectorState === 'running' && scenario !== 'monitor-template-missing';
    bootstrap.collector = { state: collectorState, updatedAt: now.toISOString(), lastBatchAt: now.toISOString() };
    bootstrap.notifications = scenario === 'monitor-template-missing'
      ? { enabled: false, deliveryReady: false, reason: 'template_missing', templateIds: {} }
      : { enabled: true, deliveryReady: ready, reason: collectorState === 'stale' ? 'collector_stale' : collectorState === 'disabled' ? 'collector_stopped' : '', templateIds: { restock: templateId } };
    bootstrap.subscriptions = scenario === 'monitor-needs-authorization' ? {} : { [templateId]: { credits: 1 } };
    bootstrap.settings = { notifyEnabled: true, dnd: { enabled: false, startMinute: 1380, endMinute: 480 } };
    if (expired) { follows[0].status = 'paused'; follows[0].statusReason = 'membership_expired'; }
    const observedAt = new Date(now.getTime() - (collectorState === 'running' ? 15000 : 360000)).toISOString();
    follows[0].stores = stores.slice(0, 2).map(s => ({ storeNumber: s.storeNumber, storeName: s.name, city: s.city,
      status: 'unavailable', lastKnownStatus: 'unavailable', observedAt, statusSince: new Date(now.getTime() - 3600000).toISOString() }));
    if (scenario === 'monitor-all-paused') follows[0].status = 'paused';
    if (scenario === 'monitor-no-follows') { follows.length = 0; bootstrap.followCount = 0; }
    if (scenario === 'monitor-user-disabled') bootstrap.settings.notifyEnabled = false;
    if (scenario === 'monitor-dnd') bootstrap.settings.dnd = { enabled: true, startMinute: 480, endMinute: 1080 };
  }
  if (stockPreview) {
    bootstrap.collector = { state: 'running' };
    follows[0].latestRestricted = scenario === 'stock-restricted';
    const observedAt = new Date(now.getTime() - (scenario === 'stock-old' ? 180000 : 0)).toISOString();
    follows[0].stores = stores.slice(0, 2).map(s => ({ storeNumber: s.storeNumber, storeName: s.name, city: s.city,
      status: scenario === 'stock-unknown' ? 'unknown' : 'unavailable', lastKnownStatus: 'unavailable', isStale: scenario === 'stock-unknown',
      observedAt: scenario === 'stock-missing' ? null : observedAt, statusSince: observedAt }));
  }
  const reminderRecords = (reminderPreview && !['reminder-empty','reminder-loading'].includes(scenario) || scenario === 'longcontent')
    ? ['accepted', 'simulated', 'failed', 'uncertain', 'skipped', 'pending', 'sending'].map((status, i) => ({ id: `reminder-preview-${i}`, productTitle: p.title, partNumber: p.partNumber,
      storeNumber: stores[i % stores.length].storeNumber, storeName: scenario === 'longcontent' ? '广州天环广场门店 · 超长门店与购物中心位置说明' : stores[i % stores.length].name,
      status, reason: status === 'skipped' ? 'dnd' : status === 'failed' ? 'wx_43101:user refused' : status === 'uncertain' ? 'send_transport_error' : null, eventType: 'restock_confirmed', createdAt: now.toISOString() })) : [];
  const rt = sandbox(async (action, payload) => {
    if (action === 'user.bootstrap') return copy(bootstrap);
    if (action === 'catalog.get') return raw;
    if (action === 'follow.list') return { follows, limits: bootstrap.limits };
    if (action === 'history.list' || action === 'query.pickup') return response;
    if (action === 'history.browse') {
      if (scenario === 'history-read-error') throw Error('offline history browse response failed');
      if (scenario === 'history-loading') return new Promise(() => {});
      return { recentViews, browsedAt: now.toISOString(), task: completeHistoryTask() };
    }
    if (action === 'quota.completeTask') return completeHistoryTask();
    if (action === 'quota.ledger') return { balance: bootstrap.quota.balance, entries: copy(ledgerEntries) };
    if (action === 'member.status') return { orders: previewOrder.orderId ? [copy(previewOrder)] : [] };
    if (action === 'member.createOrder') {
      previewOrder.orderId = payload.orderId;
      if (scenario === 'payment-error') throw Object.assign(Error('offline mock timeout'), { code: 'call_failed' });
      return { ok: true, order: copy(previewOrder), payment: { mode: 'short_series_goods', signData: '{"offlinePreview":true}', paySig: 'offline-preview', signature: 'offline-preview' } };
    }
    if (action === 'member.checkOrder') return { order: copy(previewOrder), membership: previewOrder.fulfilledAt ? copy(paidMembership) : copy(bootstrap.membership) };
    if (action === 'notify.list') return { notifications: reminderRecords, hasMore: reminderPreview && ['reminders','reminder-more-error'].includes(scenario), nextCursor: 'preview-next-cursor', clearBefore: 'preview-opaque-clear-token' };
    if (action === 'admin.stats' && scenario === 'operator-denied') throw Object.assign(Error('需要管理员权限'), { code: 'forbidden' });
    if (action === 'admin.stats' && scenario === 'operator-error') throw Error('连接中断');
    if (action === 'admin.stats') return { users: 128, activeFollows: 32, events: 1024, queries: 2086, serverTime: now.toISOString() };
    if (action === 'admin.getConfig') return { config: { announcement: '离线模拟预览', quota: { balanceCap: 10 }, notifications: { enabled: false }, memberProduct: { enabled: false } } };
    return {};
  }, { paymentScenario: paymentPreview ? scenario : '' });
  const catalog = adminPreview ? null : await rt.load('utils/store.js').getCatalog({ force: true });
  for (const pageName of Object.keys(names)) {
    const page = rt.instantiate(`pages/${pageName}/index.js`);
    if (scenario !== 'operator-loading') await page.onLoad();
    if (scenario === 'operator-saving') page.setData({ saving: true, configDirty: true });
    if (scenario === 'operator-longcontent') page.setData({ lookup: { user: true }, lookupText: JSON.stringify({ userKey: 'wxe96ad9e77b602f1b:long-user-identity-0123456789abcdefghijklmnopqrstuvwxyz', note: '运营查询长文本换行验收' }, null, 2), configText: JSON.stringify({ announcement: '运行配置说明需要在小屏完整换行且不遮挡操作按钮。'.repeat(5) }, null, 2) });
    if (pageName === 'history' && scenario !== 'history-loading' && page.browsePending) await page.browsePending;
    if (pageName === 'mine' && historyTaskPreview) await page.onToggleLedger();
    if (paymentPreview && ['payment-pending', 'payment-cancelled', 'payment-error', 'payment-fulfilled', 'payment-partial-refund'].includes(scenario)) await page.onBuyMembership();
    if (redemptionPreview) {
      page.setData({ redemptionOpen: true, redemptionCode: 'SAMPLE-CODE' });
      if (scenario === 'redemption-loading') page.setData({ redeeming: true });
      if (scenario === 'redemption-error') page.setData({ redemptionError: '兑换码无效，请核对后重试。还可尝试 4 次。' });
      if (scenario === 'redemption-limited') page.setData({ redemptionError: '输入错误次数较多，请约 15 分钟后再试。' });
      if (scenario === 'redemption-empty') page.setData({ redemptionCode: '' });
      if (['redemption-success','redemption-used'].includes(scenario)) {
        page.applyBoot({ ...bootstrap, membership: { active: true, expiresAt: '2026-10-15T07:00:00.000Z', remainingMs: 30 * 86400000 } });
        page.setData({ redemptionCode: '', redemptionResult: { kind: 'ok', title: scenario === 'redemption-success' ? '兑换成功' : '此账号已兑换过', detail: '会员有效期已更新，请查看上方会员状态。' } });
      }
    }
    if (pageName === 'mine' && reminderPreview) {
      if (scenario === 'reminder-loading') page.setData({ notificationsLoading: true });
      if (scenario === 'reminder-deleting') page.setData({ notificationActionBusy: 'delete', notificationDeletingId: reminderRecords[0].id });
      if (scenario === 'reminder-clearing') page.setData({ notificationActionBusy: 'clear' });
      if (scenario === 'reminder-error') page.setData({ notificationsActionError: '清空结果未确认，记录暂时保留。可重试原清空操作，新到提醒不受影响。' });
      if (scenario === 'reminder-more-error') page.setData({ notificationsMoreError: '更早的提醒加载失败，请重试。' });
    }
    const selected = { partNumber: p.partNumber, product: p, storeNumbers: stores.slice(0, 2).map(s => s.storeNumber), stores: stores.slice(0, 2) };
    if (pageName === 'query' || pageName === 'history') {
      page.setData({ pickerValue: { partNumber: p.partNumber, storeNumbers: selected.storeNumbers }, selection: selected, dayKey: '2026-09-15', catalog });
      if (pageName === 'query') {
        page.onPickerChange({ detail: selected });
        if (['member', 'longcontent', 'expired'].includes(scenario)) page.onDoneSelection();
      }
      if (historyDataPreview || ['member', 'longcontent', 'expired', 'empty'].includes(scenario)) await page.onQuery();
    }
    if (scenario === 'error') { if (pageName === 'admin') page.setData({ allowed: false, checked: true, accessError: '模拟错误：网络连接中断，无法完成权限校验。请检查网络后重新加载。' }); else page.setData({ loadError: '模拟错误：云环境连接超时。请检查网络或稍后重试。request-id-abcdefghijklmnopqrstuvwxyz0123456789' }); }
    const ast = parse(fs.readFileSync(path.join(mini, `pages/${pageName}/index.wxml`), 'utf8'));
    const rendered = renderNode(ast, page.data, { rt });
    const componentCss = adminPreview ? '' : cssFile('components/target-picker/index.wxss').replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^{}]+)\{/g, (_, selectors) => selectors.split(',').map(selector => `.component-target-picker ${selector.trim()}`).join(',') + '{');
    const tabIndex = appConfig.tabBar.list.findIndex(tab => tab.pagePath === `pages/${pageName}/index`);
    let renderedTabs = '', tabCss = '';
    if (appConfig.tabBar.custom && tabIndex >= 0) {
      const tabComponent = rt.instantiate('custom-tab-bar/index.js', { selected: tabIndex });
      const tabAst = parse(fs.readFileSync(path.join(mini, 'custom-tab-bar/index.wxml'), 'utf8'));
      renderedTabs = renderNode(tabAst, tabComponent.data, { rt });
      tabCss = cssFile('custom-tab-bar/index.wxss');
    }
    const rawCss = `${cssFile('app.wxss')}\n${cssFile(`pages/${pageName}/index.wxss`)}\n${componentCss}\n${tabCss}`;
    for (const width of widths) {
      const css = rawCss.replace(/(-?[\d.]+)rpx/g, (_, value) => `${Number(value) * width / 750}px`).replace(/(^|[}\n])\s*page\s*\{/g, '$1 body {').replace(/(^|[}\n])\s*view, text\s*\{/g, '$1 div, span {');
      const filename = `${pageName}-${scenario}-${width}.html`;
      const tabbar = appConfig.tabBar.custom ? renderedTabs : tabIndex < 0 ? '' : '<div class="preview-tabbar">' + appConfig.tabBar.list.map(tab => {
        const selected = tab.pagePath === `pages/${pageName}/index`;
        const icon = fs.readFileSync(path.join(mini, selected ? tab.selectedIconPath : tab.iconPath)).toString('base64');
        return `<span style="display:flex;align-items:center;flex-direction:column;color:${selected ? appConfig.tabBar.selectedColor : appConfig.tabBar.color}"><img src="data:image/png;base64,${icon}" alt="" style="width:26px;height:26px;margin-bottom:5px">${html(tab.text)}</span>`;
      }).join('') + '</div>';
      const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${names[pageName]} · ${scenario} · ${width}px 离线预览</title><style>html{width:${width}px;max-width:100%;margin:0 auto}body{margin:0}button,input,textarea{font:inherit}button{cursor:default}img{display:block}input[type=checkbox]{width:36px;height:22px;flex:none;accent-color:#1ba35a}.simulation{position:sticky;top:0;z-index:10;padding:8px 12px;background:#fff2ce;color:#705000;font:11px/1.5 sans-serif;border-bottom:1px solid #ead49c}.native-nav{background:${appConfig.window.navigationBarBackgroundColor};color:${appConfig.window.navigationBarTextStyle === 'black' ? '#203932' : '#fff'};text-align:center;padding:16px;font:600 15px sans-serif}.preview-tabbar{display:flex;justify-content:space-around;gap:6px;background:white;padding:15px 8px;border-top:1px solid #ddd;font-size:12px;color:#65776c}${css}</style><div class="simulation">离线模拟 · ${width}px · ${scenario} · 使用实际 WXML/WXSS；不代表微信实测或实时库存</div><div class="native-nav">果小哨 · ${names[pageName]}</div>${rendered}${tabbar}<script>window.previewAudit=()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>document.documentElement.clientWidth+1&&getComputedStyle(e.parentElement).overflowX!=='auto'}).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right,text:e.textContent.slice(0,60)}))});</script></html>`;
      fs.writeFileSync(path.join(out, filename), body, 'utf8');
      const expectedText = adminPreview ? { 'operator-ready': ['运行统计', '128'], 'operator-denied': ['当前账号没有管理权限', '重新检查'], 'operator-loading': ['校验权限'], 'operator-error': ['权限检查失败', '重新检查'], 'operator-longcontent': ['运行统计', '查询结果', '运营查询长文本换行验收'], 'operator-saving': ['已修改', '保存配置'] }[scenario] : historyTaskPreview ? pageName === 'history' ? ['最近浏览', '浏览不扣次数', p.title, ...{
        'history-member-reward': ['今日浏览任务完成，+1 次', '已计入次数明细'],
        'history-free-first': ['还没有浏览记录', '今日浏览任务完成，+1 次', '余 1 次'],
        'history-read-error': ['浏览记录加载或奖励确认未完成', '重新加载'],
        'history-balance-cap': ['余额已达 10 次上限', '使用次数后可返回领取'],
        'history-completed': ['今日浏览任务已完成', '奖励已计入次数明细'],
        'history-longcontent': ['各地门店已有记录', '3 家门店', '今日浏览任务完成，+1 次'],
        'history-loading': ['正在加载浏览记录'],
      }[scenario]] : ['每日体验任务', '次数明细', '浏览一次历史记录', ...(scenario === 'history-balance-cap' ? ['已浏览·待领取', '暂无记录'] : ['history-read-error', 'history-loading'].includes(scenario) ? ['去完成', '暂无记录'] : ['已完成', '体验任务', '+1'])]
          : monitoringPreview ? [...(follows.length ? [p.title] : []), '后台检测', '消息发送', '微信授权', ...{
        'monitor-template-missing': ['监测服务运行中', '模板尚未配置', '关注已开启', '查看原因'],
        'monitor-ready-authorized': ['监测服务运行中', '发送服务已就绪', '剩余 1 条提醒授权', '关注已开启'],
        'monitor-needs-authorization': ['监测服务运行中', '发送服务已就绪', '剩余 0 条提醒授权', '请授权微信提醒'],
        'monitor-stale': ['后台状态已过期', '发送服务未就绪', '关注已开启'],
        'monitor-disabled': ['后台检测尚未开放', '发送服务未就绪', '关注已开启'],
        'monitor-expired-paused': ['会员已到期', '会员到期，已暂停', '了解会员'],
        'monitor-no-follows': ['先给心仪配置留个哨', '添加关注'],
        'monitor-all-paused': ['你的关注全部已暂停', '查看并开启关注'],
        'monitor-user-disabled': ['你的消息提醒已关闭', '前往提醒设置'],
        'monitor-dnd': ['当前处于免打扰时段', '查看免打扰设置'],
      }[scenario]] : paymentPreview ? ['7 天会员', '¥7.00 / 7 天', '兑换码开通', ...{
        'payment-ready': ['购买会员', '购买须知', '一次性虚拟服务', '一经售出不予退款', '一次购买 7 天'], 'payment-renew': ['续费会员', '购买须知', '按剩余有效期顺延'],
        'payment-blocked': ['付费购买暂未开放'], 'payment-old-ios': ['iOS 15'],
        'payment-pending': ['支付正在确认中', '查询支付结果'], 'payment-cancelled': ['已取消本次支付', '请查询订单状态', '查询支付结果'],
        'payment-error': ['支付结果暂未确认', '查询支付结果'], 'payment-fulfilled': ['支付已确认，会员已开通', '已开通'],
        'payment-partial-refund': ['订单已部分退款', '部分退款', '已退款 ¥3.50'],
      }[scenario]] : redemptionPreview ? ['兑换会员', '付费购买暂未开放', { 'redemption-input': '确认兑换', 'redemption-loading': '兑换中，请稍候', 'redemption-error': '兑换码无效', 'redemption-success': '兑换成功', 'redemption-used': '此账号已兑换过', 'redemption-limited': '15 分钟后再试', 'redemption-empty': '确认兑换' }[scenario]] : stockPreview ? [p.title, { 'stock-fresh': '本次状态刚记录', 'stock-old': '待更新', 'stock-unknown': '状态待确认', 'stock-missing': '等待首次观测', 'stock-restricted': '会员权益受限' }[scenario]] : scenario === 'error' ? [pageName === 'admin' ? '模拟错误：网络连接中断' : '模拟错误：云环境连接超时']
        : pageName === 'mine' ? ['7 天会员', '¥7.00', '付费购买暂未开放', '提醒记录', ...(reminderRecords.length ? ['删除记录', scenario === 'reminder-clearing' ? '清空中' : '清空'] : [])]
        : pageName === 'follow' && follows.length ? [p.title, stores[0].name]
        : pageName === 'follow' ? ['给心仪的配置留个小哨']
        : pageName === 'admin' ? ['运行统计', '128'] : [p.partNumber, p.title];
      manifest.push({ page: pageName, scenario, width, file: filename, expectedText });
    }
  }
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: mini, renderer: 'offline WXML/WXSS approximation', remoteImages: allowRemoteImages, expressionErrors: evaluationErrors.length, snapshots: manifest }, null, 2));
fs.writeFileSync(path.join(out, 'evaluation-errors.json'), JSON.stringify(evaluationErrors, null, 2));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>果小哨 · 离线排版检查</title><style>body{font:15px/1.7 sans-serif;background:#eef5f0;color:#263d30;margin:20px}select,button{font:inherit;padding:6px;margin:4px}iframe{display:block;border:1px solid #bacabd;background:white;height:900px}p{max-width:900px}</style><h1>果小哨 · 离线排版检查</h1><p>使用当前源代码中的 WXML、WXSS 和页面格式化逻辑，模拟会员、免费、到期、空内容、错误及长文本。此工具不会调用云函数、付款或发送消息；浏览器排版不是微信渲染，最终以微信开发者工具及真机验证为准。</p><select id="page">${Object.entries(names).map(([key,value])=>`<option value="${key}">${value}</option>`).join('')}</select><select id="scenario">${scenarios.map(s=>`<option>${s}</option>`).join('')}</select><select id="width">${widths.map(w=>`<option>${w}</option>`).join('')}</select><iframe id="frame"></iframe><script>const controls=[document.querySelector('#page'),document.querySelector('#scenario'),document.querySelector('#width')];function update(){const [p,s,w]=controls.map(x=>x.value);frame.style.width=w+'px';frame.src=p+'-'+s+'-'+w+'.html';}controls.forEach(x=>x.onchange=update);update();</script></html>`);
console.log(JSON.stringify({ output: out, snapshots: manifest.length, pages: Object.keys(names), scenarios, widths, remoteImages: allowRemoteImages, expressionErrors: evaluationErrors.length }, null, 2));
if (evaluationErrors.length) { console.error(JSON.stringify(evaluationErrors.slice(0, 12), null, 2)); process.exitCode = 1; }
