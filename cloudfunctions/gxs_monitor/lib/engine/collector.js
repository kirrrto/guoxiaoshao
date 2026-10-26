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
const { canUseReminders, followAllowance } = require('../rules/membership');
const { loadFollowUsers } = require('../rules/follow-access');
const { guardedPickup } = require('./guarded-pickup');
const { createScheduler, buildGroups } = require('./scheduler');
const { createLeaseKeeper } = require('./lease');
const { recordObservations } = require('./observations');
const { buildTasks, sendTask, TASK_STATUS } = require('./notifier');
const { targetKeyOf } = require('./events');
const { AUTO_SHARE, DAY_MS } = require('./capacity-budget');
const { observationHealth } = require('./observation-health');
const { currentAvailabilityEvent } = require('./current-availability');

const NOTIFICATION_RECONCILE_INTERVAL_MS = 30000;
const NOTIFICATION_PLAN_PAGE_SIZE = 50;
const NOTIFICATION_PLAN_MAX_PAGES = 4;
const NOTIFICATION_PLAN_TASK_LIMIT = 20;
const NOTIFICATION_PLAN_SLICE_MS = 5000;
// validateConfig caps maxEventAgeSeconds at one hour. An empty page over this
// whole window is also empty under any newly-read notification configuration.
const NOTIFICATION_MAX_EVENT_AGE_MS = 3600000;
const WAITING_CONFIRMATION_LIMIT = 4096;

function createCollector({ repo, fetchImpl, clock = () => new Date(), log = console, sendImpl = null, ownerId = `collector-${process.pid}-${Date.now()}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), refreshEveryMs = 10000, statusEveryMs = 5000, mode = 'resident', minimumIntervalMs = 0, statusTtlMs = 0, shouldContinue = () => true, remainingMs = () => Infinity }) {
  let config = mergeConfig(null);
  let lastRefreshAt = -Infinity;
  let lastStatusAt = -Infinity;
  let lastSenderProbeAt = -Infinity;
  let lastNotificationReconcileAt = -Infinity;
  let lastAvailabilityPlanAt = -Infinity;
  let lastObservationHealthState = null;
  let lastObservationHealthLogAt = -Infinity;
  const hurriedWaitingEvents = new Map();
  let running = false;
  let stopping = false;
  let budget = { allowed: true, reason: null, minuteCount: 0, dayCount: 0 };
  let cadenceInfo = { cadenceMode: 'adaptive', targetPeriodMs: 0, budgetIntervalMs: 0, autoSharePercent: 80 };
  const stats = { batches: 0, observations: 0, events: 0, tasks: 0, sent: 0, lastBatchAt: null,
    notificationPasses: 0, notificationEmptyPassesSkipped: 0, notificationConfigReads: 0 };

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
  let notificationWork = null;
  let notificationRequested = false;
  function serialised(task) {
    const next = notifyChain.then(task, task);
    notifyChain = next.catch(() => {});
    return next;
  }

  async function handleBatch({ observations }) {
    if (stopping || !await lease.renew()) throw new Error('collector_lease_lost');
    const recorded = await recordObservations(ctx(), observations, 'auto');
    const applied = recorded.filter(result => !['stale', 'duplicate'].includes(result.outcome));
    if (applied.length) {
      stats.batches += 1;
      stats.observations += applied.length;
      stats.lastBatchAt = clock().toISOString();
    }
    const events = recorded.flatMap(r => r.events).length;
    stats.events += events;
    if (applied.some(result => result.latest && result.latest.status === 'available')) lastAvailabilityPlanAt = -Infinity;
    await flushOrKickNotifications();
    // Any status change puts this store on the fast cadence (see scheduler burst mode).
    return { changed: events > 0, persisted: observations.length > 0 && applied.length === observations.length };
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

  async function firstEventPage(since) {
    let events = await repo.listUnprocessedEvents({ limit: NOTIFICATION_PLAN_PAGE_SIZE, since, cursor: stats.notificationEventCursor });
    // A saved cursor can point past a now-empty tail. Wrap just once.
    if (!events.length && stats.notificationEventCursor) {
      stats.notificationEventCursor = null;
      events = await repo.listUnprocessedEvents({ limit: NOTIFICATION_PLAN_PAGE_SIZE, since });
    }
    return events;
  }

  async function planEvents(planningConfig, prefetchedEvents = null) {
    // Bound planning independently of delivery. Slow task inserts must leave
    // time to send already-durable tasks before this invocation ends.
    const deadline = clock().getTime() + Math.min(NOTIFICATION_PLAN_SLICE_MS, Math.max(0, remainingMs() - 2000));
    const canPlan = () => !stopping && shouldContinue() && lease.isHeld() && clock().getTime() < deadline;
    const maxAgeMs = (planningConfig.notifications.maxEventAgeSeconds || 120) * 1000;
    const planAt = clock().getTime();
    for (const [key, expiresAt] of hurriedWaitingEvents) if (expiresAt < planAt) hurriedWaitingEvents.delete(key);
    const since = new Date(clock().getTime() - Math.max(600000, maxAgeMs)).toISOString();
    let snapshot = null;
    let taskCount = 0;
    for (let page = 0; page < NOTIFICATION_PLAN_MAX_PAGES && canPlan(); page++) {
      // An over-wide prefetched page must not let old rows hide current events.
      // Reuse it only when every row is inside the actual configuration window.
      const usePrefetched = page === 0 && prefetchedEvents !== null && prefetchedEvents.every(event => event.detectedAt >= since);
      const events = usePrefetched ? prefetchedEvents : page === 0 ? await firstEventPage(since)
        : await repo.listUnprocessedEvents({ limit: NOTIFICATION_PLAN_PAGE_SIZE, since, cursor: stats.notificationEventCursor });
      if (!events.length) { stats.notificationEventCursor = null; break; }
      const latestByKey = new Map((await repo.getLatest([...new Set(events.map(e => targetKeyOf(e.storeNumber, e.partNumber)))])).map(l => [l._id, l]));
      for (const event of events) {
        if (!canPlan() || !await lease.renew()) return { snapshot, more: taskCount > 0 };
        const nextCursor = { detectedAt: event.detectedAt, id: event._id };
        const now = clock();
        const state = await confirmation(event, latestByKey.get(targetKeyOf(event.storeNumber, event.partNumber)));
        if (state === 'waiting' && now.getTime() - Date.parse(event.detectedAt) <= maxAgeMs) {
          // An event first seen after its old burst window still needs a prompt
          // confirmation. Re-reading it must not renew the quiet window. Keep
          // one bounded entry per event until its original expiry; never evict
          // a live entry to make room, which would permit repeated bursts.
          const waitingKey = `${event._id}\0${event.detectedAt}`;
          if (!hurriedWaitingEvents.has(waitingKey) && hurriedWaitingEvents.size < WAITING_CONFIRMATION_LIMIT
            && scheduler.hurry(event.storeNumber, now.getTime()) > 0) {
            hurriedWaitingEvents.set(waitingKey, Date.parse(event.detectedAt) + maxAgeMs);
          }
          // Leave this event unplanned, but do not let it hide later alerts.
          stats.notificationEventCursor = nextCursor;
          continue;
        }
        if (!snapshot && state === 'confirmed') {
          const follows = await repo.listActiveFollows();
          snapshot = { follows, users: await loadFollowUsers(repo, follows, clock()) };
        }
        const tasks = state === 'confirmed' ? buildTasks({ events: [event], ...snapshot, config: planningConfig, now })
          .filter(task => task.userKey > (event.notificationPlanningAfterUserKey || ''))
          .sort((a, b) => a.userKey < b.userKey ? -1 : a.userKey > b.userKey ? 1 : 0) : [];
        let afterUserKey = event.notificationPlanningAfterUserKey || null;
        let uncommitted = 0;
        const checkpoint = async complete => {
          if (!await lease.renew()) throw new Error('collector_lease_lost');
          await repo.checkpointEventPlanning({ eventId: event._id, afterUserKey, complete, ownerId, nowIso: clock().toISOString() });
          uncommitted = 0;
        };
        for (const task of tasks) {
          if (!canPlan() || taskCount >= NOTIFICATION_PLAN_TASK_LIMIT || !await lease.renew()) {
            if (uncommitted) await checkpoint(false);
            return { snapshot, more: taskCount > 0 };
          }
          if (await repo.saveNotification(task)) stats.tasks += 1;
          afterUserKey = task.userKey;
          taskCount += 1;
          uncommitted += 1;
          if (uncommitted >= 10) await checkpoint(false);
        }
        // Completion is separate from partial progress. Crashes replay only
        // the unsaved chunk; deterministic task ids still dedupe every replay.
        await checkpoint(true);
        stats.notificationEventCursor = nextCursor;
        if (taskCount >= NOTIFICATION_PLAN_TASK_LIMIT) return { snapshot, more: true };
      }
      if (events.length < NOTIFICATION_PLAN_PAGE_SIZE) { stats.notificationEventCursor = null; break; }
    }
    return { snapshot, more: false };
  }

  async function planCurrentAvailability(planningConfig, planningSnapshot) {
    if (!planningConfig.notifications.enabled || !shouldContinue()
      || remainingWorkMs() <= 4000 || clock().getTime() - lastAvailabilityPlanAt < 30000) return;
    const follows = planningSnapshot ? planningSnapshot.follows : await repo.listActiveFollows();
    const users = planningSnapshot ? planningSnapshot.users : await loadFollowUsers(repo, follows, clock());
    // Page the account/target pairs, not database reads per displayed follow.
    // The cursor is persisted in scheduled heartbeats so a large set of paid
    // accounts cannot leave later accounts permanently behind the first page.
    const candidates = follows.flatMap(follow => {
      const user = users.get(follow.userKey);
      if (!user || !canUseReminders(user, clock())) return [];
      const templateId = planningConfig.notifications.templateIds.restock;
      if (!user.subscriptions || !user.subscriptions[templateId] || user.subscriptions[templateId].credits <= 0) return [];
      return followAllowance(user, follow, follows, clock()).eligibleStoreNumbers.map(storeNumber => ({
        id: `${follow.userKey}|${storeNumber}|${follow.partNumber}`, follow, storeNumber,
      }));
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (!candidates.length) { lastAvailabilityPlanAt = clock().getTime(); return; }
    let start = candidates.findIndex(candidate => candidate.id > (stats.availabilityCursor || ''));
    if (start < 0) start = 0;
    const page = candidates.slice(start, start + 20);
    const keys = [...new Set(page.map(candidate => targetKeyOf(candidate.storeNumber, candidate.follow.partNumber)))];
    const latest = new Map((await repo.getLatest(keys)).map(row => [row._id, row]));
    for (const candidate of page) {
      if (stopping || !shouldContinue() || remainingWorkMs() <= 3000 || !await lease.renew()) return;
      const event = currentAvailabilityEvent(latest.get(targetKeyOf(candidate.storeNumber, candidate.follow.partNumber)), planningConfig, clock());
      if (event) {
        const tasks = buildTasks({ events: [event], follows: [candidate.follow], users, config: planningConfig, now: clock() });
        for (const task of tasks) if (task.status === TASK_STATUS.pending && await repo.queueCurrentAvailability(task)) stats.tasks += 1;
      }
      stats.availabilityCursor = candidate.id;
    }
    lastAvailabilityPlanAt = clock().getTime();
  }

  function concurrentNotifications() {
    // A minute invocation has a finite scan window. Waiting for the outbox
    // before dispatching inventory lets a few slow WeChat responses consume
    // that entire window, even when Apple and the shared budget are healthy.
    return mode === 'scheduled' || mode === 'resident' && config.collector.availableIntervalSeconds > 0;
  }

  function drainNotifications() {
    if (!concurrentNotifications()) return serialised(notificationPass);
    // One running pass plus one pending bit, regardless of how many batches
    // ask for delivery while WeChat is slow. No unbounded Promise queue.
    notificationRequested = true;
    if (notificationWork) return notificationWork;
    notificationWork = serialised(async () => {
      while (notificationRequested && concurrentNotifications() && !stopping && lease.isHeld() && shouldContinue()) {
        notificationRequested = false;
        if (await notificationPass()) notificationRequested = true;
      }
    }).catch(error => {
      log.error('[collector] notification pass failed', error && error.message);
    }).finally(() => {
      notificationWork = null;
      // A kick may arrive between the last loop check and this finalizer.
      if (notificationRequested && concurrentNotifications() && !stopping && lease.isHeld() && shouldContinue()) drainNotifications();
    });
    return notificationWork;
  }

  async function flushOrKickNotifications() {
    if (concurrentNotifications()) { drainNotifications(); return; }
    await drainNotifications();
  }

  async function notificationPass() {
      if (stopping || !lease.isHeld() || !shouldContinue()) return;
      stats.notificationPasses += 1;
      const availabilityDue = () => clock().getTime() - lastAvailabilityPlanAt >= 30000;
      const reconcileDue = () => clock().getTime() - lastNotificationReconcileAt >= NOTIFICATION_RECONCILE_INTERVAL_MS;
      let prefetchedEvents = null, prefetchedTasks = null;
      if (!availabilityDue() && !reconcileDue()) {
        // Keep every existing poll opportunity. Only omit the configuration
        // read after proving this pass has no work; do not cache eligibility.
        prefetchedEvents = await firstEventPage(new Date(clock().getTime() - NOTIFICATION_MAX_EVENT_AGE_MS).toISOString());
        if (!prefetchedEvents.length) {
          const senderReady = sendImpl && sendImpl.enabled !== false
            && (typeof sendImpl.getHealth !== 'function' || sendImpl.getHealth().authReady);
          prefetchedTasks = senderReady ? await repo.listPendingNotifications({ limit: 20 }) : [];
          // A sample can invalidate availability while these reads are pending.
          if (!prefetchedTasks.length && !availabilityDue() && !reconcileDue()) {
            stats.notificationEmptyPassesSkipped += 1;
            return false;
          }
        }
      }
      if (stopping || !lease.isHeld() || !shouldContinue()) return;
      // Delivery has its own snapshot. A delayed read must not overwrite the
      // newer configuration already applied to the sampling scheduler.
      stats.notificationConfigReads += 1;
      const notificationConfig = mergeConfig(await repo.getConfig());
      const reconcileAt = clock();
      let reconciled = false;
      if (reconcileAt.getTime() - lastNotificationReconcileAt >= NOTIFICATION_RECONCILE_INTERVAL_MS) {
        // Passes already run serially. Reconcile once at startup, then avoid an
        // identical expiry update after every batch. Only success advances the
        // window; anchor it to the query time so a slow update adds no delay.
        await repo.reconcileExpiredNotifications({ now: reconcileAt.toISOString(),
          pendingBefore: new Date(reconcileAt.getTime() - (notificationConfig.notifications.maxEventAgeSeconds || 120) * 1000).toISOString() });
        lastNotificationReconcileAt = reconcileAt.getTime();
        reconciled = true;
      }
      const tasksBeforePlanning = stats.tasks;
      const planning = await planEvents(notificationConfig, prefetchedEvents);
      if (!sendImpl || sendImpl.enabled === false) return planning.more;
      if (typeof sendImpl.getHealth === 'function' && !sendImpl.getHealth().authReady) return planning.more;
      await planCurrentAvailability(notificationConfig, planning.snapshot);
      // Planning may have created tasks, and reconciliation may have retired a
      // full stale prefix. In either case read the current delivery page.
      const tasks = prefetchedTasks !== null && !reconciled && stats.tasks === tasksBeforePlanning
        ? prefetchedTasks : await repo.listPendingNotifications({ limit: 20 });
      for (const task of tasks) {
        if (stopping || !shouldContinue() || !await lease.renew()) break;
        if (typeof sendImpl.getHealth === 'function' && !sendImpl.getHealth().authReady) break;
        const result = await sendTask({ task, config: notificationConfig, sendImpl, repo, now: clock(), clock, ownerId, remainingMs: remainingWorkMs,
          beforeSend: async () => !stopping && shouldContinue() && await lease.renew({ force: true }) && lease.isHeld() && shouldContinue() });
        if (result.status === TASK_STATUS.accepted) stats.sent += 1;
      }
      return planning.more;
  }

  async function refreshTargets() {
    const stored = await repo.getConfig();
    config = mergeConfig(stored);
    const follows = await repo.listActiveFollows();
    const users = await loadFollowUsers(repo, follows, clock());
    const now = clock();
    const eligible = follows.flatMap(follow => {
      const user = users.get(follow.userKey);
      if (!user || !canUseReminders(user, now)) return [];
      const allowance = followAllowance(user, follow, follows, now);
      return allowance.eligibleStoreNumbers.length ? [{ ...follow, storeNumbers: allowance.eligibleStoreNumbers }] : [];
    });
    const groups = config.collector.enabled ? buildGroups(eligible, config.collector.maxPartsPerRequest || 20) : [];
    // Continuous monitoring in both modes fits the sustainable automatic lane,
    // independent of user count. Bursts still pass the shared admission guard.
    // Explicit daily mode retains the previous resident-mode cadence.
    const autoShare = Math.min(0.95, Math.max(0.01, (config.collector.autoSharePercent || 80) / 100));
    const cadenceMode = config.collector.cadenceMode === 'fixed' ? 'fixed' : 'adaptive';
    const baseIntervalMs = Math.max(minimumIntervalMs, config.collector.intervalSeconds * 1000);
    let intervalMs = baseIntervalMs;
    let budgetIntervalMs = 0;
    if (cadenceMode === 'adaptive') {
      const autoLimit = config.collector.budgetMode === 'daily'
        ? Math.max(1, Math.floor(config.collector.maxRequestsPerDay * autoShare))
        : config.collector.maxRequestsPerDay * autoShare;
      budgetIntervalMs = config.collector.budgetMode === 'daily' && mode !== 'scheduled' ? 0 : Math.ceil(groups.length * DAY_MS / autoLimit);
      intervalMs = Math.max(minimumIntervalMs, config.collector.intervalSeconds * 1000, budgetIntervalMs);
    }
    // Fixed cadence never stretches with group count. Capacity shortfalls surface
    // as admission waits / observation delay instead of a silent longer period.
    // Minute timers use the existing aligned slots; hash phases can fall after
    // their bounded scan ends. Fixed still keeps intervalMs independent of load.
    scheduler.configure({ intervalMs, fixedCadence: cadenceMode === 'fixed' && mode !== 'scheduled',
      maxConcurrency: config.collector.maxConcurrency, timeoutMs: config.query.upstreamTimeoutMs,
      burstIntervalMs: config.collector.burstIntervalSeconds * 1000, burstQuietMs: config.collector.burstQuietSeconds * 1000,
      availableIntervalMs: config.collector.availableIntervalSeconds * 1000 });
    cadenceInfo = { cadenceMode, targetPeriodMs: intervalMs, budgetIntervalMs, autoSharePercent: Math.round(autoShare * 100) };
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

  async function publishStatus(extra, { force = true } = {}) {
    // Scheduled waves and step() share this window. Explicit/final/error
    // checkpoints keep their immediate write and the repository's owner fence.
    if (!force && clock().getTime() - lastStatusAt < statusEveryMs) return null;
    const snap = scheduler.snapshot();
    const now = clock();
    const health = observationHealth({ targets: snap.targets, intervalMs: snap.intervalMs, mode, nowMs: now.getTime(), timeoutMs: config.query.upstreamTimeoutMs });
    const status = {
      _id: 'collector_status',
      ownerId,
      mode,
      state: !lease.isHeld() ? 'no_lease' : !config.collector.enabled ? 'disabled' : !budget.allowed ? (budget.reason === 'upstream_paused' ? 'throttled' : 'budget_limited') : snap.state,
      breaker: { state: snap.breaker.state, reason: snap.breaker.reason, until: snap.breaker.until ? new Date(snap.breaker.until).toISOString() : null },
      groupCount: snap.groupCount,
      inFlight: snap.inFlight,
      intervalMs: snap.intervalMs,
      cadenceMode: cadenceInfo.cadenceMode,
      targetPeriodMs: cadenceInfo.targetPeriodMs || snap.intervalMs,
      budgetIntervalMs: cadenceInfo.budgetIntervalMs,
      autoSharePercent: cadenceInfo.autoSharePercent,
      availableIntervalMs: snap.availableIntervalMs,
      maxConcurrency: snap.maxConcurrency,
      budget: { ...budget, budgetMode: config.collector.budgetMode, maxRequestsPerMinute: config.collector.maxRequestsPerMinute || 60, maxRequestsPerDay: config.collector.maxRequestsPerDay || 10000 },
      notifications: notificationStatus(),
      observationHealth: health,
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
    // One aggregate per invocation/state transition (or five resident minutes),
    // suitable for a platform log alert. This does not claim alert delivery.
    if (config.collector.enabled && (health.staleGroups > 0 || ['stalled', 'degraded'].includes(lastObservationHealthState))
      && (health.state !== lastObservationHealthState || now.getTime() - lastObservationHealthLogAt >= 300000)) {
      const severity = health.state === 'stalled' ? 'error' : health.staleGroups ? 'warning' : 'info';
      const emit = severity === 'error' ? log.error : severity === 'warning' ? log.warn : log.info;
      if (typeof emit === 'function') emit.call(log, JSON.stringify({ event: 'collector_observation_health', severity, state: health.state,
        mode, groupCount: health.groupCount, staleGroups: health.staleGroups, freshGroups: health.freshGroups,
        pendingGroups: health.pendingGroups, intervalMs: snap.intervalMs, staleAfterMs: health.staleAfterMs, observedAt: now.toISOString() }));
      lastObservationHealthLogAt = now.getTime();
    }
    lastObservationHealthState = health.state;
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
    await flushOrKickNotifications();
    const started = shouldContinue() ? scheduler.tick() : [];
    await publishStatus(undefined, { force: false });
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
    await notificationWork;
    await notifyChain;
    if (lease.isHeld()) await publishStatus({ state: 'stopped' });
    await lease.release();
  }

  return { step, run, stop: () => { stopping = true; running = false; notificationRequested = false; scheduler.pause(); },
    settleNotifications: async () => { await notificationWork; await notifyChain; },
    drainNotifications, refreshTargets, publishStatus, scheduler, lease, stats, ownerId, currentConfig: () => config };
}

module.exports = { createCollector };
