/**
 * In-memory twin of cloudfunctions/gxs_api/lib/repo/cloudbase-repo.js.
 * Same method names and return shapes; documents are deep-copied on the way
 * in and out so tests cannot accidentally share references with the store.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COLLECTIONS } = require('../../cloudfunctions/gxs_api/lib/collections.js');
const { atomicMethods } = require('../../cloudfunctions/gxs_api/lib/repo/atomic-ops.js');
const { NOTIFIABLE_TYPES } = require('../../cloudfunctions/gxs_api/lib/engine/events.js');
const { dayKey: beijingDayKey, startOfDay, addDays } = require('../../cloudfunctions/gxs_api/lib/time.js');

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const byDesc = field => (a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0);
const byAsc = field => (a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0);

export function createMemoryRepo(seed = {}) {
  const tables = new Map(Object.values(COLLECTIONS).map(name => [name, new Map()]));
  const table = name => tables.get(name);
  const put = (name, doc) => table(name).set(doc._id, clone(doc));
  const get = (name, id) => clone(table(name).get(id)) || null;
  const all = name => [...table(name).values()].map(clone);
  const insert = (name, doc) => {
    if (table(name).has(doc._id)) {
      const error = new Error('duplicate key');
      error.errCode = -502001;
      throw error;
    }
    put(name, doc);
  };
  for (const [name, docs] of Object.entries(seed)) for (const doc of docs) put(name, doc);
  let transactionTail = Promise.resolve();
  const run = body => {
    const pending = transactionTail.then(async () => {
      const local = new Map([...tables].map(([name, rows]) => [name, new Map([...rows].map(([id, value]) => [id, clone(value)]))]));
      const writes = [];
      const result = await body({
        get: async (name, id) => clone(local.get(name).get(id)) || null,
        put: async (name, doc) => {
          if (repo.transactionWriteHook) await repo.transactionWriteHook(name, clone(doc));
          local.get(name).set(doc._id, clone(doc));
          writes.push([name, doc._id]);
        },
      });
      for (const [name, id] of writes) tables.get(name).set(id, local.get(name).get(id));
      return clone(result);
    });
    transactionTail = pending.catch(() => {});
    return pending;
  };

  const repo = {
    tables,
    async getUser(userKey) { return get(COLLECTIONS.users, userKey); },
    async createUser(user) {
      if (table(COLLECTIONS.users).has(user._id)) return get(COLLECTIONS.users, user._id);
      put(COLLECTIONS.users, user);
      return clone(user);
    },
    async updateUser(userKey, patch) {
      const user = table(COLLECTIONS.users).get(userKey);
      if (!user) throw new Error('user_missing');
      for (const [key, value] of Object.entries(patch)) {
        if (key.includes('.')) {
          const parts = key.split('.');
          let cursor = user;
          for (const part of parts.slice(0, -1)) cursor = cursor[part] = cursor[part] || {};
          cursor[parts.at(-1)] = clone(value);
        } else {
          user[key] = clone(value);
        }
      }
    },
    async listLedger(userKey, { dayKey, limit } = {}) {
      return all(COLLECTIONS.ledger).filter(e => e.userKey === userKey && (!dayKey || e.dayKey === dayKey)).sort(byDesc('createdAt')).slice(0, limit || 50);
    },
    async getConfig() { return get(COLLECTIONS.config, 'runtime'); },
    async saveConfig(config) { put(COLLECTIONS.config, { ...config, _id: 'runtime' }); },
    async getCatalogMeta() { return get(COLLECTIONS.config, 'catalog'); },
    async getBootstrapMetadata() { return { catalogMeta: get(COLLECTIONS.config, 'catalog'), collectorStatus: get(COLLECTIONS.config, 'collector_status') }; },
    async listStores() { return all(COLLECTIONS.catalogStores); },
    async listProducts() { return all(COLLECTIONS.catalogProducts); },
    async getProduct(partNumber) { return get(COLLECTIONS.catalogProducts, partNumber); },
    async getStores(storeNumbers) { return storeNumbers.map(s => get(COLLECTIONS.catalogStores, s)).filter(Boolean); },
    async replaceCatalog({ stores, products, meta }) {
      for (const store of stores) put(COLLECTIONS.catalogStores, store);
      for (const product of products) put(COLLECTIONS.catalogProducts, product);
      put(COLLECTIONS.config, { ...meta, _id: 'catalog' });
    },
    async getLatest(targetKeys) { return targetKeys.map(k => get(COLLECTIONS.latest, k)).filter(Boolean); },
    async getObservationCoverage({ partNumber, storeNumbers = [], dayKey }) {
      return all(COLLECTIONS.observationDays)
        .filter(row => row.partNumber === partNumber && row.dayKey === dayKey && (!storeNumbers.length || storeNumbers.includes(row.storeNumber)))
        .sort(byAsc('storeNumber'));
    },
    async saveLatest(latest) { put(COLLECTIONS.latest, latest); },
    async saveEvents(events) {
      let inserted = 0;
      for (const event of events) {
        if (table(COLLECTIONS.events).has(event._id)) continue;
        put(COLLECTIONS.events, event);
        inserted++;
      }
      return inserted;
    },
    async listEvents({ partNumber, storeNumbers, dayKey, limit }) {
      return all(COLLECTIONS.events)
        .filter(e => e.partNumber === partNumber && e.dayKey === dayKey && (!storeNumbers || !storeNumbers.length || storeNumbers.includes(e.storeNumber)))
        .sort(byDesc('detectedAt')).slice(0, limit || 100);
    },
    async getEventHistory({ partNumber, storeNumbers, dayKey, cursor, limit = 100, snapshotAt, includeCounts = true }) {
      const rows = all(COLLECTIONS.events).filter(e => e.partNumber === partNumber && e.dayKey === dayKey && (!storeNumbers.length || storeNumbers.includes(e.storeNumber)) && e.detectedAt <= snapshotAt).sort((a, b) => byDesc('detectedAt')(a, b) || byDesc('_id')(a, b));
      const page = rows.filter(e => !cursor || e.detectedAt < cursor.detectedAt || (e.detectedAt === cursor.detectedAt && e._id < cursor.id));
      if (!includeCounts) return { events: page.slice(0, limit), hasMore: page.length > limit, total: null, summary: null };
      const types = { first_seen_available: 'available', restock_confirmed: 'restocks', recovered_available: 'recoveries', became_unavailable: 'ended' };
      const summary = { available: 0, restocks: 0, recoveries: 0, ended: 0, lastHourRestocks: 0 };
      for (const event of rows) if (types[event.type]) summary[types[event.type]]++;
      summary.lastHourRestocks = dayKey === beijingDayKey(snapshotAt) ? all(COLLECTIONS.events).filter(e => e.partNumber === partNumber && (!storeNumbers.length || storeNumbers.includes(e.storeNumber)) && e.type === 'restock_confirmed' && e.detectedAt <= snapshotAt && Date.parse(e.detectedAt) >= Date.parse(snapshotAt) - 3600000).length : 0;
      return { events: page.slice(0, limit), hasMore: page.length > limit, total: rows.length, summary };
    },
    async listEventsByTargets(targetKeys, { since, limit } = {}) {
      return all(COLLECTIONS.events).filter(e => targetKeys.includes(e.targetKey) && (!since || e.detectedAt >= since)).sort(byDesc('detectedAt')).slice(0, limit || 100);
    },
    async getQuery(id) { return get(COLLECTIONS.queries, id); },
    async saveQuery(query) { put(COLLECTIONS.queries, query); },
    async listQueries(userKey, limit) { return all(COLLECTIONS.queries).filter(q => q.userKey === userKey).sort(byDesc('createdAt')).slice(0, limit || 20); },
    async listRecentHistoryViews(userKey, limit = 20) {
      return all(COLLECTIONS.queries).filter(query => query.userKey === userKey && query.kind === 'history' && query.status === 'success')
        .sort((a, b) => byDesc('finishedAt')(a, b) || byDesc('_id')(a, b)).slice(0, limit)
        .map(query => ({ partNumber: query.partNumber, dayKey: query.dayKey, storeNumbers: query.storeNumbers, finishedAt: query.finishedAt, createdAt: query.createdAt }));
    },
    async listExpiredQueries(userKey, staleBefore, limit = 20) { return all(COLLECTIONS.queries).filter(q => q.userKey === userKey && q.status === 'pending' && q.leaseUntil && q.leaseUntil <= staleBefore).sort((a, b) => byAsc('leaseUntil')(a, b) || byAsc('_id')(a, b)).slice(0, limit); },
    async findCompletedHistoryQuery(userKey, { startAt, endAt }) { return all(COLLECTIONS.queries).filter(q => q.userKey === userKey && q.kind === 'history' && q.status === 'success' && q.finishedAt >= startAt && q.finishedAt < endAt).sort((a, b) => byDesc('finishedAt')(a, b) || byDesc('_id')(a, b))[0] || null; },
    async listFollows(userKey) { return all(COLLECTIONS.follows).filter(f => f.userKey === userKey && f.status !== 'removed').sort(byAsc('createdAt')); },
    async getFollow(id) { return get(COLLECTIONS.follows, id); },
    async saveFollow(follow) { put(COLLECTIONS.follows, follow); },
    async listActiveFollows() { return all(COLLECTIONS.follows).filter(f => f.status === 'active'); },
    async getUsers(userKeys) { return userKeys.map(k => get(COLLECTIONS.users, k)).filter(Boolean); },
    async getOrder(id) { return get(COLLECTIONS.orders, id); },
    async getOrderByOutTradeNo(outTradeNo) { return all(COLLECTIONS.orders).find(order => order.outTradeNo === outTradeNo) || null; },
    async listReconcileOrders(options = {}) {
      const { limit = 10, nowIso = new Date().toISOString() } = typeof options === 'number' ? { limit: options } : options;
      const cap = Number.isInteger(limit) ? Math.max(1, Math.min(25, limit)) : 10;
      const cutoff = new Date(Date.parse(nowIso) - 30 * 86400000).toISOString();
      return all(COLLECTIONS.orders).filter(o => o.provider === 'wechat_virtual_payment' && ['created', 'paid', 'fulfilled', 'partially_refunded'].includes(o.status)
        && (['created', 'paid'].includes(o.status) || !o.providerAcknowledgedAt || o.fulfilledAt >= cutoff))
        .sort((a, b) => String(a.lastReconciledAt || '').localeCompare(String(b.lastReconciledAt || '')) || a._id.localeCompare(b._id)).slice(0, cap);
    },
    async saveOrder(order) { put(COLLECTIONS.orders, order); },
    async listOrders(userKey, limit) { return all(COLLECTIONS.orders).filter(o => o.userKey === userKey).sort(byDesc('createdAt')).slice(0, limit || 20); },
    async getNotification(id) { return get(COLLECTIONS.notifications, id); },
    async listSince(collection, field, since, limit = Infinity) { return all(collection).filter(doc => doc[field] >= since).sort(byDesc(field)).slice(0, limit); },
    async updateNotification(id, patch) {
      const current = table(COLLECTIONS.notifications).get(id);
      if (!current) throw new Error('notification_missing');
      Object.assign(current, clone(patch));
    },
    async listNotifications(userKey, limit) { return all(COLLECTIONS.notifications).filter(n => n.userKey === userKey).sort((a, b) => byDesc('createdAt')(a, b) || byDesc('_id')(a, b)).slice(0, limit || 50); },
    async listVisibleNotifications({ userKey, view, snapshot, cursor, limit }) {
      const rows = all(COLLECTIONS.notifications).filter(n => n.userKey === userKey && !n.userHiddenAt
        && (n.viewSequence != null ? n.viewSequence > (view.clearedThroughSequence || 0) && n.viewSequence <= snapshot.sequence : n.createdAt <= snapshot.at && (!view.legacyClearBefore || n.createdAt > view.legacyClearBefore))
        && (!cursor || n.createdAt < cursor.createdAt || n.createdAt === cursor.createdAt && n._id < cursor.id))
        .sort((a, b) => byDesc('createdAt')(a, b) || byDesc('_id')(a, b));
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    async listUnprocessedEvents({ limit = 100 } = {}) { return all(COLLECTIONS.events).filter(e => NOTIFIABLE_TYPES.has(e.type) && !e.notificationPlannedAt).sort((a, b) => byAsc('detectedAt')(a, b) || byAsc('_id')(a, b)).slice(0, limit); },
    async markEventPlanned(id, nowIso) { const event = get(COLLECTIONS.events, id); if (event) put(COLLECTIONS.events, { ...event, notificationPlannedAt: nowIso }); },
    async listPendingNotifications({ limit = 100 } = {}) { return all(COLLECTIONS.notifications).filter(t => t.status === 'pending').sort((a, b) => byAsc('createdAt')(a, b) || byAsc('_id')(a, b)).slice(0, limit); },
    async reconcileExpiredNotifications({ now }) { let reconciled = 0; for (const task of all(COLLECTIONS.notifications)) { if (task.status === 'sending' && task.leaseUntil <= now) { put(COLLECTIONS.notifications, { ...task, status: 'uncertain', reason: 'worker_expired_after_claim', finishedAt: now }); reconciled++; } } return { reconciled }; },
    async releaseLease({ id, ownerId }) {
      const current = table(COLLECTIONS.config).get(id);
      if (current && current.ownerId === ownerId) current.expiresAt = '1970-01-01T00:00:00.000Z';
    },
    async getCollectorStatus() { return get(COLLECTIONS.config, 'collector_status'); },
    async getRetentionStatus() { return get(COLLECTIONS.config, 'retention_status'); },
    async saveRetentionStatus(status) { put(COLLECTIONS.config, status); },
    async purgeExpiredData({ firstDay, cutoffIso }) {
      const removed = {};
      const drop = (name, collection, expired) => {
        removed[name] = 0;
        for (const [id, doc] of table(collection)) if (expired(doc)) { table(collection).delete(id); removed[name] += 1; }
      };
      drop('events', COLLECTIONS.events, doc => doc.dayKey < firstDay);
      drop('queries', COLLECTIONS.queries, doc => doc.createdAt < cutoffIso && doc.status !== 'pending');
      drop('notifications', COLLECTIONS.notifications, doc => doc.createdAt < cutoffIso && !['pending', 'sending'].includes(doc.status));
      drop('targetHealth', COLLECTIONS.health, doc => doc.recordedAt < cutoffIso);
      drop('subscriptionGrants', COLLECTIONS.config, doc => doc.kind === 'subscription_grant' && doc.createdAt < cutoffIso);
      drop('queryGuards', COLLECTIONS.config, doc => doc.kind === 'query_guard' && doc.updatedAt < cutoffIso);
      // Same 60-day _id window as the CloudBase implementation.
      const oldestBudget = beijingDayKey(addDays(startOfDay(firstDay), -60));
      drop('budgets', COLLECTIONS.config, doc => /^collector_budget_\d{4}-\d{2}-\d{2}$/.test(doc._id) && doc._id.slice(-10) < firstDay && doc._id.slice(-10) >= oldestBudget);
      return { removed, errors: {} };
    },
    async count(collection, where) {
      return all(collection).filter(doc => !where || Object.entries(where).every(([k, v]) => doc[k] === v)).length;
    },
    insert,
    ...atomicMethods(run),
  };
  return repo;
}
