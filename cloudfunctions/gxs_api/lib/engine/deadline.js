'use strict';
const { randomUUID } = require('node:crypto');
const { mergeConfig } = require('../config');
const { capability } = require('../deadline');

const BATCH_LIMIT = 5;
const CATEGORY_LABELS = Object.freeze({ membership: '会员续费', coupon: '优惠券', warranty: '保修到期', event: '活动截止', other: '其他' });
function buildDeadlineMessage(record, user, config) {
  const fields = config.deadlineReminders.templateFields;
  const time = new Date(Date.parse(record.remindAt) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  // dateN accepts a calendar date; timeN requires a clock component. Dates in
  // this first version end at Beijing 23:59:59, not at an inferred merchant time.
  const dueTime = new Date(Date.parse(record.dueAt) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  const category = CATEGORY_LABELS[record.category] || CATEGORY_LABELS.other;
  const values = { title: Array.from(record.title).slice(0, 20).join(''), date: fields.date.startsWith('time') ? dueTime : record.dueDate,
    time, category, remark: '你设置的到期提醒' };
  const data = {};
  for (const [slot, key] of Object.entries(fields)) if (key) data[key] = { value: values[slot] };
  return { touser: user.openid, appid: user.appid, templateId: record.authorization.templateId,
    page: `pages/deadlines/index?id=${encodeURIComponent(record._id)}`,
    miniprogramState: config.deadlineReminders.miniprogramState, lang: 'zh_CN', data };
}

/** One bounded due page per minute; no user scans and no Apple inventory work. */
async function runDeadlineReminders({ repo, sendImpl, clock = () => new Date(), ownerId = `deadline-${randomUUID()}`,
  remainingMs = () => Infinity, limit = BATCH_LIMIT }) {
  const config = mergeConfig(await repo.getConfig());
  const ready = capability(config);
  const stats = { state: ready.enabled ? 'ready' : 'disabled', reason: ready.reason, examined: 0, accepted: 0, failed: 0, uncertain: 0, missed: 0 };
  if (!ready.enabled || remainingMs() <= 1500) return stats;
  const size = Math.min(BATCH_LIMIT, Math.max(1, Math.floor(Number(limit) || BATCH_LIMIT)));
  // A crash after the durable barrier may already have delivered. Never replay it.
  const interrupted = await repo.listExpiredDeadlineClaims(clock().toISOString(), size);
  for (const record of interrupted) {
    if (remainingMs() <= 1500) return stats;
    if (await repo.reconcileDeadline({ id: record._id, nowIso: clock().toISOString() })) stats.uncertain++;
  }
  if (!sendImpl || sendImpl.enabled === false) return { ...stats, state: 'unavailable', reason: sendImpl && sendImpl.disabledReason || 'sender_missing' };
  const due = await repo.listDueDeadlines(clock().toISOString(), size);
  for (const record of due) {
    if (remainingMs() <= 2000) break;
    stats.examined++;
    const claim = await repo.claimDeadline({ id: record._id, ownerId, nowIso: clock().toISOString(), appid: sendImpl.appid || config.notifications.consumerAppId });
    if (!claim.claimed) {
      if (claim.reason === 'deadline_passed') stats.missed++;
      continue;
    }
    const revision = claim.record.revision;
    const verified = await repo.verifyDeadlineSend({ id: record._id, ownerId, revision, nowIso: clock().toISOString(), appid: sendImpl.appid || config.notifications.consumerAppId });
    if (!verified.ready) {
      if (verified.reason === 'deadline_passed') stats.missed++;
      continue;
    }
    const dueAt = Date.parse(verified.record.dueAt), nowMs = clock().getTime();
    const budget = Math.min(8000, remainingMs() - 1000, Date.parse(verified.record.leaseUntil) - nowMs - 1000, dueAt - nowMs);
    let outcome;
    if (nowMs >= dueAt) outcome = { status: 'missed', reason: 'deadline_passed' };
    else if (budget <= 0) outcome = { status: 'failed', reason: 'send_deadline_before_start' };
    else {
      try {
        const response = await sendImpl(buildDeadlineMessage(verified.record, verified.user, verified.config), { timeoutMs: Math.floor(budget), deadlineAt: dueAt });
        const raw = response && (response.errCode ?? response.errcode);
        const code = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
        outcome = !Number.isFinite(code) ? { status: 'uncertain', reason: 'invalid_platform_response' }
          : code === 0 ? { status: 'accepted', reason: null }
            : { status: 'failed', reason: code === 43101 ? 'subscription_authorization_expired' : `wx_${code}` };
      } catch (error) {
        outcome = error && error.definitelyNotSent
          ? clock().getTime() >= dueAt ? { status: 'missed', reason: 'deadline_passed' } : { status: 'failed', reason: 'send_not_started' }
          : { status: 'uncertain', reason: 'send_transport_uncertain' };
      }
    }
    await repo.finishDeadline({ id: record._id, ownerId, revision, outcome, nowIso: clock().toISOString() });
    stats[outcome.status]++;
  }
  return stats;
}
module.exports = { BATCH_LIMIT, buildDeadlineMessage, runDeadlineReminders };
