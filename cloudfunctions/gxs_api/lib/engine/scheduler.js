'use strict';
/**
 * Second-level collection scheduler (pure: clock, fetch and persistence are
 * injected; no timers inside). The resident collector drives it with `tick()`.
 *
 * Targets are request groups: one store × the SKUs followed there, deduped
 * across users. For every group the scheduler guarantees:
 *  - at most one request in flight (no stacking while the previous one runs);
 *  - a target period of `intervalMs` between request starts;
 *  - exponential backoff after failures, reset on the first success;
 *  - a global concurrency cap;
 *  - a global circuit breaker that opens on bursts of failures or on 429/503,
 *    honours Retry-After, then half-opens with one probe before closing;
 *  - burst mode: when a batch reports a status change, that group is checked
 *    every `burstIntervalMs` until `burstQuietMs` pass without another change.
 * Per-group health counters record real request/success intervals so the UI
 * can show measured coverage instead of a countdown.
 */
const DEFAULTS = Object.freeze({
  intervalMs: 1000,
  burstIntervalMs: 0, // 0 disables burst mode
  burstQuietMs: 20000,
  availableIntervalMs: 0, // explicit opt-in, independently of status-change bursts
  maxConcurrency: 2,
  timeoutMs: 8000,
  backoff: { baseMs: 2000, factor: 2, maxMs: 60000 },
  breaker: { failureThreshold: 5, windowMs: 30000, cooldownMs: 60000, maxCooldownMs: 10 * 60 * 1000 },
});

const groupKeyOf = (storeNumber, partNumbers) => `${storeNumber}|${[...partNumbers].sort().join(',')}`;
const ADMISSION_REASONS = new Set(['capacity_wait', 'minute_budget', 'daily_budget', 'auto_budget_reserved', 'upstream_paused']);
const DAILY_REASONS = new Set(['daily_budget', 'auto_budget_reserved']);

/** Merge follows into store-level request groups; identical targets are collapsed. */
function buildGroups(follows, maxPartsPerRequest = 20) {
  const byStore = new Map();
  for (const follow of follows) {
    for (const storeNumber of follow.storeNumbers) {
      const set = byStore.get(storeNumber) || new Set();
      set.add(follow.partNumber);
      byStore.set(storeNumber, set);
    }
  }
  return [...byStore.entries()].flatMap(([storeNumber, parts]) => {
    const partNumbers = [...parts].sort();
    const size = Math.max(1, Math.min(50, Math.floor(maxPartsPerRequest) || 20));
    const batches = [];
    for (let i = 0; i < partNumbers.length; i += size) {
      const batch = partNumbers.slice(i, i + size);
      batches.push({ key: groupKeyOf(storeNumber, batch), storeNumber, partNumbers: batch });
    }
    return batches;
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function emptyHealth() {
  return {
    requests: 0, successes: 0, failures: 0, consecutiveFailures: 0,
    lastRequestAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null,
    persistenceFailed: false, persistenceFailures: 0, lastPersistedAt: null, lastPersistedSuccessAt: null,
    requestInterval: { count: 0, sumMs: 0, maxMs: 0 },
    successInterval: { count: 0, sumMs: 0, maxMs: 0 },
    latency: { count: 0, sumMs: 0, maxMs: 0 },
  };
}

function addSample(stat, value) {
  stat.count += 1;
  stat.sumMs += value;
  if (value > stat.maxMs) stat.maxMs = value;
}

function createScheduler(options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  opts.backoff = { ...DEFAULTS.backoff, ...(options && options.backoff) };
  opts.breaker = { ...DEFAULTS.breaker, ...(options && options.breaker) };
  const { clock, fetchPickup, onBatch, log } = opts;
  if (typeof clock !== 'function' || typeof fetchPickup !== 'function' || typeof onBatch !== 'function') {
    throw new TypeError('scheduler requires clock, fetchPickup and onBatch');
  }

  const groups = new Map(); // key → { group, nextDueAt, inFlight, failures, health }
  const pending = new Set(); // includes removed/replaced target groups until their work settles
  const activeStores = new Set();
  const storeLastRequestAt = new Map();
  const breaker = { state: 'closed', openedAt: null, until: null, failures: [], trips: 0, probeInFlight: false, reason: null };
  let paused = false;
  let admissionUntil = 0;
  let admissionReason = null;

  function nextInterval(nowMs) {
    const align = opts.alignIntervalMs || 0;
    return align > 0 ? Math.floor(nowMs / align) * align + Math.ceil(opts.intervalMs / align) * align : nowMs + opts.intervalMs;
  }

  function fastInterval(entry, nowMs) {
    const intervals = [];
    if (opts.burstIntervalMs > 0 && entry.burstUntil > nowMs) intervals.push(opts.burstIntervalMs);
    if (opts.availableIntervalMs > 0 && entry.available) intervals.push(opts.availableIntervalMs);
    return intervals.length ? Math.min(...intervals) : 0;
  }

  function plannedDueAt(entry, requestedAt, nowMs) {
    const normalDue = nextInterval(requestedAt);
    const fast = fastInterval(entry, nowMs);
    return fast ? Math.min(normalDue, requestedAt + fast) : normalDue;
  }

  function dueAt(entry) {
    const previous = storeLastRequestAt.get(entry.group.storeNumber);
    const fast = [opts.burstIntervalMs, opts.availableIntervalMs].filter(value => value > 0);
    const spacing = fast.length ? Math.min(opts.intervalMs, ...fast) : 0;
    return Math.max(entry.nextDueAt, entry.guardUntil || 0, admissionUntil, previous === undefined ? 0 : previous + spacing);
  }

  function configure({ intervalMs, maxConcurrency, timeoutMs, burstIntervalMs, burstQuietMs, availableIntervalMs } = {}) {
    if (availableIntervalMs !== undefined) {
      if (!Number.isSafeInteger(availableIntervalMs) || availableIntervalMs < 0 || availableIntervalMs > 60000 || (availableIntervalMs > 0 && availableIntervalMs < 1000)) throw new TypeError('invalid available interval');
      opts.availableIntervalMs = availableIntervalMs;
    }
    if (burstIntervalMs !== undefined) {
      if (!Number.isFinite(burstIntervalMs) || burstIntervalMs < 0 || burstIntervalMs > 60000) throw new TypeError('invalid burst interval');
      opts.burstIntervalMs = burstIntervalMs;
    }
    if (burstQuietMs !== undefined) {
      if (!Number.isFinite(burstQuietMs) || burstQuietMs < 0 || burstQuietMs > 600000) throw new TypeError('invalid burst quiet period');
      opts.burstQuietMs = burstQuietMs;
    }
    if (intervalMs !== undefined) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new TypeError('invalid collector interval');
      opts.intervalMs = intervalMs;
    }
    if (intervalMs !== undefined || availableIntervalMs !== undefined || burstIntervalMs !== undefined) {
      for (const e of groups.values()) if (!e.failures && e.health.lastRequestAt !== null) e.nextDueAt = plannedDueAt(e, e.health.lastRequestAt, clock().getTime());
    }
    if (maxConcurrency !== undefined) {
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 10) throw new TypeError('invalid collector concurrency');
      opts.maxConcurrency = maxConcurrency;
    }
    if (timeoutMs !== undefined) {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('invalid upstream timeout');
      opts.timeoutMs = timeoutMs;
    }
  }

  function setTargets(nextGroups) {
    const keep = new Set();
    for (const group of nextGroups) {
      keep.add(group.key);
      if (!groups.has(group.key)) {
        groups.set(group.key, { group, trackedAt: clock().getTime(), nextDueAt: 0, inFlight: false, failures: 0, burstUntil: 0, available: false, availableObservedAt: null, health: emptyHealth() });
      }
    }
    for (const key of [...groups.keys()]) if (!keep.has(key)) groups.delete(key);
  }

  function breakerAllows(nowMs) {
    if (breaker.state === 'closed') return true;
    if (breaker.state === 'open') {
      if (nowMs < breaker.until) return false;
      breaker.state = 'half_open';
      breaker.probeInFlight = false;
    }
    return !breaker.probeInFlight;
  }

  function trip(nowMs, reason, retryAfterMs) {
    breaker.trips += 1;
    const cooldown = retryAfterMs || Math.min(opts.breaker.maxCooldownMs, opts.breaker.cooldownMs * 2 ** Math.min(breaker.trips - 1, 6));
    breaker.state = 'open';
    breaker.openedAt = nowMs;
    breaker.until = Math.max(breaker.until || 0, nowMs + cooldown);
    breaker.reason = reason;
    breaker.failures = [];
    breaker.probeInFlight = false;
    if (log) log.warn(`[scheduler] breaker open for ${cooldown}ms: ${reason}`);
  }

  function noteFailure(nowMs, record) {
    const status = record.httpStatus;
    const retryAfterSec = record.retryAfter ? Number(record.retryAfter) : NaN;
    const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000
      : record.retryAfter && Number.isFinite(Date.parse(record.retryAfter)) ? Math.max(0, Date.parse(record.retryAfter) - nowMs) : null;
    if (status === 429 || status === 503) {
      trip(nowMs, `http_${status}`, retryAfterMs);
      return;
    }
    if (breaker.state === 'half_open') {
      trip(nowMs, 'probe_failed', null);
      return;
    }
    breaker.failures = breaker.failures.filter(ts => nowMs - ts <= opts.breaker.windowMs);
    breaker.failures.push(nowMs);
    if (breaker.failures.length >= opts.breaker.failureThreshold) trip(nowMs, 'failure_burst', null);
  }

  function noteSuccess(wasProbe, generation) {
    // Only a probe dispatched after cooldown may close this breaker generation.
    if (breaker.state === 'half_open' && wasProbe && generation === breaker.trips) {
      breaker.state = 'closed';
      breaker.until = null;
      breaker.reason = null;
      breaker.trips = 0;
    }
    if (breaker.state === 'closed') breaker.failures = [];
    if (wasProbe && generation === breaker.trips) breaker.probeInFlight = false;
  }

  function backoffMs(failures) {
    return Math.min(opts.backoff.maxMs, opts.backoff.baseMs * opts.backoff.factor ** Math.max(0, failures - 1));
  }

  async function dispatch(entry, nowMs) {
    const { group, health } = entry;
    entry.inFlight = true;
    const wasProbe = breaker.state === 'half_open';
    const generation = breaker.trips;
    if (wasProbe) breaker.probeInFlight = true;
    let result;
    try {
      result = await fetchPickup({ storeNumber: group.storeNumber, partNumbers: group.partNumbers, timeoutMs: opts.timeoutMs });
    } catch (error) {
      result = { record: { httpStatus: null, error: { message: error.message }, elapsedMs: 0 }, observations: [] };
    }
    const finishedMs = clock().getTime();
    const { record, observations } = result;
    if (record.budgetDenied) {
      entry.nextDueAt = record.retryAt || finishedMs + 60000;
      entry.guardUntil = entry.nextDueAt;
      entry.guardReason = record.error && record.error.message || null;
      // The automatic lane is shared by every store. Once it is exhausted,
      // polling other groups only repeats the same database admission check.
      if (ADMISSION_REASONS.has(entry.guardReason) && entry.guardUntil >= admissionUntil) {
        admissionUntil = entry.guardUntil;
        admissionReason = entry.guardReason;
      }
      entry.inFlight = false;
      if (wasProbe && generation === breaker.trips) breaker.probeInFlight = false;
      return;
    }
    entry.guardUntil = 0;
    entry.guardReason = null;
    // A request outcome invalidates the earlier scheduling evidence. Only a
    // complete known batch explicitly confirmed as persisted may restore it.
    entry.available = false;
    entry.availableObservedAt = null;
    // Admission/lease transactions can delay the real HTTP start after tick().
    // Completion is a conservative bound for it, so no later batch or cold
    // start can squeeze the actual store requests below the required spacing.
    storeLastRequestAt.set(group.storeNumber, Math.max(storeLastRequestAt.get(group.storeNumber) ?? -Infinity, finishedMs));
    if (health.lastRequestAt !== null) addSample(health.requestInterval, nowMs - health.lastRequestAt);
    health.lastRequestAt = nowMs;
    health.requests += 1;
    addSample(health.latency, Number.isFinite(record.elapsedMs) ? record.elapsedMs : finishedMs - nowMs);
    const succeeded = observations.length > 0 && observations.every(o => o.status !== 'unknown');
    if (succeeded) {
      if (health.lastSuccessAt !== null) addSample(health.successInterval, finishedMs - health.lastSuccessAt);
      health.lastSuccessAt = finishedMs;
      health.successes += 1;
      health.consecutiveFailures = 0;
      entry.failures = 0;
      entry.nextDueAt = nextInterval(nowMs);
      noteSuccess(wasProbe, generation);
    } else {
      health.failures += 1;
      health.consecutiveFailures += 1;
      health.lastFailureAt = finishedMs;
      health.lastError = record.error ? record.error.message : (observations[0] && observations[0].reason ? observations[0].reason.code : `http_${record.httpStatus}`);
      entry.failures += 1;
      entry.nextDueAt = finishedMs + backoffMs(entry.failures);
      noteFailure(finishedMs, record);
    }
    try {
      const outcome = await onBatch({ group, record, observations, succeeded, finishedAt: new Date(finishedMs).toISOString() });
      health.persistenceFailed = false;
      // A superseded/duplicate sample can return normally without any write.
      // Only applied observations advance durable-observation freshness.
      if (!outcome || outcome.persisted !== false) {
        health.lastPersistedAt = clock().getTime();
        if (succeeded) health.lastPersistedSuccessAt = finishedMs;
      }
      if (succeeded && outcome && outcome.persisted === true && observations.some(observation => observation.status === 'available')) {
        entry.available = true;
        entry.availableObservedAt = finishedMs;
      }
      // A status change keeps this store on the fast cadence until it stays quiet.
      if (outcome && outcome.changed && opts.burstIntervalMs > 0) entry.burstUntil = finishedMs + opts.burstQuietMs;
      // Burst mode only ever brings the next check forward, never later than the normal cadence.
      const fast = fastInterval(entry, finishedMs);
      if (succeeded && fast > 0) entry.nextDueAt = Math.min(entry.nextDueAt, Math.max(nowMs + fast, finishedMs));
    } catch (error) {
      health.persistenceFailed = true;
      health.persistenceFailures += 1;
      health.lastError = 'observation_persistence_failed';
      entry.failures += 1;
      entry.nextDueAt = clock().getTime() + backoffMs(entry.failures);
      if (log) log.error('[scheduler] onBatch failed', error && error.message);
    } finally {
      entry.inFlight = false;
    }
  }

  /** Check a store's groups now and keep them fast for a while (e.g. a restock seen by a manual query). */
  function hurry(storeNumber, changedAt = clock().getTime()) {
    if (!(opts.burstIntervalMs > 0)) return 0;
    const nowMs = clock().getTime();
    const burstUntil = changedAt + opts.burstQuietMs;
    // Durable events can be read repeatedly while confirmation is pending.
    // Their original change time, not each read, starts the quiet window.
    if (!Number.isFinite(burstUntil) || burstUntil <= nowMs) return 0;
    let count = 0;
    for (const entry of groups.values()) {
      if (entry.group.storeNumber !== storeNumber) continue;
      entry.burstUntil = Math.max(entry.burstUntil || 0, burstUntil);
      // Never closer than the burst interval to this store's previous request.
      const earliest = entry.health.lastRequestAt === null ? nowMs : entry.health.lastRequestAt + opts.burstIntervalMs;
      if (!entry.failures) entry.nextDueAt = Math.min(entry.nextDueAt, Math.max(nowMs, earliest));
      count += 1;
    }
    return count;
  }

  /** True while any group is still on the fast cadence. */
  function bursting() {
    const nowMs = clock().getTime();
    return [...groups.values()].some(e => fastInterval(e, nowMs) > 0);
  }

  /** Dispatch every due group within the concurrency cap. Returns the in-flight promises started by this tick. */
  function tick() {
    const nowMs = clock().getTime();
    if (paused || admissionUntil > nowMs) return [];
    admissionUntil = 0;
    admissionReason = null;
    const inFlight = pending.size;
    let slots = Math.max(0, opts.maxConcurrency - inFlight);
    const started = [];
    const due = [...groups.values()].filter(e => !e.inFlight && dueAt(e) <= nowMs).sort((a, b) => a.nextDueAt - b.nextDueAt || a.group.key.localeCompare(b.group.key));
    for (const entry of due) {
      if (slots <= 0) break;
      // A store may have multiple SKU batches or a changed group key after a
      // follow refresh. They share one request cadence and never overlap.
      const storeNumber = entry.group.storeNumber;
      if (activeStores.has(storeNumber) || dueAt(entry) > nowMs) continue;
      if (!breakerAllows(nowMs)) break;
      slots -= 1;
      activeStores.add(storeNumber);
      storeLastRequestAt.set(storeNumber, nowMs);
      const work = dispatch(entry, nowMs);
      pending.add(work);
      work.finally(() => { pending.delete(work); activeStores.delete(storeNumber); }).catch(error => { if (log) log.error('[scheduler] dispatch failed', error.message); });
      started.push(work);
      if (breaker.state === 'half_open') break; // one probe at a time
    }
    return started;
  }

  function snapshot() {
    const nowMs = clock().getTime();
    const targets = [...groups.values()].map(e => ({
      key: e.group.key, storeNumber: e.group.storeNumber, partNumbers: e.group.partNumbers, trackedAt: e.trackedAt,
      inFlight: e.inFlight, dueInMs: Math.max(0, dueAt(e) - nowMs), storeDelayed: admissionUntil <= nowMs && e.nextDueAt <= nowMs && (e.guardUntil || 0) <= nowMs && dueAt(e) > nowMs,
      failures: e.failures, bursting: fastInterval(e, nowMs) > 0, available: e.available, health: e.health,
    }));
    const state = paused ? 'paused' : breaker.state === 'open' ? 'throttled' : admissionUntil > nowMs ? (admissionReason === 'upstream_paused' ? 'throttled' : 'budget_limited') : breaker.state === 'half_open' ? 'probing' : targets.some(t => t.health.persistenceFailed) ? 'error' : targets.length ? 'running' : 'idle';
    return { state, breaker: { ...breaker, failures: breaker.failures.length }, admissionUntil, admissionReason, groupCount: targets.length, inFlight: pending.size, intervalMs: opts.intervalMs, burstIntervalMs: opts.burstIntervalMs, availableIntervalMs: opts.availableIntervalMs, maxConcurrency: opts.maxConcurrency, targets };
  }

  // Persist due times and the global breaker across scheduled function cold
  // starts. Otherwise each minute would bypass Retry-After and start again at
  // the first target, starving later stores when a scan reaches its deadline.
  function checkpoint() {
    return { version: 1, breaker: { ...breaker, failures: [...breaker.failures], probeInFlight: false }, admissionUntil, admissionReason, storeLastRequestAt: [...storeLastRequestAt], targets: [...groups.values()].map(e => ({ key: e.group.key, trackedAt: e.trackedAt, nextDueAt: e.nextDueAt, guardUntil: e.guardUntil || 0, guardReason: e.guardReason || null, failures: e.failures, burstUntil: e.burstUntil || 0, available: e.available, availableObservedAt: e.availableObservedAt, health: e.health })) };
  }

  function restore(saved) {
    if (!saved || saved.version !== 1) return;
    const restoredAt = clock().getTime();
    const pastTimestamp = (value, fallback = null) => Number.isFinite(value) && value <= restoredAt + 30000 ? value : fallback;
    admissionUntil = Number.isFinite(saved.admissionUntil) ? saved.admissionUntil : 0;
    admissionReason = ADMISSION_REASONS.has(saved.admissionReason) ? saved.admissionReason : null;
    for (const item of Array.isArray(saved.storeLastRequestAt) ? saved.storeLastRequestAt : []) {
      if (Array.isArray(item) && typeof item[0] === 'string' && Number.isFinite(item[1])) storeLastRequestAt.set(item[0], pastTimestamp(item[1], restoredAt));
    }
    for (const item of Array.isArray(saved.targets) ? saved.targets : []) {
      // Older checkpoints lack the store-level field; group health still
      // proves the last request, including a group no longer followed.
      if (typeof item.key === 'string' && item.health && Number.isFinite(item.health.lastRequestAt)) {
        const storeNumber = item.key.split('|')[0];
        storeLastRequestAt.set(storeNumber, Math.max(storeLastRequestAt.get(storeNumber) ?? -Infinity, pastTimestamp(item.health.lastRequestAt, restoredAt)));
      }
      const entry = groups.get(item.key);
      if (!entry || !Number.isFinite(item.nextDueAt)) continue;
      // A clock correction must not leave health in warming_up forever. Save
      // the first trustworthy recovery time across cold starts, while keeping
      // actual due times and Retry-After protection intact below.
      entry.trackedAt = pastTimestamp(item.trackedAt)
        ?? pastTimestamp(item.health && item.health.lastRequestAt, entry.trackedAt);
      entry.nextDueAt = item.nextDueAt;
      entry.guardUntil = Number.isFinite(item.guardUntil) ? item.guardUntil : 0;
      entry.guardReason = typeof item.guardReason === 'string' ? item.guardReason : null;
      entry.failures = Math.max(0, Number(item.failures) || 0);
      entry.burstUntil = Number.isFinite(item.burstUntil) ? item.burstUntil : 0;
      if (item.health && typeof item.health === 'object') {
        entry.health = { ...emptyHealth(), ...item.health };
        if (Number.isFinite(entry.health.lastRequestAt)) entry.health.lastRequestAt = pastTimestamp(entry.health.lastRequestAt, restoredAt);
        // Discard future success evidence; rewriting it to now would invent a
        // successful observation that was never confirmed by this clock.
        for (const key of ['lastSuccessAt', 'lastPersistedAt', 'lastPersistedSuccessAt']) entry.health[key] = pastTimestamp(entry.health[key]);
      }
      // Legacy/future/failed checkpoints cannot prove a successful available
      // observation. Guard/backoff fields remain authoritative across toggles.
      entry.available = item.available === true && Number.isFinite(item.availableObservedAt) && item.availableObservedAt <= restoredAt
        && entry.health.lastPersistedSuccessAt === item.availableObservedAt && !entry.health.persistenceFailed
        && (entry.health.lastFailureAt === null || entry.health.lastFailureAt <= item.availableObservedAt);
      entry.availableObservedAt = entry.available ? item.availableObservedAt : null;
      if (entry.available && !entry.failures && !entry.guardUntil && entry.health.lastRequestAt !== null) {
        entry.nextDueAt = plannedDueAt(entry, entry.health.lastRequestAt, restoredAt);
      }
    }
    if (saved.breaker && ['closed', 'open', 'half_open'].includes(saved.breaker.state)) {
      Object.assign(breaker, saved.breaker, { failures: Array.isArray(saved.breaker.failures) ? saved.breaker.failures : [], probeInFlight: false });
    }
  }

  /** Remove a retired calendar-day admission stop without clearing source protection. */
  function resetDailyAdmission(retryAt) {
    const nowMs = clock().getTime();
    const dailyDeferral = (reason, until) => DAILY_REASONS.has(reason)
      || (!reason && Number.isFinite(retryAt) && until === retryAt);
    if (dailyDeferral(admissionReason, admissionUntil)) {
      admissionUntil = 0;
      admissionReason = null;
    }
    for (const entry of groups.values()) {
      if (!dailyDeferral(entry.guardReason, entry.guardUntil || entry.nextDueAt)) continue;
      entry.guardUntil = 0;
      entry.guardReason = null;
      // Old checkpoints have only nextDueAt. A daily denial replaced that
      // value, so recover any real failure backoff from its health timestamp.
      const lastFailureAt = Math.max(entry.health.lastFailureAt || 0,
        entry.health.persistenceFailed ? entry.health.lastRequestAt || 0 : 0);
      entry.nextDueAt = Math.max(nowMs, entry.failures ? lastFailureAt + backoffMs(entry.failures) : 0);
    }
  }

  return {
    setTargets,
    configure,
    drain: () => Promise.allSettled([...pending]),
    tick,
    hurry,
    bursting,
    snapshot,
    checkpoint,
    restore,
    resetDailyAdmission,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    nextDueInMs: () => {
      const nowMs = clock().getTime();
      const pending = [...groups.values()].filter(e => !e.inFlight && !activeStores.has(e.group.storeNumber)).map(dueAt);
      const nextTargetAt = pending.length ? Math.min(...pending) : nowMs + opts.intervalMs;
      return Math.max(0, Math.max(nextTargetAt, admissionUntil, breaker.state === 'open' ? breaker.until || 0 : 0) - nowMs);
    },
  };
}

module.exports = { DEFAULTS, buildGroups, groupKeyOf, createScheduler };
