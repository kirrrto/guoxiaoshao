import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';

const require = createRequire(import.meta.url);
const backend = require('../cloudfunctions/gxs_api/lib/rules/dnd');
const client = require('../miniprogram/utils/dnd');
const { activeDnd: readinessDnd } = require('../miniprogram/utils/reminder-readiness');
const { buildTasks, sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const periods = [{ startMinute: 1380, endMinute: 480 }, { startMinute: 720, endMinute: 780 }];
const schedule = (enabled = true, value = periods) => ({ enabled, ...value[0], periods: value.map(period => ({ ...period })) });

test('multiple quiet periods use Beijing time, inclusive starts and exclusive ends on both clients', () => {
  const dnd = schedule();
  const cases = [
    ['2026-10-15T14:59:59Z', false], ['2026-10-15T15:00:00Z', true],
    ['2026-10-15T16:00:00Z', true], ['2026-10-15T23:59:59Z', true],
    ['2026-10-16T00:00:00Z', false], ['2026-10-16T03:59:59Z', false],
    ['2026-10-16T04:00:00Z', true], ['2026-10-16T04:59:59Z', true],
    ['2026-10-16T05:00:00Z', false],
  ];
  for (const [at, active] of cases) {
    assert.equal(backend.activeDnd(dnd, at), active, at);
    assert.equal(client.activeDnd(dnd, Date.parse(at)), active, at);
    assert.equal(readinessDnd({ dnd }, new Date(at)), active, at);
  }
});

test('overlapping quiet periods form a union and full-day periods retain their enabled switch', () => {
  const dnd = schedule(true, [{ startMinute: 720, endMinute: 810 }, { startMinute: 780, endMinute: 840 }]);
  for (let minute = 0; minute < 1440; minute++) {
    const at = Date.parse('2026-10-14T16:00:00Z') + minute * 60000;
    const expected = minute >= 720 && minute < 840;
    assert.equal(backend.activeDnd(dnd, at), expected, String(minute));
    assert.equal(client.activeDnd(dnd, at), expected, String(minute));
  }
  for (const enabled of [true, false]) {
    const allDay = schedule(enabled, [...periods, { startMinute: 480, endMinute: 480 }]);
    for (const at of ['2026-10-15T01:00:00Z', '2026-10-15T06:00:00Z', '2026-10-15T16:00:00Z']) {
      assert.equal(backend.activeDnd(allDay, at), enabled);
      assert.equal(client.activeDnd(allDay, at), enabled);
    }
  }
});

test('legacy schedules remain readable and new arrays supersede their mirrored first period', () => {
  const legacy = { enabled: true, startMinute: 1380, endMinute: 480 };
  for (const api of [backend, client]) {
    assert.deepEqual(api.dndPeriods(legacy), [periods[0]]);
    assert.equal(api.activeDnd(legacy, '2026-10-15T16:00:00Z'), true);
    assert.equal(api.activeDnd(legacy, '2026-10-15T04:00:00Z'), false);
    const arrayWins = { enabled: true, startMinute: 0, endMinute: 0, periods: [periods[1]] };
    assert.equal(api.activeDnd(arrayWins, '2026-10-15T08:00:00Z'), false);
    const copy = api.dndPeriods(arrayWins); copy[0].startMinute = 0;
    assert.equal(arrayWins.periods[0].startMinute, 720);
    assert.equal(api.activeDnd(legacy, 'invalid'), false);
  }
  assert.equal(client.formatDndPeriod(periods[0]), '23:00–08:00（次日）');
  assert.equal(client.formatDndPeriod({ startMinute: 0, endMinute: 0 }), '全天');
  assert.equal(client.dndSummary(schedule()), '23:00–08:00（次日）、12:00–13:00');
  assert.equal(client.dndSummary(schedule(false)), '未开启');
});

test('quiet status gives today or tomorrow recovery after the complete overlapping and adjacent union', () => {
  const dnd = schedule(true, [periods[0], { startMinute: 420, endMinute: 540 }, { startMinute: 540, endMinute: 600 }, periods[1]]);
  assert.equal(client.dndStatus(dnd, '2026-10-15T14:59:59Z'), '每天 4 个时段');
  assert.equal(client.dndStatus(dnd, '2026-10-15T15:00:00Z'), '当前免打扰 · 明天 10:00 恢复');
  assert.equal(client.dndStatus(dnd, '2026-10-15T16:00:00Z'), '当前免打扰 · 今天 10:00 恢复');
  assert.equal(client.dndStatus(dnd, '2026-10-16T01:59:59Z'), '当前免打扰 · 今天 10:00 恢复');
  assert.equal(client.dndStatus(dnd, '2026-10-16T02:00:00Z'), '每天 4 个时段');
  assert.equal(client.dndStatus(dnd, '2026-10-16T04:00:00Z'), '当前免打扰 · 今天 13:00 恢复');
  assert.equal(client.dndStatus(dnd, '2026-10-16T05:00:00Z'), '每天 4 个时段');
  const toMidnight = schedule(true, [{ startMinute: 1320, endMinute: 0 }]);
  assert.equal(client.dndStatus(toMidnight, '2026-10-15T14:00:00Z'), '当前免打扰 · 明天 00:00 恢复');
  assert.equal(client.dndStatus(toMidnight, '2026-10-15T16:00:00Z'), '每天 1 个时段');
});

test('quiet status recognizes all-day unions and does not invent an end for invalid data', () => {
  for (const value of [
    [{ startMinute: 480, endMinute: 480 }],
    [{ startMinute: 0, endMinute: 720 }, { startMinute: 720, endMinute: 0 }],
    [{ startMinute: 1380, endMinute: 480 }, { startMinute: 420, endMinute: 1380 }],
  ]) assert.equal(client.dndStatus(schedule(true, value), '2026-10-15T08:00:00Z'), '全天免打扰');
  assert.equal(client.dndStatus(schedule(false), 'bad-time'), '未开启');
  assert.equal(client.dndStatus(null), '未开启');
  assert.equal(client.dndStatus({ enabled: true }), '时段待确认');
  assert.equal(client.dndStatus({ enabled: true, startMinute: 1380, endMinute: 480, periods: [] }), '时段待确认');
  for (const at of ['bad-time', null, Infinity]) assert.equal(client.dndStatus(schedule(), at), '时段待确认');
  assert.equal(client.dndStatus({ enabled: true, ...periods[0] }, '2026-10-15T15:00:00Z'), '当前免打扰 · 明天 08:00 恢复');
});

test('quiet status handles a one-minute gap, duplicate periods and unordered adjacent segments', () => {
  const gap = schedule(true, [{ startMinute: 0, endMinute: 720 }, { startMinute: 721, endMinute: 0 }]);
  assert.equal(client.dndStatus(gap, '2026-10-15T03:59:59Z'), '当前免打扰 · 今天 12:00 恢复');
  assert.equal(client.dndStatus(gap, '2026-10-15T04:00:00Z'), '每天 2 个时段');
  assert.equal(client.dndStatus(gap, '2026-10-15T04:01:00Z'), '当前免打扰 · 明天 12:00 恢复');
  const adjacent = schedule(true, [{ startMinute: 780, endMinute: 840 }, { startMinute: 720, endMinute: 780 }, { startMinute: 720, endMinute: 780 }]);
  assert.equal(client.dndStatus(adjacent, '2026-10-15T04:00:00Z'), '当前免打扰 · 今天 14:00 恢复');
});

test('settings save one to eight validated periods and retain unrelated preferences', async () => {
  const f = createFixture();
  const original = ok(await f.call('user.bootstrap')).settings;
  assert.deepEqual(client.dndPeriods(original.dnd), [{ startMinute: 1380, endMinute: 480 }]);
  const saved = ok(await f.call('user.updateSettings', { notifyEnabled: false, dnd: { enabled: true, periods } }));
  assert.deepEqual(saved.settings, { notifyEnabled: false, dnd: schedule() });
  assert.deepEqual(ok(await f.call('user.bootstrap')).settings, saved.settings);
  const eight = Array.from({ length: 8 }, (_, i) => ({ startMinute: i * 90, endMinute: i * 90 + 30 }));
  assert.equal(ok(await f.call('user.updateSettings', { dnd: { enabled: true, periods: eight } })).settings.dnd.periods.length, 8);
  const single = ok(await f.call('user.updateSettings', { dnd: { enabled: false, periods: [periods[1]] } })).settings;
  assert.equal(single.notifyEnabled, false);
  assert.deepEqual(single.dnd, schedule(false, [periods[1]]));
});

test('invalid or empty period lists reject the entire settings write', async () => {
  const f = createFixture();
  const original = ok(await f.call('user.bootstrap')).settings;
  const invalid = [[], null, {}, Array(9).fill(periods[0]), [{ startMinute: -1, endMinute: 1 }],
    [{ startMinute: 0, endMinute: 1440 }], [{ startMinute: 0.5, endMinute: 2 }],
    [{ startMinute: '720', endMinute: 780 }], [null], [{ startMinute: 720 }], [periods[0], {}]];
  for (const value of invalid) {
    assert.equal(client.validateDndPeriods(value), false);
    assert.equal(backend.validateDndPeriods(value), false);
    const result = await f.call('user.updateSettings', { notifyEnabled: false, dnd: { enabled: false, periods: value } });
    assert.equal(result.error.code, 'invalid_dnd');
    assert.deepEqual((await f.repo.getUser(userKeyOf())).settings, original);
  }
  for (const value of [null, true, '12:00', []]) {
    assert.equal((await f.call('user.updateSettings', { dnd: value })).error.code, 'invalid_dnd');
  }
});

test('old clients can still edit legacy single periods but cannot erase multiple periods', async () => {
  const f = createFixture();
  const legacy = { enabled: true, startMinute: 600, endMinute: 660 };
  assert.deepEqual(ok(await f.call('user.updateSettings', { dnd: legacy })).settings.dnd, legacy);
  ok(await f.call('user.updateSettings', { dnd: schedule() }));
  const rejected = await f.call('user.updateSettings', { notifyEnabled: false, dnd: { ...legacy, enabled: false } });
  assert.equal(rejected.error.code, 'dnd_client_outdated');
  assert.match(rejected.error.message, /更新小程序/);
  assert.deepEqual((await f.repo.getUser(userKeyOf())).settings, { dnd: schedule(), notifyEnabled: true });
  assert.equal(ok(await f.call('user.updateSettings', { notifyEnabled: false })).settings.notifyEnabled, false);
});

test('a legacy request paused before its transaction cannot overwrite a concurrent multi-period save', async () => {
  const f = createFixture(); ok(await f.call('user.bootstrap'));
  const update = f.repo.updateUserSettings.bind(f.repo);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.repo.updateUserSettings = async (userKey, patch) => {
    if (patch.dnd && !patch.dnd.periods) { entered(); await gate; }
    return update(userKey, patch);
  };
  const oldRequest = f.call('user.updateSettings', { dnd: { enabled: true, startMinute: 600, endMinute: 660 }, notifyEnabled: false });
  await waiting;
  ok(await f.call('user.updateSettings', { dnd: schedule() }));
  release();
  assert.equal((await oldRequest).error.code, 'dnd_client_outdated');
  assert.deepEqual((await f.repo.getUser(userKeyOf())).settings, { notifyEnabled: true, dnd: schedule() });
});

const notifications = { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 0, maxEventAgeSeconds: 120 };
async function notificationFixture(at = '2026-10-15T04:30:00Z') {
  const f = createFixture({ config: { notifications }, start: at });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' }, subscriptions: { TPL: { credits: 3 } } });
  const follow = { _id: 'dnd-follow', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' };
  await f.repo.saveFollow(follow);
  let sends = 0;
  const sender = async () => { sends++; return { errcode: 0 }; }; sender.appid = CONSUMER_APPID;
  const event = { _id: 'dnd-event', type: 'restock_confirmed', partNumber: follow.partNumber, storeNumber: 'R577', detectedAt: f.state.now.toISOString() };
  const plan = async () => buildTasks({ events: [event], follows: [follow], users: new Map([[userKeyOf(), await f.repo.getUser(userKeyOf())]]), config: { notifications }, now: f.state.now })[0];
  const send = task => sendTask({ task, config: { notifications }, repo: f.repo, sendImpl: sender, now: f.state.now, clock: () => f.state.now });
  return { f, event, plan, send, sends: () => sends };
}

test('planning skips the second quiet period and never queues its events for later replay', async () => {
  const s = await notificationFixture();
  ok(await s.f.call('user.updateSettings', { dnd: schedule() }));
  const task = await s.plan();
  assert.equal(task.status, 'skipped'); assert.equal(task.reason, 'dnd');
  await s.f.repo.saveNotification(task);
  s.f.state.now = new Date('2026-10-15T05:00:00Z');
  assert.equal((await s.send(task)).status, 'skipped');
  assert.equal(s.sends(), 0);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('a planner delayed until the quiet period ends still suppresses a recent quiet-period event', async () => {
  const s = await notificationFixture('2026-10-15T04:59:50Z');
  ok(await s.f.call('user.updateSettings', { dnd: schedule() }));
  s.f.advance(10000);
  assert.equal(backend.activeDnd(schedule(), s.f.state.now), false);
  assert.equal((await s.plan()).reason, 'dnd');
});

test('sending rechecks newly enabled multiple periods and preserves subscription credits', async () => {
  const s = await notificationFixture(); const task = await s.plan();
  assert.equal(task.status, 'pending');
  await s.f.repo.saveNotification(task); await seedNotificationObservation(s.f.repo, task);
  ok(await s.f.call('user.updateSettings', { dnd: schedule() }));
  assert.equal((await s.send(task)).reason, 'dnd');
  assert.equal(s.sends(), 0);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('the final send check catches a quiet-period update after credit reservation and releases its credit', async () => {
  const s = await notificationFixture(); const task = await s.plan();
  await s.f.repo.saveNotification(task); await seedNotificationObservation(s.f.repo, task);
  const reserve = s.f.repo.reserveSubscriptionCredit.bind(s.f.repo);
  s.f.repo.reserveSubscriptionCredit = async input => {
    const reserved = await reserve(input);
    await s.f.repo.updateUserSettings(userKeyOf(), { dnd: schedule() });
    return reserved;
  };
  const result = await s.send(task);
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'dnd');
  assert.equal(s.sends(), 0);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 3);
});

test('fresh events outside all quiet periods still send once', async () => {
  const s = await notificationFixture('2026-10-15T05:00:00Z');
  ok(await s.f.call('user.updateSettings', { dnd: schedule() }));
  const task = await s.plan(); await s.f.repo.saveNotification(task); await seedNotificationObservation(s.f.repo, task);
  assert.equal((await s.send(task)).status, 'accepted');
  await s.send(task);
  assert.equal(s.sends(), 1);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 2);
});
