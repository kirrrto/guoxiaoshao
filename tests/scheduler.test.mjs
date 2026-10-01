import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createScheduler, buildGroups } = require('../cloudfunctions/gxs_api/lib/engine/scheduler.js');

const base = Date.UTC(2026, 8, 15, 1, 0, 0);
function harness({ upstream, options = {} } = {}) {
  const state = { nowMs: base };
  const calls = [];
  const batches = [];
  const scheduler = createScheduler({
    intervalMs: 1000,
    maxConcurrency: 2,
    backoff: { baseMs: 2000, factor: 2, maxMs: 16000 },
    breaker: { failureThreshold: 3, windowMs: 10000, cooldownMs: 5000, maxCooldownMs: 60000 },
    ...options,
    clock: () => new Date(state.nowMs),
    fetchPickup: async ({ storeNumber, partNumbers }) => {
      calls.push({ storeNumber, partNumbers, at: state.nowMs });
      const step = upstream ? upstream(storeNumber, partNumbers, calls.length) : {};
      if (step.hang) await step.hang;
      state.nowMs += step.latencyMs || 100;
      const status = step.status || 'available';
      const record = { httpStatus: step.httpStatus ?? 200, retryAfter: step.retryAfter || null, elapsedMs: step.latencyMs || 100, error: step.error ? { message: step.error } : null };
      const observations = partNumbers.map(partNumber => ({ storeNumber, partNumber, status: step.error || step.httpStatus >= 400 ? 'unknown' : status, observedAt: new Date(state.nowMs).toISOString(), reason: step.error ? { code: 'transport_error' } : null }));
      return { record, observations };
    },
    onBatch: async batch => { batches.push(batch); },
    log: { warn: () => {}, error: () => {} },
  });
  const advance = ms => { state.nowMs += ms; };
  const runTick = async () => { await Promise.all(scheduler.tick()); };
  return { scheduler, calls, batches, advance, runTick, state };
}

const follows = [
  { userKey: 'u1', partNumber: 'AAAAACH/A', storeNumbers: ['R577', 'R639'] },
  { userKey: 'u2', partNumber: 'AAAAACH/A', storeNumbers: ['R577'] },
  { userKey: 'u2', partNumber: 'BBBBBCH/A', storeNumbers: ['R577'] },
];

test('capacity recovery time survives cadence changes, hurry and scheduler cold starts', async () => {
  let nowMs = base, calls = 0;
  const group = buildGroups([{ partNumber: 'AAAAACH/A', storeNumbers: ['R577'] }]);
  const create = () => createScheduler({ clock: () => new Date(nowMs), intervalMs: 1000, burstIntervalMs: 2000,
    fetchPickup: async () => {
      calls++;
      return calls === 2 ? { record: { budgetDenied: true, retryAt: base + 60000 }, observations: [] }
        : { record: { httpStatus: 200 }, observations: [{ storeNumber: 'R577', partNumber: 'AAAAACH/A', status: 'available', observedAt: new Date(nowMs).toISOString() }] };
    }, onBatch: async () => {}, log: { error() {}, warn() {} } });
  const first = create(); first.setTargets(group); await Promise.all(first.tick());
  nowMs += 2000; await Promise.all(first.tick());
  const restarted = create(); restarted.setTargets(group); restarted.restore(first.checkpoint());
  restarted.configure({ intervalMs: 1000 }); restarted.hurry('R577');
  nowMs += 3000; await Promise.all(restarted.tick());
  assert.equal(calls, 2);
  assert.equal(restarted.nextDueInMs(), 55000);
  nowMs = base + 60000; await Promise.all(restarted.tick());
  assert.equal(calls, 3);
});

test('one shared admission deficit stops every group and survives target changes and cold starts', async () => {
  let nowMs = base, calls = 0, denied = true;
  const groups = buildGroups([{ partNumber: 'AAAAACH/A', storeNumbers: Array.from({ length: 400 }, (_, i) => `R${String(i).padStart(3, '0')}`) }]);
  const create = () => createScheduler({ clock: () => new Date(nowMs), intervalMs: 1000, maxConcurrency: 3, burstIntervalMs: 2000,
    fetchPickup: async ({ storeNumber, partNumbers }) => {
      calls++;
      return denied ? { record: { budgetDenied: true, retryAt: base + 60000, error: { message: 'capacity_wait' } }, observations: [] }
        : { record: { httpStatus: 200 }, observations: [{ storeNumber, partNumber: partNumbers[0], status: 'available', observedAt: new Date(nowMs).toISOString() }] };
    }, onBatch: async () => {}, log: { error() {}, warn() {} } });
  const first = create(); first.setTargets(groups); await Promise.all(first.tick());
  for (let wave = 0; wave < groups.length; wave++) assert.equal(first.tick().length, 0);
  assert.equal(calls, 3, 'only the already-dispatched concurrency wave checks the shared database gate');
  const saved = first.checkpoint();
  assert.equal(saved.admissionUntil, base + 60000);
  const restarted = create();
  restarted.setTargets([...groups, ...buildGroups([{ partNumber: 'BBBBBCH/A', storeNumbers: ['R999'] }])]);
  restarted.restore(saved);
  restarted.configure({ intervalMs: 1000 }); restarted.hurry('R999');
  nowMs += 5000;
  assert.equal(restarted.tick().length, 0, 'a newly followed target cannot bypass the shared pause');
  assert.equal(restarted.nextDueInMs(), 55000);
  assert.equal(restarted.snapshot().state, 'budget_limited');
  assert.ok(restarted.snapshot().targets.every(target => !target.storeDelayed), 'capacity waits are not short store-spacing waits');
  denied = false; nowMs = base + 60000;
  await Promise.all(restarted.tick());
  assert.equal(calls, 6);
  assert.equal(restarted.checkpoint().admissionUntil, 0, 'time passing releases the shared pause');
});

test('daily admission migration preserves source pauses and unfinished failure backoff', () => {
  const h = harness();
  h.scheduler.setTargets(buildGroups([{ partNumber: 'AAAAACH/A', storeNumbers: ['R577', 'R639'] }]));
  const saved = h.scheduler.checkpoint();
  saved.admissionUntil = base + 3600000; saved.admissionReason = 'daily_budget';
  saved.breaker = { state: 'open', openedAt: base, until: base + 30000, failures: [], trips: 1, probeInFlight: false, reason: 'http_429' };
  Object.assign(saved.targets[0], { nextDueAt: base + 3600000, guardUntil: base + 3600000, guardReason: 'daily_budget', failures: 2 });
  Object.assign(saved.targets[0].health, { lastFailureAt: base, lastRequestAt: base });
  Object.assign(saved.targets[1], { nextDueAt: base + 3600000, guardUntil: base + 3600000, guardReason: 'upstream_paused' });
  h.scheduler.restore(saved); h.advance(500);
  h.scheduler.resetDailyAdmission(base + 3600000);
  const migrated = h.scheduler.checkpoint();
  assert.equal(migrated.admissionUntil, 0);
  assert.equal(migrated.targets[0].nextDueAt, base + 4000, 'the genuine two-failure backoff is retained');
  assert.equal(migrated.targets[0].guardUntil, 0);
  assert.equal(migrated.targets[1].guardUntil, base + 3600000, 'an explicit source pause with the same timestamp is retained');
  assert.deepEqual(migrated.breaker, saved.breaker);
  assert.equal(h.scheduler.tick().length, 0);
  assert.equal(h.scheduler.nextDueInMs(), 29500);
});

test('follows collapse into one request per store with deduped SKUs', () => {
  const groups = buildGroups(follows);
  assert.deepEqual(groups.map(g => [g.storeNumber, g.partNumbers]), [['R577', ['AAAAACH/A', 'BBBBBCH/A']], ['R639', ['AAAAACH/A']]]);
  assert.equal(groups[0].key, 'R577|AAAAACH/A,BBBBBCH/A');
});

test('each group is requested once per period, never stacked while in flight', async () => {
  let release;
  const hang = new Promise(resolve => { release = resolve; });
  let first = true;
  const h = harness({ upstream: () => { if (first) { first = false; return { hang }; } return {}; } });
  h.scheduler.setTargets(buildGroups(follows));
  const started = h.scheduler.tick();
  assert.equal(started.length, 2);
  assert.equal(h.scheduler.tick().length, 0, 'in-flight groups are not dispatched again');
  h.advance(3000);
  assert.equal(h.scheduler.tick().length, 0, 'even when overdue');
  release();
  await Promise.all(started);
  assert.equal(h.batches.length, 2);
  h.advance(1000);
  await h.runTick();
  assert.equal(h.calls.length, 4);
  const r577 = h.calls.filter(c => c.storeNumber === 'R577');
  assert.ok(r577[1].at - r577[0].at >= 1000);
});

test('concurrency cap limits simultaneous requests and later groups wait for a slot', async () => {
  const many = buildGroups([{ userKey: 'u', partNumber: 'AAAAACH/A', storeNumbers: ['R001', 'R002', 'R003', 'R004', 'R005'] }]);
  const h = harness({ options: { maxConcurrency: 2 } });
  h.scheduler.setTargets(many);
  const started = h.scheduler.tick();
  assert.equal(started.length, 2);
  await Promise.all(started);
  const more = h.scheduler.tick();
  assert.equal(more.length, 2);
  await Promise.all(more);
  await h.runTick();
  assert.equal(h.calls.length, 5);
  assert.equal(h.scheduler.snapshot().state, 'running');
});

test('failures back off exponentially per group and recover on the next success', async () => {
  let failing = true;
  const h = harness({ upstream: () => (failing ? { error: 'timeout' } : {}) });
  h.scheduler.setTargets(buildGroups([{ userKey: 'u', partNumber: 'AAAAACH/A', storeNumbers: ['R577'] }]));
  await h.runTick();
  let snap = h.scheduler.snapshot();
  assert.equal(snap.targets[0].failures, 1);
  assert.equal(snap.targets[0].dueInMs, 2000);
  h.advance(2000);
  await h.runTick();
  snap = h.scheduler.snapshot();
  assert.equal(snap.targets[0].failures, 2);
  assert.equal(snap.targets[0].dueInMs, 4000);
  h.advance(1000);
  assert.equal(h.scheduler.tick().length, 0, 'not due yet during backoff');
  h.advance(3000);
  failing = false;
  await h.runTick();
  snap = h.scheduler.snapshot();
  assert.equal(snap.targets[0].failures, 0);
  assert.equal(snap.targets[0].health.successes, 1);
  assert.equal(snap.targets[0].health.failures, 2);
  assert.equal(snap.targets[0].health.lastError, 'timeout');
  assert.equal(snap.targets[0].dueInMs, 900, 'period counts from request start');
});

test('a burst of failures opens the breaker; one probe half-opens it; success closes it', async () => {
  let mode = 'fail';
  const h = harness({ upstream: () => (mode === 'fail' ? { error: 'ECONNRESET' } : {}) });
  h.scheduler.setTargets(buildGroups([{ userKey: 'u', partNumber: 'AAAAACH/A', storeNumbers: ['R001', 'R002', 'R003'] }]));
  await h.runTick();
  await h.runTick();
  let snap = h.scheduler.snapshot();
  assert.equal(snap.breaker.state, 'open');
  assert.equal(snap.breaker.reason, 'failure_burst');
  assert.equal(snap.state, 'throttled');
  const callsWhenOpened = h.calls.length;
  h.advance(4000);
  await h.runTick();
  assert.equal(h.calls.length, callsWhenOpened, 'nothing is requested while open');
  h.advance(1000);
  const probe = h.scheduler.tick();
  assert.equal(probe.length, 1, 'half-open allows exactly one probe');
  assert.equal(h.scheduler.snapshot().state, 'probing');
  await Promise.all(probe);
  snap = h.scheduler.snapshot();
  assert.equal(snap.breaker.state, 'open', 'a failed probe re-opens with a longer cooldown');
  assert.equal(snap.breaker.trips, 2);
  assert.equal(snap.breaker.until - h.state.nowMs, 10000);
  h.advance(10000);
  mode = 'ok';
  await Promise.all(h.scheduler.tick());
  snap = h.scheduler.snapshot();
  assert.equal(snap.breaker.state, 'closed');
  assert.equal(snap.breaker.trips, 0);
  h.advance(1000);
  await h.runTick();
  assert.equal(h.scheduler.snapshot().state, 'running');
});

test('HTTP 429 trips the breaker immediately and honours Retry-After', async () => {
  let limited = true;
  const h = harness({ upstream: () => (limited ? { httpStatus: 429, retryAfter: '30' } : {}) });
  h.scheduler.setTargets(buildGroups([{ userKey: 'u', partNumber: 'AAAAACH/A', storeNumbers: ['R577'] }]));
  await h.runTick();
  const snap = h.scheduler.snapshot();
  assert.equal(snap.breaker.state, 'open');
  assert.equal(snap.breaker.reason, 'http_429');
  assert.equal(snap.breaker.until - h.state.nowMs, 30000);
  h.advance(29000);
  assert.equal(h.scheduler.tick().length, 0);
  h.advance(1000);
  limited = false;
  await Promise.all(h.scheduler.tick());
  assert.equal(h.scheduler.snapshot().breaker.state, 'closed');
});

test('removing a follow drops its group; health keeps measured intervals', async () => {
  const h = harness();
  h.scheduler.setTargets(buildGroups(follows));
  await h.runTick();
  h.advance(1000);
  await h.runTick();
  h.advance(1500);
  await h.runTick();
  const before = h.scheduler.snapshot();
  const r577 = before.targets.find(t => t.storeNumber === 'R577');
  assert.equal(r577.health.requests, 3);
  assert.equal(r577.health.requestInterval.count, 2);
  assert.ok(r577.health.requestInterval.maxMs >= 1500, 'intervals are measured from real request starts');
  assert.equal(r577.health.successInterval.count, 2);
  h.scheduler.setTargets(buildGroups(follows.slice(1)));
  const after = h.scheduler.snapshot();
  assert.deepEqual(after.targets.map(t => t.storeNumber), ['R577']);
  assert.equal(after.targets[0].health.requests, 3, 'surviving groups keep their history');
  h.scheduler.pause();
  h.advance(5000);
  assert.equal(h.scheduler.tick().length, 0);
  assert.equal(h.scheduler.snapshot().state, 'paused');
  h.scheduler.resume();
  assert.equal(h.scheduler.tick().length, 1);
});
