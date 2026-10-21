import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { nativeTabBar } from './helpers/native-tab-bar.mjs';

test('closing the keyboard inside redemption cannot expose or activate native navigation', () => {
  const rt = runtime(), native = nativeTabBar(rt), tabs = rt.load('utils/tab-bar.js');
  const mine = rt.instance('pages/mine/index.js');
  tabs.syncTabBar(mine, '/pages/mine/index');
  mine.onOpenRedemption(); native.keyboard(300); native.keyboard(0);
  assert.equal(native.hidden, true);
  assert.equal(tabs.navigateToTab(mine, 1), false);
  mine.onOpenRedemption();
  assert.equal(native.hidden, false);
  assert.equal(tabs.navigateToTab(mine, 1), true);
});

test('leaving or disposing a redemption page releases the native overlay', () => {
  for (const action of ['onHide', 'onUnload']) {
    const rt = runtime(), native = nativeTabBar(rt), mine = rt.instance('pages/mine/index.js');
    rt.load('utils/tab-bar.js').syncTabBar(mine, '/pages/mine/index');
    mine.onOpenRedemption(); assert.equal(native.hidden, true);
    mine[action](); assert.equal(native.hidden, false);
  }
});

test('closing a previous page sheet cannot expose the next page editor', async () => {
  const page = { route: 'pages/query/index', data: { sheetVisible: true }, setData(patch) { Object.assign(this.data, patch); } };
  let currentPage = page;
  const rt = runtime(undefined, { getCurrentPages: () => [currentPage] });
  const native = nativeTabBar(rt), tabs = rt.load('utils/tab-bar.js');
  tabs.syncTabBar(page, page.route);
  const sheet = rt.instance('components/config-sheet/index.js', { visible: true });
  sheet.onVisible(true); while (await rt.nextTimer()) {}
  assert.equal(native.hidden, true);
  currentPage = { route: 'pages/follow/index', data: { editing: true }, setData(patch) { Object.assign(this.data, patch); } };
  tabs.syncTabBar(currentPage, currentPage.route);
  page.data.sheetVisible = false; sheet.data.visible = false; sheet.onVisible(false);
  while (await rt.nextTimer()) {}
  assert.equal(native.hidden, true);
  sheet.lifetimes.detached.call(sheet); while (await rt.nextTimer()) {}
  assert.equal(native.hidden, true);
  currentPage.data.editing = false; tabs.setTabBarOverlay(currentPage, false);
  assert.equal(native.hidden, false);
});
