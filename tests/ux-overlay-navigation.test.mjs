import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

test('closing the keyboard inside redemption cannot expose or activate bottom navigation', () => {
  const rt = runtime();
  let keyboard, switches = 0;
  rt.wx.onKeyboardHeightChange = listener => { keyboard = listener; };
  rt.wx.offKeyboardHeightChange = () => {};
  rt.wx.switchTab = () => { switches += 1; };
  const bar = rt.instance('custom-tab-bar/index.js');
  bar.lifetimes.attached.call(bar);
  const mine = rt.instance('pages/mine/index.js');
  mine.getTabBar = () => bar;
  mine.onOpenRedemption();
  keyboard({ height: 300 });
  keyboard({ height: 0 });
  bar.syncRoute('/pages/mine/index');
  assert.equal(bar.data.sheetHidden, true);
  assert.equal(bar.onTabTap({ currentTarget: { dataset: { index: 1 } } }), false);
  assert.equal(switches, 0);
  mine.onOpenRedemption();
  assert.equal(bar.data.sheetHidden, false);
  bar.onTabTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(switches, 1);
  bar.lifetimes.detached.call(bar);
});

test('leaving or disposing a redemption page releases its navigation overlay', () => {
  for (const action of ['onHide', 'onUnload']) {
    const rt = runtime();
    const mine = rt.instance('pages/mine/index.js');
    const bar = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
    mine.getTabBar = () => bar;
    mine.onOpenRedemption();
    assert.equal(bar.data.sheetHidden, true);
    mine[action]();
    assert.equal(bar.data.sheetHidden, false);
  }
});

test('a tab bar mounted after a sheet opened is hidden before its first tap', () => {
  for (const field of ['sheetVisible', 'editing', 'redemptionOpen']) {
    const page = { route: 'pages/query/index', data: { [field]: true } };
    const rt = runtime(undefined, { getCurrentPages: () => [page] });
    const bar = rt.instance('custom-tab-bar/index.js');
    bar.lifetimes.attached.call(bar);
    assert.equal(bar.data.sheetHidden, true, field);
    assert.equal(bar.onTabTap({ currentTarget: { dataset: { index: 1 } } }), false);
    page.data[field] = false;
    bar.pageLifetimes.show.call(bar);
    assert.equal(bar.data.sheetHidden, false, field);
    bar.lifetimes.detached.call(bar);
  }
});

test('closing a sheet releases its late-mounted bar without touching another page', () => {
  let bar = null;
  const page = { route: 'pages/query/index', data: { sheetVisible: true }, getTabBar: () => bar };
  let currentPage = page;
  const rt = runtime(undefined, { getCurrentPages: () => [currentPage] });
  const sheet = rt.instance('components/config-sheet/index.js', { visible: true });
  sheet.onVisible(true);
  bar = rt.instance('custom-tab-bar/index.js');
  bar.lifetimes.attached.call(bar);
  assert.equal(bar.data.sheetHidden, true);
  const otherBar = { data: { sheetHidden: true }, setData(patch) { Object.assign(this.data, patch); } };
  currentPage = { data: { editing: true }, getTabBar: () => otherBar };
  page.data.sheetVisible = false;
  sheet.data.visible = false;
  sheet.onVisible(false);
  assert.equal(bar.data.sheetHidden, false);
  assert.equal(otherBar.data.sheetHidden, true);
  sheet.lifetimes.detached.call(sheet);
  assert.equal(otherBar.data.sheetHidden, true);
  bar.lifetimes.detached.call(bar);
});
