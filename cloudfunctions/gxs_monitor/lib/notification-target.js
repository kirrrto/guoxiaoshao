'use strict';

/** Follow timestamps also guard actions opened from old notification cards. */
function nextFollowUpdatedAt(follow, nowIso) {
  const previous = Date.parse(follow && follow.updatedAt);
  return new Date(Math.max(Date.parse(nowIso), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

function targetSnapshot(follow) {
  if (!follow || !Number.isFinite(Date.parse(follow.updatedAt)) || !Array.isArray(follow.storeNumbers) || !follow.storeNumbers.length) return null;
  return { partNumber: follow.partNumber, storeNumbers: [...new Set(follow.storeNumbers)].sort(), updatedAt: follow.updatedAt };
}

/** A single event store cannot establish the complete follow that was notified. */
function matchesNotificationTarget(task, follow) {
  const snapshot = task && task.targetSnapshot;
  if (!snapshot || !follow || task.followId !== follow._id || task.userKey !== follow.userKey || follow.status === 'removed') return false;
  if (!Number.isFinite(Date.parse(snapshot.updatedAt)) || snapshot.updatedAt !== follow.updatedAt) return false;
  if (snapshot.partNumber !== task.partNumber || snapshot.partNumber !== follow.partNumber) return false;
  if (!Array.isArray(snapshot.storeNumbers) || !snapshot.storeNumbers.length || !snapshot.storeNumbers.includes(task.storeNumber) || !Array.isArray(follow.storeNumbers)) return false;
  const current = [...new Set(follow.storeNumbers)];
  return snapshot.storeNumbers.length === current.length && current.every(store => snapshot.storeNumbers.includes(store));
}

module.exports = { nextFollowUpdatedAt, targetSnapshot, matchesNotificationTarget };
