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
const { isMember } = require('../rules/membership');
const { fetchPickup: defaultFetchPickup } = require('../apple-pickup');
const { createScheduler, buildGroups } = require('./scheduler');
const { createLeaseKeeper } = require('./lease');
const { recordObservations } = require('../services/query');
const { buildTasks, sendTask, TASK_STATUS } = require('./notifier');

function createCollector({ repo, fetchImpl, clock = () => new Date(), log = console, sendImpl = null, ownerId = `collector-${process.pid}-${Date.now()}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), refreshEveryMs = 10000, statusEveryMs = 5000, mode = 'resident', minimumIntervalMs = 0, statusTtlMs = 0, shouldContinue = () => true }) {
  let config = mergeConfig(null);
  let lastRefreshAt = -Infinity;
  let lastStatusAt = -Infinity;
  let running = false;
  let stopping = false;
  let budget = { allowed: true, reason: null, minuteCount: 0, dayCount: 0 };
  const stats = { batches: 0, observations: 0, events: 0, tasks: 0, sent: 0, lastBatchAt: null };

  const lease = createLeaseKeeper({ repo, ownerId, ttlMs: 15000, clock, log });
  const scheduler = createScheduler({
    clock,
    log,
    alignIntervalMs: mode === 'scheduled' ? 60000 : 0,
    fetchPickup: async ({ storeNumber, partNumbers, timeoutMs }) => {
      if (stopping || !lease.isHeld()) return { record: { httpStatus: null, error: { message: 'lease_lost' } }, observations: [] };
      const now = clock();
      budget = await repo.consumeCollectorBudget({ now: now.toISOString(), maxRequestsPerMinute: config.collector.maxRequestsPerMinute || 60, maxRequestsPerDay: config.collector.maxRequestsPerDay || 10000 });
      if (!budget.allowed) {
        const { dayKey, endOfDay } = require('../time');
        const retryAt = budget.reason === 'daily_budget' ? endOfDay(dayKey(now)).getTime() : Math.floor(now.getTime() / 60000) * 60000 + 60000;
        return { record: { httpStatus: null, budgetDenied: true, retryAt, error: { message: budget.reason } }, observations: [] };
      }
      if (stopping || !shouldContinue() || !await lease.renew()) return { record: { httpStatus: null, error: { message: 'lease_lost' } }, observations: [] };
      return defaultFetchPickup({ storeNumber, partNumbers, fetchImpl, now: clock, timeoutMs });
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
    stats.events += recorded.flatMap(r => r.events).length;
    await drainNotifications();
  }

  async function planEvents(events) {
    const follows = await repo.listActiveFollows();
    const users = new Map((await repo.getUsers([...new Set(follows.map(f => f.userKey))])).map(u => [u._id, u]));
    const now = clock();
    for (const event of events) {
      if (!shouldContinue()) break;
      const tasks = buildTasks({ events: [event], follows, users, config, now });
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
      const events = await repo.listUnprocessedEvents({ limit: 50 });
      if (events.length) await planEvents(events);
      if (!sendImpl || sendImpl.enabled === false) return;
      for (const task of await repo.listPendingNotifications({ limit: 20 })) {
        if (stopping || !shouldContinue() || !await lease.renew()) break;
        const result = await sendTask({ task, config, sendImpl, repo, now: clock(), clock, ownerId,
          beforeSend: async () => !stopping && shouldContinue() && await lease.renew() });
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
    const eligible = follows.filter(f => users.has(f.userKey) && isMember(users.get(f.userKey), now));
    const groups = config.collector.enabled ? buildGroups(eligible, config.collector.maxPartsPerRequest || 20) : [];
    scheduler.configure({ intervalMs: Math.max(minimumIntervalMs, config.collector.intervalSeconds * 1000), maxConcurrency: config.collector.maxConcurrency, timeoutMs: config.query.upstreamTimeoutMs });
    scheduler.setTargets(groups);
    lastRefreshAt = now.getTime();
    return { follows: follows.length, eligible: eligible.length, groups: groups.length, enabled: config.collector.enabled };
  }

  async function publishStatus(extra) {
    const snap = scheduler.snapshot();
    const now = clock();
    const status = {
      _id: 'collector_status',
      ownerId,
      mode,
      state: !lease.isHeld() ? 'no_lease' : !config.collector.enabled ? 'disabled' : !budget.allowed ? 'budget_limited' : snap.state,
      breaker: { state: snap.breaker.state, reason: snap.breaker.reason, until: snap.breaker.until ? new Date(snap.breaker.until).toISOString() : null },
      groupCount: snap.groupCount,
      inFlight: snap.inFlight,
      intervalMs: snap.intervalMs,
      maxConcurrency: snap.maxConcurrency,
      budget: { ...budget, maxRequestsPerMinute: config.collector.maxRequestsPerMinute || 60, maxRequestsPerDay: config.collector.maxRequestsPerDay || 10000 },
      notifications: { enabled: Boolean(config.notifications.enabled && sendImpl && sendImpl.enabled !== false), reason: !config.notifications.enabled ? 'notifications_disabled' : !sendImpl ? 'sender_missing' : sendImpl.disabledReason || null },
      stats,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + Math.max(statusTtlMs, (config.collector.statusStaleAfterSeconds || 30) * 1000)).toISOString(),
      ...(mode === 'scheduled' ? { scheduler: scheduler.checkpoint(), nextRunAt: new Date(Math.floor(now.getTime() / 60000) * 60000 + 60000).toISOString() } : {}),
      ...(extra || {}),
    };
    const saved = await repo.saveCollectorStatus(status, { ownerId, nowIso: clock().toISOString() });
    if (saved && saved.saved === false) return null;
    const bucket = now.toISOString().slice(0, 16);
    await repo.saveHealth(snap.targets.map(t => ({ _id: `${t.key}|${bucket}`, targetKey: t.key, storeNumber: t.storeNumber, partNumbers: t.partNumbers, bucket, ...t.health, recordedAt: now.toISOString() })));
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
