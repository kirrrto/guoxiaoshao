'use strict';
const { ApiError } = require('../errors');
const { dayKey } = require('../time');
const { ledgerIds } = require('../rules/quota');
const { COLLECTIONS } = require('../collections');
const catalog = require('./catalog');
const { fulfilOrder } = require('./member');

const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

function requireAdmin(ctx) {
  if (!ctx.identity.isAdmin) throw new ApiError('forbidden', '需要管理员权限');
}

async function getConfig(ctx) {
  requireAdmin(ctx);
  return { config: ctx.config };
}

async function updateConfig(ctx, payload) {
  requireAdmin(ctx);
  return ctx.repo.patchRuntimeConfig({ patch: payload && payload.patch, updatedAt: ctx.nowIso, updatedBy: ctx.identity.userKey || 'operator' });
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

async function lookupUser(ctx, payload) {
  requireAdmin(ctx);
  const userKey = typeof payload.userKey === 'string' ? payload.userKey : null;
  if (!userKey) throw new ApiError('invalid_payload', 'userKey 无效');
  const user = await ctx.repo.getUser(userKey);
  if (!user) throw new ApiError('unknown_user', '用户不存在');
  const follows = await ctx.repo.listFollows(userKey);
  return { user: { userKey: user._id, createdAt: user.createdAt, lastSeenAt: user.lastSeenAt, membership: user.membership, quota: user.quota, settings: user.settings, subscriptions: user.subscriptions }, follows };
}

module.exports = { getConfig, updateConfig, seedCatalog, grantMembership, grantCredits, stats, lookupUser };
