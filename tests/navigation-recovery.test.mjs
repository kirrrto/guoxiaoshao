import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

test('guide navigation shares the tab lock and rapid taps cannot open duplicate pages', () => {
  const rt = runtime(), requests = [];
  rt.wx.navigateTo = options => requests.push(options);
  rt.wx.switchTab = options => requests.push(options);
  const guide = rt.instance('pages/guide/index.js');
  guide.onTestNotification(); guide.onTestNotification();
  rt.load('utils/tab-bar.js').switchToTab({ url: '/pages/query/index' });
  assert.equal(requests.length, 1, 'all page and tab navigation must share one pending operation');
});

test('a native guide navigation failure has an explicit handler and permits an intentional retry', () => {
  const rt = runtime(), requests = [];
  rt.wx.navigateTo = options => requests.push(options);
  const guide = rt.instance('pages/guide/index.js');
  guide.onTestNotification();
  assert.equal(typeof requests[0].fail, 'function');
  requests[0].fail({ errMsg: 'navigateTo:fail too early' });
  requests[0].complete({ errMsg: 'navigateTo:fail too early' });
  assert.equal(rt.messages.length, 1);
  guide.onTestNotification();
  assert.equal(requests.length, 2);
});

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

for (const outcome of ['success', 'fail']) {
  test(`native ${outcome} callbacks and a returned Promise settle caller callbacks only once`, async () => {
    const rt = runtime(), seen = [], warnings = [];
    rt.wx.getRealtimeLogManager = () => ({ warn: (...args) => warnings.push(args) });
    const result = { errMsg: `navigateTo:${outcome === 'success' ? 'ok' : 'fail too early'}` };
    rt.wx.navigateTo = options => {
      options[outcome](result); options.complete(result);
      return outcome === 'success' ? Promise.resolve(result) : Promise.reject(result);
    };
    const nav = rt.load('utils/navigation.js');
    assert.equal(nav.navigateTo({ url: '/pages/guide/index',
      success: () => seen.push('success'), fail: () => seen.push('fail'), complete: () => seen.push('complete') }), true);
    await settle();
    assert.deepEqual(seen, [outcome, 'complete']);
    assert.equal(nav.isNavigating(), false);
    assert.equal(warnings.length, outcome === 'fail' ? 1 : 0);
  });
}

test('a Promise-only bridge rejection is handled, records safe context and never auto-navigates', async () => {
  const rt = runtime(undefined, { getCurrentPages: () => [{ route: 'pages/mine/index?account=private-account' }] });
  const warnings = []; let calls = 0;
  const url = '/pages/notification-test/index?requestId=private-request&from=mine';
  rt.wx.getRealtimeLogManager = () => ({ warn: (...args) => warnings.push(args) });
  rt.wx.navigateTo = () => { calls++; return Promise.reject({ errno: 4, errCode: -123, errMsg: `navigateTo:fail too early url: ${url}` }); };
  const nav = rt.load('utils/navigation.js');
  nav.navigateTo({ url }); await settle();
  assert.equal(calls, 1);
  assert.equal(rt.timers.size, 0, 'navigation failures require an intentional retry');
  assert.equal(nav.isNavigating(), false);
  assert.equal(rt.messages.length, 1);
  assert.equal(warnings[0][0], '[gxs] navigation_failure');
  assert.equal(warnings[0][1].errno, 4);
  assert.equal(warnings[0][1].errCode, -123);
  assert.match(warnings[0][1].errMsg, /too early/);
  assert.doesNotMatch(JSON.stringify([warnings, nav.getNavigationContext()]), /private-request|private-account|requestId|account=/);
  const context = nav.getNavigationContext();
  assert.equal(context.method, 'navigateTo');
  assert.equal(context.from, 'pages/mine/index');
  assert.equal(context.to, 'pages/notification-test/index');
  assert.equal(context.state, 'failed');
  assert.equal(context.version, rt.load('config/version.js').VERSION);
  context.state = 'tampered';
  assert.equal(nav.getNavigationContext().state, 'failed', 'diagnostic consumers cannot mutate navigation state');
});

test('destination arrival unlocks navigation and late old completion cannot release a newer request', () => {
  const rt = runtime(), requests = [];
  rt.wx.navigateTo = options => requests.push(options);
  rt.wx.switchTab = options => requests.push(options);
  const nav = rt.load('utils/navigation.js');
  nav.navigateTo({ url: '/pages/guide/index?section=prepare' });
  rt.instance('pages/guide/index.js').onShow();
  assert.equal(nav.getNavigationContext().state, 'arrived');
  assert.equal(nav.switchTab({ url: '/pages/mine/index' }), true);
  requests[0].complete({ errMsg: 'navigateTo:ok' });
  assert.equal(nav.navigateTo({ url: '/pages/notification-test/index' }), false);
  assert.equal(nav.getNavigationContext().to, 'pages/mine/index');
  requests[1].complete({ errMsg: 'switchTab:ok' });
  assert.equal(nav.navigateTo({ url: '/pages/notification-test/index' }), true);
});

test('caller cleanup exceptions remain errors and cannot strand the navigation lock', () => {
  const rt = runtime(), records = [];
  rt.app.reportError = (...args) => records.push(args);
  rt.wx.navigateTo = options => { options.fail({ errMsg: 'native failure' }); options.complete({}); };
  const nav = rt.load('utils/navigation.js');
  nav.navigateTo({ url: '/pages/guide/index', fail: () => { throw Error('business cleanup failure'); } });
  assert.equal(records.length, 1);
  assert.equal(records[0][0], 'navigation_callback');
  assert.match(records[0][1].message, /business cleanup failure/);
  assert.equal(nav.isNavigating(), false);
});

test('an in-flight guide destination retains its intended section when another shortcut is tapped', () => {
  const rt = runtime(), requests = [];
  rt.wx.switchTab = options => requests.push(options);
  const page = rt.instance('pages/guide/index.js');
  page.onCheckReminders(); page.onGoMine();
  assert.equal(requests.length, 1);
  assert.equal(rt.app.globalData.pendingMineSection, 'reminder-center');
  requests[0].complete({});
  page.onGoMine();
  assert.equal(requests.length, 2);
  assert.equal(rt.app.globalData.pendingMineSection, 'membership-card');
});

test('the original notification-test return survives blocked or failed navigation and clears only on success', () => {
  const rt = runtime(), requests = [];
  rt.app.globalData.bootstrap = { identity: { userKey: 'alice' } };
  rt.wx.navigateTo = options => requests.push(options);
  const journey = rt.load('utils/journey-context.js'), nav = rt.load('utils/navigation.js');
  journey.stageTestReturn({ from: 'follow', requestId: 'test-original-001', ownerUserKey: 'alice' });
  const mine = rt.instance('pages/mine/index.js');
  mine.setData({ testReturnAvailable: true });
  nav.navigateTo({ url: '/pages/guide/index' });
  mine.onReturnToTest();
  assert.equal(requests.length, 1);
  assert.equal(journey.peekTestReturn().requestId, 'test-original-001');
  assert.equal(mine.data.testReturnAvailable, true);
  requests[0].complete({});
  mine.onReturnToTest();
  requests[1].fail({ errMsg: 'navigateTo:fail too early' }); requests[1].complete({});
  assert.equal(journey.peekTestReturn().requestId, 'test-original-001');
  assert.equal(mine.data.testReturnAvailable, true);
  mine.onReturnToTest();
  assert.match(requests[2].url, /requestId=test-original-001/);
  requests[2].success({}); requests[2].complete({});
  assert.equal(journey.peekTestReturn(), null);
  assert.equal(mine.data.testReturnAvailable, false);
});

test('a late return navigation success cannot consume a newer return intent for the same URL', () => {
  const rt = runtime(), requests = [];
  rt.app.globalData.bootstrap = { identity: { userKey: 'alice' } };
  rt.wx.navigateTo = options => requests.push(options);
  rt.wx.switchTab = options => requests.push(options);
  const journey = rt.load('utils/journey-context.js'), nav = rt.load('utils/navigation.js');
  journey.stageTestReturn({ from: 'follow', requestId: 'test-original-001', ownerUserKey: 'alice' });
  const originalGeneration = journey.peekTestReturn().generation;
  const mine = rt.instance('pages/mine/index.js');
  mine.setData({ testReturnAvailable: true });
  mine.onReturnToTest();
  nav.confirmNavigation('pages/notification-test/index');
  const notification = rt.instance('pages/notification-test/index.js');
  notification.userKey = 'alice'; notification.accountEpoch = 0; notification.returnSource = 'follow';
  notification.setData({ loading: false, test: { requestId: 'test-original-001' } });
  notification.onGoMine();
  const newer = journey.peekTestReturn();
  assert.notEqual(newer.generation, originalGeneration);
  assert.equal(journey.peekTestReturnUrl(), requests[0].url, 'the renewed intent has the same destination and request ID');
  requests[0].success({ errMsg: 'navigateTo:ok' }); requests[0].complete({ errMsg: 'navigateTo:ok' });
  assert.equal(journey.peekTestReturn().generation, newer.generation);
  assert.equal(mine.data.testReturnAvailable, true);
  assert.equal(nav.isNavigating(), true, 'the newer return-to-Mine navigation remains pending');
});

test('all native navigation methods share one operation and synchronous failures allow retry', () => {
  const stack = [{ route: 'pages/query/index' }, { route: 'pages/guide/index' }];
  const rt = runtime(undefined, { getCurrentPages: () => stack }), requests = [];
  for (const method of ['navigateTo', 'navigateBack', 'switchTab', 'reLaunch']) rt.wx[method] = options => requests.push({ method, options });
  const nav = rt.load('utils/navigation.js');
  nav.navigateBack({ delta: 1 });
  assert.equal(nav.getNavigationContext().to, 'pages/query/index');
  for (const method of ['navigateTo', 'switchTab', 'reLaunch']) assert.equal(nav[method]({ url: '/pages/mine/index' }), false);
  requests[0].options.complete({});
  rt.wx.reLaunch = () => { throw Error('reLaunch:fail too early'); };
  assert.equal(nav.reLaunch({ url: '/pages/query/index' }), false);
  assert.equal(nav.isNavigating(), false);
  assert.equal(nav.navigateTo({ url: '/pages/mine/index' }), true);
});

test('a native tab visibility callback plus rejected Promise schedules only one recovery and retains its API name', async () => {
  const rt = runtime(), warnings = []; let calls = 0;
  rt.wx.getRealtimeLogManager = () => ({ warn: (...args) => warnings.push(args) });
  rt.wx.hideTabBar = options => {
    calls++;
    const error = { errno: 4, errCode: Number.NaN, errMsg: 'hideTabBar:fail too early' };
    options.fail(error); options.complete(error);
    return Promise.reject(error);
  };
  const tabs = rt.load('utils/tab-bar.js');
  const page = { route: 'pages/query/index', data: {}, setData(patch) { Object.assign(this.data, patch); } };
  tabs.syncTabBar(page, page.route);
  tabs.setTabBarOverlay(page, true);
  await settle();
  assert.equal(calls, 1);
  assert.equal(rt.timers.size, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '[gxs] native_tab_bar_failure');
  assert.equal(warnings[0][1].method, 'hideTabBar');
  assert.equal(warnings[0][1].errno, 4);
  assert.equal(Object.prototype.hasOwnProperty.call(warnings[0][1], 'errCode'), false, 'non-finite codes are omitted');
  assert.match(warnings[0][1].errMsg, /too early/);
  rt.wx.hideTabBar = () => { calls++; return Promise.resolve({ errMsg: 'hideTabBar:ok' }); };
  await rt.nextTimer(); await settle();
  assert.equal(calls, 2);
  assert.equal(rt.timers.size, 0);
  tabs.setTabBarOverlay(page, true);
  assert.equal(calls, 2, 'the Promise-only success confirms visibility');
});
