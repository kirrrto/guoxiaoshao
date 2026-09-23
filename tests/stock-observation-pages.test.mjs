import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const baseTime = Date.parse('2026-09-15T10:35:06.000Z');
const at = offset => new Date(baseTime + offset).toISOString();
const flush = () => new Promise(resolve => setImmediate(resolve));
const follow = (stores, extra = {}) => ({ followId: 'stock-view-follow', partNumber: 'SKU-A', productTitle: '验收配置', status: 'active', stores, ...extra });
const observation = (extra = {}) => ({ storeNumber: 'R001', storeName: '天环广场', city: '广州', status: 'unavailable', observedAt: at(0), statusSince: at(0), ...extra });

async function querySummary(stores, extra = {}) {
  const rt = runtime(async action => {
    assert.equal(action, 'follow.list');
    return { follows: [follow(stores, extra)] };
  });
  const page = rt.instance('pages/query/index.js');
  page.data.boot = { member: true, followCount: 1 }; page.visible = true;
  page.startFollowPolling(); await flush();
  return { page, rt };
}

async function historyLatest(latest, extra = {}, handler) {
  const rt = runtime(async (action, payload) => {
    if (action !== 'history.list') return handler ? handler(action, payload) : {};
    return { ok: true, product: { partNumber: 'SKU-A', title: '验收配置' }, dayKey: '2026-09-15', balance: 0,
      summary: { available: 0, restocks: 0, recoveries: 0, ended: 0 }, events: [], latest,
      pagination: { total: 0, hasMore: false, nextCursor: null }, ...extra };
  });
  const page = rt.instance('pages/history/index.js');
  page.catalog = { storeByNumber: {} }; Object.assign(page.data, { ready: true, boot: { member: true },
    selection: { partNumber: 'SKU-A', storeNumbers: ['R001'] } });
  await page.onQuery();
  assert.ok(page.data.result, 'history query must complete');
  return { page, rt };
}

test('query monitored summary marks the 2–5 minute sample as historical, without changing its timestamp', async t => {
  t.mock.method(Date, 'now', () => baseTime + 180000);
  const { page } = await querySummary([observation()]);
  const item = page.data.followTargets[0];
  assert.equal(item.statusLabel, '待更新'); assert.notEqual(item.statusCls, 'bad');
  assert.equal(item.observationState, 'stale'); assert.match(item.lastKnownText, /上次有效结果：暂无供应/);
  assert.equal(item.observedText, '2026-09-15 18:35:06'); assert.equal(item.sinceText, null);
  page.onHide();
});

test('query summary explains missing and unknown samples, and does not reveal restricted inventory', async t => {
  t.mock.method(Date, 'now', () => baseTime + 1000);
  const { page } = await querySummary([
    observation({ storeNumber: 'R001', status: null, observedAt: null, statusSince: null }),
    observation({ storeNumber: 'R002', status: 'unknown', isStale: true, lastKnownStatus: 'available', unknownSince: at(0) }),
  ]);
  const [missing, unknown] = page.data.followTargets;
  assert.equal(missing.statusLabel, '等待首次观测'); assert.equal(missing.stale, false); assert.doesNotMatch(missing.freshnessText, /过期/);
  assert.equal(unknown.statusLabel, '状态待确认'); assert.match(unknown.lastKnownText, /上次有效结果：可取货/);
  assert.match(unknown.freshnessText, /未取得有效库存/); page.onHide();
  const restricted = await querySummary([observation({ status: 'available' })], { latestRestricted: true });
  const hidden = restricted.page.data.followTargets[0];
  assert.equal(hidden.statusLabel, '会员权益受限'); assert.equal(hidden.lastKnownText, null);
  assert.doesNotMatch(hidden.observedText, /18:35:06/); assert.equal(hidden.sinceText, null); restricted.page.onHide();
});

test('query summary ages the retained sample before a failed refresh and preserves the original observation time', async t => {
  let now = baseTime, fail = false;
  t.mock.method(Date, 'now', () => now);
  const rt = runtime(async () => { if (fail) throw Error('offline'); return { follows: [follow([observation()])] }; });
  const page = rt.instance('pages/query/index.js');
  page.data.boot = { member: true, followCount: 1 }; page.visible = true; page.startFollowPolling(); await flush();
  assert.equal(page.data.followTargets[0].statusLabel, '暂无供应');
  now += 180000; fail = true; await rt.nextTimer();
  assert.equal(page.data.followRefreshError, true); assert.equal(page.data.followTargets[0].statusLabel, '待更新');
  assert.equal(page.data.followTargets[0].observedText, '2026-09-15 18:35:06'); page.onHide();
});

test('history latest uses the same stale, missing and unknown semantics as monitored summaries', async t => {
  t.mock.method(Date, 'now', () => baseTime + 180000);
  const { page } = await historyLatest([
    observation(),
    observation({ storeNumber: 'R002', status: null, observedAt: null, statusSince: null }),
    observation({ storeNumber: 'R003', observedAt: at(180000), status: 'unknown', unknownSince: at(180000), lastKnownStatus: 'available' }),
  ]);
  const [stale, missing, unknown] = page.data.result.latest;
  assert.equal(stale.statusLabel, '待更新'); assert.match(stale.lastKnownText, /暂无供应/); assert.equal(stale.sinceText, null);
  assert.equal(missing.statusLabel, '等待首次观测'); assert.equal(missing.stale, false);
  assert.equal(unknown.statusLabel, '状态待确认'); assert.match(unknown.lastKnownText, /可取货/); assert.equal(unknown.sinceText, null);
});

test('query return-to-page ages the snapshot before a pending account request completes', async t => {
  let now = baseTime, rejectAccount;
  t.mock.method(Date, 'now', () => now);
  const rt = runtime(async action => {
    if (action === 'user.bootstrap') return new Promise((resolve, reject) => { rejectAccount = reject; });
    return { follows: [follow([observation({ status: 'available' })])] };
  });
  const page = rt.instance('pages/query/index.js');
  page.data.ready = true; page.data.boot = { member: true, followCount: 1 }; page.visible = true;
  page.startFollowPolling(); await flush(); page.onHide();
  assert.equal(page.data.followTargets[0].statusLabel, '可取货');
  now += 180000; const showing = page.onShow();
  assert.equal(page.data.followTargets[0].statusLabel, '待更新', 'age is recalculated before the account request settles');
  rejectAccount(Error('offline')); await showing; await flush(); page.onHide();
  assert.equal(page.data.followTargets[0].observedText, '2026-09-15 18:35:06');
});

test('history latest omits zero duration and restricted historical values', async t => {
  t.mock.method(Date, 'now', () => baseTime + 1000);
  const fresh = await historyLatest([observation(), observation({ storeNumber: 'R002', statusSince: at(-10000) })]);
  assert.equal(fresh.page.data.result.latest[0].sinceText, null);
  assert.match(fresh.page.data.result.latest[0].observationNote, /本次状态刚记录/);
  assert.equal(fresh.page.data.result.latest[1].sinceText, '10 秒');
  const restricted = await historyLatest([observation({ status: 'available', statusSince: at(-10000) })], { latestRestricted: true });
  const hidden = restricted.page.data.result.latest[0];
  assert.equal(hidden.statusLabel, '会员权益受限'); assert.equal(hidden.lastKnownText, null); assert.equal(hidden.sinceText, null);
  assert.doesNotMatch(hidden.observedText, /18:35:06/);
});

test('history return-to-page re-evaluates an old snapshot even when account refresh is offline', async t => {
  let now = baseTime;
  t.mock.method(Date, 'now', () => now);
  const { page, rt } = await historyLatest([observation({ status: 'available' })], {}, async () => { throw Error('offline'); });
  assert.equal(page.data.result.latest[0].statusLabel, '可取货');
  now += 180000; await page.onShow();
  const item = page.data.result.latest[0];
  assert.equal(item.statusLabel, '待更新'); assert.match(item.lastKnownText, /可取货/);
  assert.equal(item.observedAt, at(0)); assert.equal(rt.calls.filter(c => c.action === 'history.list').length, 1, 'showing an old page must not run a charged history query');
});
