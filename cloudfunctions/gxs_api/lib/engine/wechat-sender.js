'use strict';

/** Consumer-app credentials, never the resource environment's implicit app. */
function createWechatSender({ appid, appSecret, expectedAppid, fetchImpl = globalThis.fetch, clock = () => new Date(), timeoutMs = 8000 }) {
  let token = null;
  let tokenExpiresAt = 0;
  let tokenRequest = null;
  const disabledReason = !appid || !appSecret ? 'consumer_credentials_missing'
    : !expectedAppid || appid !== expectedAppid ? 'consumer_appid_mismatch' : null;
  const notSent = code => Object.assign(new Error(code), { code, definitelyNotSent: true });

  async function getToken() {
    if (token && clock().getTime() < tokenExpiresAt) return token;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      try {
        const response = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ grant_type: 'client_credential', appid, secret: appSecret, force_refresh: false }),
        });
        if (!response.ok) throw notSent('wechat_token_http_error');
        const result = await response.json();
        if (!result || typeof result.access_token !== 'string' || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw notSent(`wechat_token_${Number(result && result.errcode) || 'invalid_response'}`);
        token = result.access_token;
        tokenExpiresAt = clock().getTime() + Math.max(1, Number(result.expires_in) - 120) * 1000;
        return token;
      } catch (error) {
        // Token acquisition never calls the message endpoint. Do not expose a
        // fetch error containing a URL, access token or credential in logs.
        throw notSent(error && error.definitelyNotSent ? error.code : 'wechat_token_transport_error');
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
      if ([40001, 40014, 42001].includes(Number(result && result.errcode))) { token = null; tokenExpiresAt = 0; }
      return result;
    } catch {
      throw Object.assign(new Error('wechat_message_transport_uncertain'), { code: 'wechat_message_transport_uncertain' });
    }
  };
  send.enabled = !disabledReason;
  send.disabledReason = disabledReason;
  send.appid = appid || null;
  return send;
}

module.exports = { createWechatSender };
