import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const EVENT = 'R577|SKU|restock_confirmed|2026-10-08T02:00:00.000Z';

for (const scene of [1014, 1107]) {
  test(`a new subscription-message entry (${scene}) can reopen a previously displayed event`, () => {
    const rt = runtime(); rt.load('app.js');
    rt.app.globalData.handledAlerts = [EVENT];
    rt.app.onShow({ path: 'pages/follow/index', scene, query: { eid: encodeURIComponent(EVENT) } });
    assert.equal(rt.app.globalData.pendingAlert, EVENT);
    rt.app.globalData.pendingAlert = null;
    rt.app.onShow({ path: 'pages/follow/index', scene: 1001, query: { eid: EVENT } });
    assert.equal(rt.app.globalData.pendingAlert, null, 'ordinary resume does not reopen the handled event');
    rt.app.captureAlert({ query: { eid: EVENT } });
    assert.equal(rt.app.globalData.pendingAlert, null, 'the page onLoad duplicate does not reopen it');
  });
}

test('only the follow destination consumes notification event parameters', () => {
  const rt = runtime(); rt.load('app.js');
  rt.app.onShow({ path: 'pages/query/index', scene: 1107, query: { eid: EVENT } });
  assert.equal(rt.app.globalData.pendingAlert, null);
});

test('a warm entry from Moments preview starts normal cloud access without requiring a process restart', async () => {
  const rt = runtime(undefined, { realApi: true }); rt.load('app.js');
  let connections = 0;
  rt.app.ensureCloud = async () => { connections++; return { callFunction: async () => ({ result: { ok: true, data: { recovered: true } } }) }; };
  rt.app.onLaunch({ scene: 1154, query: {} });
  rt.app.onShow({ scene: 1154, query: {} });
  assert.equal(connections, 0);
  assert.equal(rt.app.globalData.singlePage, true);
  rt.app.onShow({ scene: 1155, path: 'pages/query/index', query: {} });
  assert.equal(rt.app.globalData.singlePage, false);
  assert.equal(connections, 1);
  const result = await rt.load('utils/api.js').call('user.bootstrap');
  assert.equal(result.recovered, true);
});
