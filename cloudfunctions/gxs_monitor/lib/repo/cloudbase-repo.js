'use strict';
/**
 * CloudBase NoSQL implementation of the repository interface used by the
 * services. Every method is small and explicit so tests can provide an
 * in-memory twin (tests/helpers/memory-repo.mjs) with identical semantics.
 *
 * Conventions:
 *  - document ids are deterministic business keys where idempotency matters
 *    (users, ledger entries, queries, latest, events);
 *  - reads never throw on "not found": they return null / [];
 *  - the ledger + balance change happens inside one transaction.
 */
const { COLLECTIONS } = require('../collections');
const { isDuplicateKeyError } = require('../errors');
const { atomicMethods } = require('./atomic-ops');
const { NOTIFIABLE_TYPES } = require('../engine/events');
const { dayKey: beijingDayKey } = require('../time');

const CHUNK = 20;

function isTransactionConflict(error) {
  if (!error || typeof error !== 'object') return false;
  const values = [error.code, error.errCode, error.errMsg, error.message].filter(value => typeof value === 'string');
  // wx-server-sdk may replace the original code with -501001 while retaining
  // the explicit CloudBase conflict inside errMsg. Do not retry generic
  // resource/network failures: their write outcome is not known.
  return values.some(value => /(?:^|[^A-Z0-9_])DATABASE_TRANSACTION_CONFLICT(?:$|[^A-Z0-9_])|\bResourceUnavailable\.TransactionConflict\b|\bdatabase transaction conflict\b|事务冲突/i.test(value));
}

async function readOne(query) {
  const result = await query.limit(1).get();
  return result.data && result.data.length ? result.data[0] : null;
}

async function readAll(query, limit = Infinity) {
  // The server SDK caps each get(). Paginate explicitly, including bulk reads.
  const rows = [];
  while (rows.length < limit) {
    const size = Math.min(100, limit - rows.length);
    const result = await query.skip(rows.length).limit(size).get();
    const page = result.data || [];
    rows.push(...page);
    if (page.length < size) break;
  }
  return rows;
}

async function transactionGet(transaction, collection, id) {
  try {
    const result = await transaction.collection(collection).doc(id).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (/not exist|not found|-502004|DOCUMENT_NOT_FOUND/i.test(String(error.errMsg || error.message || error.errCode))) return null;
    throw error;
  }
}

function createCloudbaseRepo(db) {
  const _ = db.command;
  const col = name => db.collection(name);
  const run = body => db.runTransaction(async transaction => {
    const cache = new Map();
    const get = async (collection, id) => {
      const key = `${collection}\0${id}`;
      if (!cache.has(key)) cache.set(key, await transactionGet(transaction, collection, id));
      return cache.get(key);
    };
    const put = async (collection, doc) => {
      const previous = await get(collection, doc._id);
      const { _id, ...data } = doc;
      // SDK update() flattens nested objects into dotted $set fields. Replacing
      // response:null with response:{...} that way fails in MongoDB. set()
      // replaces the transaction's complete document and preserves null/object transitions.
      if (previous) await transaction.collection(collection).doc(_id).set({ data });
      else await transaction.collection(collection).add({ data: doc });
      cache.set(`${collection}\0${_id}`, doc);
    };
    try {
      return await body({ get, put });
    } catch (error) {
      // wx-server-sdk wraps read/write errors and can discard CloudBase's
      // string code. Restore only the explicit transaction-conflict signal so
      // the SDK's bounded retry loop also covers read/write conflicts.
      if (isTransactionConflict(error)) error.code = 'DATABASE_TRANSACTION_CONFLICT';
      throw error;
    }
  });
  const readIds = async (collection, ids) => {
    const unique = [...new Set(ids)];
    const result = [];
    for (let i = 0; i < unique.length; i += CHUNK) result.push(...await readAll(col(collection).where({ _id: _.in(unique.slice(i, i + CHUNK)) }).orderBy('_id', 'asc')));
    return result;
  };

  return {
    // ---- users -------------------------------------------------------
    async getUser(userKey) {
      return readOne(col(COLLECTIONS.users).where({ _id: userKey }));
    },
    async createUser(user) {
      try {
        await col(COLLECTIONS.users).add({ data: user });
        return user;
      } catch (error) {
        if (isDuplicateKeyError(error)) return readOne(col(COLLECTIONS.users).where({ _id: user._id }));
        throw error;
      }
    },
    async updateUser(userKey, patch) {
      await col(COLLECTIONS.users).doc(userKey).update({ data: patch });
    },

    // ---- quota ledger --------------------------------------------------
    // Atomic ledger and lifecycle methods are attached below via atomicMethods.
    async listLedger(userKey, { dayKey, limit } = {}) {
      const where = dayKey ? { userKey, dayKey } : { userKey };
      return readAll(col(COLLECTIONS.ledger).where(where).orderBy('createdAt', 'desc').orderBy('_id', 'desc'), limit || 50);
    },

    // ---- config & catalog ---------------------------------------------
    async getConfig() {
      return readOne(col(COLLECTIONS.config).where({ _id: 'runtime' }));
    },
    async saveConfig(config) {
      const { _id, ...data } = config;
      await col(COLLECTIONS.config).doc('runtime').set({ data });
    },
    async getCatalogMeta() {
      return readOne(col(COLLECTIONS.config).where({ _id: 'catalog' }));
    },
    async getBootstrapMetadata() {
      const result = await col(COLLECTIONS.config).where({ _id: _.in(['catalog', 'collector_status']) }).limit(2).get();
      const rows = result.data || [];
      return { catalogMeta: rows.find(row => row._id === 'catalog') || null, collectorStatus: rows.find(row => row._id === 'collector_status') || null };
    },
    async listStores() {
      return readAll(col(COLLECTIONS.catalogStores).orderBy('_id', 'asc'));
    },
    async listProducts() {
      return readAll(col(COLLECTIONS.catalogProducts).orderBy('_id', 'asc'));
    },
    async getProduct(partNumber) {
      return readOne(col(COLLECTIONS.catalogProducts).where({ _id: partNumber }));
    },
    async getStores(storeNumbers) {
      if (!storeNumbers.length) return [];
      return readIds(COLLECTIONS.catalogStores, storeNumbers);
    },
    async replaceCatalog({ stores, products, meta }) {
      const upsert = async (collection, docs) => {
        for (let i = 0; i < docs.length; i += CHUNK) {
          await Promise.all(docs.slice(i, i + CHUNK).map(doc => {
            const { _id, ...data } = doc;
            return col(collection).doc(_id).set({ data });
          }));
        }
      };
      await upsert(COLLECTIONS.catalogStores, stores);
      await upsert(COLLECTIONS.catalogProducts, products);
      const { _id, ...metaData } = meta;
      await col(COLLECTIONS.config).doc('catalog').set({ data: metaData });
    },

    // ---- observations, latest, events ----------------------------------
    async getLatest(targetKeys) {
      if (!targetKeys.length) return [];
      return readIds(COLLECTIONS.latest, targetKeys);
    },
    async saveLatest(latest) {
      const { _id, ...data } = latest;
      await col(COLLECTIONS.latest).doc(_id).set({ data });
    },
    async saveEvents(events) {
      let inserted = 0;
      for (const event of events) {
        try {
          await col(COLLECTIONS.events).add({ data: event });
          inserted++;
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
        }
      }
      return inserted;
    },
    async listEvents({ partNumber, storeNumbers, dayKey, limit }) {
      const where = { partNumber, dayKey };
      if (storeNumbers && storeNumbers.length) where.storeNumber = _.in(storeNumbers);
      return readAll(col(COLLECTIONS.events).where(where).orderBy('detectedAt', 'desc').orderBy('_id', 'desc'), limit || 100);
    },
    async getEventHistory({ partNumber, storeNumbers, dayKey, cursor, limit = 100, snapshotAt }) {
      const base = { partNumber, dayKey, detectedAt: _.lte(snapshotAt) };
      if (storeNumbers.length) base.storeNumber = _.in(storeNumbers);
      const where = cursor ? _.and([base, _.or([{ detectedAt: _.lt(cursor.detectedAt) }, { detectedAt: cursor.detectedAt, _id: _.lt(cursor.id) }])]) : base;
      const hourStart = new Date(Date.parse(snapshotAt) - 3600000).toISOString();
      // Today's rolling hour may cross Beijing midnight. Count both date
      // partitions while preserving SKU/store filters and the snapshot cutoff.
      // Older-day queries must not expose today's restricted product activity.
      const hourDays = dayKey === beijingDayKey(snapshotAt) ? [...new Set([beijingDayKey(hourStart), dayKey])] : [];
      const [rows, total, ...counts] = await Promise.all([
        readAll(col(COLLECTIONS.events).where(where).orderBy('detectedAt', 'desc').orderBy('_id', 'desc'), limit + 1),
        col(COLLECTIONS.events).where(base).count(),
        ...['first_seen_available', 'restock_confirmed', 'recovered_available', 'became_unavailable'].map(type => col(COLLECTIONS.events).where({ ...base, type }).count()),
        Promise.all(hourDays.map(hourDay => col(COLLECTIONS.events).where(_.and([{ ...base, dayKey: hourDay, type: 'restock_confirmed' }, { detectedAt: _.gte(hourStart) }])).count()))
          .then(parts => ({ total: parts.reduce((sum, part) => sum + part.total, 0) })),
      ]);
      return { events: rows.slice(0, limit), hasMore: rows.length > limit, total: total.total, summary: Object.fromEntries(['available', 'restocks', 'recoveries', 'ended', 'lastHourRestocks'].map((key, i) => [key, counts[i].total])) };
    },
    async listEventsByTargets(targetKeys, { since, limit } = {}) {
      if (!targetKeys.length) return [];
      const where = { targetKey: _.in(targetKeys) };
      if (since) where.detectedAt = _.gte(since);
      return readAll(col(COLLECTIONS.events).where(where).orderBy('detectedAt', 'desc'), limit || 100);
    },

    // ---- queries (manual) ----------------------------------------------
    async getQuery(id) {
      return readOne(col(COLLECTIONS.queries).where({ _id: id }));
    },
    async saveQuery(query) {
      const { _id, ...data } = query;
      await col(COLLECTIONS.queries).doc(_id).set({ data });
    },
    async listQueries(userKey, limit) {
      return readAll(col(COLLECTIONS.queries).where({ userKey }).orderBy('createdAt', 'desc').orderBy('_id', 'desc'), limit || 20);
    },
    async listRecentHistoryViews(userKey, limit = 20) {
      return readAll(col(COLLECTIONS.queries).where({ userKey, kind: 'history', status: 'success' })
        .field({ partNumber: true, dayKey: true, storeNumbers: true, finishedAt: true, createdAt: true })
        .orderBy('finishedAt', 'desc').orderBy('_id', 'desc'), limit);
    },
    async listExpiredQueries(userKey, staleBefore, limit = 20) {
      return readAll(col(COLLECTIONS.queries).where({ userKey, status: 'pending', leaseUntil: _.lte(staleBefore) }).orderBy('leaseUntil', 'asc').orderBy('_id', 'asc'), limit);
    },
    async findCompletedHistoryQuery(userKey, { startAt, endAt }) {
      return readOne(col(COLLECTIONS.queries).where({ userKey, kind: 'history', status: 'success', finishedAt: _.gte(startAt).and(_.lt(endAt)) }).orderBy('finishedAt', 'desc').orderBy('_id', 'desc'));
    },

    // ---- follows --------------------------------------------------------
    async listFollows(userKey) {
      return readAll(col(COLLECTIONS.follows).where({ userKey, status: _.neq('removed') }).orderBy('createdAt', 'asc').orderBy('_id', 'asc'));
    },
    async getFollow(id) {
      return readOne(col(COLLECTIONS.follows).where({ _id: id }));
    },
    async saveFollow(follow) {
      const { _id, ...data } = follow;
      await col(COLLECTIONS.follows).doc(_id).set({ data });
    },
    async listActiveFollows() {
      return readAll(col(COLLECTIONS.follows).where({ status: 'active' }).orderBy('_id', 'asc'));
    },
    async getUsers(userKeys) {
      if (!userKeys.length) return [];
      return readIds(COLLECTIONS.users, userKeys);
    },

    // ---- orders & notifications ------------------------------------------
    async getOrder(id) {
      return readOne(col(COLLECTIONS.orders).where({ _id: id }));
    },
    async getOrderByOutTradeNo(outTradeNo) {
      return readOne(col(COLLECTIONS.orders).where({ outTradeNo }));
    },
    async listReconcileOrders(limit = 100) {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const where = _.or([{ status: _.in(['created', 'paid']) }, { status: 'fulfilled', providerAcknowledgedAt: _.eq(null) }, { status: 'fulfilled', providerAcknowledgedAt: _.exists(false) }, { status: 'fulfilled', fulfilledAt: _.gte(cutoff) }]);
      const rows = await readAll(col(COLLECTIONS.orders).where(where).orderBy('createdAt', 'asc').orderBy('_id', 'asc'));
      rows.sort((a, b) => String(a.lastReconciledAt || '').localeCompare(String(b.lastReconciledAt || '')) || a.createdAt.localeCompare(b.createdAt) || a._id.localeCompare(b._id));
      return rows.slice(0, Math.max(1, Math.min(1000, limit)));
    },
    async saveOrder(order) {
      const { _id, ...data } = order;
      await col(COLLECTIONS.orders).doc(_id).set({ data });
    },
    async listOrders(userKey, limit) {
      return readAll(col(COLLECTIONS.orders).where({ userKey }).orderBy('createdAt', 'desc'), limit || 20);
    },
    // Insertion and per-user view sequence are attached via atomicMethods.
    async updateNotification(id, patch) {
      await col(COLLECTIONS.notifications).doc(id).update({ data: patch });
    },
    async listNotifications(userKey, limit) {
      return readAll(col(COLLECTIONS.notifications).where({ userKey }).orderBy('createdAt', 'desc').orderBy('_id', 'desc'), limit || 50);
    },
    async listVisibleNotifications({ userKey, view, snapshot, cursor, limit }) {
      const legacy = [_.or([{ viewSequence: _.exists(false) }, { viewSequence: _.eq(null) }]), { createdAt: _.lte(snapshot.at) }];
      if (view.legacyClearBefore) legacy.push({ createdAt: _.gt(view.legacyClearBefore) });
      const filters = [
        { userKey },
        _.or([{ userHiddenAt: _.exists(false) }, { userHiddenAt: _.eq(null) }]),
        _.or([{ viewSequence: _.gt(view.clearedThroughSequence || 0).and(_.lte(snapshot.sequence)) }, _.and(legacy)]),
      ];
      const older = position => _.or([{ createdAt: _.lt(position.createdAt) }, { createdAt: position.createdAt, _id: _.lt(position.id) }]);
      if (cursor) filters.push(older(cursor));
      const query = where => col(COLLECTIONS.notifications).where(_.and(where)).orderBy('createdAt', 'desc').orderBy('_id', 'desc');
      const result = await query(filters).limit(limit).get();
      const items = result.data || [];
      if (items.length < limit) return { items, hasMore: false };
      const last = items[items.length - 1];
      // Keyset lookahead avoids skip() losing an item if a deletion occurs
      // between the main read and the one-row hasMore check.
      const extra = await query([...filters, older({ createdAt: last.createdAt, id: last._id })]).limit(1).get();
      return { items, hasMore: Boolean(extra.data && extra.data.length) };
    },
    async listUnprocessedEvents({ limit = 100 } = {}) {
      return readAll(col(COLLECTIONS.events).where(_.and([{ type: _.in([...NOTIFIABLE_TYPES]) }, _.or([{ notificationPlannedAt: _.eq(null) }, { notificationPlannedAt: _.exists(false) }])])).orderBy('detectedAt', 'asc').orderBy('_id', 'asc'), limit);
    },
    async markEventPlanned(eventId, nowIso) {
      await col(COLLECTIONS.events).doc(eventId).update({ data: { notificationPlannedAt: nowIso } });
    },
    async listPendingNotifications({ limit = 100 } = {}) {
      return readAll(col(COLLECTIONS.notifications).where({ status: 'pending' }).orderBy('createdAt', 'asc').orderBy('_id', 'asc'), limit);
    },
    async reconcileExpiredNotifications({ now }) {
      const result = await col(COLLECTIONS.notifications).where({ status: 'sending', leaseUntil: _.lte(now) }).update({ data: { status: 'uncertain', reason: 'worker_expired_after_claim', finishedAt: now } });
      return { reconciled: result.stats ? result.stats.updated : 0 };
    },

    // ---- collector lease & status ------------------------------------------
    async releaseLease({ id, ownerId }) {
      await col(COLLECTIONS.config).where({ _id: id, ownerId }).update({ data: { expiresAt: '1970-01-01T00:00:00.000Z' } });
    },
    async getCollectorStatus() {
      return readOne(col(COLLECTIONS.config).where({ _id: 'collector_status' }));
    },
    async saveHealth(records) {
      for (let i = 0; i < records.length; i += CHUNK) {
        await Promise.all(records.slice(i, i + CHUNK).map(record => {
          const { _id, ...data } = record;
          return col(COLLECTIONS.health).doc(_id).set({ data });
        }));
      }
    },

    // ---- stats ----------------------------------------------------------
    async count(collection, where) {
      const result = await col(collection).where(where || {}).count();
      return result.total;
    },
    ...atomicMethods(run),
  };
}

module.exports = { createCloudbaseRepo, isTransactionConflict };
