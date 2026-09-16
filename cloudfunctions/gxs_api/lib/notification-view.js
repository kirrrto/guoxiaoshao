'use strict';
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { ApiError } = require('./errors');

function viewId(userKey) { return `notification_view_${createHash('sha256').update(userKey).digest('hex')}`; }
function newView(userKey) {
  return { _id: viewId(userKey), kind: 'notification_view', userKey, lastSequence: 0, clearedThroughSequence: 0, legacyClearBefore: null, tokenSecret: randomBytes(32).toString('hex') };
}
function encodeToken(kind, value, view) {
  const body = Buffer.from(JSON.stringify({ v: 1, kind, userKey: view.userKey, ...value })).toString('base64url');
  return `${body}.${createHmac('sha256', view.tokenSecret).update(body).digest('base64url')}`;
}
function canonicalTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function decodeToken(token, kind, view, nowIso) {
  const code = kind === 'clear' ? 'invalid_clear_before' : 'invalid_cursor';
  const invalid = () => { throw new ApiError(code, kind === 'clear' ? '清空范围无效，请刷新提醒列表后重试' : '分页位置无效，请刷新提醒列表'); };
  try {
    if (typeof token !== 'string' || token.length > 4096) return invalid();
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return invalid();
    const supplied = Buffer.from(signature, 'base64url');
    const expected = createHmac('sha256', view.tokenSecret).update(body).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return invalid();
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.kind !== kind || value.userKey !== view.userKey || !canonicalTime(value.at) || value.at > nowIso || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.sequence > view.lastSequence) return invalid();
    // Sequenced tasks can arrive after the request timestamp but before the
    // view is read. Their signed cursor time is an ordering key, not a cutoff.
    if (kind === 'cursor' && (!canonicalTime(value.createdAt) || typeof value.id !== 'string' || !value.id || value.id.length > 1024)) return invalid();
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return invalid();
  }
}

module.exports = { viewId, newView, encodeToken, decodeToken };
