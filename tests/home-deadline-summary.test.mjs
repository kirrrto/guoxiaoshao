import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = (id, status, ahead = 3600000) => ({ id, title: id, category: 'coupon', dueDate: '2026-12-01',
  remindAt: new Date(Date.now() + ahead).toISOString(), delivery: { status } });

test('home lists saved dates independently of Apple bootstrap and only schedules future authorized items', async () => {
  const rt = runtime(action => action === 'deadline.list' ? { userKey: 'alice', capability: { enabled: true }, items: [
    item('only-saved', 'not_enabled', 100), item('past', 'scheduled', -1000), item('next', 'scheduled'), item('later', 'scheduled', 7200000),
  ] } : Promise.reject(Error('Apple not available')));
  const page = rt.instance('pages/follow/index.js');
  await page.onLoad(); await page.deadlineReadPromise;
  assert.match(page.data.loadError, /Apple/);
  assert.equal(page.data.deadlineCount, 4);
  assert.equal(page.data.deadlines.length, 3);
  assert.equal(page.data.nextDeadline.id, 'next');
  assert.equal(rt.calls.filter(c => c.action === 'deadline.list').length, 1);
  page.onUnload();
});

test('a failed service read never opens an add flow and retry restores records-only access', async () => {
  let fail = true, navigations = 0;
  const rt = runtime(() => {
    if (fail) throw Object.assign(Error('not ready'), { code: 'deadline_service_unavailable' });
    return { userKey: 'alice', items: [], capability: { enabled: false } };
  });
  rt.wx.navigateTo = () => { navigations++; };
  const page = rt.instance('pages/follow/index.js');
  page.onOpenDeadlines();
  await page.loadDeadlines(); page.onOpenDeadlines();
  assert.equal(navigations, 0); assert.equal(page.data.deadlineCanOpen, false);
  assert.match(page.data.deadlinesError, /尚未开放/);
  assert.equal(page.data.deadlineServiceLabel, '暂不可用');
  fail = false; await page.onRetryDeadlines();
  assert.equal(page.data.deadlineCanOpen, true); assert.equal(page.data.deadlineRecordOnly, true);
  assert.equal(page.data.deadlineServiceLabel, '仅保存事项');
  page.onOpenDeadlines(); assert.equal(navigations, 1);
});

test('disabled delivery never promotes an old scheduled row into a next-send promise', async () => {
  const rt = runtime(() => ({ userKey: 'alice', capability: { enabled: false }, items: [item('old', 'scheduled')] }));
  const page = rt.instance('pages/follow/index.js'); await page.loadDeadlines();
  assert.equal(page.data.nextDeadline, null); assert.equal(page.data.deadlineRecordOnly, true);
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
  let fail = false;
  const rt = runtime(() => { if (fail) throw Error('temporarily offline'); return { userKey: 'alice', items: [item('saved', 'not_enabled')] }; });
  const page = rt.instance('pages/follow/index.js');
  await page.loadDeadlines(); fail = true; await page.onRetryDeadlines();
  assert.equal(page.data.deadlineCount, 1);
  assert.match(page.data.deadlinesError, /offline/);
  assert.equal(page.data.nextDeadline, null);
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
