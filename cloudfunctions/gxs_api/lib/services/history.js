'use strict';
const { randomUUID } = require('node:crypto');
const { ApiError } = require('../errors');
const { dayKey } = require('../time');
const { isMember } = require('../rules/membership');
const { isLiveRestricted, isHistoryRestricted } = require('../rules/new-product');
const { targetKeyOf } = require('../engine/events');
const { ensureUser } = require('./users');
const { completeTask } = require('./quota');
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
function decodeCursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 1024) throw new Error('invalid');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed.id !== 'string' || parsed.id.length > 512 || !Number.isFinite(Date.parse(parsed.detectedAt))) throw new Error('invalid');
    return parsed;
  } catch { throw new ApiError('invalid_cursor', '分页位置无效，请重新查询'); }
}
function presentEvent(e) {
  return { id: e._id, type: e.type, detectedAt: e.detectedAt, storeNumber: e.storeNumber, storeName: e.storeName, status: e.status, previousStatus: e.previousStatus, gapMs: e.gapMs === undefined ? null : e.gapMs, availableDurationMs: e.availableDurationMs === undefined ? null : e.availableDurationMs, coverageGap: typeof e.coverageGap === 'boolean' ? e.coverageGap : null, source: e.source, quote: e.quote };
}
/** Free history landing content. This exposes only this caller's own viewing
 * conditions, never paid event results or restricted current inventory. */
async function browse(ctx) {
  const user = await ensureUser(ctx);
  const queries = await ctx.repo.listRecentHistoryViews(user._id, 20);
  const seen = new Set();
  const recentViews = queries.filter(query => {
    const key = JSON.stringify([query.partNumber, query.dayKey, query.storeNumbers]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 3).map(query => ({ partNumber: query.partNumber, dayKey: query.dayKey,
    storeNumbers: query.storeNumbers || [], viewedAt: query.finishedAt || query.createdAt }));
  // Only a successful server read creates proof. Empty history is a valid read;
  // failed reads never reach this transaction. Use the completion business day.
  const now = ctx.clock();
  const completed = { ...ctx, now, nowIso: now.toISOString() };
  await ctx.repo.recordHistoryBrowse({ userKey: user._id, nowIso: completed.nowIso });
  const task = (ctx.config.tasks || []).find(item => item.id === 'view_history');
  const reward = task ? await completeTask(completed, { taskId: 'view_history' }) : null;
  return { recentViews, browsedAt: completed.nowIso, task: reward };
}
async function list(ctx, payload) {
  const historyQueryId = typeof payload.historyQueryId === 'string' && ID_PATTERN.test(payload.historyQueryId) ? payload.historyQueryId : null;
  if (!historyQueryId) throw new ApiError('invalid_query_id', 'historyQueryId 需为 8–64 位字母数字标识');
  const partNumber = typeof payload.partNumber === 'string' ? payload.partNumber.trim() : '';
  if (!/^[A-Z0-9]{5}CH\/A$/.test(partNumber)) throw new ApiError('invalid_part_number', '商品编号格式无效');
  const requestedDay = payload.dayKey === undefined ? dayKey(ctx.now) : payload.dayKey;
  const parsedDay = typeof requestedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) ? new Date(`${requestedDay}T00:00:00Z`) : new Date(NaN);
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== requestedDay || requestedDay > dayKey(ctx.now)) throw new ApiError('invalid_day', '请选择有效的历史日期');
  const storeNumbers = Array.isArray(payload.storeNumbers) ? [...new Set(payload.storeNumbers.filter(s => typeof s === 'string' && /^R\d{3}$/.test(s)))] : [];
  if (storeNumbers.length > 10) throw new ApiError('too_many_stores', '历史查询最多选择 10 家门店');
  const limit = Math.min(200, Math.max(1, Math.floor(Number(payload.limit) || 100)));
  const cursor = decodeCursor(payload.cursor);
  const user = await ensureUser(ctx);
  const [product, stores] = await Promise.all([ctx.repo.getProduct(partNumber), ctx.repo.getStores(storeNumbers)]);
  if (!product) throw new ApiError('unknown_product', '该商品不在目录中');
  if (stores.length !== storeNumbers.length) throw new ApiError('unknown_store', '存在未知门店编号');
  const member = isMember(user, ctx.now);
  const restriction = isHistoryRestricted(product, ctx.config.newProductWindows, requestedDay, ctx.now);
  if (!member && restriction.restricted) return { ok: false, reason: 'new_product_history_restricted', restrictionEndsAt: restriction.endsAt, cost: 0, balance: user.quota.balance };
  const exposeLatest = member || !isLiveRestricted(product, ctx.config.newProductWindows, ctx.now).restricted;
  const recordId = `${user._id}|history|${historyQueryId}`;
  const ownerId = randomUUID();
  const begun = await ctx.repo.beginQuery({ record: { _id: recordId, userKey: user._id, queryId: historyQueryId, kind: 'history', partNumber, storeNumbers, dayKey: requestedDay }, product, config: ctx.config, ownerId, nowIso: ctx.nowIso });
  if (begun.busy) return { ok: false, reason: 'query_in_progress', historyQueryId, retryAfterMs: begun.retryAfterMs };
  if (begun.denied) return { ok: false, reason: begun.denied.reason, restrictionEndsAt: begun.denied.restrictionEndsAt || null, cost: begun.denied.cost, balance: begun.balance };
  if (begun.replayed && (!cursor || begun.record.response.pagination && begun.record.response.pagination.total === 0)) return { ...begun.record.response, latest: exposeLatest ? presentLatest(begun.record.response.latest || [], ctx) : [], latestRestricted: !exposeLatest, replayed: true };
  if (begun.replayed && begun.record.status === 'failed') return { ...begun.record.response, replayed: true };
  try {
    const page = await ctx.repo.getEventHistory({ partNumber, storeNumbers, dayKey: requestedDay, cursor, limit, snapshotAt: begun.record.createdAt });
    const original = begun.replayed ? begun.record.response : null;
    const total = original ? original.pagination.total : page.total;
    let observationCoverage = original && original.observationCoverage;
    if (!original) {
      // These are persisted daily sample counts, not continuous coverage or an
      // event-time snapshot. Freeze this independently timed read for paging.
      const sampledStores = await ctx.repo.getObservationCoverage({ partNumber, storeNumbers, dayKey: requestedDay });
      observationCoverage = { tracking: 'daily_samples_v1', scope: 'recorded_samples_only', checkedAt: ctx.clock().toISOString(), requestedStoreNumbers: storeNumbers, stores: sampledStores };
    }
    const dataAvailability = original && original.dataAvailability || { status: total === 0 ? 'no_records' : 'recorded_events', eventCount: total };
    const billing = original ? original.billing : { reason: total === 0 ? (begun.record.charged > 0 ? 'empty_history_refunded' : 'empty_history_no_charge') : (begun.record.charged > 0 ? 'history_charged' : 'history_no_charge') };
    const latest = begun.replayed ? begun.record.response.latest || [] : exposeLatest && storeNumbers.length ? await ctx.repo.getLatest(storeNumbers.map(s => targetKeyOf(s, partNumber))) : [];
    const last = page.events.at(-1);
    const response = { ok: true, historyQueryId, product: { partNumber: product.partNumber, title: product.title, model: product.model, familyName: product.familyName }, dayKey: requestedDay,
      charged: begun.record.charged, balance: begun.balance, member: begun.record.member, summary: original ? original.summary : page.summary, events: page.events.map(presentEvent),
      dataAvailability, billing, ...(observationCoverage ? { observationCoverage } : {}),
      latest: exposeLatest ? presentLatest(latest, ctx) : [], latestRestricted: !exposeLatest,
      latestSnapshotAt: begun.replayed ? begun.record.response.latestSnapshotAt : ctx.clock().toISOString(),
      pagination: { nextCursor: page.hasMore && last ? Buffer.from(JSON.stringify({ detectedAt: last.detectedAt, id: last._id })).toString('base64url') : null, hasMore: page.hasMore, total, snapshotAt: begun.record.createdAt },
    };
    if (begun.replayed) return { ...response, refunded: original.refunded || 0, replayed: true };
    // No saved events means there was no historical result to charge for,
    // whether daily samples exist or not. Use the full total, never page size
    // or the four displayed event-type counters, and retain atomic refunds.
    const finished = await ctx.repo.finishQuery({ id: recordId, ownerId, response, refund: total === 0, nowIso: ctx.clock().toISOString() });
    return finished.stale ? { ok: false, reason: 'query_in_progress', historyQueryId, retryAfterMs: 1000 } : finished.response;
  } catch (error) {
    if (begun.replayed) throw error;
    ctx.log.error('[history] failed; compensating', error && error.message);
    const finished = await ctx.repo.finishQuery({ id: recordId, ownerId, response: { ok: false, reason: 'query_failed', historyQueryId, events: [], latest: [] }, refund: true, nowIso: ctx.clock().toISOString() });
    return finished.response || { ok: false, reason: 'query_in_progress', historyQueryId, retryAfterMs: 1000 };
  }
}
function presentLatest(latest, ctx) {
  return latest.map(l => {
    const age = ctx.now.getTime() - Date.parse(l.knownAt || l.observedAt);
    const isStale = Boolean(l.unknownSince) || !Number.isFinite(age) || age > ctx.config.collector.continuityGapMs;
    return { storeNumber: l.storeNumber, storeName: l.storeName, status: isStale ? 'unknown' : l.status, lastKnownStatus: l.lastKnownStatus || l.status, isStale, statusSince: l.statusSince, observedAt: l.observedAt, knownAt: l.knownAt, unknownSince: l.unknownSince, quote: l.quote };
  });
}
module.exports = { list, browse };
