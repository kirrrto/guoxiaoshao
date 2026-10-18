import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const NOW = Date.parse('2026-10-18T02:45:00Z');
const iso = age => new Date(NOW - age).toISOString();
const boot = { identity: { userKey: 'consumer:paid-follow' }, membership: { active: true },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'RESTOCK', soldout: 'SOLDOUT' } },
  subscriptions: { RESTOCK: { credits: 42 }, SOLDOUT: { credits: 41 } }, collector: { state: 'running' },
  settings: { notifyEnabled: true, dnd: { enabled: false } }, limits: { maxFollows: 5, maxStoresPerFollow: 4 } };
const store = (id, age, patch = {}) => ({ storeNumber: id, status: 'available', observedAt: iso(age), ...patch });
function present(stores, patch = {}) {
  const rt = runtime(); const page = rt.instance('pages/follow/index.js');
  page.setData({ follows: [{ followId: 'f1', status: 'active', partNumber: 'SKU-A', productTitle: 'Phone', stores, ...patch }], followsLoaded: true });
  page.applyBoot(boot);
  return { rt, page, row: page.data.follows[0] };
}

test('paid users with plenty of authorization still see their own four-minute stock delay', t => {
  t.mock.method(Date, 'now', () => NOW);
  const { page, row } = present([store('R001', 240000), store('R002', 250000)]);
  assert.equal(page.data.readiness.ready, true, 'authorization readiness remains independent of stock freshness');
  assert.equal(page.data.stockOverview.label, '库存更新有延迟');
  assert.match(page.data.stockOverview.detail, /2 项/);
  assert.equal(row.observationLabel, '上次 2 家可取货');
  assert.equal(row.observationAge, '4 分钟前检查');
  assert.equal(row.hasAvailable, false);
  assert.match(row.stockDetail, /当前库存待确认/);
  assert.equal(row.stores[0].compactStatus, '上次有货');
  assert.equal(row.stores[0].compactNote, '', 'the same stale warning need not repeat for every store');
});

test('partial current availability is timed from its matching store and keeps the stale remainder visible', t => {
  t.mock.method(Date, 'now', () => NOW);
  const { row } = present([store('R001', 15000), store('R002', 240000)]);
  assert.equal(row.observationLabel, '1 家可取货');
  assert.equal(row.observationAge, '15 秒前检查');
  assert.equal(row.pendingStoreCount, 1);
  assert.equal(row.observationIncomplete, true);
  assert.equal(row.hasAvailable, true);
});

test('a failed recent check cannot make the last valid in-stock result look recent', t => {
  t.mock.method(Date, 'now', () => NOW);
  const { row } = present([store('R001', 15000, { status: 'unknown', lastKnownStatus: 'available', knownAt: iso(300000) })]);
  assert.equal(row.observationAge, '5 分钟前检查');
  assert.match(row.stores[0].checkText, /^15 秒前检查/);
  assert.match(row.stores[0].lastResultTimeText, /10:40/);
  assert.equal(row.hasAvailable, false);
  assert.equal(present([store('R001', 15000, { status: 'unknown', lastKnownStatus: 'available' })]).row.observationAge, '', 'legacy records without a known timestamp must not invent one');
});

test('no-sample, paused and restricted targets never inflate the active delay summary', t => {
  t.mock.method(Date, 'now', () => NOW);
  const missing = present([store('R001', 0, { status: null, observedAt: null })]);
  assert.equal(missing.row.observationLabel, '等待首次检查');
  assert.equal(missing.row.observationAge, '');
  assert.equal(present([store('R001', 240000)], { status: 'paused' }).page.data.stockOverview, null);
  const restricted = present([store('R001', 240000)], { latestRestricted: true });
  assert.equal(restricted.row.hasAvailable, false);
  assert.equal(restricted.row.observationLabel, '库存暂不可见');
  assert.equal(restricted.page.data.stockOverview, null);
});
