import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, userContext } from './helpers/fixture.mjs';
import app from '../cloudfunctions/gxs_api/lib/app.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const validTrace = '9da5e443a2017acc';
function handler(log, requestIdOf) {
  return app.createHandler({ repo: createFixture().repo, log, requestIdOf });
}

test('a lost SDK request ID correlates with the exact SCF attempt; its read retry has a separate trace', async () => {
  const rt = runtime(undefined, { realApi: true }), native = [], local = [], remote = [];
  const handle = handler({ info: (label, details) => remote.push({ label, details }) }, () => 'scf-' + native.length);
  rt.wx.getRealtimeLogManager = () => ({ warn: (label, details) => local.push({ label, details }) });
  const payload = { token: 'private-token', note: 'private-text', owner: 'private-owner' };
  rt.app.ensureCloud = async () => ({ callFunction: async ({ data }) => {
    native.push(data);
    const result = await handle(data, userContext());
    assert.equal(result.ok, true);
    if (native.length === 1) throw { errCode: -601008, errMsg: '请求超时' };
    return { result };
  } });
  const call = rt.load('utils/api.js').call('system.ping', payload);
  await settle(); await rt.nextTimer();
  assert.equal((await call).hasUser, true);
  assert.equal(native.length, 2);
  assert.equal(local.length, 1);
  assert.equal(local[0].label, '[gxs] api_failure');
  assert.equal(local[0].details.requestId, null);
  assert.equal(local[0].details.errCode, -601008);
  assert.equal(local[0].details.clientTraceId, native[0].clientTraceId);
  assert.notEqual(native[0].clientTraceId, native[1].clientTraceId);
  for (const [i, attempt] of native.entries()) {
    assert.match(attempt.clientTraceId, /^[0-9a-f]{16}$/);
    assert.deepEqual(attempt.payload, payload, 'transport trace stays outside business payloads and idempotency keys');
    assert.deepEqual(remote[i], { label: '[gxs] api_attempt', details: { action: 'system.ping', clientTraceId: attempt.clientTraceId, requestId: 'scf-' + (i + 1) } });
  }
  assert.equal(remote.length, 2);
  assert.doesNotMatch(JSON.stringify([local, remote]), /private-|oUSER|OPENID/i);
});

test('unrecognized actions and malformed or nested traces produce no attempt log; native IDs cannot inject log text', async () => {
  let info = [];
  const handle = handler({ info: (...fields) => info.push(fields) }, () => 'bad\nid');
  for (const trace of [undefined, null, 42, [validTrace], { value: validTrace }, '0'.repeat(300), validTrace + '\n', validTrace.slice(1) + '\n', 'prefix-private-token']) {
    assert.equal((await handle({ action: 'system.ping', clientTraceId: trace, payload: { clientTraceId: validTrace } }, userContext())).ok, true);
  }
  for (const action of ['some.user.action', 'system.ping\n', 'toString', 'constructor', '__proto__']) {
    assert.equal((await handle({ action, clientTraceId: validTrace }, userContext())).error.code, 'unknown_action');
  }
  assert.equal(info.length, 0);
  await handle({ action: 'system.ping', clientTraceId: validTrace }, userContext());
  assert.deepEqual(info, [['[gxs] api_attempt', { action: 'system.ping', clientTraceId: validTrace, requestId: null }]]);
});

test('unavailable loggers cannot change an admitted action; no trace exists before native business dispatch', async () => {
  for (const log of [{}, { info() { throw Error('log unavailable'); } }, { info: async () => { throw Error('async log unavailable'); } }]) {
    const result = await handler(log, () => 'scf-1')({ action: 'system.ping', clientTraceId: validTrace }, userContext());
    assert.equal(result.ok, true);
  }
  const rt = runtime(undefined, { realApi: true }), warnings = [];
  rt.wx.getRealtimeLogManager = () => ({ warn: (_, value) => warnings.push(value) });
  rt.app.ensureCloud = async () => null;
  await assert.rejects(rt.load('utils/api.js').call('query.pickup', { queryId: 'private-id' }), err => err.code === 'cloud_init_failed');
  assert.equal(warnings[0].phase, 'cloud_init');
  assert.equal('clientTraceId' in warnings[0], false);
  assert.doesNotMatch(JSON.stringify(warnings), /private-id/);
});
