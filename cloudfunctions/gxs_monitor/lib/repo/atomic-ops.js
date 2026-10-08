'use strict';
// Shared transaction bodies. Both adapters must serialize read/modify/write and
// roll back every write if the callback fails; services never emulate a transaction.
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { COLLECTIONS: C } = require('../collections');
const { ApiError } = require('../errors');
const { dayKey } = require('../time');
const { decideLiveQuery, decideHistoryQuery } = require('../rules/access');
const { grantableAmount, ledgerIds } = require('../rules/quota');
const { isMember, hasFreeReminder, canUseReminders, validateFollowLimits, memberLimits, accountLimits, followAllowance } = require('../rules/membership');
const { purchasedPlan, needsPlanMetadata, resolvePlanMetadata } = require('../rules/member-plan');
const membershipEntitlements = require('../rules/membership-entitlements');
const { applyObservation, targetKeyOf } = require('../engine/events');
const { observationDayId, appendObservationDay } = require('../engine/observation-day');
const { viewId, newView, decodeToken } = require('../notification-view');
const { mergeConfig, patchConfig } = require('../config');
const { assertConfigEditor, makeConfigAudit } = require('../config-audit');
const { CAMPAIGN, MAX_FAILURES, LOCK_MS, CLAIMS_ID, matchesCodeHash, attemptsId } = require('../member-redemption');
const { upstreamGuardMethods, reserveAccountQuery, releaseAccountQuery } = require('./upstream-guard');
const { queryTargetMethods } = require('./query-target');
const { notificationTestMethods } = require('./notification-test');
const { memberRecordMethods } = require('./member-records');
const subscriptionCredits = require('./subscription-credit-ledger');
const { matchesNotificationTarget, nextFollowUpdatedAt } = require('../notification-target');

const quotaBalance = user => ({ balance: user.quota.balance,
  quotaRevision: Number.isInteger(user.quota.revision) ? user.quota.revision : 0 });

async function hydrateMemberPlansIn(tx, user) {
  if (!needsPlanMetadata(user)) return false;
  user.membership = (await resolvePlanMetadata(user, id => tx.get(C.orders, id))).membership;
  return true;
}

async function applyLedgerIn(tx, entry) {
  const user = await tx.get(C.users, entry.userKey);
  if (!user) throw new ApiError('user_missing', '用户不存在');
  const existing = await tx.get(C.ledger, entry._id);
  if (existing) {
    if (existing.userKey !== entry.userKey || existing.type !== entry.type || existing.delta !== entry.delta || (entry.partNumber && existing.partNumber && entry.partNumber !== existing.partNumber)) throw new ApiError('ledger_id_conflict', '该操作编号已用于不同的次数变更');
    return { applied: false, entry: existing, balance: user.quota.balance, user };
  }
  const before = Number.isInteger(user.quota && user.quota.balance) ? user.quota.balance : 0;
  const after = before + entry.delta;
  if (!Number.isInteger(entry.delta) || after < 0) throw new ApiError('insufficient_credits', '次数不足');
  const stored = { ...entry, balanceBefore: before, balanceAfter: after };
  user.quota = { ...user.quota, balance: after, revision: (Number.isInteger(user.quota.revision) ? user.quota.revision : 0) + 1, updatedAt: entry.createdAt };
  // Any reward ledger writer invalidates the cached daily summary first.
  // grantReward restores a complete summary in this same transaction.
  if (entry.delta > 0 && !['query_refund', 'notification_test_refund', 'admin_grant'].includes(entry.type)) user.quota.dailyRewardSnapshot = null;
  await tx.put(C.ledger, stored);
  await tx.put(C.users, user);
  return { applied: true, entry: stored, balance: after, user };
}

async function fulfilMembershipIn(tx, user, order, source, nowIso) {
  if (order.fulfilledAt || order.entitlementFulfilled === true || order.status === 'fulfilled') return { order, applied: false, expiresAt: user.membership && user.membership.expiresAt };
  if (order.status === 'refunded') throw new ApiError('order_refunded', '订单已全额退款，不能再发放会员');
  if (order.status !== 'paid' && !(order.status === 'partially_refunded' && Number.isFinite(Date.parse(order.paidAt)))) throw new ApiError('order_not_paid', '订单尚未确认支付');
  const refundFen = order.refundFen || 0;
  const refundedMs = refundFen ? membershipEntitlements.refundDurationMs(order, refundFen) : 0;
  const grantedMs = membershipEntitlements.durationMs(order) - refundedMs;
  if (grantedMs <= 0) throw new ApiError('order_refunded', '订单已全额退款，不能再发放会员');
  await hydrateMemberPlansIn(tx, user);
  const planId = source === 'virtual_payment' ? purchasedPlan(order, user, true) : null;
  user.membership = { ...membershipEntitlements.grant(user.membership || {}, { orderId: order._id, source, milliseconds: grantedMs, nowIso, planId }), lastOrderId: order.orderId };
  user.membership.entitlements.planMetadataVersion = 1;
  const expiresAt = user.membership.expiresAt;
  const fulfilled = { ...order, status: refundFen > 0 ? 'partially_refunded' : 'fulfilled', fulfilledAt: user.membership.entitlements.settledAt, entitlementFulfilled: true, entitlementGrantedMs: grantedMs, entitlementSourceId: order._id };
  await tx.put(C.users, user);
  await tx.put(C.orders, fulfilled);
  return { order: fulfilled, applied: true, expiresAt };
}

async function refundMembershipIn(tx, { orderId, nowIso, refundFen, providerData }) {
  const order = await tx.get(C.orders, orderId);
  if (!order) throw new ApiError('unknown_order', '订单不存在');
  if (!['created', 'paid', 'fulfilled', 'partially_refunded', 'refunded'].includes(order.status)) throw new ApiError('invalid_order_status', '当前订单无法确认退款');
  // refundFen is the provider-confirmed cumulative amount, never a callback's
  // individual refund delta. Omission retains the legacy full-refund contract.
  const cumulative = refundFen === undefined ? order.amountFen : refundFen;
  const targetMs = membershipEntitlements.refundDurationMs(order, cumulative);
  const previousFen = order.refundFen || (order.status === 'refunded' ? order.amountFen : 0);
  if (cumulative <= previousFen) return { order, applied: false, revokedMs: 0 };
  const previousMs = membershipEntitlements.refundDurationMs(order, previousFen);
  const user = await tx.get(C.users, order.userKey);
  // Old fulfilled orders may lack fulfilledAt. Preserve that fact when status
  // becomes partially_refunded without fabricating a historical timestamp.
  const wasFulfilled = Boolean(order.fulfilledAt || order.entitlementFulfilled === true || order.status === 'fulfilled');
  if (!user && wasFulfilled) throw new ApiError('user_missing', '用户不存在');
  let removedMs = 0;
  if (user) {
    const result = membershipEntitlements.revoke(user.membership || {}, { orderId: order._id, milliseconds: targetMs - previousMs, nowIso });
    user.membership = result.membership;
    removedMs = result.removedMs;
    await tx.put(C.users, user);
  }
  const complete = cumulative === order.amountFen;
  const refunded = { ...order, status: complete ? 'refunded' : 'partially_refunded', refundFen: cumulative,
    refundedAt: complete ? nowIso : order.refundedAt || null, refundUpdatedAt: nowIso, refund: providerData || null,
    entitlementFulfilled: wasFulfilled, entitlementRefundTargetMs: targetMs, entitlementRevokedMs: (order.entitlementRevokedMs || 0) + removedMs };
  await tx.put(C.orders, refunded);
  return { order: refunded, applied: true, revokedMs: removedMs, expiresAt: user && user.membership.expiresAt };
}

function atomicMethods(run) {
  return {
    ensureMemberPlanMetadata: ({ userKey }) => run(async tx => {
      const user = await tx.get(C.users, userKey);
      if (user && await hydrateMemberPlansIn(tx, user)) await tx.put(C.users, user);
      return user;
    }),
    ...notificationTestMethods(run, applyLedgerIn),
    ...memberRecordMethods(run),
    acquireLease: ({ id, ownerId, now, expiresAt }) => run(async tx => {
      const current = await tx.get(C.config, id);
      if (current && current.ownerId !== ownerId && current.expiresAt > now) return { acquired: false, holder: current.ownerId, expiresAt: current.expiresAt };
      await tx.put(C.config, { _id: id, ownerId, expiresAt, renewedAt: now, acquiredAt: current && current.ownerId === ownerId ? current.acquiredAt : now });
      return { acquired: true, holder: ownerId, expiresAt };
    }),
    saveCollectorStatus: (status, collectorLease) => run(async tx => {
      if (collectorLease) {
        const lease = await tx.get(C.config, 'collector_lease');
        if (!lease || lease.ownerId !== collectorLease.ownerId || lease.expiresAt <= collectorLease.nowIso) return { saved: false, reason: 'lease_lost' };
      }
      await tx.put(C.config, { ...status, _id: 'collector_status' });
      return { saved: true };
    }),
    patchRuntimeConfig: ({ patch, expectedRevision, updatedAt, actor, requestId, auditId = randomUUID() }) => run(async tx => {
      // Merge after acquiring the transaction snapshot; concurrent unrelated
      // edits must not restore a stale enabled flag or overwrite sibling fields.
      const stored = await tx.get(C.config, 'runtime') || {};
      // Revocation must also win against requests authorized before this snapshot.
      assertConfigEditor(stored, patch, actor, 'admin.updateConfig.transaction');
      const currentRevision = Number.isSafeInteger(stored.configRevision) && stored.configRevision >= 0 ? stored.configRevision : 0;
      // Only trusted server operators retain compatibility with older scripts.
      // Client administrators must not bypass this guard by using an old editor.
      if (expectedRevision === undefined && actor.isOperator !== true) throw new ApiError('config_revision_required', '运营页面版本过旧或未加载配置，请更新运营小程序并重新加载最新配置后再保存。');
      if (expectedRevision !== undefined) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ApiError('invalid_config_revision', '配置版本无效，请先重新加载最新配置');
        if (expectedRevision !== currentRevision) throw new ApiError('config_revision_conflict', '配置已被其他管理员更新，请先重新加载最新配置后再合并修改；当前编辑内容已保留。');
      }
      const revision = currentRevision + 1;
      const next = { ...patchConfig(stored, patch), _id: 'runtime', updatedAt, updatedBy: actor.userKey || 'operator', configRevision: revision };
      const audit = makeConfigAudit({ auditId, before: stored, after: next, patch, actor, updatedAt, requestId, revision });
      if (await tx.get(C.config, audit._id)) throw new ApiError('config_audit_conflict', '配置审计编号已存在，请重新发起操作');
      await tx.put(C.config, next);
      await tx.put(C.config, audit);
      return { config: mergeConfig(next), revision };
    }),

    getNotificationView: userKey => run(async tx => {
      let view = await tx.get(C.config, viewId(userKey));
      if (!view) { view = newView(userKey); await tx.put(C.config, view); }
      return view;
    }),

    saveNotification: notification => run(async tx => {
      if (await tx.get(C.notifications, notification._id)) return false;
      if (typeof notification.userKey !== 'string' || !notification.userKey) throw new ApiError('invalid_notification', '提醒缺少用户身份');
      const view = await tx.get(C.config, viewId(notification.userKey)) || newView(notification.userKey);
      view.lastSequence += 1;
      await tx.put(C.config, view);
      // Sequence belongs to insertion, not the event's timestamp. A delayed
      // task or one inserted in the same millisecond as clear remains visible.
      await tx.put(C.notifications, { ...notification, viewSequence: view.lastSequence });
      return true;
    }),

    hideNotification: ({ userKey, id, nowIso }) => run(async tx => {
      const task = await tx.get(C.notifications, id);
      if (!task || task.userKey !== userKey) throw new ApiError('notification_not_found', '提醒不存在或不属于当前账号');
      if (!task.userHiddenAt) await tx.put(C.notifications, { ...task, userHiddenAt: nowIso });
      return { deleted: true };
    }),

    clearNotificationView: ({ userKey, before, nowIso }) => run(async tx => {
      const view = await tx.get(C.config, viewId(userKey));
      if (!view || view.userKey !== userKey) throw new ApiError('invalid_clear_before', '请刷新提醒列表后重试');
      const cutoff = decodeToken(before, 'clear', view, nowIso);
      const sequence = Math.max(view.clearedThroughSequence || 0, cutoff.sequence);
      const legacy = !view.legacyClearBefore || view.legacyClearBefore < cutoff.at ? cutoff.at : view.legacyClearBefore;
      if (sequence !== view.clearedThroughSequence || legacy !== view.legacyClearBefore) await tx.put(C.config, { ...view, clearedThroughSequence: sequence, legacyClearBefore: legacy, clearedAt: nowIso });
      return { cleared: true, before };
    }),

    updateUserSettings: (userKey, patch) => run(async tx => {
      const user = await tx.get(C.users, userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      user.settings = { ...user.settings, ...patch };
      await tx.put(C.users, user);
      return user.settings;
    }),

    applyLedger: entry => run(async tx => {
      const { user, ...result } = await applyLedgerIn(tx, entry);
      return result;
    }),

    recordHistoryBrowse: ({ userKey, nowIso }) => run(async tx => {
      const user = await tx.get(C.users, userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      const previous = user.taskEvidence && user.taskEvidence.history_browse;
      const today = dayKey(nowIso);
      if (!previous || previous.dayKey < today) {
        user.taskEvidence = { ...user.taskEvidence, history_browse: { dayKey: today, completedAt: nowIso } };
        // Browsed-but-capped is also visible quota state. Version this marker so
        // an older zero-grant response cannot erase the completed browse label.
        user.quota = { ...user.quota, revision: (Number.isInteger(user.quota.revision) ? user.quota.revision : 0) + 1 };
        await tx.put(C.users, user);
      }
      return { dayKey: today };
    }),

    grantReward: args => run(async tx => {
      const { entry, config, reward, grantedToday = 0 } = args;
      const user = await tx.get(C.users, entry.userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      const existing = await tx.get(C.ledger, entry._id);
      if (existing) return { applied: false, amount: 0, reason: 'already_completed', balance: user.quota.balance };
      if (entry.type === 'task_reward') {
        const evidence = args.evidenceQueryId ? await tx.get(C.queries, args.evidenceQueryId) : null;
        const browse = user.taskEvidence && user.taskEvidence.history_browse;
        const browsed = args.evidenceBrowseDay === entry.dayKey && browse && browse.dayKey === entry.dayKey && Number.isFinite(Date.parse(browse.completedAt)) && dayKey(browse.completedAt) === entry.dayKey;
        const queried = evidence && evidence.userKey === entry.userKey && evidence.kind === 'history' && evidence.status === 'success' && evidence.response && evidence.response.ok === true && Number.isFinite(Date.parse(evidence.finishedAt)) && dayKey(evidence.finishedAt) === entry.dayKey;
        if (entry.taskId !== 'view_history' || (!browsed && !queried)) throw new ApiError('task_not_completed', '请先打开历史页并完成加载');
      }
      if (reward === 0) return { applied: false, amount: 0, reason: 'reward_disabled', balance: user.quota.balance };
      const tracked = user.quota.rewardDay === entry.dayKey ? user.quota.grantedToday || 0 : 0;
      const persistedSummary = user.quota.dailyRewardSnapshot;
      const summaries = [persistedSummary, args.rewardSnapshot].filter(s => s && s.dayKey === entry.dayKey);
      const total = Math.max(tracked, grantedToday, ...summaries.map(s => s.grantedToday || 0));
      const amount = grantableAmount({ balance: user.quota.balance, grantedToday: total, reward }, config);
      if (!amount) return { applied: false, amount: 0, reason: total >= config.dailyGrantCap ? 'daily_cap_reached' : 'balance_cap_reached', balance: user.quota.balance };
      const result = await applyLedgerIn(tx, { ...entry, delta: amount });
      result.user.quota = { ...result.user.quota, rewardDay: entry.dayKey, grantedToday: total + amount };
      const summary = { version: 1, dayKey: entry.dayKey, grantedToday: total + amount,
        signedInToday: entry.type === 'signin_reward' || summaries.some(s => s.signedInToday),
        tasksDoneToday: [...new Set([...summaries.flatMap(s => s.tasksDoneToday || []), ...(entry.type === 'task_reward' ? [entry.taskId] : [])])],
      };
      // Never replace a newer day's cache with a request begun before midnight.
      result.user.quota.dailyRewardSnapshot = persistedSummary && persistedSummary.dayKey > entry.dayKey ? persistedSummary : summary;
      await tx.put(C.users, result.user);
      return { applied: true, amount, reason: null, balance: result.balance };
    }),

    beginQuery: args => run(async tx => {
      const { record, product, config, ownerId, nowIso, leaseMs = 25000 } = args;
      let user = await tx.get(C.users, record.userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      const existing = await tx.get(C.queries, record._id);
      if (existing) {
        // Legacy records are bound by their actual request fields as well.
        const signature = q => JSON.stringify([q.kind, q.partNumber, [...q.storeNumbers].sort(), q.kind === 'history' ? q.dayKey : null]);
        if (signature(existing) !== signature(record)) throw new ApiError('query_id_conflict', '该查询编号已用于其他条件，请重新查询');
        if (existing.status !== 'pending' && existing.response) return { replayed: true, record: existing, ...quotaBalance(user) };
        if (existing.leaseUntil && existing.leaseUntil > nowIso) return { busy: true, record: existing, retryAfterMs: Date.parse(existing.leaseUntil) - Date.parse(nowIso), ...quotaBalance(user) };
        // A crashed worker is fenced out. Its debit belongs to this same request;
        // recovery is allowed even when the debit used the user's last credit.
        const resumed = { ...existing, status: 'pending', ownerId, leaseUntil: new Date(Date.parse(nowIso) + leaseMs).toISOString(), attempts: (existing.attempts || 1) + 1 };
        const guarded = await reserveAccountQuery(tx, { record, ownerId, nowIso, leaseMs, config });
        // Admission can delay recovery but cannot settle the debit already
        // attached to this ID. Keep clients on the original pending intent.
        if (guarded) return { busy: true, record: existing, retryAfterMs: guarded.retryAfterMs,
          guardReason: guarded.reason, ...quotaBalance(user) };
        await tx.put(C.queries, resumed);
        return { record: resumed, ...quotaBalance(user), recovered: true };
      }
      if (record.kind === 'live') {
        if (await hydrateMemberPlansIn(tx, user)) await tx.put(C.users, user);
        const maxStores = accountLimits(user, new Date(nowIso), config).queryMaxStores;
        if (record.storeNumbers.length > maxStores) throw new ApiError('too_many_stores', `单次最多查询 ${maxStores} 家门店`);
      }
      const decision = record.kind === 'history'
        ? decideHistoryQuery({ user, product, requestedDayKey: record.dayKey, now: new Date(nowIso), config })
        : decideLiveQuery({ user, product, now: new Date(nowIso), config });
      if (!decision.allowed) return { denied: decision, ...quotaBalance(user) };
      const guarded = await reserveAccountQuery(tx, { record, ownerId, nowIso, leaseMs, config });
      if (guarded) return { denied: guarded, ...quotaBalance(user) };
      if (decision.cost > 0) {
        const id = record.kind === 'history' ? ledgerIds.historyDebit(user._id, record.queryId) : ledgerIds.queryDebit(user._id, record.queryId);
        user = (await applyLedgerIn(tx, { _id: id, userKey: user._id, type: record.kind === 'history' ? 'history_debit' : 'query_debit', delta: -decision.cost, dayKey: dayKey(nowIso), createdAt: nowIso, refId: record.queryId, partNumber: record.partNumber })).user;
      }
      const pending = { ...record, charged: decision.cost, member: decision.member, status: 'pending', ownerId, leaseUntil: new Date(Date.parse(nowIso) + leaseMs).toISOString(), attempts: 1, createdAt: nowIso, finishedAt: null, response: null };
      await tx.put(C.queries, pending);
      return { record: pending, ...quotaBalance(user) };
    }),

    finishQuery: args => run(async tx => {
      const { id, ownerId, response, refund, nowIso } = args;
      const record = await tx.get(C.queries, id);
      if (!record) throw new ApiError('unknown_query', '查询记录不存在');
      if (record.status !== 'pending') return { completed: false, record, response: record.response && {
        ...record.response, quotaRevision: Number.isInteger(record.response.quotaRevision) ? record.response.quotaRevision : 0 } };
      if (record.ownerId !== ownerId) return { completed: false, stale: true, record };
      await releaseAccountQuery(tx, record, ownerId, nowIso);
      let user = await tx.get(C.users, record.userKey);
      let refunded = 0;
      if (refund && record.charged > 0) {
        const result = await applyLedgerIn(tx, { _id: `${record.userKey}|${record.kind === 'history' ? 'history' : 'query'}|${record.queryId}|refund`, userKey: record.userKey, type: 'query_refund', delta: record.charged, dayKey: dayKey(nowIso), createdAt: nowIso, refId: record.queryId });
        user = result.user;
        refunded = record.charged;
      }
      const final = { ...response, charged: record.charged, refunded, ...quotaBalance(user), member: record.member,
        ...(record.kind === 'live' ? { finishedAt: nowIso,
          alternativesExpiresAt: response.ok && (record.member || record.charged > refunded) ? new Date(Date.parse(nowIso) + 120000).toISOString() : null } : {}) };
      const completed = { ...record, status: final.ok ? 'success' : 'failed', response: final, finishedAt: nowIso, leaseUntil: null };
      if (completed.kind === 'history' && completed.status === 'success') {
        const previous = user.taskEvidence && user.taskEvidence.view_history;
        if (!previous || previous.completedAt <= nowIso) {
          user.taskEvidence = { ...user.taskEvidence, view_history: { queryId: id, dayKey: dayKey(nowIso), completedAt: nowIso } };
          await tx.put(C.users, user);
        }
      }
      await tx.put(C.queries, completed);
      return { completed: true, record: completed, response: final };
    }),

    expireQuery: ({ id, userKey, nowIso, staleBefore }) => run(async tx => {
      const record = await tx.get(C.queries, id);
      if (!record || record.userKey !== userKey || record.status !== 'pending' || !record.leaseUntil || record.leaseUntil > staleBefore) return { expired: false };
      let user = await tx.get(C.users, userKey);
      let refunded = 0;
      if (record.charged > 0) {
        const result = await applyLedgerIn(tx, { _id: `${userKey}|${record.kind === 'history' ? 'history' : 'query'}|${record.queryId}|refund`, userKey, type: 'query_refund', delta: record.charged, dayKey: dayKey(nowIso), createdAt: nowIso, refId: record.queryId });
        user = result.user;
        refunded = record.charged;
      }
      const response = { ok: false, reason: 'query_expired', queryId: record.queryId, historyQueryId: record.kind === 'history' ? record.queryId : null, results: [], events: [], latest: [], charged: record.charged, refunded, ...quotaBalance(user), member: record.member, queriedAt: record.createdAt };
      await tx.put(C.queries, { ...record, status: 'failed', finishedAt: nowIso, leaseUntil: null, response });
      return { expired: true, refunded, ...quotaBalance(user) };
    }),

    recordObservation: ({ observation, continuityGapMs, collectorLease, queryTargetLease, nowIso }) => run(async tx => {
      if (collectorLease) {
        const lease = await tx.get(C.config, 'collector_lease');
        if (!lease || lease.ownerId !== collectorLease.ownerId || lease.expiresAt <= collectorLease.nowIso) throw new ApiError('collector_lease_lost', '采集执行权已转移');
      }
      if (queryTargetLease) {
        const lease = await tx.get(C.config, queryTargetLease.id);
        if (!lease || lease.ownerId !== queryTargetLease.ownerId || lease.leaseUntil <= Date.parse(queryTargetLease.nowIso)) throw new ApiError('query_target_lease_lost', '该目标由新的查询更新中');
      }
      const previous = await tx.get(C.latest, targetKeyOf(observation.storeNumber, observation.partNumber));
      const result = applyObservation(previous, observation, {
        ...(Number.isFinite(continuityGapMs) ? { continuityGapMs } : {}),
        ...(Number.isFinite(Date.parse(nowIso)) ? { nowMs: Date.parse(nowIso) } : {}),
      });
      if (result.outcome !== 'stale' && result.outcome !== 'duplicate') {
        const summaryId = observationDayId(observation.storeNumber, observation.partNumber, dayKey(observation.observedAt));
        const previousDay = await tx.get(C.observationDays, summaryId);
        await tx.put(C.latest, result.latest);
        for (const event of result.events) await tx.put(C.events, { ...event, dayKey: dayKey(event.detectedAt), notificationPlannedAt: null });
        await tx.put(C.observationDays, appendObservationDay(previousDay, observation, result.events));
      }
      return { ...result, observation };
    }),

    mutateFollow: args => run(async tx => {
      const { userKey, follow, followId, status, nowIso, knownFollows = [] } = args;
      const user = await tx.get(C.users, userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      await hydrateMemberPlansIn(tx, user);
      const id = follow ? follow._id : followId;
      const existing = await tx.get(C.follows, id);
      const knownIndex = [...new Map([...knownFollows, ...(user.followIndex || [])].map(f => [f._id, f])).values()];
      const at = new Date(nowIso);
      const limits = memberLimits(user, at);
      const savedFollows = (await Promise.all(knownIndex.map(item => tx.get(C.follows, item._id))))
        .filter(f => f && f.userKey === userKey && f.status !== 'removed');
      const index = savedFollows.map(f => ({ _id: f._id, partNumber: f.partNumber, status: f.status, createdAt: f.createdAt }));
      if ((follow || status === 'active') && !canUseReminders(user, at)) throw new ApiError('member_required', '关注与到货提醒为会员专属，开通会员后可新增或恢复关注');
      let next;
      if (follow) {
        if (existing && existing.status !== 'removed' && followAllowance(user, existing, savedFollows, at).limitPaused) throw new ApiError('plan_limit', '该配置超出当前套餐名额，请先移除其他配置或升级月卡、年卡');
        const others = index.filter(f => f._id !== id && f.status !== 'removed');
        const check = validateFollowLimits(others, follow, existing && existing.status !== 'removed' ? Math.max(limits.maxFollows, others.length + 1) : limits.maxFollows, limits.maxStoresPerFollow);
        if (!check.ok) throw new ApiError(check.reason, `关注设置超过限制：最多 ${limits.maxFollows} 个配置，每个配置最多 ${limits.maxStoresPerFollow} 家门店`);
        next = { ...follow, storeNumbers: check.storeNumbers, createdAt: existing ? existing.createdAt : follow.createdAt };
      } else {
        if (!existing || existing.userKey !== userKey || existing.status === 'removed') throw new ApiError('unknown_follow', '关注不存在');
        if (status === 'active' && followAllowance(user, existing, savedFollows, at).limitPaused) throw new ApiError('plan_limit', '该配置超出当前套餐名额，请先移除其他配置或升级月卡、年卡');
        next = { ...existing, status, statusReason: status === 'active' ? null : 'user', updatedAt: nowIso };
      }
      next.updatedAt = nextFollowUpdatedAt(existing, nowIso);
      user.followIndex = index.filter(f => f._id !== id);
      if (next.status !== 'removed') user.followIndex.push({ _id: id, partNumber: next.partNumber, status: next.status, createdAt: next.createdAt });
      await tx.put(C.users, user);
      await tx.put(C.follows, next);
      return next;
    }),

    recordNotificationOpen: ({ userKey, taskId, nowIso }) => run(async tx => {
      const task = await tx.get(C.notifications, taskId);
      if (!task || task.userKey !== userKey || task.userHiddenAt) return { recorded: false };
      if (task.firstPresentedAt) return { recorded: false, firstOpenedAt: task.firstOpenedAt, firstPresentedAt: task.firstPresentedAt };
      // Preserve legacy read-time telemetry separately. 1.6.0 only records a
      // presentation when a visible page acknowledges successful rendering.
      const firstOpenedAt = task.firstOpenedAt || nowIso;
      await tx.put(C.notifications, { ...task, firstOpenedAt, firstPresentedAt: nowIso });
      return { recorded: true, firstOpenedAt, firstPresentedAt: nowIso };
    }),

    recordNotificationFeedback: ({ userKey, taskId, outcome, nowIso, knownFollows = [] }) => run(async tx => {
      const task = await tx.get(C.notifications, taskId);
      if (!task || task.userKey !== userKey || task.userHiddenAt) throw new ApiError('notification_not_found', '这条提醒已过期或已删除');
      if (!['bought', 'missed', 'skipped'].includes(outcome)) throw new ApiError('invalid_feedback', '请选择有效的反馈');
      const follow = outcome === 'bought' && task.followId ? await tx.get(C.follows, task.followId) : null;
      const paused = Boolean(follow && follow.status === 'active' && matchesNotificationTarget(task, follow));
      if (paused) {
        const user = await tx.get(C.users, userKey);
        if (!user) throw new ApiError('user_missing', '用户不存在');
        const index = user.followIndex || knownFollows.filter(f => f.status !== 'removed').map(f => ({ _id: f._id, partNumber: f.partNumber, status: f.status }));
        user.followIndex = [...index.filter(f => f._id !== follow._id), { _id: follow._id, partNumber: follow.partNumber, status: 'paused', createdAt: follow.createdAt }];
        await tx.put(C.users, user);
        await tx.put(C.follows, { ...follow, status: 'paused', statusReason: 'user', updatedAt: nextFollowUpdatedAt(follow, nowIso) });
      }
      await tx.put(C.notifications, { ...task, feedback: { outcome, at: nowIso } });
      return { outcome, paused };
    }),

    fulfilMembershipOrder: ({ orderId, source, nowIso }) => run(async tx => {
      const order = await tx.get(C.orders, orderId);
      if (!order) throw new ApiError('unknown_order', '订单不存在');
      const user = await tx.get(C.users, order.userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      return fulfilMembershipIn(tx, user, order, source, nowIso);
    }),

    redeemMembershipCode: ({ userKey, codeHash, nowIso }) => run(async tx => {
      const runtime = await tx.get(C.config, 'runtime');
      const settings = mergeConfig(runtime).memberRedemption;
      if (settings.enabled !== true) return { error: { code: 'redemption_disabled', message: '会员兑换暂未开放，请稍后再试' } };
      const user = await tx.get(C.users, userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      const id = attemptsId(userKey), nowMs = Date.parse(nowIso);
      const attempts = await tx.get(C.config, id);
      const rateLimited = retryAt => ({ error: { code: 'redemption_rate_limited', message: '兑换码连续输入错误，请 15 分钟后再试', details: { retryAt, retryAfterSeconds: Math.ceil((Date.parse(retryAt) - nowMs) / 1000) } } });
      if (attempts && Date.parse(attempts.lockedUntil) > nowMs) return rateLimited(attempts.lockedUntil);
      if (!matchesCodeHash(codeHash)) {
        const failures = (attempts && !attempts.lockedUntil ? attempts.failures || 0 : 0) + 1;
        const lockedUntil = failures >= MAX_FAILURES ? new Date(nowMs + LOCK_MS).toISOString() : null;
        await tx.put(C.config, { _id: id, kind: 'member_redemption_attempts', userKey, failures, lockedUntil, updatedAt: nowIso });
        return lockedUntil ? rateLimited(lockedUntil) : { error: { code: 'invalid_redemption_code', message: '兑换码无效，请检查后重试', details: { remainingAttempts: MAX_FAILURES - failures } } };
      }
      // Transactions cannot count orders. The service seeds this counter from the
      // existing redemption orders first; no redemption commits while it is absent.
      // Checked before any write so this early return commits nothing.
      const claims = await tx.get(C.config, CLAIMS_ID);
      if (!claims) return { seedClaims: true };
      const orderId = `redeem_${CAMPAIGN.id}`, recordId = `${userKey}|${orderId}`;
      const existing = await tx.get(C.orders, recordId);
      if (existing && (existing.userKey !== userKey || existing.campaignId !== CAMPAIGN.id || existing.type !== 'membership_redemption' || existing.status !== 'fulfilled')) throw new ApiError('redemption_conflict', '兑换记录状态异常，请联系客服核对');
      if (attempts && (attempts.failures || attempts.lockedUntil)) await tx.put(C.config, { ...attempts, failures: 0, lockedUntil: null, updatedAt: nowIso });
      if (existing) return { alreadyRedeemed: true, user };
      if (claims.claimed >= settings.maxClaims) return { error: { code: 'redemption_sold_out', message: '本期兑换名额已发完', details: { maxClaims: settings.maxClaims } } };
      const order = { _id: recordId, orderId, userKey, productId: CAMPAIGN.productId, type: 'membership_redemption', source: 'redemption_code', campaignId: CAMPAIGN.id, days: CAMPAIGN.days, amountFen: 0, status: 'paid', createdAt: nowIso, paidAt: null, fulfilledAt: null };
      await fulfilMembershipIn(tx, user, order, 'redemption_code', nowIso);
      await tx.put(C.config, { ...claims, claimed: claims.claimed + 1, updatedAt: nowIso });
      return { alreadyRedeemed: false, user };
    }),

    seedRedemptionClaims: ({ claimed, nowIso }) => run(async tx => {
      const existing = await tx.get(C.config, CLAIMS_ID);
      if (existing) return existing;
      const claims = { _id: CLAIMS_ID, kind: 'member_redemption_claims', campaignId: CAMPAIGN.id, claimed, seededAt: nowIso, updatedAt: nowIso };
      await tx.put(C.config, claims);
      return claims;
    }),

    createOrderIfAbsent: order => run(async tx => {
      const existing = await tx.get(C.orders, order._id);
      if (existing) {
        if (['userKey', 'productId', 'amountFen', 'outTradeNo'].some(key => (existing[key] || null) !== (order[key] || null)) || (existing.days || existing.durationDays) !== (order.days || order.durationDays)) throw new ApiError('order_id_conflict', '该订单编号已用于不同的会员发放');
        return { order: existing, applied: false };
      }
      await tx.put(C.orders, order);
      return { order, applied: true };
    }),

    updateOrder: (id, patch) => run(async tx => {
      const order = await tx.get(C.orders, id);
      if (!order) throw new ApiError('unknown_order', '订单不存在');
      const updated = { ...order, ...patch, _id: id };
      await tx.put(C.orders, updated);
      return updated;
    }),

    markOrderRefunded: args => run(tx => refundMembershipIn(tx, args)),
    refundMembershipOrder: args => run(tx => refundMembershipIn(tx, args)),

    confirmPaymentRefundCallback: ({ orderId, refundId, refundFen, nowIso }) => run(async tx => {
      const order = await tx.get(C.orders, orderId);
      if (!order || order.provider !== 'wechat_virtual_payment') throw new ApiError('unknown_order', '订单不存在');
      if (!Number.isSafeInteger(order.amountFen) || order.amountFen <= 0) throw new ApiError('invalid_refund_callback', '退款通知信息无效');
      if (typeof refundId !== 'string' || !refundId || refundId.length > 256 || /[\u0000-\u001f\u007f]/.test(refundId)
        || !Number.isSafeInteger(refundFen) || refundFen <= 0 || refundFen > order.amountFen) throw new ApiError('invalid_refund_callback', '退款通知信息无效');
      const receipts = order.refundCallbacks || [];
      const seen = new Set(); let covered = 0, existing;
      if (!Array.isArray(receipts) || receipts.length > Math.min(700, order.amountFen)) throw new ApiError('payment_refund_callback_conflict', '退款通知记录待核对');
      for (const receipt of receipts) {
        if (!receipt || typeof receipt.refundId !== 'string' || !receipt.refundId || receipt.refundId.length > 256 || seen.has(receipt.refundId) || !Number.isSafeInteger(receipt.amountFen) || receipt.amountFen <= 0) throw new ApiError('payment_refund_callback_conflict', '退款通知记录待核对');
        seen.add(receipt.refundId); covered += receipt.amountFen;
        if (receipt.refundId === refundId) existing = receipt;
      }
      if (!Number.isSafeInteger(covered) || covered > order.amountFen || existing && existing.amountFen !== refundFen) throw new ApiError('payment_refund_callback_conflict', '退款通知记录待核对');
      const confirmedFen = order.status === 'refunded' ? order.amountFen : order.refundFen || 0;
      if (!Number.isSafeInteger(confirmedFen) || confirmedFen < 0 || confirmedFen > order.amountFen) throw new ApiError('payment_refund_callback_conflict', '退款通知记录待核对');
      if (confirmedFen < covered + (existing ? 0 : refundFen)) return { confirmed: false, reason: 'refund_not_reconciled' };
      if (existing) return { confirmed: true, replayed: true };
      if (receipts.length >= 700) throw new ApiError('payment_refund_callback_conflict', '退款通知记录待核对');
      // Assign each authenticated refund ID a distinct portion of the verified
      // cumulative refund. Two callbacks cannot acknowledge the same 350 fen.
      await tx.put(C.orders, { ...order, refundCallbacks: [...receipts, { refundId, amountFen: refundFen, confirmedAt: nowIso }] });
      return { confirmed: true, replayed: false };
    }),

    markOrderPaid: ({ orderId, transactionId, nowIso, providerData }) => run(async tx => {
      const order = await tx.get(C.orders, orderId);
      if (!order) throw new ApiError('unknown_order', '订单不存在');
      if (typeof transactionId !== 'string' || !transactionId) throw new ApiError('invalid_payment', '缺少支付交易编号');
      const receiptId = `payment_${createHash('sha256').update(transactionId).digest('hex')}`;
      const receipt = await tx.get(C.config, receiptId);
      if (receipt && receipt.orderId !== orderId) throw new ApiError('payment_already_used', '该支付交易已绑定其他订单');
      if (order.transactionId && order.transactionId !== transactionId) throw new ApiError('payment_conflict', '订单已绑定其他支付交易');
      if (providerData && providerData.amountFen !== undefined && providerData.amountFen !== order.amountFen) throw new ApiError('payment_amount_mismatch', '支付金额与订单不一致');
      if (!['created', 'paid', 'fulfilled', 'partially_refunded'].includes(order.status)) throw new ApiError('invalid_order_status', '当前订单无法确认支付');
      const paid = { ...order, status: ['fulfilled', 'partially_refunded'].includes(order.status) ? order.status : 'paid', paidAt: order.paidAt || nowIso, transactionId, payment: { ...order.payment, providerData } };
      await tx.put(C.config, { _id: receiptId, orderId, transactionId, createdAt: nowIso, kind: 'payment_receipt' });
      await tx.put(C.orders, paid);
      return { order: paid, applied: !receipt };
    }),

    ...upstreamGuardMethods(run),
    ...queryTargetMethods(run),

    claimNotification: ({ id, ownerId, now, leaseUntil }) => run(async tx => {
      const task = await tx.get(C.notifications, id);
      if (!task || task.status !== 'pending') return { claimed: false, task };
      const claimed = { ...task, status: 'sending', ownerId, leaseUntil, startedAt: now };
      await tx.put(C.notifications, claimed);
      return { claimed: true, task: claimed };
    }),

    reserveSubscriptionCredit: ({ userKey, templateId, taskId, now, cooldownMinutes = 30, targetKey }) => run(async tx => {
      const task = await tx.get(C.notifications, taskId);
      const user = await tx.get(C.users, userKey);
      if (!task || task.userKey !== userKey || !user) return { reserved: false, reason: 'missing_task_or_user' };
      const subscription = user.subscriptions && user.subscriptions[templateId];
      if (task.subscriptionReserved) {
        if (task.subscriptionTemplateId !== templateId) return { reserved: false, reason: 'template_changed', replayed: true };
        const invalidated = task.subscriptionInvalidated || subscriptionCredits.reservationInvalid(subscriptionCredits.readLedger(subscription), task);
        return { reserved: !task.subscriptionReleased && !invalidated, reason: invalidated ? 'subscription_authorization_expired' : task.subscriptionReleased ? 'credit_released' : null, replayed: true };
      }
      // The one free alert is locked to a single task so concurrent events cannot send two.
      const free = !isMember(user, new Date(now));
      if (free && !hasFreeReminder(user, new Date(now))) return { reserved: false, reason: 'free_reminder_used' };
      if (free && user.freeReminderTaskId && user.freeReminderTaskId !== taskId) {
        const locked = await tx.get(C.notifications, user.freeReminderTaskId);
        if (locked && ['pending', 'sending'].includes(locked.status)) return { reserved: false, reason: 'free_reminder_in_use' };
        // A worker that died after reserving never settled the lock. A possibly
        // delivered alert still uses up the free one; anything else unlocks it.
        if (locked && ['accepted', 'uncertain'].includes(locked.status)) {
          await tx.put(C.users, { ...user, freeReminderTaskId: null, firstReminderSentAt: locked.sentAt || locked.finishedAt || now });
          return { reserved: false, reason: 'free_reminder_used' };
        }
        user.freeReminderTaskId = null;
      }
      const credit = subscriptionCredits.reserveCredit(subscription);
      if (!credit.reserved) return { reserved: false, reason: 'no_subscription_credit' };
      const cooldownId = targetKey ? `notify_cooldown_${createHash('sha256').update(`${userKey}|${targetKey}`).digest('hex')}` : null;
      if (cooldownId) {
        const cooldown = await tx.get(C.config, cooldownId);
        if (cooldown && Date.parse(now) - Date.parse(cooldown.lastReservedAt) < cooldownMinutes * 60000) return { reserved: false, reason: 'cooldown' };
        await tx.put(C.config, { _id: cooldownId, taskId, lastReservedAt: now });
      }
      user.subscriptions[templateId] = subscriptionCredits.writeLedger(subscription, credit.ledger, now);
      if (free) user.freeReminderTaskId = taskId;
      await tx.put(C.users, user);
      await tx.put(C.notifications, { ...task, subscriptionReserved: true, subscriptionTemplateId: templateId, subscriptionReservedAt: now, subscriptionCreditSequence: credit.ticket, subscriptionCreditHighWater: credit.highWater, cooldownId });
      return { reserved: true, reason: null };
    }),

    /**
     * After a send attempt: an accepted or possibly delivered alert marks the
     * account's first alert (using up the free one); any outcome unlocks it.
     */
    settleFirstReminder: ({ userKey, taskId, sent, now }) => run(async tx => {
      const user = await tx.get(C.users, userKey);
      if (!user) return { settled: false };
      const lockHeld = user.freeReminderTaskId === taskId;
      if (!lockHeld && (!sent || user.firstReminderSentAt)) return { settled: false };
      await tx.put(C.users, { ...user, freeReminderTaskId: lockHeld ? null : user.freeReminderTaskId || null, firstReminderSentAt: user.firstReminderSentAt || (sent ? now : null) });
      return { settled: true };
    }),

    releaseSubscriptionCredit: ({ userKey, templateId, taskId, now }) => run(async tx => {
      const task = await tx.get(C.notifications, taskId);
      const user = await tx.get(C.users, userKey);
      if (!task || task.userKey !== userKey || !user || !task.subscriptionReserved || task.subscriptionReleased || task.subscriptionInvalidated || task.subscriptionTemplateId !== templateId) return { released: false };
      const subscription = user.subscriptions && user.subscriptions[templateId] || { credits: 0 };
      const credit = subscriptionCredits.refundCredit(subscription, task);
      const updated = subscriptionCredits.writeLedger(subscription, credit.ledger, now);
      if (updated.credits > 0) updated.needsReauthorization = false;
      user.subscriptions = { ...user.subscriptions, [templateId]: updated };
      await tx.put(C.users, user);
      // Even a non-refundable old reservation is settled, and its own failed
      // attempt must not keep blocking fresh consent through the cooldown.
      await tx.put(C.notifications, { ...task, subscriptionReleased: true, subscriptionReleasedAt: now, subscriptionCreditRestored: credit.refunded });
      if (task.cooldownId) {
        const cooldown = await tx.get(C.config, task.cooldownId);
        if (cooldown && cooldown.taskId === taskId) await tx.put(C.config, { ...cooldown, lastReservedAt: '1970-01-01T00:00:00.000Z' });
      }
      return { released: credit.refunded };
    }),

    invalidateSubscriptionCredit: ({ userKey, templateId, taskId, now }) => run(async tx => {
      const task = await tx.get(C.notifications, taskId);
      const user = await tx.get(C.users, userKey);
      if (!task || task.userKey !== userKey || !user || !task.subscriptionReserved || task.subscriptionInvalidated || task.subscriptionReleased || task.subscriptionTemplateId !== templateId) return { invalidated: false };
      const subscription = user.subscriptions && user.subscriptions[templateId] || { credits: 0, accepted: 0 };
      const ledger = subscriptionCredits.invalidateCredits(subscription, task);
      const updated = subscriptionCredits.writeLedger(subscription, ledger, now);
      const credits = updated.credits;
      user.subscriptions = { ...user.subscriptions, [templateId]: { ...updated, needsReauthorization: credits === 0, invalidatedAt: now } };
      await tx.put(C.users, user);
      await tx.put(C.notifications, { ...task, subscriptionInvalidated: true, subscriptionInvalidatedAt: now });
      if (task.cooldownId) {
        const cooldown = await tx.get(C.config, task.cooldownId);
        if (cooldown && cooldown.taskId === taskId) await tx.put(C.config, { ...cooldown, lastReservedAt: '1970-01-01T00:00:00.000Z' });
      }
      return { invalidated: true, credits };
    }),

    /**
     * One-time repair for ledgers inflated by the 2026-09-22 build, which issued
     * 365 tickets per member "allow" although WeChat grants one send. Reissues at
     * most (lifetime accepts - occupied permissions), never more than the current
     * count. Occupied includes sends in flight and uncertain deliveries.
     */
    repairInflatedCredits: ({ userKey, templateId, usedCredits, expectedSubscription, now }) => run(async tx => {
      const user = await tx.get(C.users, userKey);
      const current = user && user.subscriptions && user.subscriptions[templateId];
      if (!current || current.poolRepairedAt || !current.creditLedger) return { repaired: false };
      // A concurrent allow, reservation, refund or old-version write changes
      // this snapshot. Re-read usage instead of issuing against a stale count.
      if (!expectedSubscription || !isDeepStrictEqual(current, expectedSubscription)) return { repaired: false, retry: true };
      if (!Number.isSafeInteger(usedCredits) || usedCredits < 0) throw new ApiError('invalid_subscription_state', '授权记录状态异常，请稍后重试');
      const ledger = subscriptionCredits.readLedger(current);
      const accepted = Number.isSafeInteger(current.accepted) ? current.accepted : 0;
      if (ledger.sequence <= accepted) return { repaired: false };
      const balance = subscriptionCredits.balance(ledger);
      // Missing/retained-old notification rows cannot make a spent or reserved
      // ticket available again. Invalidated generations are not spendable.
      const unavailableTickets = ledger.sequence - ledger.invalidatedThrough - (balance - ledger.legacyCredits);
      const credits = Math.min(balance, Math.max(0, accepted - Math.max(usedCredits, unavailableTickets)));
      // Void every issued ticket (in-flight reservations cannot be refunded),
      // then issue only the sends WeChat can still honour.
      let repaired = subscriptionCredits.writeLedger(current, { ...ledger, legacyCredits: 0, legacyInvalidated: true, invalidatedThrough: ledger.sequence, available: [] }, now);
      for (let i = 0; i < credits; i += 1) repaired = subscriptionCredits.writeLedger(repaired, subscriptionCredits.grantCredit(repaired), now);
      await tx.put(C.users, { ...user, subscriptions: { ...user.subscriptions, [templateId]: { ...repaired, needsReauthorization: credits === 0, poolRepairedAt: now } } });
      return { repaired: true, credits };
    }),

    recordSubscriptionGrant: ({ userKey, requestId, templateIds, results, now }) => run(async tx => {
      const id = `subscription_${createHash('sha256').update(`${userKey}|${requestId}`).digest('hex')}`;
      const existing = await tx.get(C.config, id);
      const user = await tx.get(C.users, userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      if (existing) return { accepted: [], subscriptions: user.subscriptions || {}, replayed: true };
      const accepted = [];
      const subscriptions = { ...user.subscriptions };
      for (const templateId of templateIds) {
        const result = results[templateId];
        if (!['accept', 'reject', 'ban', 'filter'].includes(result)) continue;
        const current = subscriptions[templateId] || { credits: 0, accepted: 0, rejected: 0 };
        // One WeChat "allow" is exactly one send. Credits accumulate across taps;
        // recording more than WeChat granted only fails later with 43101.
        const credited = result === 'accept' ? subscriptionCredits.writeLedger(current, subscriptionCredits.grantCredit(current), now) : current;
        subscriptions[templateId] = { ...credited, accepted: (current.accepted || 0) + (result === 'accept' ? 1 : 0), rejected: (current.rejected || 0) + (result === 'reject' ? 1 : 0), ...(result === 'accept' ? { needsReauthorization: false } : {}), lastResult: result, updatedAt: now };
        if (result === 'accept') accepted.push(templateId);
      }
      await tx.put(C.users, { ...user, subscriptions });
      await tx.put(C.config, { _id: id, userKey, requestId, createdAt: now, kind: 'subscription_grant' });
      return { accepted, subscriptions, replayed: false };
    }),
  };
}

module.exports = { atomicMethods };
