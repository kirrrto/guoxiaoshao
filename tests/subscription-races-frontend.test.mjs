import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const subscriptions = credits => ({ 'restock-A': { credits } });
const boot = credits => ({ membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  subscriptions: subscriptions(credits), notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'restock-A' } },
  collector: { state: 'running' }, limits: { maxFollows: 3, maxStoresPerFollow: 3 } });

test('a pre-authorization account response cannot overwrite confirmed reminder credits', async () => {
  const oldRead = deferred(); let reads = 0;
  const rt = runtime(async () => ++reads === 1 ? boot(1) : oldRead.promise);
  const store = rt.load('utils/store.js');
  await store.getBootstrap();
  const refreshing = store.getBootstrap({ force: true });
  store.publishSubscriptions(subscriptions(2));
  oldRead.resolve(boot(1));
  assert.equal((await refreshing).subscriptions['restock-A'].credits, 2);
  assert.equal(rt.app.globalData.bootstrap.subscriptions['restock-A'].credits, 2);
});

test('explicit authorization waits for an in-flight silent credit sync instead of replaying it concurrently', async () => {
  const sync = deferred();
  const rt = runtime(async action => action === 'notify.recordSubscription' ? sync.promise : boot(2));
  rt.app.globalData.bootstrap = boot(1);
  rt.wx.getSetting = ({ success }) => success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { 'restock-A': 'accept' } } });
  const credits = rt.load('utils/reminder-credits.js');
  credits.refreshConsentSetting();
  const page = rt.instance('pages/follow/index.js'); page.applyBoot(boot(1));
  assert.equal(credits.topUpReminderCredit(), true);
  await settle();
  const explicit = page.onSubscribe();
  await settle();
  assert.equal(rt.calls.filter(c => c.action === 'notify.recordSubscription').length, 1);
  sync.resolve({ subscriptions: subscriptions(2) });
  await explicit; await settle();
  assert.equal(credits.readPending(), null);
});

test('silent top-up does not start while an explicit native authorization is unresolved', async () => {
  const consent = deferred(); let prompts = 0;
  const rt = runtime(async action => action === 'notify.recordSubscription' ? { subscriptions: subscriptions(2) } : boot(2));
  rt.app.globalData.bootstrap = boot(1);
  rt.wx.getSetting = ({ success }) => success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { 'restock-A': 'accept' } } });
  rt.wx.requestSubscribeMessage = () => { prompts++; return consent.promise; };
  const credits = rt.load('utils/reminder-credits.js'); credits.refreshConsentSetting();
  const page = rt.instance('pages/follow/index.js'); page.applyBoot(boot(1));
  const explicit = page.onSubscribe();
  assert.equal(credits.topUpReminderCredit(), false);
  assert.equal(prompts, 1);
  consent.resolve({ 'restock-A': 'accept' }); await explicit;
});

test('a lost silent sync releases the shared operation and explicit retry retains the same authorization identity', async () => {
  let records = 0, prompts = 0;
  const rt = runtime(async action => {
    if (action !== 'notify.recordSubscription') return boot(2);
    if (++records === 1) throw Object.assign(Error('response lost'), { code: 'call_failed' });
    return { subscriptions: subscriptions(2), replayed: true };
  });
  rt.app.globalData.bootstrap = boot(1);
  rt.wx.getSetting = ({ success }) => success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { 'restock-A': 'accept' } } });
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'restock-A': 'accept' }; };
  const credits = rt.load('utils/reminder-credits.js'); credits.refreshConsentSetting();
  const page = rt.instance('pages/follow/index.js'); page.applyBoot(boot(1));
  credits.topUpReminderCredit(); await settle();
  const pending = credits.readPending();
  assert.ok(pending);
  await page.onSubscribe();
  const requests = rt.calls.filter(c => c.action === 'notify.recordSubscription');
  assert.equal(prompts, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].payload, requests[1].payload);
  assert.equal(credits.readPending(), null);
  assert.equal(page.data.subscription.credits, 2);
});

test('a completion can clear only the authorization request that it recorded', () => {
  const rt = runtime(), credits = rt.load('utils/reminder-credits.js');
  const older = { requestId: 'ns-older', results: { 'restock-A': 'accept' } };
  const newer = { requestId: 'ns-newer', results: { 'restock-A': 'accept' } };
  credits.savePending(newer);
  credits.clearPending(older);
  assert.deepEqual(credits.readPending(), newer);
  credits.clearPending(newer);
  assert.equal(credits.readPending(), null);
});
