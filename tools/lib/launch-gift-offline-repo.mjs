import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../../cloudfunctions/gxs_api/lib/collections');
const { launchGiftMethods } = require('../../cloudfunctions/gxs_api/lib/repo/launch-gift');
const { needsPlanMetadata, resolvePlanMetadata } = require('../../cloudfunctions/gxs_api/lib/rules/member-plan');
const clone = value => structuredClone(value);

/** Frozen export adapter; no credentials, SDK, network or live invocation. */
export function createOfflineLaunchGiftRepo(data, { onCommit = async () => {} } = {}) {
  let tables = clone(data.collections);
  for (const name of [C.orders, C.users, C.config]) if (!Array.isArray(tables[name])) throw new Error(`export_missing_collection:${name}`);
  for (const rows of Object.values(tables)) {
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row._id !== 'string' || ids.has(row._id)) throw new Error('invalid_or_duplicate_export_id');
      ids.add(row._id);
    }
  }
  const exported = () => ({ ...clone(data), collections: clone(tables) });
  let tail = Promise.resolve();
  const run = body => {
    const result = tail.then(async () => {
      const current = clone(tables); let changed = false;
      const tx = {
        get: async (name, id) => clone((current[name] || []).find(row => row._id === id) || null),
        put: async (name, doc) => {
          const rows = current[name] || (current[name] = []), index = rows.findIndex(row => row._id === doc._id);
          if (index < 0) rows.push(clone(doc)); else rows[index] = clone(doc);
          changed = true;
        },
      };
      const value = await body(tx);
      if (changed) { tables = current; await onCommit(exported()); }
      return value;
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    async getLaunchGiftOrderWatermark() { return tables[C.orders].map(row => row._id).sort().at(-1) || null; },
    async scanLaunchGiftOrders({ afterId, throughId, limit = 100 }) {
      return tables[C.orders].filter(row => (!afterId || row._id > afterId) && row._id <= throughId)
        .sort((a, b) => a._id < b._id ? -1 : 1).slice(0, Math.max(1, Math.min(100, limit))).map(clone);
    },
    ...launchGiftMethods(run, { hydrateMemberPlansIn: async (tx, user) => {
      if (!needsPlanMetadata(user)) return false;
      user.membership = (await resolvePlanMetadata(user, id => tx.get(C.orders, id))).membership;
      return true;
    } }),
    exportData: exported,
  };
}
