import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const routes = ['pages/query/index', 'pages/follow/index', 'pages/history/index', 'pages/mine/index'];
const tap = index => ({ currentTarget: { dataset: { index } } });
const copy = value => JSON.parse(JSON.stringify(value));

function navigationRuntime(initialRoute = routes[0]) {
  const stack = [{ route: initialRoute }];
  const rt = runtime(undefined, { getCurrentPages: () => stack });
  const switches = [], keyboardListeners = new Set(), removedListeners = [];
  rt.wx.switchTab = options => { switches.push(options); };
  rt.wx.onKeyboardHeightChange = listener => keyboardListeners.add(listener);
  rt.wx.offKeyboardHeightChange = listener => { removedListeners.push(listener); keyboardListeners.delete(listener); };
  const template = rt.instance('custom-tab-bar/index.js');
  const bars = [];
  function makeBar() {
    const bar = { ...template, data: copy(template.data), writes: [] };
    bar.setData = patch => { bar.writes.push(copy(patch)); Object.assign(bar.data, patch); };
    bar.lifetimes.attached.call(bar);
    bars.push(bar);
    return bar;
  }
  function setRoute(route) { stack.splice(0, stack.length, { route }); }
  function keyboard(height) { for (const listener of keyboardListeners) listener({ height }); }
  return { rt, switches, keyboardListeners, removedListeners, makeBar, setRoute, keyboard, stack, bars };
}

test('each cold tab selects its actual route before account and catalog loading can finish', async () => {
  for (let index = 0; index < routes.length; index += 1) {
    const h = navigationRuntime(routes[index]);
    const bar = h.makeBar();
    assert.equal(bar.data.selected, index, 'attached must also cover getTabBar not yet existing during page.onShow');
    bar.setData({ selected: (index + 1) % routes.length });
    const page = h.rt.instance(`${routes[index]}.js`);
    page.getTabBar = () => bar;
    assert.equal(page.data.ready, false);
    await page.onShow();
    assert.equal(bar.data.selected, index, 'onShow must sync before the page readiness guard');
    assert.equal(h.rt.calls.length, 0, 'navigation selection must not wait for or initiate cloud calls');
  }
});

test('a late mounted tab bar recovers the page selection when onShow ran before getTabBar existed', async () => {
  for (let index = 0; index < routes.length; index += 1) {
    const h = navigationRuntime(routes[index]);
    h.stack.length = 0;
    const page = h.rt.instance(`${routes[index]}.js`);
    page.getTabBar = () => null;
    await page.onShow();
    const bar = h.makeBar();
    assert.equal(bar.data.selected, index, 'the route confirmed by the page must survive delayed component attachment');
  }
});

test('cached pages recover selection after real programmatic query, history and mine navigation', async () => {
  const h = navigationRuntime();
  const bars = routes.map(() => h.makeBar());
  const pages = routes.map((route, index) => {
    const page = h.rt.instance(`${route}.js`);
    page.getTabBar = () => bars[index];
    return page;
  });
  pages[0].setData({ boot: { member: true }, selection: { partNumber: 'SKU-A', product: { supported: true }, storeNumbers: ['R001'] } });
  pages[0].onFollowSelection();
  assert.equal(h.switches.at(-1).url, '/pages/follow/index');
  assert.deepEqual(copy(h.rt.app.globalData.pendingFollow), { partNumber: 'SKU-A', storeNumbers: ['R001'] });
  // The follow editor uses catalog data after boot. Keep this test about the
  // navigation lifecycle, rather than constructing a catalog solely to open it.
  h.rt.app.globalData.pendingFollow = null;
  for (const [source, action, target] of [[1, 'onGoMine', 3], [3, 'onGoHistory', 2], [2, 'onGoMine', 3]]) {
    h.setRoute(routes[source]);
    pages[source][action]();
    assert.equal(h.switches.at(-1).url, `/${routes[target]}`);
    bars[target].setData({ selected: source });
    h.setRoute(routes[target]);
    await pages[target].onShow();
    assert.equal(bars[target].data.selected, target, 'the destination instance must not retain another tab selection');
  }
});

test('rapid taps share one navigation and select only the page that actually becomes visible', () => {
  const h = navigationRuntime(), source = h.makeBar(), other = h.makeBar();
  source.onTabTap(tap('1'));
  source.onTabTap(tap(2));
  other.onTabTap(tap(3));
  assert.equal(h.switches.length, 1, 'separate tab-bar instances must not issue competing switches');
  assert.equal(source.data.selected, 0, 'the source page must not show a destination selection before navigation succeeds');
  source.pageLifetimes.hide.call(source);
  h.setRoute(routes[1]);
  other.pageLifetimes.show.call(other);
  assert.equal(other.data.selected, 1);
  h.switches[0].success?.({});
  h.switches[0].complete?.({});
  other.onTabTap(tap(1));
  assert.equal(h.switches.length, 1, 'tapping the current tab does not reload it or re-run its rewards');
  other.onTabTap(tap(2));
  assert.equal(h.switches.length, 2, 'the next navigation is available after completion');
});

test('a failed navigation preserves the current tab and permits a retry', () => {
  const h = navigationRuntime(), bar = h.makeBar();
  bar.onTabTap(tap(2));
  const failed = h.switches[0];
  failed.fail?.({ errMsg: 'switchTab:fail interrupted' });
  failed.complete?.({ errMsg: 'switchTab:fail interrupted' });
  assert.equal(bar.data.selected, 0);
  assert.equal(h.rt.messages.length, 1, 'a failed tap must give the user a retry cue');
  bar.onTabTap(tap(2));
  assert.equal(h.switches.length, 2);
  // A late callback from the failed attempt must not release a newer attempt.
  failed.complete?.({});
  bar.onTabTap(tap(3));
  assert.equal(h.switches.length, 2);
  h.switches[1].fail?.({ errMsg: 'switchTab:fail interrupted again' });
  h.switches[1].complete?.({});
  bar.onTabTap(tap(3));
  assert.equal(h.switches.length, 3);
});

test('arrival at the real destination permits the next tap before the previous native completion callback', async () => {
  const h = navigationRuntime(), source = h.makeBar(), destination = h.makeBar();
  source.onTabTap(tap(1));
  const first = h.switches[0];
  h.setRoute(routes[1]);
  const page = h.rt.instance('pages/follow/index.js');
  page.getTabBar = () => destination;
  await page.onShow();
  assert.equal(destination.data.selected, 1);
  destination.onTabTap(tap(2));
  assert.equal(h.switches.length, 2, 'the newly visible page must not feel unresponsive while an old completion is delayed');
  first.complete?.({});
  destination.onTabTap(tap(3));
  assert.equal(h.switches.length, 2, 'the old completion must not release a newer in-flight navigation');
});

test('a synchronous switchTab exception releases navigation so the user can retry', () => {
  const h = navigationRuntime(), bar = h.makeBar();
  h.rt.wx.switchTab = () => { throw new Error('native bridge unavailable'); };
  assert.doesNotThrow(() => bar.onTabTap(tap(1)));
  assert.equal(bar.data.selected, 0);
  h.rt.wx.switchTab = options => h.switches.push(options);
  bar.onTabTap(tap(1));
  assert.equal(h.switches.length, 1);
});

test('keyboard hides only the visible bar and returning to a cached tab restores it', () => {
  const h = navigationRuntime(), first = h.makeBar(), second = h.makeBar();
  second.pageLifetimes.hide.call(second);
  const hiddenWrites = second.writes.length;
  h.keyboard(320);
  assert.equal(first.data.keyboardHidden, true, 'navigation must not obstruct the city search or redemption keyboard');
  assert.equal(second.writes.length, hiddenWrites, 'hidden cached pages must not react to another page keyboard');
  h.keyboard(0);
  assert.equal(first.data.keyboardHidden, false);
  h.keyboard(280);
  first.pageLifetimes.hide.call(first);
  h.setRoute(routes[3]);
  second.pageLifetimes.show.call(second);
  assert.equal(second.data.keyboardHidden, false);
  assert.equal(second.data.selected, 3);
  h.setRoute(routes[0]);
  first.pageLifetimes.show.call(first);
  assert.equal(first.data.keyboardHidden, false, 'a previously visible keyboard must not leave a returning tab bar missing');
});

test('detaching releases the keyboard listener and late native callbacks never write to that bar', () => {
  const h = navigationRuntime(), bar = h.makeBar();
  const listener = [...h.keyboardListeners][0];
  assert.equal(typeof listener, 'function');
  bar.onTabTap(tap(1));
  bar.lifetimes.detached.call(bar);
  const writesAtDetach = bar.writes.length;
  assert.equal(h.keyboardListeners.size, 0);
  assert.ok(h.removedListeners.includes(listener), 'offKeyboardHeightChange must use the registered listener identity');
  listener({ height: 300 });
  h.switches[0].fail?.({ errMsg: 'switchTab:fail page removed' });
  h.switches[0].complete?.({});
  assert.equal(bar.writes.length, writesAtDetach);
  const replacement = h.makeBar();
  replacement.onTabTap(tap(2));
  assert.equal(h.switches.length, 2, 'retired navigation must not leave the replacement instance locked');
});

test('unexpected gesture datasets cannot navigate outside the configured tabs', () => {
  for (const route of [routes[0], routes[3]]) {
    const h = navigationRuntime(route), bar = h.makeBar();
    for (const index of [-1, 4, 1.5, 'missing', undefined, null, '', false, [], {}]) bar.onTabTap(tap(index));
    assert.equal(h.switches.length, 0, 'missing or malformed button data must not be coerced into the query tab');
    assert.equal(bar.data.selected, routes.indexOf(route));
  }
});
