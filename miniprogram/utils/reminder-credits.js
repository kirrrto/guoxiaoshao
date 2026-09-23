/**
 * Restock reminders use one-time WeChat subscriptions: every "允许" adds one
 * send, and sends accumulate. Members add more by tapping repeatedly. Once a
 * member ticks "总是保持以上选择", WeChat answers later requests without a
 * popup, so key taps (查询、刷新、保存关注、签到) top up one send silently.
 * A new account on its free alert only needs one, so it tops up from zero.
 */
const { call, newId } = require('./api');
const { localKey } = require('./local-key');
const { publishSubscriptions } = require('./store');

const PENDING_KEY = 'gxs_subscription_pending_v1';
// Only these answers are final for a saved request. Anything else may be a lost
// response, so the saved request is kept and replayed with the same ID.
const FINAL_ERRORS = ['invalid_subscription_result', 'invalid_request_id', 'invalid_payload', 'membership_required'];

let consentSetting = null;
let topUpPending = false;

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
function clearPending() { try { wx.removeStorageSync(localKey(PENDING_KEY)); } catch (e) { /* ignore */ } }

/**
 * Silent top-up for members. Call synchronously at the start of a tap handler,
 * before any await: WeChat only accepts subscription requests inside a tap.
 * Returns true when a request was made.
 */
function topUpReminderCredit() {
  const app = getApp(), boot = app && app.globalData.bootstrap;
  const templateId = boot && boot.notifications && boot.notifications.templateIds && boot.notifications.templateIds.restock;
  const member = Boolean(boot && boot.membership && boot.membership.active);
  const sub = boot && boot.subscriptions && boot.subscriptions[templateId];
  const trialNeedsOne = !member && Boolean(boot) && boot.freeReminder === true && !(sub && Number(sub.credits) > 0);
  if (topUpPending || typeof templateId !== 'string' || !templateId || !(member || trialNeedsOne)
    || !alwaysAccepts(templateId) || readPending() || typeof wx.requestSubscribeMessage !== 'function') return false;
  let request;
  try { request = wx.requestSubscribeMessage({ tmplIds: [templateId] }); } catch (e) { return false; }
  topUpPending = true;
  Promise.resolve(request).then(res => {
    if (!res || res[templateId] !== 'accept') return null;
    const pending = { requestId: newId('ns'), results: { [templateId]: 'accept' } };
    savePending(pending);
    return call('notify.recordSubscription', pending).then(data => { clearPending(); publishSubscriptions(data.subscriptions); },
      error => { if (FINAL_ERRORS.includes(error && error.code)) clearPending(); });
  }).catch(() => { /* a declined or failed silent request changes nothing */ })
    .then(() => { topUpPending = false; refreshConsentSetting(); });
  return true;
}

module.exports = { PENDING_KEY, FINAL_ERRORS, refreshConsentSetting, alwaysAccepts, readPending, savePending, clearPending, topUpReminderCredit };
