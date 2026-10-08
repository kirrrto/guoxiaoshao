'use strict';
const { ApiError } = require('../errors');
const { dayKey } = require('../time');
const { membershipSnapshot, isMember, LIMITS, FREE_REMINDER_FOLLOWS } = require('../rules/membership');
const { resolveConfig } = require('../rules/quota');
const { maskOpenid } = require('../identity');
const { monitoringSnapshot } = require('../monitor-readiness');
const { paymentProduct, paymentProducts } = require('../payment/service');

function newUser(identity, nowIso) {
  return {
    _id: identity.userKey,
    appid: identity.appid,
    openid: identity.openid,
    createdAt: nowIso,
    lastSeenAt: nowIso,
    membership: { expiresAt: null, source: null, updatedAt: null },
    quota: { balance: 0, updatedAt: nowIso, dailyRewardSnapshot: { version: 1, dayKey: dayKey(nowIso), grantedToday: 0, signedInToday: false, tasksDoneToday: [] } },
    followIndex: [],
    settings: { dnd: { enabled: false, startMinute: 23 * 60, endMinute: 8 * 60 }, notifyEnabled: true },
    subscriptions: {},
    stats: { queries: 0 },
  };
}

/** Load or lazily create the caller's user document; operator calls have no user. */
async function ensureUser(ctx) {
  if (!ctx.identity.userKey) throw new ApiError('user_required', '该操作需要小程序用户身份');
  let user = await ctx.repo.getUser(ctx.identity.userKey);
  if (!user) user = await ctx.repo.createUser(newUser(ctx.identity, ctx.nowIso));
  return user;
}

async function touchUser(ctx, user) {
  const last = user.lastSeenAt ? Date.parse(user.lastSeenAt) : 0;
  if (ctx.now.getTime() - last > 10 * 60 * 1000) {
    try {
      await ctx.repo.updateUser(user._id, { lastSeenAt: ctx.nowIso });
    } catch {
      // This timestamp is for operator visibility, not account authorization.
      // Keep required account reads strict and retry the touch on a later visit.
      try {
        if (ctx.log && typeof ctx.log.warn === 'function') ctx.log.warn('[bootstrap] last-seen update deferred');
      } catch { /* Logging cannot make this optional timestamp mandatory. */ }
    }
  }
}

async function quotaSnapshot(ctx, user) {
  const cfg = resolveConfig(ctx.config.quota);
  const today = dayKey(ctx.now);
  const stored = user.quota && user.quota.dailyRewardSnapshot;
  // This summary is updated with the reward ledger in the same transaction.
  // Older documents and a new business day fall back to the complete ledger.
  let summary = stored && stored.version === 1 && stored.dayKey === today ? stored : null;
  if (!summary) {
    const entries = await ctx.repo.listLedger(user._id, { dayKey: today, limit: Infinity });
    summary = {
      grantedToday: entries.filter(e => e.delta > 0 && !['query_refund', 'notification_test_refund', 'admin_grant'].includes(e.type)).reduce((sum, e) => sum + e.delta, 0),
      signedInToday: entries.some(e => e.type === 'signin_reward'),
      tasksDoneToday: [...new Set(entries.filter(e => e.type === 'task_reward').map(e => e.taskId))],
    };
  }
  return {
    balance: (user.quota && user.quota.balance) || 0,
    revision: user.quota && Number.isInteger(user.quota.revision) ? user.quota.revision : 0,
    grantedToday: summary.grantedToday,
    dailyGrantCap: cfg.dailyGrantCap,
    balanceCap: cfg.balanceCap,
    queryCost: cfg.queryCost,
    historyCost: cfg.historyCost,
    signedInToday: summary.signedInToday,
    tasksDoneToday: summary.tasksDoneToday,
    tasksViewedToday: user.taskEvidence && user.taskEvidence.history_browse && user.taskEvidence.history_browse.dayKey === today ? ['view_history'] : [],
    dayKey: today,
  };
}

/** Ledgers from the 2026-09-22 build issued more tickets than accepts; see repairInflatedCredits. */
async function repairInflatedSubscriptions(ctx, user) {
  const needsRepair = sub => sub && sub.creditLedger && !sub.poolRepairedAt
    && Number(sub.creditLedger.sequence) > (Number.isSafeInteger(sub.accepted) ? sub.accepted : 0);
  const inflated = Object.entries(user.subscriptions || {}).filter(([, sub]) => needsRepair(sub));
  for (const [templateId, initial] of inflated) {
    let subscription = initial;
    for (let attempt = 0; attempt < 3 && needsRepair(subscription); attempt++) {
      // Reserved and uncertain sends already occupy permission, even before an
      // accepted response. The transaction rejects a stale ledger snapshot.
      const usedCredits = await ctx.repo.countSubscriptionRepairUsage({ userKey: user._id, templateId });
      const result = await ctx.repo.repairInflatedCredits({ userKey: user._id, templateId, usedCredits,
        expectedSubscription: subscription, now: ctx.nowIso });
      if (!result.retry) break;
      const latest = await ctx.repo.getUser(user._id);
      subscription = latest && latest.subscriptions && latest.subscriptions[templateId];
    }
  }
  return inflated.length > 0;
}

async function bootstrap(ctx) {
  const staleBefore = new Date(ctx.now.getTime() - 120000).toISOString();
  let [user, abandoned, metadata] = await Promise.all([
    ensureUser(ctx),
    ctx.repo.listExpiredQueries(ctx.identity.userKey, staleBefore, 20),
    ctx.repo.getBootstrapMetadata(),
  ]);
  for (const query of abandoned) await ctx.repo.expireQuery({ id: query._id, userKey: user._id, nowIso: ctx.nowIso, staleBefore });
  if (abandoned.length) user = await ctx.repo.getUser(user._id);
  if (await repairInflatedSubscriptions(ctx, user)) user = await ctx.repo.getUser(user._id);
  const [quota, follows] = await Promise.all([
    quotaSnapshot(ctx, user),
    Array.isArray(user.followIndex) ? user.followIndex : ctx.repo.listFollows(user._id),
    touchUser(ctx, user),
  ]);
  const { catalogMeta, collectorStatus } = metadata;
  const monitoring = monitoringSnapshot(ctx.config, collectorStatus, ctx.now);
  return {
    collector: monitoring.collector,
    serverTime: ctx.nowIso,
    identity: { appid: ctx.identity.appid, userKey: ctx.identity.userKey, openidMasked: maskOpenid(ctx.identity.openid), crossAccount: ctx.identity.crossAccount, isAdmin: ctx.identity.isAdmin },
    membership: membershipSnapshot(user, ctx.now),
    quota,
    tasks: ctx.config.tasks,
    followCount: follows.filter(f => f.status === 'active' || f.status === 'paused').length,
    memberProduct: paymentProduct(ctx),
    memberProducts: paymentProducts(ctx),
    newProductWindows: ctx.config.newProductWindows,
    // Follow and WeChat reminders are member-only; free accounts only get query credits.
    freeReminder: false,
    limits: { queryMaxStores: ctx.config.query.maxStores, maxFollows: isMember(user, ctx.now) ? LIMITS.maxFollows : FREE_REMINDER_FOLLOWS, maxStoresPerFollow: LIMITS.maxStoresPerFollow },
    notifications: monitoring.notifications,
    settings: user.settings,
    subscriptions: user.subscriptions || {},
    catalogVersion: catalogMeta ? catalogMeta.version : null,
    announcement: ctx.config.announcement,
  };
}

async function updateSettings(ctx, payload) {
  const user = await ensureUser(ctx);
  const patch = {};
  if (payload.dnd && typeof payload.dnd === 'object') {
    const { enabled, startMinute, endMinute } = payload.dnd;
    const valid = m => Number.isInteger(m) && m >= 0 && m < 24 * 60;
    if (!valid(startMinute) || !valid(endMinute)) throw new ApiError('invalid_dnd', '免打扰时间无效');
    patch.dnd = { enabled: Boolean(enabled), startMinute, endMinute };
  }
  if (typeof payload.notifyEnabled === 'boolean') patch.notifyEnabled = payload.notifyEnabled;
  const settings = await ctx.repo.updateUserSettings(user._id, patch);
  return { settings };
}

module.exports = { ensureUser, bootstrap, quotaSnapshot, updateSettings, newUser };
