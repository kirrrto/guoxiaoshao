/**
 * The scheduled monitor writes new observations once per minute and records
 * its next run as collector.nextRunAt. Visible pages read shortly after that
 * run should have finished, instead of polling faster than the data changes.
 */
const MONITOR_PERIOD_MS = 60000;
const SETTLE_MS = 20000;
const MIN_DELAY_MS = 5000;
const FOLLOW_READ_MAX_MS = 30000;

function monitorPollDelay(collector, now = Date.now()) {
  const nextRunAt = collector && Date.parse(collector.nextRunAt);
  if (!Number.isFinite(nextRunAt)) return MONITOR_PERIOD_MS;
  let due = nextRunAt + SETTLE_MS;
  // A cached status can point at a run that already passed; keep its minute phase.
  if (due < now + MIN_DELAY_MS) due += Math.ceil((now + MIN_DELAY_MS - due) / MONITOR_PERIOD_MS) * MONITOR_PERIOD_MS;
  return Math.min(due - now, MONITOR_PERIOD_MS + SETTLE_MS);
}

/** Visible follow pages observe existing records; this never schedules a stock query. */
function followPollDelay(collector, failures = 0, now = Date.now()) {
  if (failures > 0) return Math.min(120000, FOLLOW_READ_MAX_MS * Math.pow(2, Math.min(2, failures - 1)));
  // A stale collector nextRunAt can skip a whole minute after a slow read.
  // After a successful read, wait at most 30 seconds before the next attempt;
  // request duration is additional. This also catches manual and continuous-
  // worker updates that are not aligned with the scheduled minute.
  return Math.min(FOLLOW_READ_MAX_MS, monitorPollDelay(collector, now));
}

module.exports = { monitorPollDelay, followPollDelay, MONITOR_PERIOD_MS, FOLLOW_READ_MAX_MS };
