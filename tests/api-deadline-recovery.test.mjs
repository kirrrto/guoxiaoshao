import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = data => ({ result: { ok: true, data } });
const boot = balance => ({ quota: { balance, revision: balance } });

test('a stalled account read settles after one retry and releases the shared promise for manual recovery', async () => {
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
  assert.equal([...rt.timers.values()][0].ms, 800, 'only the existing safe read retry is scheduled');
  await rt.nextTimer(); await settle();
  assert.equal(attempts.length, 2);
  await rt.nextTimer();
  await assert.rejects(pending, error => error.code === 'call_failed' && error.details.attempt === 2);
  await assert.rejects(otherPage, error => error.code === 'call_failed');
  assert.equal(rt.timers.size, 0);

  const recovered = store.getBootstrap({ force: true }); await settle();
  assert.equal(attempts.length, 3);
  attempts[2].resolve(response(boot(3))); await recovered;
  attempts[0].resolve(response(boot(1))); attempts[1].resolve(response(boot(2))); await settle();
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
