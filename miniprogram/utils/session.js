/**
 * Best-effort UI cache. Read each key once per process and prefer the async
 * storage bridge. Never use this for payment, quota or authorization receipts:
 * those operations must retain their existing durable recovery semantics.
 */
const values = new Map();
const reads = new Map();
const revisions = new Map();
const writes = new Map();
const STORAGE_TIMEOUT_MS = 1200;

function readSession(key) {
  if (values.has(key)) return Promise.resolve(values.get(key));
  if (reads.has(key)) return reads.get(key);
  const revision = revisions.get(key) || 0;
  const pending = new Promise(resolve => {
    let settled = false, timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      // A user can save a new selection before the native read comes back.
      // That older snapshot must neither replace memory nor reach its caller.
      if ((revisions.get(key) || 0) === revision) values.set(key, value === undefined ? null : value);
      resolve(values.has(key) ? values.get(key) : null);
    };
    try {
      if (typeof wx.getStorage === 'function') {
        timer = setTimeout(() => finish(null), STORAGE_TIMEOUT_MS);
        wx.getStorage({ key, success: result => finish(result.data), fail: () => finish(null) });
      } else finish(wx.getStorageSync(key));
    } catch (_) { finish(null); }
  });
  reads.set(key, pending);
  pending.then(() => { if (reads.get(key) === pending) reads.delete(key); });
  return pending;
}

function persist(key, value, remove) {
  const method = remove ? 'removeStorage' : 'setStorage';
  if (typeof wx[method] !== 'function') {
    try { if (remove) wx.removeStorageSync(key); else wx.setStorageSync(key, value); }
    catch (_) { /* A UI cache may fall back to memory. */ }
    return Promise.resolve();
  }
  // Serialize native writes per key so a slower old callback cannot put an
  // earlier selection back on disk after a newer one has already been saved.
  const previous = writes.get(key);
  const run = () => new Promise(resolve => {
    try {
      wx[method]({ key, ...(remove ? {} : { data: value }), success: resolve, fail: resolve });
    } catch (_) { resolve(); }
  });
  const pending = previous ? previous.then(run) : run();
  writes.set(key, pending);
  pending.then(() => { if (writes.get(key) === pending) writes.delete(key); });
  return pending;
}

function writeSession(key, value) {
  revisions.set(key, (revisions.get(key) || 0) + 1);
  values.set(key, value);
  return persist(key, value, false);
}

function removeSession(key) {
  revisions.set(key, (revisions.get(key) || 0) + 1);
  values.set(key, null);
  return persist(key, null, true);
}

module.exports = { readSession, writeSession, removeSession };
