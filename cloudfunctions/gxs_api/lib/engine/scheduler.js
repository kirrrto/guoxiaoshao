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
 *    honours Retry-After, then half-opens with one probe before closing.
 * Per-group health counters record real request/success intervals so the UI
 * can show measured coverage instead of a countdown.
 */
const DEFAULTS = Object.freeze({
  intervalMs: 1000,
  maxConcurrency: 2,
  timeoutMs: 8000,
  backoff: { baseMs: 2000, factor: 2, maxMs: 60000 },
  breaker: { failureThreshold: 5, windowMs: 30000, cooldownMs: 60000, maxCooldownMs: 10 * 60 * 1000 },
});

const groupKeyOf = (storeNumber, partNumbers) => `${storeNumber}|${[...partNumbers].sort().join(',')}`;

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
    persistenceFailed: false, persistenceFailures: 0, lastPersistedAt: null,
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
  const breaker = { state: 'closed', openedAt: null, until: null, failures: [], trips: 0, probeInFlight: false, reason: null };
  let paused = false;

  function nextInterval(nowMs) {
    const align = opts.alignIntervalMs || 0;
    return align > 0 ? Math.floor(nowMs / align) * align + Math.ceil(opts.intervalMs / align) * align : nowMs + opts.intervalMs;
  }

  function configure({ intervalMs, maxConcurrency, timeoutMs } = {}) {
    if (intervalMs !== undefined) {
      if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new TypeError('invalid collector interval');
      opts.intervalMs = intervalMs;
      for (const e of groups.values()) if (!e.failures && e.health.lastRequestAt !== null) e.nextDueAt = nextInterval(e.health.lastRequestAt);
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
        groups.set(group.key, { group, nextDueAt: 0, inFlight: false, failures: 0, health: emptyHealth() });
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
    if (health.lastRequestAt !== null) addSample(health.requestInterval, nowMs - health.lastRequestAt);
    health.lastRequestAt = nowMs;
    health.requests += 1;
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
      entry.inFlight = false;
      if (wasProbe && generation === breaker.trips) breaker.probeInFlight = false;
      return;
    }
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
      await onBatch({ group, record, observations, succeeded, finishedAt: new Date(finishedMs).toISOString() });
      health.persistenceFailed = false;
      health.lastPersistedAt = clock().getTime();
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

  /** Dispatch every due group within the concurrency cap. Returns the in-flight promises started by this tick. */
  function tick() {
    const nowMs = clock().getTime();
    if (paused) return [];
    const inFlight = pending.size;
    let slots = Math.max(0, opts.maxConcurrency - inFlight);
    const started = [];
    const due = [...groups.values()].filter(e => !e.inFlight && e.nextDueAt <= nowMs).sort((a, b) => a.nextDueAt - b.nextDueAt || a.group.key.localeCompare(b.group.key));
    for (const entry of due) {
      if (slots <= 0) break;
      if (!breakerAllows(nowMs)) break;
      slots -= 1;
      const work = dispatch(entry, nowMs);
      pending.add(work);
      work.finally(() => pending.delete(work)).catch(error => { if (log) log.error('[scheduler] dispatch failed', error.message); });
      started.push(work);
      if (breaker.state === 'half_open') break; // one probe at a time
    }
    return started;
  }

  function snapshot() {
    const nowMs = clock().getTime();
    const targets = [...groups.values()].map(e => ({
      key: e.group.key, storeNumber: e.group.storeNumber, partNumbers: e.group.partNumbers,
      inFlight: e.inFlight, dueInMs: Math.max(0, e.nextDueAt - nowMs), failures: e.failures, health: e.health,
    }));
    const state = paused ? 'paused' : breaker.state === 'open' ? 'throttled' : breaker.state === 'half_open' ? 'probing' : targets.some(t => t.health.persistenceFailed) ? 'error' : targets.length ? 'running' : 'idle';
    return { state, breaker: { ...breaker, failures: breaker.failures.length }, groupCount: targets.length, inFlight: pending.size, intervalMs: opts.intervalMs, maxConcurrency: opts.maxConcurrency, targets };
  }

  // Persist due times and the global breaker across scheduled function cold
  // starts. Otherwise each minute would bypass Retry-After and start again at
  // the first target, starving later stores when a scan reaches its deadline.
  function checkpoint() {
    return { version: 1, breaker: { ...breaker, failures: [...breaker.failures], probeInFlight: false }, targets: [...groups.values()].map(e => ({ key: e.group.key, nextDueAt: e.nextDueAt, failures: e.failures, health: e.health })) };
  }

  function restore(saved) {
    if (!saved || saved.version !== 1) return;
    for (const item of Array.isArray(saved.targets) ? saved.targets : []) {
      const entry = groups.get(item.key);
      if (!entry || !Number.isFinite(item.nextDueAt)) continue;
      entry.nextDueAt = item.nextDueAt;
      entry.failures = Math.max(0, Number(item.failures) || 0);
      if (item.health && typeof item.health === 'object') entry.health = { ...emptyHealth(), ...item.health };
    }
    if (saved.breaker && ['closed', 'open', 'half_open'].includes(saved.breaker.state)) {
      Object.assign(breaker, saved.breaker, { failures: Array.isArray(saved.breaker.failures) ? saved.breaker.failures : [], probeInFlight: false });
    }
  }

  return {
    setTargets,
    configure,
    drain: () => Promise.allSettled([...pending]),
    tick,
    snapshot,
    checkpoint,
    restore,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    nextDueInMs: () => {
      const nowMs = clock().getTime();
      const pending = [...groups.values()].filter(e => !e.inFlight).map(e => e.nextDueAt);
      if (breaker.state === 'open') return Math.max(0, breaker.until - nowMs);
      return pending.length ? Math.max(0, Math.min(...pending) - nowMs) : opts.intervalMs;
    },
  };
}

module.exports = { DEFAULTS, buildGroups, groupKeyOf, createScheduler };
