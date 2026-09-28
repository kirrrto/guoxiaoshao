'use strict';
const { randomUUID } = require('node:crypto');
const { mergeConfig } = require('../config');
const connection = require('../connection');
const { paymentTimerIdentity } = require('./timer-context');
const { PaymentProtocolError } = require('./errors');

const CALLBACK_PATH = '/payment/callback';
const TRIGGER_NAME = 'gxs-payment-reconcile-five-minutes';
const LEASE_ID = 'payment_reconcile_lease';
const MAX_RUN_MS = 25000;
const CALL_BUDGET_MS = 12000;
const LEASE_MS = 60000;
const QUERY_ALIASES = { signature: 'signature', timestamp: 'timestamp', nonce: 'nonce', echostr: 'echostr', msg_signature: 'msg_signature', encrypt_type: 'encrypt_type' };
const defaultClock = () => new Date();
const own = (value, key) => value && Object.prototype.hasOwnProperty.call(value, key);
const hasHttpEnvelope = event => Boolean(event && (own(event, 'httpMethod') || own(event, 'requestContext') || own(event, 'rawPath')));
const response = (statusCode, body) => ({ statusCode, body, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, isBase64Encoded: false });
const callbackPathOf = event => String(event.path || event.rawPath || '').split('?')[0];
function parseHttpQuery(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') {
    const query = {};
    for (const part of raw.replace(/^\?/, '').split('&')) {
      if (!part) continue;
      const at = part.indexOf('=');
      const key = decodeURIComponent(at < 0 ? part : part.slice(0, at));
      const value = decodeURIComponent((at < 0 ? '' : part.slice(at + 1)).replace(/\+/g, ' '));
      query[key] = value;
    }
    return query;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const query = {};
  for (const [key, value] of Object.entries(raw)) {
    const item = Array.isArray(value) ? value[0] : value;
    if (item == null) continue;
    query[key] = String(item);
  }
  return query;
}
function normalizeCallbackQuery(query) {
  const normalized = { ...query };
  for (const [key, value] of Object.entries(query)) {
    const alias = QUERY_ALIASES[String(key).toLowerCase()];
    if (alias && normalized[alias] == null) normalized[alias] = value;
  }
  return normalized;
}
function callbackQuery(event) {
  for (const name of ['queryStringParameters', 'queryString', 'query', 'multiValueQueryStringParameters']) {
    const parsed = parseHttpQuery(event[name]);
    if (Object.keys(parsed).length) return { query: normalizeCallbackQuery(parsed), source: name };
  }
  return { query: {}, source: 'absent' };
}
function httpVerificationDiagnostics(event, queryMeta, error) {
  const keys = Object.keys(queryMeta.query).map(key => String(key).toLowerCase());
  return {
    stage: 'verification',
    code: error instanceof PaymentProtocolError ? error.code : 'other',
    method: typeof event.httpMethod === 'string' && ['GET', 'POST'].includes(event.httpMethod.toUpperCase()) ? event.httpMethod.toUpperCase() : 'other',
    querySource: queryMeta.source,
    queryFields: ['signature', 'timestamp', 'nonce', 'echostr', 'msg_signature', 'encrypt_type'].filter(key => keys.includes(key)),
    extraQueryKeyCount: keys.filter(key => !QUERY_ALIASES[key]).length,
  };
}
const RUNTIME_KEYS = ['TRIGGER_SRC', 'TENCENTCLOUD_RUNENV', 'TCB_SOURCE', 'WX_OPENID', 'WX_FROM_OPENID', 'WX_FROM_APPID', 'FROM_OPENID', 'FROM_APPID'];
function timerDenialDiagnostics(event, context, wxContext, runtime, invocationEnv, injectedEnv) {
  const classify = (value, allowed) => typeof value !== 'string' || !value.trim() ? 'absent' : allowed.includes(value.trim()) ? value.trim() : 'other';
  const sourceClass = value => {
    if (typeof value !== 'string' || !value.trim()) return 'absent';
    const chain = value.split(',').map(part => part.trim());
    if (chain.length > 1 && !chain.slice(1).every(part => part === 'scf')) return 'other';
    return classify(chain[0], ['wx_trigger', 'wx_client', 'wx_devtools', 'wx_localdebug', 'scf']);
  };
  let environmentKeys = [];
  try {
    const provided = typeof context.environment === 'string' ? JSON.parse(context.environment) : context.environment;
    if (provided && typeof provided === 'object' && !Array.isArray(provided)) environmentKeys = Object.keys(provided).filter(key => RUNTIME_KEYS.includes(key));
    else if (typeof context.environ === 'string') environmentKeys = context.environ.split(';').map(item => item.slice(0, item.indexOf('='))).filter(key => RUNTIME_KEYS.includes(key));
  } catch { /* The invalidContext boolean below reports parsing failure. */ }
  return {
    typeMatches: event.Type === 'Timer', triggerNameMatches: event.TriggerName === TRIGGER_NAME, invalidContext: runtime.invalidContext === true,
    invocationScoped: runtime.invocationScoped === true,
    injectedEnvironment: injectedEnv !== undefined, environmentIsCurrent: invocationEnv === process.env,
    invocationEnvironmentProvided: context.environment != null || typeof context.environ === 'string',
    contextKeys: Object.keys(context).filter(key => ['environment', 'environ', 'request_id', 'requestId', 'function_name', 'function_version', 'namespace', 'time_limit_in_ms', 'memory_limit_in_mb'].includes(key)),
    environmentKeys: [...new Set(environmentKeys)],
    sdkSource: sourceClass(wxContext.SOURCE), runtimeSource: sourceClass(runtime.TCB_SOURCE),
    sdkHasOpenid: Boolean(wxContext.OPENID), sdkHasFromOpenid: Boolean(wxContext.FROM_OPENID), sdkHasFromAppid: Boolean(wxContext.FROM_APPID),
    runtimeHasOpenid: Boolean(runtime.WX_OPENID), runtimeHasFromOpenid: Boolean(runtime.WX_FROM_OPENID || runtime.FROM_OPENID), runtimeHasFromAppid: Boolean(runtime.WX_FROM_APPID || runtime.FROM_APPID),
    triggerSource: classify(runtime.TRIGGER_SRC, ['timer', 'client', 'http']), runEnvironment: classify(runtime.TENCENTCLOUD_RUNENV, ['SCF']),
  };
}

/** Only SDK / invocation-context platform markers are trusted, never event fields. */
function isTrustedPaymentTimer(event, wxContext = {}, runtime = {}) {
  if (runtime.invalidContext || !event || event.Type !== 'Timer' || event.TriggerName !== TRIGGER_NAME || hasHttpEnvelope(event)) return false;
  if (wxContext.OPENID || wxContext.FROM_OPENID || wxContext.FROM_APPID || runtime.WX_OPENID || runtime.WX_FROM_OPENID || runtime.WX_FROM_APPID || runtime.FROM_OPENID || runtime.FROM_APPID) return false;
  const sources = [wxContext.SOURCE, runtime.TCB_SOURCE].filter(value => typeof value === 'string' && value.trim());
  if (sources.length) return sources.every(source => {
    const chain = source.split(',').map(value => value.trim());
    return chain[0] === 'wx_trigger' && chain.slice(1).every(value => value === 'scf');
  });
  // TRIGGER_SRC is only trusted when THIS invocation's platform context
  // supplied it. A warm mixed-use container keeps the previous real timer's
  // process.env, so an anonymous cloud-API call must not inherit that marker.
  return runtime.invocationScoped === true && runtime.TRIGGER_SRC === 'timer' && runtime.TENCENTCLOUD_RUNENV === 'SCF';
}

function callbackMatchesOrder(event, order) {
  if (!order || typeof order._id !== 'string' || !order._id || order.provider !== 'wechat_virtual_payment' || order.type !== 'membership_order') return false;
  const snapshot = order.paymentSnapshot;
  if (!snapshot || snapshot.provider !== 'wechat_virtual_payment' || snapshot.appid !== connection.consumerAppid || order.appid !== snapshot.appid || event.authenticatedAppid !== order.appid) return false;
  if (typeof order.openid !== 'string' || !order.openid || event.openid !== order.openid || order.userKey !== `${order.appid}:${order.openid}` || event.outTradeNo !== order.outTradeNo) return false;
  if (snapshot.productId !== order.productId || snapshot.priceFen !== order.amountFen || snapshot.days !== order.days || snapshot.buyQuantity !== 1 || snapshot.currency !== 'CNY' || snapshot.env !== 0) return false;
  // Some official iOS / refund events omit goods or transaction fields. Missing
  // fields require the authoritative query below; present contradictions fail.
  if (event.productId !== null && event.productId !== order.productId) return false;
  if (event.quantity !== null && event.quantity !== snapshot.buyQuantity) return false;
  if (event.amountFen !== null && event.amountFen !== order.amountFen) return false;
  if (event.env !== null && event.env !== snapshot.env) return false;
  if (event.transactionId && order.transactionId && event.transactionId !== order.transactionId) return false;
  if (event.attach !== null && event.attach !== order.outTradeNo) return false;
  return true;
}

function createPaymentEntry({ repo, fetchImpl = globalThis.fetch, clock = defaultClock, env,
  log = console, paymentProvider, reconcileOrderImpl, paymentProviderForImpl, handleAction }) {
  // Lazy loading keeps this infrastructure boundary injectable in offline tests.
  const reconcile = (...args) => (reconcileOrderImpl || require('./service').reconcileOrder)(...args);
  const providerFor = ctx => paymentProvider || (paymentProviderForImpl || require('./service').paymentProviderFor)(ctx);
  const contextFor = async invocationEnv => {
    const now = clock();
    return { repo, config: mergeConfig(await repo.getConfig()), fetchImpl, clock, now, nowIso: now.toISOString(),
      paymentEnv: invocationEnv, paymentProvider, paymentCacheAllowed: clock === defaultClock, log,
      identity: { appid: connection.consumerAppid, userKey: null, isOperator: false, isAdmin: false } };
  };
  const warn = stage => { if (log && typeof log.warn === 'function') log.warn('[gxs_api] payment entry failed', { stage }); };

  async function http(event, invocationEnv) {
    const path = callbackPathOf(event);
    const rawPath = typeof event.rawPath === 'string' ? event.rawPath.split('?')[0] : '';
    if (path !== CALLBACK_PATH || rawPath && rawPath !== CALLBACK_PATH) return response(403, 'forbidden');
    const method = String(event.httpMethod || event.requestContext && event.requestContext.http && event.requestContext.http.method || '').toUpperCase();
    if (!['GET', 'POST'].includes(method)) return response(405, 'method not allowed');
    let queryMeta;
    // Raw HTTP query strings are untrusted. Invalid percent encoding must be
    // rejected at this boundary, before decoding can escape the HTTP handler.
    try { queryMeta = callbackQuery(event); }
    catch { return response(403, 'forbidden'); }
    let stage = 'configuration';
    try {
      const ctx = await contextFor(invocationEnv), provider = providerFor(ctx);
      ctx.paymentProvider = provider;
      stage = 'verification';
      const verified = provider.verifyCallback({ method, query: queryMeta.query, body: event.body, isBase64Encoded: event.isBase64Encoded === true });
      if (verified.kind === 'challenge' && method === 'GET') return response(200, verified.echo);
      if (method !== 'POST' || verified.kind !== 'event' || verified.encrypted !== true || !['xpay_goods_deliver_notify', 'xpay_refund_notify'].includes(verified.event)) return response(403, 'forbidden');
      stage = 'order_lookup';
      if (typeof verified.outTradeNo !== 'string' || !/^(?!_)[A-Za-z0-9_-]{8,32}$/.test(verified.outTradeNo)) return response(403, 'forbidden');
      const order = await repo.getOrderByOutTradeNo(verified.outTradeNo);
      if (!callbackMatchesOrder(verified, order)) return response(403, 'forbidden');
      if (verified.event === 'xpay_refund_notify' && (!Number.isSafeInteger(verified.refundResultCode)
        || verified.refundResultCode === 0 && (!Number.isSafeInteger(verified.refundAmountFen) || verified.refundAmountFen <= 0 || typeof verified.refundId !== 'string' || !verified.refundId))) return response(403, 'forbidden');
      stage = 'reconciliation';
      const result = await reconcile(ctx, order, { acknowledge: false });
      const settled = result && result.order;
      // A delivery callback is acknowledged only after durable fulfilment or a
      // fully refunded terminal order. Unpaid / absent / uncertain queries retry.
      if (!settled || !(settled.status === 'refunded' || (settled.fulfilledAt || settled.entitlementFulfilled === true) && ['fulfilled', 'partially_refunded'].includes(settled.status))) return response(503, 'retry');
      if (verified.event === 'xpay_refund_notify' && verified.refundResultCode === 0) {
        stage = 'refund_confirmation';
        const receipt = await repo.confirmPaymentRefundCallback({ orderId: settled._id, refundId: verified.refundId,
          refundFen: verified.refundAmountFen, nowIso: clock().toISOString() });
        if (!receipt.confirmed) return response(503, 'retry');
      }
      // Safe-mode message pushes permit plain "success" without an encrypted
      // response envelope. The virtual-payment detailed notification contract
      // explicitly equates it to ErrCode=0 (the personal guide has a brief XML example).
      // https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html (2.4)
      // https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html (safe-mode replies)
      return response(200, provider.callbackSuccess());
    } catch (error) {
      if (stage === 'verification' && log && typeof log.warn === 'function') log.warn('[gxs_api] payment entry failed', httpVerificationDiagnostics(event, queryMeta, error));
      else warn(stage);
      return response(stage === 'verification' ? 403 : 503, stage === 'verification' ? 'forbidden' : 'retry');
    }
  }

  async function scheduled(invocationEnv) {
    if (invocationEnv.GXS_ENABLE_PAYMENT_RECONCILE !== 'true') return { ok: true, state: 'process_disabled', scanned: 0 };
    const ownerId = `payment-timer-${randomUUID()}`, started = clock().getTime(), deadline = started + MAX_RUN_MS;
    let scanned = 0, reconciled = 0, failed = 0, held = false;
    const acquire = async () => {
      const now = clock();
      return (await repo.acquireLease({ id: LEASE_ID, ownerId, now: now.toISOString(), expiresAt: new Date(now.getTime() + LEASE_MS).toISOString() })).acquired;
    };
    try {
      held = await acquire();
      if (!held) return { ok: true, state: 'standby', scanned };
      const ctx = await contextFor(invocationEnv); ctx.paymentProvider = providerFor(ctx);
      const orders = await repo.listReconcileOrders({ limit: 10, nowIso: ctx.nowIso });
      for (const order of orders) {
        if (clock().getTime() + CALL_BUDGET_MS > deadline) break;
        if (!await acquire()) { held = false; return { ok: true, state: 'lease_lost', scanned, reconciled, failed }; }
        scanned++;
        try {
          const now = clock();
          await reconcile({ ...ctx, now, nowIso: now.toISOString() }, order, { acknowledge: true });
          reconciled++;
        } catch { failed++; warn('scheduled_order'); }
        finally {
          // Failed orders rotate too, so one persistent upstream error cannot
          // starve new paid orders. This patch never changes payment status.
          try { await repo.updateOrder(order._id, { lastReconciledAt: clock().toISOString() }); }
          catch { warn('scheduled_progress'); }
        }
      }
      return { ok: true, state: 'completed', scanned, reconciled, failed, deadlineReached: clock().getTime() + CALL_BUDGET_MS > deadline };
    } catch { warn('scheduled_scan'); return { ok: false, state: 'retry', scanned, reconciled, failed }; }
    finally {
      if (held) {
        try { await repo.releaseLease({ id: LEASE_ID, ownerId }); }
        catch { warn('scheduled_release'); }
      }
    }
  }

  return async function main(event = {}, context = {}, wxContext = {}) {
    // Cloud runtimes may replace process.env between warm invocations. Resolve
    // it alongside this invocation's SDK context, not when the factory loads.
    // Explicit test/dependency injection remains stable and isolated.
    const invocationEnv = env === undefined ? process.env : env;
    // HTTP is never permitted to fall through into ordinary user/admin actions,
    // including malformed envelopes containing an empty httpMethod.
    if (hasHttpEnvelope(event)) return http(event, invocationEnv);
    if (event.Type === 'Timer' || own(event, 'TriggerName')) {
      const timerIdentity = paymentTimerIdentity(context, wxContext, invocationEnv);
      const runtime = timerIdentity.runtime;
      if (!isTrustedPaymentTimer(event, timerIdentity.wxContext, runtime)) {
        if (invocationEnv.GXS_ENABLE_PAYMENT_RECONCILE !== 'true' && log && typeof log.warn === 'function') {
          log.warn('[gxs_api] payment timer rejected', timerDenialDiagnostics(event, context, wxContext, runtime, invocationEnv, env));
        }
        return { ok: false, reason: 'timer_only' };
      }
      return scheduled(invocationEnv);
    }
    return handleAction(event, wxContext, context);
  };
}

module.exports = { createPaymentEntry, isTrustedPaymentTimer, callbackMatchesOrder, CALLBACK_PATH, TRIGGER_NAME, LEASE_ID, MAX_RUN_MS };
