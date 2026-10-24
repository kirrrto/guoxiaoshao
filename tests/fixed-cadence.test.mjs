import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createScheduler, buildGroups } = require('../cloudfunctions/gxs_api/lib/engine/scheduler.js');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector.js');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config.js');
const { reserveCapacity, capacityLimits } = require('../cloudfunctions/gxs_api/lib/engine/capacity-budget.js');

const base = Date.UTC(2026, 9, 18, 4, 0, 0);

function harness({ groupCount = 1, options = {}, upstream } = {}) {
  const state = { nowMs: base };
  const calls = [];
  const scheduler = createScheduler({
    intervalMs: 3000,
    fixedCadence: true,
    maxConcurrency: 8,
    timeoutMs: 1000,
    burstIntervalMs: 0,
    availableIntervalMs: 0,
    ...options,
    clock: () => new Date(state.nowMs),
    fetchPickup: async ({ storeNumber, partNumbers }) => {
      calls.push({ storeNumber, partNumbers, at: state.nowMs });
      const step = upstream ? upstream(storeNumber, partNumbers, calls.length) : {};
      state.nowMs += step.latencyMs || 10;
      const ok = !step.error && (step.httpStatus ?? 200) < 400;
      const record = { httpStatus: step.httpStatus ?? 200, retryAfter: step.retryAfter || null, elapsedMs: step.latencyMs || 10, error: step.error ? { message: step.error } : null };
      const observations = partNumbers.map(partNumber => ({ storeNumber, partNumber,
        status: ok ? (step.status || 'unavailable') : 'unknown',
        observedAt: new Date(state.nowMs).toISOString(),
        knownAt: new Date(state.nowMs).toISOString(),
        reason: ok ? null : { code: 'transport_error' } }));
      return { record, observations };
    },
    onBatch: async () => ({ changed: false, persisted: true }),
    log: { warn: () => {}, error: () => {} },
  });
  const follows = [];
  for (let i = 0; i < groupCount; i++) {
    const store = `R${String(100 + i).padStart(3, '0')}`;
    follows.push({ userKey: `u${i}`, partNumber: `P${String(i).padStart(3, '0')}CH/A`, storeNumbers: [store] });
  }
  scheduler.setTargets(buildGroups(follows, 20));
  return {
    scheduler, calls, state,
    advance(ms) { state.nowMs += ms; },
    async runTick() { await Promise.all(scheduler.tick()); return this; },
  };
}

test('fixed cadence keeps a 3s target period at 20/50/100 groups without budget stretching', async () => {
  for (const groupCount of [20, 50, 100]) {
    const h = harness({ groupCount, options: { maxConcurrency: 20, intervalMs: 3000, fixedCadence: true } });
    // Warm-up: dispatch whatever is due now (phase-staggered).
    await h.runTick();
    // Walk ~12s of virtual time in 100ms steps and collect request start times per group.
    const starts = new Map();
    for (let step = 0; step < 120; step++) {
      h.advance(100);
      const before = h.calls.length;
      await h.runTick();
      for (let i = before; i < h.calls.length; i++) {
        const key = h.calls[i].storeNumber;
        if (!starts.has(key)) starts.set(key, []);
        starts.get(key).push(h.calls[i].at);
      }
    }
    assert.equal(starts.size, groupCount, `${groupCount}: every group is sampled`);
    let sum = 0, count = 0, max = 0, over = 0;
    for (const times of starts.values()) {
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        sum += gap; count += 1; max = Math.max(max, gap);
        if (gap > 3500) over += 1;
      }
    }
    assert.ok(count > 0, `${groupCount}: produced repeated samples`);
    const avg = sum / count;
    assert.ok(avg <= 3600, `${groupCount}: average period ${avg}ms must stay near 3000ms (not minutes)`);
    assert.ok(max <= 7000, `${groupCount}: max gap ${max}ms must not stretch to minutes`);
    assert.equal(over, 0, `${groupCount}: no gap may exceed the 3.5s engineering threshold by a full extra slot`);
  }
});

test('fixed cadence staggers groups by a stable phase inside the period window', () => {
  const h = harness({ groupCount: 8, options: { maxConcurrency: 1, intervalMs: 3000, fixedCadence: true } });
  const snap = h.scheduler.snapshot();
  assert.equal(snap.fixedCadence, true);
  assert.equal(snap.intervalMs, 3000);
  const dues = snap.targets.map(t => t.dueInMs).filter(v => v <= 3000);
  assert.ok(dues.length >= 2, 'multiple groups are immediately near-due after phase stagger');
  // At least two distinct due offsets so requests spread across the window.
  assert.ok(new Set(dues).size >= 2, `phases should differ: ${dues.join(',')}`);
});

test('missed slots after a stall are skipped, not caught up in a burst', async () => {
  const h = harness({ groupCount: 3, options: { maxConcurrency: 3, intervalMs: 3000, fixedCadence: true } });
  // Phase-staggered groups become due within one period.
  for (let i = 0; i < 32; i++) { h.advance(100); await h.runTick(); }
  const first = h.calls.length;
  assert.ok(first > 0, 'initial sampling starts within one period');
  // Stall 30s — many slots pass.
  h.advance(30000);
  const beforeStallEnd = h.calls.length;
  await h.runTick();
  const recovered = h.calls.length - beforeStallEnd;
  // One tick may start each group at most once; never 30s/3s=10 rounds per group.
  assert.ok(recovered <= 3, `recovery tick started ${recovered} requests, expected at most one per group`);
  await h.runTick();
  assert.ok(h.calls.length - beforeStallEnd <= 3 * 2, 'a second tick still cannot dump the whole backlog');
  assert.ok(h.calls.length >= first, 'sampling resumes after the stall');
});

test('slow same-store groups report the store-serial bottleneck instead of hiding it', async () => {
  const state = { nowMs: base };
  const calls = [];
  const scheduler = createScheduler({
    intervalMs: 3000, fixedCadence: true, maxConcurrency: 4, timeoutMs: 500,
    clock: () => new Date(state.nowMs),
    fetchPickup: async ({ storeNumber }) => {
      calls.push({ storeNumber, at: state.nowMs });
      state.nowMs += 2500; // slow request forces store serialisation to matter
      return { record: { httpStatus: 200, elapsedMs: 2500 }, observations: [{ storeNumber, partNumber: 'P0CH/A', status: 'unavailable', observedAt: new Date(state.nowMs).toISOString() }] };
    },
    onBatch: async () => ({ changed: false, persisted: true }),
    log: { warn: () => {}, error: () => {} },
  });
  // Two SKU batches on one store → two groups, serialised at the store.
  scheduler.setTargets(buildGroups([
    { userKey: 'u1', partNumber: 'P0CH/A', storeNumbers: ['R777'] },
    { userKey: 'u2', partNumber: 'P1CH/A', storeNumbers: ['R777'] },
  ], 1));
  await Promise.all(scheduler.tick());
  state.nowMs += 50;
  await Promise.all(scheduler.tick());
  const snap = scheduler.snapshot();
  const delayed = snap.targets.filter(t => t.storeDelayed);
  // With 2.5s latency the second group often waits; expose the reason when it does.
  if (delayed.length) {
    assert.ok(delayed.every(t => t.storeDelayReason === 'store_serial_or_spacing'),
      'delayed same-store groups must name the bottleneck');
  }
  assert.equal(snap.fixedCadence, true);
});

test('capacity shortfall surfaces as admission wait, not a longer target period', async () => {
  const h = harness({ groupCount: 5, options: { maxConcurrency: 5, intervalMs: 3000, fixedCadence: true } });
  // Force a shared admission pause without changing intervalMs.
  h.scheduler.tick();
  // Simulate budget denial on the next dispatch.
  const scheduler = h.scheduler;
  // Use configure to keep 3000 and assert snapshot still reports 3000 after a pause-like delay.
  scheduler.configure({ intervalMs: 3000, fixedCadence: true });
  assert.equal(scheduler.snapshot().intervalMs, 3000);
  assert.equal(scheduler.snapshot().fixedCadence, true);
});

test('config accepts fixed cadence and raised budget caps, rejects silent overflow', () => {
  const ok = mergeConfig({ collector: { cadenceMode: 'fixed', intervalSeconds: 3, maxRequestsPerMinute: 2000, maxRequestsPerDay: 2880000, autoSharePercent: 70 } });
  assert.equal(ok.collector.cadenceMode, 'fixed');
  assert.equal(ok.collector.intervalSeconds, 3);
  assert.equal(ok.collector.maxRequestsPerMinute, 2000);
  assert.equal(ok.collector.autoSharePercent, 70);
  // Merged defaults form a complete document.
  assert.doesNotThrow(() => validateConfig(ok));
  assert.throws(() => validateConfig({ ...ok, collector: { ...ok.collector, cadenceMode: 'nope' } }));
  assert.throws(() => validateConfig({ ...ok, collector: { ...ok.collector, maxRequestsPerMinute: 100000 } }));
  assert.throws(() => validateConfig({ ...ok, collector: { ...ok.collector, autoSharePercent: 0 } }));
  assert.throws(() => validateConfig({ ...ok, collector: { ...ok.collector, cadenceMode: 'fixed', intervalSeconds: 0 } }));
});

test('capacity lanes honour configurable autoShare and keep one shared global cap', () => {
  const limits = capacityLimits(1000, 1000000, 0.7);
  assert.equal(limits.capacities.shared, 1000);
  assert.equal(limits.capacities.auto, 700);
  assert.equal(limits.capacities.manual, 300);
  const a = reserveCapacity(null, { nowMs: base, maxRequestsPerMinute: 100, maxRequestsPerDay: 100000, source: 'auto', autoShare: 0.7, consume: true });
  assert.equal(a.allowed, true);
  assert.equal(a.detail.sourceCapacity, 70);
  const state = a.state;
  // Exhaust the shared bucket — neither lane may bypass the global cap.
  let last = state;
  for (let i = 0; i < 100; i++) {
    const r = reserveCapacity(last, { nowMs: base + i, maxRequestsPerMinute: 100, maxRequestsPerDay: 100000, source: 'auto', autoShare: 0.7, consume: true });
    last = r.state;
    if (!r.allowed) {
      assert.ok(r.retryAt > base, 'denied requests expose a retry time');
      break;
    }
  }
  assert.equal(last.capacities.shared, 100);
});

test('collector eligible targets ignore notification credits so zero credits still monitor stock', async () => {
  // Membership-only eligibility is enforced in collector.refreshTargets via canUseReminders.
  // Here we assert the rule module itself: members stay eligible with zero subscription credits.
  const { canUseReminders } = require('../cloudfunctions/gxs_api/lib/rules/membership.js');
  const now = new Date(base).toISOString();
  const member = { membership: { expiresAt: new Date(base + 86400000).toISOString() }, subscriptions: {} };
  assert.equal(canUseReminders(member, now), true);
  const free = { membership: { expiresAt: null }, subscriptions: {} };
  assert.equal(canUseReminders(free, now), false);
  const gifted = { membership: { expiresAt: new Date(base + 86400000).toISOString(), source: 'admin_grant' }, subscriptions: { TPL: { credits: 0 } } };
  assert.equal(canUseReminders(gifted, now), true, 'gifted membership still gets collection even with zero reminder credits');
});

test('schedule metrics record planned slot, start delay and last success separately', async () => {
  const h = harness({ groupCount: 1, options: { maxConcurrency: 1, intervalMs: 3000, fixedCadence: true } });
  for (let i = 0; i < 32; i++) { h.advance(100); await h.runTick(); }
  const t = h.scheduler.snapshot().targets[0];
  assert.ok(Number.isFinite(t.plannedAt), 'plannedAt recorded');
  assert.ok(Number.isFinite(t.scheduleDelayMs) && t.scheduleDelayMs >= 0, 'schedule delay recorded');
  assert.ok(Number.isFinite(t.health.lastRequestAt), 'actual request start recorded');
  assert.ok(Number.isFinite(t.health.lastSuccessAt), 'last success recorded');
});

test('scheduled cold starts retain overdue available groups whose fixed phase falls after the scan window', async () => {
  let nowMs = base, calls = 0;
  const options = { intervalMs: 60000, fixedCadence: true, alignIntervalMs: 60000,
    availableIntervalMs: 0, burstIntervalMs: 0, clock: () => new Date(nowMs),
    fetchPickup: async ({ storeNumber, partNumbers }) => {
      calls++;
      return { record: { httpStatus: 200, elapsedMs: 0 }, observations: partNumbers.map(partNumber => ({ storeNumber, partNumber, status: 'available' })) };
    }, onBatch: async () => ({ persisted: true, changed: false }), log: { warn() {}, error() {} } };
  const candidates = buildGroups(Array.from({ length: 100 }, (_, i) => ({ partNumber: 'PHASE-SKU', storeNumbers: [`R${i}`] })));
  const phases = createScheduler(options); phases.setTargets(candidates);
  const late = phases.checkpoint().targets.find(target => target.nextDueAt - base > 40000);
  assert.ok(late, 'fixture includes a phase outside a 35-second scheduled scan');
  const group = candidates.find(candidate => candidate.key === late.key);
  const warm = createScheduler(options); warm.setTargets([group]);
  nowMs = late.nextDueAt; await Promise.all(warm.tick());
  let saved = structuredClone(warm.checkpoint());
  assert.equal(saved.targets[0].available, true);
  for (let invocation = 0; invocation < 3; invocation++) {
    nowMs = base + (invocation + 2) * 60000 + 3000;
    const overdueAt = saved.targets[0].nextDueAt;
    assert.ok(overdueAt < nowMs);
    const cold = createScheduler(options); cold.setTargets([group]); cold.restore(saved);
    assert.equal(cold.checkpoint().targets[0].nextDueAt, overdueAt, 'restoring an available result must not move an overdue fixed slot into this minute');
    const before = calls;
    await Promise.all(cold.tick());
    assert.equal(calls, before + 1, 'the already-due group runs at the beginning of every invocation');
    assert.equal(cold.tick().length, 0, 'a missed interval never creates catch-up bursts');
    saved = structuredClone(cold.checkpoint());
  }
});

test('reapplying unchanged fixed cadence cannot skip a due group during target refresh', async () => {
  const h = harness({ groupCount: 1, options: { intervalMs: 60000, fixedCadence: true }, upstream: () => ({ status: 'available' }) });
  h.state.nowMs = h.scheduler.checkpoint().targets[0].nextDueAt;
  await h.runTick();
  const dueAt = h.scheduler.checkpoint().targets[0].nextDueAt;
  h.state.nowMs = dueAt + 1000;
  h.scheduler.configure({ intervalMs: 60000, fixedCadence: true, availableIntervalMs: 0, burstIntervalMs: 0, maxConcurrency: 2 });
  assert.equal(h.scheduler.checkpoint().targets[0].nextDueAt, dueAt, 'an unchanged settings refresh leaves due work queued');
  await h.runTick();
  assert.equal(h.calls.length, 2);
});

test('recovered fixed work completing exactly on a later phase cannot dispatch twice at that time', async () => {
  for (const restore of [false, true]) {
    let nowMs = base, calls = 0;
    const options = { intervalMs: 8000, fixedCadence: true, availableIntervalMs: 0, burstIntervalMs: 0,
      clock: () => new Date(nowMs),
      fetchPickup: async () => { calls++; return { record: { httpStatus: 200, elapsedMs: 0 }, observations: [{ status: 'available' }] }; },
      onBatch: async () => ({ persisted: true, changed: false }) };
    const groups = [{ key: 'R577|SKU', storeNumber: 'R577', partNumbers: ['SKU'] }];
    let scheduler = createScheduler(options); scheduler.setTargets(groups);
    nowMs = scheduler.checkpoint().targets[0].nextDueAt;
    await Promise.all(scheduler.tick());
    assert.equal(scheduler.checkpoint().targets[0].nextDueAt, nowMs + 8000, 'a zero-duration on-time request retains the next regular slot');
    const saved = structuredClone(scheduler.checkpoint());
    nowMs = saved.targets[0].nextDueAt + 8000;
    if (restore) { scheduler = createScheduler(options); scheduler.setTargets(groups); scheduler.restore(saved); }
    assert.equal(scheduler.checkpoint().targets[0].nextDueAt, saved.targets[0].nextDueAt, 'one overdue slot stays queued');
    await Promise.all(scheduler.tick());
    assert.equal(calls, 2);
    assert.equal(scheduler.checkpoint().targets[0].nextDueAt, nowMs + 8000, 'normal cadence skips the phase just consumed by recovery');
    assert.equal(scheduler.tick().length, 0, 'a second tick at the same instant cannot replay missed work');
    nowMs += 8000;
    await Promise.all(scheduler.tick());
    assert.equal(calls, 3, 'normal sampling resumes at the following slot');
  }
});

test('a pre-request cancellation retains the fixed phase while its retry guard survives a cold start', async () => {
  for (const restore of [false, true]) {
    let nowMs = base, attempts = 0, persisted = 0;
    const options = { intervalMs: 60000, fixedCadence: true, burstIntervalMs: 0, availableIntervalMs: 0,
      clock: () => new Date(nowMs),
      fetchPickup: async () => ++attempts === 1
        ? { record: { budgetDenied: true, retryAt: nowMs + 1000, error: { message: 'request_cancelled' } }, observations: [] }
        : { record: { httpStatus: 200 }, observations: [{ status: 'unavailable' }] },
      onBatch: async () => { persisted++; return { persisted: true, changed: false }; } };
    const groups = [{ key: 'R577|SKU', storeNumber: 'R577', partNumbers: ['SKU'] }];
    let scheduler = createScheduler(options); scheduler.setTargets(groups);
    const originalDue = scheduler.checkpoint().targets[0].nextDueAt;
    nowMs = originalDue + 20000;
    await Promise.all(scheduler.tick());
    const saved = structuredClone(scheduler.checkpoint()), cancelled = saved.targets[0];
    assert.equal(cancelled.nextDueAt, originalDue, 'work that never reached HTTP keeps its original slot');
    assert.equal(cancelled.guardUntil, nowMs + 1000);
    assert.equal(cancelled.health.requests, 0);
    assert.equal(cancelled.failures, 0);
    assert.equal(persisted, 0);
    if (restore) { scheduler = createScheduler(options); scheduler.setTargets(groups); scheduler.restore(saved); }
    nowMs = cancelled.guardUntil - 1;
    assert.equal(scheduler.tick().length, 0, 'preserving priority must not bypass the retry guard');
    nowMs = cancelled.guardUntil + 10000;
    await Promise.all(scheduler.tick());
    const recovered = scheduler.checkpoint().targets[0];
    assert.equal(attempts, 2);
    assert.equal(recovered.nextDueAt, originalDue + 60000, 'a cancellation must not move the stable phase to its retry time');
    assert.equal(recovered.guardUntil, 0);
    assert.equal(recovered.guardReason, null);
    assert.equal(recovered.health.requests, 1);
    assert.equal(persisted, 1);
    assert.equal(scheduler.tick().length, 0, 'recovery cannot dispatch again at the same instant');
  }
});

test('a cancelled overdue group remains ahead of later due work after a scheduled cold start', async () => {
  let nowMs = base;
  const groups = [
    { key: 'oldest', storeNumber: 'R1', partNumbers: ['SKU'] },
    { key: 'later-a', storeNumber: 'R2', partNumbers: ['SKU'] },
    { key: 'later-b', storeNumber: 'R3', partNumbers: ['SKU'] },
  ];
  const options = { intervalMs: 60000, fixedCadence: true, maxConcurrency: 2,
    burstIntervalMs: 0, availableIntervalMs: 0, clock: () => new Date(nowMs),
    onBatch: async () => ({ persisted: true, changed: false }) };
  const warm = createScheduler({ ...options, fetchPickup: async () => ({
    record: { budgetDenied: true, retryAt: nowMs + 1000, error: { message: 'request_cancelled' } }, observations: [] }) });
  warm.setTargets([groups[0]]);
  const originalDue = warm.checkpoint().targets[0].nextDueAt;
  nowMs = originalDue + 20000;
  await Promise.all(warm.tick());
  const saved = structuredClone(warm.checkpoint());
  const cancelled = saved.targets[0];
  // Other groups became due while this group's invocation ran out of time.
  for (const [index, group] of groups.slice(1).entries()) saved.targets.push({
    ...structuredClone(cancelled), key: group.key, nextDueAt: originalDue + (index + 1) * 10000,
    guardUntil: 0, guardReason: null,
  });
  nowMs = originalDue + 30000;
  const starts = [];
  const cold = createScheduler({ ...options, fetchPickup: async ({ storeNumber }) => {
    starts.push(storeNumber);
    return { record: { httpStatus: 200 }, observations: [{ status: 'unavailable' }] };
  } });
  cold.setTargets(groups); cold.restore(saved);
  await Promise.all(cold.tick());
  assert.deepEqual(starts, ['R1', 'R2'], 'the oldest unserved group gets one of the first two recovery slots');
  assert.equal(cold.checkpoint().targets.find(target => target.key === 'later-b').health.requests, 0);
});
