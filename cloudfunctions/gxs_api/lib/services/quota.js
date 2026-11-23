'use strict';
const { ApiError } = require('../errors');
const { dayKey } = require('../time');
const { resolveConfig, legacyTaskEvidence, ledgerIds } = require('../rules/quota');
const { ensureUser, quotaSnapshot } = require('./users');

function ledgerEntry(ctx, user, { _id, type, delta, extra }) {
  return {
    _id,
    userKey: user._id,
    type,
    delta,
    dayKey: dayKey(ctx.now),
    createdAt: ctx.nowIso,
    ...(extra || {}),
  };
}

/** Daily sign-in: +1 credit, once per Beijing day, subject to caps. */
async function signin(ctx, payload = {}) {
  if (payload.expectedUserKey !== undefined && payload.expectedUserKey !== ctx.identity.userKey) {
    throw new ApiError('signin_account_changed', '账号已变化，请刷新后重新签到。');
  }
  const user = await ensureUser(ctx);
  const cfg = resolveConfig(ctx.config.quota);
  const snapshot = await quotaSnapshot(ctx, user);
  if (snapshot.signedInToday) return { granted: 0, reason: 'already_signed_in', quota: snapshot };
  const result = await ctx.repo.grantReward({ entry: ledgerEntry(ctx, user, {
    _id: ledgerIds.signin(user._id, snapshot.dayKey), type: 'signin_reward', delta: 0,
  }), config: cfg, reward: cfg.signinReward, grantedToday: snapshot.grantedToday, rewardSnapshot: snapshot });
  const refreshed = await quotaSnapshot(ctx, await ctx.repo.getUser(user._id));
  return { granted: result.amount, reason: result.reason === 'already_completed' ? 'already_signed_in' : result.reason, quota: refreshed };
}

/** Settle only the old client’s already-earned, same-day entitlement. */
async function completeTask(ctx, payload) {
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
  const task = (ctx.config.tasks || []).find(t => t.id === taskId);
  if (!task) throw new ApiError('unknown_task', '任务不存在');
  const user = await ensureUser(ctx);
  const cfg = resolveConfig(ctx.config.quota);
  const snapshot = await quotaSnapshot(ctx, user);
  if (snapshot.tasksDoneToday.includes(taskId)) return { granted: 0, reason: 'already_completed', quota: snapshot };
  if (taskId !== 'view_history') throw new ApiError('task_not_supported', '该任务暂未开放');
  const reward = task.reward ?? cfg.taskReward;
  if (reward === 0) return { granted: 0, reason: 'reward_disabled', quota: snapshot };
  if (!legacyTaskEvidence(user, snapshot.dayKey)) return { granted: 0, reason: 'reward_disabled', quota: snapshot };
  const result = await ctx.repo.grantReward({ entry: ledgerEntry(ctx, user, {
    _id: ledgerIds.task(user._id, snapshot.dayKey, taskId), type: 'task_reward', delta: 0, extra: { taskId },
  }), config: cfg, reward, grantedToday: snapshot.grantedToday, rewardSnapshot: snapshot });
  const refreshed = await quotaSnapshot(ctx, await ctx.repo.getUser(user._id));
  return { granted: result.amount, reason: result.reason, quota: refreshed };
}

async function ledger(ctx, payload) {
  if (payload.expectedUserKey !== undefined && payload.expectedUserKey !== ctx.identity.userKey) {
    throw new ApiError('ledger_account_changed', '微信账号已变化，请刷新后重新操作');
  }
  const user = await ensureUser(ctx);
  const limit = Math.min(Math.max(Number(payload.limit) || 30, 1), 100);
  const entries = await ctx.repo.listLedger(user._id, { limit });
  return { balance: (user.quota && user.quota.balance) || 0, entries: entries.map(e => ({ id: e._id, type: e.type, delta: e.delta, balanceAfter: e.balanceAfter, createdAt: e.createdAt, refId: e.refId || null, taskId: e.taskId || null })) };
}

module.exports = { signin, completeTask, ledger, ledgerEntry };
