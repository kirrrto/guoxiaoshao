import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const balances = (restock = 5, soldout = 3) => ({ RESTOCK: { credits: restock }, SOLDOUT: { credits: soldout } });
const boot = (userKey = 'consumer:alice', member = true, subscriptions = balances()) => ({
  identity: { userKey, openidMasked: 'test…account' }, membership: { active: member, expiresAt: member ? '2027-01-01T00:00:00Z' : null, remainingMs: member ? 30 * 86400000 : 0 },
  subscriptions, notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'RESTOCK', soldout: 'SOLDOUT' } },
  collector: { state: 'running' }, settings: { notifyEnabled: true, dnd: { enabled: false, startMinute: 1380, endMinute: 480 } },
  quota: { balance: 3, tasksDoneToday: [], tasksViewedToday: [] }, tasks: [], followCount: 0,
  memberProduct: { planId: 'member_7d', days: 7, priceFen: 700, enabled: false, paymentReady: false, paymentReason: 'payment_not_enabled' },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 },
});
function setup({ snapshot = boot(), record = async () => ({ subscriptions: balances(6, 4) }), native, save, read } = {}) {
  let current = copy(snapshot), prompts = 0;
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.recordSubscription') return record(payload);
    if (action === 'user.bootstrap') return read ? read(copy(current)) : copy(current);
    if (action === 'user.updateSettings') {
      const owner = current.identity.userKey;
      const response = save ? await save(payload) : { settings: { ...current.settings, ...copy(payload) } };
      if (current.identity.userKey === owner) current = { ...current, settings: copy(response.settings) };
      return response;
    }
    if (action === 'follow.list') return { follows: [], limits: current.limits };
    if (action === 'notify.list') return { notifications: [] };
    if (action === 'member.status') return { orders: [] };
    if (action === 'catalog.get') return { products: [], stores: [], families: [], version: 'test' };
    throw new Error(`Unexpected call: ${action}`);
  });
  rt.app.globalData.bootstrap = copy(current);
  rt.wx.pageScrollTo = () => {};
  rt.wx.requestSubscribeMessage = options => { prompts++; return native ? native(options) : Promise.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); };
  const mine = rt.instance('pages/mine/index.js'), follow = rt.instance('pages/follow/index.js');
  const pages = [mine, follow];
  for (const page of pages) {
    const bar = { data: { sheetHidden: false }, setData(patch) { Object.assign(this.data, patch); } };
    page.getTabBar = () => bar;
    page.pageVisible = true; page.visible = true;
    page.applyBoot(copy(current)); page.setData({ ready: true, followsLoaded: true });
  }
  return { rt, mine, follow, pages, prompts: () => prompts, credits: rt.load('utils/reminder-credits.js'),
    records: () => rt.calls.filter(call => call.action === 'notify.recordSubscription'),
    changeAccount: (snapshot, update = pages) => { current = copy(snapshot); rt.app.globalData.bootstrap = copy(current); for (const page of update) page.applyBoot(copy(current)); } };
}

test('both page templates bind the visible top-up button directly and expose synchronization retry beside it', () => {
  for (const target of ['mine', 'follow']) {
    const source = fs.readFileSync(new URL(`../miniprogram/pages/${target}/index.wxml`, import.meta.url), 'utf8');
    const body = source.split('<config-sheet wx:if="{{authorizationOpen}}"')[0];
    const buttons = [...body.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
    const topUps = buttons.filter(button => button.includes('补充提醒次数'));
    assert.equal(topUps.length, 1, target);
    assert.match(topUps[0], /bindtap="onSubscribe"/);
    assert.doesNotMatch(topUps[0], /onOpenAuthorizationPanel/);
    const retries = buttons.filter(button => button.includes('重试同步'));
    assert.equal(retries.length, 1, target);
    assert.match(retries[0], /bindtap="onRetryAuthorizationSync"/);
    assert.match(body, /\{\{authorizationFeedback\}\}/);
    assert.match(body, /authorization\.errorMessage/);
  }
});

test('both reminder centers open without native authorization and only the explicit authorize action prompts', async () => {
  const s = setup();
  for (const page of s.pages) {
    page.onOpenAuthorizationPanel();
    assert.equal(page.data.authorizationOpen, true);
    assert.equal(page.getTabBar().data.sheetHidden, true);
  }
  assert.equal(s.prompts(), 0); assert.equal(s.records().length, 0);
  await s.mine.onSubscribe(); await settle();
  assert.equal(s.prompts(), 1); assert.equal(s.records().length, 1);
  assert.deepEqual(s.records()[0].payload.results, { RESTOCK: 'accept', SOLDOUT: 'accept' });
  for (const page of s.pages) { page.onCloseAuthorizationPanel(); assert.equal(page.getTabBar().data.sheetHidden, false); }
});

test('one direct tap on either page invokes native authorization synchronously without opening a second sheet', async () => {
  for (const target of ['mine', 'follow']) {
    const native = deferred(); let inTapStack = false;
    const s = setup({ native: () => { assert.equal(inTapStack, true); return native.promise; } });
    const page = s[target];
    inTapStack = true;
    const authorizing = page.onSubscribe();
    inTapStack = false;
    assert.equal(s.prompts(), 1, 'native must be invoked before the tap handler yields');
    assert.equal(s.rt.calls.length, 0, 'no account fetch or cloud write may precede native authorization');
    assert.equal(page.data.authorizationOpen, false);
    assert.equal(page.getTabBar().data.sheetHidden, false);
    native.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); await authorizing; await settle();
    assert.equal(page.data.subscription.credits, 6);
    assert.equal(page.data.authorizationOpen, false);
  }
});

test('direct repeated taps share the native lock across pages but do not wait for slow server reconciliation', async () => {
  const native = deferred(), syncing = deferred();
  const s = setup({ native: () => native.promise, record: () => syncing.promise });
  const first = s.mine.onSubscribe();
  await s.mine.onSubscribe(); await s.follow.onSubscribe();
  assert.equal(s.prompts(), 1);
  native.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); await first; await settle();
  assert.equal(s.mine.data.authorization.syncing, true);
  assert.equal(s.mine.data.subscribing, false);
  assert.equal(s.mine.data.subscription.credits, 5, 'pending grants are not confirmed credit');
  await s.follow.onSubscribe(); await settle();
  assert.equal(s.prompts(), 2, 'a later real tap may request another grant once the native sheet closes');
  assert.equal(s.mine.data.authorization.pendingRestock, 2);
  assert.equal(s.records().length, 1, 'the existing shared queue owns the single worker');
  syncing.resolve({ subscriptions: balances(7, 5) }); await settle();
  assert.equal(s.records().length, 2);
  assert.equal(s.mine.data.authorization.pendingCount, 0);
});

test('direct authorization cannot overlap editing, saving, redemption or payment actions', async () => {
  for (const target of ['mine', 'follow']) {
    const s = setup(), page = s[target];
    for (const field of ['editing', 'saving', 'redemptionOpen', 'redeeming', 'paymentBusy', 'paymentChecking', 'paymentConfirming', 'paymentPendingId']) {
      page.setData({ [field]: field === 'paymentPendingId' ? 'pending-order' : true });
      await page.onSubscribe();
      assert.equal(s.prompts(), 0, `${target}: ${field}`);
      assert.equal(s.records().length, 0, `${target}: ${field}`);
      page.setData({ [field]: field === 'paymentPendingId' ? '' : false });
    }
    await page.onSubscribe(); await settle();
    assert.equal(s.prompts(), 1, 'the explicit action works after the other interaction finishes');
  }
});

test('native authorization also blocks reverse payment, renewal and redemption entry while queued synchronization does not', async () => {
  const native = deferred(), syncing = deferred();
  const product = { planId: 'member_7d', days: 7, priceFen: 700, productId: 'vip666', enabled: true, paymentReady: true, iosEnabled: true };
  const snapshot = { ...boot(), memberProduct: product, memberProducts: [product, { ...product, planId: 'member_30d', days: 30, priceFen: 1499 }] };
  const s = setup({ snapshot, native: () => native.promise, record: () => syncing.promise });
  Object.assign(s.rt.wx, { getDeviceInfo: () => ({ platform: 'android' }), getAppBaseInfo: () => ({ version: '8.0.70', SDKVersion: '3.10.3' }), requestVirtualPayment() {}, canIUse: () => true });
  s.mine.applyBoot(copy(snapshot));
  const page = s.mine, authorizing = page.onSubscribe();
  assert.equal(s.credits.getAuthorizationState().nativeBusy, true);
  page.onOpenMembershipRenew(); page.onOpenMembershipUpgrade();
  assert.equal(page.data.membershipUpgradeOpen, false);
  const selected = page.data.selectedPlanId;
  page.onSelectMemberProduct({ currentTarget: { dataset: { planId: 'member_30d' } } });
  assert.equal(page.data.selectedPlanId, selected);
  await page.onBuyMembership(); await page.onCheckPayment();
  page.setData({ paymentPendingId: 'existing-order' });
  await page.onBuyMembership(); await page.onAbandonPayment();
  page.setData({ paymentPendingId: '', redemptionCode: 'TEST-CODE' });
  page.onOpenRedemption(); await page.onRedeemCode();
  assert.equal(page.data.redemptionOpen, false);
  assert.equal(page.data.paymentConfirming, false);
  assert.equal(s.rt.messages.length, 0, 'no second confirmation dialog opens behind native authorization');
  assert.equal(s.rt.calls.length, 0, 'no payment/order/redemption request starts');
  // The global native lock remains authoritative even if a rendered field lags.
  page.setData({ subscribing: false });
  await page.onBuyMembership(); page.onOpenRedemption();
  assert.equal(s.rt.messages.length, 0); assert.equal(page.data.redemptionOpen, false);
  native.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); await authorizing; await settle();
  assert.equal(page.data.authorization.syncing, true);
  assert.equal(page.isNativeAuthorizationBusy(), false);
  page.onOpenMembershipRenew();
  assert.equal(page.data.membershipUpgradeOpen, true);
  const dialogs = [];
  s.rt.wx.showModal = options => { dialogs.push(options); options.success({ confirm: false }); };
  await page.onBuyMembership();
  assert.equal(dialogs[0].title, '购买须知', 'background authorization sync does not block a new purchase confirmation');
  page.onOpenRedemption(); assert.equal(page.data.redemptionOpen, true);
  page.onOpenRedemption();
  syncing.resolve({ subscriptions: balances(6, 4) }); await settle();
});

test('mine payment and redemption buttons visibly disable during the native authorization request only', () => {
  const source = fs.readFileSync(new URL('../miniprogram/pages/mine/index.wxml', import.meta.url), 'utf8');
  const handlers = new Set(['onOpenMembershipRenew', 'onOpenMembershipUpgrade', 'onCloseMembershipUpgrade', 'onSelectMemberProduct', 'onBuyMembership', 'onCheckPayment', 'onAbandonPayment', 'onOpenRedemption', 'onRedeemCode']);
  const seen = new Set();
  for (const [tag] of source.matchAll(/<button\b[^>]*>/g)) {
    const handler = tag.match(/bindtap="([^"]+)"/);
    if (!handler || !handlers.has(handler[1])) continue;
    seen.add(handler[1]);
    const disabled = tag.match(/disabled="\{\{([^\n]*?)\}\}"/);
    assert.ok(disabled && disabled[1].includes('subscribing'), handler[1]);
    assert.doesNotMatch(disabled[1], /authorization\.syncing|subscriptionPending/);
  }
  assert.equal(seen.size, handlers.size);
});

test('direct rejection or native failure never increases reminder credits', async () => {
  for (const target of ['mine', 'follow']) {
    const declined = setup({ native: () => Promise.resolve({ RESTOCK: 'reject', SOLDOUT: 'ban' }), record: async () => ({ subscriptions: balances() }) });
    await declined[target].onSubscribe(); await settle();
    assert.equal(declined.prompts(), 1);
    assert.equal(declined[target].data.subscription.credits, 5);
    assert.equal(declined[target].data.subscription.soldoutCredits, 3);
    assert.equal(declined[target].data.authorization.pendingRestock, 0);
    assert.equal(declined[target].data.authorization.pendingSoldout, 0);
    assert.match(declined[target].data.authorizationFeedback, /到货未授权.*断货授权已关闭/);
    assert.equal(declined[target].data.authorizationOpen, false);

    const failed = setup({ native: () => Promise.reject(new Error('requestSubscribeMessage:fail cancel')) });
    await failed[target].onSubscribe(); await settle();
    assert.equal(failed.records().length, 0);
    assert.equal(failed[target].data.subscription.credits, 5);
    assert.match(failed[target].data.authorizationFeedback, /授权未完成，已有次数保留/);
  }
});

test('direct authorization shows a retryable sync failure in place and retry reuses its request without native authorization', async () => {
  for (const target of ['mine', 'follow']) {
    let attempts = 0;
    const s = setup({ record: async () => {
      if (++attempts === 1) throw Object.assign(new Error('授权记录尚未同步，请重试'), { code: 'call_failed' });
      return { subscriptions: balances(6, 4) };
    } });
    const page = s[target];
    await page.onSubscribe(); await settle();
    assert.equal(page.data.authorizationOpen, false);
    assert.equal(page.data.authorization.pendingCount, 1);
    assert.match(page.data.authorization.errorMessage, /尚未同步/);
    assert.equal(page.data.subscription.credits, 5);
    const requestId = s.records()[0].payload.requestId;
    await page.onRetryAuthorizationSync(); await settle();
    assert.equal(s.prompts(), 1);
    assert.equal(s.records().length, 2);
    assert.equal(s.records()[1].payload.requestId, requestId);
    assert.equal(page.data.subscription.credits, 6);
    assert.equal(page.data.authorization.pendingCount, 0);
    assert.equal(page.data.authorization.errorMessage, '');
    assert.match(page.data.authorizationFeedback, /已有授权已同步/);
    assert.equal(page.data.authorizationOpen, false);
  }
});

test('a direct native result arriving before onShow remains visible after return and starts its feedback timeout then', async () => {
  for (const target of ['mine', 'follow']) {
    for (const accepted of [true, false]) {
      const native = deferred();
      const s = setup({ native: () => native.promise, record: async () => ({ subscriptions: accepted ? balances(6, 4) : balances() }) });
      const page = s[target], authorizing = page.onSubscribe();
      page.onHide();
      await page.onSubscribe(); assert.equal(s.prompts(), 1, 'a hidden page cannot start a native request');
      native.resolve({ RESTOCK: accepted ? 'accept' : 'reject', SOLDOUT: accepted ? 'accept' : 'reject' });
      await authorizing; await settle();
      assert.match(page.data.authorizationFeedback, accepted ? /微信已允许/ : /未授权/);
      assert.equal(page.authorizationFeedbackTimer, null, 'feedback must not expire before the page returns');
      await page.onShow();
      assert.equal(s.rt.calls.filter(call => call.action === 'user.bootstrap').length, 0);
      assert.match(page.data.authorizationFeedback, accepted ? /微信已允许/ : /未授权/);
      const timer = s.rt.timers.get(page.authorizationFeedbackTimer);
      assert.ok(timer);
      assert.equal(page.data.authorizationOpen, false);
      assert.equal(page.getTabBar().data.sheetHidden, false);
      assert.equal(page.data.subscription.credits, accepted ? 6 : 5);
      s.rt.timers.delete(page.authorizationFeedbackTimer); timer.fn();
      assert.equal(page.data.authorizationFeedback, '');
    }
  }
});

test('direct authorization keeps late native feedback out of a different account and a later visit of the original account', async () => {
  const native = deferred(); const s = setup({ native: () => native.promise });
  const authorizing = s.mine.onSubscribe();
  s.changeAccount(boot('consumer:bob', true, balances(20, 10)));
  s.changeAccount(boot());
  s.mine.setAuthorizationFeedback('当前访问反馈');
  native.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); await authorizing; await settle();
  assert.equal(s.mine.data.authorizationFeedback, '当前访问反馈', 'an older visit cannot replace current feedback');
  assert.equal(s.records().length, 1);
  assert.equal(s.records()[0].payload.expectedUserKey, 'consumer:alice');
  assert.equal(s.mine.data.authorizationOpen, false);
});

test('a native failure before return stays readable and a cancelled old feedback timer cannot retire a newer timer', async () => {
  const native = deferred(); const s = setup({ native: () => native.promise });
  const authorizing = s.mine.onSubscribe();
  s.mine.onHide();
  native.reject(new Error('requestSubscribeMessage:fail cancel')); await authorizing;
  assert.equal(s.mine.authorizationFeedbackTimer, null);
  assert.match(s.mine.data.authorizationFeedback, /授权未完成/);
  await s.mine.onShow();
  const oldTimer = s.rt.timers.get(s.mine.authorizationFeedbackTimer);
  s.mine.setAuthorizationFeedback('当前操作结果');
  const newTimer = s.mine.authorizationFeedbackTimer;
  oldTimer.fn();
  assert.equal(s.mine.authorizationFeedbackTimer, newTimer);
  assert.equal(s.mine.data.authorizationFeedback, '当前操作结果');
  assert.equal(s.records().length, 0);
  assert.equal(s.mine.data.subscription.credits, 5);
});

test('saving quiet periods preserves the verified account so explicit authorization works immediately', async () => {
  const s = setup();
  await s.mine.onAddDndPeriod();
  assert.equal(s.rt.app.globalData.bootstrap.identity.userKey, 'consumer:alice');
  assert.equal(s.rt.app.globalData.bootstrap.settings.dnd.periods.length, 2);
  assert.equal(s.rt.calls.filter(call => call.action === 'user.bootstrap').length, 0);
  s.mine.onOpenAuthorizationPanel();
  assert.equal(s.prompts(), 0);
  await s.mine.onSubscribe(); await settle();
  assert.equal(s.prompts(), 1);
  assert.equal(s.records().length, 1);
});

test('a bootstrap begun before settings were saved cannot restore the old settings', async () => {
  const stale = deferred(); let reads = 0;
  const original = boot();
  const s = setup({ read: current => ++reads === 1 ? stale.promise : current });
  const earlierRead = s.rt.load('utils/store.js').getBootstrap({ force: true });
  await s.mine.onAddDndPeriod();
  stale.resolve(original);
  const refreshed = await earlierRead;
  assert.equal(refreshed.settings.dnd.periods.length, 2);
  assert.equal(s.rt.app.globalData.bootstrap.settings.dnd.periods.length, 2);
  assert.equal(s.mine.isAuthorizationAccountCurrent(), true);
});

test('a save finishing while hidden preserves confirmed identity without opening a native sheet or overlay', async () => {
  const pending = deferred(); const s = setup({ save: () => pending.promise });
  const saving = s.mine.onAddDndPeriod();
  s.mine.onHide();
  pending.resolve({ settings: { notifyEnabled: true, dnd: { enabled: false, periods: [{ startMinute: 720, endMinute: 780 }] } } });
  await saving;
  assert.equal(s.rt.app.globalData.bootstrap.identity.userKey, 'consumer:alice');
  assert.equal(s.rt.app.globalData.bootstrap.settings.dnd.periods[0].startMinute, 720);
  assert.equal(s.mine.data.savingSettings, false);
  assert.equal(s.mine.getTabBar().data.sheetHidden, false);
  assert.equal(s.prompts(), 0);
});

test('a save from a hidden stale page cannot publish to an account changed on another page', async () => {
  const pending = deferred(); const s = setup({ save: () => pending.promise });
  const saving = s.mine.onAddDndPeriod();
  s.mine.onHide();
  s.changeAccount(boot('consumer:bob'), [s.follow]);
  const before = copy(s.mine.data.settings), globalBefore = copy(s.rt.app.globalData.bootstrap);
  pending.resolve({ settings: { notifyEnabled: false, dnd: { enabled: true, periods: [{ startMinute: 720, endMinute: 780 }] } } });
  await saving;
  assert.deepEqual(copy(s.rt.app.globalData.bootstrap), globalBefore);
  assert.deepEqual(copy(s.mine.data.settings), before);
  assert.equal(s.mine.data.savingSettings, false);
  assert.equal(s.rt.calls.filter(call => call.action === 'user.bootstrap').length, 0);
  assert.equal(s.rt.messages.length, 0);
});

test('a failed identity refresh after a successful save keeps saved settings and reports a refresh failure', async () => {
  const pending = deferred();
  const s = setup({ save: () => pending.promise, read: () => { throw new Error('account unavailable'); } });
  const saving = s.mine.onAddDndPeriod();
  s.rt.load('utils/store.js').invalidateBootstrap();
  pending.resolve({ settings: { notifyEnabled: true, dnd: { enabled: true, periods: [{ startMinute: 720, endMinute: 780 }] } } });
  await saving;
  assert.equal(s.mine.data.settings.dnd.periods[0].startMinute, 720);
  assert.match(s.mine.data.refreshError, /设置已保存，账户信息刷新失败/);
  assert.equal(s.mine.data.savingSettings, false);
  assert.equal(s.rt.messages.length, 0, 'a confirmed save must not be reported as a failed write');
  await s.mine.onSubscribe();
  assert.equal(s.prompts(), 0, 'missing verified identity still blocks native authorization');
});

test('a recovery read after saving does not repaint a hidden page or replace another account', async () => {
  for (const changeAccount of [false, true]) {
    const pending = deferred(), reading = deferred(); let reads = 0;
    const s = setup({ save: () => pending.promise, read: current => ++reads === 1 ? reading.promise : current });
    const store = s.rt.load('utils/store.js');
    const saving = s.mine.onAddDndPeriod(); store.invalidateBootstrap();
    const saved = { notifyEnabled: true, dnd: { enabled: true, periods: [{ startMinute: 720, endMinute: 780 }] } };
    pending.resolve({ settings: saved }); await settle();
    s.mine.onHide();
    if (changeAccount) {
      store.invalidateBootstrap();
      s.changeAccount(boot('consumer:bob'));
    }
    const before = copy(s.mine.data);
    reading.resolve({ ...boot(), settings: saved }); await saving;
    assert.deepEqual(copy(s.mine.data.settings), before.settings);
    assert.equal(s.mine.data.boot.identity.userKey, changeAccount ? 'consumer:bob' : 'consumer:alice');
    assert.equal(s.rt.app.globalData.bootstrap.identity.userKey, changeAccount ? 'consumer:bob' : 'consumer:alice');
    assert.equal(s.mine.getTabBar().data.sheetHidden, false);
    assert.equal(s.prompts(), 0);
  }
});

test('native permission is shared across pages and pending grants remain separate from confirmed balances', async () => {
  const native = deferred(), sync = deferred();
  const s = setup({ native: () => native.promise, record: () => sync.promise });
  s.mine.onOpenAuthorizationPanel(); s.follow.onOpenAuthorizationPanel();
  const authorizing = s.mine.onSubscribe();
  await s.follow.onSubscribe();
  assert.equal(s.prompts(), 1);
  assert.equal(s.mine.data.subscribing, true); assert.equal(s.follow.data.subscribing, true);
  s.mine.onCloseAuthorizationPanel(); assert.equal(s.mine.data.authorizationOpen, true);
  native.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); await authorizing; await settle();
  assert.equal(s.records().length, 1);
  for (const page of s.pages) {
    assert.equal(page.data.subscribing, false);
    assert.equal(page.data.subscription.credits, 5); assert.equal(page.data.subscription.soldoutCredits, 3);
    assert.equal(page.data.authorization.pendingRestock, 1); assert.equal(page.data.authorization.pendingSoldout, 1);
  }
  sync.resolve({ subscriptions: balances(6, 4) }); await settle();
  for (const page of s.pages) {
    assert.equal(page.data.subscription.credits, 6); assert.equal(page.data.subscription.soldoutCredits, 4);
    assert.equal(page.data.authorization.pendingCount, 0);
  }
});

test('cross-page retry drains the same durable request once without another native prompt', async () => {
  const retry = deferred(); let records = 0;
  const s = setup({ record: () => { if (++records === 1) throw Object.assign(new Error('网络中断'), { code: 'call_failed' }); return retry.promise; } });
  await s.mine.onSubscribe(); await settle();
  assert.equal(s.credits.getAuthorizationState().pendingCount, 1);
  const savedId = s.credits.readPending().requestId;
  const fromMine = s.mine.onRetryAuthorizationSync(), fromFollow = s.follow.onRetryAuthorizationSync();
  await settle(); assert.equal(s.records().length, 2);
  assert.equal(s.prompts(), 1);
  assert.equal(s.records()[0].payload.requestId, savedId); assert.equal(s.records()[1].payload.requestId, savedId);
  retry.resolve({ subscriptions: balances(6, 4), replayed: true }); await Promise.all([fromMine, fromFollow]);
  assert.equal(s.credits.readPending(), null);
  for (const page of s.pages) assert.equal(page.data.subscription.credits, 6);
});

test('nonmembers can inspect the reminder center but cannot start native authorization or grant themselves credits', async () => {
  const s = setup({ snapshot: boot('consumer:alice', false) });
  for (const page of s.pages) { page.onOpenAuthorizationPanel(); await page.onSubscribe(); }
  assert.equal(s.prompts(), 0); assert.equal(s.records().length, 0);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
  assert.equal(s.mine.data.settings.dnd.enabled, false);
});

test('a late native callback after account switch stays owned by the original account and gives no new-account feedback', async () => {
  const native = deferred(); const s = setup({ native: () => native.promise });
  s.mine.onOpenAuthorizationPanel();
  const authorizing = s.mine.onSubscribe();
  s.changeAccount(boot('consumer:bob', true, balances(20, 10)));
  native.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); await authorizing; await settle();
  assert.equal(s.records().length, 0, 'Alice grants wait for Alice to return');
  for (const page of s.pages) {
    assert.equal(page.data.authorizationOpen, false);
    assert.equal(page.data.authorizationFeedback, '');
    assert.equal(page.data.authorization.pendingCount, 0);
    assert.equal(page.data.subscription.credits, 20);
  }
  s.changeAccount(boot());
  await s.mine.resumeAuthorizationSync(); await settle();
  assert.equal(s.records().length, 1);
  assert.equal(s.records()[0].payload.expectedUserKey, 'consumer:alice');
});

test('a late native rejection and an old feedback timer cannot overwrite the next account', async () => {
  const native = deferred(); const s = setup({ native: () => native.promise });
  s.mine.setAuthorizationFeedback('Alice feedback');
  const authorizing = s.mine.onSubscribe();
  s.changeAccount(boot('consumer:bob'));
  s.mine.setAuthorizationFeedback('Bob feedback');
  native.reject(new Error('Alice native request failed')); await authorizing;
  assert.equal(s.mine.data.authorizationFeedback, 'Bob feedback');
  assert.equal(s.records().length, 0);
});

test('a hidden page for a different account never adopts broadcast balances or pending grants', async () => {
  const s = setup();
  s.mine.onHide();
  s.changeAccount(boot('consumer:bob', true, balances(20, 10)), [s.follow]);
  await s.follow.onSubscribe(); await settle();
  assert.equal(s.mine.data.subscription.credits, 5, 'Alice view keeps its own last confirmed balance');
  assert.equal(s.mine.data.authorization.pendingCount, 0);
  assert.equal(s.mine.data.authorizationFeedback, '');
  assert.equal(s.follow.data.subscription.credits, 6);
});

test('the mine and follow panels survive a short native-sheet round trip without a full page refresh', async () => {
  for (const target of ['mine', 'follow']) {
    const native = deferred(); const s = setup({ native: () => native.promise });
    const page = s[target]; page.onOpenAuthorizationPanel();
    const authorizing = page.onSubscribe();
    page.onHide(); assert.equal(page.getTabBar().data.sheetHidden, false);
    await page.onShow();
    assert.equal(page.data.authorizationOpen, true);
    assert.equal(page.getTabBar().data.sheetHidden, true);
    assert.equal(s.rt.calls.length, 0, `${target} should not reload account, follows or records`);
    native.resolve({ RESTOCK: 'accept', SOLDOUT: 'accept' }); await authorizing; await settle();
    assert.deepEqual(s.rt.calls.map(call => call.action), ['notify.recordSubscription']);
    page.onCloseAuthorizationPanel(); assert.equal(page.getTabBar().data.sheetHidden, false);
  }
});

test('ordinary returns still refresh and an account change cannot use the native-return shortcut', async () => {
  for (const target of ['mine', 'follow']) {
    const s = setup(), page = s[target];
    page.onHide(); await page.onShow();
    assert.ok(s.rt.calls.some(call => call.action === 'user.bootstrap'), target);
    const other = setup(), otherPage = other[target];
    otherPage.nativePromptHiddenAt = Date.now();
    other.changeAccount(boot('consumer:bob'), []);
    await otherPage.onShow();
    assert.equal(otherPage.accountSnapshot.identity.userKey, 'consumer:bob');
    assert.ok(other.rt.calls.some(call => call.action === 'user.bootstrap'));
  }
});

test('unloading releases the overlay and listeners while the existing queue continues for the other page', async () => {
  const sync = deferred(); const s = setup({ record: () => sync.promise });
  s.mine.onOpenAuthorizationPanel(); await s.mine.onSubscribe(); await settle();
  s.mine.onUnload(); const before = copy(s.mine.data);
  assert.equal(s.mine.getTabBar().data.sheetHidden, false);
  sync.resolve({ subscriptions: balances(6, 4) }); await settle();
  assert.deepEqual(copy(s.mine.data), before);
  assert.equal(s.follow.data.subscription.credits, 6);
  assert.equal(s.credits.getAuthorizationState().pendingCount, 0);
});
