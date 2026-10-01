'use strict';
const crypto = require('node:crypto');
const { createCollector } = require('./collector');
const { runRetentionIfDue } = require('./retention');
const { dayKey, endOfDay } = require('../time');
const { AUTO_SHARE } = require('./capacity-budget');

const TRIGGER_NAME = 'gxs-monitor-minute';

/** Read only platform identity markers; never return credentials or arbitrary environment values. */
function readTimerRuntime(context = {}, env = {}) {
  let invocation = {};
  try {
    if (context.environment != null) invocation = typeof context.environment === 'string' ? JSON.parse(context.environment) : context.environment;
    else if (typeof context.environ === 'string') {
      for (const item of context.environ.split(';')) {
        const at = item.indexOf('=');
        if (at > 0) invocation[item.slice(0, at)] = item.slice(at + 1);
      }
    }
    if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) return { invalidContext: true };
  } catch { return { invalidContext: true }; }
  const result = {};
  for (const key of ['TRIGGER_SRC', 'TENCENTCLOUD_RUNENV', 'TCB_SOURCE', 'WX_OPENID', 'WX_FROM_OPENID', 'WX_FROM_APPID', 'FROM_OPENID', 'FROM_APPID']) {
    const value = Object.prototype.hasOwnProperty.call(invocation, key) ? invocation[key] : env[key];
    if (value != null) result[key] = typeof value === 'string' ? value : '';
  }
  return result;
}

/** event is caller-controlled. SOURCE and identity must come from getWXContext. */
function isTrustedTimer(event, wxContext, trustedRuntime = {}) {
  if (trustedRuntime.invalidContext) return false;
  if (!event || event.Type !== 'Timer' || event.TriggerName !== TRIGGER_NAME || event.httpMethod || event.requestContext) return false;
  if (!wxContext || wxContext.OPENID || wxContext.FROM_OPENID || wxContext.FROM_APPID) return false;
  const chain = typeof wxContext.SOURCE === 'string' && wxContext.SOURCE.trim() ? wxContext.SOURCE.split(',').map(s => s.trim()) : [];
  if (chain.length) return chain[0] === 'wx_trigger' && chain.slice(1).every(s => s === 'scf');
  // SCF's documented built-ins are supplied by the runtime, never copied from
  // event. Explicit user-origin SOURCE above always wins over this fallback.
  return trustedRuntime.TRIGGER_SRC === 'timer' && trustedRuntime.TENCENTCLOUD_RUNENV === 'SCF';
}

/** A bounded scan shares the resident collector's lease, quotas and outbox. */
/**
 * How long one timer run may work. A run normally ends after one scan; while a
 * store is on the fast cadence it keeps polling until the function's own time
 * limit (from the platform context) leaves a safety margin.
 */
function runBudgetMs(context, fallbackMs = 35000) {
  let remaining = NaN;
  try {
    // Some SCF Node.js 20 runtimes expose this method but throw internally
    // (client.ms_elapsed is not a function). Keep the bounded fallback so a
    // broken platform helper cannot prevent every timer heartbeat and scan.
    if (context && typeof context.getRemainingTimeInMillis === 'function') remaining = Number(context.getRemainingTimeInMillis());
  } catch { /* The platform time helper is optional; use the bounded fallback. */ }
  // Never turn an almost-expired invocation into another five seconds of work.
  return Number.isFinite(remaining) ? Math.max(0, Math.min(55000, remaining - 5000)) : fallbackMs;
}

async function runScheduled({ repo, fetchImpl, sendImpl, clock = () => new Date(), log = console, maxRunMs = 35000, ownerId = `timer-${crypto.randomUUID()}`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = clock().getTime() + maxRunMs;
  const shouldContinue = () => clock().getTime() < deadline;
  const collector = createCollector({ repo, fetchImpl, sendImpl, clock, log, ownerId,
    mode: 'scheduled', minimumIntervalMs: 60000, statusTtlMs: 150000,
    refreshEveryMs: 60000, statusEveryMs: 0, shouldContinue, remainingMs: () => Math.max(0, deadline - clock().getTime()) });
  if (!await collector.lease.acquire()) return { state: 'standby', scanned: 0 };
  let failed = false;
  try {
    const previous = await repo.getCollectorStatus();
    await collector.refreshTargets();
    if (previous && previous.mode === 'scheduled') {
      collector.scheduler.restore(previous.scheduler);
      const current = collector.currentConfig().collector;
      if (current.budgetMode === 'continuous') {
        const oldBudget = previous.budget || {};
        let retiredRetryAt = oldBudget.budgetMode !== 'continuous'
          && ['daily_budget', 'auto_budget_reserved'].includes(oldBudget.reason) ? oldBudget.retryAt : undefined;
        // Old idle invocations overwrote budget.reason with an allowed/zero
        // heartbeat, while retaining every target's midnight nextDueAt.
        // Confirm that unlabelled wait against the persisted day's consumption;
        // ordinary future schedules and continuous-mode waits are not evidence.
        const midnight = endOfDay(dayKey(clock())).getTime();
        const saved = previous.scheduler;
        const hasUnlabelledMidnight = saved && saved.version === 1 && Array.isArray(saved.targets)
          && saved.targets.some(target => target.nextDueAt === midnight && !target.guardReason && !target.guardUntil);
        if (!Number.isFinite(retiredRetryAt) && oldBudget.budgetMode !== 'continuous' && hasUnlabelledMidnight) {
          const snapshot = await repo.getUpstreamCapacity({ now: clock().toISOString() });
          const oldDailyLimit = Number.isSafeInteger(oldBudget.maxRequestsPerDay) && oldBudget.maxRequestsPerDay > 0
            ? oldBudget.maxRequestsPerDay : current.maxRequestsPerDay;
          if (snapshot.day && snapshot.day.dayCount >= Math.max(1, Math.floor(oldDailyLimit * AUTO_SHARE))) retiredRetryAt = midnight;
        }
        // Legacy daily exhaustion parked targets until midnight. Re-admit
        // them under continuous refill while retaining 429/503 and backoff.
        collector.scheduler.resetDailyAdmission(retiredRetryAt);
      }
      collector.stats.lastBatchAt = previous.stats && previous.stats.lastBatchAt || null;
    }
    const snap = collector.scheduler.snapshot();
    // Same-store SKU batches cannot occupy concurrent slots. Allow one wave
    // per group and wait briefly for store spacing so later batches are still
    // scanned during this invocation instead of alternating across minutes.
    const maxWaves = Math.max(1, snap.groupCount);
    const fastIntervals = [snap.burstIntervalMs, snap.availableIntervalMs].filter(interval => interval > 0);
    const storeSpacingMs = fastIntervals.length ? Math.min(snap.intervalMs, ...fastIntervals) : 0;
    for (let wave = 0; wave < maxWaves && shouldContinue(); wave++) {
      const result = await collector.step();
      if (!result.held) return { state: 'standby', scanned: collector.stats.batches };
      await Promise.all(result.started);
      if (collector.lease.isHeld()) await collector.publishStatus();
      if (!result.started.length) {
        const waitMs = collector.scheduler.nextDueInMs();
        const storeDelayed = collector.scheduler.snapshot().targets.some(target => target.storeDelayed);
        if (storeDelayed && waitMs > 0 && waitMs <= storeSpacingMs && clock().getTime() + waitMs < deadline) {
          await sleep(Math.min(waitMs, 1000));
          wave -= 1;
          continue;
        }
        break;
      }
    }
    // Fast cadence: keep checking stores that just changed until they settle or time runs out.
    while (shouldContinue() && collector.lease.isHeld() && collector.scheduler.bursting()) {
      const waitMs = collector.scheduler.nextDueInMs();
      if (clock().getTime() + waitMs >= deadline) break;
      if (waitMs > 0) await sleep(Math.min(waitMs, 1000));
      const result = await collector.step();
      if (!result.held) return { state: 'standby', scanned: collector.stats.batches };
      await Promise.all(result.started);
    }
    // Pending events are read from the durable outbox on every invocation,
    // including when no target is due or all user follows have been paused.
    if (shouldContinue()) await collector.drainNotifications();
    // Once per Beijing day: purge expired history inside this lease and time budget.
    if (shouldContinue() && collector.lease.isHeld() && await collector.lease.renew()) {
      await runRetentionIfDue({ repo, now: clock(), log, remainingMs: () => Math.max(0, deadline - clock().getTime()) });
    }
    const status = collector.lease.isHeld() ? await collector.publishStatus() : null;
    return { state: status ? status.state : 'lease_lost', scanned: collector.stats.batches,
      observations: collector.stats.observations, events: collector.stats.events, sent: collector.stats.sent,
      deadlineReached: !shouldContinue() };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    collector.scheduler.pause();
    await collector.scheduler.drain();
    if (failed && collector.lease.isHeld()) {
      try { await collector.publishStatus({ state: 'error' }); } catch { /* Preserve the original failure. */ }
    }
    await collector.lease.release();
  }
}

module.exports = { TRIGGER_NAME, readTimerRuntime, isTrustedTimer, runBudgetMs, runScheduled };
