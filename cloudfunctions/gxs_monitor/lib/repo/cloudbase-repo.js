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
const { dayKey: beijingDayKey, startOfDay, addDays } = require('../time');
const { observationDayId } = require('../engine/observation-day');

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
    async getObservationCoverage({ partNumber, storeNumbers = [], dayKey }) {
      // Missing documents mean no verifiable daily summary, never zero historical samples.
      const rows = storeNumbers.length
        ? await readIds(COLLECTIONS.observationDays, storeNumbers.map(store => observationDayId(store, partNumber, dayKey)))
        : await readAll(col(COLLECTIONS.observationDays).where({ partNumber, dayKey }).orderBy('storeNumber', 'asc'));
      return rows.sort((a, b) => a.storeNumber.localeCompare(b.storeNumber));
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
    async getEventHistory({ partNumber, storeNumbers, dayKey, cursor, limit = 100, snapshotAt, includeCounts = true }) {
      const base = { partNumber, dayKey, detectedAt: _.lte(snapshotAt) };
      if (storeNumbers.length) base.storeNumber = _.in(storeNumbers);
      const where = cursor ? _.and([base, _.or([{ detectedAt: _.lt(cursor.detectedAt) }, { detectedAt: cursor.detectedAt, _id: _.lt(cursor.id) }])]) : base;
      const read = readAll(col(COLLECTIONS.events).where(where).orderBy('detectedAt', 'desc').orderBy('_id', 'desc'), limit + 1);
      // Later pages reuse the first page's frozen total and summary; skip the 6–7 count queries.
      if (!includeCounts) {
        const rows = await read;
        return { events: rows.slice(0, limit), hasMore: rows.length > limit, total: null, summary: null };
      }
      const hourStart = new Date(Date.parse(snapshotAt) - 3600000).toISOString();
      // Today's rolling hour may cross Beijing midnight. Count both date
      // partitions while preserving SKU/store filters and the snapshot cutoff.
      // Older-day queries must not expose today's restricted product activity.
      const hourDays = dayKey === beijingDayKey(snapshotAt) ? [...new Set([beijingDayKey(hourStart), dayKey])] : [];
      const [rows, total, ...counts] = await Promise.all([
        read,
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
    async listReconcileOrders(options = {}) {
      const { limit = 10, nowIso = new Date().toISOString() } = typeof options === 'number' ? { limit: options } : options;
      const cap = Number.isInteger(limit) ? Math.max(1, Math.min(25, limit)) : 10;
      const cutoff = new Date(Date.parse(nowIso) - 30 * 86400000).toISOString();
      const where = _.and([{ provider: 'wechat_virtual_payment', status: _.in(['created', 'paid', 'fulfilled', 'partially_refunded']) },
        _.or([{ status: _.in(['created', 'paid']) }, { providerAcknowledgedAt: _.eq(null) }, { providerAcknowledgedAt: _.exists(false) }, { fulfilledAt: _.gte(cutoff) }])]);
      // Sort and limit in the database: never load all pending / historical
      // orders just to select a small compensation batch in process memory.
      return readAll(col(COLLECTIONS.orders).where(where).orderBy('lastReconciledAt', 'asc').orderBy('_id', 'asc'), cap);
    },
    async saveOrder(order) {
      const { _id, ...data } = order;
      await col(COLLECTIONS.orders).doc(_id).set({ data });
    },
    async listOrders(userKey, limit) {
      return readAll(col(COLLECTIONS.orders).where({ userKey }).orderBy('createdAt', 'desc'), limit || 20);
    },
    /** Operator insights: newest documents with `field` >= `since` (events by dayKey, notifications by createdAt). */
    async listSince(collection, field, since, limit) {
      return readAll(col(collection).where({ [field]: _.gte(since) }).orderBy(field, 'desc'), limit);
    },
    // Insertion and per-user view sequence are attached via atomicMethods.
    async getNotification(id) {
      return readOne(col(COLLECTIONS.notifications).where({ _id: id }));
    },
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

    // ---- retention (engine/retention.js) ----------------------------------
    async getRetentionStatus() {
      return readOne(col(COLLECTIONS.config).where({ _id: 'retention_status' }));
    },
    async saveRetentionStatus(status) {
      const { _id, ...data } = status;
      await col(COLLECTIONS.config).doc('retention_status').set({ data });
    },
    /** Remove history data older than firstDay; each target is removed independently. */
    async purgeExpiredData({ firstDay, cutoffIso }) {
      // Budget documents are keyed by Beijing day. The 60 days before the window
      // cover any backlog by _id instead of scanning gxs_config with a pattern.
      const budgetIds = Array.from({ length: 60 }, (_, i) => `collector_budget_${beijingDayKey(addDays(startOfDay(firstDay), -(i + 1)))}`);
      const byIds = (collection, ids) => Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => col(collection).where({ _id: _.in(ids.slice(i * CHUNK, (i + 1) * CHUNK)) }));
      const targets = {
        events: [col(COLLECTIONS.events).where({ dayKey: _.lt(firstDay) })],
        // A pending query may still owe its refund on the user's next bootstrap.
        queries: [col(COLLECTIONS.queries).where({ createdAt: _.lt(cutoffIso), status: _.neq('pending') })],
        notifications: [col(COLLECTIONS.notifications).where({ createdAt: _.lt(cutoffIso), status: _.nin(['pending', 'sending']) })],
        targetHealth: [col(COLLECTIONS.health).where({ recordedAt: _.lt(cutoffIso) })],
        subscriptionGrants: [col(COLLECTIONS.config).where({ kind: 'subscription_grant', createdAt: _.lt(cutoffIso) })],
        queryGuards: [col(COLLECTIONS.config).where({ kind: 'query_guard', updatedAt: _.lt(cutoffIso) })],
        budgets: byIds(COLLECTIONS.config, budgetIds),
      };
      const removed = {}, errors = {};
      for (const [name, queries] of Object.entries(targets)) {
        try {
          removed[name] = 0;
          for (const query of queries) {
            const result = await query.remove();
            removed[name] += result && result.stats ? result.stats.removed || 0 : 0;
          }
        } catch (error) { errors[name] = String(error && (error.errMsg || error.message) || error); }
      }
      return { removed, errors };
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
