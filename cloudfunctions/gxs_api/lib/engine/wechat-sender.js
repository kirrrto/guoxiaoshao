'use strict';

/** Consumer-app credentials, never the resource environment's implicit app. */
function createWechatSender({ appid, appSecret, expectedAppid, fetchImpl = globalThis.fetch, clock = () => new Date(), timeoutMs = 8000 }) {
  let token = null;
  let tokenExpiresAt = 0;
  let tokenRequest = null;
  let authState = 'unchecked';
  let authCheckedAt = null;
  let lastErrorCode = null;
  const credentialsConfigured = Boolean(appid && appSecret);
  const disabledReason = !appid || !appSecret ? 'consumer_credentials_missing'
    : !expectedAppid || appid !== expectedAppid ? 'consumer_appid_mismatch' : null;
  const notSent = code => Object.assign(new Error(code), { code, definitelyNotSent: true });

  function getHealth() {
    const ready = !disabledReason && authState === 'ready' && Boolean(token) && clock().getTime() < tokenExpiresAt;
    return { credentialsConfigured, authState: authState === 'ready' && !ready ? 'unchecked' : authState,
      authReady: ready, checkedAt: authCheckedAt, validUntil: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
      reason: disabledReason || (ready ? null : authState === 'failed' ? 'consumer_auth_failed' : 'consumer_auth_unchecked'), lastErrorCode };
  }

  function failAuth(code) {
    token = null; tokenExpiresAt = 0;
    authState = 'failed'; authCheckedAt = clock().toISOString(); lastErrorCode = code;
  }

  async function getToken(requestTimeoutMs = timeoutMs) {
    if (token && clock().getTime() < tokenExpiresAt) return token;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      try {
        const response = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
          body: JSON.stringify({ grant_type: 'client_credential', appid, secret: appSecret, force_refresh: false }),
        });
        if (!response.ok) throw notSent('wechat_token_http_error');
        const result = await response.json();
        if (!result || typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) {
          const code = Number(result && result.errcode);
          throw notSent(`wechat_token_${Number.isSafeInteger(code) && code !== 0 && Math.abs(code) < 100000000 ? code : 'invalid_response'}`);
        }
        const expiresAt = clock().getTime() + Math.max(1, Number(result.expires_in) - 120) * 1000;
        if (!Number.isFinite(new Date(expiresAt).getTime())) throw notSent('wechat_token_invalid_response');
        token = result.access_token;
        tokenExpiresAt = expiresAt;
        authState = 'ready'; authCheckedAt = clock().toISOString(); lastErrorCode = null;
        return token;
      } catch (error) {
        // Token acquisition never calls the message endpoint. Do not expose a
        // fetch error containing a URL, access token or credential in logs.
        const code = error && error.definitelyNotSent && /^wechat_token_(?:http_error|invalid_response|-?\d{1,8})$/.test(error.code) ? error.code : 'wechat_token_transport_error';
        failAuth(code);
        throw notSent(code);
      } finally { tokenRequest = null; }
    })();
    return tokenRequest;
  }

  const send = async message => {
    if (disabledReason) throw notSent(disabledReason);
    if (message.appid !== appid) throw notSent('consumer_appid_mismatch');
    const accessToken = await getToken();
    try {
      const response = await fetchImpl(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ touser: message.touser, template_id: message.templateId, page: message.page,
          data: message.data, miniprogram_state: message.miniprogramState || 'formal', lang: message.lang || 'zh_CN' }),
      });
      if (!response.ok) throw Object.assign(new Error('wechat_message_http_error'), { code: 'wechat_message_http_error' });
      const result = await response.json();
      if ([40001, 40014, 42001].includes(Number(result && result.errcode))) failAuth(`wechat_token_${Number(result.errcode)}`);
      return result;
    } catch {
      throw Object.assign(new Error('wechat_message_transport_uncertain'), { code: 'wechat_message_transport_uncertain' });
    }
  };
  send.enabled = !disabledReason;
  send.disabledReason = disabledReason;
  send.appid = appid || null;
  send.getHealth = getHealth;
  // Probes never call the subscription-message endpoint or consume credits.
  // Return only whitelisted health fields, never tokens, secrets or raw errors.
  send.probe = async ({ timeoutMs: requestedTimeout = timeoutMs } = {}) => {
    if (disabledReason) return getHealth();
    const boundedTimeout = Math.max(1, Math.min(timeoutMs, Number.isFinite(requestedTimeout) ? Math.floor(requestedTimeout) : timeoutMs));
    try { await getToken(boundedTimeout); } catch { /* getToken records a redacted failure */ }
    return getHealth();
  };
  return send;
}

module.exports = { createWechatSender };
