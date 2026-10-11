import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, CONSUMER_APPID, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createWechatSender } = require('../cloudfunctions/gxs_api/lib/engine/wechat-sender');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { monitoringSnapshot } = require('../cloudfunctions/gxs_api/lib/monitor-readiness');
const { mergeConfig } = require('../cloudfunctions/gxs_api/lib/config');
const config = { collector: { enabled: true, maxConcurrency: 1 }, notifications: { enabled: true, templateIds: { restock: 'TPL' }, templateTitle: '订单状态提醒' } };
const log = { info() {}, error() {}, warn() {} };
const tokenResponse = () => ({ ok: true, json: async () => ({ access_token: 'private-token-not-for-heartbeats', expires_in: 7200 }) });

function fixture(patch = {}) {
  const f = createFixture({ config: { ...config, ...patch } });
  const sender = fetchImpl => createWechatSender({ appid: CONSUMER_APPID, expectedAppid: CONSUMER_APPID, appSecret: 'private-secret-not-for-heartbeats', fetchImpl, clock: () => new Date(f.state.now) });
  const run = (sendImpl, more = {}) => runScheduled({ repo: f.repo, sendImpl, fetchImpl: async () => { throw new Error('no monitored targets should request pickup'); }, clock: () => new Date(f.state.now), log, ...more });
  return { f, sender, run };
}

test('a token-only scheduled probe establishes authenticated health without sending a message', async () => {
  const s = fixture();
  const calls = [];
  const send = s.sender(async url => { calls.push(url); return tokenResponse(); });
  await s.run(send);
  assert.deepEqual(calls, ['https://api.weixin.qq.com/cgi-bin/stable_token']);
  const status = await s.f.repo.getCollectorStatus();
  assert.equal(status.notifications.credentialsConfigured, true);
  assert.equal(status.notifications.authState, 'ready');
  assert.equal(status.notifications.authReady, true);
  assert.equal(status.notifications.reason, null);
  const publicStatus = monitoringSnapshot(mergeConfig(config), status, s.f.state.now);
  assert.equal(publicStatus.notifications.deliveryReady, true);
  assert.equal(publicStatus.notifications.templateTitle, '订单状态提醒');
  assert.doesNotMatch(JSON.stringify(status), /private-token|private-secret|access_token=|api\.weixin/);
});

test('failed scheduled authentication keeps tasks pending, preserves credits and recovers on a later token-only probe', async () => {
  const s = fixture();
  await s.f.call('user.bootstrap');
  await s.f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { TPL: { credits: 1 } } });
  await s.f.repo.saveNotification({ _id: 'auth-pending', userKey: userKeyOf(), followId: 'missing-follow', eventId: 'auth-pending-event', templateId: 'TPL', status: 'pending', detectedAt: s.f.state.now.toISOString(), createdAt: s.f.state.now.toISOString() });
  let good = false;
  const calls = [];
  const send = s.sender(async url => { calls.push(url); return good ? tokenResponse() : { ok: true, json: async () => ({ errcode: 40125, errmsg: 'sensitive provider detail must not be published' }) }; });
  await s.run(send);
  let status = await s.f.repo.getCollectorStatus();
  assert.equal(status.notifications.authState, 'failed');
  assert.equal(status.notifications.reason, 'consumer_auth_failed');
  assert.equal(status.notifications.lastErrorCode, 'wechat_token_40125');
  assert.equal(monitoringSnapshot(mergeConfig(config), status, s.f.state.now).notifications.deliveryReady, false);
  assert.equal((await s.f.repo.listPendingNotifications({ limit: 20 })).length, 1);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 1);
  good = true; s.f.advance(60000);
  await s.run(send);
  status = await s.f.repo.getCollectorStatus();
  assert.equal(status.notifications.authState, 'ready');
  assert.equal(status.notifications.authReady, true);
  assert.equal(status.notifications.lastErrorCode, null);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.endsWith('/stable_token')));
});

test('scheduled probes respect missing credentials, disabled notifications, a competing lease and the deadline', async () => {
  for (const scenario of ['missing', 'disabled', 'standby', 'deadline', 'no-reserve']) {
    const s = fixture(scenario === 'disabled' ? { notifications: { ...config.notifications, enabled: false } } : {});
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error('probe was not authorized to run'); };
    const send = scenario === 'missing' ? createWechatSender({ appid: CONSUMER_APPID, expectedAppid: CONSUMER_APPID, fetchImpl }) : s.sender(fetchImpl);
    if (scenario === 'standby') await s.f.repo.acquireLease({ id: 'collector_lease', ownerId: 'other-worker', now: s.f.state.now.toISOString(), expiresAt: new Date(s.f.state.now.getTime() + 15000).toISOString() });
    await s.run(send, { maxRunMs: scenario === 'deadline' ? 0 : scenario === 'no-reserve' ? 1000 : 35000 });
    assert.equal(calls, 0, scenario);
    const status = await s.f.repo.getCollectorStatus();
    if (status) assert.equal(monitoringSnapshot(mergeConfig(await s.f.repo.getConfig()), status, s.f.state.now).notifications.deliveryReady, false, scenario);
  }
});

test('scheduled probe timeout is capped and reserves one second from the remaining invocation budget', async () => {
  for (const maxRunMs of [1500, 35000]) {
    const s = fixture();
    const send = s.sender(async () => tokenResponse());
    const originalProbe = send.probe;
    const timeouts = [];
    send.probe = async options => { timeouts.push(options.timeoutMs); return originalProbe(options); };
    await s.run(send, { maxRunMs });
    assert.deepEqual(timeouts, [Math.min(3000, maxRunMs - 1000)]);
  }
});

test('losing the collector lease while probing prevents inventory or message work afterward', async () => {
  const s = fixture();
  const send = s.sender(async () => {
    s.f.advance(16000);
    await s.f.repo.acquireLease({ id: 'collector_lease', ownerId: 'replacement', now: s.f.state.now.toISOString(), expiresAt: new Date(s.f.state.now.getTime() + 15000).toISOString() });
    return tokenResponse();
  });
  const result = await s.run(send);
  assert.equal(result.state, 'standby');
  assert.equal(await s.f.repo.getCollectorStatus(), null, 'the former owner must not overwrite the replacement heartbeat');
});

test('one failed auth probe per minute avoids repeated token attempts across collector iterations', async () => {
  const s = fixture();
  let calls = 0;
  const send = s.sender(async () => { calls++; return { ok: true, json: async () => ({ errcode: 40125 }) }; });
  const collector = createCollector({ repo: s.f.repo, sendImpl: send, fetchImpl: fakeFetch({}), clock: () => new Date(s.f.state.now), log, statusEveryMs: 0 });
  await collector.step();
  await collector.step();
  s.f.advance(59999); await collector.step();
  assert.equal(calls, 1);
  s.f.advance(1); await collector.step();
  assert.equal(calls, 2);
  await collector.lease.release();
});

test('readiness rejects unverified, expired and malformed-template heartbeats', () => {
  const now = new Date('2026-09-20T00:00:00.000Z');
  const status = { mode: 'scheduled', state: 'idle', updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 150000).toISOString(), notifications: { enabled: true, reason: null, credentialsConfigured: true, authReady: true, authState: 'ready', validUntil: new Date(now.getTime() + 5000).toISOString() } };
  const merged = mergeConfig(config);
  assert.equal(monitoringSnapshot(merged, status, now).notifications.deliveryReady, true);
  assert.equal(monitoringSnapshot(merged, status, new Date(now.getTime() + 5000)).notifications.deliveryReady, false);
  for (const patch of [{ authState: 'unchecked', authReady: false }, { authState: 'failed', authReady: false, reason: 'consumer_auth_failed' }]) assert.equal(monitoringSnapshot(merged, { ...status, notifications: { ...status.notifications, ...patch } }, now).notifications.deliveryReady, false);
  for (const id of ['524', ' ', ' TPL']) {
    const result = monitoringSnapshot(mergeConfig({ ...config, notifications: { ...config.notifications, templateIds: { restock: id } } }), status, now);
    assert.equal(result.notifications.templateConfigured, false);
    assert.equal(result.notifications.deliveryReady, false);
    assert.equal(result.notifications.reason, 'template_missing');
  }
});
