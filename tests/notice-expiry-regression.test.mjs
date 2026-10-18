import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { normalizeAnnouncement, liveNotices, noticeUnreadCount, resolveQueryNotice } = require('../miniprogram/utils/query-notice.js');
const END = Date.parse('2026-10-16T20:20:00+08:00');
const oldNotice = { id: 'unknown-production-id', title: '接口限流说明',
  publishedAt: '2026-10-16T14:00:00+08:00', kind: 'warn',
  text: '取货数据源暂时限流时，查询可能延迟或提示稍后再试，本次不扣次数。系统会自动降速与恢复，请稍后重试。以苹果官网结算页面为准。' };

async function bootstrap(notices, now, announcement = null) {
  const f = createFixture({ config: { notices, announcement }, start: new Date(now).toISOString() });
  const result = await f.call('user.bootstrap');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
}

test('the dated rate-limit notice expires exactly at the confirmed end in both runtimes', async () => {
  for (const publishedAt of [oldNotice.publishedAt, '2026-10-16T06:00:00Z', '2026-10-16 14:00']) {
    const raw = { ...oldNotice, publishedAt };
    const before = await bootstrap([raw], END - 1);
    assert.equal(before.notices.length, 1);
    assert.equal(Date.parse(before.notices[0].expiresAt), END);
    assert.equal(liveNotices([raw], END - 1)[0].expiresAt, END);
    assert.equal((await bootstrap([raw], END)).notices.length, 0);
    assert.equal(liveNotices([raw], END).length, 0);
  }
});

test('expired cached content has no board row, banner or unread indicator', () => {
  assert.deepEqual(liveNotices([oldNotice], END + 86400000), []);
  assert.equal(normalizeAnnouncement(oldNotice, END), null);
  assert.equal(noticeUnreadCount({ notices: [oldNotice], announcement: oldNotice }, END), 0);
  assert.equal(resolveQueryNotice({ announcement: oldNotice, now: END, collector: { state: 'running' } }), null);
  assert.equal(resolveQueryNotice({ announcement: oldNotice, now: END, collector: { state: 'error' } }).source, 'collector');
});

test('retiring the old incident does not hide a new same-title notice or unrelated content', async () => {
  const others = [
    { ...oldNotice, publishedAt: '2026-10-18T14:00:00+08:00' },
    { ...oldNotice, publishedAt: '' },
    { ...oldNotice, title: '取货说明' },
    { ...oldNotice, publishedAt: '2026-10-16T14:01:00+08:00' },
    { ...oldNotice, publishedAt: '2026-10-16 06:00' },
  ];
  assert.equal(liveNotices(others, END + 86400000).length, others.length);
  assert.equal((await bootstrap(others, END + 86400000)).notices.length, others.length);
});

test('the confirmed end never extends an earlier expiry or allows a later one', async () => {
  for (const offset of [-60000, 60000]) {
    const raw = { ...oldNotice, expiresAt: new Date(END + offset).toISOString() };
    const expiry = Math.min(END, END + offset);
    assert.equal(liveNotices([raw], expiry - 1)[0].expiresAt, expiry);
    assert.equal(Date.parse((await bootstrap([raw], expiry - 1)).notices[0].expiresAt), expiry);
    assert.equal((await bootstrap([raw], expiry)).notices.length, 0);
    assert.equal(liveNotices([raw], expiry).length, 0);
  }
});

test('backend notice rows use the same request clock as the banner, not the machine clock', async t => {
  const raw = { text: '临时公告', startsAt: new Date(END - 3600000).toISOString(), expiresAt: new Date(END).toISOString() };
  t.mock.method(Date, 'now', () => END + 86400000);
  const before = await bootstrap([raw], END - 1, raw);
  assert.ok(before.announcement);
  assert.equal(before.notices.length, 1);
  t.mock.method(Date, 'now', () => END - 86400000);
  const after = await bootstrap([raw], END, raw);
  assert.equal(after.announcement, null);
  assert.equal(after.notices.length, 0);
  const notStarted = await bootstrap([raw], END - 3600001, raw);
  assert.equal(notStarted.announcement, null);
  assert.equal(notStarted.notices.length, 0);
});

test('an already open board removes the legacy row at its inferred end without another request', async t => {
  let now = END - 1000;
  t.mock.method(Date, 'now', () => now);
  const rt = runtime(async () => ({ notices: [oldNotice] }));
  const page = rt.instance('pages/notice-board/index.js');
  await page.onLoad();
  assert.equal(page.data.items.length, 1);
  const calls = rt.calls.length;
  now = END;
  await rt.nextTimer();
  assert.equal(page.data.items.length, 0);
  assert.equal(rt.calls.length, calls);
  page.onUnload();
  assert.equal(rt.timers.size, 0);
});
