import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeAnnouncement, resolveQueryNotice, liveNotices, hasLiveNoticeContent, noticeUnreadCount, markNoticesSeen } = require('../miniprogram/utils/query-notice.js');

const NOW = Date.parse('2026-10-16T23:56:00+08:00');

test('legacy string announcements stay until the operator clears them', () => {
  const normalized = normalizeAnnouncement('苹果官网维护中', NOW);
  assert.equal(normalized.text, '苹果官网维护中');
  assert.equal(normalized.expiresAt, null);
});

test('structured announcements hide themselves after expiresAt without claiming recovery', () => {
  const raw = { text: '苹果官网维护中，预计于今晚20:20（北京时间）结束。', kind: 'maintenance', expiresAt: '2026-10-16T20:20:00+08:00' };
  assert.equal(normalizeAnnouncement(raw, NOW), null);
  const notice = resolveQueryNotice({ announcement: raw, now: NOW, collector: { state: 'running' } });
  assert.equal(notice, null, 'expired copy disappears; no fabricated recovery banner');
});

test('active maintenance banners render and win over collector noise', () => {
  const raw = { text: '苹果官网维护中', kind: 'maintenance', expiresAt: '2026-10-17T02:00:00+08:00' };
  const notice = resolveQueryNotice({ announcement: raw, now: NOW, collector: { state: 'error' } });
  assert.equal(notice.source, 'announcement');
  assert.equal(notice.text, '苹果官网维护中');
});

test('ordinary launch notices yield to consent and faults while maintenance keeps priority', () => {
  const { MAC_LAUNCH_CELEBRATION_NOTICE: announcement } = require('../miniprogram/utils/query-notice.js');
  const now = Date.parse('2026-10-28T12:00:00+08:00');
  const consent = { anyBlocked: true };
  const fault = { state: 'error', observationStale: true };
  assert.equal(resolveQueryNotice({ announcement, now, consent, collector: fault }).source, 'consent');
  assert.equal(resolveQueryNotice({ announcement, now, collector: fault }).source, 'collector');
  for (const state of ['running', 'idle']) {
    assert.equal(resolveQueryNotice({ announcement, now, collector: { state, observationStale: true } }).source, 'announcement');
  }
  assert.equal(resolveQueryNotice({ announcement: { ...announcement, kind: 'maintenance' }, now, consent, collector: fault }).source, 'announcement');
  assert.equal(resolveQueryNotice({ announcement, now: Date.parse('2026-11-07T00:00:00+08:00'), collector: fault }).source, 'collector');
  assert.equal(normalizeAnnouncement(announcement, Date.parse('2026-10-27T23:59:59+08:00')), null);
  assert.doesNotMatch(announcement.text, /今日|全体会员|已发放|已赠送/);
});

test('blocked WeChat subscribe permission is a recoverable query banner', () => {
  const notice = resolveQueryNotice({
    announcement: null,
    now: NOW,
    consent: { anyBlocked: true, blocked: [{ title: '商品到货提醒' }, { title: '库存不足提醒' }] },
    collector: { state: 'running' },
  });
  assert.equal(notice.source, 'consent');
  assert.equal(notice.action, 'open_settings');
  assert.match(notice.text, /商品到货提醒/);
});

test('without an announcement, a live collector fault shows the actual abnormal state', () => {
  const notice = resolveQueryNotice({ announcement: null, now: NOW, collector: { state: 'error' } });
  assert.equal(notice.source, 'collector');
  assert.match(notice.text, /异常/);
  assert.doesNotMatch(notice.text, /已恢复/);
});

test('observation delay is not a query-page banner and never claims the API is broken', () => {
  assert.equal(resolveQueryNotice({ announcement: null, now: NOW, collector: { state: 'running', observationStale: true } }), null);
  assert.equal(resolveQueryNotice({ announcement: null, now: NOW, collector: { state: 'idle', observationStale: true } }), null);
  const fault = resolveQueryNotice({ announcement: null, now: NOW, collector: { state: 'error', observationStale: true } });
  assert.equal(fault.source, 'collector');
  assert.match(fault.text, /接口状态异常/);
});

test('healthy service with no announcement shows no banner', () => {
  assert.equal(resolveQueryNotice({ announcement: null, now: NOW, collector: { state: 'running' } }), null);
  assert.equal(resolveQueryNotice({ announcement: '', now: NOW, collector: { state: 'idle' } }), null);
});

test('not-yet-started announcements stay hidden', () => {
  const raw = { text: '即将维护', startsAt: '2026-10-17T01:00:00+08:00', expiresAt: '2026-10-17T03:00:00+08:00' };
  assert.equal(normalizeAnnouncement(raw, NOW), null);
});

test('notice board keeps only live rows and exposes titles', () => {
  const rows = liveNotices([
    { id: 'a', title: '选购说明', text: '请以官网结算页为准', kind: 'notice' },
    { id: 'b', title: '过期维护', text: '旧文案', kind: 'maintenance', expiresAt: '2026-10-16T20:20:00+08:00' },
  ], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '选购说明');
  assert.equal(rows[0].text, '请以官网结算页为准');
  assert.equal(hasLiveNoticeContent({ notices: rows }), true);
  assert.equal(hasLiveNoticeContent({ notices: [{ text: '旧', expiresAt: '2026-10-16T20:20:00+08:00' }] }), false);
});

test('opening the notice board clears the red dot until a new notice appears', () => {
  const store = new Map();
  const wxMock = {
    getStorageSync: key => store.get(key),
    setStorageSync: (key, value) => { store.set(key, value); },
    removeStorageSync: key => { store.delete(key); },
  };
  const previous = global.wx;
  global.wx = wxMock;
  try {
    const payload = {
      notices: [
        { id: 'pickup-guide', title: '取货说明', text: '库存以官网结算页为准', kind: 'notice', publishedAt: '2026-10-16T14:00:00+08:00' },
      ],
    };
    assert.equal(noticeUnreadCount(payload, NOW), 1);
    markNoticesSeen(payload, NOW);
    assert.equal(noticeUnreadCount(payload, NOW), 0);
    const next = { notices: [...payload.notices, { id: 'new-1', text: '新的说明', publishedAt: '2026-10-17T10:00:00+08:00' }] };
    assert.equal(noticeUnreadCount(next, NOW), 1);
  } finally {
    global.wx = previous;
  }
});
