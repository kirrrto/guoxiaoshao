'use strict';
const { createHash } = require('node:crypto');
const { ApiError } = require('./errors');
const { mergeConfig } = require('./config');

const AUDIT_PREFIX = 'config_audit_';
const owns = (value, key) => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
const fingerprint = value => createHash('sha256').update(String(value)).digest('hex');

/** Server-only denial diagnostics. Never include identities, values or patches. */
function logConfigAuthorizationDenial(stage, stored, actor) {
  const adminList = stored && stored.adminUserKeys;
  console.warn('[gxs_config_auth_denied]', JSON.stringify({
    stage,
    documentIsArray: Array.isArray(stored),
    documentHasId: Boolean(stored && stored._id),
    adminListIsArray: Array.isArray(adminList),
    adminCount: Array.isArray(adminList) ? adminList.length : 0,
    actorHasUser: Boolean(actor && actor.userKey),
    isOperator: Boolean(actor && actor.isOperator),
    isAdmin: Boolean(actor && actor.isAdmin),
    matchesAdminList: Boolean(actor && actor.userKey && Array.isArray(adminList) && adminList.includes(actor.userKey)),
  }));
}

/** actor is constructed from the SDK context, never from a request payload. */
function assertConfigEditor(stored, patch, actor, stage = 'config.assertEditor') {
  if (!actor || (!actor.isOperator && (!actor.userKey || !Array.isArray(stored.adminUserKeys) || !stored.adminUserKeys.includes(actor.userKey)))) {
    logConfigAuthorizationDenial(stage, stored, actor);
    throw new ApiError('forbidden', '需要管理员权限');
  }
  if (owns(patch, 'adminUserKeys') && !actor.isOperator) {
    throw new ApiError('admin_assignment_forbidden', '管理员名单只能通过可信云端运维操作修改');
  }
}

function auditIdentity(userKey) {
  if (typeof userKey !== 'string' || !userKey) return null;
  const split = userKey.indexOf(':');
  const appid = split >= 0 ? userKey.slice(0, split) : '';
  const openid = split >= 0 ? userKey.slice(split + 1) : userKey;
  return { hash: fingerprint(userKey), masked: `${appid ? `${appid}:` : ''}${openid.length >= 12 ? `${openid.slice(0, 4)}…${openid.slice(-4)}` : '***'}` };
}

/** Keep useful operational numbers/flags, but never copy secrets or free text. */
function auditValue(value, key = '') {
  if (/secret|password|passwd|token|credential|authorization|private.?key|redeem.*code|code.*hash/i.test(key)) return { redacted: true };
  if (key === 'adminUserKeys') return Array.isArray(value) ? value.map(auditIdentity) : { redacted: true };
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return { hash: fingerprint(value), length: value.length };
  if (Array.isArray(value)) return value.map(item => auditValue(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, auditValue(item, name)]));
  return null;
}

function makeConfigAudit({ auditId, before, after, patch, actor, updatedAt, requestId, revision }) {
  const previous = mergeConfig(before);
  const next = mergeConfig(after);
  const changes = {};
  for (const key of Object.keys(patch)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = { before: auditValue(previous[key], key), after: auditValue(next[key], key) };
  }
  return {
    _id: `${AUDIT_PREFIX}${auditId}`, kind: 'runtime_config_audit', schemaVersion: 1,
    createdAt: updatedAt, requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
    actor: { type: actor.isOperator ? 'operator' : 'admin_user', identity: auditIdentity(actor.userKey), source: actor.source || null },
    revision, previousRevision: Number.isSafeInteger(before.configRevision) ? before.configRevision : 0,
    requestedKeys: Object.keys(patch), changedKeys: Object.keys(changes), changes,
  };
}

module.exports = { AUDIT_PREFIX, assertConfigEditor, makeConfigAudit, logConfigAuthorizationDenial };
