/** Beijing-time quiet periods. Keep the rule contract aligned with gxs_api/lib/rules/dnd. */
const MAX_DND_PERIODS = 8;
const validMinute = value => Number.isInteger(value) && value >= 0 && value < 1440;
const validPeriod = period => Boolean(period && typeof period === 'object' && !Array.isArray(period)
  && validMinute(period.startMinute) && validMinute(period.endMinute));

function validateDndPeriods(periods) {
  return Array.isArray(periods) && periods.length >= 1 && periods.length <= MAX_DND_PERIODS && periods.every(validPeriod);
}

function dndPeriods(dnd) {
  if (!dnd || typeof dnd !== 'object') return [];
  const periods = validateDndPeriods(dnd.periods) ? dnd.periods : validPeriod(dnd) ? [dnd] : [];
  return periods.map(({ startMinute, endMinute }) => ({ startMinute, endMinute }));
}

function activeDnd(dnd, now = Date.now()) {
  if (!dnd || !dnd.enabled) return false;
  const stamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(stamp)) return false;
  const shifted = new Date(stamp + 8 * 3600000);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return dndPeriods(dnd).some(({ startMinute, endMinute }) => startMinute === endMinute
    || (startMinute < endMinute ? minute >= startMinute && minute < endMinute : minute >= startMinute || minute < endMinute));
}

const minuteText = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
function formatDndPeriod(period) {
  if (!validPeriod(period)) return '';
  if (period.startMinute === period.endMinute) return '全天';
  return `${minuteText(period.startMinute)}–${minuteText(period.endMinute)}${period.startMinute > period.endMinute ? '（次日）' : ''}`;
}

function dndSummary(dnd) {
  if (!dnd || !dnd.enabled) return '未开启';
  return dndPeriods(dnd).map(formatDndPeriod).join('、') || '未设置时段';
}

/** Describe the next allowed minute after the union of daily quiet periods. */
function dndStatus(dnd, now = Date.now()) {
  if (!dnd || !dnd.enabled) return '未开启';
  // Do not turn a corrupt new schedule into a confident first-period estimate.
  if (Object.prototype.hasOwnProperty.call(dnd, 'periods') && !validateDndPeriods(dnd.periods)) return '时段待确认';
  const periods = dndPeriods(dnd);
  const stamp = now == null ? NaN : now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!periods.length || !Number.isFinite(stamp)) return '时段待确认';
  const ranges = [];
  for (const { startMinute, endMinute } of periods) {
    if (startMinute === endMinute) return '全天免打扰';
    if (startMinute < endMinute) ranges.push({ start: startMinute, end: endMinute });
    else {
      ranges.push({ start: startMinute, end: 1440 });
      if (endMinute > 0) ranges.push({ start: 0, end: endMinute });
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  if (merged.length === 1 && merged[0].start === 0 && merged[0].end === 1440) return '全天免打扰';
  const shifted = new Date(stamp + 8 * 3600000);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const active = merged.find(range => minute >= range.start && minute < range.end);
  if (!active) return `每天 ${periods.length} 个时段`;
  if (active.end < 1440) return `当前免打扰 · 今天 ${minuteText(active.end)} 恢复`;
  const end = merged[0].start === 0 ? merged[0].end : 0;
  return `当前免打扰 · 明天 ${minuteText(end)} 恢复`;
}

module.exports = { MAX_DND_PERIODS, validateDndPeriods, dndPeriods, activeDnd, formatDndPeriod, dndSummary, dndStatus };
