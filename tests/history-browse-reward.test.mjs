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

async function seedPendingBrowse(f) {
  ok(await f.call('user.bootstrap'));
  const completedAt = f.state.now.toISOString();
  const dayKey = new Date(f.state.now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  await f.repo.updateUser(userKeyOf(), { taskEvidence: { history_browse: { dayKey, completedAt } } });
}

test('new users and members can browse archived history without creating reward evidence or a debit', async () => {
  for (const member of [false, true]) {
    const f = createFixture();
    ok(await f.call('user.bootstrap'));
    if (member) await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
    for (const result of await Promise.all(Array.from({ length: 8 }, () => f.call('history.browse')))) {
      assert.deepEqual(ok(result).recentViews, []);
      assert.equal(ok(result).task, null);
    }
    const me = ok(await f.call('user.bootstrap'));
    assert.deepEqual([me.quota.balance, me.quota.tasksDoneToday, me.quota.tasksViewedToday, me.tasks], [0, [], [], []]);
    assert.equal((await f.repo.getUser(userKeyOf())).taskEvidence, undefined);
    assert.deepEqual(await f.repo.listQueries(userKeyOf(), 20), []);
    assert.deepEqual(await f.repo.listLedger(userKeyOf()), []);
    const attempted = ok(await f.call('quota.completeTask', { taskId: 'view_history', visited: true, evidenceBrowseDay: '2026-09-15' }));
    assert.deepEqual([attempted.granted, attempted.reason], [0, 'reward_disabled']);
  }
});

test('concurrent legacy claim and browse requests settle an existing reward only once', async () => {
  const f = createFixture();
  await seedPendingBrowse(f);
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2
    ? f.call('history.browse').then(r => ok(r).task)
    : f.call('quota.completeTask', { taskId: 'view_history' }).then(ok)));
  assert.equal(claims.reduce((n, claim) => n + (claim?.granted || 0), 0), 1);
  assert.deepEqual((await f.repo.listLedger(userKeyOf())).map(e => [e.type, e.delta]), [['task_reward', 1]]);
  assert.deepEqual(ok(await f.call('user.bootstrap')).tasks, []);
  assert.equal(ok(await f.call('quota.completeTask', { taskId: 'view_history' })).reason, 'already_completed');
  f.advance(86400000);
  assert.equal(ok(await f.call('history.browse')).task, null);
  assert.equal(ok(await f.call('quota.completeTask', { taskId: 'view_history' })).granted, 0);
  assert.equal(ok(await f.call('user.bootstrap')).quota.balance, 1);
});

test('a successful new archived history query records its receipt without establishing an old reward', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
  const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], dayKey: '2026-09-14' };
  await f.repo.saveEvents([{ _id: 'archived-history-event', partNumber: target.partNumber, storeNumber: 'R577', dayKey: target.dayKey,
    detectedAt: '2026-09-14T01:00:00.000Z', type: 'restock_confirmed' }]);
  const query = ok(await f.call('history.list', { ...target, historyQueryId: 'archive-history-request' }));
  assert.equal(query.ok, true);
  assert.equal((await f.repo.getUser(userKeyOf())).taskEvidence, undefined);
  assert.equal(ok(await f.call('history.browse')).task, null);
  assert.equal(ok(await f.call('quota.completeTask', { taskId: 'view_history' })).reason, 'reward_disabled');
  assert.deepEqual(await f.repo.listLedger(userKeyOf()), []);
});

test('a legacy entitlement from yesterday cannot be refreshed by crossing Beijing midnight while browsing', async () => {
  const f = createFixture({ start: '2026-09-15T15:59:59.900Z' });
  await seedPendingBrowse(f);
  const list = f.repo.listRecentHistoryViews;
  f.repo.listRecentHistoryViews = async (...args) => { const values = await list(...args); f.advance(200); return values; };
  const result = ok(await f.call('history.browse'));
  assert.equal(result.task, null);
  assert.equal((await f.repo.getUser(userKeyOf())).taskEvidence.history_browse.dayKey, '2026-09-15');
  assert.deepEqual(await f.repo.listLedger(userKeyOf()), []);
});

test('a failed read or reward commit keeps the old evidence usable for exactly one retry', async () => {
  for (const stage of ['read', 'commit']) {
    const f = createFixture();
    await seedPendingBrowse(f);
    const oldEvidence = (await f.repo.getUser(userKeyOf())).taskEvidence;
    const list = f.repo.listRecentHistoryViews;
    if (stage === 'read') f.repo.listRecentHistoryViews = async () => { throw Error('database unavailable'); };
    else f.repo.transactionWriteHook = async table => { if (table === C.ledger) throw Error('write failed'); };
    assert.equal((await f.call('history.browse')).ok, false);
    assert.deepEqual((await f.repo.getUser(userKeyOf())).taskEvidence, oldEvidence);
    assert.deepEqual(await f.repo.listLedger(userKeyOf()), []);
    f.repo.listRecentHistoryViews = list; f.repo.transactionWriteHook = null;
    assert.equal(ok(await f.call('history.browse')).task.granted, 1);
    assert.equal(ok(await f.call('quota.completeTask', { taskId: 'view_history' })).granted, 0);
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
  await seedPendingBrowse(disabled);
  assert.equal(ok(await disabled.call('quota.completeTask', { taskId: 'view_history' })).reason, 'reward_disabled');
  assert.equal((await disabled.repo.listLedger(userKeyOf())).length, 0);
  const f = createFixture();
  await seedPendingBrowse(f);
  await f.repo.updateUser(userKeyOf(), { quota: { balance: 10 } });
  const capped = ok(await f.call('history.browse'));
  assert.equal(capped.task.reason, 'balance_cap_reached');
  assert.deepEqual(capped.task.quota.tasksDoneToday, []);
  assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
  await f.repo.updateUser(userKeyOf(), { quota: { balance: 9 } });
  assert.equal(ok(await f.call('history.browse')).task.granted, 1);
});

test('new accounts have no history entry and opening a legacy link does not create a reward', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
  const rt = runtime(apiOf(f));
  const mine = rt.instance('pages/mine/index.js');
  await mine.onLoad(); await mine.onToggleLedger();
  assert.equal(mine.data.ledger.length, 0);
  let route;
  rt.wx.navigateTo = options => { route = options.url; };
  mine.onOpenPendingReward(); assert.equal(route, undefined); assert.equal(mine.data.tasks.length, 0); mine.onHide();
  const history = rt.instance('pages/history/index.js');
  await history.onLoad(); await history.loadBrowse();
  assert.equal(history.data.browse.recentViews.length, 0);
  assert.equal(history.data.taskMessage, null);
  assert.equal(history.data.boot.taskAvailable, false);
  await mine.onShow();
  assert.equal(mine.data.quota.balance, 0);
  assert.deepEqual(copy(mine.data.tasks), []);
  assert.deepEqual(copy(mine.data.ledger), []);
  assert.equal(rt.calls.filter(c => c.action === 'history.list').length, 0, 'a task tab visit must never start a charged query');
});

test('a late reward updates Mine immediately and older bootstrap/ledger responses cannot undo it', async () => {
  const f = createFixture();
  await seedPendingBrowse(f);
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
  assert.equal(mine.data.tasks.some(task => task.claimable), false);
  assert.equal(mine.data.ledger.length, 1);
  assert.equal(mine.data.ledger[0].deltaText, '+1');
});

test('failed history landing allows retry without minting evidence for a new visitor', async () => {
  const f = createFixture(); const list = f.repo.listRecentHistoryViews;
  f.repo.listRecentHistoryViews = async () => { throw Error('unavailable'); };
  const rt = runtime(apiOf(f)); const history = rt.instance('pages/history/index.js');
  await history.onLoad(); await history.loadBrowse();
  assert.match(history.data.browseError, /重试/);
  assert.equal(history.data.browse, null);
  assert.equal(history.data.boot.taskAvailable, false);
  assert.equal(history.data.boot.balance, 0);
  f.repo.listRecentHistoryViews = list;
  await history.onRetryBrowse();
  assert.equal(history.data.browseError, null);
  assert.equal(history.data.boot.taskAvailable, false);
  assert.equal(history.data.boot.balance, 0);
  assert.deepEqual(await f.repo.listLedger(userKeyOf()), []);
});

test('restock detail labels an observation gap without calling it unavailable duration', async () => {
  const rt = runtime(async () => ({ ok: true, dayKey: '2026-09-15', balance: 0, latest: [], summary: {}, events: [{ id: 'event', type: 'restock_confirmed', gapMs: 60000, detectedAt: '2026-09-15T00:00:00Z' }] }));
  const page = rt.instance('pages/history/index.js');
  page.data.boot = { taskAvailable: false }; page.selection = { partNumber: 'MXXX1CH/A', storeNumbers: [] };
  await page.onQuery();
  assert.equal(page.data.result.events[0].detailText, '距上次有效检测 1 分 0 秒');
});

test('delayed browse reward cannot restore credits after a newer explicit paid history query', async t => {
  const f = createFixture(), api = apiOf(f), late = deferred();
  await seedPendingBrowse(f);
  t.mock.method(Date, 'now', () => f.state.now.getTime());
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
  history.selection = { partNumber: 'MXXX1CH/A', storeNumbers: [] };
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
  await seedPendingBrowse(f);
  await store.getBootstrap();
  const browse = ok(await f.call('history.browse'));
  const signin = ok(await f.call('quota.signin'));
  assert.equal(signin.quota.revision, browse.task.quota.revision + 1);
  assert.equal(store.publishQuota(signin.quota), true);
  assert.equal(store.publishQuota(browse.task.quota), false);
  assert.equal((await store.getBootstrap()).quota.balance, 2);
});

test('repeated visits while capped preserve old evidence without changing the quota revision', async () => {
  const f = createFixture(); await seedPendingBrowse(f);
  await f.repo.updateUser(userKeyOf(), { quota: { balance: 10 } });
  const rt = runtime(apiOf(f)), store = rt.load('utils/store.js');
  const before = await store.getBootstrap();
  const browse = ok(await f.call('history.browse'));
  assert.equal(browse.task.granted, 0);
  assert.equal(browse.task.quota.revision, before.quota.revision);
  assert.equal(store.publishQuota(browse.task.quota), true);
  assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
  assert.deepEqual(copy((await store.getBootstrap()).quota.tasksViewedToday), ['view_history']);
});

test('Mine shows successful browsing separately from an unclaimed capped reward', async () => {
  for (const quota of [{ balance: 10, grantedToday: 0 }, { balance: 1, rewardDay: '2026-09-15', grantedToday: 2 }]) {
    const f = createFixture(); await seedPendingBrowse(f);
    await f.repo.updateUser(userKeyOf(), { quota });
    const rt = runtime(apiOf(f)); const mine = rt.instance('pages/mine/index.js'); await mine.onLoad();
    const history = rt.instance('pages/history/index.js'); history.applyBoot(await rt.load('utils/store.js').getBootstrap());
    await history.loadBrowse();
    assert.equal(mine.data.tasks[0].title, '旧版浏览奖励待领取');
    assert.equal(mine.data.tasks[0].pendingLabel, quota.balance === 10 ? '余额已满，今日用次后可领' : '今日领取已达上限');
    assert.equal(mine.data.tasks[0].claimable, false);
    let target;
    rt.wx.navigateTo = ({url}) => { target = url; };
    mine.onOpenPendingReward();
    assert.equal(target, undefined);
    assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
    if (quota.balance === 10) {
      await f.repo.updateUser(userKeyOf(), { quota: { balance: 9 } });
      mine.applyBoot(ok(await f.call('user.bootstrap')));
      assert.equal(mine.data.tasks[0].claimable, true);
      mine.onOpenPendingReward();
      assert.equal(target, '/pages/history/index');
      assert.equal(ok(await f.call('history.browse')).task.granted, 1);
    }
  }
});

test('a completed query from a previous client makes its earned reward visible after upgrading', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  const userKey = userKeyOf(), finishedAt = f.state.now.toISOString();
  await f.repo.saveQuery({ _id: 'previous-success', userKey, kind: 'history', status: 'success', response: { ok: true }, finishedAt });
  await f.repo.updateUser(userKey, { taskEvidence: { view_history: { queryId: 'previous-success', dayKey: '2026-09-15', completedAt: finishedAt } } });
  assert.deepEqual(ok(await f.call('user.bootstrap')).quota.tasksViewedToday, ['view_history']);
  assert.equal(ok(await f.call('quota.completeTask', { taskId: 'view_history' })).granted, 1);
  f.advance(86400000);
  assert.deepEqual(ok(await f.call('user.bootstrap')).quota.tasksViewedToday, []);
});

test('history hour totals name their original snapshot cutoff after the page remains open', async () => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const snapshotAt = `${today}T01:23:45.000Z`;
  const rt = runtime(async () => ({ ok: true, dayKey: today, balance: 0, latest: [], summary: { lastHourRestocks: 2 }, events: [], pagination: { snapshotAt, total: 0, hasMore: false } }));
  const history = rt.instance('pages/history/index.js'); history.data.boot = { taskAvailable: false }; history.selection = { partNumber: 'MXXX1CH/A', storeNumbers: [] };
  await history.onQuery(); history.refreshObservationSnapshot();
  assert.equal(history.data.result.lastHour, 2);
  assert.equal(history.data.result.lastHourWindowText, '截至 09:23:45 的近一小时');
});
