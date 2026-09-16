import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');
const catalog = require('../miniprogram/config/catalog-seed.js');
const realMembership = require('../cloudfunctions/gxs_api/lib/rules/membership.js');
const realQuota = require('../cloudfunctions/gxs_api/lib/rules/quota.js');
const { applyObservation } = require('../cloudfunctions/gxs_api/lib/engine/events.js');
const parts = catalog.products.filter(p => p.supported).slice(0, 5).map(p => p.partNumber);
const stores = catalog.stores.slice(0, 4).map(s => s.storeNumber);
const copy = value => JSON.parse(JSON.stringify(value));

function sandbox(envVersion = 'develop') {
  let now = Date.parse('2026-09-15T02:00:00Z'), version = envVersion;
  const data = new Map([['real-user-cache', { balance: 123 }]]), writes = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: version } }), getStorageSync: key => data.has(key) ? copy(data.get(key)) : undefined,
    setStorageSync: (key, value) => { writes.push(key); data.set(key, copy(value)); }, removeStorageSync: key => data.delete(key) };
  const module = { exports: {} };
  const fixture = path.resolve(root, '../tests/helpers/acceptance-sandbox.js');
  vm.runInNewContext(fs.readFileSync(fixture, 'utf8'), { module, wx, Date: Clock, console, require: name => require(path.resolve(path.dirname(fixture), name)) });
  return { api: module.exports, data, writes, setVersion: value => { version = value; }, advance: ms => { now += ms; } };
}

test('acceptance stays off by default and release/trial builds ignore forged storage flags', async () => {
  const s = sandbox();
  assert.equal(s.api.isEnabled(), false);
  await assert.rejects(s.api.handle('user.bootstrap'), { code: 'acceptance_disabled' });
  s.api.configure('member');
  assert.equal(s.api.isEnabled(), true);
  for (const version of ['release', 'trial', undefined]) {
    s.setVersion(version);
    assert.equal(s.api.isAvailable(), false);
    assert.equal(s.api.isEnabled(), false);
    assert.throws(() => s.api.configure('member'), { code: 'acceptance_unavailable' });
    await assert.rejects(s.api.handle('user.bootstrap'), { code: 'acceptance_unavailable' });
  }
  assert.deepEqual(s.data.get('real-user-cache'), { balance: 123 });
  assert.ok(s.writes.every(key => key === 'gxs_acceptance_v1'));
});

test('free acceptance signup, charged history task, exhausted balance match production quota defaults', async () => {
  const { api } = sandbox(); api.configure('free');
  assert.deepEqual(copy(api.QUOTA), { ...realQuota.DEFAULT_CONFIG });
  assert.equal((await api.handle('user.bootstrap')).quota.balance, 0);
  assert.equal((await api.handle('quota.signin')).granted, 1);
  assert.equal((await api.handle('quota.signin')).granted, 0);
  const history = await api.handle('history.list', { historyQueryId: 'history-task-001', partNumber: parts[0], storeNumbers: [stores[0]], dayKey: '2026-09-14' });
  assert.equal(history.charged, 1); assert.equal(history.balance, 0);
  assert.equal((await api.handle('quota.completeTask', { taskId: 'view_history' })).granted, 1);
  assert.equal((await api.handle('quota.completeTask', { taskId: 'view_history' })).granted, 0);
  const query = await api.handle('query.pickup', { queryId: 'query-free-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  assert.equal(query.charged, 1); assert.equal(query.balance, 0);
  const denied = await api.handle('query.pickup', { queryId: 'query-free-002', partNumber: parts[0], storeNumbers: [stores[0]] });
  assert.equal(denied.reason, 'insufficient_credits');
  assert.equal((await api.handle('user.bootstrap')).quota.grantedToday, 2);
});

test('failed queries refund once and repeated request IDs cannot debit or change target twice', async () => {
  const { api } = sandbox(); api.configure({ mode: 'free', inventory: 'error' });
  await api.handle('quota.signin');
  const payload = { queryId: 'query-refund-001', partNumber: parts[0], storeNumbers: [stores[0]] };
  const first = await api.handle('query.pickup', payload);
  assert.equal(first.ok, false); assert.equal(first.refunded, 1); assert.equal(first.balance, 1);
  assert.equal((await api.handle('query.pickup', payload)).replayed, true);
  const ledger = await api.handle('quota.ledger');
  assert.equal(ledger.entries.filter(e => e.type === 'query_debit').length, 1);
  assert.equal(ledger.entries.filter(e => e.type === 'query_refund').length, 1);
  await assert.rejects(api.handle('query.pickup', { ...payload, partNumber: parts[1] }), { code: 'query_id_conflict' });
});

test('member queries need no payment or credits and share production three-by-three follow limits', async () => {
  const { api } = sandbox(); api.configure('member');
  assert.equal(api.LIMITS.maxFollows, realMembership.LIMITS.maxFollows);
  assert.equal(api.LIMITS.maxStoresPerFollow, realMembership.LIMITS.maxStoresPerFollow);
  const query = await api.handle('query.pickup', { queryId: 'member-query-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  assert.equal(query.ok, true); assert.equal(query.charged, 0); assert.equal(query.balance, 0);
  const created = [];
  for (let i = 0; i < 3; i++) {
    const candidate = { followId: `follow-member-${i}`, partNumber: parts[i], storeNumbers: stores.slice(0, 3) };
    assert.equal(realMembership.validateFollowLimits(created, candidate).ok, true);
    await api.handle('follow.upsert', candidate); created.push(candidate);
  }
  const fourth = { followId: 'follow-member-4', partNumber: parts[3], storeNumbers: [stores[0]] };
  assert.equal(realMembership.validateFollowLimits(created, fourth).reason, 'too_many_follows');
  await assert.rejects(api.handle('follow.upsert', fourth), { code: 'too_many_follows' });
  await assert.rejects(api.handle('follow.upsert', { ...created[0], storeNumbers: stores }), { code: 'too_many_stores' });
  assert.equal((await api.handle('follow.list')).follows.length, 3);
  assert.equal((await api.handle('member.createOrder')).reason, 'payment_not_enabled');
});

test('membership expiration preserves follows but stops monitoring, resume and new follows', async () => {
  const s = sandbox(), { api } = s; api.configure('member');
  await api.handle('follow.upsert', { followId: 'expiry-follow-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  s.advance(31 * 86400000);
  assert.equal((await api.handle('user.bootstrap')).membership.active, false);
  const list = await api.handle('follow.list');
  assert.equal(list.follows[0].status, 'expired'); assert.equal(list.follows[0].savedStatus, 'active');
  await assert.rejects(api.handle('follow.resume', { followId: 'expiry-follow-001' }), { code: 'member_required' });
  await assert.rejects(api.handle('follow.upsert', { followId: 'expiry-follow-002', partNumber: parts[1], storeNumbers: [stores[0]] }), { code: 'member_required' });
  api.simulateRestock();
  assert.equal(api.getStatus().events, 0);
  assert.equal((await api.handle('notify.list')).notifications[0].reason, 'member_expired');
});

test('simulated authorization, do-not-disturb, restock history and cooldown never report WeChat delivery', async () => {
  const { api } = sandbox(); api.configure('member');
  await api.handle('follow.upsert', { followId: 'notify-follow-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  const authorization = { requestId: 'notify-authorization-001', results: { [api.TEMPLATE_ID]: 'accept' } };
  await api.handle('notify.recordSubscription', authorization); await api.handle('notify.recordSubscription', authorization);
  assert.equal(api.getStatus().subscriptionCredits, 1);
  await api.handle('user.updateSettings', { dnd: { enabled: true, startMinute: 0, endMinute: 0 } });
  api.simulateRestock();
  assert.equal((await api.handle('notify.list')).notifications[0].reason, 'dnd');
  assert.equal(api.getStatus().subscriptionCredits, 1);
  await api.handle('user.updateSettings', { dnd: { enabled: false, startMinute: 0, endMinute: 0 } });
  api.simulateRestock();
  const delivered = (await api.handle('notify.list')).notifications[0];
  assert.equal(delivered.status, 'simulated'); assert.equal(delivered.sentAt, null); assert.match(delivered.productTitle, /验收模拟/);
  assert.equal(api.getStatus().subscriptionCredits, 0);
  await api.handle('notify.recordSubscription', { ...authorization, requestId: 'notify-authorization-002' });
  api.simulateRestock();
  assert.equal((await api.handle('notify.list')).notifications[0].reason, 'cooldown');
  assert.equal(api.getStatus().subscriptionCredits, 1);
  const history = await api.handle('history.list', { historyQueryId: 'history-notify-001', partNumber: parts[0], storeNumbers: [stores[0]], dayKey: '2026-09-15' });
  assert.ok(history.summary.restocks >= 1); assert.ok(history.events.every(e => e.source === '验收模拟'));
});

test('new product limitations differ by identity and history date without exposing restricted latest data', async () => {
  const { api } = sandbox(); api.configure({ mode: 'free', restrictNewProducts: true });
  await api.handle('quota.signin');
  const product = catalog.products.find(p => p.familyKey === catalog.families[0].familyKey && p.supported);
  const base = { partNumber: product.partNumber, storeNumbers: [stores[0]] };
  assert.equal((await api.handle('query.pickup', { ...base, queryId: 'new-product-query-001' })).reason, 'new_product_restricted');
  assert.equal((await api.handle('history.list', { ...base, historyQueryId: 'new-history-today-001', dayKey: '2026-09-15' })).reason, 'new_product_history_restricted');
  const yesterday = await api.handle('history.list', { ...base, historyQueryId: 'new-history-old-001', dayKey: '2026-09-14' });
  assert.equal(yesterday.ok, true); assert.equal(yesterday.latestRestricted, true); assert.equal(yesterday.latest.length, 0);
  api.configure('member');
  assert.equal((await api.handle('query.pickup', { ...base, queryId: 'new-member-query-001' })).ok, true);
});

test('reset and exit isolate all acceptance data and unsupported/admin actions fail closed', async () => {
  const s = sandbox(), { api } = s; api.configure('member');
  await api.handle('follow.upsert', { followId: 'reset-follow-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  s.data.set('acceptance_gxs_query_result_v1', { old: true });
  s.data.set('acceptance_gxs_pending_q_v1', { stale: true });
  for (const action of ['admin.stats', 'admin.grantMembership', 'unknown.action']) await assert.rejects(api.handle(action));
  api.reset();
  const status = api.getStatus();
  assert.equal(status.enabled, true); assert.equal(status.mode, 'free'); assert.equal(status.follows, 0); assert.equal(status.quota.balance, 0);
  assert.equal(s.data.has('acceptance_gxs_query_result_v1'), false);
  assert.equal(s.data.has('acceptance_gxs_pending_q_v1'), false);
  api.disable(); assert.equal(api.isEnabled(), false);
  assert.deepEqual(s.data.get('real-user-cache'), { balance: 123 });
  assert.ok(s.writes.every(key => key === 'gxs_acceptance_v1'));
});

test('history acceptance paginates a frozen snapshot with exact totals, tied timestamps and one charge', async () => {
  const { api } = sandbox(); api.configure('member');
  await api.handle('follow.upsert', { followId: 'paging-follow-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  for (let i = 0; i < 150; i++) api.simulateRestock();
  api.configure('free'); await api.handle('quota.signin');
  const request = { historyQueryId: 'paging-history-001', partNumber: parts[0], storeNumbers: [stores[0]], dayKey: '2026-09-15', limit: 80 };
  const first = await api.handle('history.list', request);
  assert.equal(first.events.length, 80); assert.equal(first.pagination.total, 299); assert.equal(first.pagination.hasMore, true);
  assert.equal(first.charged, 1); assert.equal(first.balance, 0); assert.equal(first.summary.restocks, 150);
  const retry = await api.handle('history.list', request);
  assert.equal(retry.replayed, true); assert.deepEqual(copy(retry.events), copy(first.events));
  api.configure('member'); api.simulateRestock(); api.configure('free');
  let cursor = first.pagination.nextCursor;
  const ids = first.events.map(e => e.id);
  do {
    const page = await api.handle('history.list', { ...request, cursor });
    assert.equal(page.pagination.total, first.pagination.total);
    assert.equal(page.pagination.snapshotAt, first.pagination.snapshotAt);
    assert.deepEqual(copy(page.summary), copy(first.summary));
    ids.push(...page.events.map(e => e.id)); cursor = page.pagination.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 299); assert.equal(new Set(ids).size, 299);
  assert.equal((await api.handle('quota.ledger')).entries.filter(e => e.type === 'history_debit').length, 1);
  await assert.rejects(api.handle('history.list', { ...request, dayKey: '2026-09-14' }), { code: 'query_id_conflict' });
  await assert.rejects(api.handle('history.list', { ...request, cursor: 'invalid-cursor' }), { code: 'invalid_cursor' });
});

test('history replay rechecks new-product access and never restores restricted live stock after membership expires', async () => {
  const { api } = sandbox(); api.configure({ mode: 'member', inventory: 'available', restrictNewProducts: true });
  const product = catalog.products.find(p => p.familyKey === catalog.families[0].familyKey && p.supported);
  const base = { partNumber: product.partNumber, storeNumbers: [stores[0]] };
  await api.handle('query.pickup', { ...base, queryId: 'history-permission-live' });
  await api.handle('follow.upsert', { ...base, followId: 'history-permission-follow' });
  const ordinary = catalog.products.find(p => p.supported && p.familyKey !== product.familyKey);
  await api.handle('follow.upsert', { followId: 'ordinary-expiry-follow', partNumber: ordinary.partNumber, storeNumbers: [stores[0]] });
  await api.handle('query.pickup', { queryId: 'ordinary-expiry-query', partNumber: ordinary.partNumber, storeNumbers: [stores[0]] });
  const request = { ...base, historyQueryId: 'history-permission-001', dayKey: '2026-09-14' };
  assert.equal((await api.handle('history.list', request)).latest[0].status, 'available');
  const todayRequest = { ...base, historyQueryId: 'history-permission-002', dayKey: '2026-09-15' };
  await api.handle('history.list', todayRequest);
  api.configure('expired');
  const replay = await api.handle('history.list', request);
  assert.equal(replay.replayed, true); assert.equal(replay.latestRestricted, true); assert.equal(replay.latest.length, 0);
  assert.equal((await api.handle('history.list', todayRequest)).reason, 'new_product_history_restricted');
  const follows = (await api.handle('follow.list')).follows;
  const protectedFollow = follows.find(f => f.partNumber === product.partNumber);
  assert.equal(protectedFollow.latestRestricted, true); assert.equal(protectedFollow.stores[0].status, 'unknown');
  for (const key of ['lastKnownStatus', 'statusSince', 'observedAt', 'unknownSince', 'quote']) assert.equal(protectedFollow.stores[0][key], null, key);
  const ordinaryFollow = follows.find(f => f.partNumber === ordinary.partNumber);
  assert.equal(ordinaryFollow.status, 'expired'); assert.equal(ordinaryFollow.latestRestricted, false); assert.equal(ordinaryFollow.stores[0].status, 'available');
});

test('unknown and failed acceptance observations preserve known status, emit no event and refund like production', async () => {
  const s = sandbox(), { api } = s; api.configure({ mode: 'free', inventory: 'unknown' }); await api.handle('quota.signin');
  const unknown = await api.handle('query.pickup', { queryId: 'unknown-refund-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  assert.equal(unknown.ok, false); assert.equal(unknown.charged, 1); assert.equal(unknown.refunded, 1); assert.equal(unknown.balance, 1);
  assert.equal(unknown.results[0].events.length, 0);
  api.configure({ mode: 'member', inventory: 'unavailable' });
  await api.handle('follow.upsert', { followId: 'unknown-follow-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  let previous = null, index = 0;
  for (const status of ['unavailable', 'unknown', 'available', 'error', 'unavailable', 'available']) {
    s.advance(1000); api.configure({ inventory: status });
    const query = await api.handle('query.pickup', { queryId: `unknown-sequence-${++index}`, partNumber: parts[0], storeNumbers: [stores[0]] });
    const result = query.results[0];
    const actual = applyObservation(previous, { storeNumber: stores[0], partNumber: parts[0], status: status === 'error' ? 'unknown' : status, observedAt: result.observedAt });
    previous = actual.latest;
    assert.deepEqual(copy(result.events.map(e => e.type)), actual.events.map(e => e.type), status);
    const stored = s.data.get('gxs_acceptance_v1').latest[`${parts[0]}|${stores[0]}`];
    assert.equal(stored.status, actual.latest.status, status);
  }
  s.advance(300001);
  const stale = (await api.handle('follow.list')).follows[0].stores[0];
  assert.equal(stale.status, 'unknown'); assert.equal(stale.lastKnownStatus, 'available'); assert.equal(stale.isStale, true);
});

test('access denial can retry after sign-in and evicted acceptance responses cannot charge the same ID again', async () => {
  const { api } = sandbox(); api.configure('free');
  const request = { historyQueryId: 'denied-retry-001', partNumber: parts[0], storeNumbers: [stores[0]], dayKey: '2026-09-15' };
  assert.equal((await api.handle('history.list', request)).reason, 'insufficient_credits');
  await api.handle('quota.signin');
  assert.equal((await api.handle('history.list', request)).ok, true);
  api.configure('member');
  for (let i = 0; i < 201; i++) await api.handle('query.pickup', { queryId: `eviction-query-${i}`, partNumber: parts[0], storeNumbers: [stores[0]] });
  api.configure('free');
  await assert.rejects(api.handle('history.list', request), { code: 'acceptance_snapshot_expired' });
  assert.equal((await api.handle('quota.ledger')).entries.filter(e => e.type === 'history_debit').length, 1);
  assert.equal((await api.handle('quota.completeTask', { taskId: 'view_history' })).granted, 1, 'eviction preserves the server-like daily completion proof');
});

test('acceptance reminder pagination and single deletion preserve the internal record and newer arrivals', async () => {
  const { api, data } = sandbox(); api.configure('member');
  await api.handle('follow.upsert', { followId: 'reminder-paging-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  for (let i = 0; i < 45; i++) api.simulateRestock();
  const first = await api.handle('notify.list', { limit: 7 });
  assert.equal(first.notifications.length, 7); assert.equal(first.hasMore, true);
  const deletedId = first.notifications[0].id;
  assert.deepEqual(copy(await api.handle('notify.delete', { id: deletedId })), { deleted: true });
  await api.handle('notify.delete', { id: deletedId });
  assert.equal(data.get('gxs_acceptance_v1').notifications.length, 45);
  const fresh = await api.handle('notify.list', { limit: 7 });
  api.simulateRestock(); // The same millisecond, but after the list snapshot.
  const seen = fresh.notifications.map(n => n.id); let cursor = fresh.nextCursor;
  while (cursor) {
    const next = await api.handle('notify.list', { limit: 7, cursor });
    assert.equal(next.clearBefore, fresh.clearBefore);
    seen.push(...next.notifications.map(n => n.id)); cursor = next.nextCursor;
  }
  assert.equal(seen.length, 44); assert.equal(new Set(seen).size, 44); assert.equal(seen.includes(deletedId), false);
  const all = await api.handle('notify.list', { limit: 100 });
  assert.equal(all.notifications.length, 45);
  assert.equal(all.notifications.filter(n => !seen.includes(n.id)).length, 1);
});

test('acceptance clear removes all snapshot reminders, retains same-time arrivals, follows, events and cooldown', async () => {
  const { api, data } = sandbox(); api.configure('member');
  await api.handle('follow.upsert', { followId: 'reminder-clear-001', partNumber: parts[0], storeNumbers: [stores[0]] });
  await api.handle('notify.recordSubscription', { requestId: 'reminder-credit-001', results: { [api.TEMPLATE_ID]: 'accept' } });
  api.simulateRestock();
  const successfulId = (await api.handle('notify.list')).notifications[0].id;
  await api.handle('notify.delete', { id: successfulId });
  for (let i = 0; i < 39; i++) api.simulateRestock();
  const first = await api.handle('notify.list', { limit: 20 });
  assert.equal(first.hasMore, true);
  const storedBefore = data.get('gxs_acceptance_v1');
  await api.handle('notify.recordSubscription', { requestId: 'reminder-credit-002', results: { [api.TEMPLATE_ID]: 'accept' } });
  api.simulateRestock();
  await api.handle('notify.clear', { before: first.clearBefore });
  await api.handle('notify.clear', { before: first.clearBefore });
  const after = await api.handle('notify.list');
  assert.equal(after.notifications.length, 1); assert.equal(after.notifications[0].reason, 'cooldown');
  assert.equal(api.getStatus().subscriptionCredits, 1);
  assert.deepEqual(copy(data.get('gxs_acceptance_v1').follows), copy(storedBefore.follows));
  assert.ok(data.get('gxs_acceptance_v1').events.length >= storedBefore.events.length);
  await api.handle('notify.clear', { before: after.clearBefore });
  assert.equal((await api.handle('notify.list')).notifications.length, 0);
  await api.handle('notify.clear', { before: first.clearBefore }); // Cannot roll the watermark backwards.
  assert.equal((await api.handle('notify.list')).notifications.length, 0);
  for (let i = 0; i < 110; i++) api.simulateRestock();
  assert.equal((await api.handle('notify.list')).notifications[0].reason, 'cooldown', 'history retention does not disable cooldown');
});

test('acceptance reminder management rejects invalid IDs, future ranges and malformed cursors without changing records', async () => {
  const { api, data } = sandbox(); api.configure('member');
  await api.handle('follow.upsert', { followId: 'reminder-invalid-001', partNumber: parts[0], storeNumbers: [stores[0]] }); api.simulateRestock();
  const before = copy(data.get('gxs_acceptance_v1'));
  for (const id of [undefined, '', ' ', 123, 'x'.repeat(1025)]) await assert.rejects(api.handle('notify.delete', { id }), { code: 'invalid_notification_id' });
  await assert.rejects(api.handle('notify.delete', { id: 'another-users-reminder' }), { code: 'notification_not_found' });
  await assert.rejects(api.handle('notify.list', { cursor: 'bad' }), { code: 'invalid_cursor' });
  await assert.rejects(api.handle('notify.clear', { before: 'bad' }), { code: 'invalid_clear_before' });
  const token = (await api.handle('notify.list')).clearBefore;
  const future = { ...JSON.parse(decodeURIComponent(token)), snapshotAt: new Date(Date.now() + 60000).toISOString() };
  await assert.rejects(api.handle('notify.clear', { before: encodeURIComponent(JSON.stringify(future)) }), { code: 'invalid_clear_before' });
  await assert.rejects(api.handle('notify.list', { cursor: encodeURIComponent(JSON.stringify({ ...future, createdAt: new Date().toISOString(), id: 'test' })) }), { code: 'invalid_cursor' });
  const forged = JSON.parse(decodeURIComponent(token)); forged.sequence += 1;
  await assert.rejects(api.handle('notify.clear', { before: encodeURIComponent(JSON.stringify(forged)) }), { code: 'invalid_clear_before' });
  assert.deepEqual(copy(data.get('gxs_acceptance_v1')), before);
});
