'use strict';
const { ApiError } = require('../errors');
const { isMember, canUseReminders, validateFollowLimits, memberLimits, followAllowance } = require('../rules/membership');
const { isLiveRestricted } = require('../rules/new-product');
const { targetKeyOf } = require('../engine/events');
const { ensureUser } = require('./users');

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// `member` gates restricted live inventory; `active` (member or unused free alert) decides monitoring.
function present(follow, latestByKey, storesByNumber, product, ctx, member = true, active = member) {
  const latestRestricted = !member && isLiveRestricted(product || { partNumber: follow.partNumber }, ctx.config.newProductWindows, ctx.now).restricted;
  return {
    followId: follow._id,
    partNumber: follow.partNumber,
    productTitle: product ? product.title : follow.productTitle || follow.partNumber,
    familyName: product ? product.familyName : null,
    status: !active && follow.status === 'active' ? 'expired' : follow.status,
    savedStatus: follow.status,
    statusReason: !active && follow.status === 'active' ? 'membership_expired' : follow.statusReason || null,
    createdAt: follow.createdAt,
    updatedAt: follow.updatedAt,
    latestRestricted,
    stores: follow.storeNumbers.map(storeNumber => {
      // Saved follow configuration survives expiry; restricted live inventory
      // must not bypass the same rule enforced by query.pickup/history.list.
      const latest = latestByKey.get(targetKeyOf(storeNumber, follow.partNumber)) || null;
      const store = storesByNumber.get(storeNumber) || null;
      return {
        storeNumber,
        storeName: store ? store.name : (!latestRestricted && latest && latest.storeName) || storeNumber,
        city: store ? store.city : null,
        ...presentLatest(latest, ctx, latestRestricted),
      };
    }),
  };
}

/** One target's latest observation as pages show it; restricted or stale samples read as unknown. */
function presentLatest(sample, ctx, restricted = false) {
  const latest = restricted ? null : sample;
  const sampleAge = latest ? ctx.now.getTime() - Date.parse(latest.knownAt || latest.observedAt) : NaN;
  const stale = latest && (latest.unknownSince || !Number.isFinite(sampleAge) || sampleAge < 0 || sampleAge > ctx.config.collector.continuityGapMs);
  return {
    status: restricted || stale ? 'unknown' : latest ? latest.status : null,
    isStale: Boolean(stale),
    lastKnownStatus: latest ? latest.status : null,
    statusSince: latest ? latest.statusSince : null,
    observedAt: latest ? latest.observedAt : null,
    unknownSince: latest ? latest.unknownSince : null,
    quote: latest ? latest.quote : null,
  };
}

async function decorate(ctx, follows, member = true, active = member) {
  const keys = follows.flatMap(f => f.storeNumbers.map(s => targetKeyOf(s, f.partNumber)));
  const storeNumbers = [...new Set(follows.flatMap(f => f.storeNumbers))];
  const [latest, stores, products] = await Promise.all([
    ctx.repo.getLatest(keys),
    ctx.repo.getStores(storeNumbers),
    Promise.all([...new Set(follows.map(f => f.partNumber))].map(part => ctx.repo.getProduct(part))),
  ]);
  const latestByKey = new Map(latest.map(l => [l._id, l]));
  const storesByNumber = new Map(stores.map(s => [s.storeNumber, s]));
  const productByPart = new Map(products.filter(Boolean).map(p => [p.partNumber, p]));
  return follows.map(f => present(f, latestByKey, storesByNumber, productByPart.get(f.partNumber), ctx, member, active));
}

async function list(ctx) {
  const user = await ensureUser(ctx);
  const follows = await ctx.repo.listFollows(user._id);
  const member = isMember(user, ctx.now);
  const presented = await decorate(ctx, follows, member, member);
  return { member, freeReminder: false, limits: memberLimits(user, ctx.now), follows: presented.map((row, i) => {
    const allowance = followAllowance(user, follows[i], follows, ctx.now);
    return { ...row, ...allowance,
      ...(allowance.limitPaused ? { status: 'limit_paused', statusReason: 'plan_limit' } : {}),
      stores: row.stores.map(store => ({ ...store, limitPaused: member && !allowance.eligibleStoreNumbers.includes(store.storeNumber) })) };
  }) };
}

/** Create or edit a follow using this account's current paid-plan allowance. */
async function upsert(ctx, payload) {
  const user = await ensureUser(ctx);
  if (!canUseReminders(user, ctx.now)) throw new ApiError('member_required', '关注与到货提醒为会员专属，开通会员后可关注并接收微信提醒');
  const member = isMember(user, ctx.now);
  const partNumber = typeof payload.partNumber === 'string' ? payload.partNumber.trim() : '';
  if (!/^[A-Z0-9]{5}CH\/A$/.test(partNumber)) throw new ApiError('invalid_part_number', '商品编号格式无效');
  const storeNumbers = Array.isArray(payload.storeNumbers) ? payload.storeNumbers.filter(s => typeof s === 'string' && /^R\d{3}$/.test(s)) : [];
  const rawId = typeof payload.followId === 'string' && payload.followId.startsWith(`${user._id}|`) ? payload.followId.slice(user._id.length + 1) : payload.followId;
  const followId = typeof rawId === 'string' && ID_PATTERN.test(rawId) ? rawId : null;
  if (!followId) throw new ApiError('invalid_follow_id', 'followId 需为 8–64 位字母数字标识');

  const [product, stores, follows] = await Promise.all([ctx.repo.getProduct(partNumber), ctx.repo.getStores([...new Set(storeNumbers)]), ctx.repo.listFollows(user._id)]);
  if (!product) throw new ApiError('unknown_product', '该商品不在目录中');
  if (!product.supported) throw new ApiError('unsupported_product', '该商品暂不支持监测');
  if (stores.length !== new Set(storeNumbers).size) throw new ApiError('unknown_store', '存在未知门店编号');

  const recordId = `${user._id}|${followId}`;
  const existing = follows.find(f => f._id === recordId) || null;
  const others = follows.filter(f => f._id !== recordId && f.status !== 'removed');
  const limits = memberLimits(user, ctx.now);
  if (existing && followAllowance(user, existing, follows, ctx.now).limitPaused) throw new ApiError('plan_limit', '该配置超出当前套餐名额，请先移除其他配置或升级月卡、年卡');
  const check = validateFollowLimits(others, { partNumber, storeNumbers }, existing ? Math.max(limits.maxFollows, others.length + 1) : limits.maxFollows, limits.maxStoresPerFollow);
  if (!check.ok) throw new ApiError(check.reason, followLimitMessage(check.reason, limits));

  const follow = {
    _id: recordId,
    userKey: user._id,
    partNumber,
    productTitle: product.title,
    storeNumbers: check.storeNumbers,
    status: 'active',
    statusReason: null,
    notify: { enabled: true },
    createdAt: existing ? existing.createdAt : ctx.nowIso,
    updatedAt: ctx.nowIso,
    lastEventAt: existing ? existing.lastEventAt || null : null,
  };
  const saved = await ctx.repo.mutateFollow({ userKey: user._id, follow, nowIso: ctx.nowIso, knownFollows: follows });
  const [decorated] = await decorate(ctx, [saved], member, true);
  return { follow: decorated };
}

function followLimitMessage(reason, limits) {
  return {
    no_stores: '请至少选择一家门店',
    too_many_stores: `每个配置最多关注 ${limits.maxStoresPerFollow} 家门店`,
    no_part_number: '请选择商品',
    duplicate_part_number: '该机型已在关注列表中',
    too_many_follows: `最多同时关注 ${limits.maxFollows} 个配置`,
  }[reason] || '关注设置无效';
}

async function setStatus(ctx, payload, status) {
  const user = await ensureUser(ctx);
  const followId = typeof payload.followId === 'string' ? payload.followId : '';
  const recordId = followId.startsWith(`${user._id}|`) ? followId : `${user._id}|${followId}`;
  const follow = await ctx.repo.getFollow(recordId);
  if (!follow || follow.userKey !== user._id || follow.status === 'removed') throw new ApiError('unknown_follow', '关注不存在');
  if (status === 'active' && !canUseReminders(user, ctx.now)) throw new ApiError('member_required', '关注与到货提醒为会员专属，开通会员后可恢复监测');
  const updated = await ctx.repo.mutateFollow({ userKey: user._id, followId: recordId, status, nowIso: ctx.nowIso, knownFollows: await ctx.repo.listFollows(user._id) });
  if (status === 'removed') return { removed: true, followId };
  const [decorated] = await decorate(ctx, [updated], isMember(user, ctx.now), canUseReminders(user, ctx.now));
  return { follow: decorated };
}

module.exports = {
  presentLatest,
  list,
  upsert,
  pause: (ctx, payload) => setStatus(ctx, payload, 'paused'),
  resume: (ctx, payload) => setStatus(ctx, payload, 'active'),
  remove: (ctx, payload) => setStatus(ctx, payload, 'removed'),
};
