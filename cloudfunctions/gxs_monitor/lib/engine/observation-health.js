'use strict';

// Worker liveness and useful, durably saved observations are different signals.
// Two planned coverage cycles plus scheduler/HTTP jitter allow capacity-scaled
// scans to finish without making a fresh heartbeat conceal a stuck target.
function observationHealth({ targets, intervalMs, mode, nowMs, timeoutMs = 8000 }) {
  const cadence = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
  const staleAfterMs = Math.max(150000, cadence * 2 + (mode === 'scheduled' ? 60000 : 0) + timeoutMs);
  let freshGroups = 0, staleGroups = 0, pendingGroups = 0;
  let oldestSuccessAt = null, lastSuccessAt = null;
  const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value <= nowMs + 30000 ? value : null;
  for (const target of targets || []) {
    const health = target.health || {};
    const success = timestamp(health.lastPersistedSuccessAt)
      ?? (!health.persistenceFailed && timestamp(health.lastSuccessAt) !== null
        && timestamp(health.lastPersistedAt) !== null && health.lastPersistedAt >= health.lastSuccessAt
        ? timestamp(health.lastSuccessAt) : null);
    if (success !== null) {
      oldestSuccessAt = oldestSuccessAt === null ? success : Math.min(oldestSuccessAt, success);
      lastSuccessAt = lastSuccessAt === null ? success : Math.max(lastSuccessAt, success);
      if (nowMs - success > staleAfterMs) staleGroups += 1;
      else freshGroups += 1;
    } else {
      const trackedAt = timestamp(target.trackedAt) ?? timestamp(health.lastRequestAt);
      if (trackedAt !== null && nowMs - trackedAt > staleAfterMs) staleGroups += 1;
      else pendingGroups += 1;
    }
  }
  const groupCount = (targets || []).length;
  return { state: !groupCount ? 'idle' : staleGroups === groupCount ? 'stalled' : staleGroups ? 'degraded'
    : pendingGroups ? 'warming_up' : 'healthy', groupCount, freshGroups, staleGroups, pendingGroups, staleAfterMs,
  oldestSuccessAt: oldestSuccessAt === null ? null : new Date(oldestSuccessAt).toISOString(),
  lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(), evaluatedAt: new Date(nowMs).toISOString() };
}

module.exports = { observationHealth };
