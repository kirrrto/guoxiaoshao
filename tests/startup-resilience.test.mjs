import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const boot = () => ({ membership: { active: false }, quota: { balance: 1, queryCost: 1, signedInToday: true },
  limits: { queryMaxStores: 3 }, collector: { state: 'running' }, followCount: 0 });

/** Real api.js over a scripted cloud: each callFunction takes the next outcome. */
function cloudRuntime(outcomes) {
  const rt = runtime(undefined, { realApi: true }), calls = [];
  rt.load('app.js');
  rt.app.ensureCloud = async () => ({ callFunction: async ({ data }) => {
    calls.push(data.action);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return { result: { ok: true, data: next } };
  } });
  return { rt, api: rt.load('utils/api.js'), calls };
}

test('a dropped connection on a read retries once; writes and business errors never repeat', async () => {
  const { rt, api, calls } = cloudRuntime([Object.assign(Error('x'), { errMsg: 'cloud.callFunction:fail request:fail' }), { hello: 1 }]);
  const pending = api.call('user.bootstrap');
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(await rt.nextTimer(), true, 'the retry waits briefly instead of hammering the network');
  assert.deepEqual(await pending, { hello: 1 });
  assert.deepEqual(calls, ['user.bootstrap', 'user.bootstrap']);

  const write = cloudRuntime([Object.assign(Error('x'), { errMsg: 'cloud.callFunction:fail request:fail' })]);
  await assert.rejects(write.api.call('query.pickup', { queryId: 'q-1' }), error => error.code === 'call_failed' && /网络连接不稳定/.test(error.message));
  assert.equal(write.calls.length, 1, 'a charged query is never replayed automatically');

  const business = cloudRuntime([]);
  business.rt.app.ensureCloud = async () => ({ callFunction: async () => { business.calls.push('x'); return { result: { ok: false, error: { code: 'forbidden', message: '需要管理员权限' } } }; } });
  await assert.rejects(business.api.call('user.bootstrap'), error => error.code === 'forbidden');
  assert.equal(business.calls.length, 1);
});

test('a stalled cloud connection gives up after 10 seconds and the next call starts over', async () => {
  const rt = runtime(undefined, { realApi: true });
  rt.load('app.js');
  let attempts = 0;
  rt.app.initCloud = () => { attempts++; return new Promise(() => {}); };
  const first = rt.app.ensureCloud();
  assert.equal(rt.app.ensureCloud(), first, 'concurrent pages share one connection attempt');
  assert.equal([...rt.timers.values()][0].ms, 10000);
  await rt.nextTimer();
  await assert.rejects(first, /cloud_init_timeout/);
  assert.match(rt.app.globalData.cloudError, /超时/);
  await settle();
  rt.app.ensureCloud().catch(() => {});
  assert.equal(attempts, 2);
  const api = rt.load('utils/api.js');
  rt.app.ensureCloud = async () => { throw Error('cloud_init_timeout'); };
  const failed = api.call('query.pickup', {});
  await assert.rejects(failed, error => error.code === 'cloud_init_failed' && /网络不太稳定/.test(error.message));
});

test('an unknown page opens the home tab and launches are counted for the add-to-app tip', () => {
  const rt = runtime();
  rt.load('app.js');
  const relaunch = [];
  rt.wx.reLaunch = options => relaunch.push(options.url);
  rt.app.onPageNotFound({ path: 'pages/removed/index' });
  assert.deepEqual(relaunch, ['/pages/query/index']);
  rt.app.onLaunch({ scene: 1001, query: {} });
  rt.app.onLaunch({ scene: 1001, query: {} });
  assert.equal(rt.app.globalData.launchCount, 2);
  assert.equal(rt.storage.get('gxs_launch_count_v1'), 2);
});

test('the tab bar shows an offline notice and the visible page reloads once the phone reconnects', () => {
  let reloads = 0, statusListener = null;
  const page = { onNetworkRestored: () => { reloads++; } };
  const rt = runtime(undefined, { getCurrentPages: () => [page] });
  rt.wx.getNetworkType = ({ success }) => success({ networkType: 'wifi' });
  rt.wx.onNetworkStatusChange = listener => { statusListener = listener; };
  const bar = rt.instance('custom-tab-bar/index.js');
  bar.lifetimes.attached.call(bar);
  assert.equal(bar.data.offline, false);
  statusListener({ isConnected: false });
  assert.equal(bar.data.offline, true);
  assert.equal(reloads, 0);
  statusListener({ isConnected: true });
  assert.equal(bar.data.offline, false);
  assert.equal(reloads, 1);
  statusListener({ isConnected: true });
  assert.equal(reloads, 1, 'staying online does not reload again');
  bar.pageLifetimes.hide.call(bar);
  statusListener({ isConnected: false }); statusListener({ isConnected: true });
  assert.equal(reloads, 1, 'a hidden tab page leaves the reload to the visible one');
  bar.lifetimes.detached.call(bar);
  statusListener({ isConnected: false });
  assert.equal(bar.data.offline, false, 'a detached tab bar stops listening');
});

test('pages reload their failed or unconnected parts when the network returns', async () => {
  const rt = runtime(async action => action === 'user.bootstrap' ? boot() : action === 'catalog.get' ? { unchanged: true } : {});
  const query = rt.instance('pages/query/index.js');
  query.setData({ ready: true, accountReady: false });
  query.onNetworkRestored();
  await settle();
  assert.equal(query.data.accountReady, true);
  const history = rt.instance('pages/history/index.js');
  let retried = 0;
  history.onRetryLoad = () => { retried++; };
  history.setData({ loadError: '网络连接不稳定' });
  history.onNetworkRestored();
  assert.equal(retried, 1);
});

test('from the second launch the home page suggests adding the app until the tip is closed', async () => {
  const open = async launchCount => {
    const rt = runtime(async action => action === 'user.bootstrap' ? boot() : action === 'catalog.get' ? { unchanged: true } : {});
    rt.app.globalData.launchCount = launchCount;
    return rt;
  };
  const first = await open(1);
  const page = first.instance('pages/query/index.js');
  await page.onLoad();
  assert.equal(page.data.addTipVisible, false, 'not on the very first launch');
  const second = await open(2);
  const again = second.instance('pages/query/index.js');
  await again.onLoad();
  assert.equal(again.data.addTipVisible, true);
  again.onDismissAddTip();
  assert.equal(again.data.addTipVisible, false);
  const reopened = second.instance('pages/query/index.js');
  await reopened.onLoad();
  assert.equal(reopened.data.addTipVisible, false, 'closing the tip is remembered');
  assert.equal(again.onAddToFavorites().title, '果小哨 · 门店取货查询');
});
