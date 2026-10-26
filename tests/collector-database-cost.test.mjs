import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMemoryRepo } from './helpers/memory-repo.mjs';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createLeaseKeeper } = require('../cloudfunctions/gxs_api/lib/engine/lease.js');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector.js');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled.js');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const log = { info() {}, warn() {}, error() {} };
const T0 = Date.parse('2026-09-15T02:00:00.000Z');

function leaseFixture() {
  const repo = createMemoryRepo();
  let nowMs = T0, acquisitions = 0;
  const original = repo.acquireLease;
  repo.acquireLease = async args => { acquisitions++; return original(args); };
  const lease = createLeaseKeeper({ repo, ownerId: 'worker', clock: () => new Date(nowMs), log });
  return { repo, lease, clock: () => new Date(nowMs), advance: ms => { nowMs += ms; }, count: () => acquisitions };
}

test('renew reuses only a live grant with more than ten seconds remaining; acquire and forced renew still transact', async () => {
  const s = leaseFixture();
  assert.equal(await s.lease.acquire(), true);
  for (let i = 0; i < 100; i++) assert.equal(await s.lease.renew(), true);
  s.advance(4999);
  assert.equal(await s.lease.renew(), true);
  assert.equal(s.count(), 1, '101 redundant calls need no new transaction');
  s.advance(1);
  assert.equal(await s.lease.renew(), true);
  assert.equal(s.count(), 2, 'exactly ten seconds remaining renews before work');
  await s.lease.acquire();
  await s.lease.renew({ force: true });
  assert.equal(s.count(), 4);
  await s.lease.release();
  assert.equal(s.lease.isHeld(), false);
  assert.equal(s.lease.expiresAt(), null);
  await s.lease.renew();
  assert.equal(s.count(), 5, 'release invalidates the cached grant');
});

test('concurrent callers share the renewal and a slow transaction does not grant a fresh local TTL', async () => {
  const s = leaseFixture();
  const original = s.repo.acquireLease;
  let settle;
  s.repo.acquireLease = args => new Promise(resolve => { settle = async () => resolve(await original(args)); });
  const first = s.lease.acquire();
  const second = s.lease.renew();
  assert.equal(first, second);
  s.advance(7000);
  await settle();
  assert.equal(await first, true);
  assert.equal(Date.parse(s.lease.expiresAt()) - s.clock().getTime(), 8000);
  s.repo.acquireLease = original;
  await s.lease.renew();
  assert.equal(s.count(), 2, 'the elapsed transaction time cannot be reused as a new lease');
});

test('expiry and takeover reject the old worker and cannot release the new owner grant', async () => {
  const s = leaseFixture();
  await s.lease.acquire();
  s.advance(16000);
  await s.repo.acquireLease({ id: 'collector_lease', ownerId: 'replacement', now: s.clock().toISOString(), expiresAt: new Date(s.clock().getTime() + 15000).toISOString() });
  assert.equal(await s.lease.renew(), false);
  assert.equal(s.lease.isHeld(), false);
  await s.lease.release();
  const saved = s.repo.tables.get(C.config).get('collector_lease');
  assert.equal(saved.ownerId, 'replacement');
  assert.ok(Date.parse(saved.expiresAt) > s.clock().getTime());
});

test('cached grants retain observation and status transaction owner fences', async () => {
  const s = leaseFixture();
  await s.lease.acquire();
  // Simulate an out-of-band revocation even though normal acquisition cannot
  // take over an unexpired grant. The durable write must still reject it.
  s.repo.tables.get(C.config).set('collector_lease', { _id: 'collector_lease', ownerId: 'replacement', expiresAt: new Date(T0 + 15000).toISOString() });
  assert.equal(await s.lease.renew(), true);
  const fence = { ownerId: 'worker', nowIso: s.clock().toISOString() };
  await assert.rejects(s.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available', source: 'auto', observedAt: s.clock().toISOString() }, collectorLease: fence, nowIso: fence.nowIso }), error => error.code === 'collector_lease_lost');
  assert.deepEqual(await s.repo.saveCollectorStatus({ state: 'running' }, fence), { saved: false, reason: 'lease_lost' });
  assert.equal((await s.repo.getLatest(['R577|MJYH4CH/A'])).length, 0);
  assert.equal(await s.repo.getCollectorStatus(), null);
  assert.equal(await s.lease.renew({ force: true }), false, 'the pre-send forced renewal also detects revocation');
});

test('renewal failures are propagated without retries or extending the local expiry', async () => {
  const s = leaseFixture();
  await s.lease.acquire();
  const expiry = s.lease.expiresAt();
  s.advance(5000);
  let attempts = 0;
  s.repo.acquireLease = async () => { attempts++; throw new Error('database timeout'); };
  await assert.rejects(s.lease.renew(), /database timeout/);
  assert.equal(attempts, 1);
  assert.equal(s.lease.expiresAt(), expiry);
  s.advance(10000);
  assert.equal(s.lease.isHeld(), false);
});

test('status checkpoints share a five-second window while explicit final and error writes stay immediate', async () => {
  const s = leaseFixture();
  let statuses = 0;
  const original = s.repo.saveCollectorStatus;
  s.repo.saveCollectorStatus = async (...args) => { statuses++; return original(...args); };
  const collector = createCollector({ repo: s.repo, ownerId: 'worker', clock: s.clock, log, statusEveryMs: 5000 });
  for (let i = 0; i < 100; i++) {
    await collector.step();
    await collector.publishStatus(undefined, { force: false });
  }
  assert.equal(statuses, 1);
  assert.equal(s.count(), 1);
  s.advance(4999);
  await collector.publishStatus(undefined, { force: false });
  assert.equal(statuses, 1);
  s.advance(1);
  await collector.step();
  assert.equal(statuses, 2);
  assert.equal(s.count(), 2);
  await collector.publishStatus();
  await collector.publishStatus({ state: 'error' });
  assert.equal(statuses, 4);
  assert.equal((await s.repo.getCollectorStatus()).state, 'error');
  await collector.lease.release();
});

test('scheduled scans preserve samples and confirmed reminders with bounded lease and checkpoint writes', async () => {
  let display = 'unavailable';
  const upstream = fakeFetch(() => ({ display }));
  const f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60, burstIntervalSeconds: 0, availableIntervalSeconds: 0 }, notifications: { enabled: true, templateIds: { restock: 'TPL' } } }, fetchImpl: upstream });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-10-15T00:00:00Z' }, subscriptions: { TPL: { credits: 3 } } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'], status: 'active' });
  let leases = 0, statuses = 0, releases = 0;
  for (const [name, increment] of [['acquireLease', () => leases++], ['saveCollectorStatus', () => statuses++], ['releaseLease', () => releases++]]) {
    const original = f.repo[name];
    f.repo[name] = async (...args) => { increment(); return original(...args); };
  }
  const sends = [];
  const run = () => runScheduled({ repo: f.repo, fetchImpl: upstream, sendImpl: async message => { sends.push(message); return { errcode: 0 }; }, clock: () => new Date(f.state.now), log, sleep: async ms => f.advance(ms) });
  const first = await run();
  assert.equal(first.observations, 2);
  assert.equal(leases, 1, 'all immediate scan checks share the same exclusive grant');
  assert.equal(statuses, 2, 'initial and final checkpoints remain durable');
  assert.equal(releases, 1);
  f.advance(60000); display = 'available';
  await run();
  assert.equal(sends.length, 0, 'a changed status still needs confirmation');
  f.advance(60000);
  await run();
  assert.equal(sends.length, 2);
  assert.equal(upstream.calls.length, 6, 'three scans still sample both targets');
  assert.equal(releases, 3);
  assert.equal([...f.repo.tables.get(C.observationDays).values()].reduce((sum, row) => sum + row.sampleCount, 0), 6);
  assert.equal([...f.repo.tables.get(C.notifications).values()].filter(row => row.status === 'accepted').length, 2);
});
