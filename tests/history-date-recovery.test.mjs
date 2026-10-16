import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const boot = () => ({ membership: { active: false }, quota: { balance: 2, historyCost: 1, tasksDoneToday: [] }, collector: { state: 'running' } });

test('an explicit historical date is never silently replaced when its retention expires', async t => {
  let now = Date.parse('2026-10-08T02:00:00Z'); t.mock.method(Date, 'now', () => now);
  const rt = runtime(), page = rt.instance('pages/history/index.js');
  page.selection = { partNumber: 'SKU', storeNumbers: ['R577'] };
  page.onDateChange({ detail: { value: '2026-10-01' } });
  now = Date.parse('2026-10-18T02:00:00Z');
  page.applyBoot(boot());
  assert.equal(page.data.dayKey, '2026-10-01');
  assert.equal(page.data.restoreWarning, true);
  assert.match(page.data.restoreNotice, /条件未自动更改/);
  await page.onQuery();
  assert.equal(rt.calls.length, 0, 'expired conditions cannot initiate a charged request');
  assert.match(rt.messages.at(-1), /重新选择日期/);
});

test('the default today selection follows midnight while keeping yesterday results clearly labelled', t => {
  let now = Date.parse('2026-10-08T15:59:00Z'); t.mock.method(Date, 'now', () => now);
  const rt = runtime(), page = rt.instance('pages/history/index.js');
  page.selection = { partNumber: 'SKU', storeNumbers: ['R577'] };
  page.historyRequest = { ...page.selection, dayKey: '2026-10-08' };
  now = Date.parse('2026-10-08T16:01:00Z');
  page.refreshDateWindow();
  assert.equal(page.data.dayKey, '2026-10-09');
  assert.equal(page.data.resultTargetDifferent, true);
  assert.equal(rt.calls.length, 0, 'calendar rollover does not initiate a paid query');
});

test('an explicitly selected date remains fixed over midnight', t => {
  let now = Date.parse('2026-10-08T15:59:00Z'); t.mock.method(Date, 'now', () => now);
  const page = runtime().instance('pages/history/index.js');
  page.onDateChange({ detail: { value: '2026-10-08' } });
  now = Date.parse('2026-10-08T16:01:00Z');
  page.refreshDateWindow();
  assert.equal(page.data.dayKey, '2026-10-08');
  assert.equal(page.data.today, '2026-10-09');
});
