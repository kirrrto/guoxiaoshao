'use strict';
const { COLLECTIONS: C } = require('../collections');
const { ApiError } = require('../errors');
const { mergeConfig } = require('../config');
const { activeDnd } = require('../rules/dnd');
const { LIMIT, fingerprint, indexId, authorizationId, capability } = require('../deadline');

function owned(record, userKey, includeRemoved = false) {
  if (!record || record.userKey !== userKey || (!includeRemoved && record.status === 'removed')) throw new ApiError('deadline_not_found', '这条到期提醒不存在');
}
function mutable(record, revision, nowIso) {
  if (record.revision !== revision) throw new ApiError('deadline_revision_conflict', '提醒已变化，请刷新后重试');
  if (record.delivery.status === 'sending' && record.leaseUntil > nowIso) throw new ApiError('deadline_sending', '提醒正在发送，请稍后查看结果再修改');
}
function pendingReason(record, user, config, nowIso, appid) {
  const ready = capability(config);
  if (!ready.enabled) return ready.reason;
  if (!record.authorization || record.authorization.templateId !== ready.templateId || record.authorization.revision !== record.revision) return 'template_changed';
  if (!user || !user.openid || user.appid !== appid || user.appid !== config.notifications.consumerAppId) return 'account_unavailable';
  if (Date.parse(record.dueAt) < Date.parse(nowIso)) return 'deadline_passed';
  if (user.settings && user.settings.notifyEnabled === false) return 'user_disabled';
  if (activeDnd(user.settings && user.settings.dnd, nowIso)) return 'dnd';
  return null;
}
function blocked(record, reason, nowIso) {
  const deferred = ['dnd', 'user_disabled', 'notifications_disabled'].includes(reason);
  return { ...record, scheduleState: deferred ? 'pending' : 'idle', ownerId: null, leaseUntil: null,
    nextAttemptAt: deferred ? new Date(Date.parse(nowIso) + 300000).toISOString() : null,
    delivery: { ...record.delivery, status: reason === 'deadline_passed' ? 'missed' : deferred ? 'scheduled' : 'awaiting_authorization', reason } };
}
function deadlineMethods(run) {
  return {
    createDeadline: ({ userKey, id, input, nowIso }) => run(async tx => {
      const existing = await tx.get(C.deadlines, id);
      const signature = fingerprint(input);
      if (existing) {
        owned(existing, userKey);
        if (existing.createSignature !== signature) throw new ApiError('deadline_request_conflict', '这个操作编号已用于另一条提醒，请刷新后重试');
        return existing;
      }
      const index = await tx.get(C.config, indexId(userKey)) || { _id: indexId(userKey), kind: 'deadline_index', userKey, ids: [] };
      if (index.ids.length >= LIMIT) throw new ApiError('deadline_limit', `试验期间最多保存 ${LIMIT} 条到期提醒，请先删除不用的记录`);
      const record = { _id: id, userKey, ...input, revision: 1, status: 'active', scheduleState: 'idle',
        createdAt: nowIso, updatedAt: nowIso, createSignature: signature, authorization: null,
        delivery: { status: 'awaiting_authorization', reason: null } };
      await tx.put(C.deadlines, record);
      await tx.put(C.config, { ...index, ids: [...index.ids, id] });
      return record;
    }),
    updateDeadline: ({ userKey, id, revision, input, nowIso }) => run(async tx => {
      const record = await tx.get(C.deadlines, id);
      owned(record, userKey);
      const signature = fingerprint(input);
      if (record.lastMutation && record.lastMutation.fromRevision === revision && record.lastMutation.signature === signature) return record;
      mutable(record, revision, nowIso);
      const updated = { ...record, ...input, revision: record.revision + 1, updatedAt: nowIso,
        authorization: null, scheduleState: 'idle', nextAttemptAt: null, ownerId: null, leaseUntil: null,
        lastMutation: { fromRevision: revision, signature }, delivery: { status: 'awaiting_authorization', reason: null } };
      await tx.put(C.deadlines, updated);
      return updated;
    }),
    removeDeadline: ({ userKey, id, revision, nowIso }) => run(async tx => {
      const record = await tx.get(C.deadlines, id);
      owned(record, userKey, true);
      if (record.status === 'removed') return record;
      mutable(record, revision, nowIso);
      const index = await tx.get(C.config, indexId(userKey));
      if (index) await tx.put(C.config, { ...index, ids: index.ids.filter(value => value !== id) });
      // Retain only a minimal idempotency tombstone, not the user's deleted title/date.
      const removed = { _id: id, userKey, status: 'removed', scheduleState: 'idle', revision: record.revision + 1, removedAt: nowIso };
      await tx.put(C.deadlines, removed);
      return removed;
    }),
    authorizeDeadline: ({ userKey, id, revision, requestId, templateId, result, nowIso }) => run(async tx => {
      const record = await tx.get(C.deadlines, id);
      owned(record, userKey);
      const receiptId = authorizationId(userKey, requestId);
      const signature = fingerprint([id, revision, templateId, result]);
      const receipt = await tx.get(C.config, receiptId);
      if (receipt) {
        if (receipt.signature !== signature) throw new ApiError('deadline_request_conflict', '这个授权编号已被使用，请刷新后重试');
        if (record.revision !== revision) throw new ApiError('deadline_revision_conflict', '提醒已修改，请重新授权');
        return record;
      }
      mutable(record, revision, nowIso);
      if (['accepted', 'uncertain', 'sending'].includes(record.delivery.status)) throw new ApiError('deadline_already_attempted', '这次提醒已尝试发送，请先查看结果；需要新的提醒请修改日期后保存');
      if (Date.parse(record.remindAt) <= Date.parse(nowIso)) throw new ApiError('deadline_time_passed', '提醒时间已过，请调整日期或时间后再授权');
      const ready = capability(mergeConfig(await tx.get(C.config, 'runtime')));
      if (!ready.enabled || ready.templateId !== templateId) throw new ApiError('deadline_notifications_unavailable', '到期提醒的微信通知配置已变化，请刷新后重试');
      const accepted = result === 'accept';
      // Declining a new prompt does not revoke an earlier accepted authorization.
      const keepAuthorization = !accepted && record.authorization && record.authorization.templateId === templateId
        && record.authorization.revision === revision;
      const updated = keepAuthorization ? record : { ...record, authorization: accepted ? { templateId, revision, requestId, acceptedAt: nowIso } : null,
        scheduleState: accepted ? 'pending' : 'idle', nextAttemptAt: accepted ? record.remindAt : null,
        delivery: { status: accepted ? 'scheduled' : 'awaiting_authorization', reason: accepted ? null : result === 'ban' ? 'authorization_banned' : 'authorization_rejected' } };
      if (!keepAuthorization) await tx.put(C.deadlines, updated);
      await tx.put(C.config, { _id: receiptId, kind: 'deadline_authorization', userKey, signature, createdAt: nowIso });
      return updated;
    }),
    claimDeadline: ({ id, ownerId, nowIso, appid }) => run(async tx => {
      const record = await tx.get(C.deadlines, id);
      if (!record || record.status !== 'active' || record.scheduleState !== 'pending' || record.nextAttemptAt > nowIso) return { claimed: false };
      const user = await tx.get(C.users, record.userKey);
      const config = mergeConfig(await tx.get(C.config, 'runtime'));
      const reason = pendingReason(record, user, config, nowIso, appid);
      if (reason) { await tx.put(C.deadlines, blocked(record, reason, nowIso)); return { claimed: false, reason }; }
      const claimed = { ...record, scheduleState: 'sending', ownerId, leaseUntil: new Date(Date.parse(nowIso) + 60000).toISOString(),
        delivery: { status: 'sending', reason: null, attemptedAt: nowIso } };
      await tx.put(C.deadlines, claimed);
      return { claimed: true, record: claimed };
    }),
    verifyDeadlineSend: ({ id, ownerId, revision, nowIso, appid }) => run(async tx => {
      const record = await tx.get(C.deadlines, id);
      if (!record || record.status !== 'active' || record.scheduleState !== 'sending' || record.ownerId !== ownerId || record.revision !== revision || record.leaseUntil <= nowIso) return { ready: false };
      const user = await tx.get(C.users, record.userKey);
      const config = mergeConfig(await tx.get(C.config, 'runtime'));
      const reason = pendingReason(record, user, config, nowIso, appid);
      if (reason) { await tx.put(C.deadlines, blocked(record, reason, nowIso)); return { ready: false, reason }; }
      return { ready: true, record, user, config };
    }),
    finishDeadline: ({ id, ownerId, revision, outcome, nowIso }) => run(async tx => {
      const record = await tx.get(C.deadlines, id);
      if (!record || record.scheduleState !== 'sending' || record.ownerId !== ownerId || record.revision !== revision) return false;
      await tx.put(C.deadlines, { ...record, scheduleState: 'idle', ownerId: null, leaseUntil: null,
        delivery: { ...record.delivery, ...outcome, acceptedAt: outcome.status === 'accepted' ? nowIso : null } });
      return true;
    }),
    reconcileDeadline: ({ id, nowIso }) => run(async tx => {
      const record = await tx.get(C.deadlines, id);
      if (!record || record.scheduleState !== 'sending' || record.leaseUntil > nowIso) return false;
      await tx.put(C.deadlines, { ...record, scheduleState: 'idle', ownerId: null, leaseUntil: null,
        delivery: { ...record.delivery, status: 'uncertain', reason: 'worker_interrupted' } });
      return true;
    }),
  };
}
module.exports = { deadlineMethods };
