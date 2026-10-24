import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const log = { info() {}, warn() {}, error() {} };
const memberKey = index => `member-${String(index).padStart(3, '0')}`;

async function setup({ accounts = 1, waiting = 0 } = {}) {
  const f = createFixture({ config: { collector: { enabled: false }, notifications: {
    enabled: true, templateIds: { restock: 'RESTOCK', soldout: 'SOLDOUT' }, cooldownMinutes: 0, maxEventAgeSeconds: 120,
  } } });
  const base = f.state.now.getTime(), at = ms => new Date(base + ms).toISOString();
  await f.call('user.bootstrap');
  const seed = await f.repo.getUser(userKeyOf());
  for (let i = 0; i < accounts; i++) {
    const userKey = memberKey(i);
    await f.repo.createUser({ ...seed, _id: userKey, openid: `oMEMBER${String(i).padStart(21, '0')}`, followIndex: [],
      membership: { expiresAt: '2027-10-15T00:00:00.000Z' }, subscriptions: { SOLDOUT: { credits: 3 } } });
    await f.repo.saveFollow({ _id: `F${i}`, userKey, partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active', createdAt: at(0) });
  }
  for (let i = 0; i < waiting; i++) {
    const partNumber = `UNFOLLOWED${String(i).padStart(4, '0')}`, storeNumber = 'R999', key = `${storeNumber}|${partNumber}`;
    await f.repo.saveLatest({ _id: key, partNumber, storeNumber, status: 'available', statusSince: at(0), knownAt: at(0),
      observedAt: at(0), knownStreakSince: at(0), unknownSince: null });
    await f.repo.saveEvents([{ _id: `${key}|first_seen_available|${at(0)}`, partNumber, storeNumber, type: 'first_seen_available',
      status: 'available', detectedAt: at(0), notificationPlannedAt: null }]);
  }
  const eventId = `R577|MJYH4CH/A|became_unavailable|${at(1000)}`;
  await f.repo.saveEvents([{ _id: eventId, partNumber: 'MJYH4CH/A', storeNumber: 'R577', type: 'became_unavailable',
    status: 'unavailable', detectedAt: at(1000), availableSince: at(-60000), previousKnownAt: at(0),
    previousStatusConfirmed: true, notificationPlannedAt: null }]);
  await f.repo.saveLatest({ _id: 'R577|MJYH4CH/A', partNumber: 'MJYH4CH/A', storeNumber: 'R577', status: 'unavailable',
    statusSince: at(1000), knownStreakSince: at(1000), knownAt: at(2000), observedAt: at(2000), unknownSince: null });
  f.advance(3000);
  const sends = [];
  const sendImpl = async message => { sends.push({ ...message, at: f.state.now.getTime() }); return { errcode: 0 }; };
  sendImpl.appid = CONSUMER_APPID;
  const options = { repo: f.repo, sendImpl, clock: () => new Date(f.state.now), log };
  return { f, at, eventId, sends, options, run: overrides => runScheduled({ ...options, sleep: async ms => f.advance(ms), ...overrides }) };
}

test('50 one-sample events cannot hide a later confirmed alert until its send window expires', async () => {
  const s = await setup({ waiting: 50 });
  const collector = createCollector({ ...s.options, ownerId: 'fairness' });
  await collector.lease.acquire();
  await collector.drainNotifications();
  assert.equal(s.sends.length, 1);
  assert.ok((await s.f.repo.getEvent(s.eventId)).notificationPlannedAt);
  const waiting = await s.f.repo.listUnprocessedEvents();
  assert.equal(waiting.length, 50, 'unconfirmed events remain eligible for a later second sample');
  assert.ok(waiting.every(event => !event.notificationPlannedAt));
  // Confirm one formerly waiting event and visit it after the scan wraps.
  const first = waiting[0], key = `${first.storeNumber}|${first.partNumber}`;
  const [latest] = await s.f.repo.getLatest([key]);
  await s.f.repo.saveLatest({ ...latest, knownAt: s.at(4000) });
  s.f.advance(1000);
  await collector.drainNotifications();
  assert.ok((await s.f.repo.getEvent(first._id)).notificationPlannedAt);
  assert.equal(s.sends.length, 1, 'unfollowed confirmed events do not manufacture recipients');
  await collector.lease.release();
});

test('bounded waiting-event pages persist their scan position across scheduled cold starts', async () => {
  const s = await setup({ waiting: 500 });
  const getLatest = s.f.repo.getLatest;
  s.f.repo.getLatest = async keys => { const rows = await getLatest(keys); s.f.advance(1000); return rows; };
  await s.run({ ownerId: 'page-one', maxRunMs: 6000 });
  const first = await s.f.repo.getCollectorStatus();
  assert.ok(first.stats.notificationEventCursor, 'the next invocation must not restart at the first waiting page');
  assert.equal(s.sends.length, 0);
  for (let index = 0; index < 3 && !s.sends.length; index++) {
    s.f.advance(6000);
    await s.run({ ownerId: `page-next-${index}`, maxRunMs: 6000 });
  }
  assert.equal(s.sends.length, 1);
  assert.equal((await s.f.repo.listUnprocessedEvents({ limit: 1000 })).length, 500);
});

test('slow large-event fanout yields to sends and resumes after durable users on a cold start', async () => {
  const s = await setup({ accounts: 100 });
  const save = s.f.repo.saveNotification;
  let attempts = 0;
  s.f.repo.saveNotification = async task => { const result = await save(task); attempts++; s.f.advance(500); return result; };
  const started = s.f.state.now.getTime();
  await s.run({ ownerId: 'fanout-first', maxRunMs: 35000 });
  assert.ok(s.sends.length > 0 && s.sends.length < 100);
  assert.ok(s.sends[0].at - started <= 5000, 'task inserts leave time for an already-durable task to send');
  const partial = await s.f.repo.getEvent(s.eventId);
  assert.ok(partial.notificationPlanningAfterUserKey);
  assert.equal(partial.notificationPlannedAt, null);
  s.f.state.now = new Date(s.at(63000));
  await s.run({ ownerId: 'fanout-second', maxRunMs: 35000 });
  assert.equal(s.sends.length, 100);
  assert.equal(attempts, 100, 'the new invocation must not replay the first planning slice');
  assert.equal(new Set(s.sends.map(message => message.touser)).size, 100);
  assert.ok((await s.f.repo.getEvent(s.eventId)).notificationPlannedAt);
  for (let index = 0; index < 100; index++) assert.equal((await s.f.repo.getUser(memberKey(index))).subscriptions.SOLDOUT.credits, 2);
});

test('a resumed fanout rechecks cancelled follows and expired memberships without replaying accepted users', async () => {
  const s = await setup({ accounts: 25 });
  const collector = createCollector({ ...s.options, ownerId: 'fanout-cancel' });
  await collector.lease.acquire();
  await collector.drainNotifications();
  assert.equal(s.sends.length, 20);
  await s.f.repo.saveFollow({ ...await s.f.repo.getFollow('F22'), status: 'paused' });
  await s.f.repo.updateUser(memberKey(23), { membership: { expiresAt: s.at(0) } });
  await collector.drainNotifications();
  assert.equal(s.sends.length, 23);
  assert.ok((await s.f.repo.getEvent(s.eventId)).notificationPlannedAt);
  for (const index of [22, 23]) assert.equal((await s.f.repo.getUser(memberKey(index))).subscriptions.SOLDOUT.credits, 3);
  assert.equal(new Set(s.sends.map(message => message.touser)).size, 23);
  await collector.lease.release();
});

test('a failed progress transaction replays only its durable chunk without duplicate delivery or credit spending', async () => {
  const s = await setup({ accounts: 25 });
  const collector = createCollector({ ...s.options, ownerId: 'fanout-retry' });
  await collector.lease.acquire();
  let failed = false, attempts = 0;
  const save = s.f.repo.saveNotification;
  s.f.repo.saveNotification = async task => { attempts++; return save(task); };
  s.f.repo.transactionWriteHook = async (collection, doc) => {
    if (!failed && collection === C.events && doc.notificationPlanningAfterUserKey) { failed = true; throw new Error('checkpoint unavailable'); }
  };
  await assert.rejects(collector.drainNotifications(), /checkpoint unavailable/);
  assert.equal((await s.f.repo.getEvent(s.eventId)).notificationPlanningAfterUserKey, undefined);
  assert.equal(s.f.repo.tables.get(C.notifications).size, 10);
  assert.equal(s.sends.length, 0);
  s.f.repo.transactionWriteHook = null;
  await collector.drainNotifications();
  await collector.drainNotifications();
  assert.equal(attempts, 35);
  assert.equal(s.sends.length, 25);
  assert.equal(s.f.repo.tables.get(C.notifications).size, 25);
  for (let index = 0; index < 25; index++) assert.equal((await s.f.repo.getUser(memberKey(index))).subscriptions.SOLDOUT.credits, 2);
  await collector.lease.release();
});

test('event planning checkpoints are monotone and a former lease owner cannot mark an event complete', async () => {
  const s = await setup();
  const old = createCollector({ ...s.options, ownerId: 'old' });
  await old.lease.acquire();
  const checkpoint = args => s.f.repo.checkpointEventPlanning({ eventId: s.eventId, ownerId: 'old', nowIso: s.f.state.now.toISOString(), ...args });
  await checkpoint({ afterUserKey: 'member-020' });
  await checkpoint({ afterUserKey: 'member-010' });
  assert.equal((await s.f.repo.getEvent(s.eventId)).notificationPlanningAfterUserKey, 'member-020');
  s.f.advance(16000);
  const next = createCollector({ ...s.options, ownerId: 'new' });
  await next.lease.acquire();
  await assert.rejects(checkpoint({ complete: true }), error => error.code === 'collector_lease_lost');
  assert.equal((await s.f.repo.getEvent(s.eventId)).notificationPlannedAt, null);
  await next.lease.release();
});

test('the pinned CloudBase SDK keyset query covers tied timestamps while completed rows disappear', async t => {
  const sdkRequire = createRequire(new URL('../cloudfunctions/gxs_api/package.json', import.meta.url));
  try { sdkRequire.resolve('wx-server-sdk'); } catch { t.skip('Run npm ci in cloudfunctions/gxs_api for the pinned SDK contract'); return; }
  const previousRuntime = process.env.TENCENTCLOUD_RUNENV; process.env.TENCENTCLOUD_RUNENV = 'SCF';
  const cloud = sdkRequire('wx-server-sdk'); cloud.init({ env: 'offline-event-keyset' });
  const db = cloud.database(), Database = db._db.constructor, previousRequest = Database.reqClass;
  const { EJSON } = sdkRequire('bson');
  const at = '2026-09-15T02:00:00.000Z';
  const rows = ['a', 'b', 'c', 'd'].map(_id => ({ _id, type: 'first_seen_available', detectedAt: at, notificationPlannedAt: null }));
  rows.push({ _id: 'e', type: 'became_unavailable', detectedAt: '2026-09-15T02:00:01.000Z' });
  const match = (doc, query) => Object.entries(query).every(([field, value]) => {
    if (field === '$and') return value.every(item => match(doc, item));
    if (field === '$or') return value.some(item => match(doc, item));
    if (!value || typeof value !== 'object') return doc[field] === value;
    return Object.entries(value).every(([op, operand]) => {
      if (op === '$in') return operand.includes(doc[field]);
      if (op === '$eq') return operand === null ? doc[field] == null : doc[field] === operand;
      if (op === '$exists') return (doc[field] !== undefined) === operand;
      if (op === '$gt') return doc[field] > operand;
      if (op === '$gte') return doc[field] >= operand;
      throw new Error(`Unexpected query operator ${op}`);
    });
  });
  Database.reqClass = class OfflineTransport {
    async send(action, args) {
      assert.equal(action, 'database.getDocument');
      assert.equal(args.collectionName, C.events);
      assert.deepEqual(EJSON.parse(args.order), { detectedAt: 1, _id: 1 });
      const found = rows.filter(row => match(row, EJSON.parse(args.query)));
      return { data: { list: found.slice(args.offset || 0, (args.offset || 0) + args.limit).map(row => EJSON.stringify(row)) } };
    }
  };
  try {
    const repo = createCloudbaseRepo(db);
    const first = await repo.listUnprocessedEvents({ limit: 2, since: at });
    assert.deepEqual(first.map(row => row._id), ['a', 'b']);
    rows[0].notificationPlannedAt = at;
    rows[1].notificationPlannedAt = at;
    const second = await repo.listUnprocessedEvents({ limit: 2, since: at, cursor: { detectedAt: at, id: 'b' } });
    assert.deepEqual(second.map(row => row._id), ['c', 'd']);
    const last = await repo.listUnprocessedEvents({ limit: 2, since: at, cursor: { detectedAt: at, id: 'd' } });
    assert.deepEqual(last.map(row => row._id), ['e']);
  } finally {
    Database.reqClass = previousRequest;
    if (previousRuntime === undefined) delete process.env.TENCENTCLOUD_RUNENV; else process.env.TENCENTCLOUD_RUNENV = previousRuntime;
  }
});
