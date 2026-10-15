import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { activeCalendars, calendarView, guideNote, shouldOpenCalendar, withFollowReadiness } = require('../miniprogram/utils/launch-calendar');
const entry = require('../miniprogram/config/product-launches')[0];
const now = Date.parse('2026-10-11T08:00:00Z');
const calendar = calendarView(entry, now);

test('save-follow announcement requires current supported configurations even after the preorder date', () => {
  const catalog = { products: [
    { familyKey: entry.familyKey, supported: true, comingSoon: false },
    { familyKey: entry.familyKey, supported: true, comingSoon: false },
  ] };
  const notice = withFollowReadiness(calendar, catalog);
  assert.equal(notice.followNotice, '已支持保存关注');
  assert.match(notice.followNoticeDetail, /会员.*授权/);
  assert.equal(notice.stage, 'upcoming');
  assert.equal(notice.id, calendar.id, 'readiness does not reset the user mute preference');
  catalog.products[1].comingSoon = true;
  assert.equal(withFollowReadiness(calendar, catalog).followNotice, '部分配置已支持保存关注');
  catalog.products[0].supported = false;
  assert.equal(withFollowReadiness(calendarView(entry, Date.parse('2026-10-24T00:00:00Z')), catalog).followNotice, '');
  assert.equal(withFollowReadiness(calendar, { products: [{ familyKey: 'homepod-mini-2', supported: true }] }).followNotice, '');
  assert.equal(withFollowReadiness(calendar, null).followNoticeDetail, '');
});

test('launch dates use Monday-first Beijing calendar independent of device timezone', () => {
  assert.equal(calendar.monthText, '2026 年 10 月');
  assert.equal(calendar.cells[3].day, 1);
  assert.deepEqual(calendar.cells.filter(cell => cell.label).map(cell => [cell.day, cell.label]), [[16, '预购'], [23, '发售']]);
  assert.equal(calendar.cells.findIndex(cell => cell.day === 16) % 7, 4);
  assert.equal(calendar.cells.filter(cell => cell.today)[0].day, 11);
  assert.equal(calendarView(entry, Date.parse('2026-10-11T16:00:00Z')).cells.filter(cell => cell.today)[0].day, 12);
});

test('opening notice stops after launch day while manual calendar remains available', () => {
  assert.equal(activeCalendars(Date.parse('2026-10-23T15:59:59Z'), true).length, 1);
  assert.equal(activeCalendars(Date.parse('2026-10-23T16:00:00Z'), true).length, 0);
  assert.equal(activeCalendars(Date.parse('2026-10-24T00:00:00Z')).length, 1);
  assert.equal(activeCalendars(Date.parse(entry.displayUntil)).length, 0);
});

test('poster stage, weekdays and milestone states follow Beijing launch times without a timer', () => {
  assert.equal(calendar.preorderWeekdayText, '周五');
  assert.equal(calendar.releaseWeekdayText, '周五');
  assert.deepEqual([calendar.stage, calendar.stageText, calendar.preorderState, calendar.releaseState], ['upcoming', '距预购 5 天 4 小时', 'next', 'later']);
  const preorderAt = Date.parse(entry.preorderAt);
  assert.equal(calendarView(entry, preorderAt - 3 * 3600000).stageText, '距预购 3 小时');
  assert.equal(calendarView(entry, preorderAt - 30 * 60000).stageText, '预购即将开始');
  const preorder = calendarView(entry, preorderAt);
  assert.deepEqual([preorder.stage, preorder.stageText, preorder.preorderState, preorder.releaseState], ['preorder', '预购进行中', 'done', 'next']);
  const released = calendarView(entry, Date.parse('2026-10-22T16:00:00Z'));
  assert.deepEqual([released.stage, released.stageText, released.preorderState, released.releaseState], ['released', '已正式发售', 'done', 'done']);
});

test('guide entry note follows the launch stage and returns to generic copy after the window', () => {
  assert.equal(guideNote(now), `${entry.title} · 10.16 20:00 开启预购`);
  assert.equal(guideNote(Date.parse(entry.preorderAt)), `${entry.title} · 10.23 正式发售`);
  assert.equal(guideNote(Date.parse('2026-10-22T15:59:59Z')), `${entry.title} · 10.23 正式发售`);
  assert.equal(guideNote(Date.parse('2026-10-22T16:00:00Z')), `${entry.title} 已发售 · 查看取货攻略`);
  assert.equal(guideNote(Date.parse(entry.displayUntil)), '从选择配置，到收到提醒后下单');
});

test('frequency is once per Beijing date and dismissal applies to this launch revision', () => {
  const saved = { id: calendar.id, day: '2026-10-11', muted: false };
  assert.equal(shouldOpenCalendar(calendar, null, now), true);
  assert.equal(shouldOpenCalendar(calendar, saved, now), false);
  assert.equal(shouldOpenCalendar(calendar, saved, Date.parse('2026-10-11T16:00:00Z')), true);
  assert.equal(shouldOpenCalendar(calendar, { ...saved, muted: true }, Date.parse('2026-10-12T16:00:00Z')), false);
  assert.equal(shouldOpenCalendar({ ...calendar, id: 'updated-official-dates' }, { ...saved, muted: true }, now), true);
});

function pageRuntime() {
  const rt = runtime();
  rt.load('utils/launch-calendar.js').activeCalendars = () => [calendar];
  const page = rt.instance('pages/query/index.js');
  const bar = { data: {}, setData(value) { Object.assign(this.data, value); } };
  page.getTabBar = () => bar;
  page.visible = true;
  page.setData({ ready: true });
  return { rt, page, bar };
}

test('opening poster announces follow readiness and retracts it when the catalog changes', async () => {
  const { rt, page } = pageRuntime();
  const catalog = rt.load('utils/store.js').currentCatalog();
  page.catalog = catalog;
  page.calendarViewReady = true;
  await page.maybeOpenCalendar();
  assert.equal(page.data.openingCalendar.followNotice, '已支持保存关注');
  page.applyCatalog({ ...catalog, version: `${catalog.version}-revoked`,
    products: catalog.products.map(product => product.familyKey === entry.familyKey ? { ...product, supported: false } : product) });
  assert.equal(page.data.openingCalendar.followNotice, '');
  assert.equal(rt.calls.length, 0);
  page.onUnload();
});

test('guide poster reads the current catalog, follows refreshes and removes its listener on unload', () => {
  const rt = runtime();
  rt.load('utils/launch-calendar.js').activeCalendars = () => [calendar];
  const store = rt.load('utils/store.js');
  let refresh, removed = false;
  store.subscribeCatalog = listener => { refresh = listener; return () => { removed = true; }; };
  const page = rt.instance('pages/guide/index.js');
  page.onLoad({ section: 'calendar', from: 'query' }); page.onShow();
  assert.equal(page.data.calendars[0].followNotice, '已支持保存关注');
  refresh({ products: [] });
  assert.equal(page.data.calendars[0].followNotice, '');
  page.onUnload();
  assert.equal(removed, true);
  assert.equal(rt.calls.length, 0);
});

test('query calendar and Mine help enter the guide with distinct visible content and no automatic actions', () => {
  const rt = runtime(), routes = [], scrolls = [];
  rt.wx.navigateTo = value => routes.push(value.url);
  rt.wx.pageScrollTo = value => scrolls.push(value);
  rt.load('utils/launch-calendar.js').activeCalendars = () => [calendar];
  const query = rt.instance('pages/query/index.js'), mine = rt.instance('pages/mine/index.js');
  query.onOpenGuide(); mine.onHelp();
  assert.deepEqual(routes, ['/pages/guide/index?section=calendar&from=query', '/pages/guide/index?section=prepare&from=mine']);
  const page = rt.instance('pages/guide/index.js');
  page.onLoad(Object.fromEntries(new URLSearchParams(routes[0].split('?')[1])));
  page.onShow(); if (page.onReady) page.onReady();
  assert.equal(page.data.showLaunchPoster, true);
  assert.equal(page.data.calendars.length, 1);
  assert.equal(page.data.calendarExpanded, false, 'only the month grid is initially folded');
  assert.equal(page.data.stageId, 'prepare');
  assert.equal(page.data.stage.steps.length, 3, 'purchase guidance is already available without an expand action');
  assert.equal(page.returnSource, 'query');
  page.onLoad(Object.fromEntries(new URLSearchParams(routes[1].split('?')[1])));
  page.onShow(); if (page.onReady) page.onReady();
  assert.equal(page.data.showLaunchPoster, false);
  assert.equal(page.data.calendars.length, 0);
  assert.equal(page.data.stageId, 'prepare');
  assert.equal(page.data.stage.steps.length, 3);
  assert.equal(page.returnSource, 'mine');
  assert.deepEqual(scrolls, []);
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.messages.length, 0);
  page.onUnload();
});

test('poster opt-in survives catalog refresh while image failure preserves dates and guide content', () => {
  const rt = runtime();
  rt.load('utils/launch-calendar.js').activeCalendars = () => [calendar];
  const page = rt.instance('pages/guide/index.js');
  for (const options of [{}, { from: 'query' }, { section: 'prepare', stage: 'pickup' }, { section: 'notification' }, { section: 'membership' }, { section: 'pickup' }, { section: 'unknown' }]) {
    page.onLoad(options);
    page.refreshCalendars(rt.load('utils/store.js').currentCatalog());
    assert.equal(page.data.showLaunchPoster, false);
    assert.equal(page.data.calendars.length, 0);
    if (options.section === 'prepare') assert.equal(page.data.stageId, 'prepare');
  }
  page.onLoad({ section: 'calendar', from: 'query', stage: 'pickup' });
  assert.equal(page.data.stageId, 'prepare');
  page.onCalendarImageError({ currentTarget: { dataset: { index: '0' } } });
  assert.equal(page.data.calendars[0].imageUrl, '');
  assert.equal(page.data.calendars[0].preorderDateText, calendar.preorderDateText);
  assert.equal(page.data.calendars[0].releaseDateText, calendar.releaseDateText);
  assert.equal(page.data.stage.steps.length, 3);
  page.onToggleCalendar();
  assert.equal(page.data.calendarExpanded, true);
  assert.equal(rt.calls.length, 0);
});

test('opening calendar waits for first render, performs no API calls, and releases tab on close', async () => {
  const { rt, page, bar } = pageRuntime();
  await page.maybeOpenCalendar();
  assert.equal(page.data.calendarOpen, false);
  page.calendarViewReady = true;
  await Promise.all([page.maybeOpenCalendar(), page.maybeOpenCalendar()]);
  assert.equal(page.data.calendarOpen, true);
  assert.equal(bar.data.sheetHidden, true);
  assert.equal(rt.calls.length, 0);
  page.onCalendarMute({ detail: { value: ['mute'] } });
  page.onCloseCalendar();
  assert.equal(page.data.calendarOpen, false);
  assert.equal(bar.data.sheetHidden, false);
  assert.equal(rt.storage.get(page.calendarStorageKey).muted, true);
  page.calendarChecked = false;
  await page.maybeOpenCalendar();
  assert.equal(page.data.calendarOpen, false);
});

test('async cache response cannot open a hidden page or interrupt an active editor', async () => {
  const { rt, page } = pageRuntime();
  let response;
  rt.wx.getStorage = options => { response = options.success; };
  page.calendarViewReady = true;
  const pending = page.maybeOpenCalendar();
  page.visible = false;
  response({ data: null });
  await pending;
  assert.equal(page.data.calendarOpen, false);
  assert.equal(rt.storage.has('gxs_launch_calendar_iphone-duo'), false);
  page.visible = true;
  page.setData({ sheetVisible: true });
  await page.maybeOpenCalendar();
  assert.equal(page.data.calendarOpen, false);
});

test('share and single-page entries keep their intended journey without an opening overlay', async () => {
  for (const mode of ['share', 'single']) {
    const { rt, page } = pageRuntime();
    page.calendarViewReady = true;
    if (mode === 'share') page.enteredFromShare = true;
    else rt.app.globalData.singlePage = true;
    await page.maybeOpenCalendar();
    assert.equal(page.data.calendarOpen, false);
    assert.equal(rt.calls.length, 0);
  }
});

test('guide actions stay inside the mini program', () => {
  const rt = runtime();
  const navigations = [];
  rt.wx.switchTab = options => navigations.push(options.url);
  rt.wx.navigateTo = options => navigations.push(options.url);
  rt.wx.setClipboardData = () => { throw new Error('guide must not copy an external link'); };
  const page = rt.instance('pages/guide/index.js');
  page.onLoad({ stage: 'unknown', section: 'faq' });
  assert.equal(page.data.stageId, 'prepare');
  assert.equal(page.data.faqOpen, 'notification');
  page.onStageAction();
  page.onSelectStage({ currentTarget: { dataset: { id: 'monitor' } } });
  page.onStageAction();
  page.onSelectStage({ currentTarget: { dataset: { id: 'notice' } } });
  page.onStageAction();
  page.onSelectStage({ currentTarget: { dataset: { id: 'pickup' } } });
  page.onStageAction();
  page.onTestNotification();
  page.onCalendarPlan();
  assert.deepEqual(navigations, ['/pages/query/index', '/pages/follow/index', '/pages/follow/index', '/pages/follow/index', '/pages/notification-test/index?from=guide', '/pages/query/index']);
  assert.equal(rt.calls.length, 0);
});
