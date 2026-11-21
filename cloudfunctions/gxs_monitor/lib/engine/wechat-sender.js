'use strict';

// WeChat HTTP and SDK adapters use different casing for the same integer.
// Missing or contradictory evidence must preserve an uncertain send outcome.
function subscriptionResponseCode(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  let result = null;
  for (const raw of [response.errcode, response.errCode]) {
    if (raw == null) continue;
    if (typeof raw !== 'number' && !(typeof raw === 'string' && /^-?\d+$/.test(raw))) return null;
    const code = Number(raw);
    if (!Number.isSafeInteger(code) || (result !== null && result !== code)) return null;
    result = code;
  }
  return result;
}

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

  function startTokenRequest() {
    const request = { controller: new AbortController(), waiters: 0 };
    tokenRequest = request;
    const networkTimer = setTimeout(() => request.controller.abort(), timeoutMs);
    request.promise = (async () => {
      try {
        const response = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: request.controller.signal,
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
        if (tokenRequest !== request) throw notSent('wechat_send_deadline');
        token = result.access_token;
        tokenExpiresAt = expiresAt;
        authState = 'ready'; authCheckedAt = clock().toISOString(); lastErrorCode = null;
        return token;
      } catch (error) {
        // Token acquisition never calls the message endpoint. Do not expose a
        // fetch error containing a URL, access token or credential in logs.
        const code = error && error.definitelyNotSent && /^wechat_token_(?:http_error|invalid_response|-?\d{1,8})$/.test(error.code) ? error.code : 'wechat_token_transport_error';
        if (tokenRequest === request) failAuth(code);
        throw notSent(code);
      } finally {
        clearTimeout(networkTimer);
        if (tokenRequest === request) tokenRequest = null;
      }
    })();
    return request;
  }

  async function getToken(requestTimeoutMs = timeoutMs) {
    if (token && clock().getTime() < tokenExpiresAt) return token;
    const request = tokenRequest || startTokenRequest();
    request.waiters++;
    let timer;
    try {
      // Each caller owns its waiting budget, including the one that starts the request.
      return await Promise.race([request.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(notSent('wechat_send_deadline')), requestTimeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      request.waiters--;
      if (request.waiters === 0 && tokenRequest === request) {
        tokenRequest = null;
        request.controller.abort();
      }
    }
  }

  const send = async (message, { timeoutMs: requestedTimeout = timeoutMs, deadlineAt = Infinity } = {}) => {
    if (disabledReason) throw notSent(disabledReason);
    if (message.appid !== appid) throw notSent('consumer_appid_mismatch');
    const boundedTimeout = Math.max(1, Math.min(timeoutMs, Number.isFinite(requestedTimeout) ? Math.floor(requestedTimeout) : timeoutMs));
    const startedAt = clock().getTime();
    const deadline = Math.min(startedAt + boundedTimeout, deadlineAt);
    const tokenTimeout = Math.floor(deadline - startedAt);
    if (tokenTimeout < 1) throw notSent('wechat_send_deadline');
    const accessToken = await getToken(tokenTimeout);
    const messageTimeout = Math.floor(deadline - clock().getTime());
    if (messageTimeout < 1) throw notSent('wechat_send_deadline');
    try {
      const response = await fetchImpl(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(messageTimeout),
        body: JSON.stringify({ touser: message.touser, template_id: message.templateId, page: message.page,
          data: message.data, miniprogram_state: message.miniprogramState || 'formal', lang: message.lang || 'zh_CN' }),
      });
      if (!response.ok) throw Object.assign(new Error('wechat_message_http_error'), { code: 'wechat_message_http_error' });
      const result = await response.json();
      const code = subscriptionResponseCode(result);
      if (accessToken === token && [40001, 40014, 42001].includes(code)) failAuth(`wechat_token_${code}`);
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
    try { await getToken(boundedTimeout); } catch { /* Only a failure of the shared request changes auth health. */ }
    return getHealth();
  };
  return send;
}

module.exports = { createWechatSender, subscriptionResponseCode };
