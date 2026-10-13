import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, userContext } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const { ledgerIds } = require('../cloudfunctions/gxs_api/lib/rules/quota.js');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const historyRequest = { historyQueryId: 'reward-proof-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'], dayKey: '2026-09-14' };

test('task reports need a successful server history query; unsupported configured tasks do not grant', async () => {
  const f = createFixture({ config: { quota: { historyCost: 0 }, tasks: [{ id: 'view_history', title: '浏览历史', reward: 1 }, { id: 'client_says_done', title: '未实现任务', reward: 9 }] } });
  const denied = await f.call('quota.completeTask', { taskId: 'view_history', completed: true, historyQueryId: 'fake-proof' });
  assert.equal(denied.error.code, 'task_not_completed');
  assert.equal((await f.call('quota.completeTask', { taskId: 'client_says_done' })).error.code, 'task_not_supported');
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 0);
  assert.equal(ok(await f.call('history.list', historyRequest)).ok, true);
  const stored = await f.repo.getUser(userKeyOf());
  assert.equal(stored.taskEvidence.view_history.dayKey, '2026-09-15', 'completion date, not the requested historical date, proves the task');
  const grants = await Promise.all(Array.from({ length: 8 }, () => f.call('quota.completeTask', { taskId: 'view_history' })));
  assert.equal(grants.reduce((sum, result) => sum + ok(result).granted, 0), 1);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
  f.advance(86400000);
  assert.equal(ok(await f.call('history.list', historyRequest)).replayed, true);
  assert.equal((await f.call('quota.completeTask', { taskId: 'view_history' })).error.code, 'task_not_completed', 'replaying yesterday\'s completed request does not create a new completion');
});

test('task proof rejects pending, failed, live, other-user, previous-day and invalid response records', async () => {
  for (const patch of [
    { status: 'pending' }, { status: 'failed' }, { kind: 'live' }, { userKey: userKeyOf('someone_else') },
    { finishedAt: '2026-09-14T15:59:59.999Z' }, { finishedAt: null }, { response: { ok: false } },
  ]) {
    const f = createFixture();
    ok(await f.call('user.bootstrap'));
    const query = { _id: 'untrusted-proof', userKey: userKeyOf(), kind: 'history', status: 'success', response: { ok: true }, finishedAt: f.state.now.toISOString(), ...patch };
    await f.repo.saveQuery(query);
    // Even a stale or malformed server marker cannot replace validating the record.
    await f.repo.updateUser(userKeyOf(), { taskEvidence: { view_history: { queryId: query._id, dayKey: '2026-09-15', completedAt: f.state.now.toISOString() } } });
    const result = await f.call('quota.completeTask', { taskId: 'view_history' });
    assert.equal(result.error.code, 'task_not_completed', JSON.stringify(patch));
    assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 0);
    assert.equal((await f.repo.listLedger(userKeyOf())).length, 0);
  }
});

test('legacy proof is found by Beijing completion day and rechecked after the lookup', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  const record = { _id: 'legacy-history', userKey: userKeyOf(), kind: 'history', status: 'success', response: { ok: true }, finishedAt: '2026-09-14T16:00:00.000Z' };
  await f.repo.saveQuery(record);
  const find = f.repo.findCompletedHistoryQuery;
  f.repo.findCompletedHistoryQuery = async (...args) => {
    const result = await find(...args);
    await f.repo.saveQuery({ ...record, status: 'failed', response: { ok: false } });
    return result;
  };
  assert.equal((await f.call('quota.completeTask', { taskId: 'view_history' })).error.code, 'task_not_completed');
  f.repo.findCompletedHistoryQuery = find;
  await f.repo.saveQuery(record);
  assert.equal(ok(await f.call('quota.completeTask', { taskId: 'view_history' })).granted, 1);
});

test('zero rewards stay disabled instead of falling back to the configured default', async () => {
  const f = createFixture({ config: { quota: { historyCost: 0, taskReward: 8, signinReward: 0 }, tasks: [{ id: 'view_history', title: '浏览历史', reward: 0 }] } });
  assert.equal(ok(await f.call('history.list', historyRequest)).ok, true);
  const result = ok(await f.call('quota.completeTask', { taskId: 'view_history' }));
  assert.equal(result.granted, 0);
  assert.equal(result.reason, 'reward_disabled');
  assert.equal(ok(await f.call('quota.signin')).reason, 'reward_disabled');
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 0);
  assert.deepEqual(await f.repo.listLedger(userKeyOf()), []);
});

test('failure to commit a successful history response also rolls back its task proof', async () => {
  const f = createFixture();
  ok(await f.call('quota.signin'));
  f.repo.transactionWriteHook = async (table, doc) => { if (table === C.queries && doc.status === 'success') throw new Error('completion storage unavailable'); };
  const result = ok(await f.call('history.list', historyRequest));
  assert.equal(result.ok, false);
  assert.equal(result.refunded, 1);
  assert.equal((await f.repo.getUser(userKeyOf())).taskEvidence, undefined);
  assert.equal((await f.call('quota.completeTask', { taskId: 'view_history' })).error.code, 'task_not_completed');
});

test('bootstrap uses server summaries without skipping fresh identity, status or query recovery reads', async () => {
  const f = createFixture({ config: { quota: { historyCost: 0 } } });
  ok(await f.call('history.list', historyRequest));
  const grants = await Promise.all([f.call('quota.signin'), f.call('quota.completeTask', { taskId: 'view_history' })]);
  assert.equal(grants.reduce((sum, result) => sum + ok(result).granted, 0), 2);
  const reads = [];
  for (const name of ['getConfig', 'getUser', 'getBootstrapMetadata', 'listExpiredQueries', 'listLedger', 'listFollows', 'getCatalogMeta', 'getCollectorStatus']) {
    const original = f.repo[name];
    f.repo[name] = async (...args) => { reads.push(name); return original(...args); };
  }
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.quota.grantedToday, 2);
  assert.equal(boot.quota.signedInToday, true);
  assert.deepEqual(boot.quota.tasksDoneToday, ['view_history']);
  assert.deepEqual(reads.sort(), ['getBootstrapMetadata', 'getConfig', 'getUser', 'listExpiredQueries'].sort());
  f.advance(86400000);
  const nextDay = ok(await f.call('user.bootstrap'));
  assert.equal(nextDay.quota.grantedToday, 0);
  assert.equal(nextDay.quota.signedInToday, false);
  assert.deepEqual(nextDay.quota.tasksDoneToday, []);
});

test('a failed last-seen write keeps the verified account usable and retries on the next visit', async () => {
  const f = createFixture();
  ok(await f.call('quota.signin'));
  const membership = { expiresAt: '2026-10-15T00:00:00.000Z' };
  await f.repo.updateUser(userKeyOf(), { membership });
  const before = await f.repo.getUser(userKeyOf());
  f.advance(11 * 60 * 1000);
  const update = f.repo.updateUser;
  let attempts = 0;
  const warnings = [], errors = [];
  const { createHandler } = require('../cloudfunctions/gxs_api/lib/app.js');
  const handle = createHandler({ repo: f.repo, clock: () => new Date(f.state.now),
    log: { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) } });
  f.repo.updateUser = async (id, patch) => {
    assert.equal(id, userKeyOf());
    assert.deepEqual(patch, { lastSeenAt: f.state.now.toISOString() });
    attempts++;
    throw new Error(`last-seen write unavailable for ${id}`);
  };
  const boot = ok(await handle({ action: 'user.bootstrap' }, userContext()));
  assert.equal(boot.membership.active, true);
  assert.equal(boot.membership.expiresAt, membership.expiresAt);
  assert.equal(boot.quota.balance, before.quota.balance);
  assert.equal(boot.quota.signedInToday, true);
  assert.equal(boot.identity.userKey, userKeyOf());
  assert.equal(attempts, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /last-seen/);
  assert.equal(JSON.stringify(warnings).includes(userKeyOf()), false, 'diagnostics contain no account identifiers');
  assert.deepEqual(errors, []);
  const brokenLogger = createHandler({ repo: f.repo, clock: () => new Date(f.state.now),
    log: { warn() { throw new Error('logger unavailable'); }, error: (...args) => errors.push(args) } });
  assert.equal(ok(await brokenLogger({ action: 'user.bootstrap' }, userContext())).quota.balance, before.quota.balance);
  assert.deepEqual(errors, [], 'a telemetry logger failure cannot reject a verified account');
  assert.deepEqual(await f.repo.getUser(userKeyOf()), before, 'failed telemetry cannot change account state');
  f.repo.updateUser = update;
  ok(await f.call('user.bootstrap'));
  assert.equal((await f.repo.getUser(userKeyOf())).lastSeenAt, f.state.now.toISOString());
});

test('required account and configuration read failures still reject bootstrap', async () => {
  for (const method of ['getUser', 'getConfig']) {
    const f = createFixture();
    ok(await f.call('user.bootstrap'));
    f.repo[method] = async () => { throw new Error('required read unavailable'); };
    const result = await f.call('user.bootstrap');
    assert.equal(result.ok, false, method);
    assert.equal(result.error.code, 'internal_error', method);
    assert.equal(result.data, undefined, 'a failed required read cannot return default entitlements');
  }
});

test('legacy bootstrap scans the full day and legacy follow documents; reward commit upgrades its summary', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  const user = await f.repo.getUser(userKeyOf());
  delete user.followIndex;
  delete user.quota.dailyRewardSnapshot;
  f.repo.tables.get(C.users).set(user._id, user);
  f.repo.insert(C.ledger, { _id: ledgerIds.task(user._id, '2026-09-15', 'view_history'), userKey: user._id, taskId: 'view_history', type: 'task_reward', delta: 1, dayKey: '2026-09-15', createdAt: '2026-09-15T00:00:00.000Z' });
  for (let i = 0; i < 120; i++) f.repo.insert(C.ledger, { _id: `old-debit-${i}`, userKey: user._id, type: 'query_debit', delta: -1, dayKey: '2026-09-15', createdAt: '2026-09-15T01:00:00.000Z' });
  await f.repo.saveFollow({ _id: 'legacy-follow', userKey: user._id, status: 'active' });
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.followCount, 1);
  assert.equal(boot.quota.grantedToday, 1);
  assert.deepEqual(boot.quota.tasksDoneToday, ['view_history']);
  const signin = ok(await f.call('quota.signin'));
  assert.equal(signin.quota.grantedToday, 2);
  assert.equal(signin.quota.signedInToday, true);
  assert.deepEqual(signin.quota.tasksDoneToday, ['view_history']);
  f.repo.listLedger = async () => { throw new Error('the upgraded reward summary should be used'); };
  assert.equal(ok(await f.call('user.bootstrap')).quota.grantedToday, 2);
});

test('a notification-test refund restores spent balance without consuming the daily reward allowance', async () => {
  const f = createFixture();
  ok(await f.call('quota.signin'));
  const user = await f.repo.getUser(userKeyOf());
  delete user.quota.dailyRewardSnapshot;
  f.repo.tables.get(C.users).set(user._id, user);
  f.repo.insert(C.ledger, { _id: 'notification-test-refund-001', userKey: user._id, type: 'notification_test_refund',
    delta: 1, dayKey: '2026-09-15', createdAt: f.state.now.toISOString() });
  const quota = ok(await f.call('user.bootstrap')).quota;
  assert.equal(quota.grantedToday, 1);
  assert.equal(quota.signedInToday, true);
});

test('independent settings updates merge atomically, are isolated by account and roll back on error', async () => {
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  const dnd = { enabled: true, startMinute: 1320, endMinute: 420 };
  const results = await Promise.all([f.call('user.updateSettings', { notifyEnabled: false }), f.call('user.updateSettings', { dnd })]);
  results.forEach(ok);
  assert.deepEqual((await f.repo.getUser(userKeyOf())).settings, { dnd, notifyEnabled: false });
  assert.equal(ok(await f.call('user.bootstrap', {}, userContext('other-account'))).settings.notifyEnabled, true);
  f.repo.transactionWriteHook = async table => { if (table === C.users) throw new Error('settings write failed'); };
  assert.equal((await f.call('user.updateSettings', { notifyEnabled: true })).error.code, 'internal_error');
  assert.deepEqual((await f.repo.getUser(userKeyOf())).settings, { dnd, notifyEnabled: false });
});
