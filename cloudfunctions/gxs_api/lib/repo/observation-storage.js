'use strict';
// One authority per target. No process-local switch may override this marker.
const { COLLECTIONS: C } = require('../collections');
const { ApiError } = require('../errors');
const { isDeepStrictEqual } = require('node:util');
const { dayKey } = require('../time');
const { applyObservation, targetKeyOf } = require('../engine/events');
const { observationDayId, appendObservationDay } = require('../engine/observation-day');
const { isProductIdentity } = require('../rules/product-target');
const MIGRATION_LEASE_ID = 'inventory_storage_migration_lease';
const revisionOf = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const storageOf = latest => latest && latest.observationStorage || { schemaVersion: 1, mode: 'legacy', revision: 0 };
function nextRevision(storage) {
  const revision = revisionOf(storage.revision) + 1;
  if (!Number.isSafeInteger(revision)) throw new ApiError('observation_revision_exhausted', '库存摘要修订号已超出范围');
  return revision;
}
function publicSummary(row) {
  if (!row) return null;
  const { storageRevision, storageMode, ...summary } = row;
  return summary;
}
const stamped = (row, revision, mode) => ({ ...publicSummary(row), storageRevision: revision, storageMode: mode });

function summaryIssues(row, latest, { matchLatest = true } = {}) {
  if (!row) return ['missing_daily_summary'];
  const issues = [];
  const target = targetKeyOf(latest.storeNumber, latest.partNumber);
  if (row.schemaVersion !== 1 || row.storeNumber !== latest.storeNumber || row.partNumber !== latest.partNumber
      || row._id !== `${target}|${row.dayKey}` || !/^\d{4}-\d{2}-\d{2}$/.test(row.dayKey || '')) issues.push('summary_identity_mismatch');
  for (const name of ['sampleCount', 'knownCount', 'unknownCount', 'manualCount', 'autoCount']) {
    if (!Number.isSafeInteger(row[name]) || row[name] < 0) issues.push(`invalid_${name}`);
  }
  if (!(row.sampleCount > 0) || row.knownCount + row.unknownCount !== row.sampleCount
      || row.manualCount + row.autoCount > row.sampleCount) issues.push('sample_counts_mismatch');
  for (const name of ['firstObservedAt', 'lastObservedAt']) {
    if (!Number.isFinite(Date.parse(row[name])) || dayKey(row[name]) !== row.dayKey) issues.push(`invalid_${name}`);
  }
  if (Date.parse(row.firstObservedAt) > Date.parse(row.lastObservedAt)) issues.push('summary_time_order');
  if (row.knownCount === 0 ? row.firstKnownAt !== null || row.lastKnownAt !== null
    : !Number.isFinite(Date.parse(row.firstKnownAt)) || !Number.isFinite(Date.parse(row.lastKnownAt))
      || dayKey(row.firstKnownAt) !== row.dayKey || dayKey(row.lastKnownAt) !== row.dayKey
      || Date.parse(row.firstKnownAt) > Date.parse(row.lastKnownAt)
      || Date.parse(row.firstKnownAt) < Date.parse(row.firstObservedAt)
      || Date.parse(row.lastKnownAt) > Date.parse(row.lastObservedAt)) issues.push('known_times_mismatch');
  if (!row.eventCounts || typeof row.eventCounts !== 'object' || Array.isArray(row.eventCounts)
      || Object.values(row.eventCounts).some(n => !Number.isSafeInteger(n) || n < 0)) issues.push('invalid_event_counts');
  else if (Object.values(row.eventCounts).reduce((sum, n) => sum + n, 0) > row.sampleCount) issues.push('event_counts_exceed_samples');
  const windows = row.availableWindows;
  if (!windows || ['count', 'totalMs', 'maxMs'].some(k => !Number.isSafeInteger(windows[k]) || windows[k] < 0)
      || (windows.minMs !== null && (!Number.isSafeInteger(windows.minMs) || windows.minMs < 0))
      || (windows.count === 0 ? windows.totalMs !== 0 || windows.maxMs !== 0 || windows.minMs !== null
        : windows.minMs === null || windows.minMs > windows.maxMs || windows.maxMs > windows.totalMs)) issues.push('invalid_available_windows');
  if (row.firstAvailableAt !== null && (!Number.isFinite(Date.parse(row.firstAvailableAt)) || dayKey(row.firstAvailableAt) !== row.dayKey)) issues.push('invalid_first_available');
  // latest.sampleCount is a lifetime/recovery counter, never daily evidence.
  if (matchLatest && (dayKey(latest.observedAt) !== row.dayKey || row.lastObservedAt !== latest.observedAt)) issues.push('latest_summary_mismatch');
  return [...new Set(issues)];
}

// The latest snapshot MUST be fetched before archives. A rollover/flush that
// commits between the reads can only supply a newer complete archive version.
function selectObservationCoverage(latestRows, archivedRows, { partNumber, storeNumbers = [], dayKey: date }) {
  const selected = new Set(storeNumbers);
  const inScope = row => row && row.partNumber === partNumber && row.dayKey === date && (!selected.size || selected.has(row.storeNumber));
  const rows = new Map();
  for (const row of archivedRows) if (inScope(row)) {
    const previous = rows.get(row.storeNumber);
    if (!previous || revisionOf(row.storageRevision) > revisionOf(previous.storageRevision)) rows.set(row.storeNumber, row);
  }
  for (const latest of latestRows) {
    const storage = storageOf(latest), embedded = storage.day;
    if (storage.mode !== 'embedded' || !inScope(embedded)) continue;
    const archived = rows.get(embedded.storeNumber);
    if (!archived || revisionOf(embedded.storageRevision) >= revisionOf(archived.storageRevision)) rows.set(embedded.storeNumber, embedded);
  }
  return [...rows.values()].sort((a, b) => a.storeNumber.localeCompare(b.storeNumber)).map(publicSummary);
}

async function assertMigrationLease(tx, lease, nowIso) {
  if (!lease || !lease.ownerId || !Number.isFinite(Date.parse(nowIso))) throw new ApiError('migration_lease_required', '库存迁移需要有效执行权');
  const saved = await tx.get(C.config, MIGRATION_LEASE_ID);
  if (!saved || saved.ownerId !== lease.ownerId || saved.expiresAt <= nowIso) throw new ApiError('migration_lease_lost', '库存迁移执行权已转移');
}

function observationStorageMethods(run) {
  return {
    recordObservation: ({ observation, continuityGapMs, collectorLease, queryTargetLease, nowIso }) => run(async tx => {
      if (collectorLease) {
        const lease = await tx.get(C.config, 'collector_lease');
        if (!lease || lease.ownerId !== collectorLease.ownerId || lease.expiresAt <= collectorLease.nowIso) throw new ApiError('collector_lease_lost', '采集执行权已转移');
      }
      if (queryTargetLease) {
        const lease = await tx.get(C.config, queryTargetLease.id);
        if (!lease || lease.ownerId !== queryTargetLease.ownerId || lease.leaseUntil <= Date.parse(queryTargetLease.nowIso)) throw new ApiError('query_target_lease_lost', '该目标由新的查询更新中');
      }
      const previous = await tx.get(C.latest, targetKeyOf(observation.storeNumber, observation.partNumber));
      const result = applyObservation(previous, observation, {
        ...(Number.isFinite(continuityGapMs) ? { continuityGapMs } : {}),
        ...(Number.isFinite(Date.parse(nowIso)) ? { nowMs: Date.parse(nowIso) } : {}),
      });
      if (result.outcome === 'stale' || result.outcome === 'duplicate') return { ...result, observation };
      const storage = storageOf(previous), date = dayKey(observation.observedAt);
      if (previous && previous.observationStorage && (storage.schemaVersion !== 1 || !Number.isSafeInteger(storage.revision) || storage.revision < 0)) throw new ApiError('observation_storage_invalid', '库存持久化版本或修订号需要核对');
      const summaryId = observationDayId(observation.storeNumber, observation.partNumber, date);
      const revision = nextRevision(storage);
      let daily;
      if (storage.mode === 'embedded') {
        if (storage.schemaVersion !== 1 || !storage.day || storage.day.storageRevision !== storage.revision || storage.day.storageMode !== 'embedded'
            || summaryIssues(storage.day, previous, { matchLatest: result.outcome !== 'repaired' }).length) {
          throw new ApiError('observation_summary_invalid', '库存日摘要需要核对，尚未写入本次样本');
        }
        if (storage.day.dayKey === date) daily = storage.day;
        else {
          // Full replacement, never increment/replay. This also preserves an
          // old embedded day when trusted time repairs a future latest record.
          await tx.put(C.observationDays, stamped(storage.day, revision, 'embedded'));
          // Ordinary forward rollover starts a genuinely new day. A trusted
          // future-time repair may return to a previously archived real day.
          daily = result.outcome === 'repaired' ? await tx.get(C.observationDays, summaryId) : null;
          if (daily && (daily.dayKey !== date || summaryIssues(daily, result.latest, { matchLatest: false }).length)) throw new ApiError('observation_summary_invalid', '历史库存日摘要需要核对，已保留原累计');
        }
        if (daily && Date.parse(daily.lastObservedAt) >= Date.parse(observation.observedAt)) throw new ApiError('observation_summary_future', '库存日摘要时间需要核对，已保留原累计');
        daily = stamped(appendObservationDay(daily, observation, result.events), revision, 'embedded');
        result.latest.observationStorage = { ...storage, revision, day: daily };
      } else if (storage.mode === 'legacy') {
        const previousDay = await tx.get(C.observationDays, summaryId);
        let baselineIssue = storage.baselineIssue && storage.baselineIssue.dayKey === date ? storage.baselineIssue : null;
        if (previous && Number.isFinite(Date.parse(previous.observedAt)) && dayKey(previous.observedAt) === date
            && (!previousDay || previousDay.lastObservedAt !== previous.observedAt) && result.outcome !== 'repaired') {
          baselineIssue = { dayKey: date, reason: previousDay ? 'legacy_baseline_mismatch' : 'legacy_baseline_missing' };
        }
        daily = appendObservationDay(previousDay, observation, result.events);
        if (previous && previous.observationStorage || baselineIssue) {
          daily = stamped(daily, revision, 'legacy');
          result.latest.observationStorage = { schemaVersion: 1, mode: 'legacy', revision, day: null, ...(baselineIssue ? { baselineIssue } : {}) };
        }
        await tx.put(C.observationDays, daily);
      } else throw new ApiError('observation_storage_unknown', '库存持久化版本暂不支持');
      await tx.put(C.latest, result.latest);
      for (const event of result.events) await tx.put(C.events, { ...event, dayKey: dayKey(event.detectedAt), notificationPlannedAt: null });
      return { ...result, observation };
    }),

    transitionObservationStorage: ({ targetKey, action = 'migrate', dryRun = true, migrationLease, nowIso }) => run(async tx => {
      const targetParts = typeof targetKey === 'string' ? targetKey.split('|') : [];
      if (targetParts.length !== 2 || !/^R\d{3}$/.test(targetParts[0]) || !isProductIdentity(targetParts[1]) || !['migrate', 'rollback', 'archive'].includes(action)
          || !Number.isFinite(Date.parse(nowIso))) throw new ApiError('invalid_inventory_migration', '库存迁移参数无效');
      if (!dryRun) await assertMigrationLease(tx, migrationLease, nowIso);
      const latest = await tx.get(C.latest, targetKey), storage = storageOf(latest);
      const report = { targetKey, action, dryRun, applied: false, mode: storage.mode, revision: revisionOf(storage.revision) };
      if (!latest || !latest.observedAt) return { ...report, status: 'waiting_for_first_sample', issues: ['no_accepted_observation'] };
      if (!Number.isFinite(Date.parse(latest.observedAt)) || Date.parse(latest.observedAt) > Date.parse(nowIso) + 30000) return { ...report, status: 'blocked', issues: ['invalid_latest_time'] };
      if (!['legacy', 'embedded'].includes(storage.mode) || (latest.observationStorage && (storage.schemaVersion !== 1 || !Number.isSafeInteger(storage.revision) || storage.revision < 0))) return { ...report, status: 'blocked', issues: ['unknown_storage_version'] };
      if (storage.mode === 'embedded' && (!storage.day || storage.day.storageRevision !== storage.revision || storage.day.storageMode !== 'embedded')) return { ...report, status: 'blocked', issues: ['embedded_revision_mismatch'] };
      const baselineDate = dayKey(latest.observedAt);
      if (storage.baselineIssue && storage.baselineIssue.dayKey === baselineDate) return { ...report, status: 'blocked', baselineDate, issues: [storage.baselineIssue.reason] };
      const daily = storage.mode === 'legacy' ? await tx.get(C.observationDays, `${targetKey}|${baselineDate}`) : storage.day;
      const issues = summaryIssues(daily, latest, { matchLatest: true });
      if (issues.length) return { ...report, status: 'blocked', baselineDate, issues };
      if (action === 'migrate' && storage.mode === 'embedded') return { ...report, status: 'already_migrated', baselineDate, sampleCount: daily.sampleCount };
      if (action !== 'migrate' && storage.mode === 'legacy') return { ...report, status: 'already_legacy', baselineDate, sampleCount: daily.sampleCount };
      if (action === 'archive') {
        const archived = await tx.get(C.observationDays, daily._id);
        if (archived && archived.storageRevision === storage.revision && isDeepStrictEqual(publicSummary(archived), publicSummary(daily))) return { ...report, status: 'already_archived', baselineDate, sampleCount: daily.sampleCount };
      }
      const revision = nextRevision({ ...storage, revision: Math.max(storage.revision, revisionOf(daily.storageRevision)) });
      const preview = { ...report, status: 'ready', baselineDate, sampleCount: daily.sampleCount, nextRevision: revision, issues: [] };
      if (dryRun) return preview;
      if (action === 'migrate') {
        await tx.put(C.latest, { ...latest, observationStorage: { schemaVersion: 1, mode: 'embedded', revision, day: stamped(daily, revision, 'embedded') } });
      } else {
        const mode = action === 'rollback' ? 'legacy' : 'embedded';
        await tx.put(C.observationDays, stamped(daily, revision, mode));
        await tx.put(C.latest, { ...latest, observationStorage: { schemaVersion: 1, mode, revision, day: mode === 'legacy' ? null : stamped(daily, revision, mode) } });
      }
      return { ...preview, status: action === 'migrate' ? 'migrated' : action === 'rollback' ? 'rolled_back' : 'archived', applied: true, revision, mode: action === 'rollback' ? 'legacy' : 'embedded' };
    }),

    // No business caller currently uses a raw full replacement. Keep legacy
    // fixture/import support, but never allow it to erase migrated authority.
    saveLatest: latest => run(async tx => {
      const previous = await tx.get(C.latest, latest._id);
      const storage = storageOf(previous);
      if (storage.mode !== 'legacy' || latest.observationStorage && latest.observationStorage.mode !== 'legacy') throw new ApiError('raw_latest_write_forbidden', '迁移后的库存只能通过样本事务更新');
      const saved = previous && previous.observationStorage
        ? { ...latest, observationStorage: { ...storage, schemaVersion: 1, mode: 'legacy', revision: nextRevision(storage), day: null } } : latest;
      await tx.put(C.latest, saved);
    }),
  };
}
module.exports = { MIGRATION_LEASE_ID, storageOf, summaryIssues, publicSummary, selectObservationCoverage, observationStorageMethods };
