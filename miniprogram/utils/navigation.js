const { VERSION } = require('../config/version');

// Every programmatic navigation shares this lock, including links outside the
// tab bar. Native completion or the destination's onShow releases it.
let pending = null;
let recent = null;

function safeRoute(value) {
  const route = typeof value === 'string' ? value.split(/[?#]/)[0].replace(/^\/+/, '') : '';
  return /^[A-Za-z0-9/_-]{1,120}$/.test(route) ? route : '';
}

function pagesNow() {
  try { return typeof getCurrentPages === 'function' ? getCurrentPages() : []; }
  catch (_) { return []; }
}

function getNavigationContext() { return recent ? { ...recent } : null; }
function isNavigating() { return Boolean(pending); }

function nativeErrorCodes(error) {
  const codes = {};
  for (const key of ['errno', 'errCode']) {
    try {
      const value = error && error[key];
      if (typeof value === 'number' && Number.isFinite(value)) codes[key] = value;
    } catch (_) { /* Native errors can contain inaccessible properties. */ }
  }
  return codes;
}

function confirmNavigation(route) {
  if (!pending || !pending.context.to || safeRoute(route) !== pending.context.to) return;
  const current = pending;
  pending = null;
  current.context.state = 'arrived';
  current.context.durationMs = Math.max(0, Date.now() - current.startedAt);
}

function reportCallbackError(error) {
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app && typeof app.reportError === 'function') app.reportError('navigation_callback', error);
    else console.error('[gxs] navigation_callback', error);
  } catch (_) { /* Diagnostics cannot prevent navigation cleanup. */ }
}

function invoke(callback, result) {
  if (typeof callback !== 'function') return;
  try { callback(result); } catch (error) { reportCallbackError(error); }
}

function reportFailure(context, error, url) {
  try {
    let message = String(error && (error.errMsg || error.message) || error || 'navigation failed');
    if (url) message = message.split(url).join(safeRoute(url));
    message = message.replace(/([^\s"'<>?]+)\?[^\s"'<>]*/g, '$1?[redacted]').slice(0, 300);
    const log = typeof wx.getRealtimeLogManager === 'function' ? wx.getRealtimeLogManager() : null;
    if (log && typeof log.warn === 'function') log.warn('[gxs] navigation_failure', { ...context, ...nativeErrorCodes(error), errMsg: message });
  } catch (_) { /* Keep the original failure and the retry path. */ }
}

function navigate(method, options = {}) {
  if (pending) return false;
  const pages = pagesNow(), current = pages[pages.length - 1];
  const target = method === 'navigateBack' ? pages[pages.length - 1 - (Number(options.delta) || 1)] : null;
  const context = { version: VERSION, method, from: safeRoute(current && current.route),
    to: safeRoute(method === 'navigateBack' ? target && target.route : options.url),
    state: 'pending', startedAt: new Date().toISOString(), durationMs: 0 };
  const request = { context, startedAt: Date.now() };
  pending = request; recent = context;
  let outcome = '', completed = false;
  const release = state => {
    if (pending === request) pending = null;
    context.state = state;
    context.durationMs = Math.max(0, Date.now() - request.startedAt);
  };
  const success = result => {
    if (outcome) return;
    outcome = 'success';
    invoke(options.success, result);
  };
  const fail = error => {
    if (outcome) return;
    outcome = 'failed'; release('failed');
    reportFailure(context, error, options.url);
    if (typeof options.fail === 'function') invoke(options.fail, error);
    else {
      try { wx.showToast({ title: '页面切换未完成，请重试', icon: 'none' }); }
      catch (_) { /* A failing native bridge must still release the lock. */ }
    }
  };
  const complete = result => {
    if (completed) return;
    completed = true; release(outcome || 'completed');
    invoke(options.complete, result);
  };
  try {
    if (typeof wx[method] !== 'function') throw Error(`${method}:fail unavailable`);
    const result = wx[method]({ ...options, success, fail, complete });
    // Some clients return a Promise even with callbacks. Observe both without
    // replaying caller cleanup, and never let a bridge rejection escape.
    if (result && typeof result.then === 'function') Promise.resolve(result).then(
      value => { success(value); complete(value); },
      error => { fail(error); complete(error); },
    );
  } catch (error) { fail(error); complete(error); return false; }
  return true;
}

module.exports = {
  navigateTo: options => navigate('navigateTo', options),
  navigateBack: options => navigate('navigateBack', options),
  switchTab: options => navigate('switchTab', options),
  reLaunch: options => navigate('reLaunch', options),
  confirmNavigation, isNavigating, getNavigationContext, nativeErrorCodes,
};
