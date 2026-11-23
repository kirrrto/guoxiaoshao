import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const copy = value => JSON.parse(JSON.stringify(value));

test('release notes open locally without disturbing account work or starting network requests', () => {
  const rt = runtime();
  const mine = rt.instance('pages/mine/index.js');
  mine.setData({ paymentPendingId: 'pending-order', paymentBusy: true, showReminderSettings: true,
    settings: { notifyEnabled: false, dnd: { enabled: true, start: 1320, end: 480 } } });
  const before = JSON.parse(JSON.stringify(mine.data));
  assert.equal(mine.data.showReleaseNotes, false);
  mine.onToggleReleaseNotes();
  assert.equal(mine.data.showReleaseNotes, true);
  mine.onToggleReleaseNotes();
  assert.deepEqual(copy(mine.data), before);
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.messages.length, 0);
  mine.pageRetired = true;
  mine.onToggleReleaseNotes();
  assert.equal(mine.data.showReleaseNotes, false);
});

test('release notes identify the build version without confusing its development channel with a version', () => {
  const rt = runtime();
  rt.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'trial' } });
  const mine = rt.instance('pages/mine/index.js');
  const { VERSION } = rt.load('config/version.js');
  const { RELEASE_NOTES } = rt.load('config/release-notes.js');
  assert.equal(mine.data.version, VERSION);
  assert.match(mine.data.versionLabel, /体验版/);
  const latestPublicNote = mine.data.visibleReleaseNotes[0];
  assert.ok(latestPublicNote.title);
  assert.ok(latestPublicNote.highlights.length > 0);
  assert.equal(new Set(RELEASE_NOTES.map(entry => entry.version)).size, RELEASE_NOTES.length);
  assert.deepEqual(mine.data.visibleReleaseNotes.map(entry => entry.version), Array.from(RELEASE_NOTES.slice(0, 3), entry => entry.version));
  assert.equal(mine.data.releaseNotesPage, 1);
  assert.equal(mine.data.releaseNotesPageCount, Math.ceil(RELEASE_NOTES.length / 3));
});

test('customer release notes exclude personal testing privileges, including historical entries', () => {
  const rt = runtime();
  const { RELEASE_NOTES } = rt.load('config/release-notes.js');
  for (const row of RELEASE_NOTES) {
    const publicCopy = [row.title, ...row.highlights, row.note || ''].join(' ');
    assert.doesNotMatch(publicCopy, /指定(?:管理员|测试账号)|管理员功能测试|个人测试权限|开发者专属权益/);
  }
  assert.ok(!RELEASE_NOTES.some(row => row.version === '3.8.2'));
  const candidate = RELEASE_NOTES.find(row => row.version === '3.8.3');
  assert.ok(candidate.highlights.some(text => text.includes('月卡、年卡可免扣次查询日本、台湾和香港')));
  assert.ok(candidate.highlights.some(text => text.includes('扣次和退款记录')));
});

test('release pages cover every known version once in newest-first order without growing the rendered list', () => {
  const rt = runtime(), mine = rt.instance('pages/mine/index.js');
  const { RELEASE_NOTES } = rt.load('config/release-notes.js');
  mine.onToggleReleaseNotes();
  const visited = [];
  for (let page = 1; page <= mine.data.releaseNotesPageCount; page++) {
    assert.equal(mine.data.releaseNotesPage, page);
    assert.ok(mine.data.visibleReleaseNotes.length > 0 && mine.data.visibleReleaseNotes.length <= 3);
    visited.push(...mine.data.visibleReleaseNotes.map(entry => entry.version));
    mine.onNextReleaseNotes();
  }
  assert.deepEqual(visited, Array.from(RELEASE_NOTES, entry => entry.version));
  const last = copy(mine.data);
  mine.onNextReleaseNotes();
  assert.deepEqual(copy(mine.data), last, 'cannot advance beyond the final page');
  for (let page = mine.data.releaseNotesPageCount; page > 1; page--) mine.onPreviousReleaseNotes();
  assert.equal(mine.data.releaseNotesPage, 1);
  const first = copy(mine.data);
  mine.onPreviousReleaseNotes();
  assert.deepEqual(copy(mine.data), first, 'cannot move before the first page');
  assert.equal(rt.calls.length, 0);
});

test('closing and reopening release notes resets the first page without changing payment or settings', () => {
  const rt = runtime(), mine = rt.instance('pages/mine/index.js');
  mine.setData({ paymentPendingId: 'existing-payment', paymentBusy: true, showLedger: true,
    settings: { notifyEnabled: false }, orders: [{ orderId: 'already-paid' }] });
  const protectedFields = () => copy({ paymentPendingId: mine.data.paymentPendingId, paymentBusy: mine.data.paymentBusy,
    showLedger: mine.data.showLedger, settings: mine.data.settings, orders: mine.data.orders });
  const original = protectedFields();
  mine.onToggleReleaseNotes(); mine.onNextReleaseNotes();
  assert.equal(mine.data.releaseNotesPage, 2);
  mine.onToggleReleaseNotes();
  assert.equal(mine.data.releaseNotesPage, 1);
  mine.onNextReleaseNotes();
  assert.equal(mine.data.releaseNotesPage, 1, 'hidden pagination cannot alter the next opening');
  mine.onToggleReleaseNotes();
  assert.equal(mine.data.releaseNotesPage, 1);
  assert.deepEqual(protectedFields(), original);
  mine.pageRetired = true;
  const retired = copy(mine.data);
  mine.onPreviousReleaseNotes(); mine.onNextReleaseNotes(); mine.onToggleReleaseNotes();
  assert.deepEqual(copy(mine.data), retired);
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.messages.length, 0);
});
