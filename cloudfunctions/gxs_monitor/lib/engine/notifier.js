'use strict';
/**
 * Turn recognised events into notification tasks and send them.
 *
 * Matching is re-checked at send time (membership, follow active, DND,
 * global switch, subscription credit) — never trusted from when the follow
 * was created. One user receives at most one task per event even when several
 * of their follows overlap. Task ids are deterministic so retries dedupe.
 *
 * Sending is injected (`sendImpl`) so this module has no WeChat dependency;
 * the worker passes the sender authenticated for the consumer mini program.
 */
const { NOTIFIABLE_TYPES } = require('./events');
const { canUseReminders, reminderBlockReason, isMember } = require('../rules/membership');
const { inMinuteWindow } = require('../time');
const { isValidTemplateId } = require('../config');
const { targetSnapshot } = require('../notification-target');

const TASK_STATUS = Object.freeze({ pending: 'pending', sending: 'sending', accepted: 'accepted', failed: 'failed', uncertain: 'uncertain', skipped: 'skipped' });

function taskId(userKey, eventId) {
  return `${userKey}|${eventId}`;
}

/** The alert an event sends: 'restock', 'soldout' (needs its own template) or null. */
function alertKind(type) {
  if (NOTIFIABLE_TYPES.has(type)) return 'restock';
  if (type === 'became_unavailable') return 'soldout';
  return null;
}

function templateIdFor(kind, config) {
  const ids = config.notifications.templateIds || {};
  return ids[kind] || null;
}

const DEFAULT_FIELDS = Object.freeze({ product: 'thing1', store: 'thing2', time: 'time3', status: 'thing4' });

/**
 * Build tasks for one batch of events. `follows` are active follows (any user),
 * `users` a Map userKey → user. Returns tasks including skipped ones with reasons,
 * so the audit trail explains every non-delivery.
 */
function buildTasks({ events, follows, users, config, now }) {
  const tasks = [];
  for (const event of events) {
    const kind = alertKind(event.type);
    if (!kind) continue;
    const templateId = templateIdFor(kind, config);
    // Sold-out alerts are optional: without their own template none are planned.
    if (kind === 'soldout' && !isValidTemplateId(templateId)) continue;
    const matching = follows.filter(f => f.partNumber === event.partNumber && f.storeNumbers.includes(event.storeNumber));
    const seen = new Set();
    for (const follow of matching) {
      if (seen.has(follow.userKey)) continue;
      seen.add(follow.userKey);
      const user = users.get(follow.userKey);
      // The free alert is a restock alert; sold-out alerts are a member feature.
      if (kind === 'soldout' && user && !isMember(user, now)) continue;
      const base = {
        _id: taskId(follow.userKey, event._id), userKey: follow.userKey, followId: follow._id, eventId: event._id, eventType: event.type,
        partNumber: event.partNumber, storeNumber: event.storeNumber, storeName: event.storeName || null, productTitle: event.productTitle || follow.productTitle || null,
        targetSnapshot: targetSnapshot(follow),
        detectedAt: event.detectedAt, createdAt: now.toISOString(), templateId: templateId || null, status: TASK_STATUS.pending, reason: null, sentAt: null, attempts: 0,
      };
      const skip = reason => tasks.push({ ...base, status: TASK_STATUS.skipped, reason });
      if (!config.notifications.enabled) { skip('notifications_disabled'); continue; }
      if (!isValidTemplateId(templateId)) { skip('template_missing'); continue; }
      if (!user) { skip('user_missing'); continue; }
      if (!canUseReminders(user, now)) { skip(reminderBlockReason(user)); continue; }
      if (follow.status !== 'active') { skip('follow_not_active'); continue; }
      if (user.settings && user.settings.notifyEnabled === false) { skip('user_disabled'); continue; }
      const dnd = user.settings && user.settings.dnd;
      if (dnd && dnd.enabled && inMinuteWindow(now, dnd.startMinute, dnd.endMinute)) { skip('dnd'); continue; }
      const sub = user.subscriptions && user.subscriptions[templateId];
      if (!sub || sub.credits <= 0) { skip('no_subscription_credit'); continue; }
      tasks.push(base);
    }
  }
  return tasks;
}

const plainText = value => String(value || '').replace(/<[^>]+>/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (value, max) => Array.from(plainText(value)).slice(0, max).join('') || '—';

/** Keep the exact capacity and colour together; use SKU if a full descriptor cannot fit. */
function compactProduct(task) {
  const title = plainText(task.productTitle);
  const compact = title.replace(/(\d+(?:\.\d+)?)\s*GB\b/gi, '$1G').replace(/(\d+(?:\.\d+)?)\s*TB\b/gi, '$1T').replace(/Pro\s+Max/g, 'ProMax');
  const withoutBrand = compact.replace(/^iPhone\s*/i, '').replace(/勃艮第酒红色/g, '酒红色');
  const candidate = [title, compact, withoutBrand].find(value => value && Array.from(value).length <= 20);
  return candidate || clip(task.partNumber || title, 20);
}

/** WeChat rejects overlong thing fields; keep all values within the documented limits. */
function buildMessage(task, config) {
  const time = new Date(task.detectedAt);
  const beijing = new Date(time.getTime() + 8 * 60 * 60 * 1000);
  const hh = String(beijing.getUTCHours()).padStart(2, '0');
  const mm = String(beijing.getUTCMinutes()).padStart(2, '0');
  const ss = String(beijing.getUTCSeconds()).padStart(2, '0');
  const wording = { first_seen_available: '发现可取货', restock_confirmed: '确认补货', recovered_available: '恢复可取货' }[task.eventType] || '可取货';
  const soldOut = alertKind(task.eventType) === 'soldout';
  const fields = { ...DEFAULT_FIELDS, ...((soldOut ? config.notifications.soldoutFields : config.notifications.templateFields) || {}) };
  const page = config.notifications.page || 'pages/follow/index';
  const values = {
    product: compactProduct(task),
    store: clip(task.storeName || task.storeNumber, 20),
    time: `${beijing.getUTCFullYear()}年${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${hh}:${mm}:${ss}`,
    // Template 524 calls this slot "预约项目". Describe the real watch item,
    // without fabricating an order, reservation or a successful purchase.
    status: soldOut ? (fields.status && fields.status.startsWith('phrase') ? '已断货' : '已断货，本轮补货结束')
      : config.notifications.contentMode === 'watch_item' ? '商品到货关注' : wording,
    // "到货数量": Apple shows that a store can hand one over today, never how many.
    // Sold out: nothing left for pickup, which a number field states as 0.
    quantity: soldOut ? (!fields.quantity ? null : fields.quantity.startsWith('number') ? '0' : fields.quantity.startsWith('phrase') ? '无货' : '暂无现货')
      : fields.quantity && fields.quantity.startsWith('phrase') ? '有现货' : '有现货，具体数量以门店为准',
  };
  const data = {};
  for (const [slot, key] of Object.entries(fields)) if (key) data[key] = { value: values[slot] };
  return {
    templateId: task.templateId,
    // The follow page reads this alert back by event ID, scoped to the account that opens it.
    page: task.eventId ? `${page}${page.includes('?') ? '&' : '?'}eid=${encodeURIComponent(task.eventId)}` : page,
    data,
  };
}

/**
 * Send one pending task. Result statuses:
 *  accepted  — WeChat accepted the message (errcode 0);
 *  failed    — WeChat rejected it (invalid template, user refused, quota…);
 *  uncertain — transport timeout/exception: the message may or may not have
 *              been accepted, so it is NOT retried blindly.
 */
function skipReason({ task, user, follow, config, now, senderAppid }) {
  const settings = user && user.settings;
  if (!config.notifications.enabled) return 'notifications_disabled';
  const kind = alertKind(task.eventType) || 'restock';
  if (!isValidTemplateId(task.templateId) || templateIdFor(kind, config) !== task.templateId) return 'template_changed';
  if (!user) return 'member_expired';
  if (!canUseReminders(user, now)) return reminderBlockReason(user);
  if (kind === 'soldout' && !isMember(user, now)) return 'member_expired';
  if (senderAppid && user.appid !== senderAppid) return 'consumer_appid_mismatch';
  if (!user.openid) return 'openid_missing';
  if (!follow || follow.status !== 'active' || follow.userKey !== task.userKey || follow.partNumber !== task.partNumber || !follow.storeNumbers.includes(task.storeNumber)) return 'follow_not_active';
  if (settings && settings.notifyEnabled === false) return 'user_disabled';
  if (settings && settings.dnd && settings.dnd.enabled && inMinuteWindow(now, settings.dnd.startMinute, settings.dnd.endMinute)) return 'dnd';
  if (now.getTime() - Date.parse(task.detectedAt) > (config.notifications.maxEventAgeSeconds || 120) * 1000) return 'event_expired';
  return null;
}

/** A claimed task is never replayed after an ambiguous send or worker crash. */
async function sendTask({ task, config, sendImpl, repo, now, ownerId = 'notifier', clock = () => now, beforeSend = async () => true, remainingMs = () => Infinity }) {
  if (!sendImpl || sendImpl.enabled === false) return { ...task, deliveryDisabled: sendImpl ? sendImpl.disabledReason : 'sender_missing' };
  if (remainingMs() <= 1000) return task;
  const claim = await repo.claimNotification({ id: task._id, ownerId, now: now.toISOString(), leaseUntil: new Date(now.getTime() + 60000).toISOString() });
  if (!claim.claimed) return claim.task || task;
  task = claim.task;
  const finish = async patch => {
    await repo.updateNotification(task._id, patch);
    return { ...task, ...patch };
  };
  const canStart = async () => remainingMs() > 1000 && await beforeSend() && remainingMs() > 1000;
  const defer = () => finish({ status: TASK_STATUS.pending, reason: 'send_deferred', ownerId: null, leaseUntil: null, sentAt: null,
    subscriptionReserved: false, subscriptionReleased: false, subscriptionInvalidated: false, subscriptionTemplateId: null,
    subscriptionCreditSequence: null, subscriptionCreditHighWater: null, cooldownId: null });
  // Read after the claim, rather than trusting task-planning snapshots.
  const user = await repo.getUser(task.userKey);
  const follow = await repo.getFollow(task.followId);
  const { mergeConfig } = require('../config');
  config = mergeConfig(await repo.getConfig());
  now = clock();
  const reason = skipReason({ task, user, follow, config, now, senderAppid: sendImpl.appid || config.notifications.consumerAppId });
  if (reason) return finish({ status: TASK_STATUS.skipped, reason, sentAt: null });
  if (!await canStart()) return defer();
  // Restock and sold-out alerts cool down separately, so one never blocks the other.
  const targetKey = `${alertKind(task.eventType) === 'soldout' ? 'soldout|' : ''}${task.storeNumber}|${task.partNumber}`;
  const reservation = await repo.reserveSubscriptionCredit({ userKey: task.userKey, templateId: task.templateId, taskId: task._id, now: now.toISOString(), targetKey, cooldownMinutes: config.notifications.cooldownMinutes || 0 });
  if (!reservation.reserved) return finish({ status: TASK_STATUS.skipped, reason: reservation.reason || 'no_subscription_credit', sentAt: null });
  // A reservation transaction may outlast the worker's deadline or lease.
  // No message endpoint has been called yet, so refund and defer safely.
  if (!await canStart()) {
    await repo.releaseSubscriptionCredit({ userKey: task.userKey, templateId: task.templateId, taskId: task._id, now: clock().toISOString() });
    await repo.settleFirstReminder({ userKey: task.userKey, taskId: task._id, sent: false, now: clock().toISOString() });
    return defer();
  }
  const timeoutMs = Math.max(1, Math.min(8000, Math.floor(remainingMs()) - 1000));
  let outcome;
  try {
    const response = await sendImpl({ touser: user.openid, appid: user.appid, ...buildMessage(task, config), miniprogramState: config.notifications.miniprogramState || 'formal', lang: 'zh_CN' }, { timeoutMs });
    const code = response && (response.errCode ?? response.errcode);
    if (code === undefined || !Number.isFinite(Number(code))) outcome = { status: TASK_STATUS.uncertain, reason: 'invalid_platform_response' };
    else if (Number(code) === 0) outcome = { status: TASK_STATUS.accepted, reason: null };
    else outcome = { status: TASK_STATUS.failed, reason: Number(code) === 43101 ? 'subscription_authorization_expired' : `wx_${Number(code)}` };
  } catch (error) {
    // Unknown exceptions after handing off may already have delivered. Only an
    // adapter explicitly proving the send never started can release the credit.
    outcome = { status: error && error.definitelyNotSent ? TASK_STATUS.failed : TASK_STATUS.uncertain, reason: error && error.code || 'send_transport_error' };
  }
  // A possibly delivered alert counts as the account's first; a failure frees the trial lock.
  await repo.settleFirstReminder({ userKey: task.userKey, taskId: task._id, sent: outcome.status !== TASK_STATUS.failed, now: clock().toISOString() });
  if (outcome.status === TASK_STATUS.failed) {
    const creditAction = outcome.reason === 'subscription_authorization_expired' ? repo.invalidateSubscriptionCredit : repo.releaseSubscriptionCredit;
    await creditAction({ userKey: task.userKey, templateId: task.templateId, taskId: task._id, now: clock().toISOString() });
  }
  return finish({ ...outcome, attempts: (task.attempts || 0) + 1, sentAt: clock().toISOString() });
}

module.exports = { TASK_STATUS, taskId, alertKind, buildTasks, buildMessage, compactProduct, sendTask, skipReason };
