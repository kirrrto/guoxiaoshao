import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { nativeTabBar } from './helpers/native-tab-bar.mjs';

const routes = ['pages/query/index', 'pages/follow/index', 'pages/history/index', 'pages/mine/index'];
function navigationRuntime(initialRoute = routes[0], options = {}) {
  const stack = [{ route: initialRoute }], switches = [];
  const rt = runtime(undefined, { getCurrentPages: () => stack });
  const native = nativeTabBar(rt, options), tabs = rt.load('utils/tab-bar.js');
  rt.wx.switchTab = options => switches.push(options);
  const makePage = (index = 0) => ({ route: routes[index], data: { networkOffline: false }, setData(patch) { Object.assign(this.data, patch); } });
  const show = page => { stack.splice(0, stack.length, page); tabs.syncTabBar(page, page.route); };
  return { rt, native, tabs, switches, stack, show, makePage };
}

test('the four routes and themed icons are registered with the native tab bar only', () => {
  const app = JSON.parse(fs.readFileSync(new URL('../miniprogram/app.json', import.meta.url)));
  assert.notEqual(app.tabBar.custom, true);
  assert.deepEqual(app.tabBar.list.map(tab => tab.pagePath), routes);
  assert.deepEqual(app.tabBar.list.map(tab => tab.text), ['查询', '小哨', '历史', '我的']);
  for (const tab of app.tabBar.list) for (const name of ['iconPath', 'selectedIconPath'])
    assert.ok(fs.existsSync(new URL(`../miniprogram/${tab[name]}`, import.meta.url)));
  assert.equal(fs.existsSync(new URL('../miniprogram/custom-tab-bar', import.meta.url)), false,
    'a page-specific custom component must not be included in the package');
});

test('each cold tab confirms its route without loading or hiding the native bar', async () => {
  for (let index = 0; index < routes.length; index++) {
    const h = navigationRuntime(routes[index]);
    const page = h.rt.instance(`${routes[index]}.js`);
    h.stack.splice(0, 1, { ...page, route: routes[index] });
    assert.equal(page.data.ready, false);
    await page.onShow();
    h.stack.length = 0;
    assert.equal(h.tabs.getCurrentTabPath(), `/${routes[index]}`);
    assert.equal(h.native.commands.length, 0, 'first selection does not rebuild or toggle navigation');
    assert.equal(h.rt.calls.length, 0, 'navigation does not depend on cloud loading');
  }
});

test('programmatic navigation deduplicates rapid taps and current-route selections', () => {
  const h = navigationRuntime(), source = h.makePage(), next = h.makePage(1);
  h.show(source);
  assert.equal(h.tabs.navigateToTab(source, 1), true);
  assert.equal(h.tabs.navigateToTab(source, 2), false);
  assert.equal(h.tabs.navigateToTab(next, 3), false);
  assert.equal(h.switches.length, 1);
  assert.equal(h.tabs.getCurrentTabPath(), `/${routes[0]}`);
  h.show(next);
  assert.equal(h.tabs.navigateToTab(next, 1), false);
  assert.equal(h.tabs.navigateToTab(next, 2), true, 'arrival releases the old navigation before its native completion');
  h.switches[0].complete({});
  assert.equal(h.tabs.navigateToTab(next, 3), false, 'a late old completion cannot release a newer navigation');
  h.switches[1].complete({});
  assert.equal(h.tabs.navigateToTab(next, 3), true);
});

test('failed navigation keeps the confirmed route and releases the lock for retry', () => {
  const h = navigationRuntime(), page = h.makePage(); h.show(page);
  h.tabs.navigateToTab(page, 2);
  h.switches[0].fail({}); h.switches[0].complete({});
  assert.equal(h.tabs.getCurrentTabPath(), `/${routes[0]}`);
  assert.equal(h.rt.messages.length, 1);
  assert.equal(h.tabs.navigateToTab(page, 2), true);
  h.switches[0].complete({});
  assert.equal(h.tabs.navigateToTab(page, 3), false);
});

test('real page navigation retains intent and caller failure cleanup while suppressing duplicate switches', () => {
  const h = navigationRuntime(routes[1]);
  const page = h.rt.instance('pages/follow/index.js');
  page.route = routes[1]; h.show(page);
  page.setData({ follows: [{ followId: 'saved-1', partNumber: 'SKU-1', stores: [{ storeNumber: 'R001' }] }] });
  const event = { currentTarget: { dataset: { id: 'saved-1' } } };
  page.onQueryFollow(event); page.onQueryFollow(event);
  assert.equal(h.switches.length, 1);
  assert.equal(h.rt.app.globalData.pendingSharedTarget.partNumber, 'SKU-1');
  // Use the surviving target: the repeated entry must not replace the first
  // pending intent, or its failure callback can no longer clean it up.
  h.switches[0].fail({ errMsg: 'native failure' }); h.switches[0].complete({});
  assert.equal(h.rt.app.globalData.pendingSharedTarget, null);
  assert.equal(h.rt.messages.length, 1);
  page.onQueryFollow(event); assert.equal(h.switches.length, 2);
});

test('explicit programmatic navigation retains success and completion callbacks', () => {
  const h = navigationRuntime(), page = h.makePage(), seen = []; h.show(page);
  assert.equal(h.tabs.switchToTab({ url: '/pages/history/index', success: result => seen.push(['success', result]),
    complete: result => seen.push(['complete', result]) }), true);
  const result = { errMsg: 'switchTab:ok' };
  h.switches[0].success(result); h.switches[0].complete(result);
  assert.deepEqual(seen, [['success', result], ['complete', result]]);
});

test('a synchronous bridge exception permits retry and malformed indices cannot navigate', () => {
  const h = navigationRuntime(routes[3]), page = h.makePage(3); h.show(page);
  for (const index of [-1, 4, 1.5, 'missing', undefined, null, '', false, [], {}])
    assert.equal(h.tabs.navigateToTab(page, index), false);
  h.rt.wx.switchTab = () => { throw Error('bridge unavailable'); };
  assert.equal(h.tabs.navigateToTab(page, 1), false);
  h.rt.wx.switchTab = options => h.switches.push(options);
  assert.equal(h.tabs.navigateToTab(page, '1'), true);
  assert.equal(h.switches.length, 1);
});

test('keyboard close cannot expose a native bar while any overlay owner remains', () => {
  const h = navigationRuntime(), page = h.makePage(); h.show(page);
  h.tabs.setTabBarOverlay(page, true, 'sheet');
  h.tabs.setTabBarOverlay(page, true, 'redemption');
  h.native.keyboard(320); h.native.keyboard(0);
  h.tabs.setTabBarOverlay(page, false, 'sheet');
  assert.equal(h.native.hidden, true);
  assert.equal(h.tabs.navigateToTab(page, 1), false);
  h.tabs.setTabBarOverlay(page, false, 'redemption');
  assert.equal(h.native.hidden, false);
  assert.deepEqual(h.native.commands.map(c => c.method), ['hideTabBar', 'showTabBar']);
  assert.ok(h.native.commands.every(c => c.options.animation === false));
});

test('hide and show are serialized so late native completion cannot leave navigation hidden', () => {
  const h = navigationRuntime(routes[0], { deferred: true }), page = h.makePage(); h.show(page);
  h.tabs.setTabBarOverlay(page, true);
  h.tabs.setTabBarOverlay(page, false);
  assert.equal(h.native.commands.length, 1);
  h.native.commands[0].finish();
  assert.equal(h.native.commands.length, 2);
  h.native.commands[1].finish();
  assert.equal(h.native.hidden, false);
});

test('a failed native hide retries without a new gesture and a failed show restores navigation', async () => {
  const h = navigationRuntime(routes[0], { deferred: true }), page = h.makePage(); h.show(page);
  h.tabs.setTabBarOverlay(page, true);
  h.native.commands[0].finish(false);
  assert.equal([...h.rt.timers.values()][0].ms, 120);
  await h.rt.nextTimer();
  assert.equal(h.native.commands[1].method, 'hideTabBar');
  h.native.commands[1].finish(); assert.equal(h.native.hidden, true);
  h.tabs.setTabBarOverlay(page, false);
  h.native.commands[2].finish(false);
  assert.equal(h.native.hidden, true, 'the native bar stays hidden while the failed show is pending retry');
  await h.rt.nextTimer();
  assert.equal(h.native.commands[3].method, 'showTabBar');
  h.native.commands[3].finish();
  assert.equal(h.native.hidden, false);
  assert.equal(h.rt.timers.size, 0);
});

test('persistent bridge failures stop after two delayed retries and repeated events cannot bypass backoff', async () => {
  for (const hidden of [true, false]) {
    const h = navigationRuntime(routes[0], { deferred: true }), page = h.makePage(); h.show(page);
    if (!hidden) { h.tabs.setTabBarOverlay(page, true); h.native.commands[0].finish(); }
    const start = h.native.commands.length;
    h.tabs.setTabBarOverlay(page, hidden);
    for (let attempt = 0; attempt < 3; attempt++) {
      h.native.commands.at(-1).finish(false);
      h.tabs.setTabBarOverlay(page, hidden); h.native.keyboard(0);
      assert.equal(h.native.commands.length, start + attempt + 1);
      assert.equal(await h.rt.nextTimer(), attempt < 2);
    }
    assert.equal(h.rt.timers.size, 0);
    assert.equal(h.native.commands.length, start + 3);
  }
});

test('a new show intention cancels a pending hide retry, including an already queued old timer', () => {
  const h = navigationRuntime(routes[0], { deferred: true }), page = h.makePage(); h.show(page);
  h.tabs.setTabBarOverlay(page, true); h.native.commands[0].finish(false);
  const staleRetry = [...h.rt.timers.values()][0].fn;
  h.tabs.setTabBarOverlay(page, false);
  assert.equal(h.rt.timers.size, 0);
  assert.equal(h.native.commands.at(-1).method, 'showTabBar');
  h.native.commands.at(-1).finish(); staleRetry();
  assert.equal(h.native.commands.length, 2);
  assert.equal(h.native.hidden, false);
});

test('a retry owned by a previous page cannot hide navigation on the new page', () => {
  const h = navigationRuntime(routes[0], { deferred: true }), first = h.makePage(), next = h.makePage(1); h.show(first);
  h.tabs.setTabBarOverlay(first, true); h.native.commands[0].finish(false);
  const staleRetry = [...h.rt.timers.values()][0].fn;
  h.show(next);
  h.native.commands.at(-1).finish(); staleRetry();
  assert.deepEqual(h.native.commands.map(command => command.method), ['hideTabBar', 'showTabBar']);
  assert.equal(h.native.hidden, false);
  h.tabs.setTabBarOverlay(first, false);
  assert.equal(h.native.commands.length, 2);
});

test('page hide releases listeners; late keyboard callbacks and old sheets cannot affect the next page', () => {
  const h = navigationRuntime(), first = h.makePage(), next = h.makePage(1); h.show(first);
  const oldListener = [...h.native.keyboardListeners][0];
  h.native.keyboard(300); assert.equal(h.native.hidden, true);
  h.tabs.releaseTabBar(first);
  assert.equal(h.native.keyboardListeners.size, 0);
  h.show(next); h.tabs.setTabBarOverlay(next, true, 'editor');
  h.tabs.setTabBarOverlay(first, false); oldListener({ height: 0 });
  assert.equal(h.native.hidden, true);
  h.tabs.setTabBarOverlay(next, false, 'editor');
  assert.equal(h.native.hidden, false);
  h.show(first); assert.equal(h.native.hidden, false);
  assert.equal(h.native.keyboardListeners.size, 1);
});

test('returning to a cached page restores an already-open overlay before navigation can run', () => {
  for (const field of ['sheetVisible', 'editing', 'redemptionOpen', 'calendarOpen', 'authorizationOpen']) {
    const h = navigationRuntime(), page = h.makePage(); page.data[field] = true; h.show(page);
    assert.equal(h.native.hidden, true, field);
    assert.equal(h.tabs.navigateToTab(page, 1), false);
    page.data[field] = false; h.show(page);
    assert.equal(h.native.hidden, false, field);
  }
});
