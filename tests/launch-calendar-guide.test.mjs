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

test('archived calendar data distinguishes opening and editorial expiry', () => {
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

test('query and Mine help open the buying guide without performing business actions', () => {
  const rt = runtime(), routes = [], scrolls = [];
  rt.wx.navigateTo = value => {
    routes.push(value.url);
    value.success({ errMsg: 'navigateTo:ok' });
    value.complete({ errMsg: 'navigateTo:ok' });
  };
  rt.wx.pageScrollTo = value => scrolls.push(value);
  const query = rt.instance('pages/query/index.js'), mine = rt.instance('pages/mine/index.js');
  query.onOpenGuide(); mine.onHelp();
  assert.deepEqual(routes, ['/pages/guide/index?section=prepare&from=query', '/pages/guide/index?section=prepare&from=mine']);
  const page = rt.instance('pages/guide/index.js');
  for (const [index, source] of ['query', 'mine'].entries()) {
    page.onLoad(Object.fromEntries(new URLSearchParams(routes[index].split('?')[1])));
    page.onShow();
    assert.equal(page.data.section, 'prepare');
    assert.equal(page.data.stageId, 'prepare');
    assert.equal(page.data.stage.steps.length, 3, 'buying guidance is immediately available');
    assert.equal(page.returnSource, source);
  }
  assert.deepEqual(scrolls, []);
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.messages.length, 0);
  page.onUnload();
});

test('old calendar links retain their target and return path while opening current buying help', () => {
  const rt = runtime(), routes = [];
  rt.wx.switchTab = value => routes.push(value.url);
  const store = rt.load('utils/store.js'), catalog = store.currentCatalog();
  const product = catalog.products.find(item => item.supported && !item.comingSoon);
  const storeNumber = Object.keys(catalog.storeByNumber)[0];
  let refresh, removed = false;
  store.subscribeCatalog = listener => { refresh = listener; return () => { removed = true; }; };
  const page = rt.instance('pages/guide/index.js');
  page.onLoad({ section: 'calendar', from: 'query', stage: 'pickup', gxsPart: encodeURIComponent(product.partNumber), gxsStores: storeNumber });
  page.onShow();
  assert.equal(page.data.section, 'prepare');
  assert.equal(page.data.stageId, 'prepare');
  assert.equal(page.data.targetSummary.title, product.title);
  assert.equal(page.data.stage.steps.length, 3);
  refresh({ productByPart: {}, storeByNumber: {} });
  assert.equal(page.data.targetSummary, null, 'removed targets are not shown after catalog refresh');
  page.onReturnTask();
  assert.deepEqual(routes, ['/pages/query/index']);
  page.onUnload();
  assert.equal(removed, true);
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.storage.size, 0);
});

test('guide actions preserve all four buying stages and explicit test-notification navigation', () => {
  const rt = runtime();
  const navigations = [];
  // These are separate completed visits, not rapid taps during one transition.
  const completeNavigation = options => {
    navigations.push(options.url);
    options.success({ errMsg: 'navigation:ok' });
    options.complete({ errMsg: 'navigation:ok' });
  };
  rt.wx.switchTab = completeNavigation;
  rt.wx.navigateTo = completeNavigation;
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
  assert.deepEqual(navigations, ['/pages/query/index', '/pages/follow/index', '/pages/follow/index', '/pages/follow/index', '/pages/notification-test/index?from=guide']);
  assert.equal(rt.calls.length, 0);
});
