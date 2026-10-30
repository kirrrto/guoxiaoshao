'use strict';
const { ApiError } = require('../errors');
const { ensureUser } = require('./users');
const deadline = require('../deadline');

function guard(ctx, payload, required = false) {
  if ((required || Object.prototype.hasOwnProperty.call(payload, 'expectedUserKey')) && payload.expectedUserKey !== ctx.identity.userKey) {
    throw new ApiError('deadline_account_changed', '微信账号已变化，请刷新后重新操作');
  }
}
function requestId(value) {
  if (!deadline.REQUEST_PATTERN.test(value || '')) throw new ApiError('invalid_request_id', '操作编号无效，请重新打开页面');
  return value;
}
function mutation(payload) {
  if (typeof payload.id !== 'string' || !/^deadline_[a-f0-9]{64}$/.test(payload.id)) throw new ApiError('deadline_not_found', '这条到期提醒不存在');
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) throw new ApiError('deadline_revision_conflict', '提醒已变化，请刷新后重试');
  return { id: payload.id, revision: payload.revision };
}
function readiness(ctx) { return deadline.capability(ctx.config, { env: ctx.notificationEnv || process.env }); }
function response(ctx, item) { const ready = readiness(ctx); return { userKey: ctx.identity.userKey, item: deadline.present(item, ctx.config, ctx.now, ready), capability: ready }; }
async function list(ctx, payload) {
  guard(ctx, payload);
  const user = await ensureUser(ctx);
  const items = await ctx.repo.listDeadlines(user._id, deadline.LIMIT);
  const ready = readiness(ctx);
  return { userKey: user._id, items: items.map(item => deadline.present(item, ctx.config, ctx.now, ready)), limit: deadline.LIMIT,
    capability: ready, serverTime: ctx.nowIso };
}
async function create(ctx, payload) {
  guard(ctx, payload);
  const id = deadline.recordId(ctx.identity.userKey, requestId(payload.requestId));
  const user = await ensureUser(ctx);
  // An acknowledged-lost create must be replayable after its scheduled time.
  const existing = await ctx.repo.getDeadline(id);
  const input = deadline.validateInput(payload, existing ? new Date(existing.createdAt) : ctx.now);
  return response(ctx, await ctx.repo.createDeadline({ userKey: user._id, id, input, nowIso: ctx.nowIso }));
}
async function update(ctx, payload) {
  guard(ctx, payload);
  const ids = mutation(payload);
  const user = await ensureUser(ctx);
  const existing = await ctx.repo.getDeadline(ids.id);
  const replay = existing && existing.userKey === user._id && existing.lastMutation && existing.lastMutation.fromRevision === ids.revision;
  const input = deadline.validateInput(payload, replay ? new Date(existing.updatedAt) : ctx.now);
  return response(ctx, await ctx.repo.updateDeadline({ ...ids, userKey: user._id, input, nowIso: ctx.nowIso }));
}
async function remove(ctx, payload) {
  guard(ctx, payload);
  const ids = mutation(payload);
  const user = await ensureUser(ctx);
  await ctx.repo.removeDeadline({ ...ids, userKey: user._id, nowIso: ctx.nowIso });
  return { userKey: user._id, removed: true, id: ids.id };
}
async function authorize(ctx, payload) {
  guard(ctx, payload, true);
  const ids = mutation(payload);
  const ready = readiness(ctx);
  if (!ready.enabled) throw new ApiError('deadline_notifications_unavailable', '到期提醒的微信通知尚未开放，记录仍会保存');
  if (payload.templateId !== ready.templateId || !['accept', 'reject', 'ban'].includes(payload.result)) throw new ApiError('invalid_subscription_result', '请使用当前到期提醒模板完成微信授权');
  const user = await ensureUser(ctx);
  const item = await ctx.repo.authorizeDeadline({ ...ids, userKey: user._id, requestId: requestId(payload.requestId), templateId: ready.templateId,
    result: payload.result, nowIso: ctx.nowIso });
  return response(ctx, item);
}
module.exports = { list, create, update, remove, authorize };
