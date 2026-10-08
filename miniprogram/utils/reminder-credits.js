/**
 * Restock reminders use one-time WeChat subscriptions: every "允许" adds one
 * send, and sends accumulate. Members add more by tapping repeatedly. Once a
 * member ticks "总是保持以上选择", WeChat answers later requests without a
 * popup, so key taps (查询、刷新、保存关注、签到) top up one send silently.
 */
const { call, newId } = require('./api');
const { localKey } = require('./local-key');
const { publishSubscriptions } = require('./store');

const PENDING_KEY = 'gxs_subscription_pending_v1';
// Only these answers are final for a saved request. Anything else may be a lost
// response, so the saved request is kept and replayed with the same ID.
const FINAL_ERRORS = ['invalid_subscription_result', 'invalid_request_id', 'invalid_payload', 'membership_required'];

let consentSetting = null;
let subscriptionBusy = false;

// Explicit authorization and silent top-ups share one persisted pending slot.
// Hold it from the native prompt until recording finishes, across all pages.
function beginSubscription() {
  if (subscriptionBusy) return false;
  subscriptionBusy = true;
  return true;
}
function endSubscription() { subscriptionBusy = false; }
function isSubscriptionBusy() { return subscriptionBusy; }
function getConsentSetting() { return consentSetting; }

/** Cache the "总是保持以上选择" answers; refreshed on app show and after each prompt. */
function refreshConsentSetting() {
  if (typeof wx.getSetting !== 'function') return;
  try {
    wx.getSetting({ withSubscriptions: true, success: res => { consentSetting = res && res.subscriptionsSetting || null; }, fail() {} });
  } catch (e) { /* older clients keep the explicit button only */ }
}

function alwaysAccepts(templateId) {
  const setting = consentSetting;
  return Boolean(setting && setting.mainSwitch !== false && setting.itemSettings && setting.itemSettings[templateId] === 'accept');
}

function readPending() { try { return wx.getStorageSync(localKey(PENDING_KEY)) || null; } catch (e) { return null; } }
function savePending(pending) { try { wx.setStorageSync(localKey(PENDING_KEY), pending); } catch (e) { /* the in-flight call still carries its ID */ } }
function clearPending(pending) {
  try {
    const key = localKey(PENDING_KEY), saved = wx.getStorageSync(key);
    if (pending && saved && saved.requestId !== pending.requestId) return;
    wx.removeStorageSync(key);
  } catch (e) { /* ignore */ }
}

/** A filtered template must not discard another template's accepted grant. */
function normalizeSubscriptionResults(tmplIds, response) {
  const results = {}, filtered = [];
  for (const id of tmplIds) {
    const value = response && response[id];
    if (['accept', 'reject', 'ban'].includes(value)) results[id] = value;
    else if (value === 'filter') filtered.push(id);
  }
  return { results, filtered };
}

function normalizePendingAuthorization(pending) {
  const normalized = normalizeSubscriptionResults(Object.keys(pending.results || {}), pending.results);
  const filtered = [...new Set([...(Array.isArray(pending.filtered) ? pending.filtered : []), ...normalized.filtered])];
  return { requestId: pending.requestId, results: normalized.results, ...(filtered.length ? { filtered } : {}) };
}

async function recordPending(pending) {
  pending = normalizePendingAuthorization(pending);
  if (!Object.keys(pending.results).length) {
    clearPending(pending);
    return { accepted: [], results: {}, filtered: pending.filtered || [], skipped: true };
  }
  savePending(pending);
  try {
    const data = await call('notify.recordSubscription', { requestId: pending.requestId, results: pending.results });
    clearPending(pending);
    publishSubscriptions(data.subscriptions);
    return { ...data, results: pending.results, filtered: pending.filtered || [] };
  } catch (error) {
    if (FINAL_ERRORS.includes(error && error.code)) clearPending(pending);
    throw error;
  }
}

/** Resume the original grant after a restart without showing WeChat again. */
async function syncPendingAuthorization() {
  const pending = readPending();
  if (!pending || !beginSubscription()) return null;
  try { return await recordPending(pending); }
  finally { endSubscription(); }
}

/** Called directly by a user tap; no await occurs before the native request. */
async function requestReminderAuthorization(tmplIds) {
  if (!beginSubscription()) throw Object.assign(new Error('授权正在同步，请稍后再试'), { code: 'subscription_busy' });
  try {
    const pending = readPending();
    if (pending) return await recordPending(pending);
    const requestId = newId('ns');
    const response = await wx.requestSubscribeMessage({ tmplIds });
    const normalized = normalizeSubscriptionResults(tmplIds, response);
    if (!Object.keys(normalized.results).length) return { ...normalized, accepted: [], skipped: true };
    const saved = { requestId, ...normalized };
    savePending(saved);
    return await recordPending(saved);
  } finally { endSubscription(); refreshConsentSetting(); }
}

/**
 * Silent top-up for members. Call synchronously at the start of a tap handler,
 * before any await: WeChat only accepts subscription requests inside a tap.
 * Returns true when a request was made.
 */
function topUpReminderCredit() {
  const app = getApp(), boot = app && app.globalData.bootstrap;
  const templateId = boot && boot.notifications && boot.notifications.templateIds && boot.notifications.templateIds.restock;
  const member = Boolean(boot && boot.membership && boot.membership.active);
  if (subscriptionBusy || typeof templateId !== 'string' || !templateId || !member
    || readPending() || typeof wx.requestSubscribeMessage !== 'function') return false;
  // Members also top up sell-out alerts; only templates set to "always" can be requested silently.
  const soldoutId = member && boot.notifications.templateIds.soldout;
  const tmplIds = [templateId, ...(typeof soldoutId === 'string' && soldoutId ? [soldoutId] : [])].filter(alwaysAccepts);
  if (!tmplIds.length) return false;
  if (!beginSubscription()) return false;
  let request;
  try { request = wx.requestSubscribeMessage({ tmplIds }); } catch (e) { endSubscription(); return false; }
  Promise.resolve(request).then(res => {
    const results = {};
    for (const id of tmplIds) if (res && res[id] === 'accept') results[id] = 'accept';
    if (!Object.keys(results).length) return null;
    const pending = { requestId: newId('ns'), results };
    savePending(pending);
    return call('notify.recordSubscription', pending).then(data => { clearPending(pending); publishSubscriptions(data.subscriptions); },
      error => { if (FINAL_ERRORS.includes(error && error.code)) clearPending(pending); });
  }).catch(() => { /* a declined or failed silent request changes nothing */ })
    .then(() => { endSubscription(); refreshConsentSetting(); });
  return true;
}

module.exports = { PENDING_KEY, FINAL_ERRORS, refreshConsentSetting, alwaysAccepts, getConsentSetting, isSubscriptionBusy,
  readPending, savePending, clearPending, beginSubscription, endSubscription, normalizeSubscriptionResults,
  normalizePendingAuthorization, requestReminderAuthorization, syncPendingAuthorization, topUpReminderCredit };
