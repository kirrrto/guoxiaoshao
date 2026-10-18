'use strict';
const { createHash } = require('node:crypto');
const { ApiError } = require('../errors');
const { COLLECTIONS: C } = require('../collections');
const { startOfDay, dayKey, addDays } = require('../time');
const { accountKey, runtimeFor, EVENTS, REASONS, ENTRY_POINTS, PLANS, EVENT_RETENTION_DAYS, INTENT_DETAIL_DAYS } = require('../growth-policy');

const REPORT_LIMIT = 2000;
const DAY = 86400000;
const token = (value, max = 64) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
const allowed = (list, value, fallback = null) => list.includes(value) ? value : fallback;

async function ingest(ctx, payload) {
  if (!ctx.config.features.growthEvents) return { enabled: false, accepted: 0, duplicate: 0, dropped: 0 };
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 10
    || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 16384) throw new ApiError('invalid_growth_batch', '事件批次无效');
  // Only an already bootstrapped, SDK-authenticated account can contribute.
  if (!await ctx.repo.getUser(ctx.identity.userKey)) throw new ApiError('user_required', '请先刷新账户');
  const key = accountKey(ctx.identity.userKey);
  if (!await ctx.repo.reserveGrowthBatch({ accountKey: key, nowIso: ctx.nowIso })) {
    return { enabled: true, accepted: 0, duplicate: 0, dropped: payload.events.length, rateLimited: true };
  }
  const { experiment } = runtimeFor(ctx.config, ctx.identity.userKey);
  const events = [];
  for (const input of payload.events) {
    if (!input || !EVENTS.includes(input.eventName) || !token(input.eventId) || !token(input.sessionId)) continue;
    const clientTime = Date.parse(input.occurredAt);
    if (!Number.isFinite(clientTime) || Math.abs(clientTime - ctx.now.getTime()) > DAY) continue;
    let target = null;
    if (input.eventName === 'target_committed') {
      const value = input.target;
      if (!value || typeof value.partNumber !== 'string' || !/^[A-Za-z0-9/]{1,32}$/.test(value.partNumber)
        || !Array.isArray(value.storeNumbers) || value.storeNumbers.length < 1 || value.storeNumbers.length > 5
        || value.storeNumbers.some(number => !/^R\d{1,6}$/.test(number))) continue;
      const stores = [...new Set(value.storeNumbers)].sort();
      const [product, knownStores] = await Promise.all([ctx.repo.getProduct(value.partNumber), ctx.repo.getStores(stores)]);
      if (!product || !product.supported || product.comingSoon || knownStores.length !== stores.length) continue;
      target = { partNumber: product.partNumber, storeNumbers: stores };
    }
    const id = createHash('sha256').update(`${key}\n${input.eventId}`).digest('hex');
    events.push({ _id: id, accountKey: key, eventId: input.eventId, eventName: input.eventName,
      schemaVersion: 1, occurredAt: new Date(clientTime).toISOString(), receivedAt: ctx.nowIso,
      sessionId: input.sessionId, appVersion: typeof input.appVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.appVersion) ? input.appVersion : null,
      buildSha: typeof input.buildSha === 'string' && /^[a-f0-9]{7,40}$/.test(input.buildSha) ? input.buildSha : null,
      platform: allowed(['ios', 'android', 'windows', 'mac', 'devtools', 'unknown'], input.platform, 'unknown'),
      entryPoint: allowed(ENTRY_POINTS, input.entryPoint, 'unknown'), planId: allowed(PLANS, input.planId),
      reasonCode: allowed(REASONS, input.reasonCode), result: allowed(['success', 'cancel', 'unknown', 'blocked'], input.result),
      experiment, target });
  }
  const result = await ctx.repo.ingestGrowth({ accountKey: key, events, nowIso: ctx.nowIso });
  return { enabled: true, ...result, rejected: payload.events.length - events.length };
}

/** Infer cash only from the existing server-verified order receipt fields. */
function classifyOrder(order) {
  const source = order.payment && order.payment.source || order.source;
  if (order.productId === 'admin_grant' || ['admin', 'admin_grant', 'redemption', 'member_redemption', 'gift', 'test'].includes(source)
    || /^(grant_|redeem_)/.test(order.orderId || '') || order.test === true) return { kind: 'non_cash' };
  const paid = order.payment && order.payment.providerData;
  const valid = order.provider === 'wechat_virtual_payment' && paid && paid.provider === order.provider
    && Number.isSafeInteger(order.amountFen) && order.amountFen > 0 && paid.amountFen === order.amountFen
    && typeof order.transactionId === 'string' && order.transactionId.length > 0 && typeof order.outTradeNo === 'string' && order.outTradeNo.length > 0
    && typeof order.userKey === 'string' && Number.isFinite(Date.parse(order.paidAt));
  if (!valid) return { kind: order.paidAt || order.fulfilledAt || order.transactionId || ['paid', 'fulfilled', 'refunded', 'partially_refunded'].includes(order.status) ? 'unknown' : 'unpaid' };
  const hasRefund = order.status === 'refunded' || order.status === 'partially_refunded'
    || (order.refundFen !== undefined && order.refundFen !== null && order.refundFen !== 0);
  const refundKnown = !hasRefund || (Number.isSafeInteger(order.refundFen) && order.refundFen > 0 && order.refundFen <= order.amountFen
    && order.refund && order.refund.source === 'query_order' && order.refund.transactionId === order.transactionId
    && Number.isFinite(Date.parse(order.refundUpdatedAt)));
  return { kind: 'cash', paidAt: order.paidAt, grossFen: order.amountFen, refundFen: refundKnown ? Number(order.refundFen) || 0 : null,
    transactionKey: `${order.provider}:${order.transactionId}`, accountKey: accountKey(order.userKey), planId: allowed(PLANS, order.planId, order.days === 7 ? 'member_7d' : 'unknown') };
}

function buildReport({ orders, accounts, events, complete, since, until, config }) {
  const firstPayment = new Map(), unknownAccounts = new Set(), seenTransactions = new Set();
  const finance = { cashOrders: 0, payingAccounts: 0, grossFen: 0, refundsFen: 0, netFen: null, feesFen: null,
    unknownPaymentOrders: 0, unknownRefundOrders: 0, nonCashOrders: 0, unpaidOrders: 0, duplicateTransactions: 0, hiddenCashOrders: 0, byPlan: {} };
  const paying = new Set();
  // Paid time establishes first-payment classification independently of order creation time.
  for (const order of [...orders].sort((a, b) => String(a.paidAt || '').localeCompare(String(b.paidAt || '')) || String(a._id).localeCompare(String(b._id)))) {
    const fact = classifyOrder(order);
    if (fact.kind === 'unknown') {
      finance.unknownPaymentOrders++;
      if (order.userKey) unknownAccounts.add(accountKey(order.userKey));
    }
    if (fact.kind === 'non_cash') finance.nonCashOrders++;
    if (fact.kind === 'unpaid') finance.unpaidOrders++;
    if (fact.kind !== 'cash' || fact.paidAt > until) continue;
    if (seenTransactions.has(fact.transactionKey)) { finance.duplicateTransactions++; continue; }
    seenTransactions.add(fact.transactionKey);
    const first = !firstPayment.has(fact.accountKey);
    if (first) firstPayment.set(fact.accountKey, fact);
    if (fact.paidAt < since) continue;
    finance.cashOrders++; finance.grossFen += fact.grossFen; paying.add(fact.accountKey);
    if (order.userHiddenAt) finance.hiddenCashOrders++;
    if (fact.refundFen === null) finance.unknownRefundOrders++; else finance.refundsFen += fact.refundFen;
    const p = finance.byPlan[fact.planId] || (finance.byPlan[fact.planId] = { orders: 0, firstPayments: 0, repeatPayments: 0, grossFen: 0, refundsFen: 0 });
    p.orders++; p[first ? 'firstPayments' : 'repeatPayments']++; p.grossFen += fact.grossFen; p.refundsFen += fact.refundFen || 0;
  }
  finance.payingAccounts = paying.size;
  finance.netFen = finance.unknownRefundOrders || finance.duplicateTransactions ? null : finance.grossFen - finance.refundsFen;
  finance.firstPaymentClassificationComplete = complete && unknownAccounts.size === 0 && finance.duplicateTransactions === 0;
  const cohort = { definition: 'first_valid_target_receipt_account_cohort_matured_7x24h', eligible: 0, mature: 0, pending: 0, firstPaidD7: 0,
    existingPayers: 0, unknownHistory: 0, rate: null, byExperiment: {} };
  for (const account of accounts) {
    const intent = account.firstIntent;
    if (!intent || intent.at < since || intent.at > until) continue;
    if (unknownAccounts.has(account._id)) { cohort.unknownHistory++; continue; }
    const first = firstPayment.get(account._id);
    if (first && first.paidAt < intent.at) { cohort.existingPayers++; continue; }
    cohort.eligible++;
    if (Date.parse(until) - Date.parse(intent.at) < 7 * DAY) { cohort.pending++; continue; }
    cohort.mature++;
    const converted = first && Date.parse(first.paidAt) - Date.parse(intent.at) <= 7 * DAY;
    if (converted) cohort.firstPaidD7++;
    const e = intent.experiment;
    const name = e ? `${e.id}:${e.assignmentVersion}:${e.mode}:${e.variant}` : 'unassigned';
    const group = cohort.byExperiment[name] || (cohort.byExperiment[name] = { mature: 0, firstPaidD7: 0, rate: null });
    group.mature++; if (converted) group.firstPaidD7++;
  }
  // Unknown history or truncated scans cannot substantiate a first-purchase denominator.
  const trustworthy = complete && !cohort.unknownHistory && !finance.duplicateTransactions;
  if (trustworthy && cohort.mature) cohort.rate = cohort.firstPaidD7 / cohort.mature;
  for (const group of Object.values(cohort.byExperiment)) if (trustworthy && group.mature) group.rate = group.firstPaidD7 / group.mature;
  const offers = new Set(), blocked = new Set(), traffic = new Set(), sessions = new Set(), reasons = {}, feedback = {};
  for (const e of events.filter(e => e.receivedAt >= since && e.receivedAt <= until)) {
    traffic.add(e.accountKey); sessions.add(`${e.accountKey}:${e.sessionId}`);
    if (e.eventName === 'purchase_feedback' && e.reasonCode && e.reasonCode.startsWith('feedback_')) feedback[e.reasonCode] = (feedback[e.reasonCode] || 0) + 1;
    if (e.eventName === 'offer_viewed') offers.add(e.accountKey);
    if (e.eventName === 'checkout_blocked') {
      blocked.add(e.accountKey);
      const key = `${e.platform}:${e.planId || 'unknown'}:${e.reasonCode || 'unknown'}`;
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
  const offerBlocked = [...blocked].filter(key => offers.has(key)).length;
  return { since, until, timezone: 'Asia/Shanghai', finance, cohort,
    traffic: { identifiedAccounts: traffic.size, sessions: sessions.size, anonymousAccounts: null, collectionEnabled: Boolean(config.features.growthEvents) },
    checkout: { offerAccounts: offers.size, blockedOfferAccounts: offerBlocked, rate: complete && offers.size ? offerBlocked / offers.size : null, reasons },
    feedback: { responses: feedback, interpretation: 'voluntary_responses_not_population_estimate' },
    activation: { rate: null, reason: 'historical_reminder_readiness_not_recorded' },
    coverage: { complete, scanLimit: REPORT_LIMIT, orders: orders.length, accounts: accounts.length, events: events.length,
      readMode: 'bounded_keyset_scan_not_atomic_snapshot', historicalEventsComplete: false, paymentHistoryComplete: complete,
      eventRetentionDays: EVENT_RETENTION_DAYS, intentDetailRetentionDays: INTENT_DETAIL_DAYS,
      revenueBasis: 'orders_paid_in_window_with_cumulative_refunds_as_read', paymentTimeBasis: 'server_first_verified_time_not_cashier_timestamp', collectionDelivery: 'best_effort_account_only',
      note: '数据为读取时快照；不含未接入或丢失的前端事件。未知付款、未知退款及样本截断不可当作零。' } };
}

async function report(ctx, payload) {
  if (!ctx.identity.isAdmin) throw new ApiError('forbidden', '需要管理员权限');
  const days = Number.isInteger(payload.days) && payload.days >= 7 && payload.days <= 90 ? payload.days : 30;
  const since = startOfDay(dayKey(addDays(ctx.now, -(days - 1)))).toISOString();
  const scans = await Promise.all([C.orders, C.growthAccounts, C.growthEvents].map(collection => ctx.repo.scanGrowthReport(collection, REPORT_LIMIT + 1, { remainingMs: ctx.remainingMs })));
  return buildReport({ orders: scans[0].rows.slice(0, REPORT_LIMIT), accounts: scans[1].rows.slice(0, REPORT_LIMIT), events: scans[2].rows.slice(0, REPORT_LIMIT),
    complete: scans.every(scan => scan.complete && scan.rows.length <= REPORT_LIMIT), since, until: ctx.nowIso, config: ctx.config });
}

module.exports = { ingest, report, classifyOrder, buildReport, REPORT_LIMIT };
