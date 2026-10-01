'use strict';
/**
 * Resident collector: lease → targets from active members' follows → scheduler
 * → persist observations/events → notification tasks → status for the UI.
 *
 * Designed to run as a single CloudBase Run instance later; nothing here
 * starts by itself. `step()` performs one iteration so tests can drive it with
 * a fake clock and a simulated upstream; `run()` is the production loop.
 */
const { mergeConfig } = require('../config');
const { canUseReminders } = require('../rules/membership');
const { guardedPickup } = require('./guarded-pickup');
const { createScheduler, buildGroups } = require('./scheduler');
const { createLeaseKeeper } = require('./lease');
const { recordObservations } = require('./observations');
const { buildTasks, sendTask, TASK_STATUS, alertKind } = require('./notifier');
const { targetKeyOf } = require('./events');

function createCollector({ repo, fetchImpl, clock = () => new Date(), log = console, sendImpl = null, ownerId = `collector-${process.pid}-${Date.now()}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), refreshEveryMs = 10000, statusEveryMs = 5000, mode = 'resident', minimumIntervalMs = 0, statusTtlMs = 0, shouldContinue = () => true, remainingMs = () => Infinity }) {
  let config = mergeConfig(null);
  let lastRefreshAt = -Infinity;
  let lastStatusAt = -Infinity;
  let lastSenderProbeAt = -Infinity;
  let running = false;
  let stopping = false;
  let budget = { allowed: true, reason: null, minuteCount: 0, dayCount: 0 };
  const stats = { batches: 0, observations: 0, events: 0, tasks: 0, sent: 0, lastBatchAt: null };

  const lease = createLeaseKeeper({ repo, ownerId, ttlMs: 15000, clock, log });
  // Renewal transactions can consume part of their own TTL. Bound external
  // work by the lease actually returned, not its nominal 15-second duration.
  const remainingWorkMs = () => lease.isHeld()
    ? Math.max(0, Math.min(remainingMs(), Date.parse(lease.expiresAt()) - clock().getTime())) : 0;
  const scheduler = createScheduler({
    clock,
    log,
    alignIntervalMs: mode === 'scheduled' ? 60000 : 0,
    fetchPickup: async ({ storeNumber, partNumbers, timeoutMs }) => {
      if (stopping || !lease.isHeld()) return { record: { httpStatus: null, error: { message: 'lease_lost' } }, observations: [] };
      return guardedPickup({ repo, config, clock, fetchImpl, storeNumber, partNumbers, timeoutMs, source: 'auto', remainingMs: remainingWorkMs,
        onBudget: value => { budget = value; }, beforeRequest: async () => !stopping && shouldContinue() && await lease.renew() && lease.isHeld() && shouldContinue() });
    },
    onBatch: handleBatch,
  });

  function ctx() {
    const now = clock();
    return { repo, config, now, nowIso: now.toISOString(), clock, log, collectorOwnerId: ownerId };
  }

  // Notification work is serialised: concurrent batches must not both spend a user's single subscription credit.
  let notifyChain = Promise.resolve();
  function serialised(task) {
    const next = notifyChain.then(task, task);
    notifyChain = next.catch(() => {});
    return next;
  }

  async function handleBatch({ observations }) {
    if (stopping || !await lease.renew()) throw new Error('collector_lease_lost');
    const recorded = await recordObservations(ctx(), observations, 'auto');
    stats.batches += 1;
    stats.observations += observations.length;
    stats.lastBatchAt = clock().toISOString();
    const events = recorded.flatMap(r => r.events).length;
    stats.events += events;
    await drainNotifications();
    // Any status change puts this store on the fast cadence (see scheduler burst mode).
    return { changed: events > 0 };
  }

  /**
   * An alert waits for the next sample to repeat the new status, so one noisy
   * sample cannot send "restocked" and "sold out" in turn. It is also dropped
   * when it only undoes a blip: availability seen once (never confirmed, so
   * never alerted) cannot be "sold out", and "available → sold out for one
   * sample → available" is not a new restock. Returns 'confirmed', 'noise' or 'waiting'.
   */
  async function confirmation(event, latest) {
    const previousWasUnconfirmed = since => event.previousStatusConfirmed === false
      || (event.previousStatusConfirmed == null && since && event.previousKnownAt === since);
    if (event.type === 'became_unavailable' && previousWasUnconfirmed(event.availableSince)) return 'noise';
    if (['restock_confirmed', 'recovered_available'].includes(event.type) && event.nonAvailableSince && previousWasUnconfirmed(event.nonAvailableSince)
      && await repo.getEvent(`${targetKeyOf(event.storeNumber, event.partNumber)}|became_unavailable|${event.nonAvailableSince}`)) return 'noise';
    if (!latest || latest.statusSince !== event.detectedAt || latest.status !== event.status) return latest ? 'noise' : 'waiting';
    // Two valid samples must be consecutive. An unknown result interrupts the
    // streak; merely recovering the same last-known status is not confirmation.
    if (latest.unknownSince) return 'waiting';
    return Date.parse(latest.knownAt) > Date.parse(latest.knownStreakSince || event.detectedAt) ? 'confirmed' : 'waiting';
  }

  async function planEvents(events) {
    const follows = await repo.listActiveFollows();
    const users = new Map((await repo.getUsers([...new Set(follows.map(f => f.userKey))])).map(u => [u._id, u]));
    const alerting = events.filter(e => alertKind(e.type));
    const latestByKey = new Map((alerting.length ? await repo.getLatest([...new Set(alerting.map(e => targetKeyOf(e.storeNumber, e.partNumber)))]) : []).map(l => [l._id, l]));
    const now = clock();
    const maxAgeMs = (config.notifications.maxEventAgeSeconds || 120) * 1000;
    for (const event of events) {
      if (!shouldContinue()) break;
      let planned = [event];
      if (alertKind(event.type)) {
        const state = await confirmation(event, latestByKey.get(targetKeyOf(event.storeNumber, event.partNumber)));
        const expired = now.getTime() - Date.parse(event.detectedAt) > maxAgeMs;
        if (state === 'waiting' && !expired) {
          // Check this store right away; the next drain plans the event once confirmed.
          scheduler.hurry(event.storeNumber, Date.parse(event.detectedAt));
          continue;
        }
        if (state !== 'confirmed') planned = [];
      }
      const tasks = buildTasks({ events: planned, follows, users, config, now });
      for (const task of tasks) {
        if (!shouldContinue()) return;
        if (await repo.saveNotification(task)) stats.tasks += 1;
      }
      // Only commit the cursor after ALL deterministic tasks are durable. A
      // failure/restart replays planning safely; already-created tasks dedupe.
      await repo.markEventPlanned(event._id, now.toISOString());
    }
  }

  function drainNotifications() {
    return serialised(async () => {
      if (stopping || !lease.isHeld() || !shouldContinue()) return;
      config = mergeConfig(await repo.getConfig());
      await repo.reconcileExpiredNotifications({ now: clock().toISOString() });
      // Ten minutes is well past the send window, so an old backlog never delays new alerts.
      const since = new Date(clock().getTime() - Math.max(600, config.notifications.maxEventAgeSeconds || 120) * 1000).toISOString();
      const events = await repo.listUnprocessedEvents({ limit: 50, since });
      if (events.length) await planEvents(events);
      if (!sendImpl || sendImpl.enabled === false) return;
      if (typeof sendImpl.getHealth === 'function' && !sendImpl.getHealth().authReady) return;
      for (const task of await repo.listPendingNotifications({ limit: 20 })) {
        if (stopping || !shouldContinue() || !await lease.renew()) break;
        if (typeof sendImpl.getHealth === 'function' && !sendImpl.getHealth().authReady) break;
        const result = await sendTask({ task, config, sendImpl, repo, now: clock(), clock, ownerId, remainingMs: remainingWorkMs,
          beforeSend: async () => !stopping && shouldContinue() && await lease.renew() && lease.isHeld() && shouldContinue() });
        if (result.status === TASK_STATUS.accepted) stats.sent += 1;
      }
    });
  }

  async function refreshTargets() {
    const stored = await repo.getConfig();
    config = mergeConfig(stored);
    const follows = await repo.listActiveFollows();
    const users = new Map((await repo.getUsers([...new Set(follows.map(f => f.userKey))])).map(u => [u._id, u]));
    const now = clock();
    const eligible = follows.filter(f => users.has(f.userKey) && canUseReminders(users.get(f.userKey), now));
    const groups = config.collector.enabled ? buildGroups(eligible, config.collector.maxPartsPerRequest || 20) : [];
    // Scheduled scans should last throughout the day as the target count changes.
    // Resident mode keeps its configured cadence; the guard still reserves capacity.
    const autoLimit = Math.max(1, Math.floor(config.collector.maxRequestsPerDay * 0.8));
    const budgetIntervalMs = mode === 'scheduled' ? Math.ceil(groups.length * 86400000 / autoLimit) : 0;
    scheduler.configure({ intervalMs: Math.min(3600000, Math.max(minimumIntervalMs, config.collector.intervalSeconds * 1000, budgetIntervalMs)), maxConcurrency: config.collector.maxConcurrency, timeoutMs: config.query.upstreamTimeoutMs,
      burstIntervalMs: config.collector.burstIntervalSeconds * 1000, burstQuietMs: config.collector.burstQuietSeconds * 1000 });
    scheduler.setTargets(groups);
    lastRefreshAt = now.getTime();
    return { follows: follows.length, eligible: eligible.length, groups: groups.length, enabled: config.collector.enabled };
  }

  async function probeSender() {
    if (!config.notifications.enabled || !sendImpl || sendImpl.enabled === false || typeof sendImpl.probe !== 'function') return;
    if (stopping || !shouldContinue() || !lease.isHeld() || clock().getTime() - lastSenderProbeAt < 60000) return;
    // A scheduled invocation reserves time to persist status and release its
    // lease. The bounded token-only request also stays below the lease TTL.
    if (remainingMs() <= 1000 || !await lease.renew() || !shouldContinue()) return;
    const timeoutMs = Math.min(3000, Math.floor(remainingWorkMs()) - 1000);
    if (timeoutMs < 1) return;
    lastSenderProbeAt = clock().getTime();
    await sendImpl.probe({ timeoutMs });
    await lease.renew();
  }

  function notificationStatus() {
    const health = sendImpl && typeof sendImpl.getHealth === 'function' ? sendImpl.getHealth() : null;
    const authReady = Boolean(health && health.authReady === true);
    const reason = !config.notifications.enabled ? 'notifications_disabled' : !sendImpl ? 'sender_missing'
      : sendImpl.disabledReason || (!health ? 'sender_unknown' : health.reason || (authReady ? null : 'consumer_auth_unchecked'));
    return { enabled: Boolean(config.notifications.enabled && sendImpl && sendImpl.enabled !== false && authReady), reason,
      credentialsConfigured: health ? health.credentialsConfigured === true : false,
      authState: health && ['unchecked', 'ready', 'failed'].includes(health.authState) ? health.authState : 'unchecked', authReady,
      checkedAt: health && health.checkedAt || null, validUntil: health && health.validUntil || null,
      lastErrorCode: health && health.lastErrorCode || null };
  }

  async function publishStatus(extra) {
    const snap = scheduler.snapshot();
    const now = clock();
    const status = {
      _id: 'collector_status',
      ownerId,
      mode,
      state: !lease.isHeld() ? 'no_lease' : !config.collector.enabled ? 'disabled' : !budget.allowed ? (budget.reason === 'upstream_paused' ? 'throttled' : 'budget_limited') : snap.state,
      breaker: { state: snap.breaker.state, reason: snap.breaker.reason, until: snap.breaker.until ? new Date(snap.breaker.until).toISOString() : null },
      groupCount: snap.groupCount,
      inFlight: snap.inFlight,
      intervalMs: snap.intervalMs,
      maxConcurrency: snap.maxConcurrency,
      budget: { ...budget, maxRequestsPerMinute: config.collector.maxRequestsPerMinute || 60, maxRequestsPerDay: config.collector.maxRequestsPerDay || 10000 },
      notifications: notificationStatus(),
      stats,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + Math.max(statusTtlMs, (config.collector.statusStaleAfterSeconds || 30) * 1000)).toISOString(),
      ...(mode === 'scheduled' ? { scheduler: scheduler.checkpoint(), nextRunAt: new Date(Math.floor(now.getTime() / 60000) * 60000 + 60000).toISOString() } : {}),
      ...(extra || {}),
    };
    // Per-target health stays in the scheduler (persisted by the scheduled
    // checkpoint above). Nothing read the per-minute gxs_target_health documents.
    const saved = await repo.saveCollectorStatus(status, { ownerId, nowIso: clock().toISOString() });
    if (saved && saved.saved === false) return null;
    lastStatusAt = now.getTime();
    return status;
  }

  /** One iteration: keep the lease, refresh targets when due, dispatch due requests. */
  async function step() {
    const nowMs = clock().getTime();
    const held = await lease.renew();
    if (!held) {
      // A standby process must never overwrite the current owner's heartbeat.
      return { held: false, started: [] };
    }
    if (nowMs - lastRefreshAt >= refreshEveryMs) await refreshTargets();
    await probeSender();
    if (!lease.isHeld()) return { held: false, started: [] };
    await drainNotifications();
    const started = shouldContinue() ? scheduler.tick() : [];
    if (nowMs - lastStatusAt >= statusEveryMs) await publishStatus();
    return { held: true, started };
  }

  async function run() {
    running = true;
    stopping = false;
    log.info(`[collector] ${ownerId} starting`);
    while (running) {
      try {
        const { held } = await step();
        await sleep(held ? Math.min(1000, Math.max(100, scheduler.nextDueInMs())) : 3000);
      } catch (error) {
        log.error('[collector] step failed', error && error.stack ? error.stack : error);
        await sleep(2000);
      }
    }
    scheduler.pause();
    await scheduler.drain();
    await notifyChain;
    if (lease.isHeld()) await publishStatus({ state: 'stopped' });
    await lease.release();
  }

  return { step, run, stop: () => { stopping = true; running = false; scheduler.pause(); }, drainNotifications, refreshTargets, publishStatus, scheduler, lease, stats, ownerId, currentConfig: () => config };
}

module.exports = { createCollector };
