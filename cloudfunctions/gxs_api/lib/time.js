'use strict';
/** Beijing-time helpers. All business days (rewards, new-product windows, history filters) use UTC+8. */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid time value: ${String(value)}`);
  return date;
}

/** `YYYY-MM-DD` of the Beijing calendar day containing `value`. */
function dayKey(value) {
  const shifted = new Date(toDate(value).getTime() + BEIJING_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Start of a Beijing calendar day as a UTC Date. */
function startOfDay(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new TypeError(`Invalid day key: ${key}`);
  return new Date(Date.parse(`${key}T00:00:00.000+08:00`));
}

function endOfDay(key) {
  return new Date(startOfDay(key).getTime() + DAY_MS);
}

function addDays(value, days) {
  return new Date(toDate(value).getTime() + days * DAY_MS);
}

/** Minutes since Beijing midnight, for do-not-disturb windows. */
function minutesOfDay(value) {
  const shifted = new Date(toDate(value).getTime() + BEIJING_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** [start, end) in Beijing minutes; wraps midnight. Equal endpoints mean all day when DND is enabled. */
function inMinuteWindow(value, startMinute, endMinute) {
  const minute = minutesOfDay(value);
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) return minute >= startMinute && minute < endMinute;
  return minute >= startMinute || minute < endMinute;
}

module.exports = { BEIJING_OFFSET_MS, DAY_MS, dayKey, startOfDay, endOfDay, addDays, minutesOfDay, inMinuteWindow, toDate };
