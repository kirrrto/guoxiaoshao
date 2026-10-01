'use strict';
const { ApiError } = require('../errors');
const { dayKey, startOfDay } = require('../time');
const { ledgerIds } = require('../rules/quota');
const { COLLECTIONS } = require('../collections');
const catalog = require('./catalog');
const { fulfilOrder } = require('./member');
const { assertConfigEditor, logConfigAuthorizationDenial } = require('../config-audit');
const { paymentProviderFor, paymentProduct } = require('../payment/service');
const { AUTO_SHARE } = require('../engine/capacity-budget');
const { KNOWN_STATUSES } = require('../engine/events');
const { monitoringSnapshot } = require('../monitor-readiness');

const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

function requireAdmin(ctx, diagnosticStage) {
  if (!ctx.identity.isAdmin) {
    if (diagnosticStage) logConfigAuthorizationDenial(diagnosticStage, ctx.config, ctx.identity);
    throw new ApiError('forbidden', '需要管理员权限');
  }
}

async function getConfig(ctx) {
  requireAdmin(ctx);
  return { config: ctx.config };
}

async function paymentStatus(ctx) {
  requireAdmin(ctx);
  // Pure configuration inspection: no token probe, order creation or payment.
  return { payment: paymentProviderFor(ctx).getReadiness(), product: paymentProduct(ctx) };
}

async function updateConfig(ctx, payload) {
  requireAdmin(ctx, 'admin.updateConfig.requireAdmin');
  const patch = payload && payload.patch;
  assertConfigEditor(ctx.config, patch, ctx.identity, 'admin.updateConfig.snapshot');
  return ctx.repo.patchRuntimeConfig({ patch, updatedAt: ctx.nowIso, actor: ctx.identity, requestId: ctx.requestId });
}

async function seedCatalog(ctx) {
  requireAdmin(ctx);
  return catalog.seed(ctx);
}

/** Grant membership days without payment (testing, compensation, gifts). */
async function grantMembership(ctx, payload) {
  requireAdmin(ctx);
  const userKey = typeof payload.userKey === 'string' ? payload.userKey : null;
  const days = Number(payload.days);
  const grantId = typeof payload.grantId === 'string' && ID_PATTERN.test(payload.grantId) ? payload.grantId : null;
  if (!userKey || !Number.isInteger(days) || days <= 0 || days > 3650) throw new ApiError('invalid_payload', 'userKey/days/grantId 无效');
  if (!grantId) throw new ApiError('invalid_payload', 'grantId 需为 4–64 位标识（用于幂等）');
  const user = await ctx.repo.getUser(userKey);
  if (!user) throw new ApiError('unknown_user', '用户不存在');
  const orderId = `grant_${grantId}`;
  const recordId = `${userKey}|${orderId}`;
  const { order } = await ctx.repo.createOrderIfAbsent({ _id: recordId, orderId, userKey, productId: 'admin_grant', days, amountFen: 0, status: 'paid', createdAt: ctx.nowIso, paidAt: ctx.nowIso, fulfilledAt: null, payment: { source: 'admin', by: ctx.identity.userKey || 'operator', note: payload.note || null } });
  const result = await fulfilOrder(ctx, order, 'admin_grant');
  const refreshed = await ctx.repo.getUser(userKey);
  return { applied: result.applied, expiresAt: refreshed.membership.expiresAt, orderId };
}

async function grantCredits(ctx, payload) {
  requireAdmin(ctx);
  const userKey = typeof payload.userKey === 'string' ? payload.userKey : null;
  const amount = Number(payload.amount);
  const grantId = typeof payload.grantId === 'string' && ID_PATTERN.test(payload.grantId) ? payload.grantId : null;
  if (!userKey || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000 || !grantId) throw new ApiError('invalid_payload', 'userKey/amount/grantId 无效');
  const user = await ctx.repo.getUser(userKey);
  if (!user) throw new ApiError('unknown_user', '用户不存在');
  const result = await ctx.repo.applyLedger({
    _id: ledgerIds.adminGrant(userKey, grantId), userKey, type: 'admin_grant', delta: amount, dayKey: dayKey(ctx.now), createdAt: ctx.nowIso, note: payload.note || null, by: ctx.identity.userKey || 'operator',
  });
  return { applied: result.applied, balance: result.balance };
}

async function stats(ctx) {
  requireAdmin(ctx);
  const [users, follows, events, queries, orders] = await Promise.all([
    ctx.repo.count(COLLECTIONS.users),
    ctx.repo.count(COLLECTIONS.follows, { status: 'active' }),
    ctx.repo.count(COLLECTIONS.events),
    ctx.repo.count(COLLECTIONS.queries),
    ctx.repo.count(COLLECTIONS.orders, { status: 'fulfilled' }),
  ]);
  return { users, activeFollows: follows, events, queries, fulfilledOrders: orders, serverTime: ctx.nowIso };
}

const INSIGHT_LIMIT = 2000;
const WINDOW_BUCKETS = [[60000, '1 分钟内'], [5 * 60000, '1–5 分钟'], [15 * 60000, '5–15 分钟'], [60 * 60000, '15–60 分钟'], [Infinity, '1 小时以上']];

/** Operational snapshot only: no reservations, probes, user creation or refill. */
async function capacity(ctx) {
  requireAdmin(ctx);
  const today = dayKey(ctx.now);
  const since = startOfDay(today).toISOString();
  const [snapshot, queries] = await Promise.all([
    ctx.repo.getUpstreamCapacity({ now: ctx.nowIso }),
    ctx.repo.listSince(COLLECTIONS.queries, 'createdAt', since, INSIGHT_LIMIT),
  ]);
  const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const { day, collector, capacity: stored } = snapshot;
  const total = count(day && day.dayCount);
  const auto = count(day && day.autoCount);
  const manual = count(day && day.manualCount);
  const unclassified = Math.max(0, total - auto - manual);
  const sourceSplitComplete = unclassified === 0 && auto + manual === total;
  const uniqueGroups = collector && Number.isSafeInteger(collector.groupCount) && collector.groupCount >= 0 ? collector.groupCount : null;
  const monitorMode = collector && ['scheduled', 'resident'].includes(collector.mode) ? collector.mode : null;
  const collectorUpdatedAtMs = collector && Date.parse(collector.updatedAt);
  const collectorStatusUpdatedAt = Number.isFinite(collectorUpdatedAtMs) ? new Date(collectorUpdatedAtMs).toISOString() : null;
  const collectorStatusStale = monitoringSnapshot(ctx.config, collector, ctx.now).collector.stale;
  const normalCadenceSeconds = monitorMode ? Math.max(monitorMode === 'scheduled' ? 60 : 1, ctx.config.collector.intervalSeconds) : null;
  const configuredNormalRequestsPerDay = uniqueGroups !== null && normalCadenceSeconds
    ? Math.ceil(uniqueGroups * 86400 / normalCadenceSeconds) : null;
  const autoRequestsPerDay = ctx.config.collector.budgetMode === 'daily'
    ? Math.max(1, Math.floor(ctx.config.collector.maxRequestsPerDay * AUTO_SHARE)) : ctx.config.collector.maxRequestsPerDay * AUTO_SHARE;
  const recordedAtMs = stored && finite(stored.updatedAtMs);
  const recordedAt = recordedAtMs !== null && stored && Number.isFinite(new Date(recordedAtMs).getTime()) ? new Date(recordedAtMs).toISOString() : null;
  const lanes = (values, factor = 1) => Object.fromEntries(['shared', 'auto', 'manual'].map(lane => {
    const value = values && finite(values[lane]);
    return [lane, value == null ? null : finite(value * factor)];
  }));
  const completed = queries.filter(query => query.createdAt <= ctx.nowIso && query.kind === 'live' && ['success', 'failed'].includes(query.status));
  const reuse = { completedLiveQueries: completed.length, freshTargets: 0, reusedTargets: 0, unclassifiedTargets: 0, unknownTargets: 0 };
  for (const query of completed) {
    const results = query.response && Array.isArray(query.response.results) ? query.response.results : [];
    for (const result of results) {
      if (!result || !KNOWN_STATUSES.has(result.status)) reuse.unknownTargets++;
      else if (result.reused === true) reuse.reusedTargets++;
      else if (result.reused === false) reuse.freshTargets++;
      else reuse.unclassifiedTargets++;
    }
  }
  const classified = reuse.freshTargets + reuse.reusedTargets;
  return {
    mode: ctx.config.collector.budgetMode,
    maxRequestsPerMinute: ctx.config.collector.maxRequestsPerMinute,
    sustainedDailyTarget: ctx.config.collector.maxRequestsPerDay,
    ...(ctx.config.collector.budgetMode === 'daily' ? { hardDailyLimit: ctx.config.collector.maxRequestsPerDay } : {}),
    collectorEnabled: ctx.config.collector.enabled, monitorMode, uniqueGroups, collectorStatusUpdatedAt, collectorStatusStale,
    plannedIntervalSeconds: collector && finite(collector.intervalMs) !== null ? collector.intervalMs / 1000 : null,
    normalCadenceSeconds, configuredNormalRequestsPerDay, autoRequestsPerDay,
    aboveAutoCapacity: configuredNormalRequestsPerDay === null ? null : configuredNormalRequestsPerDay > autoRequestsPerDay,
    todayReservations: { date: today, available: Boolean(day), total, auto, manual, unclassified, sourceSplitComplete },
    tokenSnapshot: stored ? { recordedAt, tokens: lanes(stored.tokens), burstCapacity: lanes(stored.capacities), refillPerSecond: lanes(stored.rates, 1000) } : null,
    recentQueryReuse: { since, sampleLimit: INSIGHT_LIMIT, sampledRecords: queries.length, truncated: queries.length >= INSIGHT_LIMIT,
      ...reuse, reuseShareOfClassifiedTargets: classified ? reuse.reusedTargets / classified : null, attributionComplete: reuse.unclassifiedTargets === 0 },
    serverTime: ctx.nowIso,
  };
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
}

function spread(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { count: sorted.length, p50Ms: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9), maxMs: sorted.length ? sorted[sorted.length - 1] : null };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) { const k = key(item); counts[k] = (counts[k] || 0) + 1; }
  return counts;
}

/**
 * Operator view of whether alerts arrive in time to buy: how long stores stay
 * available, how often alerts are skipped for lack of authorisations, how late
 * accepted alerts leave, and what users answered on the alert page.
 */
async function insights(ctx, payload) {
  requireAdmin(ctx);
  const days = Math.min(10, Math.max(1, Math.floor(Number(payload.days) || 7)));
  const since = new Date(ctx.now.getTime() - days * 86400000);
  const [events, notifications] = await Promise.all([
    ctx.repo.listSince(COLLECTIONS.events, 'dayKey', dayKey(since), INSIGHT_LIMIT),
    ctx.repo.listSince(COLLECTIONS.notifications, 'createdAt', since.toISOString(), INSIGHT_LIMIT),
  ]);
  const windows = events.filter(e => e.type === 'became_unavailable' && Number.isFinite(e.availableDurationMs) && e.availableDurationMs >= 0).map(e => e.availableDurationMs);
  const delays = notifications.filter(n => n.status === 'accepted' && n.sentAt && n.detectedAt)
    .map(n => Date.parse(n.sentAt) - Date.parse(n.detectedAt)).filter(ms => Number.isFinite(ms) && ms >= 0);
  const skipReasons = countBy(notifications.filter(n => n.status === 'skipped'), n => n.reason || 'unknown');
  const feedback = countBy(notifications.filter(n => n.feedback && n.feedback.outcome), n => n.feedback.outcome);
  const answered = Object.values(feedback).reduce((sum, n) => sum + n, 0);
  let lower = 0;
  return {
    days,
    since: since.toISOString(),
    truncated: events.length >= INSIGHT_LIMIT || notifications.length >= INSIGHT_LIMIT,
    availability: { ...spread(windows), buckets: WINDOW_BUCKETS.map(([upper, label]) => {
      const count = windows.filter(ms => ms >= lower && ms < upper).length; lower = upper; return { label, count };
    }) },
    alerts: {
      total: notifications.length,
      byStatus: countBy(notifications, n => n.status),
      skipReasons,
      noCreditShare: notifications.length ? (skipReasons.no_subscription_credit || 0) / notifications.length : null,
      sendDelay: spread(delays),
    },
    feedback: { answered, ...feedback, boughtShare: answered ? (feedback.bought || 0) / answered : null },
    serverTime: ctx.nowIso,
  };
}

async function lookupUser(ctx, payload) {
  requireAdmin(ctx);
  const userKey = typeof payload.userKey === 'string' ? payload.userKey : null;
  if (!userKey) throw new ApiError('invalid_payload', 'userKey 无效');
  const user = await ctx.repo.getUser(userKey);
  if (!user) throw new ApiError('unknown_user', '用户不存在');
  const follows = await ctx.repo.listFollows(userKey);
  return { user: { userKey: user._id, createdAt: user.createdAt, lastSeenAt: user.lastSeenAt, membership: user.membership, quota: user.quota, settings: user.settings, subscriptions: user.subscriptions }, follows };
}

module.exports = { getConfig, paymentStatus, updateConfig, seedCatalog, grantMembership, grantCredits, stats, capacity, insights, lookupUser };
