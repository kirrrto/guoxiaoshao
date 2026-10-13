'use strict';
const { createHash } = require('node:crypto');
const { COLLECTIONS: C } = require('../collections');
const { ApiError, isMissingCollectionError } = require('../errors');
const { dayKey } = require('../time');
const idOf = (userKey, requestId) => `test_${createHash('sha256').update(`${userKey}|${requestId}`).digest('hex')}`;
const snapshot = (record, user) => ({ record, balance: user.quota.balance, quotaRevision: Number.isInteger(user.quota.revision) ? user.quota.revision : 0 });

// Test records are durable idempotency barriers, kept outside the real outbox,
// stock history and their retention jobs. Never delete a possibly-sent barrier.
function notificationTestMethods(transaction, applyLedgerIn) {
  const run = body => transaction(body).catch(error => {
    if (isMissingCollectionError(error)) throw new ApiError('test_storage_unavailable', '测试通知服务尚未准备好，请稍后再试');
    throw error;
  });
  const read = async (tx, userKey, requestId, nowIso) => {
    const user = await tx.get(C.users, userKey);
    if (!user) throw new ApiError('user_missing', '用户不存在');
    const id = requestId ? idOf(userKey, requestId) : user.notificationTestLatestId;
    // Probe the collection even before the first authorization. No record is
    // created: a missing deployment must not appear ready to send a test.
    const found = await tx.get(C.notificationTests, id || '_notification_test_readiness');
    let record = id ? found : null;
    if (record && record.status === 'sending' && record.leaseUntil <= nowIso) {
      record = { ...record, status: 'uncertain', reason: 'worker_result_unknown' };
      await tx.put(C.notificationTests, record);
    }
    if (record && record.status === 'authorized' && Date.parse(nowIso) - Date.parse(record.createdAt) > 10 * 60000) {
      record = { ...record, status: 'needs_authorization', reason: 'authorization_expired' };
      await tx.put(C.notificationTests, record);
    }
    return { user, record };
  };
  return {
    getNotificationTest: args => run(async tx => {
      const { user, record } = await read(tx, args.userKey, args.requestId, args.nowIso);
      return snapshot(record, user);
    }),
    openNotificationTest: ({ userKey, requestId, nowIso, presented = false }) => run(async tx => {
      const { user, record } = await read(tx, userKey, requestId, nowIso);
      if (!record || record.charged !== 1 || !['sending', 'accepted', 'uncertain'].includes(record.status)
        || (presented ? record.firstPresentedAt : record.firstOpenedAt)) return snapshot(record, user);
      // 1.5.3 uses opened=true while loading; only the new presented protocol
      // confirms a visible render. Keep both signals distinct during rollout.
      const opened = { ...record, firstOpenedAt: record.firstOpenedAt || nowIso, ...(presented ? { firstPresentedAt: nowIso } : {}) };
      await tx.put(C.notificationTests, opened);
      return snapshot(opened, user);
    }),
    retireNotificationTestAuthorization: ({ userKey, requestId, nowIso }) => run(async tx => {
      const { user, record } = await read(tx, userKey, requestId, nowIso);
      if (!record || record.status !== 'authorized') return snapshot(record, user);
      const retired = { ...record, status: 'needs_authorization', reason: 'authorization_expired' };
      await tx.put(C.notificationTests, retired);
      return snapshot(retired, user);
    }),
    authorizeNotificationTest: ({ userKey, requestId, templateId, result, nowIso }) => run(async tx => {
      const { user, record: existing } = await read(tx, userKey, requestId, nowIso);
      if (existing) {
        if (existing.templateId !== templateId || existing.authorization !== result) throw new ApiError('test_id_conflict', '这次测试编号已用于其他授权，请查看原结果');
        return snapshot(existing, user);
      }
      const prior = user.notificationTestLatestId ? await tx.get(C.notificationTests, user.notificationTestLatestId) : null;
      if (prior && (prior.status === 'sending' || prior.status === 'uncertain' && !prior.feedback)) throw new ApiError('test_result_uncertain', '上一条测试结果尚未确认，请先查看并反馈原测试，暂不重复发送');
      const record = { _id: idOf(userKey, requestId), userKey, requestId, templateId, authorization: result,
        status: result === 'accept' ? 'authorized' : 'needs_authorization', createdAt: nowIso,
        charged: 0, refunded: 0, feedback: null, attempts: 0, reason: null };
      await tx.put(C.notificationTests, record);
      await tx.put(C.users, { ...user, notificationTestLatestId: record._id });
      return snapshot(record, user);
    }),
    beginNotificationTest: ({ userKey, requestId, templateId, ownerId, nowIso }) => run(async tx => {
      const { user, record } = await read(tx, userKey, requestId, nowIso);
      if (!record) throw new ApiError('test_not_found', '请先授权这次测试');
      if (record.status !== 'authorized') return { ...snapshot(record, user), acquired: false };
      if (record.templateId !== templateId) {
        const retired = { ...record, status: 'needs_authorization', reason: 'authorization_expired' };
        await tx.put(C.notificationTests, retired);
        return { ...snapshot(retired, user), acquired: false };
      }
      // Different native authorizations may already exist on two devices.
      // Check the send barrier at debit time as well as authorization time.
      const activeId = user.notificationTestSendingId || user.notificationTestLatestId;
      const active = activeId && activeId !== record._id ? await tx.get(C.notificationTests, activeId) : null;
      if (active && (active.status === 'sending' || active.status === 'uncertain' && !active.feedback)) {
        throw new ApiError('test_result_uncertain', '上一条测试结果尚未确认，请先查看并反馈原测试，暂不重复发送');
      }
      if (!Number.isInteger(user.quota.balance) || user.quota.balance < 1) throw new ApiError('insufficient_credits', '测试需要 1 次签到或任务获得的次数，请先获取次数');
      const charged = await applyLedgerIn(tx, { _id: `${userKey}|notification_test|${requestId}|debit`, userKey,
        type: 'notification_test_debit', delta: -1, testRequestId: requestId, refId: requestId, dayKey: dayKey(nowIso), createdAt: nowIso });
      const sending = { ...record, status: 'sending', charged: 1, ownerId, attempts: 1,
        leaseUntil: new Date(Date.parse(nowIso) + 60000).toISOString(), sendStartedAt: nowIso };
      await tx.put(C.notificationTests, sending);
      await tx.put(C.users, { ...charged.user, notificationTestLatestId: record._id, notificationTestSendingId: record._id });
      return { ...snapshot(sending, charged.user), acquired: true };
    }),
    finishNotificationTest: ({ userKey, requestId, ownerId, status, reason, nowIso }) => run(async tx => {
      const { user, record } = await read(tx, userKey, requestId, nowIso);
      if (!record) throw new ApiError('test_not_found', '测试记录不存在');
      if (!['sending', 'uncertain'].includes(record.status) || record.ownerId !== ownerId) return snapshot(record, user);
      let currentUser = user;
      if (status === 'failed' && record.charged === 1) {
        currentUser = (await applyLedgerIn(tx, { _id: `${userKey}|notification_test|${requestId}|refund`, userKey,
          type: 'notification_test_refund', delta: 1, testRequestId: requestId, refId: requestId, dayKey: dayKey(nowIso), createdAt: nowIso })).user;
      }
      const finished = { ...record, status, reason, settledAt: nowIso, refunded: status === 'failed' ? record.charged : 0 };
      await tx.put(C.notificationTests, finished);
      return snapshot(finished, currentUser);
    }),
    feedbackNotificationTest: ({ userKey, requestId, outcome, nowIso }) => run(async tx => {
      const { user, record } = await read(tx, userKey, requestId, nowIso);
      if (!record || !['accepted', 'uncertain'].includes(record.status)) throw new ApiError('test_feedback_unavailable', '这次测试暂不需要收件反馈');
      const updated = { ...record, feedback: { outcome, updatedAt: nowIso } };
      await tx.put(C.notificationTests, updated);
      return snapshot(updated, user);
    }),
  };
}
module.exports = { notificationTestMethods, idOf };
