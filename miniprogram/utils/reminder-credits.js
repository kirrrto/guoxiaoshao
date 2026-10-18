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

let queueLoading = null;

function adoptQueue(saved) {
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

// Page startup must not call getStorageSync. A tap still reads synchronously so
// the native authorization request stays inside the user gesture.
function loadQueueSync() {
  if (queue !== null) return true;
  let saved;
  try { saved = wx.getStorageSync(localKey(PENDING_KEY)); }
  catch (_) { storageFailure(); return false; }
  return adoptQueue(saved);
}

function loadQueue() {
  if (queue !== null) return true;
  if (typeof wx.getStorage !== 'function') return loadQueueSync();
  if (!queueLoading) {
    queueLoading = new Promise(resolve => {
      try {
        wx.getStorage({
          key: localKey(PENDING_KEY),
          success: result => resolve(result && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null),
          fail: () => resolve(null),
        });
      } catch (_) { resolve(undefined); }
    }).then(saved => {
      if (queue === null) {
        if (saved === undefined) storageFailure();
        else adoptQueue(saved);
      }
      emitState();
      return queue !== null;
    }).finally(() => { queueLoading = null; });
  }
  return false;
}

function ensureQueueForTap() {
  return queue !== null || loadQueueSync();
}

function whenAuthorizationReady() {
  if (queue !== null) return Promise.resolve();
  if (typeof wx.getStorage !== 'function') { loadQueueSync(); return Promise.resolve(); }
  loadQueue();
  return queueLoading || Promise.resolve();
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

/**
 * Per-template WeChat subscribe state. Credits on the server are independent:
 * a balance does not mean the client will accept further sends.
 * 'ask' can still raise the sheet; 'reject'/'ban' are locked and silent on Android.
 */
function templateConsent(templateId) {
  if (typeof templateId !== 'string' || !templateId) return 'missing';
  const setting = consentSetting;
  if (!setting) return 'unknown';
  if (setting.mainSwitch === false) return 'main_switch_off';
  const value = setting.itemSettings && setting.itemSettings[templateId];
  if (value === 'accept') return 'accept';
  if (value === 'reject') return 'reject';
  if (value === 'ban') return 'ban';
  return 'ask';
}

function consentStatusLabel(status) {
  return { accept: '已允许', reject: '已拒绝', ban: '已关闭', ask: '未授权', missing: '未配置', unknown: '未知', main_switch_off: '总开关已关' }[status] || '未知';
}

/**
 * UI report for the recovery card. Partial rejects stay actionable for the
 * remaining templates instead of blocking every authorization tap.
 */
function buildConsentReport({ restockId, soldoutId, restockTitle = '商品到货提醒', soldoutTitle = '库存不足提醒' } = {}) {
  const mainSwitchOff = Boolean(consentSetting && consentSetting.mainSwitch === false);
  const items = [];
  if (typeof restockId === 'string' && restockId) {
    const status = templateConsent(restockId);
    items.push({ id: restockId, title: restockTitle, status, label: consentStatusLabel(status), blocked: status === 'reject' || status === 'ban' || status === 'main_switch_off' });
  }
  if (typeof soldoutId === 'string' && soldoutId) {
    const status = templateConsent(soldoutId);
    items.push({ id: soldoutId, title: soldoutTitle, status, label: consentStatusLabel(status), blocked: status === 'reject' || status === 'ban' || status === 'main_switch_off' });
  }
  const blocked = items.filter(item => item.blocked);
  const open = items.filter(item => !item.blocked && item.status !== 'missing');
  return {
    mainSwitchOff,
    items,
    blocked,
    open,
    anyBlocked: blocked.length > 0 || mainSwitchOff,
    allBlocked: items.length > 0 && blocked.length === items.length,
    // Restock is the required send; sold-out is optional and must not hide it.
    restockBlocked: items.length > 0 && Boolean(items[0] && items[0].blocked),
    known: Boolean(consentSetting),
  };
}

/**
 * Android remembers 「总是保持以上选择」 and will not raise the sheet again for
 * templates already locked to reject/ban. Detect that so the UI can guide the
 * user to settings instead of a silent no-op or a misleading "未授权" result.
 */
function consentLockState(tmplIds) {
  const setting = consentSetting;
  if (!setting) return null;
  if (setting.mainSwitch === false) return 'main_switch_off';
  const items = setting.itemSettings;
  if (!items || !Array.isArray(tmplIds) || !tmplIds.length) return null;
  const locked = tmplIds.filter(id => items[id] === 'reject' || items[id] === 'ban');
  if (locked.length && locked.length === tmplIds.length) return items[tmplIds[0]] === 'ban' || locked.every(id => items[id] === 'ban') ? 'banned' : 'rejected';
  return null;
}

/**
 * Opens the mini-program settings page (subscribe switches live there on
 * current WeChat). Refreshes the cached consent report when the user returns.
 * Settings cannot be changed on the user's behalf; they still need a fresh tap
 * so wx.requestSubscribeMessage can record a real accept.
 */
function openSubscribeSettings(onReturned) {
  const done = () => {
    refreshConsentSettingAsync().then(setting => {
      emitState();
      if (typeof onReturned === 'function') { try { onReturned(setting); } catch (_) { /* UI callback */ } }
    });
  };
  if (typeof wx.openSetting !== 'function') {
    wx.showToast({ title: '请从微信右上角菜单进入设置', icon: 'none' });
    return;
  }
  try {
    wx.openSetting({
      withSubscriptions: true,
      success() { done(); },
      fail() { wx.showToast({ title: '请从微信右上角菜单进入设置', icon: 'none' }); done(); },
    });
  } catch (_) {
    wx.showToast({ title: '请从微信右上角菜单进入设置', icon: 'none' });
    done();
  }
}

function refreshConsentSettingAsync() {
  return new Promise(resolve => {
    if (typeof wx.getSetting !== 'function') return resolve(consentSetting);
    try {
      wx.getSetting({
        withSubscriptions: true,
        success: res => {
          consentSetting = res && res.subscriptionsSetting || null;
          resolve(consentSetting);
        },
        fail: () => resolve(consentSetting),
      });
    } catch (_) { resolve(consentSetting); }
  });
}

function showConsentSettingsGuide(lockState) {
  const banned = lockState === 'banned';
  const title = lockState === 'main_switch_off' ? '订阅消息总开关已关闭'
    : banned ? '订阅消息已被关闭' : '微信已记住“不允许”';
  const content = lockState === 'main_switch_off'
    ? '你已关闭订阅消息，微信不会再弹出授权。请在设置中开启后，再回到本页点「补充提醒次数」。'
    : banned
      ? '相关订阅消息被拒绝或已关闭，微信不会再弹出授权。请到设置中打开后，再回来增加提醒次数。'
      : '你之前选过「不允许」且勾选了「总是保持以上选择」，微信会直接返回不允许、不再弹窗。请到设置里改为允许，再回来点「补充提醒次数」。';
  const guide = '可点「前往设置」，或手动打开小程序右上角「···」→ 设置 → 订阅消息。开启后仍需点「补充提醒次数」，由微信确认才会加次数。';
  wx.showModal({
    title,
    content: `${content}\n\n${guide}`,
    confirmText: '前往设置',
    cancelText: '稍后再说',
    success: r => {
      if (r.confirm) openSubscribeSettings();
    },
    complete: () => refreshConsentSetting(),
  });
}

function readPending() { return activeEntries()[0] || null; }
function savePending(pending) {
  if (!ensureQueueForTap()) throw issue('subscription_storage_failed', storageError.message);
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
  if (!pending || !ensureQueueForTap()) return;
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
  if (!ensureQueueForTap()) throw issue('subscription_storage_failed', storageError && storageError.message || '无法读取本地授权记录，请重试同步后再授权。');
  activeEntries();
  if (storageBlocked) throw issue('subscription_storage_failed', storageError.message);
  if (queue.length >= MAX_PENDING) throw issue('subscription_queue_full', '已有 100 条授权等待同步，请先重试同步');
  if (nativeBusy) throw issue('subscription_busy', '微信授权窗口尚未完成，请稍后再点');
  return owner;
}

/**
 * Android only raises the subscribe dialog inside a real tap's synchronous
 * call stack, and drops the gesture once the handler is async or only a
 * Promise is observed. Prefer success/fail callbacks; still accept a thenable
 * return for clients and test doubles that only implement the Promise form.
 * A deadline keeps `nativeBusy` from sticking when the client never settles.
 */
function invokeNativeSubscribe(tmplIds, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      settle(reject, issue('subscription_timeout', '微信授权窗口未响应，请稍后再试'));
    }, timeoutMs);
    try {
      const maybePromise = wx.requestSubscribeMessage({
        tmplIds,
        success: res => settle(resolve, res),
        fail: err => settle(reject, err && err.errMsg ? err : issue('subscription_failed', (err && (err.errMsg || err.message)) || '微信授权未完成')),
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(
          res => settle(resolve, res),
          err => settle(reject, err || issue('subscription_failed', '微信授权未完成')),
        );
      }
    } catch (error) {
      settle(reject, error);
    }
  });
}

/**
 * Always returns a Promise. The native request is issued synchronously from
 * the caller's tap before any then/await, so Android can still show the dialog.
 */
function requestReminderAuthorization(tmplIds, options = {}) {
  let owner;
  try {
    owner = preflight();
    if (!options.deferSync && readPending()) return syncPendingAuthorization();
    if (!pausedAccounts.has(owner)) errors.delete(owner);
    if (!beginSubscription()) return Promise.reject(issue('subscription_busy', '微信授权窗口尚未完成，请稍后再点'));
  } catch (error) {
    return Promise.reject(error);
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    endSubscription();
    refreshConsentSetting();
  };
  return invokeNativeSubscribe(tmplIds).then(response => {
    let saved, normalized;
    try {
      const requestId = newId('ns');
      normalized = normalizeSubscriptionResults(tmplIds, response);
      if (!Object.keys(normalized.results).length) return { ...normalized, accepted: [], skipped: true };
      saved = savePending({ requestId, userKey: owner, createdAt: Date.now(), ...normalized });
    } finally { finish(); }
    if (userKey() !== owner) throw issue('subscription_account_changed', '账户已变化，授权已为原账户保留，请切回后同步');
    const accepted = Object.keys(normalized.results).filter(id => normalized.results[id] === 'accept');
    if (options.deferSync) {
      scheduleSync(owner);
      return { requestId: saved.requestId, ...normalized, accepted, queued: true, synchronized: false, ...(storageBlocked ? { storageWarning: true } : {}) };
    }
    const pending = awaitEntry(saved);
    pausedAccounts.delete(owner); scheduleSync(owner);
    return pending;
  }, error => {
    finish();
    throw error;
  });
}

/** Only a real tap and remembered template choices can start a silent request. */
function topUpReminderCredit() {
  const app = getApp(), boot = app && app.globalData.bootstrap;
  const templateId = boot && boot.notifications && boot.notifications.templateIds && boot.notifications.templateIds.restock;
  const member = Boolean(boot && boot.membership && boot.membership.active);
  if (nativeBusy || !userKey() || typeof templateId !== 'string' || !templateId || !member
    || !ensureQueueForTap() || readPending() || storageBlocked || typeof wx.requestSubscribeMessage !== 'function') return false;
  const soldoutId = boot.notifications.templateIds.soldout;
  const tmplIds = [...new Set([templateId, ...(typeof soldoutId === 'string' && soldoutId ? [soldoutId] : [])])].filter(alwaysAccepts);
  if (!tmplIds.length || queue.length >= MAX_PENDING || !beginSubscription()) return false;
  const owner = userKey(), requestId = newId('ns');
  // Same synchronous native call as an explicit tap; callbacks + deadline keep
  // Android's dialog reachable and release `nativeBusy` if the client hangs.
  invokeNativeSubscribe(tmplIds).then(response => {
    const results = {};
    for (const id of tmplIds) if (response && response[id] === 'accept') results[id] = 'accept';
    if (!Object.keys(results).length) return;
    savePending({ requestId, userKey: owner, createdAt: Date.now(), results });
    scheduleSync(owner);
  }).catch(error => { setError(owner, error); }).then(() => { endSubscription(); refreshConsentSetting(); });
  return true;
}

module.exports = { PENDING_KEY, MAX_PENDING, PENDING_TTL_MS, FINAL_ERRORS, refreshConsentSetting, refreshConsentSettingAsync, alwaysAccepts, getConsentSetting, isSubscriptionBusy,
  templateConsent, consentStatusLabel, buildConsentReport, consentLockState, showConsentSettingsGuide, openSubscribeSettings,
  readPending, savePending, clearPending, beginSubscription, endSubscription, normalizeSubscriptionResults, normalizePendingAuthorization,
  invokeNativeSubscribe, requestReminderAuthorization, syncPendingAuthorization, topUpReminderCredit, getAuthorizationState, subscribeAuthorizationState, whenAuthorizationReady };
