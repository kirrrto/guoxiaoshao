import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

function connectionRuntime() {
  const rt = runtime(undefined, { realApi: true }), attempts = [];
  rt.wx.cloud = { Cloud: class {
    constructor() { this.pending = deferred(); attempts.push(this); }
    init() { return this.pending.promise; }
  } };
  rt.load('app.js');
  return { rt, attempts };
}

for (const outcome of ['resolve', 'reject']) {
  test(`an old timed-out cloud init cannot ${outcome} over a recovered connection`, async () => {
    const { rt, attempts } = connectionRuntime();
    const first = rt.app.ensureCloud();
    await rt.nextTimer();
    await assert.rejects(first, /cloud_init_timeout/);
    const current = rt.app.ensureCloud();
    attempts[1].pending.resolve();
    assert.equal(await current, attempts[1]);
    attempts[0].pending[outcome](outcome === 'reject' ? Error('old auth failure') : undefined);
    await settle();
    assert.equal(rt.app.globalData.cloud, attempts[1]);
    assert.equal(rt.app.globalData.cloudError, null);
  });
}

test('late cloud success is reusable when no replacement attempt has started', async () => {
  const { rt, attempts } = connectionRuntime();
  const pending = rt.app.ensureCloud();
  await rt.nextTimer();
  await assert.rejects(pending, /cloud_init_timeout/);
  attempts[0].pending.resolve(); await settle();
  assert.equal(await rt.app.ensureCloud(), attempts[0]);
  assert.equal(attempts.length, 1);
  assert.equal(rt.app.globalData.cloudError, null);
});

for (const errMsg of ['cloud.callFunction:fail -601017 not allowed', 'cloud.callFunction:fail unknown configuration failure']) {
  test(`a safe read does not replay a non-transient failure: ${errMsg}`, async () => {
    const rt = runtime(undefined, { realApi: true }); let calls = 0;
    rt.app.ensureCloud = async () => ({ callFunction: async () => { calls++; throw { errMsg }; } });
    const pending = rt.load('utils/api.js').call('user.bootstrap'); pending.catch(() => {});
    await settle();
    assert.equal(rt.timers.size, 0, 'only identified transient failures may schedule the automatic retry');
    await assert.rejects(pending, error => error.code === 'call_failed');
    assert.equal(calls, 1);
  });
}

test('server timeouts retain safe diagnostics for each attempt and never log the payload', async () => {
  const rt = runtime(undefined, { realApi: true }), logged = []; let attempts = 0;
  rt.wx.getRealtimeLogManager = () => ({ warn: (label, details) => logged.push({ label, details }) });
  rt.app.ensureCloud = async () => ({ callFunction: async () => {
    attempts++; throw { errCode: -601008, errMsg: 'server-side request timeout', requestID: `req-${attempts}` };
  } });
  const pending = rt.load('utils/api.js').call('user.bootstrap', { token: 'MUST-NOT-LOG' }); pending.catch(() => {});
  await settle();
  assert.equal(await rt.nextTimer(), true);
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'call_failed');
    assert.equal(error.details.action, 'user.bootstrap');
    assert.equal(error.details.phase, 'call_function');
    assert.equal(error.details.errCode, -601008);
    assert.equal(error.details.requestId, 'req-2');
    assert.equal(error.details.attempt, 2);
    return true;
  });
  assert.deepEqual(logged.map(value => value.details.attempt), [1, 2]);
  assert.ok(logged.every(value => value.details.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(logged), /MUST-NOT-LOG|token/);
});

test('a stale catalog version respects failure backoff while explicit refresh can retry immediately', async t => {
  let now = Date.parse('2026-09-28T02:00:00Z'); t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const rt = runtime(async () => { calls++; throw Error('server-side request timeout'); });
  const store = rt.load('utils/store.js');
  const initial = await store.getCatalog(); await settle();
  rt.app.globalData.bootstrap = { catalogVersion: 'a-new-server-version' };
  assert.equal(await store.getCatalog(), initial); await settle();
  assert.equal(calls, 1, 'version mismatch must not bypass the failed refresh backoff');
  await assert.rejects(store.getCatalog({ force: true }), /timeout/);
  assert.equal(calls, 2, 'an explicit pull-to-refresh is allowed to retry');
  now += 30001;
  await store.getCatalog(); await settle();
  assert.equal(calls, 3);
});

test('a failed manual catalog refresh retries after backoff even when the previous catalog was fresh', async t => {
  let now = Date.parse('2026-09-28T02:00:00Z'); t.mock.method(Date, 'now', () => now);
  let fail = false, calls = 0;
  const rt = runtime(async () => { calls++; return fail ? {} : { unchanged: true }; });
  const store = rt.load('utils/store.js');
  await store.getCatalog(); await settle();
  fail = true;
  await assert.rejects(store.getCatalog({ force: true }), /商品目录暂时不可用/);
  await store.getCatalog(); await settle();
  assert.equal(calls, 2);
  now += 30001; fail = false;
  await store.getCatalog(); await settle();
  assert.equal(calls, 3);
  await store.getCatalog(); await settle();
  assert.equal(calls, 3, 'a successful refresh resets the retry deadline');
});

test('cloud authentication failures are identified separately and logging failure cannot replace them', async () => {
  const rt = runtime(undefined, { realApi: true });
  rt.wx.getRealtimeLogManager = () => ({ warn: () => { throw Error('log unavailable'); } });
  rt.app.ensureCloud = async () => { throw { errCode: -601017, errMsg: 'not allowed' }; };
  await assert.rejects(rt.load('utils/api.js').call('user.bootstrap'), error => {
    assert.equal(error.code, 'cloud_init_failed');
    assert.equal(error.details.phase, 'cloud_init');
    assert.equal(error.details.errCode, -601017);
    return true;
  });
  assert.equal(rt.timers.size, 0);
});
