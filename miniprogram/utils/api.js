const cloudConfig = require('../config/cloud');

class ApiError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details || null;
  }
}

/** Call one gxs_api action. Resolves with `data`; rejects with ApiError. */
async function call(action, payload = {}) {
  const app = getApp();
  if (app.globalData && app.globalData.singlePage) throw new ApiError('single_page_mode', '朋友圈中只能预览。点击屏幕下方「前往小程序」即可查询和关注。');
  let cloud;
  try {
    cloud = await (app.ensureCloud ? app.ensureCloud() : app.cloudReady);
  } catch (error) {
    throw new ApiError('cloud_init_failed', `云环境初始化失败：${app.globalData.cloudError || ''}`);
  }
  let response;
  try {
    response = await cloud.callFunction({ name: cloudConfig.apiFunction, data: { action, payload } });
  } catch (error) {
    throw new ApiError('call_failed', friendlyCallError(error));
  }
  const result = response && response.result;
  if (!result || typeof result !== 'object') throw new ApiError('bad_response', '服务返回格式异常');
  if (!result.ok) {
    const err = result.error || {};
    throw new ApiError(err.code || 'unknown_error', err.message || '请求失败', err.details);
  }
  return result.data;
}

function friendlyCallError(error) {
  const msg = (error && (error.errMsg || error.message)) || String(error);
  if (/-601017|not allowed/i.test(msg)) return '共享环境拒绝了当前小程序（cloudbase_auth 未放行）';
  if (/-601022|-601023/.test(msg)) return '资源方 cloudbase_auth 调用失败，请检查其部署';
  if (/-404006|empty poll result base resp/i.test(msg)) return '连接暂时中断，结果尚未确认，请重试。';
  if (/timeout|timed out/i.test(msg)) return '请求超时，请稍后重试';
  return `调用失败：${msg}`;
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
