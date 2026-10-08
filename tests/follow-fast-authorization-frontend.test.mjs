import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const balances = (restock, soldout) => ({ 'restock-A': { credits: restock }, 'soldout-B': { credits: soldout } });
const boot = (restock = 5, soldout = 3) => ({
  identity: { userKey: 'consumer:user-a' },
  membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'restock-A', soldout: 'soldout-B' } },
  subscriptions: balances(restock, soldout), collector: { state: 'running' },
  settings: { notifyEnabled: true, dnd: { enabled: false } },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 },
});
function pageFor(rt, data = boot()) {
  rt.app.globalData.bootstrap = data;
  const page = rt.instance('pages/follow/index.js');
  page.visible = true;
  page.setData({ ready: true, followsLoaded: true, follows: [{ followId: 'f1', status: 'active', stores: [{ storeNumber: 'R001' }] }] });
  page.applyBoot(data);
  return page;
}
const response = (restock, soldout) => ({ accepted: ['restock-A', 'soldout-B'], subscriptions: balances(restock, soldout) });

test('a second tap can authorize before the first cloud response without inflating confirmed balances or refreshing the page', async () => {
  const replies = [deferred(), deferred()]; let records = 0, prompts = 0;
  const rt = runtime(async action => {
    assert.equal(action, 'notify.recordSubscription');
    return replies[records++].promise;
  });
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'restock-A': 'accept', 'soldout-B': 'accept' }; };
  const page = pageFor(rt), patches = [], setData = page.setData;
  page.setData = (patch, done) => { patches.push(copy(patch)); setData(patch, done); };
  await page.onSubscribe(); await settle();
  assert.equal(page.data.subscribing, false);
  assert.equal(records, 1);
  assert.equal(page.data.authorization.pendingRestock, 1);
  assert.equal(page.data.authorization.pendingSoldout, 1);
  assert.equal(page.data.subscription.credits, 5);
  assert.equal(page.data.subscription.soldoutCredits, 3);
  assert.equal(page.data.readiness.ready, true, 'pending top-ups do not suspend existing credits');
  assert.match(page.data.authorizationFeedback, /微信已允许/);
  await page.onSubscribe(); await settle();
  assert.equal(prompts, 2);
  assert.equal(records, 1, 'one cloud writer drains the queued results in order');
  assert.equal(page.data.authorization.pendingRestock, 2);
  assert.equal(page.data.authorization.pendingSoldout, 2);
  assert.equal(page.data.subscription.credits, 5);
  replies[0].resolve(response(6, 4)); await settle();
  assert.equal(records, 2);
  assert.equal(page.data.subscription.credits, 6);
  assert.equal(page.data.authorization.pendingRestock, 1);
  replies[1].resolve(response(7, 5)); await settle();
  assert.equal(page.data.subscription.credits, 7);
  assert.equal(page.data.subscription.soldoutCredits, 5);
  assert.equal(page.data.authorization.pendingCount, 0);
  assert.equal(rt.messages.length, 0, 'success feedback must not cover the next tap with a toast');
  assert.ok(patches.every(patch => !['boot', 'follows', 'collector', 'refreshedText', 'refreshing', 'ready'].some(key => key in patch)), 'authorization updates only its own display and readiness');
  const requests = rt.calls.filter(call => call.action === 'notify.recordSubscription');
  assert.notEqual(requests[0].payload.requestId, requests[1].payload.requestId);
});

test('native permission is never reentered or counted before WeChat has answered', async () => {
  const consent = deferred(); let prompts = 0;
  const rt = runtime(async () => response(6, 4));
  rt.wx.requestSubscribeMessage = () => { prompts++; return consent.promise; };
  const page = pageFor(rt), pending = page.onSubscribe();
  await page.onSubscribe();
  assert.equal(prompts, 1);
  assert.equal(page.data.subscribing, true);
  assert.equal(page.data.authorization.pendingCount, 0);
  assert.equal(page.data.subscription.credits, 5);
  assert.equal(rt.calls.length, 0);
  consent.resolve({ 'restock-A': 'accept', 'soldout-B': 'accept' });
  await pending; await settle();
  assert.equal(page.data.subscribing, false);
});

test('first successful top-up keeps the authorization card in the same position for continued taps', async () => {
  const rt = runtime(async () => response(1, 1)), page = pageFor(rt, boot(0, 0));
  assert.equal(page.data.readiness.ready, false);
  await page.onSubscribe(); await settle();
  assert.equal(page.data.readiness.ready, true);
  assert.equal(page.data.authorizationSession, true);
  assert.equal(page.data.authorizationPanelFirst, true);
  await page.onSubscribe(); await settle();
  assert.equal(page.data.authorizationPanelFirst, true);
});

test('a failed sync has an independent retry that retains the request identity and never reopens permission', async () => {
  let records = 0, prompts = 0;
  const rt = runtime(async () => {
    if (++records === 1) throw Object.assign(Error('网络连接失败'), { code: 'call_failed' });
    return { ...response(6, 4), replayed: true };
  });
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'restock-A': 'accept', 'soldout-B': 'accept' }; };
  const page = pageFor(rt);
  await page.onSubscribe(); await settle();
  assert.equal(page.data.subscribing, false);
  assert.equal(page.data.authorization.pendingCount, 1);
  assert.equal(page.data.subscription.credits, 5);
  assert.match(page.data.authorization.errorMessage, /网络/);
  await page.onRetryAuthorizationSync(); await settle();
  assert.equal(prompts, 1);
  assert.equal(records, 2);
  assert.deepEqual(rt.calls[0].payload, rt.calls[1].payload);
  assert.equal(page.data.authorization.pendingCount, 0);
  assert.equal(page.data.authorization.errorMessage, '');
  assert.match(page.data.authorizationFeedback, /未重复申请微信授权/);
});

test('a short return from the native permission sheet avoids a follow and account refresh', async () => {
  const consent = deferred();
  const rt = runtime(async action => { assert.equal(action, 'notify.recordSubscription'); return response(6, 4); });
  rt.wx.requestSubscribeMessage = () => consent.promise;
  const page = pageFor(rt), pending = page.onSubscribe();
  page.onHide();
  await page.onShow();
  assert.equal(rt.calls.length, 0);
  assert.equal(page.visible, true);
  consent.resolve({ 'restock-A': 'accept', 'soldout-B': 'accept' });
  await pending; await settle();
  assert.deepEqual(rt.calls.map(call => call.action), ['notify.recordSubscription']);
});

test('a normal page return still refreshes follows rather than mistaking it for permission dismissal', async () => {
  const rt = runtime(async action => action === 'follow.list' ? { follows: [], limits: boot().limits } : boot());
  const page = pageFor(rt);
  page.onHide();
  await page.onShow();
  assert.ok(rt.calls.some(call => call.action === 'follow.list'));
});

test('an unloaded page receives neither queue nor balance rendering while shared authorization synchronization completes', async () => {
  const sync = deferred(), rt = runtime(async () => sync.promise), page = pageFor(rt);
  await page.onSubscribe(); await settle();
  page.onUnload();
  const snapshot = copy(page.data);
  let published;
  rt.load('utils/store.js').subscribeSubscriptions(value => { published = value; });
  sync.resolve(response(6, 4)); await settle();
  assert.deepEqual(copy(page.data), snapshot);
  assert.equal(published['restock-A'].credits, 6);
  assert.equal(rt.load('utils/reminder-credits.js').getAuthorizationState().pendingCount, 0);
});

test('a storage failure keeps accepted results visible but prevents another native prompt until synchronization recovers', async () => {
  const sync = deferred(); let prompts = 0;
  const rt = runtime(async () => sync.promise), page = pageFor(rt);
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'restock-A': 'accept', 'soldout-B': 'accept' }; };
  const write = rt.wx.setStorageSync;
  rt.wx.setStorageSync = () => { throw Error('disk full'); };
  await page.onSubscribe(); await settle();
  assert.equal(page.data.authorization.storageBlocked, true);
  assert.match(page.data.authorization.errorMessage, /存储失败/);
  assert.equal(page.data.authorization.pendingRestock, 1);
  await page.onSubscribe();
  assert.equal(prompts, 1);
  rt.wx.setStorageSync = write;
  const retry = page.onRetryAuthorizationSync();
  sync.resolve(response(6, 4)); await retry; await settle();
  assert.equal(page.data.authorization.storageBlocked, false);
  assert.equal(page.data.subscription.credits, 6);
});

test('pending top-ups preserve existing readiness but an empty confirmed balance still waits for sync', () => {
  for (const [credits, ready, code] of [[5, true, 'ready'], [0, false, 'subscription_pending']]) {
    const rt = runtime(), page = pageFor(rt, boot(credits, credits));
    page.setData({ subscriptionPending: true });
    page.refreshReadiness();
    assert.equal(page.data.readiness.ready, ready);
    assert.equal(page.data.readiness.code, code);
  }
});
