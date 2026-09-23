'use strict';
/**
 * Data retention: keep the most recent RETENTION_DAYS Beijing days of raw
 * history (events, finished queries, settled reminders and short-lived
 * bookkeeping). Daily observation summaries, which also count each day's
 * events and availability windows, are kept long term, as are users, the
 * quota ledger, orders, follows, current observations and configuration.
 *
 * The scheduled monitor calls this every minute; it runs at most once per
 * Beijing day, after the overnight quiet hour, inside the monitor's lease.
 */
const { dayKey, startOfDay, addDays, minutesOfDay } = require('../time');

const RETENTION_DAYS = 10;
const RUN_AFTER_MINUTE = 4 * 60;
const MIN_REMAINING_MS = 10000;

/** First Beijing day still kept; today counts as one of the RETENTION_DAYS. */
function retentionStart(now) {
  return dayKey(addDays(now, -(RETENTION_DAYS - 1)));
}

async function runRetentionIfDue({ repo, now, log = console, remainingMs = () => Infinity }) {
  if (minutesOfDay(now) < RUN_AFTER_MINUTE || remainingMs() < MIN_REMAINING_MS) return null;
  const today = dayKey(now);
  try {
    const previous = await repo.getRetentionStatus();
    if (previous && previous.lastRunDay === today) return null;
    const firstDay = retentionStart(now);
    const { removed, errors } = await repo.purgeExpiredData({ firstDay, cutoffIso: startOfDay(firstDay).toISOString() });
    if (Object.keys(errors).length) log.error('[retention] some collections were not purged', errors);
    // Record the day even after a partial failure: retry tomorrow, not every minute.
    const status = { _id: 'retention_status', lastRunDay: today, lastRunAt: now.toISOString(), firstDay, removed, errors };
    await repo.saveRetentionStatus(status);
    return status;
  } catch (error) {
    // Retention must never fail the monitor scan it runs after.
    log.error('[retention] skipped', error && error.message ? error.message : error);
    return null;
  }
}

module.exports = { RETENTION_DAYS, retentionStart, runRetentionIfDue };
