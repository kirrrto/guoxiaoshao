'use strict';
const { ApiError } = require('../errors');
const { dayKey } = require('../time');
const { membershipSnapshot, accountLimits } = require('../rules/membership');
const { ensurePlanMetadata, ensureOutageCompensation } = require('../rules/member-plan');
const { resolveConfig } = require('../rules/quota');
const { maskOpenid } = require('../identity');
const { monitoringSnapshot } = require('../monitor-readiness');
const { paymentProduct, paymentProducts } = require('../payment/service');
const { runtimeFor } = require('../growth-policy');
const { validateDndPeriods, MAX_DND_PERIODS } = require('../rules/dnd');

const OUTAGE_COMPENSATION_NOTICE = Object.freeze({
  id: 'outage-compensation-2026-10-21',
  title: '服务恢复与会员时长补偿',
  kind: 'recovery',
  publishedAt: '2026-10-21T00:00:00+08:00',
  startsAt: '2026-10-21T00:00:00+08:00',
  expiresAt: '2026-10-21T23:59:59+08:00',
  text: '因昨晚服务器故障，目前查询与监测服务已恢复。今日（10 月 21 日）已为会员及曾付费用户自动顺延 1 天会员时长，免费用户今日打开自动获赠 1 天体验会员，可在「我的」查看。',
});

const IPAD_MINI_CATALOG_NOTICE = Object.freeze({
  id: 'ipad-mini-catalog-2026-10-27',
  title: '新款 iPad mini 目录更新说明',
  kind: 'notice',
  publishedAt: '2026-10-27T00:00:00+08:00',
  startsAt: '2026-10-27T00:00:00+08:00',
  expiresAt: '2026-11-06T23:59:59+08:00',
  text: '苹果商店已上架新款 iPad mini（A20 Pro），老款取货接口已停用。果小哨已同步更新新款全系配置；原关注老款的用户请点「调整」改选新款。',
});

function noticeExpiresAt(raw) {
  const configured = raw.expiresAt ? Date.parse(raw.expiresAt) : NaN;
  const published = typeof raw.publishedAt === 'string' ? raw.publishedAt.trim() : '';
  // Compatibility for the dated incident whose legacy runtime row had no end.
  // Keep in sync with miniprogram/utils/query-notice.js; never retire later rows.
  if (typeof raw.title !== 'string' || raw.title.trim() !== '接口限流说明'
    || !(/(?:z|[+-]\d{2}:?\d{2})$/i.test(published) && Date.parse(published) === Date.parse('2026-10-16T14:00:00+08:00')
      || /^2026-10-16[ T]14:00(?::00)?$/.test(published))) return raw.expiresAt || null;
  const confirmedEnd = '2026-10-16T20:20:00+08:00';
  return Number.isFinite(configured) && configured < Date.parse(confirmedEnd) ? raw.expiresAt : confirmedEnd;
}

/** Drop expired structured banners; legacy strings have no clock and stay until cleared. */
function liveAnnouncement(raw, now) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.trim() ? raw : null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const startsAt = raw.startsAt ? Date.parse(raw.startsAt) : null;
  const expiry = noticeExpiresAt(raw);
  const expiresAt = expiry ? Date.parse(expiry) : null;
  const t = now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now();
  if (Number.isFinite(startsAt) && t < startsAt) return null;
  if (Number.isFinite(expiresAt) && t >= expiresAt) return null;
  return { text, kind: ['notice', 'maintenance', 'recovery', 'warn'].includes(raw.kind) ? raw.kind : 'notice', startsAt: raw.startsAt || null, expiresAt: expiry };
}

/** Notice-board rows; same expiry rules as the banner announcement. */
function liveNotices(raw, now) {
  if (!Array.isArray(raw)) return [];
  const t = now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now();
  const out = [];
  for (const item of raw) {
    const live = liveAnnouncement(item, t);
    if (!live) continue;
    out.push({
      id: item && typeof item.id === 'string' ? item.id.slice(0, 64) : '',
      title: item && typeof item.title === 'string' ? item.title.slice(0, 40) : '',
      publishedAt: item && typeof item.publishedAt === 'string' ? item.publishedAt.slice(0, 32) : '',
      ...live,
    });
  }
  return out;
}

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
  user = await ensurePlanMetadata(ctx.repo, user);
  return ensureOutageCompensation(ctx.repo, user, ctx.now);
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
  const builtInNotice = [IPAD_MINI_CATALOG_NOTICE, OUTAGE_COMPENSATION_NOTICE]
    .map(raw => ({ raw, live: liveAnnouncement(raw, ctx.now) }))
    .find(item => item.live);
  const configuredBanner = liveAnnouncement(ctx.config.announcement, ctx.now);
  const configuredNotices = liveNotices(ctx.config.notices, ctx.now);
  const announcement = configuredBanner || (builtInNotice ? {
    ...builtInNotice.live,
    title: builtInNotice.raw.title,
    publishedAt: builtInNotice.raw.publishedAt,
  } : null);
  const notices = builtInNotice && configuredBanner && !configuredNotices.some(item => item.id === builtInNotice.raw.id)
    ? [{ id: builtInNotice.raw.id, title: builtInNotice.raw.title, publishedAt: builtInNotice.raw.publishedAt, ...builtInNotice.live }, ...configuredNotices]
    : configuredNotices;
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
    limits: accountLimits(user, ctx.now, ctx.config),
    notifications: monitoring.notifications,
    settings: user.settings,
    subscriptions: user.subscriptions || {},
    catalogVersion: catalogMeta ? catalogMeta.version : null,
    announcement,
    notices,
    ...runtimeFor(ctx.config, user._id),
  };
}

async function updateSettings(ctx, payload) {
  const user = await ensureUser(ctx);
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'dnd')) {
    const dnd = payload.dnd;
    if (!dnd || typeof dnd !== 'object' || Array.isArray(dnd)) throw new ApiError('invalid_dnd', '免打扰时间无效');
    const hasPeriods = Object.prototype.hasOwnProperty.call(dnd, 'periods');
    const periods = hasPeriods ? dnd.periods : [{ startMinute: dnd.startMinute, endMinute: dnd.endMinute }];
    if (!validateDndPeriods(periods)) throw new ApiError('invalid_dnd', `请设置 1–${MAX_DND_PERIODS} 个有效免打扰时段`);
    const clean = periods.map(({ startMinute, endMinute }) => ({ startMinute, endMinute }));
    // Keep the first interval mirrored for old clients. Legacy single-period
    // writes keep their original shape; the transaction guards newer schedules.
    patch.dnd = { enabled: Boolean(dnd.enabled), ...clean[0], ...(hasPeriods ? { periods: clean } : {}) };
  }
  if (typeof payload.notifyEnabled === 'boolean') patch.notifyEnabled = payload.notifyEnabled;
  const settings = await ctx.repo.updateUserSettings(user._id, patch);
  return { settings };
}

module.exports = { ensureUser, bootstrap, quotaSnapshot, updateSettings, newUser };
