import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

async function present(overrides = {}) {
  const response = { ok: true, product: { title: '测试配置' }, dayKey: '2026-09-14', balance: 1,
    latest: [{ storeNumber: 'R577', status: 'unavailable', observedAt: '2026-09-16T10:00:00.000Z' }],
    events: [], summary: { available: 0, restocks: 0, recoveries: 0, ended: 0 }, pagination: { total: 0, hasMore: false }, ...overrides };
  const rt = runtime(async () => response), page = rt.instance('pages/history/index.js');
  Object.assign(page.data, { boot: { member: false }, catalog: { storeByNumber: { R577: { name: '天环广场' } } }, selection: { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] } });
  await page.onQuery();
  return page.data.result;
}
const coverage = stores => ({ tracking: 'daily_samples_v1', requestedStoreNumbers: ['R577', 'R639'], stores });
const sample = { storeNumber: 'R577', sampleCount: 3, knownCount: 3, unknownCount: 0, firstObservedAt: '2026-09-14T01:00:00Z', lastObservedAt: '2026-09-14T01:05:00Z' };

test('empty history never implies a recorded zero even with a current known latest observation', async () => {
  const result = await present({ refunded: 1 });
  assert.equal(result.hasEventRecords, false);
  assert.equal(result.coverageTitle, '暂无该日期的历史数据');
  assert.match(result.coverageNote, /无法判断当天/);
  assert.match(result.billingText, /已退还 1 次/);
  assert.equal(result.coverageStores.length, 0);
});

test('sampled unchanged states and failed samples have distinct copy without implying full-day coverage', async () => {
  const valid = await present({ observationCoverage: coverage([sample]) });
  assert.equal(valid.coverageTitle, '已留存观测，暂无变化事件');
  assert.equal(valid.hasEventRecords, false);
  assert.match(valid.coverageSummary, /所选 2 家门店中，1 家/);
  assert.equal(valid.coverageStores[0].storeName, '天环广场');
  assert.equal(valid.coverageStores[0].rangeText, '09:00:00 — 09:05:00');
  const unknown = await present({ observationCoverage: coverage([{ ...sample, knownCount: 0, unknownCount: 3 }]) });
  assert.equal(unknown.coverageTitle, '当天观测未获得有效结果');
  assert.match(unknown.coverageNote, /不能据此判断/);
});

test('legacy events remain valid evidence without fabricating daily sample coverage', async () => {
  const result = await present({ events: [{ id: 'event-1', type: 'status_changed', detectedAt: '2026-09-14T01:00:00Z', storeNumber: 'R577' }], pagination: { total: 1, hasMore: false } });
  assert.equal(result.hasEventRecords, true);
  assert.equal(result.coverageTitle, '已记录 1 条变化事件');
  assert.match(result.coverageSummary, /缺少当日采样摘要/);
  assert.equal(result.billingText, '');
});

test('member empty result describes no charge only when server confirms the billing outcome', async () => {
  const result = await present({ refunded: 0, billing: { reason: 'empty_history_no_charge' } });
  assert.equal(result.billingText, '本次未查到历史事件，未扣次数。');
  assert.equal((await present()).billingText, '', 'legacy cached results must not claim a new refund');
});
