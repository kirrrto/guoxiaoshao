import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const now = Date.parse('2026-09-15T10:38:00.000Z');
const fmt = runtime().load('utils/format.js');
const sample = { status: 'unavailable', observedAt: new Date(now - 180000).toISOString(), statusSince: new Date(now - 180000).toISOString() };

test('a two-to-five-minute stock sample cannot have both a current stock badge and an expired note', () => {
  const view = fmt.stockObservation({ ...sample, isStale: false }, now);
  assert.equal(view.statusLabel, '待更新');
  assert.equal(view.statusCls, 'unknown');
  assert.equal(view.stale, true);
  assert.match(view.lastKnownText, /上次有效结果：暂无供应/);
  assert.equal(view.sinceText, null);
  assert.equal(sample.observedAt, '2026-09-15T10:35:00.000Z');
});

test('a newly recorded or changed status has no misleading zero-second continuous duration', () => {
  const fresh = { status: 'available', observedAt: new Date(now).toISOString(), statusSince: new Date(now).toISOString() };
  const first = fmt.stockObservation(fresh, now);
  assert.equal(first.statusLabel, '可取货'); assert.equal(first.observationState, 'fresh');
  assert.equal(first.sinceText, null); assert.match(first.observationNote, /本次状态刚记录/);
  assert.doesNotMatch(first.observationNote, /首次观测/);
  assert.equal(fmt.stockObservation({ ...fresh, observedAt: new Date(now + 2000).toISOString() }, now + 2000).sinceText, '2 秒');
});

test('a fresh timestamp never overrides a server unknown or stale result', () => {
  for (const flags of [{ isStale: true }, { unknownSince: new Date(now).toISOString() }, { status: 'unknown' }]) {
    const view = fmt.stockObservation({ status: 'unavailable', lastKnownStatus: 'available', observedAt: new Date(now).toISOString(), ...flags }, now);
    assert.equal(view.statusLabel, '状态待确认'); assert.equal(view.observationState, 'unknown');
    assert.match(view.lastKnownText, /上次有效结果：可取货/);
    assert.match(view.freshnessText, /未取得有效库存/); assert.equal(view.sinceText, null);
  }
});

test('missing and restricted observations have distinct explanations without leaking historical stock', () => {
  const missing = fmt.stockObservation({ observedAt: null }, now);
  assert.equal(missing.statusLabel, '等待首次观测'); assert.equal(missing.stale, false);
  assert.doesNotMatch(missing.freshnessText, /过期/);
  const restricted = fmt.stockObservation({ ...sample, lastKnownStatus: 'available' }, now, { restricted: true });
  assert.equal(restricted.statusLabel, '会员权益受限'); assert.equal(restricted.observedText, '未展示实时库存');
  assert.equal(restricted.lastKnownText, null); assert.equal(restricted.sinceText, null);
});

test('follow polling expires the retained badge even when refreshing the account fails', async () => {
  const rt = runtime(async () => { throw Error('offline'); });
  const page = rt.instance('pages/follow/index.js');
  const observedAt = new Date(Date.now() - 180000).toISOString();
  Object.assign(page.data, { ready: true, boot: { member: true }, collector: { state: 'running' },
    follows: [{ followId: 'f1', status: 'active', stores: [{ ...sample, observedAt, statusLabel: '暂无供应', statusCls: 'bad', stale: false }] }] });
  page.visible = true; page.startPolling(); await rt.nextTimer();
  const view = page.data.follows[0].stores[0];
  assert.equal(view.statusLabel, '待更新'); assert.equal(view.observedAt, observedAt);
  assert.match(page.data.refreshError, /刷新失败/); page.onHide(); assert.equal(rt.timers.size, 0);
});

test('acceptance list refresh reads existing samples without inventing newer stock', async () => {
  let acceptance;
  const rt = runtime((action, payload) => acceptance.handle(action, payload));
  rt.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'develop' } });
  acceptance = rt.load('../tests/helpers/acceptance-sandbox.js'); acceptance.configure({ mode: 'member', inventory: 'unavailable' });
  const catalog = rt.load('config/catalog-seed.js'), product = catalog.products.find(p => p.supported), store = catalog.stores[0];
  await acceptance.handle('follow.upsert', { followId: 'freshness-001', partNumber: product.partNumber, storeNumbers: [store.storeNumber] });
  await acceptance.handle('query.pickup', { queryId: 'freshness-query-001', partNumber: product.partNumber, storeNumbers: [store.storeNumber] });
  const state = rt.storage.get('gxs_acceptance_v1'), record = state.latest[`${product.partNumber}|${store.storeNumber}`];
  const observedAt = new Date(Date.now() - 180000).toISOString();
  record.observedAt = observedAt; record.knownAt = observedAt; record.statusSince = observedAt;
  const page = rt.instance('pages/follow/index.js'); page.data.boot = { member: true }; page.data.collector = { state: 'running' };
  await page.loadFollows({ force: true }); await page.loadFollows({ force: true });
  const view = page.data.follows[0].stores[0];
  assert.equal(view.statusLabel, '待更新'); assert.match(view.lastKnownText, /暂无供应/);
  assert.equal(view.observedAt, observedAt);
  assert.equal(rt.storage.get('gxs_acceptance_v1').latest[`${product.partNumber}|${store.storeNumber}`].observedAt, observedAt);
});
