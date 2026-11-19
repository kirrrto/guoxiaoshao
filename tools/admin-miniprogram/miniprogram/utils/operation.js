const { newId } = require('./api');
const { localKey } = require('./local-key');

function readPending(key) {
  const saved = wx.getStorageSync(key);
  if (saved === '' || saved === undefined || saved === null) return [];
  // The previous operator client stored a single {id, fingerprint} in this key.
  const entries = saved.pending === undefined ? [saved] : saved.pending;
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.id !== 'string'
      || !/^[A-Za-z0-9_-]{4,64}$/.test(entry.id) || typeof entry.fingerprint !== 'string')) throw Error('Invalid pending grant');
  return entries;
}

function persist(key, entries) {
  if (entries.length) wx.setStorageSync(key, { ...entries[entries.length - 1], pending: entries });
  else wx.removeStorageSync(key);
  const stored = readPending(key);
  return stored.length === entries.length && stored.every((item, i) =>
    item.id === entries[i].id && item.fingerprint === entries[i].fingerprint);
}

function begin(kind, payload) {
  const key = localKey(`gxs_pending_${kind}_v1`);
  const fingerprint = JSON.stringify(payload, Object.keys(payload).sort());
  try {
    const entries = readPending(key);
    const existing = entries.find(entry => entry.fingerprint === fingerprint);
    if (existing) return existing.id;
    const entry = { id: newId(kind), fingerprint };
    if (persist(key, [...entries, entry])) return entry.id;
  } catch (_) { /* Without a durable ID the grant must not be dispatched. */ }
  throw Error('本机无法保存或读取操作编号，本次未发起发放。请恢复存储后按原内容重试。');
}

function finish(kind, id) {
  const key = localKey(`gxs_pending_${kind}_v1`);
  try {
    const entries = readPending(key);
    const remaining = entries.filter(entry => entry.id !== id);
    return remaining.length === entries.length || persist(key, remaining);
  } catch (_) { return false; }
}

module.exports = { begin, finish };
