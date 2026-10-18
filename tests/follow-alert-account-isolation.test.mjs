import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const EVENT = 'R577|SKU|restock_confirmed|2026-10-18T02:00:00.000Z';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(setImmediate);
const boot = userKey => ({ identity: { userKey }, membership: { active: true },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'TPL' } },
  subscriptions: { TPL: { credits: 3 } }, collector: { state: 'running' }, settings: { notifyEnabled: true },
  limits: { maxFollows: 5, maxStoresPerFollow: 4 } });
const detail = title => ({ notification: { eventId: EVENT, eventType: 'restock_confirmed', partNumber: 'SKU', storeNumber: 'R577',
  productTitle: title, detectedAt: new Date().toISOString(), feedback: null },
  latest: { status: 'available', observedAt: new Date().toISOString() }, follow: { status: 'active' } });
const feedback = outcome => ({ currentTarget: { dataset: { outcome } } });
function setup(handler) {
  const rt = runtime(handler), page = rt.instance('pages/follow/index.js');
  rt.app.globalData.handledAlerts = [];
  page.visible = true;
  page.applyBoot(boot('alice'), { ready: true });
  return { rt, page, count: action => rt.calls.filter(call => call.action === action).length };
}

test('switching accounts clears a displayed alert and permits the new owner to open the same stock event', async () => {
  let owner = 'alice';
  const s = setup(action => action === 'notify.detail' ? detail(owner) : {});
  await s.page.loadAlert(EVENT); await settle();
  assert.equal(s.page.data.alert.productTitle, 'alice');
  assert.equal(s.count('notify.open'), 1);
  s.page.applyBoot(boot('bob'));
  assert.equal(s.page.data.alert, null);
  assert.equal(s.page.data.alertBusy, false);
  assert.equal(s.page.presentedAlertId, null);
  assert.equal(s.rt.app.globalData.handledAlerts.includes(EVENT), false);
  owner = 'bob';
  await s.page.loadAlert(EVENT); await settle();
  assert.equal(s.page.data.alert.productTitle, 'bob');
  assert.equal(s.count('notify.open'), 2, 'the prior account acknowledgment cannot suppress this owner');
  s.page.recordAlertOpen(); await settle();
  assert.equal(s.count('notify.open'), 2, 'the new account still deduplicates its own repeated presentation');
  s.page.onUnload();
});

for (const outcome of ['success', 'failure']) {
  test(`an old-account detail ${outcome} cannot replace the same event loading for a new account`, async () => {
    const old = deferred(), current = deferred(); let reads = 0;
    const s = setup(action => action === 'notify.detail' ? ++reads === 1 ? old.promise : current.promise : {});
    const pending = s.page.loadAlert(EVENT);
    s.page.applyBoot(boot('bob'));
    const next = s.page.loadAlert(EVENT);
    if (outcome === 'success') old.resolve(detail('alice-private')); else old.reject(Error('alice read failed'));
    await pending;
    assert.equal(s.page.data.alert.loading, true);
    assert.equal(s.page.data.alert.error, undefined);
    assert.equal(s.count('notify.open'), 0);
    current.resolve(detail('bob-private')); await next; await settle();
    assert.equal(s.page.data.alert.productTitle, 'bob-private');
    assert.equal(s.count('notify.open'), 1);
    s.page.onUnload();
  });
}

test('returning to the original account does not revive that account previous outstanding detail read', async () => {
  const old = deferred(); let reads = 0;
  const s = setup(action => action === 'notify.detail' ? ++reads === 1 ? old.promise : detail('new visit') : {});
  const pending = s.page.loadAlert(EVENT);
  s.page.applyBoot(boot('bob')); s.page.applyBoot(boot('alice'));
  await s.page.loadAlert(EVENT);
  old.resolve(detail('old visit')); await pending; await settle();
  assert.equal(s.page.data.alert.productTitle, 'new visit');
  assert.equal(s.count('notify.open'), 1);
  s.page.onUnload();
});

test('a queued open receipt is retired before dispatch if the account changes synchronously', async () => {
  const s = setup(() => ({}));
  s.page.setData({ alert: { eventId: EVENT, productTitle: 'alice' } });
  s.page.presentedAlertId = EVENT;
  const pending = s.page.recordAlertOpen();
  s.page.applyBoot(boot('bob'));
  await pending;
  assert.equal(s.count('notify.open'), 0);
  assert.equal(s.page.acknowledgedAlerts.has(EVENT), false);
  s.page.onUnload();
});

test('closing and reopening before a queued receipt starts still acknowledges the new visible presentation once', async () => {
  const s = setup(action => action === 'notify.detail' ? detail('new presentation') : {});
  s.page.setData({ alert: { eventId: EVENT, productTitle: 'old presentation' } });
  s.page.presentedAlertId = EVENT;
  const old = s.page.recordAlertOpen();
  s.page.onCloseAlert();
  await s.page.loadAlert(EVENT); await old; await settle();
  assert.equal(s.count('notify.open'), 1);
  assert.equal(s.page.acknowledgedAlerts.has(EVENT), true);
  s.page.onUnload();
});

for (const outcome of ['success', 'failure']) {
  test(`a late old-account open ${outcome} cannot acknowledge or unlock the new account receipt, which can retry`, async () => {
    const old = deferred(), current = deferred(); let opens = 0;
    const s = setup(action => action === 'notify.detail' ? detail('owner')
      : action === 'notify.open' ? ++opens === 1 ? old.promise : opens === 2 ? current.promise : {} : {});
    await s.page.loadAlert(EVENT); await settle();
    s.page.applyBoot(boot('bob')); await s.page.loadAlert(EVENT); await settle();
    const work = s.page.alertOpenInFlight;
    if (outcome === 'success') old.resolve({ opened: true }); else old.reject(Error('old receipt failed'));
    await settle();
    assert.equal(s.page.alertOpenInFlight, work, 'old finally cannot clear the new same-event request');
    assert.equal(s.page.acknowledgedAlerts.has(EVENT), false);
    s.page.recordAlertOpen(); await settle();
    assert.equal(opens, 2, 'duplicate callbacks join the current outstanding receipt');
    current.reject(Error('new receipt failed')); await settle();
    assert.equal(s.page.alertOpenInFlight, null);
    assert.equal(s.page.acknowledgedAlerts.has(EVENT), false);
    await s.page.recordAlertOpen();
    assert.equal(opens, 3);
    assert.equal(s.page.acknowledgedAlerts.has(EVENT), true);
    assert.equal(s.count('notify.detail'), 2, 'receipt retries do not refetch stock');
    s.page.onUnload();
  });
}

for (const outcome of ['success', 'failure']) {
  test(`a late old-account feedback ${outcome} cannot alter a new same-event card or its busy state`, async () => {
    const old = deferred(), current = deferred(); let writes = 0;
    const s = setup(action => action === 'notify.detail' ? detail('owner')
      : action === 'notify.feedback' ? ++writes === 1 ? old.promise : current.promise
        : action === 'follow.list' ? { follows: [], limits: boot('bob').limits } : {});
    await s.page.loadAlert(EVENT);
    const pending = s.page.onAlertFeedback(feedback('bought'));
    s.page.applyBoot(boot('bob')); await s.page.loadAlert(EVENT);
    const next = s.page.onAlertFeedback(feedback('missed'));
    if (outcome === 'success') old.resolve({ outcome: 'bought', paused: true }); else old.reject(Error('old feedback failed'));
    await pending;
    assert.equal(s.page.data.alert.feedback, null);
    assert.equal(s.page.data.alert.followActive, true);
    assert.equal(s.page.data.alertBusy, true, 'the old finally cannot enable duplicate new-account submissions');
    assert.equal(s.count('follow.list'), 0, 'old membership writes cannot invalidate or refresh the new account list');
    assert.equal(s.rt.messages.length, 0);
    current.resolve({ outcome: 'missed', paused: false }); await next;
    assert.equal(s.page.data.alert.feedback, 'missed');
    assert.equal(s.page.data.alertBusy, false);
    assert.equal(s.rt.messages.at(-1), '已记录，继续为你盯着');
    s.page.onUnload();
  });
}

test('current-account feedback failures remain visible and retry can confirm a purchase and refresh follows', async () => {
  let fail = true;
  const s = setup((action, payload) => {
    if (action === 'notify.detail') return detail('alice');
    if (action === 'notify.feedback') { if (fail) throw Error('feedback unavailable'); return { outcome: payload.outcome, paused: true }; }
    if (action === 'follow.list') return { follows: [], limits: boot('alice').limits };
    return {};
  });
  await s.page.loadAlert(EVENT);
  await s.page.onAlertFeedback(feedback('bought'));
  assert.equal(s.page.data.alertBusy, false);
  assert.equal(s.page.data.alert.feedback, null);
  assert.match(s.rt.messages.at(-1).message, /feedback unavailable/);
  fail = false; await s.page.onAlertFeedback(feedback('bought'));
  assert.equal(s.page.data.alert.feedback, 'bought');
  assert.equal(s.page.data.alert.followActive, false);
  assert.equal(s.page.data.alertBusy, false);
  assert.equal(s.count('follow.list'), 1);
  s.page.onUnload();
});

test('closing and reopening the same event retires old feedback presentation but still refreshes its actual same-account pause', async () => {
  const old = deferred();
  const s = setup(action => action === 'notify.detail' ? detail('new presentation') : action === 'notify.feedback' ? old.promise
    : action === 'follow.list' ? { follows: [], limits: boot('alice').limits } : {});
  await s.page.loadAlert(EVENT);
  const pending = s.page.onAlertFeedback(feedback('bought'));
  s.page.onCloseAlert(); await s.page.loadAlert(EVENT);
  old.resolve({ outcome: 'bought', paused: true }); await pending;
  assert.equal(s.page.data.alert.feedback, null, 'a new presentation waits for its own authoritative details');
  assert.equal(s.page.data.alertBusy, false);
  assert.equal(s.count('follow.list'), 1, 'the actual same-account follow mutation still refreshes the list');
  assert.equal(s.rt.messages.length, 0);
  s.page.onUnload();
});
