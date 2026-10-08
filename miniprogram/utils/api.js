const cloudConfig = require('../config/cloud');

class ApiError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details || null;
  }
}

// Reads that are safe to repeat: a dropped connection retries once before the page sees it.
const RETRYABLE_READS = new Set(['system.ping', 'user.bootstrap', 'catalog.get', 'follow.list', 'notify.list', 'notify.detail', 'member.status', 'quota.ledger', 'query.recent']);
const RETRY_DELAY_MS = 800;
// A platform request can lose both callbacks. Without our own deadline every
// caller shares a permanently pending account/catalog promise, including Retry.
// Reads can recover quickly; writes allow the deployed 30 s function to finish
// and remain uncertain on timeout so their existing operation ID is retained.
const READ_TIMEOUT_MS = 12000;
const WRITE_TIMEOUT_MS = 35000;

function callWithDeadline(cloud, action, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cloud.callFunction timeout')),
      RETRYABLE_READS.has(action) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
    let request;
    try { request = cloud.callFunction({ name: cloudConfig.apiFunction, data: { action, payload } }); }
    catch (error) { clearTimeout(timer); reject(error); return; }
    Promise.resolve(request)
      .then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Call one gxs_api action. Resolves with `data`; rejects with ApiError. */
async function call(action, payload = {}) {
  try {
    return await callOnce(action, payload, 1);
  } catch (error) {
    if (!RETRYABLE_READS.has(action) || !error || !error.retryable) throw error;
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return callOnce(action, payload, 2);
  }
}

async function callOnce(action, payload, attempt) {
  const app = getApp();
  if (app.globalData && app.globalData.singlePage) throw new ApiError('single_page_mode', '朋友圈中只能预览。点击屏幕下方「前往小程序」即可查询和关注。');
  let startedAt = Date.now();
  let cloud;
  try {
    cloud = await (app.ensureCloud ? app.ensureCloud() : app.cloudReady);
  } catch (error) {
    const reason = app.globalData.cloudError || errorMessage(error);
    throw transportError('cloud_init_failed', /超时|timeout|network|request:fail/i.test(reason) ? '网络不太稳定，暂时连不上服务，请检查网络后重试' : `云环境初始化失败：${reason}`,
      error, { action, phase: 'cloud_init', attempt, startedAt });
  }
  let response;
  startedAt = Date.now();
  try {
    response = await callWithDeadline(cloud, action, payload);
  } catch (error) {
    throw transportError('call_failed', friendlyCallError(error), error, { action, phase: 'call_function', attempt, startedAt });
  }
  const result = response && response.result;
  if (!result || typeof result !== 'object') throw new ApiError('bad_response', '服务返回格式异常');
  if (!result.ok) {
    const err = result.error || {};
    throw new ApiError(err.code || 'unknown_error', err.message || '请求失败', err.details);
  }
  return result.data;
}

function errorMessage(error) { return String((error && (error.errMsg || error.message)) || error); }

function transportCode(error) {
  const raw = error && error.errCode;
  if (raw !== undefined && raw !== null && /^-?\d+$/.test(String(raw))) return Number(raw);
  const match = errorMessage(error).match(/(?:^|[^\d])(-\d{4,})(?=[^\d]|$)/);
  return match ? Number(match[1]) : null;
}

/** Keep enough context to locate a failing action without recording account data or payloads. */
function transportError(code, message, original, context) {
  const msg = errorMessage(original), errCode = transportCode(original);
  const match = msg.match(/(?:requestID|requestId|request_id)\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  const requestId = original && (original.requestID || original.requestId) || (match && match[1]);
  const details = { action: context.action, phase: context.phase, attempt: context.attempt,
    durationMs: Math.max(0, Date.now() - context.startedAt), errCode,
    requestId: typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? requestId : null };
  const error = new ApiError(code, message, details);
  // An authorization/configuration failure is not repaired by repeating it.
  // Unknown failures remain visible for an explicit user retry.
  error.retryable = errCode !== -601017 && !/not allowed|permission denied|access denied/i.test(msg)
    && ([-601008, -404006].includes(errCode) || /超时|timeout|timed out|empty poll result base resp|request:fail|network|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|offline/i.test(msg));
  try {
    const log = typeof wx.getRealtimeLogManager === 'function' ? wx.getRealtimeLogManager() : null;
    if (log && typeof log.warn === 'function') log.warn('[gxs] api_failure', details);
  } catch (e) { /* Diagnostics must never prevent a request from settling. */ }
  return error;
}

function friendlyCallError(error) {
  const msg = `${transportCode(error) || ''} ${errorMessage(error)}`;
  if (/-601017|not allowed/i.test(msg)) return '共享环境拒绝了当前小程序（cloudbase_auth 未放行）';
  if (/-601022|-601023/.test(msg)) return '资源方 cloudbase_auth 调用失败，请检查其部署';
  if (/-404006|empty poll result base resp/i.test(msg)) return '连接暂时中断，结果尚未确认，请重试。';
  if (/-601008|timeout|timed out/i.test(msg)) return '请求超时，请稍后重试';
  if (/request:fail|network|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|offline/i.test(msg)) return '网络连接不稳定，请检查网络后重试';
  return `调用失败：${errorMessage(error)}`;
}

/** Client-generated idempotency key: [A-Za-z0-9_-]{8,64}. */
function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function toast(message, icon = 'none') {
  wx.showToast({ title: message, icon, duration: 2200 });
}

function showError(error) {
  const message = error && error.message ? error.message : '操作失败';
  if (message.length > 24) wx.showModal({ title: '操作未完成', content: message, showCancel: false });
  else wx.showToast({ title: message, icon: 'none', duration: 2600 });
}

module.exports = { call, ApiError, newId, toast, showError };
