const { newId, call } = require('./api');
const { localKey } = require('./local-key');

// Retain an uncertain operation across retries and page/app recreation.
// Each unresolved target retains its own ID. Switching A → B → A must not
// discard A's uncertain debit and charge it again under a fresh ID.
// Memory also preserves retries during a storage outage while this runtime is
// alive. A full app restart cannot recover an ID that storage failed to save.
const pendingByKey = new Map();

function current(key, peek = false) {
  if (pendingByKey.has(key)) return pendingByKey.get(key);
  let saved;
  try { saved = wx.getStorageSync(key); } catch (e) { if (peek) return []; }
  const entries = saved && Array.isArray(saved.pending) ? saved.pending : saved ? [saved] : [];
  const pending = entries.filter(item => item && typeof item.id === 'string' && typeof item.fingerprint === 'string');
  pendingByKey.set(key, pending);
  return pending;
}

function persist(key, entries, latest) {
  // Preserve the v1 top-level ID for upgrades, and retain the other unresolved
  // targets in the same key. Completed entries are removed, never evicted merely
  // because the user tries another target.
  try {
    if (!entries.length) wx.removeStorageSync(key);
    else wx.setStorageSync(key, { ...(latest || entries[entries.length - 1]), pending: entries });
  } catch (e) { /* in-memory recovery remains available */ }
}

function targetFingerprint(payload) {
  const normalized = { ...payload };
  if (Array.isArray(normalized.storeNumbers)) normalized.storeNumbers = [...new Set(normalized.storeNumbers)].sort();
  return JSON.stringify(Object.keys(normalized).sort().reduce((out, field) => { out[field] = normalized[field]; return out; }, {}));
}

function pendingFor(kind, payload, owner) {
  const entries = current(localKey(`gxs_pending_${kind}_v1`), true);
  const fingerprint = targetFingerprint(payload);
  return entries.find(item => item.fingerprint === fingerprint && item.owner === owner)
    || entries.find(item => item.fingerprint === fingerprint && !item.owner && !(item.settledOwners || []).includes(owner));
}

function hasPending(kind, payload, owner) {
  return Boolean(pendingFor(kind, payload, owner));
}

function legacyId(kind, payload, owner) {
  const entry = pendingFor(kind, payload, owner);
  return entry && ((!entry.owner && (owner || !entry.currentFormat)) || entry.legacyMode) ? entry.id : null;
}

function begin(kind, payload, owner) {
  const key = localKey(`gxs_pending_${kind}_v1`);
  const fingerprint = targetFingerprint(payload);
  const entries = current(key);
  let pending = entries.find(item => item.fingerprint === fingerprint && item.owner === owner);
  if (!pending) { pending = { id: newId(kind), fingerprint, currentFormat: true }; entries.push(pending); }
  if (owner) pending.owner = owner;
  // A retry also persists the retained ID if storage has recovered meanwhile.
  persist(key, entries, pending);
  return pending.id;
}

const VERIFY_FAILED = '旧查询暂时无法核对，本次未扣次，请稍后再试。';

async function verifyLegacy(kind, payload, owner, { cost, member, isCurrent, existingOnly = false }) {
  const key = localKey(`gxs_pending_${kind}_v1`), entry = pendingFor(kind, payload, owner);
  if (!owner) throw Object.assign(Error(VERIFY_FAILED), { code: 'query_recovery_unavailable' });
  const currentAccount = () => {
    const boot = getApp().globalData.bootstrap;
    return isCurrent() && (!boot || !boot.identity || boot.identity.userKey === owner);
  };
  if (!entry || !currentAccount()) return null;
  const scope = { ...payload, kind: kind === 'q' ? 'live' : 'history', queryId: entry.id, expectedUserKey: owner };
  if (existingOnly && entry.owner === owner) return { ...scope, mode: 'resume' };
  if (entry.owner === owner && entry.legacyMode) return { ...scope, mode: entry.legacyMode,
    ...(entry.legacyMode === 'start' ? { maxCost: entry.maxCost } : {}) };
  let result;
  try { result = await call('query.recovery', scope); }
  catch (_) { throw Object.assign(Error(VERIFY_FAILED), { code: 'query_recovery_unavailable' }); }
  if (!currentAccount()) return null;
  if (!result || result.userKey !== owner || !['matched', 'missing'].includes(result.status)) {
    throw Object.assign(Error(VERIFY_FAILED), { code: 'query_recovery_unavailable' });
  }
  let mode = 'resume';
  const maxCost = member ? 0 : cost;
  if (result.status === 'missing') {
    if (existingOnly) throw Object.assign(Error('当前账号未查到这次查询，请按当前上限调整门店。本次未扣次。'), { code: 'query_recovery_missing' });
    if (!Number.isSafeInteger(maxCost) || maxCost < 0) throw Object.assign(Error(VERIFY_FAILED), { code: 'query_recovery_unavailable' });
    const confirmed = await new Promise(resolve => wx.showModal({ title: '当前账号暂未查到上次请求',
      content: member ? '核对未扣次。要发起一次会员免费查询吗？' : `核对未扣次。要发起一次消耗 ${cost} 次的新查询吗？`,
      confirmText: '发起查询', cancelText: '稍后核对', success: res => resolve(!!res.confirm), fail: () => resolve(false) }));
    if (!confirmed || !currentAccount()) return null;
    mode = 'start';
  }
  // Keep the unowned record recoverable by its original account. A separately
  // confirmed purchase reuses the same ID within the current account so a
  // late write from the initial request cannot charge that account twice.
  const entries = current(key), copy = { id: entry.id, fingerprint: entry.fingerprint, owner, legacyMode: mode,
    ...(mode === 'start' ? { maxCost } : {}) };
  const existing = entries.find(item => item.id === entry.id && item.owner === owner);
  if (!existing) { entries.push(copy); persist(key, entries, copy); }
  if (existingOnly) return { ...scope, mode: 'resume' };
  const pending = existing || copy;
  return { ...scope, mode: pending.legacyMode, ...(pending.legacyMode === 'start' ? { maxCost: pending.maxCost } : {}) };
}

function finish(kind, id, owner, settled = true) {
  const key = localKey(`gxs_pending_${kind}_v1`), entries = current(key);
  const entry = entries.find(item => item.id === id && item.owner === owner);
  if (!entry) return;
  const remaining = entries.filter(item => item !== entry);
  if (entry.legacyMode && settled) {
    const legacy = remaining.find(item => !item.owner && item.id === id && item.fingerprint === entry.fingerprint);
    if (legacy) legacy.settledOwners = [...new Set([...(legacy.settledOwners || []), owner])];
  }
  // Keep the empty array in memory even when removal fails, so the completed
  // saved ID cannot resurrect while this runtime remains alive.
  pendingByKey.set(key, remaining);
  persist(key, remaining);
}

function uncertain(error) {
  // A refused account switch says nothing about an earlier debit under the
  // original owner. Keep that owner's ID so a later retry can find it.
  return !error || ['offline', 'cloud_init_failed', 'call_failed', 'bad_response', 'internal_error', 'query_in_progress', 'request_in_progress', 'request_budget_exhausted', 'busy',
    'query_account_changed', 'history_page_account', 'query_recovery_account'].includes(error.code);
}

module.exports = { begin, hasPending, legacyId, verifyLegacy, finish, uncertain };
