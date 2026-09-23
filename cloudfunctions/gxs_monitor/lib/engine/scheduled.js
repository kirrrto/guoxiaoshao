'use strict';
const crypto = require('node:crypto');
const { createCollector } = require('./collector');
const { runRetentionIfDue } = require('./retention');

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
async function runScheduled({ repo, fetchImpl, sendImpl, clock = () => new Date(), log = console, maxRunMs = 35000, ownerId = `timer-${crypto.randomUUID()}` }) {
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
      collector.stats.lastBatchAt = previous.stats && previous.stats.lastBatchAt || null;
    }
    const snap = collector.scheduler.snapshot();
    const maxWaves = Math.max(1, Math.ceil(snap.groupCount / snap.maxConcurrency));
    for (let wave = 0; wave < maxWaves && shouldContinue(); wave++) {
      const result = await collector.step();
      if (!result.held) return { state: 'standby', scanned: collector.stats.batches };
      await Promise.all(result.started);
      if (collector.lease.isHeld()) await collector.publishStatus();
      if (!result.started.length) break;
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

module.exports = { TRIGGER_NAME, readTimerRuntime, isTrustedTimer, runScheduled };
