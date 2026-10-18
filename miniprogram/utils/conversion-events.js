const api = require('./api');
const build = require('../config/version');

const EVENTS = ['session_started', 'target_committed', 'offer_viewed', 'offer_cta_clicked', 'checkout_blocked', 'cashier_invoked', 'cashier_result', 'activation_viewed', 'purchase_feedback'];
const REASONS = ['payment_product_id_missing', 'payment_plan_disabled', 'payment_not_enabled', 'payment_server_not_ready', 'payment_devtools', 'payment_ios_disabled', 'payment_ios_version_low', 'payment_wechat_version_low', 'payment_api_unavailable', 'payment_capability_unknown', 'payment_runtime_unsupported', 'cashier_cancelled', 'cashier_result_unknown', 'feedback_no_need', 'feedback_bought', 'feedback_price_duration', 'feedback_unclear', 'feedback_trust', 'feedback_payment', 'feedback_other', 'unknown'];
const ENTRY_POINTS = ['member', 'mine', 'query', 'result', 'query_selection', 'query_result', 'follow', 'checkout', 'activation', 'share', 'unknown'];
const PLANS = ['member_7d', 'member_30d', 'member_365d'];
const inList = (list, value, fallback = null) => list.includes(value) ? value : fallback;

/** Memory-only, account-scoped best-effort UI telemetry. Never await it on a purchase path. */
function createTracker({ call = api.call, now = () => Date.now(), makeId = api.newId, schedule = setTimeout, cancel = clearTimeout, device = () => typeof wx !== 'undefined' && typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : {} } = {}) {
  let account = null, enabled = false, sessionId = null, platform = 'unknown';
  let queue = [], timer = null, generation = 0, active = false;
  function plan(delay = 1200) {
    if (!timer && enabled && queue.length) timer = schedule(() => { timer = null; flush(); }, delay);
  }
  function configure(session) {
    try {
      const key = session && session.identity && session.identity.userKey;
      const next = typeof key === 'string' && key ? key : null;
      const on = Boolean(next && session.features && session.features.growthEvents === true);
      if (next !== account || !on) {
        generation++; queue = []; active = false;
        if (timer) cancel(timer);
        timer = null; sessionId = null;
      }
      account = next; enabled = on;
      if (!enabled || sessionId) return;
      sessionId = makeId('session');
      platform = inList(['ios', 'android', 'windows', 'mac', 'devtools'], device().platform, 'unknown');
      track('session_started', { entryPoint: 'unknown' });
    } catch (e) { enabled = false; queue = []; }
  }
  function track(eventName, fields = {}) {
    try {
      if (!enabled || !sessionId || !EVENTS.includes(eventName)) return false;
      const event = { eventId: makeId('event'), eventName, schemaVersion: 1, occurredAt: new Date(now()).toISOString(), sessionId,
        appVersion: build.VERSION, buildSha: build.BUILD_SHA || null, platform,
        entryPoint: inList(ENTRY_POINTS, fields.entryPoint, 'unknown'), planId: inList(PLANS, fields.planId),
        reasonCode: inList(REASONS, fields.reasonCode), result: inList(['success', 'cancel', 'unknown', 'blocked'], fields.result) };
      if (eventName === 'target_committed') {
        const target = fields.target || fields;
        if (typeof target.partNumber !== 'string' || !/^[A-Za-z0-9/]{1,32}$/.test(target.partNumber) || !Array.isArray(target.storeNumbers)) return false;
        const stores = [...new Set(target.storeNumbers)].filter(value => /^R\d{1,6}$/.test(value));
        if (!stores.length || stores.length > 5) return false;
        event.target = { partNumber: target.partNumber, storeNumbers: stores.sort() };
      }
      if (queue.length >= 40) {
        const expendable = queue.findIndex(row => ['session_started', 'offer_viewed', 'activation_viewed'].includes(row.event.eventName));
        if (expendable < 0) return false;
        queue.splice(expendable, 1);
      }
      queue.push({ event, attempts: 0 }); plan(); return true;
    } catch (e) { return false; }
  }
  async function flush() {
    if (!enabled || active || !queue.length) return;
    const epoch = generation;
    if (timer) cancel(timer);
    timer = null; active = true;
    queue = queue.filter(row => now() - Date.parse(row.event.occurredAt) <= 86400000);
    const batch = queue.splice(0, 10);
    let failed = false;
    try { if (batch.length) await call('growth.ingest', { events: batch.map(row => row.event) }); }
    catch (error) {
      failed = true;
      if (epoch === generation && enabled) queue = [...batch.filter(row => row.attempts++ < 1), ...queue].slice(0, 40);
    } finally {
      if (epoch === generation) { active = false; plan(failed ? 15000 : 1200); }
    }
  }
  return { configure, track, flush };
}

const tracker = createTracker();
module.exports = { ...tracker, createTracker, EVENTS, REASONS };
