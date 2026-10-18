import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const EVENT = 'R577|SKU|restock_confirmed|2026-10-18T02:00:00.000Z';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const boot = userKey => ({ identity: { userKey }, membership: { active: true },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'TPL' } },
  subscriptions: { TPL: { credits: 3 } }, collector: { state: 'running' }, settings: { notifyEnabled: true },
  limits: { maxFollows: 5, maxStoresPerFollow: 4 } });
const detail = { notification: { eventId: EVENT, eventType: 'restock_confirmed', partNumber: 'SKU', storeNumber: 'R577', productTitle: 'Alice phone', detectedAt: new Date().toISOString() },
  latest: { status: 'available', observedAt: new Date().toISOString() }, follow: { status: 'active' } };
function setup(account, overrides = {}) {
  const rt = runtime(action => {
    if (overrides[action]) return overrides[action]();
    if (action === 'user.bootstrap') return account();
    if (action === 'notify.detail') return detail;
    if (action === 'follow.list') return { follows: [], limits: boot('alice').limits };
    if (action === 'catalog.get') return { unchanged: true };
    return {};
  });
  rt.app.globalData.handledAlerts = [];
  rt.app.globalData.bootstrap = boot('alice');
  const page = rt.instance('pages/follow/index.js'); page.visible = false;
  page.applyBoot(boot('alice'), { ready: true });
  return { rt, page, opens: () => rt.calls.filter(call => call.action === 'notify.open').length };
}

test('returning to an old cached card waits for identity and never acknowledges it for a different account', async () => {
  const account = deferred(), s = setup(() => account.promise);
  await s.page.loadAlert(EVENT);
  s.rt.app.globalData.bootstrap = boot('bob');
  const returning = s.page.onShow(); await settle();
  assert.equal(s.opens(), 0, 'old alert must not send before the returning visit verifies its account');
  account.resolve(boot('bob')); await returning;
  assert.equal(s.page.data.alert, null);
  assert.equal(s.opens(), 0);
  s.page.onUnload();
});

test('a detail arriving during a returning identity check cannot bypass the receipt guard', async () => {
  const account = deferred(), response = deferred();
  const s = setup(() => account.promise, { 'notify.detail': () => response.promise });
  const loading = s.page.loadAlert(EVENT);
  const returning = s.page.onShow();
  response.resolve(detail); await loading; await settle();
  assert.equal(s.opens(), 0);
  account.resolve(boot('bob')); await returning;
  assert.equal(s.page.data.alert, null); assert.equal(s.opens(), 0);
  s.page.onUnload();
});

test('same-account return acknowledges after verification and failed receipts remain retryable', async () => {
  const account = deferred(); let fail = true;
  const s = setup(() => account.promise, { 'notify.open': () => { if (fail) throw Error('receipt unavailable'); return {}; } });
  await s.page.loadAlert(EVENT);
  const returning = s.page.onShow(); await settle(); assert.equal(s.opens(), 0);
  account.resolve(boot('alice')); await returning; await settle();
  assert.equal(s.opens(), 1); assert.equal(s.page.acknowledgedAlerts.has(EVENT), false);
  fail = false; await s.page.recordAlertOpen();
  assert.equal(s.opens(), 2); assert.equal(s.page.acknowledgedAlerts.has(EVENT), true);
  s.page.onUnload();
});

test('failed identity refresh blocks old receipts until a later visit verifies the account', async () => {
  const account = deferred(); let restored = false;
  const s = setup(() => restored ? boot('alice') : account.promise);
  await s.page.loadAlert(EVENT);
  const returning = s.page.onShow(); account.reject(Error('identity unavailable')); await returning;
  await s.page.recordAlertOpen(); assert.equal(s.opens(), 0, 'failed identity refresh must not authorize old-card analytics');
  s.page.onHide(); restored = true; await s.page.onShow(); await settle();
  assert.equal(s.opens(), 1); assert.equal(s.page.acknowledgedAlerts.has(EVENT), true);
  s.page.onUnload();
});

test('failed identity refresh followed by another account never sends the old receipt', async () => {
  let restored = false;
  const s = setup(() => { if (!restored) throw Error('identity unavailable'); return boot('bob'); });
  await s.page.loadAlert(EVENT); s.rt.app.globalData.bootstrap = boot('bob');
  await s.page.onShow(); await s.page.recordAlertOpen(); assert.equal(s.opens(), 0);
  s.page.onHide(); restored = true; await s.page.onShow(); await settle();
  assert.equal(s.page.data.alert, null); assert.equal(s.opens(), 0);
  s.page.onUnload();
});

test('automatic retry can acknowledge the same visible card once identity recovers', async () => {
  let restored = false;
  const s = setup(() => { if (!restored) throw Error('identity unavailable'); return boot('alice'); });
  await s.page.loadAlert(EVENT); await s.page.onShow();
  assert.equal(s.opens(), 0);
  restored = true;
  const poll = s.rt.timers.get(s.page.pollTimer); assert.ok(poll);
  s.rt.timers.delete(s.page.pollTimer); await poll.fn(); await settle();
  assert.equal(s.opens(), 1); assert.equal(s.page.acknowledgedAlerts.has(EVENT), true);
  s.page.onUnload();
});
