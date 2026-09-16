import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const apiOf = fixture => async (action, payload) => {
  const response = await fixture.call(action, payload);
  if (!response.ok) throw Object.assign(Error(response.error.message), { code: response.error.code });
  return response.data;
};

test('free landing browse rewards zero-balance users and members even with no history, without a query debit', async () => {
  for (const member of [false, true]) {
    const f = createFixture();
    ok(await f.call('user.bootstrap'));
    if (member) await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
    const first = ok(await f.call('history.browse'));
    assert.deepEqual(first.recentViews, []);
    assert.equal(first.task.granted, 1);
    assert.equal(first.task.quota.balance, 1);
    assert.deepEqual(first.task.quota.tasksDoneToday, ['view_history']);
    assert.equal((await f.repo.listQueries(userKeyOf(), 20)).length, 0);
    assert.deepEqual((await f.repo.listLedger(userKeyOf())).map(e => [e.type, e.delta]), [['task_reward', 1]]);
    assert.equal(ok(await f.call('history.browse')).task.granted, 0);
    assert.equal(ok(await f.call('quota.completeTask', { taskId: 'view_history' })).granted, 0);
  }
});

test('concurrent page visits share one Beijing-day reward and the next day may grant once again', async () => {
  const f = createFixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.call('history.browse')));
  assert.equal(results.reduce((n, value) => n + ok(value).task.granted, 0), 1);
  f.advance(86400000);
  assert.equal((await f.call('quota.completeTask', { taskId: 'view_history' })).error.code, 'task_not_completed');
  assert.equal(ok(await f.call('history.browse')).task.granted, 1);
  assert.equal(ok(await f.call('user.bootstrap')).quota.balance, 2);
  assert.equal((await f.repo.listLedger(userKeyOf())).length, 2);
});

test('history landing proves the server completion date when reading crosses midnight', async () => {
  const f = createFixture({ start: '2026-09-15T15:59:59.900Z' });
  const list = f.repo.listRecentHistoryViews;
  f.repo.listRecentHistoryViews = async (...args) => { const values = await list(...args); f.advance(200); return values; };
  const result = ok(await f.call('history.browse'));
  assert.equal(result.task.quota.dayKey, '2026-09-16');
  assert.equal((await f.repo.listLedger(userKeyOf()))[0].dayKey, '2026-09-16');
});

test('failed landing reads and failed evidence commits cannot reward; retry can finish once', async () => {
  for (const stage of ['read', 'commit']) {
    const f = createFixture();
    const list = f.repo.listRecentHistoryViews;
    if (stage === 'read') f.repo.listRecentHistoryViews = async () => { throw Error('database unavailable'); };
    else f.repo.transactionWriteHook = async (table, doc) => { if (table === C.users && doc.taskEvidence?.history_browse) throw Error('write failed'); };
    assert.equal((await f.call('history.browse')).ok, false);
    assert.equal((await f.repo.getUser(userKeyOf())).taskEvidence, undefined);
    assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
    assert.equal((await f.call('quota.completeTask', { taskId: 'view_history', visited: true, evidenceBrowseDay: '2026-09-15' })).error.code, 'task_not_completed');
    f.repo.listRecentHistoryViews = list; f.repo.transactionWriteHook = null;
    assert.equal(ok(await f.call('history.browse')).task.granted, 1);
  }
});

test('free landing exposes only the caller viewing conditions, never paid stock results or other accounts', async () => {
  const f = createFixture({ config: { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-14T00:00:00Z' }] } });
  const base = { kind: 'history', status: 'success', dayKey: '2026-09-14', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], createdAt: f.state.now.toISOString(), finishedAt: f.state.now.toISOString(), response: { ok: true, events: [{ secret: 'paid history' }], latest: [{ status: 'available' }] } };
  await f.repo.saveQuery({ ...base, _id: 'own', userKey: userKeyOf() });
  await f.repo.saveQuery({ ...base, _id: 'foreign', userKey: userKeyOf('other'), partNumber: 'MXXX1CH/A' });
  const result = ok(await f.call('history.browse', { userKey: userKeyOf('other'), partNumber: 'MJYH4CH/A', includeResults: true }));
  assert.equal(result.recentViews.length, 1);
  assert.deepEqual(Object.keys(result.recentViews[0]).sort(), ['dayKey', 'partNumber', 'storeNumbers', 'viewedAt']);
  assert.doesNotMatch(JSON.stringify(result), /paid history|available|MXXX1CH/);
  const denied = ok(await f.call('history.list', { historyQueryId: 'still-restricted-001', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] }));
  assert.equal(denied.reason, 'new_product_history_restricted');
});

test('disabled or capped browse rewards never fabricate a +1 entry and a balance cap can be retried later', async () => {
  const disabled = createFixture({ config: { tasks: [{ id: 'view_history', title: '浏览历史', reward: 0 }] } });
  assert.equal(ok(await disabled.call('history.browse')).task.reason, 'reward_disabled');
  assert.equal((await disabled.repo.listLedger(userKeyOf())).length, 0);
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { quota: { balance: 10 } });
  const capped = ok(await f.call('history.browse'));
  assert.equal(capped.task.reason, 'balance_cap_reached');
  assert.deepEqual(capped.task.quota.tasksDoneToday, []);
  assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
  await f.repo.updateUser(userKeyOf(), { quota: { balance: 9 } });
  assert.equal(ok(await f.call('history.browse')).task.granted, 1);
});

test('task entry loads free history, updates member Mine and refreshes its already open ledger on return', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
  const rt = runtime(apiOf(f));
  const mine = rt.instance('pages/mine/index.js');
  await mine.onLoad(); await mine.onToggleLedger();
  assert.equal(mine.data.ledger.length, 0);
  let route;
  rt.wx.switchTab = options => { route = options.url; };
  mine.onGoHistory(); assert.equal(route, '/pages/history/index'); mine.onHide();
  const history = rt.instance('pages/history/index.js');
  await history.onLoad(); await history.loadBrowse();
  assert.equal(history.data.browse.recentViews.length, 0);
  assert.match(history.data.taskMessage, /\+1/);
  assert.equal(history.data.boot.taskAvailable, false);
  await mine.onShow();
  assert.equal(mine.data.quota.balance, 1);
  assert.equal(mine.data.tasks[0].done, true);
  assert.equal(mine.data.ledger[0].deltaText, '+1');
  assert.equal(rt.calls.filter(c => c.action === 'history.list').length, 0, 'a task tab visit must never start a charged query');
});

test('a late reward updates Mine immediately and older bootstrap/ledger responses cannot undo it', async () => {
  const f = createFixture();
  const api = apiOf(f), oldBoot = deferred(), oldLedger = deferred();
  let blockBoot = false, blockLedger = false;
  const rt = runtime(async (action, payload) => {
    if (action === 'user.bootstrap' && blockBoot) { blockBoot = false; return oldBoot.promise; }
    if (action === 'quota.ledger' && blockLedger) { blockLedger = false; return oldLedger.promise; }
    return api(action, payload);
  });
  const mine = rt.instance('pages/mine/index.js'); await mine.onLoad();
  const before = copy(rt.app.globalData.bootstrap);
  blockBoot = true;
  const waitingBootstrap = rt.load('utils/store.js').getBootstrap({ force: true });
  blockLedger = true;
  const waitingLedger = mine.onToggleLedger();
  const history = rt.instance('pages/history/index.js'); history.applyBoot(before); history.catalog = { productByPart: {} };
  await history.loadBrowse();
  oldBoot.resolve(before); oldLedger.resolve({ entries: [] });
  await waitingLedger; const fresh = await waitingBootstrap;
  // The visible Mine listener starts a second ledger request after the reward.
  await mine.loadLedger();
  assert.equal(fresh.quota.balance, 1);
  assert.equal(mine.data.quota.balance, 1);
  assert.equal(mine.data.tasks[0].done, true);
  assert.equal(mine.data.ledger.length, 1);
  assert.equal(mine.data.ledger[0].deltaText, '+1');
});

test('failed history landing visibly offers retry and does not mark the task complete', async () => {
  const f = createFixture(); const list = f.repo.listRecentHistoryViews;
  f.repo.listRecentHistoryViews = async () => { throw Error('unavailable'); };
  const rt = runtime(apiOf(f)); const history = rt.instance('pages/history/index.js');
  await history.onLoad(); await history.loadBrowse();
  assert.match(history.data.browseError, /重试/);
  assert.equal(history.data.browse, null);
  assert.equal(history.data.boot.taskAvailable, true);
  assert.equal(history.data.boot.balance, 0);
  f.repo.listRecentHistoryViews = list;
  await history.onRetryBrowse();
  assert.equal(history.data.browseError, null);
  assert.equal(history.data.boot.taskAvailable, false);
  assert.equal(history.data.boot.balance, 1);
});

test('restock detail labels an observation gap without calling it unavailable duration', async () => {
  const rt = runtime(async () => ({ ok: true, dayKey: '2026-09-15', balance: 0, latest: [], summary: {}, events: [{ id: 'event', type: 'restock_confirmed', gapMs: 60000, detectedAt: '2026-09-15T00:00:00Z' }] }));
  const page = rt.instance('pages/history/index.js');
  page.data.boot = { taskAvailable: false }; page.data.selection = { partNumber: 'MXXX1CH/A', storeNumbers: [] };
  await page.onQuery();
  assert.equal(page.data.result.events[0].detailText, '距上次有效检测 1 分 0 秒');
});

test('delayed browse reward cannot restore credits after a newer explicit paid history query', async () => {
  const f = createFixture(), api = apiOf(f), late = deferred();
  // A paid lookup needs an actual saved event; empty histories are refunded.
  await f.repo.saveEvents([{ _id: 'paid-history-race-event', partNumber: 'MXXX1CH/A', storeNumber: 'R577', dayKey: '2026-09-14', detectedAt: '2026-09-14T01:00:00.000Z', type: 'restock_confirmed' }]);
  let browseResult;
  const rt = runtime(async (action, payload) => {
    const result = await api(action, payload);
    if (action === 'history.browse') { browseResult = result; return late.promise; }
    return result;
  });
  const boot = await rt.load('utils/store.js').getBootstrap();
  const history = rt.instance('pages/history/index.js'); history.applyBoot(boot); history.catalog = { productByPart: {}, storeByNumber: {} };
  const browsing = history.loadBrowse();
  while (!browseResult) await new Promise(resolve => setImmediate(resolve));
  assert.equal(browseResult.task.quota.balance, 1);
  history.data.selection = { partNumber: 'MXXX1CH/A', storeNumbers: [] };
  history.data.dayKey = '2026-09-14';
  await history.onQuery();
  await history.completeTask();
  assert.equal(history.data.boot.balance, 0);
  late.resolve(browseResult); await browsing;
  assert.equal(history.data.boot.balance, 0);
  assert.equal((await rt.load('utils/store.js').getBootstrap()).quota.balance, 0);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 0);
});

test('quota revisions reject out-of-order mutations even when timestamps are identical', async () => {
  const f = createFixture(), rt = runtime(apiOf(f)), store = rt.load('utils/store.js');
  await store.getBootstrap();
  const browse = ok(await f.call('history.browse'));
  const signin = ok(await f.call('quota.signin'));
  assert.equal(signin.quota.revision, browse.task.quota.revision + 1);
  assert.equal(store.publishQuota(signin.quota), true);
  assert.equal(store.publishQuota(browse.task.quota), false);
  assert.equal((await store.getBootstrap()).quota.balance, 2);
});

test('a capped browse has a newer revision even without a ledger entry', async () => {
  const f = createFixture(); ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { quota: { balance: 10 } });
  const rt = runtime(apiOf(f)), store = rt.load('utils/store.js');
  const before = await store.getBootstrap();
  const browse = ok(await f.call('history.browse'));
  assert.equal(browse.task.granted, 0);
  assert.ok(browse.task.quota.revision > before.quota.revision);
  assert.equal(store.publishQuota(browse.task.quota), true);
  assert.equal(store.publishQuota(before.quota), false);
  assert.deepEqual(copy((await store.getBootstrap()).quota.tasksViewedToday), ['view_history']);
});

test('Mine shows successful browsing separately from an unclaimed capped reward', async () => {
  for (const quota of [{ balance: 10, grantedToday: 0 }, { balance: 1, rewardDay: '2026-09-15', grantedToday: 2 }]) {
    const f = createFixture(); ok(await f.call('user.bootstrap'));
    await f.repo.updateUser(userKeyOf(), { quota });
    const rt = runtime(apiOf(f)); const mine = rt.instance('pages/mine/index.js'); await mine.onLoad();
    const history = rt.instance('pages/history/index.js'); history.applyBoot(await rt.load('utils/store.js').getBootstrap());
    await history.loadBrowse();
    assert.equal(mine.data.tasks[0].done, false);
    assert.match(mine.data.tasks[0].pendingLabel, /已浏览/);
    assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
  }
});

test('history hour totals name their original snapshot cutoff after the page remains open', async () => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const snapshotAt = `${today}T01:23:45.000Z`;
  const rt = runtime(async () => ({ ok: true, dayKey: today, balance: 0, latest: [], summary: { lastHourRestocks: 2 }, events: [], pagination: { snapshotAt, total: 0, hasMore: false } }));
  const history = rt.instance('pages/history/index.js'); history.data.boot = { taskAvailable: false }; history.data.selection = { partNumber: 'MXXX1CH/A', storeNumbers: [] };
  await history.onQuery(); history.refreshObservationSnapshot();
  assert.equal(history.data.result.lastHour, 2);
  assert.equal(history.data.result.lastHourWindowText, '截至 09:23:45 的近一小时');
});
