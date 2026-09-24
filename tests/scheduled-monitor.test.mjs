import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { readTimerRuntime, isTrustedTimer, runScheduled, TRIGGER_NAME } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { monitoringSnapshot } = require('../cloudfunctions/gxs_api/lib/monitor-readiness');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { buildMessage } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const log = { info() {}, warn() {}, error() {} };
const event = { Type: 'Timer', TriggerName: TRIGGER_NAME };

async function setup(extra = {}) {
  let display = 'unavailable';
  const upstream = fakeFetch(() => ({ display }));
  const f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60, statusStaleAfterSeconds: 150 }, notifications: { enabled: true, templateIds: { restock: 'TPL' } }, ...extra }, fetchImpl: upstream });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { TPL: { credits: 3 } } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639'], status: 'active' });
  const sends = [];
  const sendImpl = async message => { sends.push(message); return { errcode: 0 }; };
  // Waiting inside a run advances the fake clock, as real time would.
  const run = more => runScheduled({ repo: f.repo, fetchImpl: upstream, sendImpl, clock: () => new Date(f.state.now), log, sleep: async ms => f.advance(ms), ...more });
  return { f, upstream, run, sends, available: () => { display = 'available'; } };
}

test('scheduled function trusts platform SOURCE and rejects all forged client Timer events', () => {
  assert.equal(isTrustedTimer(event, { SOURCE: 'wx_trigger' }), true);
  assert.equal(isTrustedTimer(event, { SOURCE: 'wx_trigger,scf' }), true);
  for (const context of [{}, { SOURCE: 'wx_client' }, { SOURCE: 'wx_client,scf' }, { SOURCE: 'wx_devtools' }, { SOURCE: 'wx_trigger', OPENID: 'user' }, { SOURCE: 'wx_trigger', FROM_APPID: 'wxconsumer' }]) assert.equal(isTrustedTimer(event, context), false);
  assert.equal(isTrustedTimer({ ...event, TriggerName: 'other' }, { SOURCE: 'wx_trigger' }), false);
  assert.equal(isTrustedTimer({ ...event, httpMethod: 'POST' }, { SOURCE: 'wx_trigger' }), false);
  const nativeTimer = { TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF' };
  assert.equal(isTrustedTimer(event, {}, nativeTimer), true);
  assert.equal(isTrustedTimer({ ...event, ...nativeTimer }, {}), false, 'caller fields never become trusted runtime');
  assert.equal(isTrustedTimer(event, { ...nativeTimer }), false, 'only the dedicated runtime argument supplies built-ins');
  assert.equal(isTrustedTimer(event, {}, { TRIGGER_SRC: 'timer' }), false);
  assert.equal(isTrustedTimer(event, { SOURCE: 'wx_client' }, nativeTimer), false);
  assert.equal(isTrustedTimer(event, { OPENID: 'user' }, nativeTimer), false);
});

test('request-scoped SCF environment overrides warm-instance markers and exposes no secrets', () => {
  const env = { TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF', TCB_SOURCE: 'wx_trigger', GXS_CONSUMER_APPSECRET: 'never-return' };
  const runtime = readTimerRuntime({ environment: JSON.stringify({ TRIGGER_SRC: 'client', TCB_SOURCE: 'wx_client', TOKEN: 'never-return' }) }, env);
  assert.equal(runtime.TRIGGER_SRC, 'client'); assert.equal(runtime.TCB_SOURCE, 'wx_client');
  assert.equal(runtime.GXS_CONSUMER_APPSECRET, undefined); assert.equal(runtime.TOKEN, undefined);
  assert.equal(isTrustedTimer(event, { SOURCE: runtime.TCB_SOURCE }, runtime), false);
  const legacy = readTimerRuntime({ environ: 'TRIGGER_SRC=timer;TENCENTCLOUD_RUNENV=SCF;TCB_SOURCE=;TOKEN=hidden' }, env);
  assert.equal(isTrustedTimer(event, { SOURCE: legacy.TCB_SOURCE }, legacy), true);
  assert.equal(isTrustedTimer(event, {}, readTimerRuntime({ environment: '{bad' }, env)), false);
});

test('minute scans keep real availability state; a restock is re-checked every 2s and sent once confirmed', async () => {
  const s = await setup();
  assert.equal((await s.run()).scanned, 2);
  assert.equal((await s.run()).scanned, 0, 'duplicate trigger cannot bypass due times');
  assert.equal((await s.f.repo.getCollectorStatus()).stats.lastBatchAt, s.f.state.now.toISOString(), 'a duplicate heartbeat retains the last actual batch time');
  s.f.advance(60000); s.available();
  const started = s.f.state.now.getTime();
  const next = await s.run();
  // Both stores change, are re-checked 2 s later (confirming, so both alerts go out),
  // then stay on the 2 s cadence until 20 s pass without another change.
  assert.equal(s.sends.length, 2);
  assert.ok(next.scanned >= 20, `fast re-checks while the stores are hot: ${next.scanned}`);
  assert.ok(s.f.state.now.getTime() - started >= 20000 && s.f.state.now.getTime() - started <= 30000, 'the fast cadence stops after 20 quiet seconds');
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.TPL.credits, 1);
  const status = await s.f.repo.getCollectorStatus();
  assert.equal(status.state, 'running'); assert.equal(status.mode, 'scheduled'); assert.equal(status.intervalMs, 60000);
  assert.equal(Date.parse(status.expiresAt) - s.f.state.now.getTime(), 150000);
  s.f.advance(60000); await s.run(); assert.equal(s.sends.length, 2, 'steady availability is not re-sent');
});

test('cold-start jitter does not skip a new minute or duplicate the same minute', async () => {
  const s = await setup();
  s.f.advance(750); await s.run(); assert.equal(s.upstream.calls.length, 2);
  s.f.advance(59000); await s.run(); assert.equal(s.upstream.calls.length, 2, 'still the same minute bucket');
  s.f.advance(350); await s.run(); assert.equal(s.upstream.calls.length, 4, 'new bucket is due despite 650ms earlier cold start');
  s.f.advance(500); await s.run(); assert.equal(s.upstream.calls.length, 4, 'duplicate trigger in bucket is suppressed');
});

test('deadline carries unfinished stores before recently scanned stores into the next minute', async () => {
  const s = await setup({ collector: { enabled: true, intervalSeconds: 60, maxConcurrency: 1 } });
  await s.f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577', 'R639', 'R320', 'R448'], status: 'active' });
  const original = s.upstream;
  const slow = async (...args) => { const result = await original(...args); s.f.advance(6000); return result; };
  await s.run({ fetchImpl: slow, maxRunMs: 10000 });
  assert.deepEqual(s.upstream.calls.map(x => x.storeNumber), ['R320', 'R448']);
  s.f.advance(60000); await s.run({ fetchImpl: slow, maxRunMs: 10000 });
  assert.deepEqual(s.upstream.calls.slice(2).map(x => x.storeNumber), ['R577', 'R639']);
});

test('failed observation persistence is visible and never reported as a successful batch', async () => {
  const s = await setup();
  s.f.repo.recordObservation = async () => { throw new Error('storage unavailable'); };
  const result = await s.run();
  assert.equal(result.scanned, 0); assert.equal(result.state, 'error');
  const status = await s.f.repo.getCollectorStatus();
  assert.equal(status.stats.lastBatchAt, null);
  assert.ok(status.scheduler.targets.every(x => x.health.persistenceFailed));
});

test('scheduled monitor remains useful with missing message credentials and has honest delivery readiness', async () => {
  const s = await setup({ notifications: { enabled: false, templateIds: {} } });
  const result = await s.run({ sendImpl: null });
  assert.equal(result.scanned, 2); assert.equal(s.sends.length, 0);
  const boot = await s.f.call('user.bootstrap');
  assert.equal(boot.data.collector.state, 'running'); assert.equal(boot.data.notifications.deliveryReady, false);
  assert.equal(boot.data.notifications.reason, 'template_missing');
});

test('a persisted 429 Retry-After survives the next function cold start', async () => {
  const s = await setup();
  let calls = 0;
  const upstream = async () => { calls++; return { status: 429, headers: { get: key => key.toLowerCase() === 'retry-after' ? '180' : null }, body: (async function* () { yield Buffer.from('{}'); })() }; };
  await s.run({ fetchImpl: upstream });
  assert.equal(calls, 2);
  s.f.advance(60000); await s.run({ fetchImpl: upstream }); assert.equal(calls, 2);
  assert.equal((await s.f.repo.getCollectorStatus()).state, 'throttled');
});

test('deadline is respected, and a manual-query restock is confirmed by one prompt re-check before sending', async () => {
  const s = await setup();
  const exhausted = await s.run({ maxRunMs: 0 });
  assert.equal(exhausted.scanned, 0); assert.equal(exhausted.deadlineReached, true);
  await s.run(); s.f.advance(1000); s.available();
  await s.f.call('query.pickup', { queryId: 'scheduled-manual-1', partNumber: 'MJYH4CH/A', storeNumbers: ['R577'] });
  assert.equal(s.sends.length, 0);
  const result = await s.run(); assert.ok(result.scanned >= 1, 'the store is re-checked to confirm'); assert.equal(s.sends.length, 1);
});

test('another active lease prevents timer traffic and heartbeat clobbering', async () => {
  const s = await setup();
  await s.f.repo.acquireLease({ id: 'collector_lease', ownerId: 'resident', now: s.f.state.now.toISOString(), expiresAt: new Date(s.f.state.now.getTime() + 15000).toISOString() });
  assert.equal((await s.run()).state, 'standby'); assert.equal(s.upstream.calls.length, 0);
  assert.equal(await s.f.repo.getCollectorStatus(), null);
});

test('readiness distinguishes stale worker, missing credentials and configured sender', () => {
  const now = new Date('2026-09-15T02:00:00Z');
  const config = mergeConfig({ collector: { enabled: true }, notifications: { enabled: true, templateIds: { restock: 'TPL' } } });
  const status = { mode: 'scheduled', state: 'running', updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 150000).toISOString(), notifications: { enabled: false, reason: 'consumer_credentials_missing' } };
  assert.equal(monitoringSnapshot(config, status, new Date(now.getTime() + 60000)).notifications.reason, 'consumer_credentials_missing');
  assert.equal(monitoringSnapshot(config, status, new Date(now.getTime() + 150001)).notifications.reason, 'collector_stale');
  assert.equal(monitoringSnapshot(config, { ...status, notifications: { enabled: true, reason: null } }, now).notifications.deliveryReady, false, 'a legacy configured-only heartbeat is not proof of token authentication');
  assert.equal(monitoringSnapshot(config, { ...status, notifications: { enabled: true, reason: null, authReady: true, authState: 'ready', validUntil: new Date(now.getTime() + 3600000).toISOString() } }, now).notifications.deliveryReady, true);
  assert.equal(monitoringSnapshot(config, { ...status, notifications: null }, now).notifications.reason, 'sender_unknown');
  assert.equal(monitoringSnapshot({ ...config, collector: { ...config.collector, enabled: false } }, status, now).collector.state, 'disabled', 'fresh heartbeat does not override an operator stop');
});

test('observation transaction fences out a worker whose lease changed after its request started', async () => {
  const s = await setup();
  await s.f.repo.acquireLease({ id: 'collector_lease', ownerId: 'new-owner', now: s.f.state.now.toISOString(), expiresAt: new Date(s.f.state.now.getTime() + 15000).toISOString() });
  await assert.rejects(s.f.repo.recordObservation({ observation: { storeNumber: 'R577', partNumber: 'MJYH4CH/A', status: 'available', source: 'auto', observedAt: s.f.state.now.toISOString() }, continuityGapMs: 300000,
    collectorLease: { ownerId: 'old-owner', nowIso: s.f.state.now.toISOString() } }), /采集执行权已转移/);
  assert.deepEqual(await s.f.repo.getLatest(['R577|MJYH4CH/A']), []);
  const saved = await s.f.repo.saveCollectorStatus({ state: 'running', ownerId: 'old-owner', updatedAt: s.f.state.now.toISOString() }, { ownerId: 'old-owner', nowIso: s.f.state.now.toISOString() });
  assert.equal(saved.saved, false);
  assert.equal(await s.f.repo.getCollectorStatus(), null, 'an old owner cannot overwrite the current worker heartbeat');
});

test('a real short-phrase template status is supported without permitting mismatched product fields', () => {
  const config = mergeConfig({ notifications: { templateFields: { status: 'phrase4' } } });
  assert.doesNotThrow(() => validateConfig(config));
  assert.equal(buildMessage({ detectedAt: '2026-09-15T02:00:00Z', eventType: 'restock_confirmed' }, config).data.phrase4.value, '确认补货');
  assert.throws(() => validateConfig(mergeConfig({ notifications: { templateFields: { product: 'phrase1' } } })), /templateFields/);
});
