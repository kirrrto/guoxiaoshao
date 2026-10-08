'use strict';
const { randomUUID } = require('node:crypto');
const { ApiError } = require('../errors');
const { ensureUser, quotaSnapshot } = require('./users');
const { isValidTemplateId } = require('../config');
const { createWechatSender } = require('../engine/wechat-sender');
const { buildMessage } = require('../engine/notifier');
const PAGE = 'pages/notification-test/index';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
function requestId(payload) {
  if (!validId(payload.requestId)) throw new ApiError('invalid_request_id', '测试需要有效的请求编号');
  return payload.requestId;
}
function senderFor(ctx) {
  if (ctx.notificationTestSender) return ctx.notificationTestSender;
  const env = ctx.notificationEnv || process.env;
  return createWechatSender({ appid: env.GXS_CONSUMER_APPID, appSecret: env.GXS_CONSUMER_APPSECRET,
    expectedAppid: ctx.config.notifications.consumerAppId, fetchImpl: ctx.fetchImpl, clock: ctx.clock });
}
function readiness(ctx, sender) {
  const templateId = ctx.config.notifications.templateIds.restock;
  const reason = !ctx.config.notifications.enabled ? 'notifications_disabled' : !isValidTemplateId(templateId) ? 'template_missing'
    : sender.enabled === false ? sender.disabledReason || 'sender_missing' : null;
  return { ready: !reason, reason, templateId: isValidTemplateId(templateId) ? templateId : null };
}
function present(value) {
  const r = value.record;
  return { balance: value.balance, quotaRevision: value.quotaRevision, test: r ? {
    requestId: r.requestId, status: r.status, reason: r.reason, charged: r.charged, refunded: r.refunded,
    createdAt: r.createdAt, settledAt: r.settledAt || null, firstOpenedAt: r.firstOpenedAt || null, firstPresentedAt: r.firstPresentedAt || null, feedback: r.feedback && r.feedback.outcome || null,
  } : null };
}
async function status(ctx, payload) {
  const user = await ensureUser(ctx);
  if (payload.requestId !== undefined) requestId(payload);
  let value = (payload.opened === true || payload.presented === true) && payload.requestId
    ? await ctx.repo.openNotificationTest({ userKey: user._id, requestId: payload.requestId, nowIso: ctx.nowIso, presented: payload.presented === true })
    : await ctx.repo.getNotificationTest({ userKey: user._id, requestId: payload.requestId, nowIso: ctx.nowIso });
  const ready = readiness(ctx, senderFor(ctx));
  if (value.record && value.record.status === 'authorized' && value.record.templateId !== ready.templateId) {
    value = await ctx.repo.retireNotificationTestAuthorization({ userKey: user._id, requestId: value.record.requestId, nowIso: ctx.nowIso });
  }
  const current = await ctx.repo.getUser(user._id);
  return { ...present(value), ...ready, cost: 1, userKey: user._id, quota: await quotaSnapshot(ctx, current) };
}
async function authorize(ctx, payload) {
  const user = await ensureUser(ctx), id = requestId(payload);
  const ready = readiness(ctx, senderFor(ctx));
  if (!ready.ready) throw new ApiError('test_unavailable', '微信通知测试暂未开放，请稍后再试');
  if (!['accept', 'reject', 'ban'].includes(payload.result) || payload.templateId !== ready.templateId) throw new ApiError('invalid_subscription_result', '请使用当前测试模板完成微信授权');
  return present(await ctx.repo.authorizeNotificationTest({ userKey: user._id, requestId: id, templateId: ready.templateId, result: payload.result, nowIso: ctx.nowIso }));
}
function testMessage(record, config) {
  const message = buildMessage({ templateId: record.templateId, detectedAt: record.createdAt, productTitle: '【测试】通知体验', storeName: '【测试】服务通知' }, config);
  const fields = { product: 'thing1', store: 'thing2', time: 'time3', status: 'thing4', ...config.notifications.templateFields };
  const values = { product: '【测试】通知体验', store: '【测试】服务通知', status: '【测试】非到货提醒', quantity: '【测试】无库存信息' };
  for (const [slot, value] of Object.entries(values)) if (fields[slot]) message.data[fields[slot]] = {
    value: fields[slot].startsWith('phrase') ? '测试' : fields[slot].startsWith('number') ? '0' : value,
  };
  return { ...message, page: `${PAGE}?requestId=${encodeURIComponent(record.requestId)}` };
}
async function send(ctx, payload) {
  const user = await ensureUser(ctx), id = requestId(payload), sender = senderFor(ctx), ready = readiness(ctx, sender);
  // Replays remain readable even if sending was disabled after the first call.
  const previous = await ctx.repo.getNotificationTest({ userKey: user._id, requestId: id, nowIso: ctx.nowIso });
  if (previous.record && previous.record.status !== 'authorized') return present(previous);
  if (!ready.ready) throw new ApiError('test_unavailable', '微信通知测试暂未开放，本次未扣次');
  const remaining = () => typeof ctx.remainingMs === 'function' ? ctx.remainingMs() : Infinity;
  // A fresh debit needs time for admission, the message request, and durable
  // settlement. Replays above remain readable without beginning another send.
  if (remaining() <= 9000) throw new ApiError('request_budget_exhausted', '连接耗时较长，本次尚未发起发送或扣次，请继续原测试');
  const ownerId = randomUUID();
  const begun = await ctx.repo.beginNotificationTest({ userKey: user._id, requestId: id, templateId: ready.templateId, ownerId, nowIso: ctx.clock().toISOString() });
  if (!begun.acquired) return present(begun);
  let outcome;
  try {
    // Reserve six seconds for settlement/refund even when preceding database
    // calls consumed most of this invocation's limit.
    const timeoutMs = Math.floor(Math.min(8000, remaining() - 6000, Date.parse(begun.record.leaseUntil) - ctx.clock().getTime() - 1000));
    if (timeoutMs < 1000) throw { definitelyNotSent: true, code: 'test_send_deadline' };
    const response = await sender({ ...testMessage(begun.record, ctx.config), appid: user.appid, touser: user.openid,
      miniprogramState: ctx.config.notifications.miniprogramState || 'formal', lang: 'zh_CN' }, { timeoutMs });
    const code = response && (response.errcode ?? response.errCode);
    const validCode = (typeof code === 'number' || typeof code === 'string' && /^-?\d+$/.test(code)) && Number.isSafeInteger(Number(code));
    outcome = !validCode ? { status: 'uncertain', reason: 'invalid_platform_response' }
      : Number(code) === 0 ? { status: 'accepted', reason: null }
      : { status: 'failed', reason: Number(code) === 43101 ? 'needs_authorization' : `wx_${Number(code)}` };
  } catch (error) {
    outcome = { status: error && error.definitelyNotSent ? 'failed' : 'uncertain', reason: error && error.definitelyNotSent ? 'not_sent' : 'transport_unknown' };
  }
  const finish = () => ctx.repo.finishNotificationTest({ userKey: user._id, requestId: id, ownerId, ...outcome, nowIso: ctx.clock().toISOString() });
  let finished;
  try { finished = await finish(); } catch { finished = await finish(); } // Idempotent settlement may retry; sending never does.
  return present(finished);
}
async function feedback(ctx, payload) {
  const user = await ensureUser(ctx), id = requestId(payload);
  if (!['received', 'not_received'].includes(payload.outcome)) throw new ApiError('invalid_feedback', '请选择收到或没收到');
  return present(await ctx.repo.feedbackNotificationTest({ userKey: user._id, requestId: id, outcome: payload.outcome, nowIso: ctx.nowIso }));
}
module.exports = { status, authorize, send, feedback, testMessage };
