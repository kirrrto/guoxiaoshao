import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo.js');
const { dayKey } = require('../cloudfunctions/gxs_api/lib/time.js');
const partNumber = 'MXXX1CH/A';
const cutoff = '2026-09-15T16:20:00.000Z'; // Beijing 00:20 on September 16.
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const event = (id, detectedAt, extra = {}) => ({ _id: id, partNumber, storeNumber: 'R577', type: 'restock_confirmed', detectedAt, dayKey: dayKey(detectedAt), ...extra });

// Executes the production adapter's where/count calls on a small deterministic
// dataset. It catches a wrong day partition or missing filter independently of
// the in-memory service fixture implementation.
function eventDatabase(rows) {
  const compare = op => value => ({ op, value });
  const command = { lte: compare('lte'), gte: compare('gte'), lt: compare('lt'), in: compare('in'), and: value => ({ op: 'and', value }), or: value => ({ op: 'or', value }) };
  function matches(row, condition) {
    if (condition.op === 'and') return condition.value.every(c => matches(row, c));
    if (condition.op === 'or') return condition.value.some(c => matches(row, c));
    return Object.entries(condition).every(([key, expected]) => {
      if (!expected || typeof expected !== 'object') return row[key] === expected;
      if (expected.op === 'lte') return row[key] <= expected.value;
      if (expected.op === 'gte') return row[key] >= expected.value;
      if (expected.op === 'lt') return row[key] < expected.value;
      if (expected.op === 'in') return expected.value.includes(row[key]);
      throw Error(`Unknown comparison ${expected.op}`);
    });
  }
  const db = { command, collection: () => ({ where: condition => {
    const selected = rows.filter(row => matches(row, condition));
    const ordering = []; let skip = 0, limit = selected.length;
    const query = { orderBy(key, direction) { ordering.push([key, direction]); return query; }, skip(value) { skip = value; return query; }, limit(value) { limit = value; return query; },
      async count() { return { total: selected.length }; },
      async get() { return { data: selected.slice().sort((a, b) => { for (const [key, direction] of ordering) if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1); return 0; }).slice(skip, skip + limit) }; } };
    return query;
  } }) };
  return db;
}

test('production history adapter counts the full rolling hour across Beijing midnight, with exact bounds and scope', async () => {
  const rows = [
    event('outside-before', '2026-09-15T15:19:59.999Z'),
    event('lower-bound', '2026-09-15T15:20:00.000Z'),
    event('previous-day', '2026-09-15T15:50:00.000Z'),
    event('today', '2026-09-15T16:10:00.000Z'),
    event('upper-bound', cutoff),
    event('outside-after', '2026-09-15T16:20:00.001Z'),
    event('other-store', '2026-09-15T16:10:00.000Z', { storeNumber: 'R639' }),
    event('other-product', '2026-09-15T16:10:00.000Z', { partNumber: 'MYYY2CH/A' }),
    event('other-type', '2026-09-15T16:10:00.000Z', { type: 'first_seen_available' }),
  ];
  const repo = createCloudbaseRepo(eventDatabase(rows));
  const request = { partNumber, storeNumbers: ['R577'], dayKey: '2026-09-16', snapshotAt: cutoff, limit: 1 };
  const result = await repo.getEventHistory(request);
  assert.equal(result.events.length, 1);
  assert.equal(result.total, 3, 'daily event total must stay on the selected day');
  assert.equal(result.summary.restocks, 2);
  assert.equal(result.summary.available, 1);
  assert.equal(result.summary.lastHourRestocks, 4, 'hour total includes both day partitions, not only the first event page');
  assert.equal(result.hasMore, true);
  const otherPage = await repo.getEventHistory({ ...request, cursor: { detectedAt: result.events[0].detectedAt, id: result.events[0]._id } });
  assert.equal(otherPage.summary.lastHourRestocks, 4);
  const allStores = await repo.getEventHistory({ ...request, storeNumbers: [] });
  assert.equal(allStores.summary.lastHourRestocks, 5);
  const oldDay = await repo.getEventHistory({ ...request, dayKey: '2026-09-15' });
  assert.equal(oldDay.summary.lastHourRestocks, 0, 'an older-day response must not include today activity');
});

test('past-day new-product history does not reveal restricted current-day activity through the rolling counter', async () => {
  const f = createFixture({ start: cutoff, config: { quota: { historyCost: 0 }, newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-11T00:00:00.000Z' }] } });
  const protectedPart = 'MJYH4CH/A';
  await f.repo.saveEvents([event('previous', '2026-09-15T15:50:00.000Z', { partNumber: protectedPart }), event('today', '2026-09-15T16:10:00.000Z', { partNumber: protectedPart })]);
  const request = { historyQueryId: 'midnight-access-01', partNumber: protectedPart, storeNumbers: ['R577'], dayKey: '2026-09-15' };
  const oldDay = ok(await f.call('history.list', request));
  assert.equal(oldDay.ok, true);
  assert.equal(oldDay.summary.restocks, 1);
  assert.equal(oldDay.summary.lastHourRestocks, 0);
  assert.equal(oldDay.latestRestricted, true);
  assert.equal(ok(await f.call('history.list', { ...request, historyQueryId: 'midnight-access-02', dayKey: '2026-09-16' })).reason, 'new_product_history_restricted');
});

test('history pages retain the original cross-midnight counter after time advances, without charging another credit', async () => {
  const f = createFixture({ start: cutoff });
  ok(await f.call('quota.signin'));
  await f.repo.saveEvents([event('previous', '2026-09-15T15:50:00.000Z'), event('today-a', '2026-09-15T16:05:00.000Z'), event('today-b', '2026-09-15T16:10:00.000Z')]);
  const request = { historyQueryId: 'midnight-page-001', partNumber, storeNumbers: ['R577'], dayKey: '2026-09-16', limit: 1 };
  const first = ok(await f.call('history.list', request));
  assert.equal(first.summary.lastHourRestocks, 3);
  assert.equal(first.balance, 0);
  f.advance(45 * 60000);
  await f.repo.saveEvents([event('new-after-query', '2026-09-15T16:40:00.000Z')]);
  const next = ok(await f.call('history.list', { ...request, cursor: first.pagination.nextCursor }));
  assert.equal(next.summary.lastHourRestocks, 3);
  assert.equal(next.pagination.snapshotAt, cutoff);
  assert.equal(next.pagination.total, 2);
  assert.equal(next.balance, 0);
});

test('real observation coverage gaps survive history serialization and become qualified frontend time spans', async () => {
  const f = createFixture({ config: { quota: { historyCost: 0 } } });
  const observe = (observedAt, status) => f.repo.recordObservation({ observation: { partNumber, storeNumber: 'R577', observedAt, status, source: 'auto' } });
  await observe('2026-09-15T00:00:00.000Z', 'available');
  await observe('2026-09-15T00:01:00.000Z', 'unknown');
  await observe('2026-09-15T00:30:00.000Z', 'unavailable');
  await f.repo.saveEvents([
    event('continuous', '2026-09-15T00:45:00.000Z', { type: 'became_unavailable', availableDurationMs: 120000, coverageGap: false }),
    event('legacy', '2026-09-15T00:50:00.000Z', { type: 'became_unavailable', availableDurationMs: 180000 }),
  ]);
  const response = ok(await f.call('history.list', { historyQueryId: 'gap-history-0001', partNumber, storeNumbers: ['R577'] }));
  const ended = response.events.filter(e => e.type === 'became_unavailable');
  assert.deepEqual(ended.map(e => e.coverageGap), [null, false, true]);
  const rt = runtime(async () => response), page = rt.instance('pages/history/index.js');
  page.catalog = { storeByNumber: {} }; Object.assign(page.data, { boot: { member: true }, selection: { partNumber, storeNumbers: ['R577'] } });
  await page.onQuery();
  const views = page.data.result.events.filter(e => e.type === 'became_unavailable');
  assert.match(views[0].detailText, /连续性未确认/);
  assert.match(views[1].detailText, /按检测时间记录/);
  assert.match(views[2].detailText, /期间检测中断，不能确认连续可取货/);
  for (const view of views) assert.doesNotMatch(view.detailText, /可取货持续/);
});

test('frontend names the fixed rolling-hour cutoff and explicitly identifies the previous day at midnight', async t => {
  t.mock.method(Date, 'now', () => Date.parse(cutoff));
  const rt = runtime(async () => ({ ok: true, product: { partNumber, title: '真实数据测试配置' }, dayKey: '2026-09-16', balance: 0, latest: [], events: [], summary: { available: 0, restocks: 2, recoveries: 0, ended: 0, lastHourRestocks: 4 }, pagination: { snapshotAt: cutoff, total: 2, hasMore: true } }));
  const page = rt.instance('pages/history/index.js');
  page.catalog = { storeByNumber: {} }; Object.assign(page.data, { boot: { member: true }, selection: { partNumber, storeNumbers: ['R577'] } });
  await page.onQuery();
  assert.equal(page.data.result.lastHour, 4);
  assert.equal(page.data.result.lastHourComplete, true);
  assert.match(page.data.result.lastHourWindowText, /截至 00:20:00 的近一小时（含前一日）/);
});
