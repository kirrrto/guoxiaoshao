/**
 * One native "允许" grants one send per accepted template. Native requests
 * only originate in real tap handlers; the queue synchronizes results,
 * never calls WeChat from a background loop.
 */
const { call, newId } = require('./api');
const { localKey } = require('./local-key');
const { publishSubscriptions } = require('./store');

const PENDING_KEY = 'gxs_subscription_pending_v1';
const MAX_PENDING = 100;
// Server receipts survive 10 Beijing calendar days. Stop uncertain replays
// before the server's deduplication window can close.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FINAL_ERRORS = ['invalid_subscription_result', 'invalid_request_id', 'invalid_payload', 'membership_required'];

let consentSetting = null;
let nativeBusy = false;
let queue = null;
let storageBlocked = false;
let storageError = null;
let worker = null;
let workerOwner = null;
let kickRequested = false;
const errors = new Map();
const pausedAccounts = new Set();
const listeners = new Set();
const waiters = new Map();

function issue(code, message) { return Object.assign(new Error(message), { code }); }
function userKey() {
  const app = getApp(), boot = app && app.globalData && app.globalData.bootstrap;
  const id = boot && boot.identity && boot.identity.userKey;
  return typeof id === 'string' && id ? id : null;
}
function errorSummary(error) { return error ? { code: error.code || 'call_failed', message: error.message || '授权记录尚未同步，请重试' } : null; }
function setError(owner, error) { if (owner) errors.set(owner, errorSummary(error)); }
function storageFailure() {
  storageBlocked = true;
  storageError = { code: 'subscription_storage_failed', message: '授权暂存在本次运行，暂时无法保存到手机。请保持小程序打开并重试同步。' };
}
function invalidStorage() {
  storageBlocked = true;
  storageError = { code: 'subscription_storage_invalid', message: '本地待同步授权记录格式异常，已停止新增授权，避免覆盖原有记录。请重新打开后重试同步。' };
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
  return { requestId: pending.requestId, results: normalized.results, ...(filtered.length ? { filtered } : {}),
    ...(pending.userKey ? { userKey: pending.userKey } : {}), ...(pending.createdAt !== undefined ? { createdAt: pending.createdAt } : {}) };
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return null;
}
function legacyTimestamp(pending) {
  const known = timestamp(pending.createdAt);
  if (known !== null) return known;
  const match = /^ns-([a-z0-9]+)-[a-z0-9]+$/i.exec(pending.requestId || '');
  const parsed = match && parseInt(match[1], 36);
  return Number.isSafeInteger(parsed) && parsed >= Date.UTC(2020, 0, 1) ? parsed : null;
}
function fresh(entry, now = Date.now()) {
  return Number.isFinite(entry.createdAt) && entry.createdAt <= now + 60000 && now - entry.createdAt < PENDING_TTL_MS;
}

function persistQueue() {
  if (queue === null) return false;
  try {
    const key = localKey(PENDING_KEY);
    if (queue.length) wx.setStorageSync(key, { version: 2, entries: queue });
    else wx.removeStorageSync(key);
    storageBlocked = false; storageError = null;
    return true;
  } catch (_) { storageFailure(); return false; }
}

function loadQueue() {
  if (queue !== null) return true;
  let saved;
  try { saved = wx.getStorageSync(localKey(PENDING_KEY)); }
  catch (_) { storageFailure(); return false; }
  if (!saved) { queue = []; storageBlocked = false; storageError = null; return true; }
  const legacy = saved && typeof saved === 'object' && typeof saved.requestId === 'string';
  const versionTwo = saved && saved.version === 2 && Array.isArray(saved.entries);
  if (!legacy && !versionTwo) { invalidStorage(); return false; }
  const entries = versionTwo ? saved.entries : [saved];
  if (versionTwo && (entries.length > MAX_PENDING || entries.some(entry => !entry || typeof entry.requestId !== 'string' || !entry.requestId
    || typeof entry.userKey !== 'string' || !entry.userKey || timestamp(entry.createdAt) === null
    || !entry.results || typeof entry.results !== 'object' || Array.isArray(entry.results)))) {
    // Keep the original stored value intact. A corrupt outbox must not become
    // an apparently empty queue that the next authorization overwrites.
    invalidStorage(); return false;
  }
  queue = [];
  for (const source of entries) {
    if (!source || typeof source.requestId !== 'string' || !source.results || typeof source.results !== 'object' || Array.isArray(source.results)) continue;
    const entry = normalizePendingAuthorization(source);
    entry.userKey = typeof source.userKey === 'string' && source.userKey ? source.userKey : legacy ? userKey() : null;
    entry.createdAt = legacy ? legacyTimestamp(source) : timestamp(source.createdAt);
    // Bootstrap may not be available at the first read of an old single slot.
    if (legacy && !entry.userKey) entry.legacy = true;
    if (!queue.some(item => item.requestId === entry.requestId && item.userKey === entry.userKey)) queue.push(entry);
  }
  if (legacy && queue.some(entry => !entry.userKey)) return true;
  if (legacy || !entries.length) persistQueue();
  return true;
}

function activeEntries() {
  if (!loadQueue()) return [];
  const owner = userKey();
  let changed = false;
  if (owner) {
    for (const entry of queue) if (entry.legacy && !entry.userKey) { entry.userKey = owner; delete entry.legacy; changed = true; }
  }
  queue = queue.filter(entry => {
    if (!entry.userKey && entry.legacy) return true;
    if (entry.userKey && fresh(entry)) return true;
    if (entry.userKey) {
      const expired = issue('subscription_pending_expired', '这条待同步授权已超过安全重试期限，请重新授权；已有提醒次数保留。');
      setError(entry.userKey, expired);
      settleEntry(entry, null, expired);
    }
    changed = true;
    return false;
  });
  if (changed) persistQueue();
  return owner ? queue.filter(entry => entry.userKey === owner) : [];
}

function getAuthorizationState() {
  const entries = activeEntries(), owner = userKey(), acceptedByTemplate = {};
  for (const entry of entries) for (const id of Object.keys(entry.results)) {
    if (entry.results[id] === 'accept') acceptedByTemplate[id] = (acceptedByTemplate[id] || 0) + 1;
  }
  return { nativeBusy, syncing: Boolean(worker && workerOwner === owner), pendingCount: entries.length, acceptedByTemplate,
    error: storageError || errors.get(owner) || null, storageBlocked };
}
function emitState() {
  const state = getAuthorizationState();
  for (const listener of listeners) { try { listener(state); } catch (_) { /* UI listeners never own the outbox. */ } }
}
function subscribeAuthorizationState(listener) {
  listeners.add(listener);
  try { listener(getAuthorizationState()); } catch (_) { /* Keep the subscription usable. */ }
  return () => listeners.delete(listener);
}

// Only the native request owns this lock, never a slow cloud response.
function beginSubscription() {
  if (nativeBusy) return false;
  nativeBusy = true; emitState(); return true;
}
function endSubscription() { nativeBusy = false; emitState(); }
function isSubscriptionBusy() { return nativeBusy; }
function getConsentSetting() { return consentSetting; }

function refreshConsentSetting() {
  if (typeof wx.getSetting !== 'function') return;
  try {
    wx.getSetting({ withSubscriptions: true, success: res => { consentSetting = res && res.subscriptionsSetting || null; }, fail() {} });
  } catch (_) { /* Older clients keep the explicit button only. */ }
}
function alwaysAccepts(templateId) {
  const setting = consentSetting;
  return Boolean(setting && setting.mainSwitch !== false && setting.itemSettings && setting.itemSettings[templateId] === 'accept');
}

function readPending() { return activeEntries()[0] || null; }
function savePending(pending) {
  if (!loadQueue()) throw issue('subscription_storage_failed', storageError.message);
  const normalized = normalizePendingAuthorization(pending);
  const owner = normalized.userKey || userKey();
  if (!owner) throw issue('subscription_identity_required', '正在确认账户，请稍后再授权');
  const existing = queue.find(entry => entry.userKey === owner && entry.requestId === normalized.requestId);
  if (existing) return existing;
  if (queue.length >= MAX_PENDING) throw issue('subscription_queue_full', '已有 100 条授权等待同步，请先重试同步');
  const entry = { ...normalized, userKey: owner, createdAt: timestamp(normalized.createdAt) === null ? Date.now() : timestamp(normalized.createdAt) };
  queue.push(entry); persistQueue(); emitState(); return entry;
}
function clearPending(pending) {
  if (!pending || !loadQueue()) return;
  const owner = pending.userKey || userKey();
  const index = queue.findIndex(entry => entry.userKey === owner && entry.requestId === pending.requestId);
  if (index < 0) return;
  queue.splice(index, 1); persistQueue(); emitState();
}

function waiterKey(entry) { return entry.userKey + '|' + entry.requestId; }
function awaitEntry(entry) {
  return new Promise((resolve, reject) => {
    const key = waiterKey(entry), callbacks = waiters.get(key) || [];
    callbacks.push({ resolve, reject }); waiters.set(key, callbacks);
  });
}
function settleEntry(entry, result, error) {
  const key = waiterKey(entry), callbacks = waiters.get(key) || [];
  waiters.delete(key);
  for (const callback of callbacks) { if (error) callback.reject(error); else callback.resolve(result); }
}
function rejectWaiting(owner, error) {
  for (const entry of queue || []) if (entry.userKey === owner) settleEntry(entry, null, error);
}

async function drain(owner) {
  let last = null, firstError = null;
  while (true) {
    if (userKey() !== owner) throw issue('subscription_account_changed', '账户尚未确认或已经变化，原账户的授权记录会保留，请稍后同步');
    const entry = readPending();
    if (!entry) { if (firstError) throw firstError; return last; }
    if (!Object.keys(entry.results).length) {
      clearPending(entry);
      last = { accepted: [], results: {}, filtered: entry.filtered || [], skipped: true };
      settleEntry(entry, last); continue;
    }
    try {
      const data = await call('notify.recordSubscription', { requestId: entry.requestId, results: entry.results, expectedUserKey: owner });
      // A successful response confirms this specific account's entry even if
      // its page left. Never publish its balance into an unknown/new account.
      clearPending(entry);
      if (userKey() !== owner) {
        const changed = issue('subscription_account_changed', '账户尚未确认或已经变化，已同步结果不会写入其他账户');
        settleEntry(entry, null, changed); throw changed;
      }
      publishSubscriptions(data.subscriptions);
      last = { ...data, results: entry.results, filtered: entry.filtered || [] };
      settleEntry(entry, last);
    } catch (error) {
      setError(owner, error);
      if (FINAL_ERRORS.includes(error && error.code)) {
        clearPending(entry); settleEntry(entry, null, error);
        firstError = firstError || error;
        if (error.code !== 'membership_required') continue;
      }
      pausedAccounts.add(owner); rejectWaiting(owner, error); emitState(); throw error;
    }
  }
}

function startWorker(owner) {
  if (worker) { kickRequested = true; return worker; }
  workerOwner = owner;
  const operation = Promise.resolve().then(() => drain(owner)).catch(error => {
    setError(owner, error);
    // Terminal validation errors already settled their own entry. A new
    // authorization may have arrived as that worker finished; do not reject
    // its unrelated waiter with the preceding entry's error.
    if (!FINAL_ERRORS.includes(error && error.code) || error.code === 'membership_required') rejectWaiting(owner, error);
    throw error;
  });
  worker = operation.finally(() => {
    worker = null; workerOwner = null;
    const kick = kickRequested; kickRequested = false;
    emitState();
    // An enqueue can race the final empty-queue check. Honor that kick after
    // releasing the worker unless an uncertain failure paused this account.
    const current = userKey();
    if (kick && current && !pausedAccounts.has(current) && readPending()) startWorker(current).catch(() => {});
  });
  emitState();
  return worker;
}
function scheduleSync(owner) {
  if (owner !== userKey() || pausedAccounts.has(owner)) return;
  startWorker(owner).catch(() => {});
}

/** Retry saved results only; this never calls wx.requestSubscribeMessage. */
async function syncPendingAuthorization() {
  const owner = userKey();
  if (!owner) return null;
  errors.delete(owner); pausedAccounts.delete(owner);
  activeEntries();
  if (storageBlocked && queue !== null) persistQueue();
  emitState();
  if (worker) {
    if (workerOwner === owner) return worker;
    try { await worker; } catch (_) { /* The preceding account keeps its own queue. */ }
    if (userKey() !== owner) return null;
  }
  if (!readPending()) return null;
  return startWorker(owner);
}

function preflight() {
  const owner = userKey();
  if (!owner) throw issue('subscription_identity_required', '正在确认账户，请稍后再授权');
  activeEntries();
  if (storageBlocked) throw issue('subscription_storage_failed', storageError.message);
  if (queue.length >= MAX_PENDING) throw issue('subscription_queue_full', '已有 100 条授权等待同步，请先重试同步');
  if (nativeBusy) throw issue('subscription_busy', '微信授权窗口尚未完成，请稍后再点');
  return owner;
}

/** No await occurs before the native request made by this user's tap. */
async function requestReminderAuthorization(tmplIds, options = {}) {
  const owner = preflight();
  if (!options.deferSync && readPending()) return syncPendingAuthorization();
  if (!pausedAccounts.has(owner)) errors.delete(owner);
  if (!beginSubscription()) throw issue('subscription_busy', '微信授权窗口尚未完成，请稍后再点');
  let saved, normalized;
  try {
    const requestId = newId('ns');
    const response = await wx.requestSubscribeMessage({ tmplIds });
    normalized = normalizeSubscriptionResults(tmplIds, response);
    if (!Object.keys(normalized.results).length) return { ...normalized, accepted: [], skipped: true };
    saved = savePending({ requestId, userKey: owner, createdAt: Date.now(), ...normalized });
  } finally { endSubscription(); refreshConsentSetting(); }
  if (userKey() !== owner) throw issue('subscription_account_changed', '账户已变化，授权已为原账户保留，请切回后同步');
  const accepted = Object.keys(normalized.results).filter(id => normalized.results[id] === 'accept');
  if (options.deferSync) {
    scheduleSync(owner);
    return { requestId: saved.requestId, ...normalized, accepted, queued: true, synchronized: false, ...(storageBlocked ? { storageWarning: true } : {}) };
  }
  const pending = awaitEntry(saved);
  pausedAccounts.delete(owner); scheduleSync(owner);
  return pending;
}

/** Only a real tap and remembered template choices can start a silent request. */
function topUpReminderCredit() {
  const app = getApp(), boot = app && app.globalData.bootstrap;
  const templateId = boot && boot.notifications && boot.notifications.templateIds && boot.notifications.templateIds.restock;
  const member = Boolean(boot && boot.membership && boot.membership.active);
  if (nativeBusy || !userKey() || typeof templateId !== 'string' || !templateId || !member
    || readPending() || storageBlocked || typeof wx.requestSubscribeMessage !== 'function') return false;
  const soldoutId = boot.notifications.templateIds.soldout;
  const tmplIds = [...new Set([templateId, ...(typeof soldoutId === 'string' && soldoutId ? [soldoutId] : [])])].filter(alwaysAccepts);
  if (!tmplIds.length || queue.length >= MAX_PENDING || !beginSubscription()) return false;
  const owner = userKey(), requestId = newId('ns');
  let request;
  try { request = wx.requestSubscribeMessage({ tmplIds }); }
  catch (_) { endSubscription(); return false; }
  Promise.resolve(request).then(response => {
    const results = {};
    for (const id of tmplIds) if (response && response[id] === 'accept') results[id] = 'accept';
    if (!Object.keys(results).length) return;
    savePending({ requestId, userKey: owner, createdAt: Date.now(), results });
    scheduleSync(owner);
  }).catch(error => { setError(owner, error); }).then(() => { endSubscription(); refreshConsentSetting(); });
  return true;
}

module.exports = { PENDING_KEY, MAX_PENDING, PENDING_TTL_MS, FINAL_ERRORS, refreshConsentSetting, alwaysAccepts, getConsentSetting, isSubscriptionBusy,
  readPending, savePending, clearPending, beginSubscription, endSubscription, normalizeSubscriptionResults, normalizePendingAuthorization,
  requestReminderAuthorization, syncPendingAuthorization, topUpReminderCredit, getAuthorizationState, subscribeAuthorizationState };
