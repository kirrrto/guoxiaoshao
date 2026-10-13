/**
 * The scheduled monitor writes new observations once per minute and records
 * its next run as collector.nextRunAt. Visible pages read shortly after that
 * run should have finished, instead of polling faster than the data changes.
 */
const MONITOR_PERIOD_MS = 60000;
const SETTLE_MS = 20000;
const MIN_DELAY_MS = 5000;

function monitorPollDelay(collector, now = Date.now()) {
  const nextRunAt = collector && Date.parse(collector.nextRunAt);
  if (!Number.isFinite(nextRunAt)) return MONITOR_PERIOD_MS;
  let due = nextRunAt + SETTLE_MS;
  // A cached status can point at a run that already passed; keep its minute phase.
  if (due < now + MIN_DELAY_MS) due += Math.ceil((now + MIN_DELAY_MS - due) / MONITOR_PERIOD_MS) * MONITOR_PERIOD_MS;
  return Math.min(due - now, MONITOR_PERIOD_MS + SETTLE_MS);
}

module.exports = { monitorPollDelay, MONITOR_PERIOD_MS };
