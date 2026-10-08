/** Offline, deterministic WXML/WXSS layout preview. This is NOT the WeChat renderer. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adminPreview = process.argv.includes('--admin-only');
if (adminPreview && process.argv.some(arg => /^--(?:reminders|stock|redemption|payment|orders|monitoring|history-task|history-data|sheets|release-notes|onboarding|notification-test|alternatives)-only$/.test(arg))) throw Error('--admin-only cannot be combined with consumer scenarios');
const mini = path.join(project, adminPreview ? 'tools/admin-miniprogram/miniprogram' : 'miniprogram');
const appConfig = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'));
appConfig.tabBar = appConfig.tabBar || { custom: false, list: [] };
// app.json colors may be theme.json variables (darkmode); resolve them per theme.
const theme = appConfig.themeLocation ? JSON.parse(fs.readFileSync(path.join(mini, appConfig.themeLocation), 'utf8')) : null;
const themed = (value, mode = 'light') => theme && typeof value === 'string' && value.startsWith('@') ? theme[mode][value.slice(1)] : value;
const navCss = mode => `.native-nav{background:${themed(appConfig.window.navigationBarBackgroundColor, mode)};color:${themed(appConfig.window.navigationBarTextStyle, mode) === 'black' ? '#203932' : '#fff'}}`;
const outputAt = process.argv.indexOf('--out');
const out = path.resolve(outputAt >= 0 ? process.argv[outputAt + 1] : path.join(os.tmpdir(), 'guoxiaoshao-ui-preview'));
const allowRemoteImages = process.argv.includes('--remote-images');
// Stress rpx rounding independently from the browser's subpixel layout. This
// is not a claim about any particular WeChat renderer's conversion rules.
const roundRpx = process.argv.includes('--round-rpx');
const rpxRoundingProfile = roundRpx ? 'whole CSS pixel rounding stress; not a WeChat renderer implementation' : null;
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
    const definition = captured;
    const defaults = Object.fromEntries(Object.entries(definition.properties || {}).map(([key, value]) => [key, value && Object.hasOwn(value, 'value') ? value.value : undefined]));
    const p = { ...definition, ...(definition.methods || {}), data: { ...defaults, ...copy(definition.data || {}), ...props } };
    p.setData = patch => { for (const [key, value] of Object.entries(patch)) { const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = p.data; for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {}); target[parts.at(-1)] = value; } };
    p.triggerEvent = () => {};
    return p;
  }
  return { load: relative => load(path.join(mini, relative)), instantiate, app, storage };
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
const sheetAst = adminPreview ? null : parse(fs.readFileSync(path.join(mini, 'components/config-sheet/index.wxml'), 'utf8'));
const nudgeAst = adminPreview ? null : parse(fs.readFileSync(path.join(mini, 'components/reminder-nudge/index.wxml'), 'utf8'));

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
  if (node.name === 'page-meta') return '';
  const attrs = node.attrs;
  if (node.name === 'reminder-nudge') {
    // Controlled presentation fixture. Prompt eligibility, persistence and
    // native gesture behavior are exercised by reminder-nudge.test.mjs.
    if (!context.nudge) return '';
    return renderNode(nudgeAst, { open: true, submitting: false, prompt: context.nudge }, context);
  }
  if (node.name === 'slot') return context.slots && context.slots[attrs.name || 'default'] || '';
  if (node.name === 'config-sheet') {
    const props = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (['id', 'wx:if'].includes(key) || key.startsWith('bind')) continue;
      props[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = evaluate(value, scope);
    }
    const sheet = context.rt.instantiate('components/config-sheet/index.js', { ...props, keyboardHeight: context.keyboardHeight || 0 });
    const slots = {};
    for (const child of node.children) {
      const slot = child.attrs && child.attrs.slot || 'default';
      (slots[slot] ||= []).push(child);
    }
    for (const name of Object.keys(slots)) slots[name] = renderChildren(slots[name], scope, context);
    return `<div class="component-config-sheet">${renderNode(sheetAst, sheet.data, { ...context, slots })}</div>`;
  }
  if (node.name === 'target-picker') {
    const p = context.rt.instantiate('components/target-picker/index.js', { catalogVersion: evaluate(attrs['catalog-version'] || '', scope), value: evaluate(attrs.value || '', scope), maxStores: Number(evaluate(attrs['max-stores'] || '3', scope)), storesOptional: truth(attrs['stores-optional'] || '', scope), supportedOnly: truth(attrs['supported-only'] || '', scope) });
    p.loadCatalog(); if (p.data.value) p.onValue(p.data.value);
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
  if (node.name === 'button' && attrs.size) renderedAttrs += ` size="${html(evaluate(attrs.size, scope))}"`;
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
const orderRecordsPreview = process.argv.includes('--orders-only');
const monitoringPreview = process.argv.includes('--monitoring-only');
const historyTaskPreview = process.argv.includes('--history-task-only');
const historyDataPreview = process.argv.includes('--history-data-only');
const sheetPreview = process.argv.includes('--sheets-only');
const releaseNotesPreview = process.argv.includes('--release-notes-only');
const onboardingPreview = process.argv.includes('--onboarding-only');
const notificationTestPreview = process.argv.includes('--notification-test-only');
const alternativesPreview = process.argv.includes('--alternatives-only');
const nudgePreview = process.argv.includes('--nudge-only');
// Targeted cascade stress from the device-reported fixed-width button failure.
// :where keeps the same specificity as button:not([size=mini]); this deliberately
// is not a complete implementation of WeChat's native component stylesheet.
const buttonConstraintProfile = alternativesPreview ? 'regression stress only: alternative-panel button:not([size=mini]) fixed 184px, min-width:min-content, auto inline margins; not verified WeChat implementation' : null;
const buttonConstraintCss = buttonConstraintProfile ? ':where(.alternative-panel) button:not([size=mini]){width:184px;min-width:min-content;margin-left:auto;margin-right:auto;}' : '';
const widths = [320, 375, 430], scenarios = adminPreview ? ['operator-ready', 'operator-denied', 'operator-loading', 'operator-error', 'operator-longcontent', 'operator-saving'] : historyTaskPreview ? ['history-member-reward', 'history-free-first', 'history-read-error', 'history-balance-cap', 'history-completed', 'history-longcontent', 'history-loading'] : monitoringPreview ? ['monitor-template-missing', 'monitor-ready-authorized', 'monitor-needs-authorization', 'monitor-stale', 'monitor-disabled', 'monitor-expired-paused'] : redemptionPreview ? ['redemption-input', 'redemption-loading', 'redemption-error', 'redemption-success', 'redemption-used', 'redemption-limited', 'redemption-empty'] : stockPreview ? ['stock-fresh', 'stock-old', 'stock-unknown', 'stock-missing', 'stock-restricted'] : reminderPreview ? ['reminders', 'reminder-empty', 'reminder-loading', 'reminder-deleting', 'reminder-clearing', 'reminder-error', 'reminder-more-error', 'longcontent'] : ['free', 'member', 'expired', 'empty', 'error', 'loading', 'longcontent'];
if (historyDataPreview) scenarios.splice(0, scenarios.length, 'history-no-data', 'history-unknown-only', 'history-observed-no-events', 'history-events-only', 'history-observed-events', 'history-partial-stores');
if (paymentPreview) scenarios.splice(0, scenarios.length, 'payment-ready', 'payment-renew', 'payment-blocked', 'payment-old-ios', 'payment-pending', 'payment-cancelled', 'payment-error', 'payment-fulfilled', 'payment-partial-refund', 'payment-monthly', 'payment-annual', 'payment-pending-monthly', 'payment-member', 'payment-upgrade-monthly', 'payment-upgrade-annual', 'payment-member-pending-monthly', 'payment-rules');
if (orderRecordsPreview) scenarios.splice(0, scenarios.length, 'orders-single', 'orders-deleting', 'orders-clearing', 'orders-error', 'orders-pending', 'orders-empty', 'orders-legacy');
if (sheetPreview) scenarios.splice(0, scenarios.length, 'sheet-edit', 'sheet-keyboard', 'sheet-longcontent', 'sheet-saving');
if (releaseNotesPreview) scenarios.splice(0, scenarios.length, 'free', 'member', 'longcontent');
if (onboardingPreview) scenarios.splice(0, scenarios.length, 'onboarding-first', 'onboarding-signing', 'onboarding-error', 'onboarding-signed', 'onboarding-shared', 'onboarding-share-pending', 'onboarding-share-catalog', 'onboarding-share-error');
if (notificationTestPreview) scenarios.splice(0, scenarios.length, 'notification-test-ready', 'notification-test-no-quota', 'notification-test-accepted', 'notification-test-uncertain', 'notification-test-failed', 'notification-test-received', 'notification-test-not-received');
if (alternativesPreview) scenarios.splice(0, scenarios.length, 'alternatives-default', 'alternatives-selection', 'alternatives-premium', 'alternatives-free', 'alternatives-match', 'alternatives-prepared', 'alternatives-empty', 'alternatives-error', 'alternatives-expired', 'alternatives-cached');
if (nudgePreview) scenarios.splice(0, scenarios.length, 'nudge-restock', 'nudge-both', 'nudge-one');
const names = nudgePreview ? { mine: '我的' } : alternativesPreview ? { query: '查询' } : notificationTestPreview ? { 'notification-test': '通知测试' } : adminPreview ? { admin: '运营工具' } : onboardingPreview ? { query: '查询' } : paymentPreview || orderRecordsPreview ? { mine: '我的' } : historyDataPreview ? { history: '历史' } : historyTaskPreview ? { history: '历史', mine: '我的' } : stockPreview || monitoringPreview ? { follow: '小哨提醒' } : reminderPreview || redemptionPreview || releaseNotesPreview ? { mine: '我的' } : { query: '查询', follow: '小哨提醒', history: '历史', mine: '我的' };
if (sheetPreview) delete names.mine;
if (monitoringPreview) scenarios.push('monitor-no-follows', 'monitor-all-paused', 'monitor-user-disabled', 'monitor-dnd', 'monitor-free-account', 'monitor-alert', 'monitor-dual-ready', 'monitor-dual-soldout-empty', 'monitor-dual-restock-empty', 'monitor-dual-soldout-low', 'monitor-dual-pending', 'monitor-dual-native', 'monitor-dual-sync-error', 'monitor-dual-storage-error');
fs.mkdirSync(out, { recursive: true });
const manifest = [];

for (const scenario of scenarios) {
  const products = copy(baseProducts);
  if (['longcontent', 'history-longcontent', 'sheet-longcontent'].includes(scenario)) { const p = products.find(p => p.partNumber === sample.partNumber); p.title += ' · 超长商品名称与配置说明用于检查换行及小屏布局 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; }
  const p = products.find(p => p.partNumber === sample.partNumber), member = nudgePreview ? true : alternativesPreview ? scenario !== 'alternatives-free' : historyTaskPreview ? ['history-member-reward', 'history-longcontent'].includes(scenario) : monitoringPreview ? !['monitor-expired-paused', 'monitor-free-account'].includes(scenario) : stockPreview ? scenario !== 'stock-restricted' : ['member', 'longcontent'].includes(scenario), expired = scenario === 'expired' || scenario === 'monitor-expired-paused';
  const bootstrap = { identity: { userKey: 'preview:offline-user', openidMasked: 'preview…0001', isAdmin: true }, membership: { active: member, remainingMs: member ? 18 * 86400000 : 0, expiresAt: member ? '2026-10-03T07:00:00Z' : expired ? '2026-09-10T07:00:00Z' : null },
    quota: { balance: member ? 5 : 0, revision: 0, grantedToday: 0, dailyGrantCap: 2, balanceCap: 10, queryCost: 1, historyCost: 1, signedInToday: false, tasksDoneToday: [], tasksViewedToday: [] }, tasks: [{ id: 'view_history', title: '浏览一次历史记录', reward: 1 }],
    collector: { state: scenario === 'expired' ? 'stale' : 'not_deployed' }, memberProduct: { id: 'vip666', title: '7 天会员', days: 7, priceFen: 700, enabled: paymentPreview && scenario !== 'payment-blocked', paymentReady: paymentPreview && scenario !== 'payment-blocked', iosEnabled: true, note: '该产品为一次性虚拟服务，一经售出不予退款。一次购买 7 天，已有会员按剩余有效期顺延，不自动续费。', paymentReason: '购买开放后可在此开通会员。' },
    notifications: { enabled: false, templateIds: {} }, subscriptions: {}, settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 1380, endMinute: 480 } },
    limits: { maxFollows: 3, maxStoresPerFollow: 3, queryMaxStores: 3 }, followCount: scenario === 'empty' ? 0 : 1, catalogVersion: 'offline-preview' };
  if (paymentPreview) bootstrap.memberProducts = [
    { ...bootstrap.memberProduct, planId: 'member_7d', limits: { maxFollows: 3, maxStoresPerFollow: 3 } },
    { ...bootstrap.memberProduct, id: 'member_30d', planId: 'member_30d', limits: { maxFollows: 4, maxStoresPerFollow: 4 }, title: '30 天会员', days: 30, priceFen: 1990, note: '' },
    { ...bootstrap.memberProduct, id: 'member_365d', planId: 'member_365d', limits: { maxFollows: 4, maxStoresPerFollow: 4 }, title: '365 天会员', days: 365, priceFen: 20000, note: '' },
  ];
  if (notificationTestPreview) bootstrap.quota.balance = scenario === 'notification-test-no-quota' ? 0 : 2;
  if (scenario === 'alternatives-premium') Object.assign(bootstrap.limits, { queryMaxStores: 4, alternativeMaxColors: 4 });
  if (scenario === 'history-balance-cap') bootstrap.quota.balance = 10;
  if (sheetPreview) bootstrap.membership = { active: true, expiresAt: '2026-09-22T07:00:00Z', remainingMs: 7 * 86400000 };
  if (['payment-renew', 'payment-member', 'payment-upgrade-monthly', 'payment-upgrade-annual', 'payment-member-pending-monthly'].includes(scenario)) bootstrap.membership = { active: true, remainingMs: 18 * 86400000, expiresAt: '2026-10-03T07:00:00Z' };
  const previewOrder = { orderId: '', productId: 'vip666', source: 'virtual_payment', type: 'membership', amountFen: 700, days: 7, createdAt: now.toISOString(),
    status: scenario === 'payment-partial-refund' ? 'partially_refunded' : scenario === 'payment-fulfilled' ? 'fulfilled' : 'created',
    paymentPending: scenario === 'payment-pending', fulfilledAt: ['payment-partial-refund', 'payment-fulfilled'].includes(scenario) ? now.toISOString() : null,
    refundFen: scenario === 'payment-partial-refund' ? 350 : 0 };
  if (['payment-pending-monthly', 'payment-member-pending-monthly'].includes(scenario)) Object.assign(previewOrder, {
    orderId: 'offline-original-monthly-order', productId: 'offline-monthly-goods', planId: 'member_30d', days: 30, amountFen: 1990, paymentPending: true,
  });
  const notificationTest = ['notification-test-ready', 'notification-test-no-quota'].includes(scenario) ? null : {
    requestId: 'offline-notification-test', status: scenario === 'notification-test-failed' ? 'failed' : scenario === 'notification-test-uncertain' ? 'uncertain' : 'accepted',
    charged: 1, refunded: scenario === 'notification-test-failed' ? 1 : 0, feedback: null,
  };
  const notificationResult = () => ({ userKey: bootstrap.identity.userKey, ready: true, templateId: 'offline-notification-template',
    balance: bootstrap.quota.balance, quotaRevision: bootstrap.quota.revision, quota: copy(bootstrap.quota), test: copy(notificationTest) });
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
  if (alternativesPreview) {
    if (!member) { bootstrap.quota.balance = 2; bootstrap.newProductWindows = []; }
    const offset = scenario === 'alternatives-expired' ? -121000 : 0;
    Object.assign(response, { queryId: 'query-alternative-preview', member, charged: member ? 0 : 1, refunded: 0,
      balance: bootstrap.quota.balance, quotaRevision: bootstrap.quota.revision,
      queriedAt: new Date(now.getTime() + offset).toISOString(), finishedAt: new Date(now.getTime() + offset).toISOString(),
      alternativesExpiresAt: new Date(now.getTime() + offset + 120000).toISOString(),
      results: response.results.map(row => ({ ...row, status: 'unavailable', observedAt: new Date(now.getTime() + offset).toISOString(), quote: '离线模拟：当前门店暂无供应' })),
    });
  }
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
    if (scenario.startsWith('monitor-dual-')) {
      bootstrap.notifications.templateIds.soldout = 'offline-soldout-template';
      bootstrap.subscriptions = {
        [templateId]: { credits: scenario === 'monitor-dual-restock-empty' ? 0 : 8 },
        'offline-soldout-template': { credits: scenario === 'monitor-dual-soldout-empty' ? 0 : scenario === 'monitor-dual-soldout-low' ? 1 : 5 },
      };
    }
    bootstrap.settings = { notifyEnabled: true, dnd: { enabled: false, startMinute: 1380, endMinute: 480 } };
    if (expired) { follows[0].status = 'paused'; follows[0].statusReason = 'membership_expired'; }
    const observedAt = new Date(now.getTime() - (collectorState === 'running' ? 15000 : 360000)).toISOString();
    follows[0].stores = stores.slice(0, 2).map(s => ({ storeNumber: s.storeNumber, storeName: s.name, city: s.city,
      status: 'unavailable', lastKnownStatus: 'unavailable', observedAt, statusSince: new Date(now.getTime() - 3600000).toISOString() }));
    if (scenario === 'monitor-all-paused') follows[0].status = 'paused';
    if (scenario === 'monitor-no-follows') { follows.length = 0; bootstrap.followCount = 0; }
    if (scenario === 'monitor-user-disabled') bootstrap.settings.notifyEnabled = false;
    if (scenario === 'monitor-dnd') bootstrap.settings.dnd = { enabled: true, startMinute: 480, endMinute: 1080 };
    if (scenario === 'monitor-free-account') { follows.length = 0; Object.assign(bootstrap, { freeReminder: false, followCount: 0, subscriptions: {} }); }
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
  bootstrap.limits.maxFollows = bootstrap.membership.active ? 3 : 0;
  const previewCalls = [];
  let recordOrders = orderRecordsPreview ? [
    { orderId: 'grant_' + '0123456789abcdef'.repeat(4), source: 'admin_grant', days: 30, amountFen: 0, status: 'fulfilled', canClearRecord: true, fulfilledAt: now.toISOString() },
    { orderId: 'offline-paid-monthly', days: 30, amountFen: 1990, status: 'fulfilled', canClearRecord: true, fulfilledAt: now.toISOString() },
    { orderId: 'offline-payment-unconfirmed', days: 365, amountFen: 20000, status: 'paid', canClearRecord: false, clearRecordReason: 'payment_unconfirmed', paidAt: now.toISOString() },
  ] : [];
  if (scenario === 'orders-single') recordOrders = recordOrders.slice(0, 1);
  if (scenario === 'orders-empty') recordOrders = recordOrders.slice(0, 2);
  if (scenario === 'orders-pending') recordOrders = recordOrders.slice(1);
  if (scenario === 'orders-legacy') recordOrders.forEach(item => { delete item.canClearRecord; delete item.clearRecordReason; });
  const rt = sandbox(async (action, payload) => {
    previewCalls.push({ action, payload });
    if (action === 'user.bootstrap') return copy(bootstrap);
    if (action === 'catalog.get') return raw;
    if (action === 'follow.list') return { follows, limits: bootstrap.limits };
    if (action === 'history.list' || action === 'query.pickup') return response;
    if (action === 'query.alternatives') {
      if (scenario === 'alternatives-error') throw Error('已有观测暂未读取成功，请检查网络后重试。');
      const observedAt = new Date(now.getTime() - 15000).toISOString();
      return { queryId: payload.queryId, basePartNumber: p.partNumber, partNumbers: payload.partNumbers, storeNumbers: payload.storeNumbers,
        finishedAt: response.finishedAt, expiresAt: response.alternativesExpiresAt, readAt: now.toISOString(),
        results: scenario === 'alternatives-empty' ? [] : payload.partNumbers.flatMap(partNumber => payload.storeNumbers.filter(storeNumber => !response.results.some(row => row.storeNumber === storeNumber)).map(storeNumber => ({
          partNumber, storeNumber, status: 'available', observedAt, knownAt: observedAt, expiresAt: new Date(now.getTime() + 105000).toISOString(),
        }))),
      };
    }
    if (action === 'history.browse') {
      if (scenario === 'history-read-error') throw Error('offline history browse response failed');
      if (scenario === 'history-loading') return new Promise(() => {});
      return { recentViews, browsedAt: now.toISOString(), task: completeHistoryTask() };
    }
    if (action === 'quota.completeTask') return completeHistoryTask();
    if (action === 'quota.ledger') return { balance: bootstrap.quota.balance, entries: copy(ledgerEntries) };
    if (action === 'member.status') return { orders: orderRecordsPreview ? copy(recordOrders) : previewOrder.orderId ? [copy(previewOrder)] : [] };
    if (action === 'member.deleteRecord' || action === 'member.clearRecords') {
      if (scenario === 'orders-error') throw Error('offline preview timeout');
      const hiddenOrderIds = payload.orderIds || [payload.orderId];
      recordOrders = recordOrders.filter(item => !hiddenOrderIds.includes(item.orderId));
      return { hiddenOrderIds, retained: [] };
    }
    if (action === 'member.createOrder') {
      previewOrder.orderId = payload.orderId;
      if (scenario === 'payment-error') throw Object.assign(Error('offline mock timeout'), { code: 'call_failed' });
      return { ok: true, order: copy(previewOrder), payment: { mode: 'short_series_goods', signData: '{"offlinePreview":true}', paySig: 'offline-preview', signature: 'offline-preview' } };
    }
    if (action === 'member.checkOrder') return { order: copy(previewOrder), membership: previewOrder.fulfilledAt ? copy(paidMembership) : copy(bootstrap.membership) };
    if (action === 'notificationTest.status') return notificationResult();
    if (action === 'notificationTest.feedback') {
      if (!notificationTest || !['received', 'not_received'].includes(payload.outcome)) throw Error('Invalid offline test feedback');
      notificationTest.feedback = payload.outcome;
      return notificationResult();
    }
    if (action === 'notify.detail') return { notification: { eventId: 'preview-event', status: 'accepted', eventType: 'restock_confirmed', partNumber: p.partNumber, storeNumber: stores[0].storeNumber, storeName: stores[0].name, productTitle: p.title, detectedAt: new Date(now.getTime() - 120000).toISOString(), feedback: null },
      latest: { restricted: false, status: 'available', isStale: false, lastKnownStatus: 'available', statusSince: new Date(now.getTime() - 120000).toISOString(), observedAt: new Date(now.getTime() - 15000).toISOString(), unknownSince: null }, follow: { followId: 'f-preview', status: 'active' } };
    if (action === 'notify.list') return { notifications: reminderRecords, hasMore: reminderPreview && ['reminders','reminder-more-error'].includes(scenario), nextCursor: 'preview-next-cursor', clearBefore: 'preview-opaque-clear-token' };
    if (action === 'admin.stats' && scenario === 'operator-denied') throw Object.assign(Error('需要管理员权限'), { code: 'forbidden' });
    if (action === 'admin.stats' && scenario === 'operator-error') throw Error('连接中断');
    if (action === 'admin.stats') return { users: 128, activeFollows: 32, events: 1024, queries: 2086, serverTime: now.toISOString() };
    if (action === 'admin.insights') return { since: '2026-09-08T07:00:00Z', truncated: scenario === 'operator-longcontent',
      availability: { count: 42, p50Ms: 90000, p90Ms: 600000, buckets: [{ label: '不足 1 分钟', count: 16 }, { label: '1 至 5 分钟', count: 18 }, { label: '超过 5 分钟', count: 8 }] },
      alerts: { total: 80, byStatus: { accepted: 60, skipped: 20 }, noCreditShare: 0.125, sendDelay: { p50Ms: 10000, p90Ms: 45000 } },
      feedback: { answered: 18, bought: 10, missed: 6, skipped: 2, boughtShare: 10 / 18 },
      activity: { successfulQueryUsers: 56, followUsers: 24, acceptedAlertUsers: 18, openedAlertUsers: 12, boughtUsers: 8 },
      notificationTests: { total: 28, users: 20, byStatus: { accepted: 24, failed: 2, uncertain: 2 }, feedback: { received: 15, not_received: 3 } },
    };
    if (action === 'admin.getConfig') return { config: { announcement: '离线模拟预览', quota: { balanceCap: 10 }, notifications: { enabled: false }, memberProduct: { enabled: false } } };
    return {};
  }, { paymentScenario: paymentPreview ? scenario : '' });
  if (['payment-pending-monthly', 'payment-member-pending-monthly'].includes(scenario)) rt.storage.set(`gxs_member_payment_v1:${encodeURIComponent(bootstrap.identity.userKey)}`, {
    orderId: previewOrder.orderId, planId: 'member_30d',
  });
  const catalog = adminPreview || notificationTestPreview ? null : await rt.load('utils/store.js').getCatalog({ force: true });
  for (const pageName of Object.keys(names)) {
    const page = rt.instantiate(`pages/${pageName}/index.js`);
    if (['payment-pending-monthly', 'payment-member-pending-monthly'].includes(scenario)) page.setData({ selectedPlanId: 'member_365d' });
    if (pageName === 'follow' && scenario === 'monitor-alert') Object.assign(rt.app.globalData, { pendingAlert: 'preview-event', handledAlerts: [] });
    // 'loading' shows the skeleton a page renders before its first data arrives.
    if (!['operator-loading', 'loading'].includes(scenario)) await page.onLoad();
    // Notification feedback requires a visible page, just like an actual tap
    // in WeChat. onLoad alone now intentionally represents a hidden preload.
    if (alternativesPreview || notificationTestPreview) await page.onShow();
    if (scenario === 'monitor-alert') await new Promise(resolve => setImmediate(resolve));
    if (adminPreview && ['operator-ready', 'operator-longcontent'].includes(scenario)) await page.onLoadInsights();
    if (scenario === 'operator-saving') page.setData({ saving: true, configDirty: true });
    if (scenario === 'operator-longcontent') page.setData({ lookup: { user: true }, lookupText: JSON.stringify({ userKey: 'wxe96ad9e77b602f1b:long-user-identity-0123456789abcdefghijklmnopqrstuvwxyz', note: '运营查询长文本换行验收' }, null, 2), configText: JSON.stringify({ announcement: '运行配置说明需要在小屏完整换行且不遮挡操作按钮。'.repeat(5) }, null, 2) });
    if (pageName === 'history' && scenario !== 'history-loading' && page.browsePending) await page.browsePending;
    // Mine sections are collapsed by default; open the ones each audit checks.
    if (pageName === 'mine' && historyTaskPreview) { page.setData({ showQuotaDetails: true }); await page.onToggleLedger(); }
    if (pageName === 'mine' && orderRecordsPreview) {
      await page.onToggleOrders();
      if (scenario === 'orders-pending') {
        page.setData({ paymentPendingId: 'offline-paid-monthly', paymentMessage: '支付结果待核对，请先查询原订单。' });
        page.setOrderRecords(page.data.orders);
      }
      if (scenario === 'orders-deleting') page.setData({ orderActionBusy: 'delete', orderDeletingId: recordOrders[0].orderId });
      if (scenario === 'orders-clearing') page.setData({ orderActionBusy: 'clear' });
      if (['orders-error', 'orders-empty'].includes(scenario)) await page.onClearOrders();
    }
    if (pageName === 'mine' && paymentPreview) {
      if (scenario === 'payment-rules') page.setData({ showMembershipRules: true });
      if (scenario === 'payment-renew') page.onOpenMembershipRenew();
      if (['payment-upgrade-monthly', 'payment-upgrade-annual'].includes(scenario)) {
        page.onOpenMembershipUpgrade();
        if (scenario === 'payment-upgrade-annual') page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_365d' } } });
      }
      if (['payment-monthly', 'payment-annual'].includes(scenario)) page.onSelectMemberProduct({ currentTarget: { dataset: { planId: scenario === 'payment-monthly' ? 'member_30d' : 'member_365d' } } });
      if (['payment-pending-monthly', 'payment-member-pending-monthly'].includes(scenario)) {
        await page.onCheckPayment();
        if (page.data.selectedPlanId !== 'member_30d' || page.data.paymentPendingId !== previewOrder.orderId) throw Error('Original monthly order was not retained in offline preview');
      }
    }
    if (notificationTestPreview && ['notification-test-received', 'notification-test-not-received'].includes(scenario)) {
      const outcome = scenario === 'notification-test-received' ? 'received' : 'not_received';
      await page.onFeedback({ currentTarget: { dataset: { outcome } } });
      if (page.data.test.feedback !== outcome || !page.data.feedbackNote) throw Error('Visible offline test feedback was not recorded');
    }
    if (pageName === 'mine' && reminderPreview) page.setData({ showNotifications: true });
    if (pageName === 'mine' && releaseNotesPreview) {
      page.onToggleReleaseNotes();
      if (scenario === 'longcontent') page.onToggleOlderReleaseNotes();
    }
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
    // Combined authorization must remain visible with service details collapsed.
    if (pageName === 'follow' && monitoringPreview) {
      page.setData({ showServiceDetails: !scenario.startsWith('monitor-dual-') });
      if (['monitor-dual-pending', 'monitor-dual-native', 'monitor-dual-sync-error', 'monitor-dual-storage-error'].includes(scenario)) {
        page.setData({ authorizationSession: true, authorizationPanelFirst: true, authorizationFeedback: '微信已允许：到货 +1，断货 +1' });
        page.applyAuthorizationState({
          nativeBusy: scenario === 'monitor-dual-native', syncing: scenario === 'monitor-dual-pending', pendingCount: 100,
          acceptedByTemplate: { 'offline-template-example': 100, 'offline-soldout-template': 99 },
          error: scenario === 'monitor-dual-sync-error' ? { code: 'timeout', message: '网络较慢，授权记录尚未同步。' }
            : scenario === 'monitor-dual-storage-error' ? { code: 'subscription_storage_failed', message: '授权尚未保存，请保持小程序开启并重试同步。' } : null,
          storageBlocked: scenario === 'monitor-dual-storage-error',
        });
      }
      page.refreshReadiness();
    }
    // Stock audits deliberately open per-card details to verify retained
    // historical explanations. Ordinary page scenarios keep their default fold.
    if (pageName === 'follow' && stockPreview) {
      for (const follow of page.data.follows) page.onToggleFollowDetails({ currentTarget: { dataset: { id: follow.followId } } });
    }
    if (pageName === 'mine' && reminderPreview) {
      if (scenario === 'reminder-loading') page.setData({ notificationsLoading: true });
      if (scenario === 'reminder-deleting') page.setData({ notificationActionBusy: 'delete', notificationDeletingId: reminderRecords[0].id });
      if (scenario === 'reminder-clearing') page.setData({ notificationActionBusy: 'clear' });
      if (scenario === 'reminder-error') page.setData({ notificationsActionError: '清空结果未确认，记录暂时保留。可重试原清空操作，新到提醒不受影响。' });
      if (scenario === 'reminder-more-error') page.setData({ notificationsMoreError: '更早的提醒加载失败，请重试。' });
    }
    const selected = { partNumber: p.partNumber, product: p, storeNumbers: stores.slice(0, 2).map(s => s.storeNumber), stores: stores.slice(0, 2) };
    if ((pageName === 'query' || pageName === 'history') && scenario !== 'loading') {
      page.setData({ pickerValue: { partNumber: p.partNumber, storeNumbers: selected.storeNumbers }, dayKey: '2026-09-15' });
      page.onPickerChange({ detail: selected });
      if (pageName === 'query') {
        if (alternativesPreview || ['member', 'longcontent', 'expired'].includes(scenario)) page.onDoneSelection();
      }
      if (alternativesPreview || historyDataPreview || ['member', 'longcontent', 'expired', 'empty'].includes(scenario)) await page.onQuery();
    }
    if (alternativesPreview) {
      if (scenario === 'alternatives-cached') { page.setData({ resultIsCache: true }); page.refreshStoreChoices(); }
      if (!page.data.alternativeStoreChoices.some(item => item.selected && selected.storeNumbers.includes(item.storeNumber))) throw Error('Original stores were not selected by default');
      if (scenario !== 'alternatives-default') {
        const otherColor = page.data.alternativeColorChoices.find(item => item.partNumber !== p.partNumber);
        const otherStore = page.data.alternativeStoreChoices.find(item => !selected.storeNumbers.includes(item.storeNumber));
        if (!otherColor || !otherStore) throw Error('Catalog fixture needs another permitted color and same-city/nearby store outside the original query');
        page.onToggleAlternative({ currentTarget: { dataset: { kind: 'part', value: otherColor.partNumber } } });
        page.onToggleAlternative({ currentTarget: { dataset: { kind: 'store', value: otherStore.storeNumber } } });
        if (page.selection.partNumber !== p.partNumber || page.selection.storeNumbers.join() !== selected.storeNumbers.join()) throw Error('Selecting alternatives changed the active query without explicit preparation');
        if (scenario === 'alternatives-premium') {
          for (const color of page.data.alternativeColorChoices.slice(0, 4)) {
            if (!page.data.alternativeParts.includes(color.partNumber)) page.onToggleAlternative({ currentTarget: { dataset: { kind: 'part', value: color.partNumber } } });
          }
          for (const store of page.data.alternativeStoreChoices.slice(0, 4)) {
            if (!page.data.alternativeStores.includes(store.storeNumber)) page.onToggleAlternative({ currentTarget: { dataset: { kind: 'store', value: store.storeNumber } } });
          }
          if (page.data.alternativeParts.length !== 4 || page.data.alternativeStores.length !== 4) throw Error('Premium layout fixture must select four colors and four stores through the page handlers');
        }
        if (!['alternatives-selection', 'alternatives-premium', 'alternatives-free', 'alternatives-expired', 'alternatives-cached'].includes(scenario)) await page.onReadAlternatives();
        if (['alternatives-match', 'alternatives-prepared'].includes(scenario) && page.data.alternativeMatches.length !== 1) throw Error('Expected one fresh alternate-color, outside-original-store observation');
        if (scenario === 'alternatives-prepared') {
          await page.onPrepareAlternative({ currentTarget: { dataset: { key: page.data.alternativeMatches[0].key } } });
          if (page.selection.partNumber !== otherColor.partNumber || page.selection.storeNumbers.join() !== otherStore.storeNumber) throw Error('Explicit preparation did not retain the user-selected alternative');
        }
        if (scenario === 'alternatives-empty' && page.data.alternativeMatches.length) throw Error('Empty observation response created a stock match');
        if (!page.data.alternativeSelectedColors.length) throw Error('Selected colors did not create an explicit manual query action');
      }
      if (['alternatives-cached', 'alternatives-expired'].includes(scenario) && (page.data.alternativeCanRead || page.data.alternativeMatches.length)) throw Error('Expired/cached observations remained accessible');
      const expectedReads = ['alternatives-default', 'alternatives-selection', 'alternatives-premium', 'alternatives-free', 'alternatives-expired', 'alternatives-cached'].includes(scenario) ? 0 : scenario === 'alternatives-prepared' ? 2 : 1;
      if (previewCalls.filter(item => item.action === 'query.pickup').length !== 1 || previewCalls.filter(item => item.action === 'query.alternatives').length !== expectedReads) throw Error('Alternative UI started an unexpected sampling/read request');
    }
    if (onboardingPreview) page.setData({
      signing: scenario === 'onboarding-signing',
      signinError: scenario === 'onboarding-error' ? '签到暂未确认，请重试；同一天不会重复领取。' : null,
      'boot.signedInToday': scenario === 'onboarding-signed',
      sharedSelection: scenario === 'onboarding-shared',
      sharedTargetPending: scenario.startsWith('onboarding-share-'),
      sharedTargetReady: scenario === 'onboarding-share-pending',
      sharedTargetError: scenario === 'onboarding-share-error' ? '商品目录刷新失败，可稍后重试，当前选择已保留。' : null,
    });
    if (scenario === 'error') { if (pageName === 'admin') page.setData({ allowed: false, checked: true, accessError: '模拟错误：网络连接中断，无法完成权限校验。请检查网络后重新加载。' }); else page.setData({ loadError: '模拟错误：云环境连接超时。请检查网络或稍后重试。request-id-abcdefghijklmnopqrstuvwxyz0123456789' }); }
    if (sheetPreview) {
      if (pageName === 'follow') {
        page.onEdit({ currentTarget: { dataset: { id: follows[0].followId } } });
        // Rendering a slotted component alone does not deliver its native
        // change event. Resolve the actual picker before the sheet snapshot.
        const picker = rt.instantiate('components/target-picker/index.js', { value: page.data.editor.pickerValue, maxStores: page.data.limits.maxStoresPerFollow, supportedOnly: true, inSheet: true });
        picker.onCatalog(catalog);
        page.onEditorChange({ detail: picker.getSelection() });
      }
      else page.onEditSelection();
      if (scenario === 'sheet-saving' && pageName === 'follow') page.setData({ saving: true });
    }
    const ast = parse(fs.readFileSync(path.join(mini, `pages/${pageName}/index.wxml`), 'utf8'));
    const nudge = nudgePreview ? { title: scenario === 'nudge-both' ? '补充到货和断货提醒次数' : '补充到货提醒次数', restockCount: 1, soldoutCount: scenario === 'nudge-both' ? 0 : 15, soldoutEnabled: scenario !== 'nudge-one', detail: '已有次数会保留。每项选择「允许」增加 1 次，消息发送后消耗对应次数。' } : null;
    const rendered = renderNode(ast, page.data, { rt, nudge, keyboardHeight: scenario === 'sheet-keyboard' ? 280 : 0 });
    if (alternativesPreview && !rendered.includes('换个颜色或门店，继续找货')) throw Error('Manual alternative choices were hidden');
    const componentCss = adminPreview ? '' : cssFile('components/target-picker/index.wxss').replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^{}]+)\{/g, (_, selectors) => selectors.trim().startsWith('@') ? `${selectors}{` : selectors.split(',').map(selector => `.component-target-picker ${selector.trim()}`).join(',') + '{');
    const tabIndex = appConfig.tabBar.list.findIndex(tab => tab.pagePath === `pages/${pageName}/index`);
    let renderedTabs = '', tabCss = '';
    if (appConfig.tabBar.custom && tabIndex >= 0) {
      const tabComponent = rt.instantiate('custom-tab-bar/index.js', { selected: tabIndex, sheetHidden: Boolean(page.data.sheetVisible || page.data.editing || page.data.redemptionOpen) });
      const tabAst = parse(fs.readFileSync(path.join(mini, 'custom-tab-bar/index.wxml'), 'utf8'));
      renderedTabs = renderNode(tabAst, tabComponent.data, { rt });
      tabCss = cssFile('custom-tab-bar/index.wxss');
    }
    const rawCss = `${buttonConstraintCss}\n${cssFile('app.wxss')}\n${cssFile(`pages/${pageName}/index.wxss`)}\n${componentCss}\n${adminPreview ? '' : cssFile('components/config-sheet/index.wxss') + cssFile('components/reminder-nudge/index.wxss')}\n${tabCss}`;
    for (const width of widths) {
      const css = rawCss.replace(/(-?[\d.]+)rpx/g, (_, value) => { const pixels = Number(value) * width / 750; return `${roundRpx ? Math.round(pixels) : pixels}px`; }).replace(/(^|[}\n])\s*page\s*\{/g, '$1 body {').replace(/(^|[}\n])\s*view, text\s*\{/g, '$1 div, span {');
      const filename = `${pageName}-${scenario}-${width}.html`;
      const tabbar = appConfig.tabBar.custom ? renderedTabs : tabIndex < 0 ? '' : '<div class="preview-tabbar">' + appConfig.tabBar.list.map(tab => {
        const selected = tab.pagePath === `pages/${pageName}/index`;
        const icon = fs.readFileSync(path.join(mini, selected ? tab.selectedIconPath : tab.iconPath)).toString('base64');
        return `<span style="display:flex;align-items:center;flex-direction:column;color:${selected ? appConfig.tabBar.selectedColor : appConfig.tabBar.color}"><img src="data:image/png;base64,${icon}" alt="" style="width:26px;height:26px;margin-bottom:5px">${html(tab.text)}</span>`;
      }).join('') + '</div>';
      const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${names[pageName]} · ${scenario} · ${width}px 离线预览</title><style>html{width:${width}px;max-width:100%;margin:0 auto}body{margin:0}button,input,textarea{font:inherit}button{cursor:default}img{display:block}input[type=checkbox]{width:36px;height:22px;flex:none;accent-color:#1ba35a}.simulation{position:sticky;top:0;z-index:10;padding:8px 12px;background:#fff2ce;color:#705000;font:11px/1.5 sans-serif;border-bottom:1px solid #ead49c}.native-nav{text-align:center;padding:16px;font:600 15px sans-serif}${navCss('light')}${theme ? `@media (prefers-color-scheme: dark){${navCss('dark')}}` : ''}.preview-tabbar{display:flex;justify-content:space-around;gap:6px;background:white;padding:15px 8px;border-top:1px solid #ddd;font-size:12px;color:#65776c}${css}</style><div class="simulation">离线模拟 · ${width}px · ${scenario} · 使用实际 WXML/WXSS；不代表微信实测或实时库存</div><div class="native-nav">果小哨 · ${names[pageName]}</div>${rendered}${tabbar}<script>window.previewAudit=()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>document.documentElement.clientWidth+1&&getComputedStyle(e.parentElement).overflowX!=='auto'}).map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right,text:e.textContent.slice(0,60)}))});</script></html>`;
      fs.writeFileSync(path.join(out, filename), body, 'utf8');
      const expectedText = alternativesPreview ? [p.title,
        '换个颜色或门店，继续找货', '同机型、同容量', '同城门店', '勾选不扣次',
        ...{
          'alternatives-default': ['先选可接受的颜色', '本次查询门店'],
          'alternatives-selection': ['查看近期有货记录', '会员不扣次', '查询'],
          'alternatives-premium': ['4 / 4', '4 家门店', '会员不扣次', '查询'],
          'alternatives-free': ['消耗 1 次', '查询'],
          'alternatives-match': ['观测可取货', '准备这个配置和门店', '15 秒前'],
          'alternatives-prepared': ['已准备所选配置和门店，尚未查询或扣次', '库存以官网下单页为准'],
          'alternatives-empty': ['暂无近期有货记录', '不代表无货', '会员不扣次', '查询'],
          'alternatives-error': ['已有观测暂未读取成功', '请检查网络后重试'],
          'alternatives-expired': ['近期记录已不可用', '会员不扣次', '查询'],
          'alternatives-cached': ['近期记录已不可用', '会员不扣次', '查询'],
        }[scenario],
      ] : notificationTestPreview ? ['先试收一条通知', '消耗 1 次签到／任务额度', '查看原测试结果', '微信受理不保证手机弹出横幅', ...{
        'notification-test-ready': ['授权并发送测试 · 1 次', '当前 2 次'],
        'notification-test-no-quota': ['当前 0 次', '去「我的」签到获取次数'],
        'notification-test-accepted': ['微信已受理', '受理不代表已送达', '我收到了', '暂时没收到'],
        'notification-test-uncertain': ['结果尚未确认', '本次暂不退次数，也不会重复发送', '我收到了', '暂时没收到'],
        'notification-test-failed': ['明确发送失败，次数已退回', '本次扣除 1 次 · 已退回 1 次'],
        'notification-test-received': ['已记录：你确认收到了测试消息', '正式到货监测仍需会员与有效授权'],
        'notification-test-not-received': ['已记录：暂未收到', '请检查微信服务通知、订阅消息设置及手机通知权限'],
      }[scenario]] : adminPreview ? { 'operator-ready': ['运行统计', '128'], 'operator-denied': ['当前账号没有管理权限', '重新检查'], 'operator-loading': ['校验权限'], 'operator-error': ['权限检查失败', '重新检查'], 'operator-longcontent': ['运行统计', '查询结果', '运营查询长文本换行验收'], 'operator-saving': ['已修改', '保存配置'] }[scenario] : historyTaskPreview ? pageName === 'history' ? ['最近浏览', '浏览不扣次数', p.title, ...{
        'history-member-reward': ['今日浏览任务完成，+1 次', '已计入次数明细'],
        'history-free-first': ['还没有浏览记录', '今日浏览任务完成，+1 次', '余 1 次'],
        'history-read-error': ['浏览记录加载或奖励确认未完成', '重新加载'],
        'history-balance-cap': ['余额已达 10 次上限', '使用次数后可返回领取'],
        'history-completed': ['今日浏览任务已完成', '奖励已计入次数明细'],
        'history-longcontent': ['各地门店已有记录', '3 家门店', '今日浏览任务完成，+1 次'],
        'history-loading': ['正在加载浏览记录'],
      }[scenario]] : ['每日体验任务', '次数明细', '浏览一次历史记录', ...(scenario === 'history-balance-cap' ? ['已浏览·待领取', '暂无记录'] : ['history-read-error', 'history-loading'].includes(scenario) ? ['去完成', '暂无记录'] : ['已完成', '体验任务', '+1'])]
          : monitoringPreview ? [...(follows.length ? [p.title, '调整', '详情与管理'] : []), ...(scenario.startsWith('monitor-dual-') ? ['到货', '断货'] : ['后台检测', '消息发送']), '微信提醒', ...{
        'monitor-template-missing': ['监测服务运行中', '模板尚未配置', '关注已开启', '查看原因'],
        'monitor-ready-authorized': ['监测服务运行中', '发送服务已就绪', '提醒次数只剩 1 次', '增加提醒次数', '关注已开启'],
        'monitor-needs-authorization': ['监测服务运行中', '发送服务已就绪', '还没有提醒次数', '增加提醒次数'],
        'monitor-stale': ['后台状态已过期', '发送服务未就绪', '关注已开启'],
        'monitor-disabled': ['后台检测尚未开放', '发送服务未就绪', '关注已开启'],
        'monitor-expired-paused': ['会员已到期', '会员到期，已暂停', '到货提醒为会员专属', '了解会员'],
        'monitor-no-follows': ['先给心仪配置留个哨', '添加关注'],
        'monitor-all-paused': ['你的关注全部已暂停', '暂停仍占一个配置名额', '恢复'],
        'monitor-user-disabled': ['你的消息提醒已关闭', '前往提醒设置'],
        'monitor-dnd': ['当前处于免打扰时段', '查看免打扰设置'],
        'monitor-free-account': ['关注与到货提醒为会员专属', '了解会员', '免费用户'],
        'monitor-alert': ['到货提醒', '确认补货', '2 分钟前', '可取货', '复制型号和门店', '增加提醒次数', '买到了吗？'],
        'monitor-dual-ready': ['提醒条件已就绪', '到货 8 次', '断货 5 次', '增加提醒次数', '每次允许'],
        'monitor-dual-soldout-empty': ['断货提醒为可选项', '到货提醒还可发送 8 次', '增加提醒次数'],
        'monitor-dual-restock-empty': ['到货提醒暂无次数', '断货提醒还可发送 5 次', '增加提醒次数'],
        'monitor-dual-soldout-low': ['断货提醒只剩 1 次', '增加提醒次数'],
        'monitor-dual-pending': ['待同步', '增加提醒次数', '到货 8 次', '断货 5 次'],
        'monitor-dual-native': ['待同步', '到货 8 次', '断货 5 次'],
        'monitor-dual-sync-error': ['待同步', '重试同步', '增加提醒次数'],
        'monitor-dual-storage-error': ['授权暂存在本次运行', '重试同步'],
      }[scenario]] : paymentPreview ? ['兑换码开通', ...(!page.data.membership.active || page.data.membershipUpgradeOpen || page.data.paymentPendingId ? ['周卡', '月卡', '年卡', '¥7.00', '¥19.90', '¥200.00'] : ['升级长期套餐', '续费会员']), ...{
        'payment-ready': ['立即开通', '选择会员时长', '付款确认后生效'], 'payment-renew': ['续费会员', '确认续费', '在原到期时间后增加 7 天', '剩余有效期继续保留'],
        'payment-blocked': ['付费购买暂未开放'], 'payment-old-ios': ['iOS 15'],
        'payment-pending': ['支付正在确认中', '查询支付结果'], 'payment-cancelled': ['已取消本次支付', '请查询订单状态', '查询支付结果'],
        'payment-error': ['支付结果暂未确认', '查询支付结果'], 'payment-fulfilled': ['支付已确认，会员已开通', '已开通'],
        'payment-partial-refund': ['订单已部分退款', '部分退款', '已退款 ¥3.50'],
        'payment-monthly': ['立即开通 · ¥19.90', '30 天'],
        'payment-annual': ['立即开通 · ¥200.00', '365 天'],
        'payment-pending-monthly': ['30 天会员 · ¥19.90', 'offline-original-monthly-order', '支付正在确认中', '查询支付结果'],
        'payment-member': ['18', '天剩余', '到期 2026-10-03', '升级长期套餐', '续费会员'],
        'payment-upgrade-monthly': ['续费可选', '确认升级 · ¥19.90', '在原到期时间后增加 30 天', '预计到期 2026-11-02', '按全价购买', '不抵扣差价'],
        'payment-upgrade-annual': ['续费可选', '确认升级 · ¥200.00', '在原到期时间后增加 365 天', '预计到期 2027-10-03', '按所选套餐全价购买', '不抵扣差价'],
        'payment-member-pending-monthly': ['30 天会员 · ¥19.90', 'offline-original-monthly-order', '套餐已按原订单锁定', '查询支付结果'],
        'payment-rules': ['一次性虚拟服务', '一经售出不予退款', '一次购买 7 天', '权益与购买须知'],
      }[scenario]] : redemptionPreview ? ['兑换会员', '付费购买暂未开放', { 'redemption-input': '确认兑换', 'redemption-loading': '兑换中，请稍候', 'redemption-error': '兑换码无效', 'redemption-success': '兑换成功', 'redemption-used': '此账号已兑换过', 'redemption-limited': '15 分钟后再试', 'redemption-empty': '确认兑换' }[scenario]] : stockPreview ? [p.title, '收起详情', '删除关注', ...{
        'stock-fresh': ['暂无供应', '本次状态刚记录', '观测 2026-09-15 15:00:00'],
        'stock-old': ['待更新', '观测已过期', '上次有效结果：暂无供应（仅供参考）', '上次检查 2026-09-15 14:57:00'],
        'stock-unknown': ['状态待确认', '最近一次检查未取得有效库存', '上次有效结果：暂无供应（仅供参考）'],
        'stock-missing': ['等待首次观测', '尚无观测', '还没有有效观测'],
        'stock-restricted': ['会员权益受限', '未展示实时库存', '当前账号暂不能查看该新品的实时库存'],
      }[scenario]] : scenario === 'loading' ? [{ query: '正在加载商品目录', follow: '正在读取你的关注', history: '正在加载商品目录', mine: '正在读取账户信息' }[pageName]]
        : scenario === 'error' ? [pageName === 'admin' ? '模拟错误：网络连接中断' : '模拟错误：云环境连接超时', '暂时没有连上', '重试']
        : pageName === 'mine' ? [member ? '果小哨会员' : expired ? '会员已到期' : '让小哨持续帮你留意', ...(page.data.membership.active ? ['升级长期套餐', '续费会员'] : ['¥7.00', '付费购买暂未开放', '不自动续费']), '提醒记录', ...(reminderPreview && reminderRecords.length ? ['删除记录', scenario === 'reminder-clearing' ? '清空中' : '清空'] : [])]
        : pageName === 'follow' && follows.length ? [p.title, stores[0].name, ...(sheetPreview ? ['调整关注', '产品配置', '选择门店', '已选门店', p.title + ' · 2 家门店', scenario === 'sheet-saving' ? '正在保存' : '保存关注'] : [])]
        : pageName === 'follow' ? ['给心仪的配置留个小哨']
        : pageName === 'admin' ? ['运行统计', '128'] : [p.title, ...(sheetPreview ? ['产品配置', '选择门店', '已选门店'] : [])];
      if (adminPreview && ['operator-ready', 'operator-longcontent'].includes(scenario)) expectedText.push('成功查询 56', '查看提醒详情 12', '测试通知：28 条／20 人', '各行为分别计数', ...(scenario === 'operator-longcontent' ? ['以上不是完整统计'] : []));
      if (nudgePreview) expectedText.push('补充提醒次数', '稍后再说', '24 小时内不再主动提示');
      if (releaseNotesPreview) expectedText.push('更新公告', '当前版本', ...(page.data.visibleReleaseNotes || page.data.releaseNotes).map(entry => `v${entry.version}`),
        ...(page.data.olderReleaseNotesCount ? [scenario === 'longcontent' ? '收起更早版本' : '展开更早版本'] : []));
      if (orderRecordsPreview) expectedText.push('会员记录', ...{
        'orders-single': ['订单号：grant_', '删除记录', '清空当前显示的记录'],
        'orders-deleting': ['删除中…', '支付状态待确认，暂不可清理'],
        'orders-clearing': ['清空中…', '支付状态待确认，暂不可清理'],
        'orders-error': ['清理结果暂未确认', '重试操作'],
        'orders-pending': ['请先处理上方待确认订单', '支付状态待确认，暂不可清理', '查询支付结果'],
        'orders-empty': ['暂无会员记录', '已清理 2 条记录'],
        'orders-legacy': ['记录清理需新版服务支持', '部分记录需要新版服务支持清理'],
      }[scenario]);
      if (onboardingPreview) expectedText.push(...{
        'onboarding-first': ['签到领取查询次数'],
        'onboarding-signing': ['签到中'],
        'onboarding-error': ['签到暂未确认', '同一天不会重复领取'],
        'onboarding-signed': ['查看任务 / 查询次数'],
        'onboarding-shared': ['已载入朋友分享的配置与门店'],
        'onboarding-share-pending': ['朋友分享的配置已保留', '载入分享配置', '忽略这次分享'],
        'onboarding-share-catalog': ['分享的配置暂未在商品目录中确认', '刷新目录并重试'],
        'onboarding-share-error': ['商品目录刷新失败', '当前选择已保留', '刷新目录并重试'],
      }[scenario]);
      const expectedAlternativeCounts = alternativesPreview ? { colors: page.data.alternativeColorChoices.length, stores: page.data.alternativeStoreChoices.length, queries: page.data.alternativeSelectedColors.length } : undefined;
      manifest.push({ page: pageName, scenario, width, file: filename, expectedText, expectedAlternativeCounts });
    }
  }
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: mini, renderer: 'offline WXML/WXSS approximation', buttonConstraintProfile, rpxRoundingProfile, remoteImages: allowRemoteImages, expressionErrors: evaluationErrors.length, snapshots: manifest }, null, 2));
fs.writeFileSync(path.join(out, 'evaluation-errors.json'), JSON.stringify(evaluationErrors, null, 2));
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>果小哨 · 离线排版检查</title><style>body{font:15px/1.7 sans-serif;background:#eef5f0;color:#263d30;margin:20px}select,button{font:inherit;padding:6px;margin:4px}iframe{display:block;border:1px solid #bacabd;background:white;height:900px}p{max-width:900px}</style><h1>果小哨 · 离线排版检查</h1><p>使用当前源代码中的 WXML、WXSS 和页面格式化逻辑，模拟会员、免费、到期、空内容、错误及长文本。此工具不会调用云函数、付款或发送消息；浏览器排版不是微信渲染，最终以微信开发者工具及真机验证为准。</p><select id="page">${Object.entries(names).map(([key,value])=>`<option value="${key}">${value}</option>`).join('')}</select><select id="scenario">${scenarios.map(s=>`<option>${s}</option>`).join('')}</select><select id="width">${widths.map(w=>`<option>${w}</option>`).join('')}</select><iframe id="frame"></iframe><script>const controls=[document.querySelector('#page'),document.querySelector('#scenario'),document.querySelector('#width')];function update(){const [p,s,w]=controls.map(x=>x.value);frame.style.width=w+'px';frame.src=p+'-'+s+'-'+w+'.html';}controls.forEach(x=>x.onchange=update);update();</script></html>`);
console.log(JSON.stringify({ output: out, snapshots: manifest.length, pages: Object.keys(names), scenarios, widths, remoteImages: allowRemoteImages, expressionErrors: evaluationErrors.length }, null, 2));
if (evaluationErrors.length) { console.error(JSON.stringify(evaluationErrors.slice(0, 12), null, 2)); process.exitCode = 1; }
