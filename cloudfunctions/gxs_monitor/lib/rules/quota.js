'use strict';
const { dayKey } = require('../time');
/**
 * Query credits accrue by daily sign-in. Older task awards can settle only
 * against proof created before that program ended. Every change is recorded
 * in an idempotent ledger keyed by a deterministic id, so repeated or
 * concurrent requests can never grant or debit twice.
 */

const DEFAULT_CONFIG = Object.freeze({
  signinReward: 1,
  taskReward: 1,
  dailyGrantCap: 2,
  balanceCap: 10,
  queryCost: 1,
  historyCost: 1,
});

function resolveConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config || {}), signinReward: DEFAULT_CONFIG.signinReward, balanceCap: DEFAULT_CONFIG.balanceCap };
}

// A prior build wrote one of these markers only after the history read succeeded.
// A current successful read must never create new eligibility.
function legacyTaskEvidence(user, day) {
  const evidence = user.taskEvidence || {};
  const valid = marker => marker?.dayKey === day && Number.isFinite(Date.parse(marker.completedAt))
    && dayKey(marker.completedAt) === day;
  if (valid(evidence.history_browse)) return { evidenceBrowseDay: day };
  if (valid(evidence.view_history) && evidence.view_history.queryId) return { evidenceQueryId: evidence.view_history.queryId };
  return null;
}

/**
 * How many credits a reward may add right now given the daily cap and the
 * balance cap. Returns 0 when nothing can be granted.
 */
function grantableAmount({ balance, grantedToday, reward }, config) {
  const cfg = resolveConfig(config);
  const dailyRoom = Math.max(0, cfg.dailyGrantCap - grantedToday);
  const balanceRoom = Math.max(0, cfg.balanceCap - balance);
  return Math.max(0, Math.min(reward, dailyRoom, balanceRoom));
}

/** Deterministic ledger ids make every grant/debit idempotent. */
const ledgerIds = {
  signin: (userKey, dayKey) => `${userKey}|signin|${dayKey}`,
  task: (userKey, dayKey, taskId) => `${userKey}|task|${dayKey}|${taskId}`,
  queryDebit: (userKey, queryId) => `${userKey}|query|${queryId}|debit`,
  queryRefund: (userKey, queryId) => `${userKey}|query|${queryId}|refund`,
  historyDebit: (userKey, historyQueryId) => `${userKey}|history|${historyQueryId}|debit`,
  adminGrant: (userKey, grantId) => `${userKey}|admin|${grantId}`,
};

function canAfford(balance, cost) {
  return Number.isInteger(balance) && balance >= cost;
}

module.exports = { DEFAULT_CONFIG, resolveConfig, legacyTaskEvidence, grantableAmount, ledgerIds, canAfford };
