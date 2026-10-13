const { newId } = require('./api');
const { localKey } = require('./local-key');

// Retain an uncertain operation across retries and page/app recreation.
// A new target is a new intent; a completed response releases its key.
function begin(kind, payload) {
  const key = localKey(`gxs_pending_${kind}_v1`);
  const normalized = { ...payload };
  if (Array.isArray(normalized.storeNumbers)) normalized.storeNumbers = [...new Set(normalized.storeNumbers)].sort();
  const fingerprint = JSON.stringify(Object.keys(normalized).sort().reduce((out, field) => { out[field] = normalized[field]; return out; }, {}));
  let saved;
  try { saved = wx.getStorageSync(key); } catch (e) { /* storage unavailable */ }
  if (saved && saved.fingerprint === fingerprint && saved.id) return saved.id;
  const id = newId(kind);
  try { wx.setStorageSync(key, { id, fingerprint }); } catch (e) { /* still safe within this request */ }
  return id;
}

function finish(kind) {
  try { wx.removeStorageSync(localKey(`gxs_pending_${kind}_v1`)); } catch (e) { /* ignore */ }
}

function uncertain(error) {
  return !error || ['cloud_init_failed', 'call_failed', 'bad_response', 'internal_error', 'query_in_progress', 'request_in_progress', 'busy'].includes(error.code);
}

module.exports = { begin, finish, uncertain };
