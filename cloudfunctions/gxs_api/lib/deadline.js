'use strict';
const { createHash } = require('node:crypto');
const { ApiError } = require('./errors');
const { isValidTemplateId } = require('./config');
const { dayKey, DAY_MS } = require('./time');

const LIMIT = 20;
const CATEGORIES = ['membership', 'coupon', 'warranty', 'event', 'other'];
const REQUEST_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordId = (userKey, requestId) => `deadline_${fingerprint([userKey, requestId])}`;
const indexId = userKey => `deadline_index_${fingerprint(userKey)}`;
const authorizationId = (userKey, requestId) => `deadline_authorization_${fingerprint([userKey, requestId])}`;

function capability(config, { env } = {}) {
  const value = config.deadlineReminders || {};
  const templateId = isValidTemplateId(value.templateId) ? value.templateId : null;
  const fields = value.templateFields || {};
  const keys = Object.values(fields).filter(Boolean);
  const fieldsValid = /^thing\d+$/.test(fields.title) && /^(?:date|time)\d+$/.test(fields.date)
    && (!fields.time || /^time\d+$/.test(fields.time)) && (!fields.category || /^thing\d+$/.test(fields.category))
    && (!fields.remark || /^thing\d+$/.test(fields.remark))
    && Object.keys(fields).every(key => ['title', 'date', 'time', 'category', 'remark'].includes(key)) && new Set(keys).size === keys.length;
  const stockTemplate = templateId && Object.values(config.notifications && config.notifications.templateIds || {}).includes(templateId);
  const reason = !templateId ? 'template_missing' : stockTemplate || !fieldsValid ? 'template_invalid'
    : !['formal', 'trial', 'developer'].includes(value.miniprogramState) ? 'template_invalid'
    : value.enabled !== true ? 'notifications_disabled'
      : env && (!env.GXS_CONSUMER_APPID || !env.GXS_CONSUMER_APPSECRET) ? 'consumer_credentials_missing'
        : env && env.GXS_CONSUMER_APPID !== config.notifications.consumerAppId ? 'consumer_appid_mismatch' : null;
  return { enabled: !reason, templateId, reason };
}

function validateInput(payload, now) {
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!title || Array.from(title).length > 40 || /[\x00-\x1f\x7f]/.test(title)) throw new ApiError('invalid_deadline_title', '请填写 1–40 字的提醒名称');
  const category = payload.category || 'other';
  if (!CATEGORIES.includes(category)) throw new ApiError('invalid_deadline_category', '请选择有效的提醒类型');
  const dueDate = payload.dueDate;
  if (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new ApiError('invalid_deadline_date', '请选择有效的到期日期');
  const dueMs = Date.parse(`${dueDate}T23:59:59.000+08:00`);
  if (!Number.isFinite(dueMs) || dayKey(dueMs) !== dueDate || dueMs <= now.getTime() || dueMs - now.getTime() > 3660 * DAY_MS) throw new ApiError('invalid_deadline_date', '到期日期需在未来十年内');
  const advanceDays = payload.advanceDays;
  if (!Number.isInteger(advanceDays) || advanceDays < 0 || advanceDays > 365) throw new ApiError('invalid_deadline_advance', '提前天数需为 0–365 天');
  const remindTime = payload.remindTime === undefined ? '09:00' : payload.remindTime;
  if (typeof remindTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(remindTime)) throw new ApiError('invalid_deadline_time', '请选择有效的提醒时间');
  const remindMs = Date.parse(`${dueDate}T${remindTime}:00.000+08:00`) - advanceDays * DAY_MS;
  if (remindMs <= now.getTime()) throw new ApiError('deadline_time_passed', '提醒时间已过去，请调整日期、时间或提前天数');
  return { title, category, dueDate, advanceDays, remindTime, remindAt: new Date(remindMs).toISOString(), dueAt: new Date(dueMs).toISOString() };
}

function present(record, config, now, ready = capability(config)) {
  const stored = record.delivery || {};
  let status = stored.status || 'awaiting_authorization', reason = stored.reason || null;
  if (status === 'sending' && record.leaseUntil && record.leaseUntil <= now.toISOString()) { status = 'uncertain'; reason = 'worker_interrupted'; }
  // Preserve actual send outcomes even when an operator later disables delivery.
  if (!['accepted', 'uncertain', 'sending', 'failed'].includes(status)) {
    if (Date.parse(record.dueAt) < now.getTime()) { status = 'missed'; reason = 'deadline_passed'; }
    else if (!ready.enabled) { status = 'not_enabled'; reason = ready.reason; }
    else if (!record.authorization || record.authorization.templateId !== ready.templateId || record.authorization.revision !== record.revision) {
      status = 'awaiting_authorization'; reason = record.authorization ? 'template_changed' : reason;
    }
  }
  return { id: record._id, revision: record.revision, title: record.title, category: record.category,
    dueDate: record.dueDate, advanceDays: record.advanceDays, remindTime: record.remindTime,
    remindAt: record.remindAt, dueAt: record.dueAt, createdAt: record.createdAt, updatedAt: record.updatedAt,
    delivery: { status, reason, attemptedAt: stored.attemptedAt || null, acceptedAt: stored.acceptedAt || null } };
}

module.exports = { LIMIT, CATEGORIES, REQUEST_PATTERN, fingerprint, recordId, indexId, authorizationId, capability, validateInput, present };
