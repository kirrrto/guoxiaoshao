import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const overnight = { startMinute: 1380, endMinute: 480 };
const lunch = { startMinute: 720, endMinute: 780 };
const settingsOf = (periods = [overnight], enabled = true) => ({ notifyEnabled: true, dnd: { enabled, ...periods[0], periods: copy(periods) } });
const account = (settings = settingsOf(), userKey = 'consumer:alice') => ({
  identity: { userKey, openidMasked: 'test…account' }, membership: { active: true, expiresAt: '2027-10-20T00:00:00Z', remainingMs: 30 * 86400000 },
  quota: { balance: 3, tasksDoneToday: [], tasksViewedToday: [] }, tasks: [], collector: { state: 'not_deployed' },
  memberProduct: { planId: 'member_7d', days: 7, priceFen: 700, enabled: false, paymentReady: false, paymentReason: 'payment_not_enabled' },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 }, followCount: 0, settings: copy(settings),
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
const timeEvent = (index, value) => ({ currentTarget: { dataset: { index } }, detail: { value } });
const indexEvent = index => ({ currentTarget: { dataset: { index } } });

function setup(initial = account(), handleSave) {
  let server = copy(initial);
  const rt = runtime(async (action, payload) => {
    if (action === 'user.bootstrap') return copy(server);
    if (action === 'user.updateSettings') {
      if (handleSave) return handleSave(payload, server);
      server.settings = { ...server.settings, ...copy(payload) };
      return { settings: copy(server.settings) };
    }
    if (action === 'notify.list') return { notifications: [] };
    if (action === 'member.status') return { orders: [] };
    throw new Error(`Unexpected call: ${action}`);
  });
  rt.app.globalData.bootstrap = copy(server);
  const page = rt.instance('pages/mine/index.js');
  page.applyBoot(copy(server)); page.data.ready = true;
  return { rt, page, saves: () => rt.calls.filter(call => call.action === 'user.updateSettings'),
    setAccount: value => { server = copy(value); rt.app.globalData.bootstrap = copy(server); page.applyBoot(copy(server)); }, saved: () => copy(server.settings) };
}

test('legacy single-period accounts can enable, add, edit and delete real quiet-period rows', async () => {
  const s = setup(account({ notifyEnabled: true, dnd: { enabled: false, ...overnight } }));
  assert.equal(s.saves().length, 0, 'reading old settings does not migrate or enable them');
  assert.equal(s.page.data.dndPeriods.length, 1);
  assert.equal(s.page.data.dndSummary, '未开启');
  await s.page.onDndToggle({ detail: { value: true } });
  assert.deepEqual(s.saved().dnd.periods, [overnight]);
  await s.page.onAddDndPeriod();
  assert.deepEqual(s.saved().dnd.periods, [overnight, lunch]);
  await s.page.onDndStart(timeEvent(1, '18:30'));
  await s.page.onDndEnd(timeEvent(1, '20:00'));
  assert.deepEqual(s.saved().dnd.periods[1], { startMinute: 1110, endMinute: 1200 });
  await s.page.onRemoveDndPeriod(indexEvent(0));
  assert.deepEqual(s.saved().dnd, { enabled: true, startMinute: 1110, endMinute: 1200, periods: [{ startMinute: 1110, endMinute: 1200 }] });
  assert.equal(s.page.data.dndPeriods[0].index, 0);
  const before = s.saves().length;
  await s.page.onRemoveDndPeriod(indexEvent(0));
  assert.equal(s.saves().length, before, 'the last remaining period cannot be deleted');
});

test('cross-midnight and all-day rows expose the correct visible text and flags', async () => {
  const s = setup(account(settingsOf([overnight, lunch])));
  assert.equal(s.page.data.dndPeriods[0].start, '23:00');
  assert.equal(s.page.data.dndPeriods[0].end, '08:00');
  assert.equal(s.page.data.dndPeriods[0].overnight, true);
  assert.equal(s.page.data.dndPeriods[0].allDay, false);
  assert.match(s.page.data.dndSummary, /23:00–08:00（次日）.*12:00–13:00/);
  await s.page.onDndEnd(timeEvent(1, '12:00'));
  assert.equal(s.page.data.dndPeriods[1].allDay, true);
  assert.equal(s.page.data.dndPeriods[1].overnight, false);
  assert.match(s.page.data.dndSummary, /全天/);
});

test('an eight-period schedule rejects extra additions without an API write and becomes editable after deletion', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ startMinute: i * 90, endMinute: i * 90 + 30 }));
  const s = setup(account(settingsOf(eight)));
  assert.equal(s.page.data.maxDndPeriods, 8);
  await s.page.onAddDndPeriod();
  assert.equal(s.saves().length, 0);
  assert.match(String(s.rt.messages.at(-1)), /最多设置 8/);
  await s.page.onRemoveDndPeriod(indexEvent(7));
  await s.page.onAddDndPeriod();
  assert.equal(s.page.data.dndPeriods.length, 8);
  assert.deepEqual(s.saved().dnd.periods.at(-1), lunch);
});

test('a pending save does not change confirmed rows and blocks duplicate add/edit/delete/toggle actions', async () => {
  const waiting = deferred();
  const s = setup(account(settingsOf([overnight, lunch])), () => waiting.promise);
  const before = copy(s.page.data.settings);
  const saving = s.page.onAddDndPeriod();
  assert.equal(s.page.data.savingSettings, true);
  assert.deepEqual(copy(s.page.data.settings), before);
  assert.equal(s.page.data.dndPeriods.length, 2);
  await s.page.onAddDndPeriod(); await s.page.onDndStart(timeEvent(0, '22:00'));
  await s.page.onRemoveDndPeriod(indexEvent(0)); await s.page.onDndToggle({ detail: { value: false } });
  assert.equal(s.saves().length, 1);
  waiting.resolve({ settings: settingsOf([overnight, lunch, lunch]) }); await saving;
  assert.equal(s.page.data.dndPeriods.length, 3);
  assert.equal(s.page.data.savingSettings, false);
});

test('failed saving reloads confirmed settings, leaves rows intact and allows a later retry', async () => {
  let attempts = 0;
  const s = setup(account(settingsOf([overnight, lunch])), (patch, server) => {
    if (++attempts === 1) throw Object.assign(new Error('设置暂未保存，请重试'), { code: 'call_failed' });
    server.settings = { ...server.settings, ...copy(patch) }; return { settings: copy(server.settings) };
  });
  await s.page.onRemoveDndPeriod(indexEvent(0));
  assert.deepEqual(copy(s.page.data.settings), settingsOf([overnight, lunch]));
  assert.equal(s.page.data.savingSettings, false);
  assert.equal(s.rt.calls.filter(call => call.action === 'user.bootstrap').length, 1);
  assert.equal(s.rt.messages.some(message => message && message.code === 'call_failed'), true);
  await s.page.onRemoveDndPeriod(indexEvent(0));
  assert.deepEqual(copy(s.page.data.settings.dnd.periods), [lunch]);
});

test('an old account save cannot overwrite another account or clear its newer save lock', async () => {
  const alice = deferred(), bob = deferred(); let calls = 0;
  const s = setup(account(settingsOf([overnight])), () => (++calls === 1 ? alice.promise : bob.promise));
  const aliceSave = s.page.onAddDndPeriod();
  s.setAccount(account(settingsOf([lunch], false), 'consumer:bob'));
  assert.equal(s.page.data.savingSettings, false, 'the new account can edit its own settings');
  const bobSave = s.page.onDndToggle({ detail: { value: true } });
  alice.resolve({ settings: settingsOf([overnight, lunch]) }); await aliceSave;
  assert.equal(s.page.data.savingSettings, true, 'Alice cannot release Bob\'s pending save');
  assert.deepEqual(copy(s.page.data.settings), settingsOf([lunch], false));
  bob.resolve({ settings: settingsOf([lunch]) }); await bobSave;
  assert.equal(s.page.data.boot.identity.userKey, 'consumer:bob');
  assert.deepEqual(copy(s.page.data.settings), settingsOf([lunch]));
  assert.equal(s.page.data.savingSettings, false);
});

test('an old account save failure is silent and cannot trigger a refresh of the new account', async () => {
  const waiting = deferred(); const s = setup(account(), () => waiting.promise);
  const saving = s.page.onAddDndPeriod();
  s.setAccount(account(settingsOf([lunch], false), 'consumer:bob'));
  const before = copy(s.page.data), messages = s.rt.messages.length, reads = s.rt.calls.length;
  waiting.reject(new Error('Alice settings failed')); await saving;
  assert.deepEqual(copy(s.page.data), before);
  assert.equal(s.rt.messages.length, messages);
  assert.equal(s.rt.calls.length, reads);
});

test('switching away and back still rejects the earlier visit\'s settings response', async () => {
  const waiting = deferred(); const s = setup(account(), () => waiting.promise);
  const saving = s.page.onAddDndPeriod();
  s.setAccount(account(settingsOf([lunch]), 'consumer:bob'));
  s.setAccount(account(settingsOf([lunch], false)));
  waiting.resolve({ settings: settingsOf([overnight, lunch]) }); await saving;
  assert.deepEqual(copy(s.page.data.settings), settingsOf([lunch], false));
});

test('reopening a page restores all server periods and disabling/re-enabling preserves them', async () => {
  const first = setup(account(settingsOf([overnight, lunch])));
  await first.page.onDndToggle({ detail: { value: false } });
  const reopened = setup(account(first.saved()));
  assert.equal(reopened.page.data.dndPeriods.length, 2);
  assert.equal(reopened.page.data.dndSummary, '未开启');
  assert.equal(reopened.saves().length, 0);
  await reopened.page.onDndToggle({ detail: { value: true } });
  assert.deepEqual(reopened.saved().dnd.periods, [overnight, lunch]);
  assert.equal(reopened.saved().dnd.enabled, true);
});

test('missing or malformed legacy schedules show an editable default without assuming permission', async () => {
  for (const settings of [{ notifyEnabled: true }, { notifyEnabled: true, dnd: { enabled: false } },
    { notifyEnabled: true, dnd: { enabled: false, startMinute: -1, endMinute: 1500 } }]) {
    const s = setup(account(settings));
    assert.equal(s.page.data.dndPeriods.length, 1);
    assert.equal(s.page.data.dndPeriods[0].start, '23:00');
    assert.equal(s.page.data.dndPeriods[0].end, '08:00');
    assert.deepEqual(copy(s.page.data.settings), settings);
    assert.equal(s.page.data.dndSummary, '未开启');
    assert.equal(s.saves().length, 0);
    await s.page.onDndToggle({ detail: { value: true } });
    assert.deepEqual(s.saved().dnd, settingsOf().dnd);
  }
});

test('invalid picker input or a retired page cannot write new quiet periods', async () => {
  const s = setup(account(settingsOf([overnight, lunch])));
  for (const value of ['24:00', '12:60', '1:00', 'noon']) await s.page.onDndStart(timeEvent(0, value));
  await s.page.onDndEnd(timeEvent(8, '13:00'));
  await s.page.onRemoveDndPeriod(indexEvent(-1));
  assert.equal(s.saves().length, 0);
  s.page.onUnload();
  await s.page.onAddDndPeriod(); await s.page.onDndStart(timeEvent(0, '22:00'));
  await s.page.onRemoveDndPeriod(indexEvent(1)); await s.page.onDndToggle({ detail: { value: false } });
  assert.equal(s.saves().length, 0);
});

test('night and lunch shortcuts preserve saved rows and avoid duplicate or invalid writes', async () => {
  const s = setup(account(settingsOf([overnight], false)));
  const preset = value => ({ currentTarget: { dataset: { preset: value } } });
  await s.page.onAddDndPreset(preset('night'));
  await s.page.onAddDndPreset(preset('unknown'));
  assert.equal(s.saves().length, 0);
  await s.page.onAddDndPreset(preset('lunch'));
  assert.deepEqual(s.saved().dnd.periods, [overnight, lunch]);
  assert.equal(s.saved().dnd.enabled, false, 'a preset never enables reminders without the switch');
  await s.page.onAddDndPreset(preset('lunch'));
  assert.equal(s.saves().length, 1);
  const full = setup(account(settingsOf(Array.from({ length: 8 }, (_, i) => ({ startMinute: i * 60, endMinute: i * 60 + 20 })))));
  await full.page.onAddDndPreset(preset('lunch'));
  assert.equal(full.saves().length, 0);
});

test('quiet status refresh is local, stops while hidden, and resumes after native authorization returns', async () => {
  const s = setup();
  s.rt.app.globalData.bootstrap = account();
  const timer = s.rt.timers.get(s.page.dndClockTimer);
  assert.ok(timer && timer.ms > 0 && timer.ms <= 60020);
  const calls = s.rt.calls.length;
  s.rt.timers.delete(s.page.dndClockTimer);
  await timer.fn();
  assert.equal(s.rt.calls.length, calls, 'the clock must never poll cloud services');
  s.page.onHide();
  assert.equal(s.page.dndClockTimer, null);
  s.page.nativePromptHiddenAt = Date.now();
  await s.page.onShow();
  assert.ok(s.rt.timers.has(s.page.dndClockTimer));
  assert.equal(s.rt.calls.length, calls, 'a short native return reuses the confirmed account');
  await s.page.onDndToggle({ detail: { value: false } });
  assert.equal(s.page.dndClockTimer, null);
  s.page.onUnload();
});
