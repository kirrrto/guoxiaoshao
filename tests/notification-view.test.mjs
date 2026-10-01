import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';
import { createRequire } from 'node:module';
import { createFixture, userContext, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const { encodeToken } = require('../cloudfunctions/gxs_api/lib/notification-view.js');
const { sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier.js');
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo.js');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const task = (id, createdAt = '2026-09-15T02:00:00.000Z', userKey = userKeyOf()) => ({ _id: id, userKey, status: 'pending', createdAt, detectedAt: createdAt, eventType: 'restock_confirmed', partNumber: 'MXXX1CH/A', storeNumber: 'R577', followId: 'F', templateId: 'TPL', attempts: 0 });

test('notification deletion is owner-only, idempotent and preserves the internal task', async () => {
  const f = createFixture();
  await f.repo.saveNotification(task('own'));
  await f.repo.saveNotification(task('other', undefined, userKeyOf('another')));
  assert.equal((await f.call('notify.delete', { id: 'other' })).error.code, 'notification_not_found');
  assert.equal((await f.call('notify.delete', { id: 'missing' })).error.code, 'notification_not_found');
  for (const id of [{}, '', '   ', 'x'.repeat(1025)]) assert.equal((await f.call('notify.delete', { id })).error.code, 'invalid_notification_id');
  for (let i = 0; i < 2; i++) assert.equal(ok(await f.call('notify.delete', { id: 'own' })).deleted, true);
  assert.deepEqual(ok(await f.call('notify.list')).notifications, []);
  const stored = (await f.repo.listNotifications(userKeyOf()))[0];
  assert.equal(stored.status, 'pending'); assert.ok(stored.userHiddenAt);
  assert.equal(await f.repo.saveNotification(task('own')), false, 'replanning the same event cannot recreate a hidden task');
  assert.equal((await f.repo.listPendingNotifications()).length, 2);
  assert.equal(ok(await f.call('notify.list', {}, userContext('another'))).notifications[0].id, 'other');
});

test('notification keyset pages cover more than 100 tied records and ignore later inserts and hidden rows', async () => {
  const f = createFixture();
  await Promise.all(Array.from({ length: 307 }, (_, i) => f.repo.saveNotification(task(`notice-${String(i).padStart(4, '0')}`))));
  for (const id of ['notice-0306', 'notice-0150', 'notice-0000']) ok(await f.call('notify.delete', { id }));
  let page = ok(await f.call('notify.list', { limit: 100 }));
  const first = page, ids = page.notifications.map(n => n.id);
  assert.equal(page.notifications.length, 100); assert.equal(page.hasMore, true);
  assert.ok(page.notifications.every(n => !('viewSequence' in n) && !('userHiddenAt' in n)));
  await f.repo.saveNotification(task('same-millisecond-later'));
  while (page.hasMore) {
    page = ok(await f.call('notify.list', { limit: 100, cursor: page.nextCursor }));
    assert.equal(page.clearBefore, first.clearBefore);
    ids.push(...page.notifications.map(n => n.id));
  }
  assert.equal(ids.length, 304); assert.equal(new Set(ids).size, 304);
  assert.ok(!ids.includes('same-millisecond-later'));
  assert.equal(page.nextCursor, null);
  assert.ok(ok(await f.call('notify.list')).notifications.some(n => n.id === 'same-millisecond-later'));
});

test('clear removes all legacy pages and keeps newly inserted records even when their event time is old', async () => {
  const f = createFixture();
  for (let i = 0; i < 225; i++) f.repo.insert(C.notifications, task(`legacy-${i}`, '2026-09-14T02:00:00.000Z'));
  const page = ok(await f.call('notify.list', { limit: 20 }));
  assert.equal(page.notifications.length, 20); assert.equal(page.hasMore, true);
  await f.repo.saveNotification(task('delayed-new-task', '2026-09-13T02:00:00.000Z'));
  assert.equal(ok(await f.call('notify.clear', { before: page.clearBefore })).cleared, true);
  const remaining = ok(await f.call('notify.list')).notifications;
  assert.deepEqual(remaining.map(n => n.id), ['delayed-new-task']);
  assert.equal((await f.repo.listNotifications(userKeyOf(), Infinity)).length, 226);
  assert.equal((await f.repo.listPendingNotifications({ limit: 500 })).length, 226);
});

test('request-time arrivals use one sequence boundary for pages and clear while legacy rows keep the time boundary', async () => {
  const f = createFixture();
  await f.repo.saveNotification(task('old'));
  const getView = f.repo.getNotificationView;
  let inject = true;
  f.repo.getNotificationView = async userKey => {
    if (inject) {
      inject = false;
      // Both arrive after ctx.nowIso but before the view sequence is read.
      await f.repo.saveNotification(task('before-view', '2026-09-15T02:00:00.001Z'));
      f.repo.insert(C.notifications, task('legacy-after-time', '2026-09-15T02:00:00.001Z'));
    }
    return getView(userKey);
  };
  const first = ok(await f.call('notify.list', { limit: 1 }));
  assert.deepEqual(first.notifications.map(n => n.id), ['before-view']);
  assert.equal(first.hasMore, true);
  // A later insertion with an old event date must stay outside this snapshot.
  await f.repo.saveNotification(task('after-view', '2026-09-14T02:00:00.000Z'));
  const second = ok(await f.call('notify.list', { limit: 1, cursor: first.nextCursor }));
  assert.deepEqual(second.notifications.map(n => n.id), ['old']);
  assert.equal(second.hasMore, false); assert.equal(second.clearBefore, first.clearBefore);
  f.advance(10);
  ok(await f.call('notify.clear', { before: first.clearBefore }));
  assert.deepEqual(ok(await f.call('notify.list')).notifications.map(n => n.id), ['legacy-after-time', 'after-view']);
  assert.equal((await f.repo.listNotifications(userKeyOf(), Infinity)).length, 4);
});

test('concurrent clear and insert preserve new arrivals, and watermarks never move backwards', async () => {
  for (const insertFirst of [false, true]) {
    const f = createFixture(); await f.repo.saveNotification(task('old'));
    const first = ok(await f.call('notify.list'));
    const insert = () => f.repo.saveNotification(task('new-at-same-time'));
    const clear = () => f.call('notify.clear', { before: first.clearBefore });
    await Promise.all(insertFirst ? [insert(), clear()] : [clear(), insert()]);
    assert.deepEqual(ok(await f.call('notify.list')).notifications.map(n => n.id), ['new-at-same-time']);
    const second = ok(await f.call('notify.list'));
    await Promise.all([f.call('notify.clear', { before: second.clearBefore }), f.call('notify.clear', { before: first.clearBefore })]);
    assert.deepEqual(ok(await f.call('notify.list')).notifications, []);
    await f.repo.saveNotification(task('after-both-clears'));
    ok(await f.call('notify.clear', { before: first.clearBefore }));
    assert.deepEqual(ok(await f.call('notify.list')).notifications.map(n => n.id), ['after-both-clears']);
  }
});

test('clear and page tokens reject tampering, other users, wrong purposes, future times and unknown sequences', async () => {
  const f = createFixture();
  await f.repo.saveNotification(task('one')); await f.repo.saveNotification(task('two'));
  const page = ok(await f.call('notify.list', { limit: 1 }));
  assert.equal((await f.call('notify.clear', { before: page.clearBefore }, userContext('another'))).error.code, 'invalid_clear_before');
  assert.equal((await f.call('notify.list', { cursor: page.nextCursor }, userContext('another'))).error.code, 'invalid_cursor');
  const view = await f.repo.getNotificationView(userKeyOf());
  const [body, signature] = page.clearBefore.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), sequence: 9999 })).toString('base64url');
  const bad = [null, '', `${forged}.${signature}`, page.nextCursor,
    encodeToken('clear', { at: '2026-09-16T02:00:00.000Z', sequence: 1 }, view),
    encodeToken('clear', { at: f.state.now.toISOString(), sequence: 9999 }, view)];
  for (const before of bad) assert.equal((await f.call('notify.clear', { before })).error.code, 'invalid_clear_before');
  assert.equal((await f.call('notify.list', { cursor: page.clearBefore })).error.code, 'invalid_cursor');
  assert.equal(ok(await f.call('notify.list')).notifications.length, 2);
  assert.equal((await f.repo.getNotificationView(userKeyOf())).clearedThroughSequence, 0);
});

test('hiding and clearing an in-flight notification do not cancel delivery, refund its credit or reset dedupe/cooldown', async () => {
  const config = { notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 30 } };
  const f = createFixture({ config }); ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00.000Z' }, subscriptions: { TPL: { credits: 2 } } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], status: 'active' });
  const first = task('in-flight'); await f.repo.saveNotification(first);
  await seedNotificationObservation(f.repo, first);
  const cutoff = ok(await f.call('notify.list')).clearBefore;
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let sends = 0; const sender = async () => { sends++; entered(); await gate; return { errcode: 0 }; }; sender.appid = CONSUMER_APPID;
  const send = value => sendTask({ task: value, config, repo: f.repo, sendImpl: sender, now: f.state.now, clock: () => f.state.now, ownerId: 'notification-view-test' });
  const running = send(first); await started;
  ok(await f.call('notify.delete', { id: first._id })); ok(await f.call('notify.clear', { before: cutoff }));
  assert.equal((await f.repo.listNotifications(userKeyOf()))[0].status, 'sending');
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 1);
  release(); assert.equal((await running).status, 'accepted');
  assert.equal(await f.repo.saveNotification(first), false);
  await send(first); assert.equal(sends, 1);
  assert.deepEqual(ok(await f.call('notify.list')).notifications, []);
  const second = task('after-clear'); await f.repo.saveNotification(second);
  assert.equal((await send(second)).reason, 'cooldown'); assert.equal(sends, 1);
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 1);
  assert.equal(ok(await f.call('notify.list')).notifications[0].id, 'after-clear');
});

test('notification insertion and clearing roll back metadata together with task writes', async () => {
  const f = createFixture(); ok(await f.call('user.bootstrap'));
  const view = await f.repo.getNotificationView(userKeyOf());
  f.repo.transactionWriteHook = async table => { if (table === C.notifications) throw new Error('write unavailable'); };
  await assert.rejects(f.repo.saveNotification(task('failed-insert')));
  assert.equal((await f.repo.getNotificationView(userKeyOf())).lastSequence, 0);
  f.repo.transactionWriteHook = null; await f.repo.saveNotification(task('created'));
  assert.equal((await f.repo.listNotifications(userKeyOf()))[0].viewSequence, 1);
  const before = ok(await f.call('notify.list')).clearBefore;
  f.repo.transactionWriteHook = async (table, doc) => { if (table === C.config && doc._id === view._id) throw new Error('watermark unavailable'); };
  assert.equal((await f.call('notify.clear', { before })).error.code, 'internal_error');
  f.repo.transactionWriteHook = null;
  assert.equal(ok(await f.call('notify.list')).notifications.length, 1);
});

test('real wx-server-sdk 4.0.2 notification view queries and atomic sequence/clear/delete work with serialized predicates', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); } catch { t.skip('Run npm ci in cloudfunctions/gxs_api for the pinned SDK contract'); return; }
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV; process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk'); cloud.init({ env: 'offline-notification-view' });
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson'); const copy = value => EJSON.parse(EJSON.stringify(value));
  let committed = {}, revision = 0, sequence = 0; const transactions = new Map(), calls = [];
  const match = (doc, query) => Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every(q => match(doc, q));
    if (key === '$or') return value.some(q => match(doc, q));
    if (!value || typeof value !== 'object') return value === null ? doc[key] == null : doc[key] === value;
    return Object.entries(value).every(([op, operand]) => {
      if (op === '$exists') return (doc[key] !== undefined) === operand;
      if (op === '$eq') return operand === null ? doc[key] == null : doc[key] === operand;
      if (op === '$gt') return doc[key] > operand;
      if (op === '$gte') return doc[key] >= operand;
      if (op === '$lt') return doc[key] < operand;
      if (op === '$lte') return doc[key] <= operand;
      throw new Error(`Unsupported serialized predicate ${op}`);
    });
  });
  Database.reqClass = class OfflineTransport {
    async send(action, args = {}) {
      calls.push({ action, args: copy(args) });
      if (action === 'database.startTransaction') { const id = `tx-${++sequence}`; transactions.set(id, { rows: copy(committed), revision, dirty: false }); return { transactionId: id }; }
      if (action === 'database.abortTransaction') { transactions.delete(args.transactionId); return {}; }
      if (action === 'database.commitTransaction') {
        const tx = transactions.get(args.transactionId); transactions.delete(args.transactionId);
        if (tx.dirty && tx.revision !== revision) return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'conflicting view sequence' };
        if (tx.dirty) { committed = tx.rows; revision++; } return {};
      }
      const tx = transactions.get(args.transactionId), tables = tx ? tx.rows : committed;
      const rows = tables[args.collectionName] ||= {};
      if (action === 'database.getDocument') {
        let docs = Object.values(rows).filter(doc => match(doc, EJSON.parse(args.query)));
        const order = args.order ? EJSON.parse(args.order) : {};
        docs.sort((a, b) => { for (const [field, direction] of Object.entries(order)) if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * direction; return 0; });
        return { data: { list: docs.slice(args.offset || 0, (args.offset || 0) + Math.min(args.limit || 100, 100)).map(doc => EJSON.stringify(doc)) } };
      }
      assert.ok(tx, 'all view mutations must carry a transaction ID'); tx.dirty = true;
      if (action === 'database.insertDocument') { const docs = args.data.map(value => EJSON.parse(value)); for (const doc of docs) rows[doc._id] = doc; return { data: { insertedIds: docs.map(doc => doc._id) } }; }
      if (action === 'database.modifyDocument') { assert.equal(args.merge, false); const id = EJSON.parse(args.query)._id; rows[id] = { _id: id, ...EJSON.parse(args.data) }; return { data: { updated: 1 } }; }
      throw new Error(`Unexpected SDK operation ${action}`);
    }
  };
  try {
    const repo = createCloudbaseRepo(db), nowIso = '2026-09-15T02:00:00.000Z';
    const afterRequest = '2026-09-15T02:00:00.001Z';
    committed[C.notifications] = { legacy: task('legacy', '2026-09-14T02:00:00.000Z'), 'legacy-future': task('legacy-future', afterRequest) };
    const results = await Promise.all([repo.saveNotification(task('new-A')), repo.saveNotification(task('new-B', afterRequest))]);
    assert.deepEqual(results, [true, true]);
    const view = await repo.getNotificationView(userKeyOf()); assert.equal(view.lastSequence, 2);
    assert.equal(new Set(Object.values(committed[C.notifications]).filter(n => n.viewSequence).map(n => n.viewSequence)).size, 2);
    const snapshot = { at: nowIso, sequence: 2 };
    const page = await repo.listVisibleNotifications({ userKey: userKeyOf(), view, snapshot, cursor: null, limit: 1 });
    assert.equal(page.items[0]._id, 'new-B'); assert.equal(page.hasMore, true);
    const next = await repo.listVisibleNotifications({ userKey: userKeyOf(), view, snapshot, cursor: { createdAt: afterRequest, id: 'new-B' }, limit: 10 });
    assert.deepEqual(next.items.map(n => n._id), ['new-A', 'legacy']);
    await repo.hideNotification({ userKey: userKeyOf(), id: 'new-B', nowIso });
    const cutoff = encodeToken('clear', snapshot, view);
    await repo.saveNotification(task('new-C', '2026-09-13T02:00:00.000Z'));
    await repo.clearNotificationView({ userKey: userKeyOf(), before: cutoff, nowIso });
    const current = await repo.getNotificationView(userKeyOf());
    const visible = await repo.listVisibleNotifications({ userKey: userKeyOf(), view: current, snapshot: { at: '2026-09-15T02:00:00.010Z', sequence: current.lastSequence }, cursor: null, limit: 20 });
    assert.deepEqual(visible.items.map(n => n._id), ['legacy-future', 'new-C']);
    assert.equal(committed[C.notifications]['new-B'].status, 'pending'); assert.ok(committed[C.notifications]['new-B'].userHiddenAt);
    assert.ok(calls.filter(c => c.action === 'database.getDocument' && !c.args.transactionId).every(c => EJSON.parse(c.args.order)._id === -1));
  } finally {
    Database.reqClass = previousRequest;
    if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV; else process.env.TENCENTCLOUD_RUNENV = previousRuntime;
  }
});
