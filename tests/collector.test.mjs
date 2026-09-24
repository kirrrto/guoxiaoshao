import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMemoryRepo } from './helpers/memory-repo.mjs';
import { fakeFetch, PRODUCTS, STORES } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector.js');
const { buildTasks, buildMessage } = require('../cloudfunctions/gxs_api/lib/engine/notifier.js');
const { COLLECTIONS } = require('../cloudfunctions/gxs_api/lib/collections.js');

const T0 = '2026-09-15T02:00:00.000Z'; // 10:00 Beijing
const member = (key, openid, extra = {}) => ({
  _id: key, appid: 'wxe96ad9e77b602f1b', openid, membership: { expiresAt: '2026-10-15T00:00:00.000Z' },
  quota: { balance: 0 }, settings: { notifyEnabled: true, dnd: { enabled: false, startMinute: 0, endMinute: 0 } },
  subscriptions: { TPL_RESTOCK: { credits: 1 } }, ...extra,
});
const follow = (id, userKey, partNumber, storeNumbers, status = 'active') => ({ _id: `${userKey}|${id}`, userKey, partNumber, storeNumbers, status, productTitle: partNumber, createdAt: T0 });

function setup({ collectorEnabled = true, notificationsEnabled = true } = {}) {
  const repo = createMemoryRepo({
    [COLLECTIONS.catalogProducts]: PRODUCTS,
    [COLLECTIONS.catalogStores]: STORES,
    [COLLECTIONS.config]: [{ _id: 'runtime', collector: { enabled: collectorEnabled, intervalSeconds: 1 }, notifications: { enabled: notificationsEnabled, templateIds: { restock: 'TPL_RESTOCK' } } }],
    [COLLECTIONS.users]: [
      member('A', 'openid-A'),
      member('B', 'openid-B'),
      member('C', 'openid-C', { settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 9 * 60, endMinute: 11 * 60 } } }),
      member('D', 'openid-D', { subscriptions: {} }),
      // Expired and already alerted once, so the free alert does not apply.
      member('E', 'openid-E', { membership: { expiresAt: '2026-09-01T00:00:00.000Z' }, firstReminderSentAt: '2026-08-20T00:00:00.000Z' }),
    ],
    [COLLECTIONS.follows]: [
      follow('f1', 'A', 'MJYH4CH/A', ['R577', 'R639']),
      follow('f2', 'A', 'MXXX1CH/A', ['R577']),
      follow('f3', 'B', 'MJYH4CH/A', ['R577']),
      follow('f4', 'B', 'MXXX1CH/A', ['R577'], 'paused'),
      follow('f5', 'C', 'MJYH4CH/A', ['R577']),
      follow('f6', 'D', 'MJYH4CH/A', ['R577']),
      follow('f7', 'E', 'MJYH4CH/A', ['R320']),
    ],
  });
  const state = { nowMs: Date.parse(T0), display: 'unavailable' };
  const fetchImpl = fakeFetch(storeNumber => ({ display: state.display, storeName: STORES.find(s => s.storeNumber === storeNumber).name }));
  const sends = [];
  const collector = createCollector({
    repo, fetchImpl, clock: () => new Date(state.nowMs), log: { info() {}, warn() {}, error() {} },
    sendImpl: async message => { sends.push(message); return { errCode: 0 }; },
    ownerId: 'collector-test-1', refreshEveryMs: 10000, statusEveryMs: 0,
  });
  const run = async () => { const { started } = await collector.step(); await Promise.all(started); };
  return { repo, state, fetchImpl, sends, collector, run, advance: ms => { state.nowMs += ms; } };
}

test('collector only targets active follows of active members and merges same-store SKUs', async () => {
  const s = setup();
  const summary = await s.collector.refreshTargets();
  assert.deepEqual(summary, { follows: 6, eligible: 5, groups: 2, enabled: true });
  const snap = s.collector.scheduler.snapshot();
  assert.deepEqual(snap.targets.map(t => [t.storeNumber, t.partNumbers]), [['R577', ['MJYH4CH/A', 'MXXX1CH/A']], ['R639', ['MJYH4CH/A']]]);
});

test('collector runs the loop: observations → events → deduped notification tasks → one send per user', async () => {
  const s = setup();
  await s.run();
  assert.equal(s.fetchImpl.calls.length, 2);
  assert.deepEqual(s.fetchImpl.calls.map(c => c.parts), [['MJYH4CH/A', 'MXXX1CH/A'], ['MJYH4CH/A']]);
  let latest = await s.repo.getLatest(['R577|MJYH4CH/A']);
  assert.equal(latest[0].status, 'unavailable');
  assert.equal(latest[0].source, 'auto');
  assert.equal((await s.repo.count(COLLECTIONS.events)).valueOf(), 0);

  s.advance(1000);
  s.state.display = 'available';
  await s.run();
  assert.equal(s.sends.length, 0, 'a new status waits for one confirming re-check');
  s.advance(1000);
  await s.run();
  const events = [...s.repo.tables.get(COLLECTIONS.events).values()];
  assert.deepEqual(events.map(e => [e.storeNumber, e.partNumber, e.type]).sort(), [
    ['R577', 'MJYH4CH/A', 'restock_confirmed'], ['R577', 'MXXX1CH/A', 'restock_confirmed'], ['R639', 'MJYH4CH/A', 'restock_confirmed'],
  ]);
  const tasks = [...s.repo.tables.get(COLLECTIONS.notifications).values()];
  const byKey = Object.fromEntries(tasks.map(t => [`${t.userKey}:${t.storeNumber}:${t.partNumber}`, `${t.status}${t.reason ? ':' + t.reason : ''}`]));
  assert.equal(Object.keys(byKey).length, 6, 'one task per user per event, overlapping follows collapse');
  const userA = Object.entries(byKey).filter(([k]) => k.startsWith('A:')).map(([, v]) => v).sort();
  assert.deepEqual(userA, ['accepted', 'skipped:no_subscription_credit', 'skipped:no_subscription_credit'], 'a single subscription credit yields exactly one send');
  assert.equal(byKey['B:R577:MJYH4CH/A'], 'accepted');
  assert.equal(byKey['C:R577:MJYH4CH/A'], 'skipped:dnd');
  assert.equal(byKey['D:R577:MJYH4CH/A'], 'skipped:no_subscription_credit');
  assert.equal(s.sends.length, 2);
  assert.deepEqual(s.sends.map(m => m.touser).sort(), ['openid-A', 'openid-B']);
  assert.equal(s.sends[0].templateId, 'TPL_RESTOCK');
  assert.equal(s.sends[0].data.thing4.value, '确认补货');
  assert.ok(['天环广场', '珠江新城'].includes(s.sends[0].data.thing2.value));
  assert.equal(s.sends.find(m => m.touser === 'openid-B').data.thing2.value, '天环广场');
  const storedA = await s.repo.getUser('A');
  assert.equal(storedA.subscriptions.TPL_RESTOCK.credits, 0, 'one-time subscription credit is consumed');

  s.advance(1000);
  await s.run();
  assert.equal([...s.repo.tables.get(COLLECTIONS.events).values()].length, 3, 'steady availability creates no new events');
  assert.equal(s.sends.length, 2);
  const status = await s.repo.getCollectorStatus();
  assert.equal(status.state, 'running');
  assert.equal(status.groupCount, 2);
  assert.equal(s.collector.stats.batches, 8, 'four runs over two stores, including the confirming re-check');
  assert.ok(status.stats.batches >= 4, 'status is published at the start of a step, before that step\'s batches land');
  assert.equal(status.stats.sent, 2);
  // The heartbeat taken at step start only includes completed requests. Publish
  // after drain to inspect this round's actual network calls (not dispatches).
  await s.collector.publishStatus();
  const targets = s.collector.scheduler.snapshot().targets;
  assert.ok(targets.length >= 2);
  assert.equal(targets.find(t => t.storeNumber === 'R577').health.requests, 4);
  assert.equal((s.repo.tables.get(COLLECTIONS.health) || new Map()).size, 0, 'status publishing no longer writes one health document per target per minute');
});

test('a second collector cannot take the lease while the first renews it; it takes over after expiry', async () => {
  const s = setup();
  await s.run();
  const other = createCollector({ repo: s.repo, fetchImpl: s.fetchImpl, clock: () => new Date(s.state.nowMs), log: { info() {}, warn() {}, error() {} }, ownerId: 'collector-test-2', statusEveryMs: 0 });
  const blocked = await other.step();
  assert.equal(blocked.held, false);
  assert.equal((await s.repo.getCollectorStatus()).state, 'running', 'standby must not overwrite the active collector status');
  assert.equal((await s.repo.getCollectorStatus()).ownerId, 'collector-test-1');
  s.advance(16000);
  const taken = await other.step();
  assert.equal(taken.held, true);
  await Promise.all(taken.started);
  const lost = await s.collector.step();
  assert.equal(lost.held, false, 'the original owner must stop once the lease moved');
  await other.stop();
});

test('collector switch off empties the target set without touching follows', async () => {
  const s = setup({ collectorEnabled: false });
  await s.run();
  assert.equal(s.fetchImpl.calls.length, 0);
  assert.equal(s.collector.scheduler.snapshot().state, 'idle');
  assert.equal((await s.repo.listActiveFollows()).length, 6);
});

test('notifier explains every skipped delivery and never sends when notifications are disabled', () => {
  const now = new Date(T0);
  const users = new Map([['A', member('A', 'openid-A')], ['E', member('E', 'openid-E', { membership: { expiresAt: '2026-09-01T00:00:00.000Z' }, firstReminderSentAt: '2026-08-20T00:00:00.000Z' })]]);
  const follows = [follow('f1', 'A', 'MJYH4CH/A', ['R577']), follow('f1b', 'A', 'MJYH4CH/A', ['R577', 'R639']), follow('f7', 'E', 'MJYH4CH/A', ['R577'])];
  const event = { _id: 'R577|MJYH4CH/A|restock_confirmed|' + T0, type: 'restock_confirmed', partNumber: 'MJYH4CH/A', storeNumber: 'R577', storeName: '天环广场', productTitle: 'iPhone 18 Pro Max 1TB 勃艮第酒红色', detectedAt: T0 };
  const config = { notifications: { enabled: true, templateIds: { restock: 'TPL_RESTOCK' } } };
  const tasks = buildTasks({ events: [event, { ...event, _id: 'x', type: 'became_unavailable' }], follows, users, config, now });
  assert.deepEqual(tasks.map(t => [t.userKey, t.status, t.reason]), [['A', 'pending', null], ['E', 'skipped', 'member_expired']]);
  const disabled = buildTasks({ events: [event], follows, users, config: { notifications: { enabled: false, templateIds: { restock: 'TPL_RESTOCK' } } }, now });
  assert.deepEqual(disabled.map(t => t.reason), ['notifications_disabled', 'notifications_disabled']);
  const message = buildMessage(tasks[0], config);
  assert.equal(message.data.time3.value, '2026年9月15日 10:00:00');
  assert.equal(message.data.thing1.value.length <= 20, true);
});
