import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const boot = () => ({
  identity: { userKey: 'recovery:user' }, membership: { active: true, expiresAt: '2027-01-01T00:00:00Z', remainingMs: 86400000 },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'A' } }, subscriptions: { A: { credits: 3 } },
  collector: { state: 'running' }, settings: { notifyEnabled: true, dnd: { enabled: false, startMinute: 1380, endMinute: 480 } },
  quota: { balance: 1, queryCost: 1, historyCost: 1, tasksDoneToday: [] }, tasks: [], memberProduct: {}, followCount: 1,
  limits: { maxFollows: 3, maxStoresPerFollow: 3 },
});
const follow = { followId: 'f-existing', partNumber: 'SKU-A', productTitle: 'Phone', status: 'active', stores: [] };

test('returning to an account or follow tab retries a failed first load without discarding the saved follow', async () => {
  for (const name of ['mine', 'follow']) {
    let online = false;
    const rt = runtime(async action => {
      if (action === 'user.bootstrap') { if (!online) throw Error('请求超时'); return boot(); }
      if (action === 'follow.list') return { follows: [follow], limits: boot().limits };
      if (action === 'catalog.get') return { unchanged: true };
      return { notifications: [] };
    });
    const page = rt.instance(`pages/${name}/index.js`);
    await page.onLoad();
    assert.equal(page.data.ready, false, name);
    assert.match(page.data.loadError, /请求超时/, name);
    page.onHide(); online = true;
    await page.onShow();
    assert.equal(page.data.ready, true, name);
    assert.equal(page.data.loadError, null, name);
    if (name === 'follow') assert.equal(page.data.follows[0].followId, follow.followId);
    assert.equal(rt.calls.filter(call => call.action === 'user.bootstrap').length, 2, name);
    page.onUnload();
  }
});

test('an unfinished first follow read cannot open an empty-list add flow', async () => {
  let finishList;
  const rt = runtime(async action => action === 'user.bootstrap' ? boot() : action === 'catalog.get' ? { unchanged: true }
    : new Promise(resolve => { finishList = resolve; }));
  const page = rt.instance('pages/follow/index.js');
  const loading = page.onLoad();
  await settle();
  assert.equal(page.data.ready, true);
  assert.equal(page.data.followsLoaded, false);
  page.onAdd();
  assert.equal(page.data.editing, false);
  assert.match(rt.messages.at(-1), /正在确认已有关注/);
  finishList({ follows: [follow], limits: boot().limits });
  await loading;
  page.onAdd();
  assert.equal(page.data.editing, true);
  assert.equal(page.data.follows[0].followId, follow.followId);
  page.onUnload();
});

test('a lost silent authorization response appears as pending on return and retries its ID without another WeChat prompt', async () => {
  let recordCalls = 0, prompts = 0;
  const account = boot();
  const rt = runtime(async action => {
    if (action === 'user.bootstrap') return account;
    if (action === 'catalog.get') return { unchanged: true };
    if (action === 'follow.list') return { follows: [follow], limits: account.limits };
    if (action === 'notify.recordSubscription') {
      if (++recordCalls === 1) throw Object.assign(Error('response lost'), { code: 'call_failed' });
      account.subscriptions = { A: { credits: 4 } };
      return { replayed: true, accepted: ['A'], subscriptions: account.subscriptions };
    }
    return {};
  });
  rt.wx.getSetting = ({ success }) => success({ subscriptionsSetting: { mainSwitch: true, itemSettings: { A: 'accept' } } });
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { A: 'accept' }; };
  const page = rt.instance('pages/follow/index.js');
  await page.onLoad();
  const credits = rt.load('utils/reminder-credits.js');
  credits.refreshConsentSetting();
  assert.equal(credits.topUpReminderCredit(), true);
  await settle();
  const pendingId = credits.readPending().requestId;
  await page.onShow();
  assert.equal(page.data.subscriptionPending, true);
  assert.equal(page.data.readiness.code, 'subscription_pending');
  assert.equal(page.data.creditBoostTip, '', 'sync the existing record before suggesting additional authorization');
  await page.onSubscribe();
  assert.equal(prompts, 1);
  assert.equal(recordCalls, 2);
  assert.equal(rt.calls.filter(call => call.action === 'notify.recordSubscription')[1].payload.requestId, pendingId);
  assert.equal(page.data.subscriptionPending, false);
  assert.equal(page.data.subscription.credits, 4);
  page.onUnload();
});

test('account reconnect recovery can be awaited and does not act on a hidden or retired page', async () => {
  const rt = runtime(async action => action === 'user.bootstrap' ? boot() : { notifications: [] });
  const page = rt.instance('pages/mine/index.js');
  page.setData({ loadError: 'offline' });
  await page.onNetworkRestored();
  assert.equal(page.data.ready, true);
  const count = rt.calls.length;
  page.onHide(); await page.onNetworkRestored();
  assert.equal(rt.calls.length, count);
  page.onUnload(); await page.onNetworkRestored(); await page.onRetryLoad();
  assert.equal(rt.calls.length, count);
});

test('a confirmed credit broadcast clears a pending-sync notice even when the credit balance is unchanged', async () => {
  const rt = runtime(async action => action === 'user.bootstrap' ? boot() : action === 'catalog.get' ? { unchanged: true }
    : { follows: [follow], limits: boot().limits });
  const page = rt.instance('pages/follow/index.js');
  await page.onLoad();
  const credits = rt.load('utils/reminder-credits.js');
  const pending = { requestId: 'accepted-000001', results: { A: 'accept' } };
  credits.savePending(pending);
  page.applyBoot(boot());
  assert.equal(page.data.readiness.code, 'subscription_pending');
  credits.clearPending(pending);
  rt.load('utils/store.js').publishSubscriptions(boot().subscriptions);
  assert.equal(page.data.subscriptionPending, false);
  assert.equal(page.data.readiness.code, 'ready');
  page.onUnload();
});
