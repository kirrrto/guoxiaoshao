'use strict';
/**
 * Action router. `createHandler` is pure with respect to infrastructure: the
 * repository, upstream fetch and clock are injected so the same code runs in
 * the cloud function and in offline tests against the in-memory repository.
 *
 * Request:  { action: 'query.pickup', payload: {...} }
 * Response: { ok: true, data, serverTime, requestId }
 *        or { ok: false, error: { code, message, details }, serverTime, requestId }
 */
const { ApiError } = require('./errors');
const { mergeConfig } = require('./config');
const { resolveIdentity } = require('./identity');
const connection = require('./connection');
const users = require('./services/users');
const quota = require('./services/quota');
const catalog = require('./services/catalog');
const query = require('./services/query');
const queryAlternatives = require('./services/query-alternatives');
const history = require('./services/history');
const follows = require('./services/follows');
const member = require('./services/member');
const notify = require('./services/notify');
const notificationTest = require('./services/notification-test');
const admin = require('./services/admin');

const { version: VERSION } = require('../package.json');
const defaultClock = () => new Date();

/** action → [handler, requiresUser] */
const ACTIONS = {
  'system.ping': [async ctx => ({ version: VERSION, env: ctx.identity.env, appid: ctx.identity.appid, crossAccount: ctx.identity.crossAccount, hasUser: Boolean(ctx.identity.userKey), isAdmin: ctx.identity.isAdmin }), false],
  'user.bootstrap': [users.bootstrap, true],
  'user.updateSettings': [users.updateSettings, true],
  'catalog.get': [catalog.get, false],
  'quota.signin': [quota.signin, true],
  'quota.completeTask': [quota.completeTask, true],
  'quota.ledger': [quota.ledger, true],
  'query.pickup': [query.pickup, true],
  'query.recent': [query.recent, true],
  'query.alternatives': [queryAlternatives.alternatives, true],
  'history.list': [history.list, true],
  'history.browse': [history.browse, true],
  'follow.list': [follows.list, true],
  'follow.upsert': [follows.upsert, true],
  'follow.pause': [follows.pause, true],
  'follow.resume': [follows.resume, true],
  'follow.remove': [follows.remove, true],
  'member.status': [member.status, true],
  'member.createOrder': [member.createOrder, true],
  'member.checkOrder': [member.checkOrder, true],
  'member.abandonOrder': [member.abandonOrder, true],
  'member.deleteRecord': [member.deleteRecord, true],
  'member.clearRecords': [member.clearRecords, true],
  'member.redeemCode': [member.redeemCode, true],
  'notify.recordSubscription': [notify.recordSubscription, true],
  'notify.list': [notify.list, true],
  'notify.detail': [notify.detail, true],
  'notify.open': [notify.open, true],
  'notify.feedback': [notify.feedback, true],
  'notify.delete': [notify.remove, true],
  'notify.clear': [notify.clear, true],
  'notificationTest.status': [notificationTest.status, true],
  'notificationTest.authorize': [notificationTest.authorize, true],
  'notificationTest.send': [notificationTest.send, true],
  'notificationTest.feedback': [notificationTest.feedback, true],
  'admin.getConfig': [admin.getConfig, false],
  'admin.paymentStatus': [admin.paymentStatus, false],
  'admin.updateConfig': [admin.updateConfig, false],
  'admin.seedCatalog': [admin.seedCatalog, false],
  'admin.grantMembership': [admin.grantMembership, false],
  'admin.grantCredits': [admin.grantCredits, false],
  'admin.stats': [admin.stats, false],
  'admin.capacity': [admin.capacity, false],
  'admin.insights': [admin.insights, false],
  'admin.lookupUser': [admin.lookupUser, false],
};

function createHandler({ repo, fetchImpl, clock = defaultClock, log = console, allowedAppids = connection.allowedAppids, requestIdOf = () => null, paymentEnv, paymentProvider, notificationTestSender, notificationEnv, remainingMs = () => Infinity }) {
  return async function handle(event, wxContext) {
    const now = clock();
    const nowIso = now.toISOString();
    const requestId = requestIdOf();
    const action = event && typeof event.action === 'string' ? event.action : null;
    const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    const envelope = (body) => ({ ...body, serverTime: nowIso, requestId });

    try {
      const entry = action && ACTIONS[action];
      if (!entry) throw new ApiError('unknown_action', `未知操作：${String(action)}`);
      const stored = await repo.getConfig();
      const config = mergeConfig(stored);
      const identity = resolveIdentity(wxContext || {}, { allowedAppids, adminUserKeys: config.adminUserKeys });
      if (!identity.appAllowed) throw new ApiError('app_not_allowed', '该小程序未被允许访问');
      const [handler, requiresUser] = entry;
      if (requiresUser && !identity.userKey) throw new ApiError('user_required', '该操作需要小程序用户身份');
      const ctx = { repo, config, identity, now, nowIso, clock, fetchImpl, log, requestId, paymentEnv, paymentProvider, notificationTestSender, notificationEnv, remainingMs,
        paymentCacheAllowed: clock === defaultClock };
      const data = await handler(ctx, payload);
      return envelope({ ok: true, data });
    } catch (error) {
      if (error instanceof ApiError) {
        return envelope({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
      }
      log.error(`[gxs_api] ${action} failed`, error && error.stack ? error.stack : error);
      return envelope({ ok: false, error: { code: 'internal_error', message: '服务暂时不可用，请稍后再试', details: null } });
    }
  };
}

module.exports = { createHandler, ACTIONS, VERSION };
