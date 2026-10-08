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
  const current = mine.data.visibleReleaseNotes.filter(entry => entry.version === mine.data.version);
  assert.equal(current.length, 1, 'the current build must have exactly one matching change record');
  assert.ok(current[0].title);
  assert.ok(current[0].highlights.length > 0);
  assert.equal(new Set(RELEASE_NOTES.map(entry => entry.version)).size, RELEASE_NOTES.length);
  assert.deepEqual(mine.data.visibleReleaseNotes.map(entry => entry.version), Array.from(RELEASE_NOTES.slice(0, 3), entry => entry.version));
  assert.equal(mine.data.releaseNotesPage, 1);
  assert.equal(mine.data.releaseNotesPageCount, Math.ceil(RELEASE_NOTES.length / 3));
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
  mine.setData({ paymentPendingId: 'existing-payment', paymentBusy: true, showPurchaseRules: true,
    settings: { notifyEnabled: false }, orders: [{ orderId: 'already-paid' }] });
  const protectedFields = () => copy({ paymentPendingId: mine.data.paymentPendingId, paymentBusy: mine.data.paymentBusy,
    showPurchaseRules: mine.data.showPurchaseRules, settings: mine.data.settings, orders: mine.data.orders });
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
