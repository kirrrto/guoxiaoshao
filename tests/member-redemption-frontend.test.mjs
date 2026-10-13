import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');
const clone = value => JSON.parse(JSON.stringify(value));
const inactive = { active: false, expiresAt: null, remainingMs: 0 };
const active = { active: true, expiresAt: '2027-10-20T12:00:00.000Z', remainingMs: 30 * 86400000 };
const expired = { active: false, expiresAt: '2026-01-01T12:00:00.000Z', remainingMs: 0 };
const boot = (membership = inactive) => ({ identity: { userKey: 'real:user', openidMasked: 'real…user', isAdmin: false }, membership: clone(membership),
  quota: { balance: 1, tasksDoneToday: [] }, tasks: [], collector: { state: 'not_deployed' }, memberProduct: { priceFen: 900, paymentReason: 'payment_not_enabled' },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 }, followCount: 0 });
const redeemedOrder = { orderId: 'redemption-record-001', type: 'membership_redemption', source: 'redemption_code', days: 30, amountFen: 0, status: 'fulfilled', fulfilledAt: '2026-09-15T00:00:00Z' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function runtime({ handler = async action => action === 'member.status' ? { orders: [redeemedOrder] } : { notifications: [] }, getBoot = async () => boot(active), app, wxExtra = {} } = {}) {
  let definition;
  const calls = [], invalidated = [], bootstrapCalls = [], toasts = [], errors = [];
  const api = { call: async (action, payload = {}) => { calls.push({ action, payload: clone(payload) }); return handler(action, payload); }, showError: value => errors.push(value), toast: value => toasts.push(value) };
  const store = { getBootstrap: async options => { bootstrapCalls.push(options); return getBoot(options); },
    invalidateBootstrap: () => invalidated.push('bootstrap'), invalidateFollows: () => invalidated.push('follows'), publishQuota() {}, subscribeQuota: () => () => {} };
  const wx = { stopPullDownRefresh() {}, ...wxExtra };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/mine/index.js'), 'utf8'), { console, Date, Promise, Map, Set, wx, getApp: app ? () => app : undefined, Page: value => { definition = value; },
    require: name => name.endsWith('/api') ? api : name.endsWith('/store') ? store : name.endsWith('/reminder-credits') ? { topUpReminderCredit: () => false } : require(path.resolve(root, 'pages/mine', name)) });
  const page = { ...definition, data: clone(definition.data) };
  page.setData = patch => { for (const [key, value] of Object.entries(clone(patch))) { const parts = key.split('.'); let target = page.data; for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {}); target[parts.at(-1)] = value; } };
  page.applyBoot(boot()); page.data.ready = true;
  return { page, calls, invalidated, bootstrapCalls, toasts, errors };
}
const enter = (page, code = 'EXAMPLE-UNLISTED') => page.onRedemptionInput({ detail: { value: code } });

test('real account redemption entry trims input only at the server request', async () => {
  const rt = runtime({ handler: async action => action === 'member.redeemCode' ? { redeemed: true, alreadyRedeemed: false, membership: active } : action === 'member.status' ? { orders: [redeemedOrder] } : { notifications: [] } });
  rt.page.onOpenRedemption();
  assert.equal(rt.page.data.boot.identity.userKey, 'real:user');
  assert.equal(rt.page.data.redemptionOpen, true);
  enter(rt.page, '  EXAMPLE-UNLISTED  '); await rt.page.onRedeemCode();
  assert.deepEqual(rt.calls.find(c => c.action === 'member.redeemCode').payload, { code: 'EXAMPLE-UNLISTED' });
  assert.equal(rt.page.data.membership.expiresAt, active.expiresAt);
  assert.equal(rt.page.data.redemptionCode, '');
  assert.equal(rt.page.data.redemptionResult.title, '兑换成功');
  assert.deepEqual(rt.invalidated, ['bootstrap', 'follows']);
  assert.equal(rt.page.data.orders[0].sourceLabel, '兑换码开通');
  assert.equal(rt.page.data.orders[0].amountText, '');
});

test('redemption stays pending until the server confirms and double submissions make one request', async () => {
  const pending = deferred();
  const rt = runtime({ handler: action => action === 'member.redeemCode' ? pending.promise : action === 'member.status' ? { orders: [] } : { notifications: [] } });
  enter(rt.page); const redeeming = rt.page.onRedeemCode(); await rt.page.onRedeemCode();
  assert.equal(rt.calls.filter(c => c.action === 'member.redeemCode').length, 1);
  assert.equal(rt.page.data.redeeming, true);
  assert.equal(rt.page.data.membership.active, false);
  pending.resolve({ redeemed: true, alreadyRedeemed: false, membership: active }); await redeeming;
  assert.equal(rt.page.data.redeeming, false);
  assert.equal(rt.page.data.membership.active, true);
});

test('confirmed membership survives failed account and order refreshes', async () => {
  const rt = runtime({ handler: async action => { if (action === 'member.redeemCode') return { redeemed: true, alreadyRedeemed: false, membership: active }; throw Error('offline'); },
    getBoot: async () => { throw Error('offline'); } });
  enter(rt.page); await rt.page.onRedeemCode();
  assert.equal(rt.page.data.membership.active, true);
  assert.equal(rt.page.data.membership.expiresAt, active.expiresAt);
  assert.equal(rt.page.data.redemptionResult.title, '兑换成功');
  assert.match(rt.page.data.refreshError, /刷新失败/);
  assert.match(rt.page.data.ordersError, /加载失败/);
  assert.equal(rt.calls.some(c => c.action === 'member.status'), true);
});

test('already-used code with expired membership never claims a new activation', async () => {
  const rt = runtime({ handler: async action => action === 'member.redeemCode' ? { redeemed: true, alreadyRedeemed: true, membership: expired } : action === 'member.status' ? { orders: [redeemedOrder] } : { notifications: [] }, getBoot: async () => boot(expired) });
  enter(rt.page); await rt.page.onRedeemCode();
  assert.equal(rt.page.data.redemptionResult.title, '此账号已兑换过');
  assert.match(rt.page.data.redemptionResult.detail, /未重新开通.*已到期/);
  assert.equal(rt.page.data.membership.active, false);
  assert.equal(rt.page.data.membership.expiresAt, expired.expiresAt);
});

test('invalid, disabled, throttled and unknown errors stay readable and never echo the code or internal error', async () => {
  const errors = [
    { code: 'invalid_redemption_code', details: { remainingAttempts: 3 } },
    { code: 'redemption_rate_limited', details: { retryAfterSeconds: 65 } },
    { code: 'redemption_disabled' }, { code: 'redemption_conflict' }, { code: 'call_failed' },
  ];
  for (const error of errors) {
    const rt = runtime({ handler: async () => { throw Object.assign(new Error('SECRET INPUT internal_details'), error); } });
    enter(rt.page); await rt.page.onRedeemCode();
    assert.equal(rt.page.data.membership.active, false);
    assert.equal(rt.page.data.redeeming, false);
    assert.equal(rt.page.data.redemptionCode, 'EXAMPLE-UNLISTED');
    assert.match(rt.page.data.redemptionError, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(rt.page.data.redemptionError, /SECRET|internal|EXAMPLE|redemption_/);
  }
});

test('empty input makes no request and uncertain redemption can retry without local extension', async () => {
  let attempts = 0;
  const rt = runtime({ handler: async action => {
    if (action === 'member.redeemCode') { if (++attempts === 1) throw Object.assign(Error('timeout'), { code: 'call_failed' }); return { redeemed: true, alreadyRedeemed: true, membership: active }; }
    return action === 'member.status' ? { orders: [redeemedOrder] } : { notifications: [] };
  } });
  enter(rt.page, '   '); await rt.page.onRedeemCode(); assert.equal(rt.calls.length, 0);
  enter(rt.page); await rt.page.onRedeemCode(); await rt.page.onRedeemCode();
  assert.equal(attempts, 2);
  assert.equal(rt.page.data.membership.expiresAt, active.expiresAt);
  assert.equal(rt.page.data.redemptionResult.title, '此账号已兑换过');
});

test('late pre-redemption account and membership-record reads cannot undo confirmed membership or its record', async () => {
  const oldBoot = deferred(), oldOrders = deferred(); let boots = 0, orders = 0;
  const rt = runtime({ getBoot: () => ++boots === 1 ? oldBoot.promise : boot(active), handler: action => {
    if (action === 'member.redeemCode') return { redeemed: true, alreadyRedeemed: false, membership: active };
    if (action === 'member.status') return ++orders === 1 ? oldOrders.promise : { orders: [redeemedOrder] };
    return { notifications: [] };
  } });
  const staleAccount = rt.page.refresh({ force: true }), staleOrders = rt.page.loadOrders({ force: true });
  enter(rt.page); await rt.page.onRedeemCode();
  oldBoot.resolve(boot()); oldOrders.resolve({ orders: [] }); await Promise.all([staleAccount, staleOrders]);
  assert.equal(rt.page.data.membership.active, true);
  assert.equal(rt.page.data.membership.expiresAt, active.expiresAt);
  assert.equal(rt.page.data.orders[0].sourceLabel, '兑换码开通');
});

test('unloaded account page ignores late account, membership-record and reminder reads', async () => {
  const oldBoot = deferred(), oldNotices = deferred(), oldOrders = deferred();
  const rt = runtime({ getBoot: () => oldBoot.promise, handler: action => action === 'member.status' ? oldOrders.promise : oldNotices.promise });
  const oldAccount = rt.page.refresh({ force: true }), oldNotifications = rt.page.loadNotifications({ force: true }), oldRecords = rt.page.loadOrders({ force: true });
  rt.page.onUnload();
  const snapshot = clone(rt.page.data);
  oldBoot.resolve(boot(active));
  oldOrders.resolve({ orders: [redeemedOrder] });
  oldNotices.resolve({ notifications: [{ id: 'late-notice' }] });
  await Promise.all([oldAccount, oldNotifications, oldRecords]);
  assert.deepEqual(rt.page.data, snapshot);
  const reads = rt.calls.length;
  await rt.page.onShow(); await rt.page.refresh(); await rt.page.loadOrders(); await rt.page.loadNotifications();
  assert.equal(rt.calls.length, reads);
});

test('redemption deep link opens for a real account and ignores request data in the URL', async () => {
  const real = runtime(); await real.page.onLoad({ openRedemption: '1' });
  assert.equal(real.page.data.redemptionOpen, true);
  assert.equal(real.page.data.boot.identity.userKey, 'real:user');
  const ordinary = runtime({ getBoot: async () => boot() });
  await ordinary.page.onLoad({ code: 'URL-INPUT', membership: active, openRedemption: 'true' });
  assert.equal(ordinary.page.data.redemptionOpen, false);
  assert.equal(ordinary.page.data.redemptionCode, '');
  assert.equal(ordinary.page.data.membership.active, false);
  assert.equal(ordinary.calls.some(c => c.action === 'member.redeemCode'), false);
});

test('unloaded page ignores late settings, quota, ledger and reminder mutations', async () => {
  const settings = deferred(), signin = deferred(), ledger = deferred(), deleting = deferred();
  const rt = runtime({ getBoot: async () => boot(), handler: action => {
    if (action === 'user.updateSettings') return settings.promise;
    if (action === 'quota.signin') return signin.promise;
    if (action === 'quota.ledger') return ledger.promise;
    if (action === 'notify.delete') return deleting.promise;
    return { notifications: [{ id: 'real-notice' }] };
  } });
  rt.page.data.notifications = [{ id: 'real-notice' }];
  const oldSettings = rt.page.saveSettings({ notifyEnabled: false }), oldSignin = rt.page.onSignin(), oldLedger = rt.page.onToggleLedger();
  const oldDelete = rt.page.applyNotificationAction({ type: 'delete', id: 'real-notice' });
  rt.page.onUnload();
  const snapshot = clone(rt.page.data);
  settings.resolve({ settings: { notifyEnabled: false, dnd: { enabled: true, startMinute: 0, endMinute: 0 } } });
  signin.resolve({ granted: 1, quota: { balance: 99 } });
  ledger.resolve({ entries: [{ id: 'late-ledger', type: 'signin_reward', delta: 1 }] });
  deleting.resolve({ deleted: true });
  await Promise.all([oldSettings, oldSignin, oldLedger, oldDelete]);
  assert.deepEqual(rt.page.data, snapshot);
  assert.deepEqual(rt.invalidated, []);
  assert.deepEqual(rt.toasts, []);
  assert.deepEqual(rt.errors, []);
});

test('redemption completion after unload cannot update a retired page or launch follow-up reads', async () => {
  for (const succeeds of [true, false]) {
    const pending = deferred();
    const rt = runtime({ handler: () => pending.promise });
    enter(rt.page); const redeeming = rt.page.onRedeemCode();
    rt.page.onUnload();
    const snapshot = clone(rt.page.data);
    if (succeeds) pending.resolve({ redeemed: true, alreadyRedeemed: false, membership: active });
    else pending.reject(Object.assign(Error('timeout'), { code: 'call_failed' }));
    await redeeming;
    assert.deepEqual(rt.page.data, snapshot);
    assert.deepEqual(rt.invalidated, []);
    assert.equal(rt.bootstrapCalls.length, 0);
    enter(rt.page, 'LATE-INPUT'); rt.page.onOpenRedemption(); await rt.page.onRedeemCode();
    assert.deepEqual(rt.page.data, snapshot);
    assert.equal(rt.calls.length, 1);
  }
});

test('an already-used response with no current membership preserves the inactive server snapshot', async () => {
  const rt = runtime({ getBoot: async () => { throw Error('offline'); }, handler: async action => action === 'member.redeemCode'
    ? { redeemed: true, alreadyRedeemed: true, membership: inactive } : { orders: [redeemedOrder] } });
  enter(rt.page); await rt.page.onRedeemCode();
  assert.equal(rt.page.data.membership.active, false);
  assert.equal(rt.page.data.membership.expiresAt, null);
  assert.equal(rt.page.data.redemptionResult.title, '此账号已兑换过');
  assert.match(rt.page.data.redemptionResult.detail, /没有生效/);
});

test('a new membership offers to continue the configuration a free user tried to follow', async () => {
  const app = { globalData: { pendingMemberFollow: { partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], title: 'iPhone 18 Pro Max 1TB' } } };
  const modals = [], tabs = [];
  const rt = runtime({ app, wxExtra: { showModal: options => modals.push(options), switchTab: options => tabs.push(options.url) },
    handler: async action => action === 'member.redeemCode' ? { redeemed: true, alreadyRedeemed: false, membership: active } : action === 'member.status' ? { orders: [redeemedOrder] } : { notifications: [] } });
  enter(rt.page); await rt.page.onRedeemCode();
  assert.equal(modals.at(-1).title, '会员已开通');
  assert.match(modals.at(-1).content, /iPhone 18 Pro Max 1TB/);
  assert.equal(app.globalData.pendingMemberFollow, null, 'offered once');
  modals.at(-1).success({ confirm: true });
  assert.deepEqual(clone(app.globalData.pendingFollow), { partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] });
  assert.deepEqual(tabs, ['/pages/follow/index']);
  // An already-used code activates nothing, so the kept target stays for a later purchase.
  const kept = { globalData: { pendingMemberFollow: { partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], title: 'x' } } };
  const again = runtime({ app: kept, wxExtra: { showModal: options => modals.push(options) },
    handler: async action => action === 'member.redeemCode' ? { redeemed: true, alreadyRedeemed: true, membership: active } : action === 'member.status' ? { orders: [] } : { notifications: [] } });
  const before = modals.length;
  enter(again.page); await again.page.onRedeemCode();
  assert.equal(modals.length, before);
  assert.equal(kept.globalData.pendingMemberFollow.partNumber, 'MJYH4CH/A');
});
