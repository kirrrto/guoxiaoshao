import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { reminderReadiness, restockSubscription } = require('../miniprogram/utils/reminder-readiness.js');
const copy = value => JSON.parse(JSON.stringify(value));
const active = (id = 'f1', stores = ['R001']) => ({ followId: id, partNumber: id, status: 'active', stores: stores.map(storeNumber => ({ storeNumber })) });
const boot = patch => ({ membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' }, collector: { state: 'running' }, notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'A', other: 'B' } }, subscriptions: { A: { credits: 1 }, B: { credits: 9 } }, settings: { notifyEnabled: true, dnd: { enabled: false } }, limits: { maxFollows: 3, maxStoresPerFollow: 3 }, ...patch });
const state = patch => ({ boot: { member: true }, followsLoaded: true, follows: [active()], collector: { state: 'running' }, delivery: { cls: 'ok' }, settings: { notifyEnabled: true }, subscription: { templateCount: 1, credits: 1 }, ...patch });

test('personal readiness distinguishes loading, no follows and all paused from healthy shared services', () => {
  assert.equal(reminderReadiness(state({ followsLoaded: false, follows: [] })).code, 'checking_follows');
  const empty = reminderReadiness(state({ follows: [] }));
  assert.equal(empty.code, 'no_follows'); assert.equal(empty.action, 'add'); assert.equal(empty.ready, false);
  const paused = reminderReadiness(state({ follows: [{ ...active(), status: 'paused' }] }));
  assert.equal(paused.code, 'all_paused'); assert.equal(paused.action, 'follows'); assert.equal(paused.ready, false);
  const ready = reminderReadiness(state({ follows: [active('f1', ['R001', 'R002']), active('f2', ['R002', 'R003']), { ...active('f3', ['R004']), status: 'paused' }] }));
  assert.equal(ready.ready, true); assert.equal(ready.activeCount, 2); assert.equal(ready.storeCount, 3);
});

test('other-template credits cannot make restock delivery ready or appear in requested template IDs', async () => {
  assert.deepEqual(restockSubscription({ templateIds: { restock: 'A', other: 'B' } }, { A: { credits: 0 }, B: { credits: 50 } }), { templateIds: ['A'], templateCount: 1, credits: 0 });
  const rt = runtime(async action => action === 'notify.recordSubscription' ? { accepted: ['A'], subscriptions: { A: { credits: 1 }, B: { credits: 50 } } } : boot());
  const page = rt.instance('pages/follow/index.js'); page.setData({ followsLoaded: true, follows: [active()] });
  page.applyBoot(boot({ subscriptions: { A: { credits: 0 }, B: { credits: 50 } } }));
  assert.equal(page.data.readiness.code, 'no_credit'); assert.equal(page.data.subscription.credits, 0);
  let requested;
  rt.wx.requestSubscribeMessage = async value => { requested = copy(value); return { A: 'accept' }; };
  await page.onReadinessAction();
  assert.deepEqual(requested.tmplIds, ['A']); assert.equal(page.data.subscription.credits, 1); assert.equal(page.data.readiness.ready, true);
});

test('template and sender blockers explain service configuration instead of asking for repeated authorization', () => {
  for (const patch of [{ subscription: { templateCount: 0, credits: 0 } }, { delivery: { cls: 'warn' } }, { collector: { state: 'stale' } }]) {
    const result = reminderReadiness(state(patch));
    assert.equal(result.ready, false); assert.equal(result.action, 'service'); assert.notEqual(result.action, 'subscribe');
  }
  assert.equal(reminderReadiness(state({ subscriptionPending: true })).actionLabel, '同步授权记录');
});

test('personal switch, expiry and Beijing overnight DND retain their separate next steps', () => {
  assert.equal(reminderReadiness(state({ boot: { member: false, expired: true } })).action, 'membership');
  assert.equal(reminderReadiness(state({ settings: { notifyEnabled: false } })).code, 'user_disabled');
  const quiet = state({ settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 1380, endMinute: 480 } } });
  const during = reminderReadiness(quiet, Date.parse('2026-09-16T15:30:00Z'));
  assert.equal(during.code, 'dnd'); assert.equal(during.action, 'settings');
  assert.equal(reminderReadiness(quiet, Date.parse('2026-09-17T00:00:00Z')).ready, true);
});

test('pause and resume immediately recompute the personal outcome after reloading real follow state', async () => {
  let follow = active();
  const rt = runtime(async action => {
    if (action === 'follow.pause') follow = { ...follow, status: 'paused' };
    if (action === 'follow.resume') follow = { ...follow, status: 'active' };
    return { follows: [follow], limits: { maxFollows: 3, maxStoresPerFollow: 3 } };
  });
  const page = rt.instance('pages/follow/index.js'); page.applyBoot(boot());
  assert.equal(page.data.readiness.code, 'checking_follows');
  await page.loadFollows(); assert.equal(page.data.readiness.ready, true);
  await page.onToggle({ currentTarget: { dataset: { id: 'f1', status: 'active' } } }); assert.equal(page.data.readiness.code, 'all_paused');
  await page.onToggle({ currentTarget: { dataset: { id: 'f1', status: 'paused' } } }); assert.equal(page.data.readiness.ready, true);
});

test('personal next steps navigate to a precise list or settings target without mutating preferences', () => {
  const rt = runtime(), page = rt.instance('pages/follow/index.js'), scrolls = [], routes = [];
  rt.wx.pageScrollTo = options => scrolls.push(options); rt.wx.switchTab = options => routes.push(options.url);
  page.setData({ followsLoaded: true, follows: [{ ...active(), status: 'paused' }] }); page.applyBoot(boot()); page.onReadinessAction();
  assert.equal(scrolls[0].selector, '#follow-configurations');
  page.setData({ follows: [active()] }); page.applyBoot(boot({ settings: { notifyEnabled: false } })); page.onReadinessAction();
  assert.equal(rt.app.globalData.pendingMineSection, 'reminder-settings'); assert.equal(routes[0], '/pages/mine/index'); assert.equal(rt.calls.length, 0);
});

test('notification reasons lead to settings or live readiness, while uncertain messages have no resend', () => {
  const rt = runtime(), mine = rt.instance('pages/mine/index.js'), scrolls = [], routes = [];
  rt.wx.pageScrollTo = value => scrolls.push(value); rt.wx.switchTab = value => routes.push(value.url);
  mine.pageVisible = true; mine.setData({ ready: true, notifications: [
    { id: 'quiet', status: 'skipped', reason: 'dnd' }, { id: 'auth', status: 'skipped', reason: 'no_subscription_credit' },
    { id: 'unknown', status: 'uncertain', reason: 'send_transport_error' }, { id: 'removed', status: 'skipped', reason: 'follow_not_active', partNumber: 'SKU-A' },
  ] });
  const tap = id => mine.onNotificationAction({ currentTarget: { dataset: { id } } });
  tap('quiet'); assert.equal(scrolls.at(-1).selector, '#reminder-settings');
  tap('auth'); assert.equal(routes.at(-1), '/pages/follow/index'); assert.equal(rt.app.globalData.pendingFollowFocus.section, 'reminder-health');
  tap('unknown'); assert.match(rt.messages.at(-1).content, /不会自动重发/); assert.equal(rt.calls.length, 0);
  tap('removed'); assert.equal(rt.app.globalData.pendingFollowFocus.partNumber, 'SKU-A');
});

test('settings deep link survives a cold page and a deferred callback after hiding cannot scroll another page', () => {
  const rt = runtime(), mine = rt.instance('pages/mine/index.js'), pending = [], scrolls = [];
  rt.wx.nextTick = fn => pending.push(fn); rt.wx.pageScrollTo = value => scrolls.push(value);
  rt.app.globalData.pendingMineSection = 'reminder-settings'; mine.pageVisible = true;
  mine.consumePendingSection(); assert.equal(pending.length, 0);
  mine.setData({ ready: true }); mine.consumePendingSection(); mine.onHide(); pending.shift()();
  assert.equal(scrolls.length, 0); assert.equal(rt.app.globalData.pendingMineSection, 'reminder-settings');
  mine.pageVisible = true; mine.consumePendingSection(); pending.shift()();
  assert.equal(scrolls[0].selector, '#reminder-settings'); assert.equal(rt.app.globalData.pendingMineSection, null);
});

test('returning from a reminder focuses the matching configuration after load without resuming it or requesting authorization', async () => {
  const rt = runtime(async () => ({ follows: [active('SKU-A'), { ...active('SKU-B'), status: 'paused' }], limits: {} }));
  const page = rt.instance('pages/follow/index.js'), scrolls = [];
  rt.wx.pageScrollTo = value => scrolls.push(value);
  rt.app.globalData.pendingFollowFocus = { section: 'follow-configurations', partNumber: 'SKU-B' };
  page.visible = true; page.applyBoot(boot(), { ready: true });
  page.consumePendingFocus(); assert.equal(scrolls.length, 0);
  await page.loadFollows();
  assert.equal(scrolls[0].selector, '#follow-entry-1');
  assert.deepEqual(rt.calls.map(c => c.action), ['follow.list']);
  assert.equal(page.data.follows[1].status, 'paused');
  assert.equal(rt.app.globalData.pendingFollowFocus, null);
});

test('a delayed pre-pause poll cannot replace the newly paused list or falsely restore personal readiness', async () => {
  let finishOldRead, reads = 0;
  const rt = runtime(async action => {
    if (action === 'follow.list') {
      reads += 1;
      if (reads === 1) return new Promise(resolve => { finishOldRead = resolve; });
      return { follows: [{ ...active(), status: 'paused' }], limits: {} };
    }
    return {};
  });
  const page = rt.instance('pages/follow/index.js'); page.setData({ followsLoaded: true, follows: [active()] }); page.applyBoot(boot());
  const oldPoll = page.loadFollows({ force: true });
  await page.onToggle({ currentTarget: { dataset: { id: 'f1', status: 'active' } } });
  assert.equal(page.data.readiness.code, 'all_paused'); assert.equal(reads, 2);
  finishOldRead({ follows: [active()], limits: {} }); await oldPoll;
  assert.equal(page.data.follows[0].status, 'paused'); assert.equal(page.data.readiness.code, 'all_paused');
});
