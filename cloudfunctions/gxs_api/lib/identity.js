'use strict';
/**
 * Caller identity in the shared environment.
 *
 * When 果小哨 (consumer AppID) calls this function, WeChat fills FROM_APPID /
 * FROM_OPENID; APPID / OPENID describe the resource-owner app. Users are keyed
 * by `${appid}:${openid}` so a future second consumer app never collides.
 * Operator invocations (console / API / timers) carry no user and may only run
 * system.* and admin.* actions.
 */
const OPERATOR_ORIGINS = new Set(['wx_devtools', 'wx_localdebug', 'wx_trigger']);

function resolveIdentity(wxContext, { allowedAppids, adminUserKeys, adminOpenids }) {
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
  const crossAccount = Boolean(text(wxContext.FROM_APPID));
  const appid = crossAccount ? text(wxContext.FROM_APPID) : text(wxContext.APPID);
  // Cross-account identity is a pair. Never combine the consumer AppID with
  // the resource owner's OPENID when FROM_OPENID is absent.
  const openid = crossAccount ? text(wxContext.FROM_OPENID) : text(wxContext.OPENID);
  const source = text(wxContext.SOURCE);
  const chain = source ? source.split(',').map(value => value.trim()) : [];
  const userKey = appid && openid ? `${appid}:${openid}` : null;
  // SOURCE is taken from the SDK's trusted invocation context. A user-origin
  // chain ending in scf stays a user call; lack of OPENID is never sufficient.
  const isOperator = !openid && !crossAccount && !text(wxContext.FROM_OPENID)
    && chain.length > 0 && OPERATOR_ORIGINS.has(chain[0]) && chain.slice(1).every(hop => hop === 'scf');
  const isAdmin = isOperator
    || (userKey && Array.isArray(adminUserKeys) && adminUserKeys.includes(userKey))
    || (openid && Array.isArray(adminOpenids) && adminOpenids.includes(openid));
  const appAllowed = !appid || !Array.isArray(allowedAppids) || allowedAppids.length === 0 || allowedAppids.includes(appid);
  return { appid, openid, source, crossAccount, userKey, isOperator, isAdmin: Boolean(isAdmin), appAllowed, env: wxContext.ENV || null };
}

/** Never echo raw openids to clients; show enough to recognise the account. */
function maskOpenid(openid) {
  if (!openid || openid.length < 8) return null;
  return `${openid.slice(0, 4)}…${openid.slice(-4)}`;
}

module.exports = { resolveIdentity, maskOpenid, OPERATOR_ORIGINS };
