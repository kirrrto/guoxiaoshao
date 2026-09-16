'use strict';
// Shared transaction bodies. Both adapters must serialize read/modify/write and
// roll back every write if the callback fails; services never emulate a transaction.
const { createHash } = require('node:crypto');
const { COLLECTIONS: C } = require('../collections');
const { ApiError } = require('../errors');
const { dayKey } = require('../time');
const { decideLiveQuery, decideHistoryQuery } = require('../rules/access');
const { grantableAmount, ledgerIds } = require('../rules/quota');
const { isMember, extendMembership, validateFollowLimits } = require('../rules/membership');
const { applyObservation, targetKeyOf } = require('../engine/events');
const { viewId, newView, decodeToken } = require('../notification-view');
const { mergeConfig, patchConfig } = require('../config');
const { CAMPAIGN, MAX_FAILURES, LOCK_MS, matchesCodeHash, attemptsId } = require('../member-redemption');

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
  if (entry.delta > 0 && !['query_refund', 'admin_grant'].includes(entry.type)) user.quota.dailyRewardSnapshot = null;
  await tx.put(C.ledger, stored);
  await tx.put(C.users, user);
  return { applied: true, entry: stored, balance: after, user };
}

async function fulfilMembershipIn(tx, user, order, source, nowIso) {
  if (order.status === 'fulfilled') return { order, applied: false, expiresAt: user.membership.expiresAt };
  if (order.status !== 'paid') throw new ApiError('order_not_paid', '订单尚未确认支付');
  const expiresAt = extendMembership(user, order.days || order.durationDays, new Date(nowIso)).toISOString();
  user.membership = { expiresAt, source, updatedAt: nowIso, lastOrderId: order.orderId };
  const fulfilled = { ...order, status: 'fulfilled', fulfilledAt: nowIso };
  await tx.put(C.users, user);
  await tx.put(C.orders, fulfilled);
  return { order: fulfilled, applied: true, expiresAt };
}

function atomicMethods(run) {
  return {
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
    patchRuntimeConfig: ({ patch, updatedAt, updatedBy }) => run(async tx => {
      // Merge after acquiring the transaction snapshot; concurrent unrelated
      // edits must not restore a stale enabled flag or overwrite sibling fields.
      const stored = await tx.get(C.config, 'runtime') || {};
      const next = { ...patchConfig(stored, patch), _id: 'runtime', updatedAt, updatedBy };
      await tx.put(C.config, next);
      return { config: mergeConfig(next) };
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
      const user = await tx.get(C.users, record.userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      const existing = await tx.get(C.queries, record._id);
      if (existing) {
        // Legacy records are bound by their actual request fields as well.
        const signature = q => JSON.stringify([q.kind, q.partNumber, [...q.storeNumbers].sort(), q.kind === 'history' ? q.dayKey : null]);
        if (signature(existing) !== signature(record)) throw new ApiError('query_id_conflict', '该查询编号已用于其他条件，请重新查询');
        if (existing.status !== 'pending' && existing.response) return { replayed: true, record: existing, balance: user.quota.balance };
        if (existing.leaseUntil && existing.leaseUntil > nowIso) return { busy: true, record: existing, retryAfterMs: Date.parse(existing.leaseUntil) - Date.parse(nowIso), balance: user.quota.balance };
        // A crashed worker is fenced out. Its debit belongs to this same request;
        // recovery is allowed even when the debit used the user's last credit.
        const resumed = { ...existing, status: 'pending', ownerId, leaseUntil: new Date(Date.parse(nowIso) + leaseMs).toISOString(), attempts: (existing.attempts || 1) + 1 };
        await tx.put(C.queries, resumed);
        return { record: resumed, balance: user.quota.balance, recovered: true };
      }
      const decision = record.kind === 'history'
        ? decideHistoryQuery({ user, product, requestedDayKey: record.dayKey, now: new Date(nowIso), config })
        : decideLiveQuery({ user, product, now: new Date(nowIso), config });
      if (!decision.allowed) return { denied: decision, balance: user.quota.balance };
      let balance = user.quota.balance;
      if (decision.cost > 0) {
        const id = record.kind === 'history' ? ledgerIds.historyDebit(user._id, record.queryId) : ledgerIds.queryDebit(user._id, record.queryId);
        balance = (await applyLedgerIn(tx, { _id: id, userKey: user._id, type: record.kind === 'history' ? 'history_debit' : 'query_debit', delta: -decision.cost, dayKey: dayKey(nowIso), createdAt: nowIso, refId: record.queryId, partNumber: record.partNumber })).balance;
      }
      const pending = { ...record, charged: decision.cost, member: decision.member, status: 'pending', ownerId, leaseUntil: new Date(Date.parse(nowIso) + leaseMs).toISOString(), attempts: 1, createdAt: nowIso, finishedAt: null, response: null };
      await tx.put(C.queries, pending);
      return { record: pending, balance };
    }),

    finishQuery: args => run(async tx => {
      const { id, ownerId, response, refund, nowIso } = args;
      const record = await tx.get(C.queries, id);
      if (!record) throw new ApiError('unknown_query', '查询记录不存在');
      if (record.status !== 'pending') return { completed: false, record, response: record.response };
      if (record.ownerId !== ownerId) return { completed: false, stale: true, record };
      let user = await tx.get(C.users, record.userKey);
      let refunded = 0;
      if (refund && record.charged > 0) {
        const result = await applyLedgerIn(tx, { _id: `${record.userKey}|${record.kind === 'history' ? 'history' : 'query'}|${record.queryId}|refund`, userKey: record.userKey, type: 'query_refund', delta: record.charged, dayKey: dayKey(nowIso), createdAt: nowIso, refId: record.queryId });
        user = result.user;
        refunded = record.charged;
      }
      const final = { ...response, charged: record.charged, refunded, balance: user.quota.balance, member: record.member };
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
      const response = { ok: false, reason: 'query_expired', queryId: record.queryId, historyQueryId: record.kind === 'history' ? record.queryId : null, results: [], events: [], latest: [], charged: record.charged, refunded, balance: user.quota.balance, member: record.member, queriedAt: record.createdAt };
      await tx.put(C.queries, { ...record, status: 'failed', finishedAt: nowIso, leaseUntil: null, response });
      return { expired: true, refunded };
    }),

    recordObservation: ({ observation, continuityGapMs, collectorLease }) => run(async tx => {
      if (collectorLease) {
        const lease = await tx.get(C.config, 'collector_lease');
        if (!lease || lease.ownerId !== collectorLease.ownerId || lease.expiresAt <= collectorLease.nowIso) throw new ApiError('collector_lease_lost', '采集执行权已转移');
      }
      const previous = await tx.get(C.latest, targetKeyOf(observation.storeNumber, observation.partNumber));
      const result = applyObservation(previous, observation, Number.isFinite(continuityGapMs) ? { continuityGapMs } : undefined);
      if (result.outcome !== 'stale' && result.outcome !== 'duplicate') {
        await tx.put(C.latest, result.latest);
        for (const event of result.events) await tx.put(C.events, { ...event, dayKey: dayKey(event.detectedAt), notificationPlannedAt: null });
      }
      return { ...result, observation };
    }),

    mutateFollow: args => run(async tx => {
      const { userKey, follow, followId, status, nowIso, knownFollows = [] } = args;
      const user = await tx.get(C.users, userKey);
      if (!user) throw new ApiError('user_missing', '用户不存在');
      const id = follow ? follow._id : followId;
      const existing = await tx.get(C.follows, id);
      const index = user.followIndex || knownFollows.filter(f => f.status !== 'removed').map(f => ({ _id: f._id, partNumber: f.partNumber, status: f.status }));
      if ((follow || status === 'active') && !isMember(user, new Date(nowIso))) throw new ApiError('member_required', '会员到期后无法新增或恢复监测');
      let next;
      if (follow) {
        const check = validateFollowLimits(index.filter(f => f._id !== id && f.status !== 'removed'), follow);
        if (!check.ok) throw new ApiError(check.reason, '关注设置超过限制：最多 3 个机型，每个机型最多 3 家门店');
        next = { ...follow, storeNumbers: check.storeNumbers, createdAt: existing ? existing.createdAt : follow.createdAt };
      } else {
        if (!existing || existing.userKey !== userKey || existing.status === 'removed') throw new ApiError('unknown_follow', '关注不存在');
        next = { ...existing, status, statusReason: status === 'active' ? null : 'user', updatedAt: nowIso };
      }
      user.followIndex = index.filter(f => f._id !== id);
      if (next.status !== 'removed') user.followIndex.push({ _id: id, partNumber: next.partNumber, status: next.status });
      await tx.put(C.users, user);
      await tx.put(C.follows, next);
      return next;
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
      if (mergeConfig(runtime).memberRedemption.enabled !== true) return { error: { code: 'redemption_disabled', message: '会员兑换暂未开放，请稍后再试' } };
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
      const orderId = `redeem_${CAMPAIGN.id}`, recordId = `${userKey}|${orderId}`;
      const existing = await tx.get(C.orders, recordId);
      if (existing && (existing.userKey !== userKey || existing.campaignId !== CAMPAIGN.id || existing.type !== 'membership_redemption' || existing.status !== 'fulfilled')) throw new ApiError('redemption_conflict', '兑换记录状态异常，请联系客服核对');
      if (attempts && (attempts.failures || attempts.lockedUntil)) await tx.put(C.config, { ...attempts, failures: 0, lockedUntil: null, updatedAt: nowIso });
      if (existing) return { alreadyRedeemed: true, user };
      const order = { _id: recordId, orderId, userKey, productId: CAMPAIGN.productId, type: 'membership_redemption', source: 'redemption_code', campaignId: CAMPAIGN.id, days: CAMPAIGN.days, amountFen: 0, status: 'paid', createdAt: nowIso, paidAt: null, fulfilledAt: null };
      await fulfilMembershipIn(tx, user, order, 'redemption_code', nowIso);
      return { alreadyRedeemed: false, user };
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

    markOrderRefunded: ({ orderId, nowIso, providerData }) => run(async tx => {
      const order = await tx.get(C.orders, orderId);
      if (!order) throw new ApiError('unknown_order', '订单不存在');
      if (order.status === 'refunded') return { order, applied: false };
      if (order.status === 'fulfilled') {
        const user = await tx.get(C.users, order.userKey);
        if (!user) throw new ApiError('user_missing', '用户不存在');
        const expiry = Date.parse(user.membership && user.membership.expiresAt) || Date.parse(nowIso);
        const days = order.days || order.durationDays;
        if (!Number.isInteger(days) || days <= 0) throw new ApiError('invalid_order', '会员天数无效');
        user.membership = { ...user.membership, expiresAt: new Date(Math.max(Date.parse(nowIso), expiry - days * 86400000)).toISOString(), updatedAt: nowIso, source: 'refund' };
        await tx.put(C.users, user);
      }
      const refunded = { ...order, status: 'refunded', refundedAt: nowIso, refund: providerData || null };
      await tx.put(C.orders, refunded);
      return { order: refunded, applied: true };
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
      if (!['created', 'paid', 'fulfilled'].includes(order.status)) throw new ApiError('invalid_order_status', '当前订单无法确认支付');
      const paid = { ...order, status: order.status === 'fulfilled' ? 'fulfilled' : 'paid', paidAt: order.paidAt || nowIso, transactionId, payment: { ...order.payment, providerData } };
      await tx.put(C.config, { _id: receiptId, orderId, transactionId, createdAt: nowIso, kind: 'payment_receipt' });
      await tx.put(C.orders, paid);
      return { order: paid, applied: !receipt };
    }),

    consumeCollectorBudget: ({ now, maxRequestsPerMinute, maxRequestsPerDay }) => run(async tx => {
      const date = dayKey(now);
      const id = `collector_budget_${date}`;
      const minuteKey = new Date(now).toISOString().slice(0, 16);
      const current = await tx.get(C.config, id) || { _id: id, dayCount: 0 };
      const minuteCount = current.minuteKey === minuteKey ? current.minuteCount || 0 : 0;
      if (minuteCount >= maxRequestsPerMinute || current.dayCount >= maxRequestsPerDay) return { allowed: false, reason: current.dayCount >= maxRequestsPerDay ? 'daily_budget' : 'minute_budget', minuteCount, dayCount: current.dayCount };
      await tx.put(C.config, { ...current, minuteKey, minuteCount: minuteCount + 1, dayCount: current.dayCount + 1, updatedAt: now, expiresAt: new Date(Date.parse(now) + 7 * 86400000).toISOString() });
      return { allowed: true, reason: null, minuteCount: minuteCount + 1, dayCount: current.dayCount + 1 };
    }),

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
      if (task.subscriptionReserved) return { reserved: !task.subscriptionReleased, reason: task.subscriptionReleased ? 'credit_released' : null, replayed: true };
      const subscription = user.subscriptions && user.subscriptions[templateId];
      if (!subscription || !(subscription.credits > 0)) return { reserved: false, reason: 'no_subscription_credit' };
      const cooldownId = targetKey ? `notify_cooldown_${createHash('sha256').update(`${userKey}|${targetKey}`).digest('hex')}` : null;
      if (cooldownId) {
        const cooldown = await tx.get(C.config, cooldownId);
        if (cooldown && Date.parse(now) - Date.parse(cooldown.lastReservedAt) < cooldownMinutes * 60000) return { reserved: false, reason: 'cooldown' };
        await tx.put(C.config, { _id: cooldownId, taskId, lastReservedAt: now });
      }
      user.subscriptions[templateId] = { ...subscription, credits: subscription.credits - 1, updatedAt: now };
      await tx.put(C.users, user);
      await tx.put(C.notifications, { ...task, subscriptionReserved: true, subscriptionTemplateId: templateId, subscriptionReservedAt: now, cooldownId });
      return { reserved: true, reason: null };
    }),

    releaseSubscriptionCredit: ({ userKey, templateId, taskId, now }) => run(async tx => {
      const task = await tx.get(C.notifications, taskId);
      const user = await tx.get(C.users, userKey);
      if (!task || task.userKey !== userKey || !user || !task.subscriptionReserved || task.subscriptionReleased || task.subscriptionTemplateId !== templateId) return { released: false };
      const subscription = user.subscriptions && user.subscriptions[templateId] || { credits: 0 };
      user.subscriptions = { ...user.subscriptions, [templateId]: { ...subscription, credits: subscription.credits + 1, updatedAt: now } };
      await tx.put(C.users, user);
      await tx.put(C.notifications, { ...task, subscriptionReleased: true, subscriptionReleasedAt: now });
      if (task.cooldownId) {
        const cooldown = await tx.get(C.config, task.cooldownId);
        if (cooldown && cooldown.taskId === taskId) await tx.put(C.config, { ...cooldown, lastReservedAt: '1970-01-01T00:00:00.000Z' });
      }
      return { released: true };
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
        subscriptions[templateId] = { ...current, credits: (current.credits || 0) + (result === 'accept' ? 1 : 0), accepted: (current.accepted || 0) + (result === 'accept' ? 1 : 0), rejected: (current.rejected || 0) + (result === 'reject' ? 1 : 0), lastResult: result, updatedAt: now };
        if (result === 'accept') accepted.push(templateId);
      }
      await tx.put(C.users, { ...user, subscriptions });
      await tx.put(C.config, { _id: id, userKey, requestId, createdAt: now, kind: 'subscription_grant' });
      return { accepted, subscriptions, replayed: false };
    }),
  };
}

module.exports = { atomicMethods };
