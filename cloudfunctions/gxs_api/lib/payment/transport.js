'use strict';
const { PaymentProtocolError, fail } = require('./errors');

const MAX_RESPONSE_BYTES = 262144;

async function readJson(response, allowEmpty = false) {
  if (!response || !response.ok) fail('payment_http_error');
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) fail('payment_response_too_large');
  let raw;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('payment_response_too_large'); }
        chunks.push(Buffer.from(item.value));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else {
    raw = await response.text();
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) fail('payment_response_too_large');
  }
  if (allowEmpty && !raw.trim()) return {};
  let data;
  try { data = JSON.parse(raw); } catch { fail('payment_invalid_response'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('payment_invalid_response');
  if (data.errcode !== undefined && data.errcode !== 0) {
    const code = data.errcode;
    fail('payment_wechat_error', { wechatCode: Number.isSafeInteger(code) && Math.abs(code) < 1000000000 ? code : null });
  }
  return data;
}

// The deadline includes reading the response body, including fetch implementations
// that ignore abort signals. There is no automatic retry of a financial request.
async function withDeadline(timeoutMs, work) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PaymentProtocolError('payment_timeout'));
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]); }
  catch (error) {
    if (error instanceof PaymentProtocolError) throw error;
    fail(controller.signal.aborted ? 'payment_timeout' : 'payment_transport_error');
  } finally { clearTimeout(timer); }
}

async function requestJson(fetchImpl, url, options, signal, allowEmpty = false) {
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal });
  const result = await readJson(response, allowEmpty);
  if (signal.aborted) fail('payment_timeout');
  return result;
}

// Instance-local, consumer-AppID-scoped cache with coalesced refreshes. It is kept
// separate from membership logic so the host can reuse one provider instance.
function createAccessTokenProvider({ appid, appSecret, fetchImpl, clock, timeoutMs }) {
  let token = null; let expiresAt = 0; let pending = null;
  return {
    async get() {
      if (token && clock().getTime() < expiresAt) return token;
      if (pending) return pending;
      pending = withDeadline(timeoutMs, async signal => {
        const result = await requestJson(fetchImpl, 'https://api.weixin.qq.com/cgi-bin/stable_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'client_credential', appid, secret: appSecret, force_refresh: false }),
        }, signal);
        if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 4096
            || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 0 || result.expires_in > 86400) fail('payment_invalid_token_response');
        token = result.access_token;
        expiresAt = clock().getTime() + Math.max(0, result.expires_in - 120) * 1000;
        return token;
      }).finally(() => { pending = null; });
      return pending;
    },
    invalidate() { token = null; expiresAt = 0; },
  };
}

module.exports = { requestJson, withDeadline, createAccessTokenProvider };
