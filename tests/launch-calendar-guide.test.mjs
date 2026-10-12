import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { activeCalendars, calendarView, shouldOpenCalendar } = require('../miniprogram/utils/launch-calendar');
const entry = require('../miniprogram/config/product-launches')[0];
const now = Date.parse('2026-10-11T08:00:00Z');
const calendar = calendarView(entry, now);

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
  assert.deepEqual(navigations, ['/pages/query/index', '/pages/follow/index', '/pages/follow/index', '/pages/follow/index', '/pages/notification-test/index', '/pages/query/index']);
  assert.equal(rt.calls.length, 0);
});
