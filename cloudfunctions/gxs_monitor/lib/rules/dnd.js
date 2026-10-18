'use strict';
const { inMinuteWindow } = require('../time');

const MAX_DND_PERIODS = 8;
const validMinute = value => Number.isInteger(value) && value >= 0 && value < 1440;
const validPeriod = period => Boolean(period && typeof period === 'object' && !Array.isArray(period)
  && validMinute(period.startMinute) && validMinute(period.endMinute));

function validateDndPeriods(periods) {
  return Array.isArray(periods) && periods.length >= 1 && periods.length <= MAX_DND_PERIODS && periods.every(validPeriod);
}

/** New schedules take precedence; old stored accounts remain readable without a migration. */
function dndPeriods(dnd) {
  if (!dnd || typeof dnd !== 'object') return [];
  const periods = validateDndPeriods(dnd.periods) ? dnd.periods : validPeriod(dnd) ? [dnd] : [];
  return periods.map(({ startMinute, endMinute }) => ({ startMinute, endMinute }));
}

/** Each interval is [start, end), in Beijing time. Overlap is the union; equal endpoints mean all day. */
function activeDnd(dnd, now = Date.now()) {
  if (!dnd || !dnd.enabled) return false;
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) && dndPeriods(dnd).some(period => inMinuteWindow(date, period.startMinute, period.endMinute));
}

/** A delayed planner must not revive events that happened inside a quiet period. */
function suppressDndEvent(dnd, now, detectedAt) {
  return activeDnd(dnd, now) || detectedAt != null && activeDnd(dnd, detectedAt);
}

module.exports = { MAX_DND_PERIODS, validateDndPeriods, dndPeriods, activeDnd, suppressDndEvent };
