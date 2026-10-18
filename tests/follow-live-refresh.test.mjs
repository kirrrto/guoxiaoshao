import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fireTimer = async (rt, id) => { const timer = rt.timers.get(id); assert.ok(timer, 'expected timer is scheduled'); rt.timers.delete(id); await timer.fn(); };
const boot = (userKey = 'alice') => ({ identity: { userKey }, membership: { active: true },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'RESTOCK' } },
  subscriptions: { RESTOCK: { credits: 8 } }, collector: { state: 'running' }, settings: { notifyEnabled: true },
  limits: { maxFollows: 5, maxStoresPerFollow: 4 } });
const follows = (label = 'new', at = new Date().toISOString()) => ({ follows: [{ followId: label, partNumber: 'SKU-A',
  productTitle: label, status: 'active', stores: [{ storeNumber: 'R575', status: 'available', observedAt: at }] }], limits: boot().limits });
function setup(handler) {
  const rt = runtime(handler), page = rt.instance('pages/follow/index.js');
  rt.app.globalData.bootstrap = boot();
  page.visible = true; page.setData({ ready: true }); page.applyBoot(boot());
  return { rt, page, actions: () => rt.calls.map(call => call.action) };
}

test('an automatic record update changes the same followed product from no stock to pickup without a manual query', async t => {
  let now = Date.now(), status = 'unavailable';
  t.mock.method(Date, 'now', () => now);
  const f = setup(action => {
    if (action === 'user.bootstrap') return boot();
    if (action === 'catalog.get') return { unchanged: true };
    const response = follows('same-product', new Date(now).toISOString());
    response.follows[0].stores[0].status = status;
    response.follows[0].stores[0].source = 'auto';
    return response;
  });
  await f.page.onShow();
  assert.equal(f.page.data.follows[0].hasAvailable, false);
  f.page.onToggleFollowDetails({ currentTarget: { dataset: { id: 'same-product' } } });
  status = 'available'; now += 30000;
  await fireTimer(f.rt, f.page.pollTimer);
  assert.equal(f.page.data.follows[0].hasAvailable, true);
  assert.equal(f.page.data.follows[0].observationLabel, '1 家可取货');
  assert.equal(f.page.data.follows[0].stores[0].observedAt, new Date(now).toISOString());
  assert.equal(f.page.data.follows[0].detailsExpanded, true, 'automatic updates preserve the open store details');
  assert.equal(f.page.data.subscription.credits, 8);
  assert.equal(f.actions().filter(action => action === 'follow.list').length, 2);
  assert.equal(f.actions().includes('query.pickup'), false, 'no paid/manual stock query is needed to show the automatic result');
  f.page.onUnload();
});

test('follow reads begin while bootstrap is pending and still publish if that account refresh fails', async () => {
  const account = deferred();
  const f = setup(action => action === 'user.bootstrap' ? account.promise : follows());
  const pending = f.page.refreshLiveStatus(); await settle();
  assert.equal(f.actions().filter(action => action === 'follow.list').length, 1, 'bootstrap cannot block fetching stock records');
  assert.equal(f.page.data.follows.length, 0, 'presentation waits for the account boundary');
  account.reject(Error('account endpoint unavailable')); await pending;
  assert.equal(f.page.data.follows[0].productTitle, 'new');
  assert.match(f.page.data.refreshError, /库存记录已更新.*账户与提醒条件暂未更新/);
  assert.equal(f.page.data.liveSync.state, 'retrying');
  assert.equal(f.actions().includes('query.pickup'), false);
  f.page.onUnload();
});

test('visible reads cap stale collector scheduling at 30 seconds and slow reads never overlap', async t => {
  const now = Date.parse('2026-10-18T02:00:30Z'); t.mock.method(Date, 'now', () => now);
  const stock = deferred();
  const f = setup(action => action === 'user.bootstrap' ? boot() : stock.promise);
  f.page.data.collector = { state: 'running', nextRunAt: '2026-10-18T02:01:00Z' };
  f.page.startPolling();
  assert.equal([...f.rt.timers.values()][0].ms, 30000);
  const ticking = f.rt.nextTimer(); await settle();
  assert.equal(f.page.data.liveSync.state, 'syncing');
  assert.equal(f.rt.timers.size, 0, 'a waiting network request has no next poll scheduled');
  const manual = f.page.onRefreshStatus(), concurrent = f.page.refreshLiveStatus();
  await settle();
  assert.equal(f.actions().filter(action => action === 'follow.list').length, 1);
  assert.equal(f.actions().filter(action => action === 'user.bootstrap').length, 1);
  stock.resolve(follows()); await Promise.all([ticking, manual, concurrent]);
  assert.equal(f.rt.timers.size, 2, 'one network poll and one local freshness clock');
  assert.equal(f.rt.timers.get(f.page.pollTimer).ms, 30000);
  assert.equal(f.page.data.refreshing, false);
  f.page.onUnload(); assert.equal(f.rt.timers.size, 0);
});

test('hiding retires in-flight page updates and returning bypasses the 15-second settled follow cache', async () => {
  const stock = deferred(); let reads = 0;
  const f = setup(action => action === 'user.bootstrap' ? boot() : action === 'catalog.get' ? { unchanged: true }
    : ++reads === 1 ? stock.promise : follows('returned'));
  const pending = f.page.refreshLiveStatus(); await settle();
  f.page.onHide(); const hidden = copy(f.page.data);
  stock.resolve(follows('hidden')); await pending;
  assert.deepEqual(copy(f.page.data), hidden, 'late background records do not paint a hidden page');
  assert.equal(f.rt.timers.size, 0);
  await f.page.onShow();
  assert.equal(reads, 2, 'return reads server records even though the shared snapshot is less than 15 seconds old');
  assert.equal(f.page.data.follows[0].productTitle, 'returned');
  assert.equal(f.page.data.liveSync.state, 'waiting');
  assert.equal(f.actions().includes('query.pickup'), false);
  f.page.onUnload();
});

test('an account switch discovered during parallel reads discards the old records and reads the new owner', async () => {
  const account = deferred(); let reads = 0;
  const f = setup(action => action === 'user.bootstrap' ? account.promise : follows(++reads === 1 ? 'alice-private' : 'bob-private'));
  const painted = [], write = f.page.setData;
  f.page.setData = patch => { if (patch.follows) painted.push(...patch.follows.map(row => row.productTitle)); write(patch); };
  const pending = f.page.refreshLiveStatus(); await settle();
  account.resolve(boot('bob')); await pending;
  assert.equal(f.page.accountSnapshot.identity.userKey, 'bob');
  assert.equal(f.page.data.follows[0].productTitle, 'bob-private');
  assert.equal(reads, 2);
  assert.equal(painted.includes('alice-private'), false, 'old account data never crosses the new account boundary');
  assert.equal(f.page.data.liveSync.state, 'waiting');
  f.page.onUnload();
});

for (const outcome of ['success', 'failure']) {
  test(`an external account switch survives an old refresh ${outcome} and keeps automatic polling alive`, async () => {
    const stock = deferred();
    const f = setup(action => action === 'user.bootstrap' ? boot() : stock.promise);
    const pending = f.page.refreshLiveStatus(); await settle();
    f.page.applyBoot(boot('bob'));
    f.page.setData({ refreshError: 'bob notice' });
    if (outcome === 'success') stock.resolve(follows('alice-private')); else stock.reject(Error('old account failed'));
    await pending;
    assert.equal(f.page.accountSnapshot.identity.userKey, 'bob');
    assert.equal(f.page.data.follows.length, 0);
    assert.equal(f.page.data.refreshError, 'bob notice');
    assert.equal(f.rt.timers.size, 1, 'switching accounts must not permanently stop future automatic reads');
    f.page.onUnload();
  });
}

test('offline stops polling and reconnect starts one immediate read across duplicate restoration callbacks', async () => {
  let networkChanged, network = 'none'; const stock = deferred();
  const f = setup(action => action === 'user.bootstrap' ? boot() : stock.promise);
  f.rt.wx.getNetworkType = ({ success }) => success({ networkType: network });
  f.rt.wx.onNetworkStatusChange = fn => { networkChanged = fn; };
  f.page.startPolling();
  assert.equal(f.page.data.liveSync.state, 'offline'); assert.equal(f.rt.timers.size, 0); assert.equal(f.actions().length, 0);
  network = 'wifi'; networkChanged({ isConnected: true });
  const repeated = f.page.onNetworkRestored(); await settle();
  assert.equal(f.actions().filter(action => action === 'follow.list').length, 1);
  stock.resolve(follows()); await repeated;
  assert.equal(f.page.data.liveSync.state, 'waiting'); assert.equal(f.rt.timers.size, 2);
  networkChanged({ isConnected: false });
  assert.equal(f.page.data.liveSync.state, 'offline'); assert.equal(f.page.pollTimer, null);
  assert.equal(f.rt.timers.size, 1, 'disconnection retains only the local freshness clock');
  const before = f.actions().length;
  f.page.onUnload(); networkChanged({ isConnected: true }); await settle();
  assert.equal(f.actions().length, before, 'an unloaded page cannot restart network work');
});

test('repeated read failures back off without losing the old observation or starting paid queries', async () => {
  const f = setup(async action => { if (action === 'user.bootstrap') return boot(); throw Error('follow endpoint unavailable'); });
  f.page.data.follows = follows('kept').follows;
  const times = [];
  await f.page.refreshLiveStatus(); times.push(f.rt.timers.get(f.page.pollTimer).ms);
  await fireTimer(f.rt, f.page.pollTimer); times.push(f.rt.timers.get(f.page.pollTimer).ms);
  await fireTimer(f.rt, f.page.pollTimer); times.push(f.rt.timers.get(f.page.pollTimer).ms);
  await fireTimer(f.rt, f.page.pollTimer); times.push(f.rt.timers.get(f.page.pollTimer).ms);
  assert.deepEqual(times, [30000, 60000, 120000, 120000]);
  assert.equal(f.page.data.follows[0].productTitle, 'kept');
  assert.equal(f.page.data.liveSync.state, 'retrying');
  assert.equal(f.actions().includes('query.pickup'), false);
  f.page.onUnload();
});

test('offline visible records age into historical observations without network activity', async t => {
  let now = Date.parse('2026-10-18T02:00:00Z'); t.mock.method(Date, 'now', () => now);
  const f = setup(() => { throw Error('offline must not read'); });
  f.rt.wx.getNetworkType = ({ success }) => success({ networkType: 'none' });
  f.page.data.follows = follows('kept', new Date(now).toISOString()).follows;
  await f.page.refreshLiveStatus();
  assert.equal(f.page.data.follows[0].stores[0].observationState, 'fresh');
  assert.equal(f.page.pollTimer, null);
  assert.equal(f.rt.timers.size, 1);
  now += 121000;
  await fireTimer(f.rt, f.page.observationTimer);
  assert.equal(f.page.data.follows[0].stores[0].observationState, 'stale');
  assert.match(f.page.data.follows[0].observationLabel, /上次/);
  assert.equal(f.actions().length, 0, 'local expiry cannot consume any remote work or query quota');
  f.page.onHide(); assert.equal(f.rt.timers.size, 0);
});

test('a slow old-account follow response cannot trigger an extra read or cross the confirmed account boundary', async () => {
  const account = deferred(), stock = deferred(); let reads = 0;
  const f = setup(action => action === 'user.bootstrap' ? account.promise
    : ++reads === 1 ? stock.promise : follows('bob-private'));
  const painted = [], write = f.page.setData;
  f.page.setData = patch => { if (patch.follows) painted.push(...patch.follows.map(row => row.productTitle)); write(patch); };
  const pending = f.page.refreshLiveStatus(); await settle();
  account.resolve(boot('bob')); await settle();
  stock.resolve(follows('alice-private')); await pending;
  assert.equal(f.page.data.follows[0].productTitle, 'bob-private');
  assert.equal(reads, 2, 'a generation-invalidated shared read is reused for the newly confirmed account');
  assert.equal(painted.includes('alice-private'), false);
  f.page.onUnload();
});

test('cold startup completed in the background cannot paint, and the next visible visit starts normally', async () => {
  const account = deferred();
  const rt = runtime(action => action === 'user.bootstrap' ? account.promise : action === 'catalog.get' ? { unchanged: true } : follows('visible'));
  const page = rt.instance('pages/follow/index.js'); page.visible = true;
  const pending = page.onLoad(); await settle();
  page.onHide(); const hidden = copy(page.data);
  account.resolve(boot()); await pending;
  assert.deepEqual(copy(page.data), hidden);
  assert.equal(rt.calls.filter(call => call.action === 'follow.list').length, 0);
  await page.onShow();
  assert.equal(page.data.ready, true);
  assert.equal(page.data.follows[0].productTitle, 'visible');
  assert.equal(page.data.liveSync.state, 'waiting');
  page.onUnload();
});

test('a quick return before cold startup settles resumes once without leaving the page loading forever', async () => {
  const account = deferred();
  const rt = runtime(action => action === 'user.bootstrap' ? account.promise : action === 'catalog.get' ? { unchanged: true } : follows('visible'));
  const page = rt.instance('pages/follow/index.js'); page.visible = true;
  const pending = page.onLoad(); await settle();
  page.onHide(); await page.onShow();
  account.resolve(boot()); await pending;
  assert.equal(page.data.ready, true);
  assert.equal(page.data.follows[0].productTitle, 'visible');
  assert.equal(rt.calls.filter(call => call.action === 'follow.list').length, 1);
  assert.equal(page.data.liveSync.state, 'waiting');
  page.onUnload();
});
