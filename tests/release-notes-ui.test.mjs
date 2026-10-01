import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

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
  assert.deepEqual(mine.data, before);
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
  assert.equal(mine.data.version, VERSION);
  assert.match(mine.data.versionLabel, /体验版/);
  const current = mine.data.releaseNotes.filter(entry => entry.version === mine.data.version);
  assert.equal(current.length, 1, 'the current build must have exactly one matching change record');
  assert.ok(current[0].title);
  assert.ok(current[0].highlights.length > 0);
  assert.equal(new Set(mine.data.releaseNotes.map(entry => entry.version)).size, mine.data.releaseNotes.length);
});
