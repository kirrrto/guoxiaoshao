import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, fakeFetch, operatorContext, userKeyOf } from './helpers/fixture.mjs';

const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = data => ({ result: { ok: true, data } });
const boot = balance => ({ quota: { balance, revision: balance } });
const timeout = () => Object.assign(Error('errCode: -601008 server-side request timedout | errMsg: 请求超时; requestId: sdk-123'), { errMsg: '请求超时' });

for (const stage of ['backoff', 'connecting']) {
  test(`a retired read does not dispatch its SDK timeout retry after invalidation during ${stage}`, async () => {
    const rt = runtime(undefined, { realApi: true }), api = rt.load('utils/api.js');
    const connection = deferred();
    let connections = 0, calls = 0;
    const cloud = { callFunction: async () => {
      if (++calls === 1) throw timeout();
      return response('current account');
    } };
    rt.app.ensureCloud = async () => ++connections === 2 && stage === 'connecting' ? connection.promise : cloud;
    const previous = api.call('follow.list');
    previous.catch(() => {});
    await settle();
    if (stage === 'connecting') { await rt.nextTimer(); await settle(); }
    api.resetPendingReads();
    const current = api.call('follow.list');
    await settle();
    if (stage === 'backoff') await rt.nextTimer();
    else connection.resolve(cloud);
    assert.equal(await current, 'current account');
    await assert.rejects(previous, err => err.details.errCode === -601008 && err.details.attempt === 1);
    assert.equal(calls, 2, 'only the original request and the current account request reached the server');
    assert.equal(rt.timers.size, 0);
  });
}

test('existing stock alternatives use one shared, bounded read retry with exact SDK diagnostics', async () => {
  const rt = runtime(undefined, { realApi: true }), api = rt.load('utils/api.js'), logs = [];
  let calls = 0;
  rt.wx.getRealtimeLogManager = () => ({ warn: (_, details) => logs.push(details) });
  rt.app.ensureCloud = async () => ({ callFunction: async () => { if (++calls === 1) throw timeout(); return response({ results: [] }); } });
  const payload = { queryId: 'private-query-id' };
  const pending = api.call('query.alternatives', payload);
  assert.equal(api.call('query.alternatives', payload), pending);
  await settle(); await rt.nextTimer();
  assert.deepEqual(await pending, { results: [] });
  assert.equal(calls, 2);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].phase, 'call_function');
  assert.equal(logs[0].errCode, -601008);
  assert.equal(logs[0].requestId, 'sdk-123');
  assert.doesNotMatch(JSON.stringify(logs), /private-query-id/);
  assert.equal(rt.timers.size, 0);
});

test('a native SDK timeout after a committed last-credit query keeps its id and permits explicit replay only', async () => {
  const fetchImpl = fakeFetch({ R577: { display: 'available' } });
  const backend = createFixture({ fetchImpl });
  await backend.call('user.bootstrap', {});
  await backend.call('admin.grantCredits', { userKey: userKeyOf(), grantId: 'native-timeout-credit', amount: 1 }, operatorContext());
  const rt = runtime(undefined, { realApi: true }), api = rt.load('utils/api.js'), operations = rt.load('utils/operation.js');
  let calls = 0;
  const payload = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
  rt.app.ensureCloud = async () => ({ callFunction: async ({ data }) => {
    const result = await backend.call(data.action, data.payload);
    assert.equal(result.ok, true);
    if (++calls === 1) throw timeout();
    return { result };
  } });
  const id = operations.begin('q', payload, userKeyOf());
  await assert.rejects(api.call('query.pickup', { ...payload, queryId: id }), error =>
    operations.uncertain(error) && error.details.errCode === -601008 && error.details.requestId === 'sdk-123');
  assert.equal(calls, 1);
  assert.equal(rt.timers.size, 0, 'no native retry is scheduled for a paid operation');
  assert.equal((await backend.repo.getUser(userKeyOf())).quota.balance, 0);
  backend.advance(120000);
  assert.equal(operations.begin('q', payload, userKeyOf()), id);
  const result = await api.call('query.pickup', { ...payload, queryId: id });
  assert.equal(result.replayed, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal((await backend.repo.listLedger(userKeyOf())).filter(entry => entry.type === 'query_debit').length, 1);
});

test('a stalled account read settles at its deadline without duplicating a still-running request', async () => {
  const rt = runtime(undefined, { realApi: true });
  const attempts = [];
  rt.app.ensureCloud = async () => ({ callFunction: () => { const request = deferred(); attempts.push(request); return request.promise; } });
  const store = rt.load('utils/store.js');
  const pending = store.getBootstrap(); pending.catch(() => {});
  const otherPage = store.getBootstrap(); otherPage.catch(() => {});
  await settle();
  assert.equal(attempts.length, 1, 'tabs share one pending read');
  assert.equal([...rt.timers.values()][0].ms, 12000);
  await rt.nextTimer(); await settle();
  assert.equal(attempts.length, 1, 'a native request with no callback is not automatically duplicated');
  await assert.rejects(pending, error => error.code === 'call_failed' && error.details.attempt === 1);
  await assert.rejects(otherPage, error => error.code === 'call_failed');
  assert.equal(rt.timers.size, 0);

  const recovered = store.getBootstrap({ force: true }); await settle();
  assert.equal(attempts.length, 2);
  attempts[1].resolve(response(boot(3))); await recovered;
  attempts[0].resolve(response(boot(1))); await settle();
  assert.equal(rt.app.globalData.bootstrap.quota.balance, 3, 'late responses cannot replace the recovered account');
  assert.equal(rt.timers.size, 0);
});

for (const action of ['query.pickup', 'history.list', 'member.createOrder', 'notificationTest.send']) {
  test(`a stalled ${action} remains uncertain and never automatically repeats`, async () => {
    const rt = runtime(undefined, { realApi: true }); let calls = 0;
    rt.app.ensureCloud = async () => ({ callFunction: () => { calls++; return new Promise(() => {}); } });
    const pending = rt.load('utils/api.js').call(action); pending.catch(() => {});
    await settle();
    assert.equal([...rt.timers.values()][0].ms, 35000);
    await rt.nextTimer();
    await assert.rejects(pending, error => error.code === 'call_failed' && rt.load('utils/operation.js').uncertain(error));
    assert.equal(calls, 1);
    assert.equal(rt.timers.size, 0);
  });
}

test('a synchronously throwing platform request releases its deadline', async () => {
  const rt = runtime(undefined, { realApi: true });
  rt.app.ensureCloud = async () => ({ callFunction: () => { throw Error('invalid environment'); } });
  await assert.rejects(rt.load('utils/api.js').call('query.pickup'), error => error.code === 'call_failed');
  assert.equal(rt.timers.size, 0);
});
