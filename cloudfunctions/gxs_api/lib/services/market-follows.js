'use strict';
const { createHash } = require('node:crypto');
const { ApiError } = require('../errors');
const { MARKETS, findMarket, findMarketProduct } = require('../markets');
const { ensureUser } = require('./users');
const { hasMemberAccess, canWatchMarkets, memberLimits, followAllowance } = require('../rules/membership');

function checkOwner(ctx, payload, required) {
  if ((required || payload.expectedUserKey !== undefined) && payload.expectedUserKey !== ctx.identity.userKey) {
    throw new ApiError('market_account_changed', '账户已变化，请刷新后重试');
  }
}

function present(user, follow, all, ctx) {
  const allowance = followAllowance(user, follow, all, ctx.now, ctx.config);
  const status = follow.status === 'active' && !hasMemberAccess(user, ctx.now, ctx.config) ? 'expired'
    : follow.status === 'active' && allowance.marketPlanRequired ? 'plan_required'
    : follow.status === 'active' && allowance.limitPaused ? 'limit_paused' : follow.status;
  return { followId: follow._id, market: follow.market, partNumber: follow.partNumber,
    storeNumbers: follow.storeNumbers, status, savedStatus: follow.status, language: follow.language || 'zh-CN',
    updatedAt: follow.updatedAt, ...allowance };
}

// Existing regional watches can outlive the catalog that originally accepted
// them. Keep the saved account/region namespace authoritative for removal.
function isSavedRegionalWatch(follow, owner) {
  return follow?.userKey === owner && /^[A-Z]{2}$/.test(follow.market) && follow.market !== 'CN'
    && typeof follow._id === 'string' && follow._id.startsWith(owner + '|market:' + follow.market + ':');
}

async function marketFollows(ctx, payload = {}) {
  checkOwner(ctx, payload, false);
  const user = await ensureUser(ctx);
  const all = await ctx.repo.listFollows(user._id);
  const { collector, notifications, internationalMonitoring, internationalNotifications } = ctx.config;
  const monitoring = Object.fromEntries(MARKETS.map(({ code }) => [code, collector.enabled && internationalMonitoring[code] === true]));
  return { follows: all.filter(follow => findMarket(follow.market) || isSavedRegionalWatch(follow, user._id)).map(follow => present(user, follow, all, ctx)),
    savedCount: all.length, limits: memberLimits(user, ctx.now, ctx.config), canWatch: canWatchMarkets(user, ctx.now, ctx.config),
    watchRegistrationOpen: true, watchEditing: true, monitoring,
    notifications: Object.fromEntries(MARKETS.map(({ code }) => [code, monitoring[code] && notifications.enabled && internationalNotifications[code] === true])) };
}

function requireTarget(region, partNumber, storeNumbers) {
  const product = region && findMarketProduct(region.code, partNumber);
  if (!product?.monitorSupported) throw new ApiError('unknown_product', '该站点不支持关注此配置');
  if (!Array.isArray(storeNumbers) || !storeNumbers.length || storeNumbers.length > region.stores.length
    || !storeNumbers.every(number => region.stores.some(store => store.storeNumber === number))
    || new Set(storeNumbers).size !== storeNumbers.length) throw new ApiError('unknown_store', '请选择此站点目录内的门店');
  return product;
}

async function marketWatch(ctx, payload) {
  checkOwner(ctx, payload, true);
  const region = findMarket(payload.market);
  if (!region) throw new ApiError('unknown_market', '该站点不在支持范围内。');
  const product = requireTarget(region, payload.partNumber, payload.storeNumbers);
  const language = payload.language === undefined ? 'zh-CN' : payload.language;
  if (language !== 'zh-CN' && language !== 'en') throw new ApiError('invalid_language', '请选择支持的提醒语言');
  const user = await ensureUser(ctx);
  const all = await ctx.repo.listFollows(user._id);
  const skuHash = createHash('sha256').update(product.partNumber).digest('hex').slice(0, 24);
  const id = user._id + '|market:' + region.code + ':' + skuHash;
  const follow = { _id: id, market: region.code, language, userKey: user._id, partNumber: product.partNumber,
    productTitle: product.title, storeNumbers: payload.storeNumbers.slice().sort(), status: 'active', statusReason: null,
    notify: { enabled: true }, createdAt: ctx.nowIso, updatedAt: ctx.nowIso, lastEventAt: null };
  const saved = await ctx.repo.mutateFollow({ userKey: user._id, follow, market: region.code, nowIso: ctx.nowIso, knownFollows: all,
    expectedUpdatedAt: payload.expectedUpdatedAt });
  return { follow: present(user, saved, [...all.filter(row => row._id !== id), saved], ctx) };
}

async function ownedWatch(ctx, user, payload, allowWithdrawn = false) {
  const id = payload.followId;
  if (typeof id !== 'string' || !id.startsWith(user._id + '|market:') || id.length > 256) throw new ApiError('unknown_follow', '关注不存在');
  const existing = await ctx.repo.getFollow(id);
  const region = existing && findMarket(existing.market);
  if (existing?.userKey !== user._id || (!region && !(allowWithdrawn && isSavedRegionalWatch(existing, user._id)))) throw new ApiError('unknown_follow', '关注不存在');
  return { id, existing, region };
}

async function marketEditWatch(ctx, payload) {
  checkOwner(ctx, payload, true);
  const user = await ensureUser(ctx);
  const { id, region } = await ownedWatch(ctx, user, payload);
  const { removeStore, language, expectedUpdatedAt } = payload;
  if ((removeStore === undefined) === (language === undefined)
    || !(expectedUpdatedAt === null || typeof expectedUpdatedAt === 'string' && Number.isFinite(Date.parse(expectedUpdatedAt)))) {
    throw new ApiError('invalid_payload', '请重新打开关注设置后再修改');
  }
  if (removeStore !== undefined && (typeof removeStore !== 'string' || !removeStore)) throw new ApiError('unknown_store', '请选择要移除的门店');
  if (language !== undefined && !['zh-CN', 'en'].includes(language)) throw new ApiError('invalid_language', '请选择支持的提醒语言');
  const saved = await ctx.repo.editMarketWatch({ userKey: user._id, id, market: region.code, expectedUpdatedAt, removeStore, language, nowIso: ctx.nowIso });
  return { follow: present(user, saved, await ctx.repo.listFollows(user._id), ctx) };
}

async function marketWatchStatus(ctx, payload) {
  checkOwner(ctx, payload, true);
  if (!['active', 'paused', 'removed'].includes(payload.status)) throw new ApiError('invalid_status', '关注状态无效');
  const user = await ensureUser(ctx);
  const { id, existing, region } = await ownedWatch(ctx, user, payload, payload.status !== 'active');
  if (payload.status === 'active') requireTarget(region, existing.partNumber, existing.storeNumbers);
  const all = await ctx.repo.listFollows(user._id);
  const saved = await ctx.repo.mutateFollow({ userKey: user._id, followId: id, status: payload.status, market: existing.market, nowIso: ctx.nowIso, knownFollows: all,
    expectedUpdatedAt: payload.expectedUpdatedAt });
  return { follow: present(user, saved, all, ctx) };
}

module.exports = { marketFollows, marketWatch, marketWatchStatus, marketEditWatch };
