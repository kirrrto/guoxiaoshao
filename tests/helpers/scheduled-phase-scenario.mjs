import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { runScheduled } = require('../../cloudfunctions/gxs_api/lib/engine/scheduled');
const { createScheduler, buildGroups } = require('../../cloudfunctions/gxs_api/lib/engine/scheduler');
const { COLLECTIONS: C } = require('../../cloudfunctions/gxs_api/lib/collections');

// Exercise the real scheduled collector with one shared virtual clock. Parallel
// DB/HTTP work overlaps instead of advancing the clock once per concurrent call.
export async function scheduledPhaseScenario({ run = runScheduled, available = true, initialAvailable = available,
  groupCount = 21, minutes = 4, oldCheckpoint = true, guard = null, maxRunMs = 45000,
  burstIntervalSeconds = 0, burstQuietSeconds = 4, httpStatus = 200 } = {}) {
  const f = createFixture({ start: '2026-10-26T07:50:00.000Z', config: {
    collector: { enabled: true, cadenceMode: 'fixed', intervalSeconds: 60, maxConcurrency: 2,
      burstIntervalSeconds, burstQuietSeconds, availableIntervalSeconds: 0, budgetMode: 'continuous',
      maxRequestsPerDay: 800000, maxRequestsPerMinute: 600 },
    notifications: { enabled: false },
  } });
  const base = f.state.now.getTime(), partNumber = 'MJYH4CH/A';
  await f.call('user.bootstrap');
  const seed = await f.repo.getUser(userKeyOf()), follows = [];
  for (let index = 0; index < groupCount; index++) {
    const storeNumber = `R${1000 + index}`, userKey = `phase-member-${index}`;
    const follow = { _id: `F${index}`, userKey, partNumber, storeNumbers: [storeNumber], status: 'active', createdAt: f.state.now.toISOString() };
    follows.push(follow);
    await f.repo.createUser({ ...seed, _id: userKey, followIndex: [follow], membership: { expiresAt: '2027-01-01T00:00:00.000Z' } });
    await f.repo.saveFollow(follow);
    const previous = new Date(base - 60000).toISOString();
    await f.repo.saveLatest({ _id: `${storeNumber}|${partNumber}`, storeNumber, partNumber,
      status: initialAvailable ? 'available' : 'unavailable', observedAt: previous, knownAt: previous,
      statusSince: previous, knownStreakSince: previous });
  }
  if (oldCheckpoint) {
    const old = createScheduler({ clock: () => new Date(base), fixedCadence: true, intervalMs: 60000,
      fetchPickup: async () => {}, onBatch: async () => {} });
    old.setTargets(buildGroups(follows));
    const checkpoint = old.checkpoint();
    for (const target of checkpoint.targets) {
      const previous = target.nextDueAt - 60000;
      target.available = initialAvailable;
      target.availableObservedAt = initialAvailable ? previous : null;
      Object.assign(target.health, { requests: 1, successes: 1, lastRequestAt: previous,
        lastSuccessAt: previous, lastPersistedAt: previous, lastPersistedSuccessAt: previous });
      if (guard === 'target') { target.guardUntil = base + 90000; target.guardReason = 'capacity_wait'; }
    }
    if (guard === 'quota') { checkpoint.admissionUntil = base + 90000; checkpoint.admissionReason = 'capacity_wait'; }
    if (guard === '429') checkpoint.breaker = { state: 'open', until: base + 90000, openedAt: base,
      reason: 'http_429', failures: [], trips: 1, probeInFlight: false };
    await f.repo.saveCollectorStatus({ _id: 'collector_status', mode: 'scheduled', intervalMs: 60000,
      cadenceMode: 'fixed', budget: { budgetMode: 'continuous' }, stats: {}, scheduler: checkpoint });
  }
  let nowMs = base, sequence = 0, activeHttp = 0, maxActiveHttp = 0;
  const timers = [], starts = [], rows = [];
  const sleep = ms => new Promise(resolve => timers.push({ at: nowMs + ms, sequence: sequence++, resolve }));
  const calls = {};
  for (const name of Object.keys(f.repo)) {
    if (typeof f.repo[name] !== 'function') continue;
    const original = f.repo[name];
    f.repo[name] = async (...args) => { calls[name] = (calls[name] || 0) + 1; await sleep(200); return original(...args); };
  }
  const raw = fakeFetch(() => ({ display: available ? 'available' : 'unavailable', status: httpStatus }));
  const fetchImpl = async (...args) => {
    starts.push({ store: new URL(String(args[0])).searchParams.get('store'), at: nowMs });
    maxActiveHttp = Math.max(maxActiveHttp, ++activeHttp);
    try { await sleep(800); return await raw(...args); }
    finally { activeHttp--; }
  };
  for (let minute = 0; minute < minutes; minute++) {
    nowMs = base + minute * 60000 + 1000; f.state.now = new Date(nowMs);
    const startedAt = nowMs, before = starts.length, beforeCalls = { ...calls };
    let done = false, result, error;
    const work = run({ repo: f.repo, fetchImpl, sendImpl: null, clock: () => new Date(nowMs), sleep,
      log: { info() {}, warn() {}, error() {} }, ownerId: `phase-${minute}`, maxRunMs })
      .then(value => { result = value; done = true; }, caught => { error = caught; done = true; });
    for (let turns = 0; !done; turns++) {
      if (turns >= 10000) throw Error('scheduled phase scenario did not settle');
      await new Promise(resolve => setImmediate(resolve));
      if (done) break;
      timers.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
      if (!timers.length) throw Error('scheduled phase scenario has no pending virtual operation');
      nowMs = timers[0].at; f.state.now = new Date(nowMs);
      while (timers.length && timers[0].at === nowMs) timers.shift().resolve();
    }
    await work;
    if (error) throw error;
    const status = f.repo.tables.get(C.config).get('collector_status'), minuteStarts = starts.slice(before);
    rows.push({ minute, scanned: result.scanned, requests: minuteStarts.length,
      uniqueStores: new Set(minuteStarts.map(item => item.store)).size, elapsedMs: nowMs - startedAt,
      startsMs: minuteStarts.map(item => item.at - startedAt),
      phaseRemainders: [...new Set(status.scheduler.targets.map(target => target.nextDueAt % 60000))].sort((a, b) => a - b),
      cadenceMode: status.cadenceMode, intervalMs: status.intervalMs, deadlineReached: result.deadlineReached,
      admissionUntil: status.scheduler.admissionUntil, breakerUntil: status.scheduler.breaker.until,
      repoCalls: Object.fromEntries(Object.entries(calls).map(([name, count]) => [name, count - (beforeCalls[name] || 0)])) });
  }
  return { offline: true, groupCount, maxActiveHttp, rows };
}
