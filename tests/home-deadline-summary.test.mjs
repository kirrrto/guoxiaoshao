import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = (id, status, ahead = 3600000) => ({ id, title: id, category: 'coupon', dueDate: '2026-12-01',
  remindAt: new Date(Date.now() + ahead).toISOString(), delivery: { status } });

test('calendar and appointment use Beijing dates and keep a numeric user title intact', () => {
  const { presentHomeDeadline } = runtime().load('utils/deadlines.js');
  const record = { ...item('1', 'scheduled'), dueDate: '2027-01-02', remindAt: '2026-12-31T16:30:00.000Z' };
  const before = presentHomeDeadline(record, Date.parse('2026-12-31T15:59:00Z'), true);
  assert.equal(before.title, '1');
  assert.equal(before.calendarMonth, '2027年1月');
  assert.equal(before.calendarDay, '2');
  assert.deepEqual({ ...before.summaryReminder }, { year: '2027', month: '1月', day: '1', time: '00:30' });
  const after = presentHomeDeadline(record, Date.parse('2026-12-31T16:00:00Z'), true);
  assert.equal(after.calendarMonth, '1月');
  assert.deepEqual({ ...after.summaryReminder }, { year: '', month: '1月', day: '1', time: '00:30' });
});

test('invalid dates never show a synthetic appointment; leap days are preserved', () => {
  const { presentHomeDeadline } = runtime().load('utils/deadlines.js');
  const now = Date.parse('2026-11-25T23:00:00Z');
  const record = { ...item('coupon', 'scheduled'), remindAt: '2028-02-28T01:00:00Z', dueDate: '2028-02-29' };
  const valid = presentHomeDeadline(record, now, true);
  assert.equal(valid.calendarDay, '29');
  assert.equal(valid.summaryReminder.time, '09:00');
  for (const dueDate of ['2027-02-29', '', '2028-2-9', null]) {
    const summary = presentHomeDeadline({ ...record, dueDate }, now, true);
    assert.equal(summary.calendarDay, '');
    assert.equal(summary.calendarMonth, '');
    assert.equal(summary.summaryReminder, null);
    assert.equal(summary.statusLabel, '提醒状态待确认');
  }
  const missingTime = presentHomeDeadline({ ...record, remindAt: null }, now, true);
  assert.equal(missingTime.calendarDay, '29');
  assert.equal(missingTime.summaryReminder, null);
  assert.equal(missingTime.statusLabel, '提醒状态待确认');
});

test('only the actual future plan moves ahead of paused and deferred reminders', async () => {
  const paused = { ...item('paused', 'scheduled'), delivery: { status: 'scheduled', reason: 'user_disabled' } };
  const deferredItem = { ...item('quiet', 'scheduled'), delivery: { status: 'scheduled', reason: 'dnd' } };
  const rt = runtime(() => ({ userKey: 'alice', capability: { enabled: true },
    items: [paused, deferredItem, item('ready', 'scheduled', 7200000)] }));
  const page = rt.instance('pages/follow/index.js');
  await page.loadDeadlines();
  assert.equal(page.data.deadlines[0].id, 'ready');
  assert.ok(page.data.deadlines[0].summaryReminder);
  for (const row of page.data.deadlines.slice(1)) {
    assert.equal(row.summaryReminder, null);
    assert.equal(row.statusLabel, row.id === 'paused' ? '微信提醒已关闭' : '免打扰期间，提醒已延后');
  }
});

test('home lists saved dates independently of Apple bootstrap and only schedules future authorized items', async () => {
  const rt = runtime(action => action === 'deadline.list' ? { userKey: 'alice', capability: { enabled: true }, items: [
    item('only-saved', 'not_enabled', 100), item('past', 'scheduled', -1000), item('next', 'scheduled'), item('later', 'scheduled', 7200000),
  ] } : Promise.reject(Error('Apple not available')));
  const page = rt.instance('pages/follow/index.js');
  await page.onLoad(); await page.deadlineReadPromise;
  assert.match(page.data.loadError, /Apple/);
  assert.equal(page.data.deadlineCount, 4);
  assert.equal(page.data.deadlines.length, 3);
  assert.equal(page.data.deadlines[0].id, 'next');
  assert.ok(page.data.deadlineCanOpen && page.data.deadlines[0].summaryReminder);
  assert.equal(page.data.deadlines.filter(deadline => deadline.id === 'next').length, 1);
  assert.equal(rt.calls.filter(c => c.action === 'deadline.list').length, 1);
  page.onUnload();
});

test('a failed service read never opens an add flow and retry restores records-only access', async () => {
  let fail = true;
  const routes = [];
  const rt = runtime(() => {
    if (fail) throw Object.assign(Error('not ready'), { code: 'deadline_service_unavailable' });
    return { userKey: 'alice', items: [], capability: { enabled: false } };
  });
  rt.wx.navigateTo = ({ url }) => { routes.push(url); };
  const page = rt.instance('pages/follow/index.js');
  page.onOpenDeadlines();
  await page.loadDeadlines(); page.onOpenDeadlines();
  assert.equal(routes.length, 0); assert.equal(page.data.deadlineCanOpen, false);
  assert.match(page.data.deadlinesError, /尚未开放/);
  assert.equal(page.data.deadlinesLoaded, false);
  fail = false; await page.onRetryDeadlines();
  assert.equal(page.data.deadlineCanOpen, true); assert.equal(page.data.deadlineRecordOnly, true);
  assert.equal(page.data.deadlinesError, '');
  page.onOpenDeadlines(); assert.deepEqual(routes, ['/pages/deadlines/index?mode=add']);
});

test('disabled delivery never promotes an old scheduled row into a next-send promise', async () => {
  const rt = runtime(() => ({ userKey: 'alice', capability: { enabled: false },
    items: [item('old', 'scheduled'), item('failed', 'failed', 7200000)] }));
  const page = rt.instance('pages/follow/index.js'); await page.loadDeadlines();
  assert.equal(page.data.deadlineRecordOnly, true);
  assert.equal(page.data.deadlines[0].summaryReminder, null);
  assert.equal(page.data.deadlines[0].statusLabel, '');
  assert.equal(page.data.deadlines[1].statusLabel, '提醒发送失败');
  let route;
  rt.wx.navigateTo = ({ url }) => { route = url; };
  page.onOpenDeadlines();
  assert.equal(route, '/pages/deadlines/index');
});

test('date summary deduplicates reads and ignores hidden-page completions', async () => {
  const pending = deferred();
  const rt = runtime(() => pending.promise), page = rt.instance('pages/follow/index.js');
  const first = page.loadDeadlines(), second = page.loadDeadlines();
  assert.equal(first, second);
  page.onHide();
  pending.resolve({ userKey: 'alice', items: [item('old', 'scheduled')] });
  await first;
  assert.equal(page.data.deadlineCount, 0);
  assert.equal(page.data.deadlinesLoading, false);
  assert.equal(rt.calls.length, 1);
});

test('a response from the previous account never appears in the home summary', async () => {
  const pending = deferred();
  const rt = runtime(() => pending.promise), page = rt.instance('pages/follow/index.js');
  rt.app.globalData.bootstrap = { identity: { userKey: 'alice' } };
  const reading = page.loadDeadlines();
  rt.app.globalData.bootstrap = { identity: { userKey: 'bob' } };
  pending.resolve({ userKey: 'alice', items: [item('private', 'scheduled')] });
  await reading;
  assert.equal(page.data.deadlineCount, 0);
  assert.equal(page.data.deadlinesLoading, false);
});

test('failed summary refresh retains confirmed records and exposes retry instead of an empty success', async () => {
  const offline = deferred();
  let reads = 0;
  const rt = runtime(() => reads++ ? offline.promise.then(() => { throw Error('temporarily offline'); })
    : { userKey: 'alice', capability: { enabled: true }, items: [item('saved', 'scheduled')] });
  const page = rt.instance('pages/follow/index.js');
  await page.loadDeadlines();
  assert.ok(page.data.deadlineCanOpen && page.data.deadlines[0].summaryReminder);
  const retry = page.onRetryDeadlines();
  assert.equal(page.data.deadlineCanOpen, false);
  assert.equal(page.data.deadlinesLoading, true);
  offline.resolve();
  await retry;
  assert.equal(page.data.deadlineCount, 1);
  assert.match(page.data.deadlinesError, /offline/);
  assert.equal(page.data.deadlineCanOpen, false);
  assert.equal(page.data.deadlines[0].id, 'saved');
  assert.equal(page.data.deadlinesLoading, false);
});

test('a new server identity clears the previous summary while bootstrap is still stale', async () => {
  let userKey = 'alice';
  const rt = runtime(() => ({ userKey, items: [item(userKey, 'not_enabled')] }));
  rt.app.globalData.bootstrap = { identity: { userKey: 'alice' } };
  const page = rt.instance('pages/follow/index.js');
  await page.loadDeadlines(); assert.equal(page.data.deadlineCount, 1);
  userKey = 'bob'; await page.loadDeadlines();
  assert.equal(page.data.deadlineCount, 0);
  assert.equal(page.data.deadlinesLoaded, false);
  assert.match(page.data.deadlinesError, /账户已变化/);
});
