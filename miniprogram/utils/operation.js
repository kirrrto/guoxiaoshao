const { newId } = require('./api');
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

function lookup(entries, fingerprint, owner) {
  return entries.find(item => item.fingerprint === fingerprint && item.owner === owner)
    || entries.find(item => item.fingerprint === fingerprint && !item.owner);
}

function hasPending(kind, payload, owner) {
  return Boolean(lookup(current(localKey(`gxs_pending_${kind}_v1`), true), targetFingerprint(payload), owner));
}

function begin(kind, payload, owner) {
  const key = localKey(`gxs_pending_${kind}_v1`);
  const fingerprint = targetFingerprint(payload);
  const entries = current(key);
  let pending = lookup(entries, fingerprint, owner);
  if (!pending) { pending = { id: newId(kind), fingerprint }; entries.push(pending); }
  if (owner) pending.owner = owner;
  // A retry also persists the retained ID if storage has recovered meanwhile.
  persist(key, entries, pending);
  return pending.id;
}

function finish(kind, id) {
  const key = localKey(`gxs_pending_${kind}_v1`), entries = current(key);
  if (!entries.some(item => item.id === id)) return;
  const remaining = entries.filter(item => item.id !== id);
  // Keep the empty array in memory even when removal fails, so the completed
  // saved ID cannot resurrect while this runtime remains alive.
  pendingByKey.set(key, remaining);
  persist(key, remaining);
}

function uncertain(error) {
  return !error || ['offline', 'cloud_init_failed', 'call_failed', 'bad_response', 'internal_error', 'query_in_progress', 'request_in_progress', 'request_budget_exhausted', 'busy'].includes(error.code);
}

module.exports = { begin, hasPending, finish, uncertain };
