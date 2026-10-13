import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { readTimerRuntime, isTrustedTimer, runBudgetMs, runScheduled, TRIGGER_NAME } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { monitoringSnapshot } = require('../cloudfunctions/gxs_api/lib/monitor-readiness');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { buildMessage } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const log = { info() {}, warn() {}, error() {} };
const event = { Type: 'Timer', TriggerName: TRIGGER_NAME };

test('scheduled budget survives the SCF Node.js 20 remaining-time helper failure', () => {
  const context = { getRemainingTimeInMillis() { throw new TypeError('client.ms_elapsed is not a function'); } };
  assert.equal(runBudgetMs(context), 35000);
  assert.equal(runBudgetMs(context, 12000), 12000);
  assert.equal(runBudgetMs({}), 35000);
  assert.equal(runBudgetMs(null), 35000);
  assert.equal(runBudgetMs({ getRemainingTimeInMillis: () => NaN }), 35000);
});

test('scheduled budget preserves the platform method receiver and reserves cleanup time', () => {
  const context = { remaining: 17000, getRemainingTimeInMillis() { return this.remaining; } };
  assert.equal(runBudgetMs(context), 12000);
  assert.equal(runBudgetMs({ getRemainingTimeInMillis: () => 90000 }), 55000);
  assert.equal(runBudgetMs({ getRemainingTimeInMillis: () => 5500 }), 500);
  for (const remaining of [5000, 1000, 0, -1]) {
    assert.equal(runBudgetMs({ getRemainingTimeInMillis: () => remaining }), 0, `${remaining}ms must not start more work`);
  }
});

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

// Scheduler fixtures span many stores, but each account still obeys the real
// three-store allowance. Preserve target counts and scheduling assertions.
async function distributeStores(f, stores) {
  const seed = await f.repo.getUser(userKeyOf());
  const original = await f.repo.getFollow('F');
  await f.repo.saveFollow({ ...original, status: 'removed' });
  for (let i = 0; i < stores.length; i += 3) {
    const userKey = `scheduler-member-${i}`;
    await f.repo.createUser({ ...seed, _id: userKey, followIndex: [] });
    await f.repo.saveFollow({ _id: `${userKey}|follow`, userKey, partNumber: 'MJYH4CH/A',
      storeNumbers: stores.slice(i, i + 3), status: 'active', createdAt: f.state.now.toISOString() });
  }
}

test('production monitor entry publishes a fresh heartbeat when the platform time helper throws', async () => {
  const s = await setup();
  const entry = fs.readFileSync(new URL('../cloudfunctions/gxs_monitor/index.js', import.meta.url), 'utf8');
  const exported = {};
  let databaseCalls = 0;
  const scheduled = require('../cloudfunctions/gxs_monitor/lib/engine/scheduled');
  const imports = {
    'wx-server-sdk': { init() {}, getWXContext: () => ({}), database: () => { databaseCalls++; return {}; } },
    './lib/repo/cloudbase-repo': { createCloudbaseRepo: () => s.f.repo },
    './lib/engine/wechat-sender': { createWechatSender: () => null },
    './lib/engine/scheduled': { ...scheduled, runScheduled: options => scheduled.runScheduled({
      ...options, clock: () => new Date(s.f.state.now), log, sleep: async ms => s.f.advance(ms),
    }) },
    './lib/connection': { consumerAppid: 'test-consumer' },
  };
  vm.runInNewContext(entry, {
    exports: exported, require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
    process: { env: { GXS_ENABLE_SCHEDULED_MONITOR: 'true', TRIGGER_SRC: 'timer', TENCENTCLOUD_RUNENV: 'SCF' } },
    fetch: s.upstream,
  });
  const result = await exported.main(event, { getRemainingTimeInMillis() { throw new TypeError('client.ms_elapsed is not a function'); } });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'running');
  assert.equal(result.scanned, 2);
  assert.equal(databaseCalls, 1);
  const status = await s.f.repo.getCollectorStatus();
  assert.equal(status.updatedAt, s.f.state.now.toISOString());
  assert.equal(status.stats.lastBatchAt, s.f.state.now.toISOString());
  assert.equal(status.mode, 'scheduled');
});

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
  await distributeStores(s.f, ['R577', 'R639', 'R320', 'R448']);
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

test('a shared capacity pause bounds admission checks across hundreds of stores and cold starts', async () => {
  const s = await setup({ collector: { enabled: true, budgetMode: 'continuous', intervalSeconds: 60, maxConcurrency: 2 } });
  await s.f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: Array.from({ length: 400 }, (_, i) => `R${String(i).padStart(3, '0')}`), status: 'active' });
  let checks = 0;
  const retryAt = s.f.state.now.getTime() + 120000;
  s.f.repo.consumeCollectorBudget = async () => { checks++; return { allowed: false, reason: 'capacity_wait', retryAt, budgetMode: 'continuous' }; };
  assert.equal((await s.run()).scanned, 0);
  assert.equal(checks, 2, 'one concurrent wave is sufficient to learn the shared deficit');
  assert.equal((await s.f.repo.getCollectorStatus()).scheduler.admissionUntil, retryAt);
  s.f.advance(60000);
  assert.equal((await s.run()).scanned, 0);
  assert.equal(checks, 2, 'a cold start restores the global admission pause');
  assert.equal(s.upstream.calls.length, 0);
  assert.equal((await s.f.repo.getCollectorStatus()).state, 'budget_limited');
});

test('continuous mode migrates legacy daily checkpoints and resumes the same day', async () => {
  for (const reason of ['daily_budget', 'auto_budget_reserved']) {
    const s = await setup();
    s.f.repo.tables.get(C.config).set('collector_budget_2026-09-15', { _id: 'collector_budget_2026-09-15', dayCount: reason === 'daily_budget' ? 10000 : 8000 });
    assert.equal((await s.run()).scanned, 0);
    const oldStatus = await s.f.repo.getCollectorStatus();
    assert.equal(oldStatus.budget.reason, reason);
    // Reproduce the deployed checkpoint shape before global/per-target
    // admission fields and an explicit budget mode were introduced.
    delete oldStatus.budget.budgetMode;
    delete oldStatus.scheduler.admissionUntil; delete oldStatus.scheduler.admissionReason;
    for (const target of oldStatus.scheduler.targets) { delete target.guardUntil; delete target.guardReason; }
    await s.f.repo.saveCollectorStatus(oldStatus);
    const config = await s.f.repo.getConfig();
    await s.f.repo.saveConfig({ ...config, collector: { ...config.collector, budgetMode: 'continuous' } });
    s.f.advance(60000);
    await s.run();
    const migrated = await s.f.repo.getCollectorStatus();
    assert.equal(migrated.budget.budgetMode, 'continuous');
    assert.equal(migrated.budget.reason, 'capacity_wait');
    assert.ok(migrated.scheduler.admissionUntil < oldStatus.budget.retryAt, 'recovery no longer waits for midnight');
    s.f.advance(60000);
    assert.ok((await s.run()).scanned > 0, 'continuous refill resumes within the same day');
    assert.ok(s.upstream.calls.length > 0);
    assert.ok(s.f.state.now.getTime() < oldStatus.budget.retryAt);
  }
});

test('daily checkpoint migration leaves an existing source 429 pause intact', async () => {
  const s = await setup();
  s.f.repo.tables.get(C.config).set('collector_budget_2026-09-15', { _id: 'collector_budget_2026-09-15', dayCount: 10000 });
  await s.run();
  const oldStatus = await s.f.repo.getCollectorStatus();
  const nowMs = s.f.state.now.getTime();
  oldStatus.scheduler.breaker = { state: 'open', openedAt: nowMs, until: nowMs + 180000, failures: [], trips: 1, probeInFlight: false, reason: 'http_429' };
  await s.f.repo.saveCollectorStatus(oldStatus);
  const config = await s.f.repo.getConfig();
  await s.f.repo.saveConfig({ ...config, collector: { ...config.collector, budgetMode: 'continuous' } });
  s.f.advance(60000);
  const result = await s.run();
  assert.equal(result.scanned, 0); assert.equal(result.state, 'throttled');
  assert.equal(s.upstream.calls.length, 0);
  assert.deepEqual((await s.f.repo.getCollectorStatus()).scheduler.breaker, oldStatus.scheduler.breaker);
});

async function legacyHeartbeatCheckpoint({ dayCount = 10000, groups = 17 } = {}) {
  const s = await setup({ collector: { enabled: true, budgetMode: 'continuous', intervalSeconds: 60, statusStaleAfterSeconds: 150 } });
  s.f.state.now = new Date('2026-10-01T13:58:04.585Z');
  const midnight = Date.parse('2026-10-01T16:00:00.000Z');
  const stores = Array.from({ length: groups }, (_, i) => `R${300 + i}`);
  await distributeStores(s.f, stores);
  const previous = { _id: 'collector_status', mode: 'scheduled', state: 'running',
    updatedAt: s.f.state.now.toISOString(), groupCount: groups,
    // A later cold-start heartbeat replaced the original daily denial. This
    // is the shape observed in the production incident, not its first denial.
    budget: { allowed: true, reason: null, dayCount: 0, minuteCount: 0, maxRequestsPerDay: 10000, maxRequestsPerMinute: 60 },
    stats: { lastBatchAt: '2026-10-01T04:08:11.855Z' },
    scheduler: { version: 1, breaker: { state: 'closed', until: null, failures: [], trips: 0, reason: null, probeInFlight: false },
      storeLastRequestAt: [], targets: stores.map(store => ({ key: `${store}|MJYH4CH/A`, nextDueAt: midnight, failures: 0, burstUntil: 0 })) } };
  await s.f.repo.saveCollectorStatus(previous);
  s.f.repo.tables.get(C.config).set('collector_budget_2026-10-01', { _id: 'collector_budget_2026-10-01', dayCount });
  return { ...s, previous, midnight, stores };
}

test('continuous migration recovers all 17 legacy midnight targets after idle heartbeats lost the daily reason', async () => {
  const s = await legacyHeartbeatCheckpoint();
  assert.equal((await s.run()).scanned, 0, 'exhausted legacy capacity must refill before HTTP');
  const migrated = await s.f.repo.getCollectorStatus();
  assert.equal(migrated.budget.reason, 'capacity_wait');
  assert.ok(migrated.scheduler.targets.every(target => target.nextDueAt < s.midnight));
  assert.equal(s.f.repo.tables.get(C.config).get('collector_budget_2026-10-01').dayCount, 10000);
  for (let minute = 0; minute < 6 && new Set(s.upstream.calls.map(call => call.storeNumber)).size < 17; minute++) {
    s.f.advance(60000);
    await s.run();
  }
  assert.equal(new Set(s.upstream.calls.map(call => call.storeNumber)).size, 17, 'no old target remains stranded until midnight');
  assert.ok(s.f.state.now.getTime() < s.midnight);
  assert.ok(Date.parse((await s.f.repo.getCollectorStatus()).stats.lastBatchAt) > Date.parse(s.previous.stats.lastBatchAt));
});

test('legacy midnight migration needs persisted exhaustion and does not reset ordinary future targets', async () => {
  for (const variant of ['no-exhaustion', 'not-midnight', 'already-continuous']) {
    const s = await legacyHeartbeatCheckpoint({ dayCount: variant === 'no-exhaustion' ? 1 : 10000, groups: 1 });
    if (variant === 'not-midnight') s.previous.scheduler.targets[0].nextDueAt = s.midnight - 1000;
    if (variant === 'already-continuous') s.previous.budget.budgetMode = 'continuous';
    await s.f.repo.saveCollectorStatus(s.previous);
    assert.equal((await s.run()).scanned, 0, variant);
    assert.equal(s.upstream.calls.length, 0, variant);
    assert.equal((await s.f.repo.getCollectorStatus()).scheduler.targets[0].nextDueAt, s.previous.scheduler.targets[0].nextDueAt, variant);
  }
});

test('legacy idle-heartbeat migration preserves the real source pause and reconstructed failure backoff', async () => {
  const s = await legacyHeartbeatCheckpoint({ groups: 1 });
  const nowMs = s.f.state.now.getTime();
  const breaker = { state: 'open', openedAt: nowMs, until: nowMs + 180000, failures: [], trips: 1, probeInFlight: false, reason: 'http_429' };
  s.previous.scheduler.breaker = breaker;
  s.previous.scheduler.targets[0].failures = 6;
  s.previous.scheduler.targets[0].health = { lastFailureAt: nowMs, lastRequestAt: nowMs - 1000 };
  await s.f.repo.saveCollectorStatus(s.previous);
  assert.equal((await s.run()).scanned, 0);
  const migrated = await s.f.repo.getCollectorStatus();
  assert.equal(s.upstream.calls.length, 0);
  assert.deepEqual(migrated.scheduler.breaker, breaker);
  assert.equal(migrated.scheduler.targets[0].nextDueAt, nowMs + 60000);
  assert.equal(migrated.scheduler.targets[0].failures, 6);
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
