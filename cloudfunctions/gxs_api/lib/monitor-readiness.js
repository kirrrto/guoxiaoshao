'use strict';
const { isValidTemplateId } = require('./config');
const { observationHealth } = require('./engine/observation-health');

/** Publish configuration and observed worker health separately. No secrets leave the server. */
function monitoringSnapshot(config, status, now) {
  const age = status ? now.getTime() - Date.parse(status.updatedAt) : Infinity;
  const baseTtl = Math.max(5, Number(config.collector.statusStaleAfterSeconds) || 30) * 1000;
  const mode = status && status.mode === 'scheduled' ? 'scheduled' : 'resident';
  // A scheduled worker is expected to be asleep between minute triggers. Its
  // explicit expiry covers that gap; a missing trigger still becomes stale.
  const expiry = status && Date.parse(status.expiresAt);
  const scheduledTtl = Number.isFinite(expiry) ? Math.min(150000, expiry - Date.parse(status.updatedAt)) : baseTtl;
  const stale = !Number.isFinite(age) || age < -30000 || age > (mode === 'scheduled' ? Math.max(baseTtl, scheduledTtl) : baseTtl);
  const state = !status ? 'not_deployed' : !config.collector.enabled ? 'disabled' : stale && !['stopped', 'disabled'].includes(status.state) ? 'stale' : status.state;
  const observed = status && status.scheduler && Array.isArray(status.scheduler.targets)
    ? observationHealth({ targets: status.scheduler.targets, intervalMs: status.intervalMs, mode, nowMs: now.getTime(), timeoutMs: config.query.upstreamTimeoutMs })
    : status && status.observationHealth || null;
  const observationStale = Boolean(observed && observed.staleGroups > 0);
  const collector = {
    enabled: Boolean(config.collector.enabled), state, stale, mode,
    observationHealth: observed, observationStale,
    breaker: status && status.breaker || null,
    intervalMs: status && status.intervalMs || null,
    groupCount: status && Number.isInteger(status.groupCount) ? status.groupCount : null,
    lastBatchAt: status && status.stats && status.stats.lastBatchAt || null,
    updatedAt: status && status.updatedAt || null,
    nextRunAt: status && status.nextRunAt || null,
  };
  const notifications = config.notifications;
  const templateConfigured = isValidTemplateId(notifications.templateIds && notifications.templateIds.restock);
  const sender = status && status.notifications;
  const authExpiry = sender && Date.parse(sender.validUntil);
  const authReady = Boolean(sender && sender.authReady === true && sender.authState === 'ready' && Number.isFinite(authExpiry) && authExpiry > now.getTime());
  let reason = !templateConfigured ? 'template_missing' : !notifications.enabled ? 'notifications_disabled'
    : !status ? 'collector_not_deployed' : stale ? 'collector_stale'
    : ['stopped', 'no_lease', 'disabled', 'error'].includes(state) || !config.collector.enabled ? 'collector_stopped'
    : observationStale ? 'collector_observation_stale'
    : !sender ? 'sender_unknown' : sender.reason || (!sender.enabled ? 'sender_missing' : !authReady ? 'consumer_auth_unchecked' : null);
  return { collector, notifications: {
    enabled: Boolean(notifications.enabled), templateIds: notifications.templateIds,
    templateTitle: notifications.templateTitle || '',
    templateConfigured, deliveryReady: reason === null, reason,
  } };
}

module.exports = { monitoringSnapshot };
