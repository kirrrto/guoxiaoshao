import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userContext, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const quiet = { info() {}, warn() {}, error() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await flush();
  assert.ok(predicate(), 'controlled asynchronous work reached the expected boundary');
}

async function setup(options = {}) {
  const upstream = fakeFetch(() => ({ display: 'available' }));
  const f = createFixture({ config: {
    collector: { enabled: true, intervalSeconds: 60, burstIntervalSeconds: 0, availableIntervalSeconds: options.availableIntervalSeconds ?? 3,
      budgetMode: 'continuous', maxRequestsPerDay: 100000 },
    notifications: { enabled: true, templateIds: { restock: 'TPL' }, cooldownMinutes: 0 },
  } });
  for (let i = 0; i < 5; i++) {
    const wxContext = userContext(`oASYNC${String(i).padStart(22, '0')}`);
    await f.call('user.bootstrap', {}, wxContext);
    const userKey = `${wxContext.FROM_APPID}:${wxContext.FROM_OPENID}`;
    await f.repo.updateUser(userKey, { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { TPL: { credits: 3 } } });
    await f.repo.saveFollow({ _id: `follow-${i}`, userKey, partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  }
  const sends = [], pending = [];
  let hold = true, active = 0, maxActive = 0;
  const sender = async (message, settings) => {
    sends.push({ message, settings }); active++; maxActive = Math.max(maxActive, active);
    try { if (hold) await new Promise(resolve => pending.push(resolve)); return { errcode: 0 }; }
    finally { active--; }
  };
  sender.appid = CONSUMER_APPID;
  const collector = createCollector({ repo: f.repo, fetchImpl: upstream, sendImpl: sender, clock: () => new Date(f.state.now), log: quiet,
    mode: options.mode || 'resident', sleep: flush });
  const first = await collector.step(); await Promise.all(first.started); await collector.drainNotifications();
  f.advance(options.availableIntervalSeconds === 0 ? 60000 : 3000);
  const second = await collector.step();
  const secondWork = Promise.all(second.started);
  await until(() => sends.length === 1);
  return { f, collector, upstream, sends, pending, secondWork, get maxActive() { return maxActive; },
    releaseAll() { hold = false; while (pending.length) pending.shift()(); },
    async cleanup() { collector.stop(); this.releaseAll(); await secondWork; await collector.drainNotifications(); await collector.lease.release(); },
  };
}

test('resident availability sampling persists while five controlled slow notifications are sent serially', async () => {
  const s = await setup();
  try {
    let persisted = false; s.secondWork.then(() => { persisted = true; }); await flush();
    assert.equal(persisted, true, 'a handed-off message must not hold the observation dispatch open');
    for (let i = 0; i < 5; i++) {
      s.f.advance(3000);
      await Promise.all((await s.collector.step()).started);
      const [latest] = await s.f.repo.getLatest(['R577|MJYH4CH/A']);
      assert.equal(latest.observedAt, s.f.state.now.toISOString());
      assert.equal(latest.sampleCount, i + 3);
      assert.equal(s.sends.length, i + 1, 'the current send stays held while sampling continues');
      s.pending.shift()();
      if (i < 4) await until(() => s.sends.length === i + 2);
    }
    await s.collector.drainNotifications();
    assert.equal(s.sends.length, 5);
    assert.equal(new Set(s.sends.map(send => send.message.touser)).size, 5);
    assert.equal(s.maxActive, 1);
    assert.ok(s.sends.every(send => send.settings.timeoutMs > 0 && send.settings.timeoutMs <= 8000));
  } finally { await s.cleanup(); }
});

test('concurrent notification kicks share one work promise and one coalesced follow-up pass', async () => {
  const s = await setup();
  try {
    let reads = 0;
    const listPending = s.f.repo.listPendingNotifications;
    s.f.repo.listPendingNotifications = async args => { reads++; return listPending(args); };
    const work = s.collector.drainNotifications();
    for (let i = 0; i < 100; i++) assert.equal(s.collector.drainNotifications(), work);
    s.releaseAll(); await work;
    assert.equal(s.sends.length, 5); assert.equal(s.maxActive, 1);
    assert.ok(reads <= 2, `100 kicks must not create 100 queued passes; got ${reads}`);
  } finally { await s.cleanup(); }
});

test('resident stop joins the existing send and starts no later notification', async () => {
  const s = await setup();
  let run;
  try {
    let finished = false;
    run = s.collector.run().then(() => { finished = true; });
    await flush(); s.collector.stop(); await flush();
    assert.equal(finished, false, 'shutdown waits for an already handed-off message');
    s.releaseAll(); await run;
    assert.equal(s.sends.length, 1);
    assert.equal(s.collector.lease.isHeld(), false);
  } finally { s.collector.stop(); s.releaseAll(); if (run) await run; await s.cleanup(); }
});

test('a lost collector lease fences queued notifications and subsequent HTTP after the in-flight send settles', async () => {
  const s = await setup();
  try {
    s.f.advance(16000);
    const other = await s.f.repo.acquireLease({ id: 'collector_lease', ownerId: 'replacement', now: s.f.state.now.toISOString(),
      expiresAt: new Date(s.f.state.now.getTime() + 15000).toISOString() });
    assert.equal(other.acquired, true);
    s.releaseAll(); await s.secondWork; await s.collector.drainNotifications();
    assert.equal(s.sends.length, 1);
    const previous = s.upstream.calls.length;
    assert.equal((await s.collector.step()).held, false);
    assert.equal(s.upstream.calls.length, previous);
  } finally { await s.cleanup(); }
});

test('default resident mode and scheduled collectors keep their existing awaited notification lifecycle', async () => {
  for (const options of [{ availableIntervalSeconds: 0 }, { mode: 'scheduled' }]) {
    const s = await setup(options);
    try {
      let finished = false; s.secondWork.then(() => { finished = true; }); await flush();
      assert.equal(finished, false, JSON.stringify(options));
      s.releaseAll(); await s.secondWork; assert.equal(s.sends.length, 5);
    } finally { await s.cleanup(); }
  }
});

test('a delayed notification config read cannot roll back a newer collector configuration', async () => {
  const s = await setup();
  let releaseRead;
  try {
    s.releaseAll(); await s.secondWork; await s.collector.drainNotifications();
    const readConfig = s.f.repo.getConfig, previous = await readConfig();
    let intercept = true, entered = false;
    s.f.repo.getConfig = async () => {
      const value = await readConfig();
      if (intercept) { intercept = false; entered = true; await new Promise(resolve => { releaseRead = resolve; }); }
      return value;
    };
    const olderPass = s.collector.drainNotifications(); await until(() => entered);
    await s.f.repo.saveConfig({ ...previous, collector: { ...previous.collector, availableIntervalSeconds: 0 },
      notifications: { ...previous.notifications, enabled: false } });
    await s.collector.refreshTargets();
    assert.equal(s.collector.currentConfig().collector.availableIntervalSeconds, 0);
    releaseRead(); await olderPass;
    assert.equal(s.collector.currentConfig().collector.availableIntervalSeconds, 0, 'notification work cannot restore its stale cadence snapshot');
    assert.equal(s.collector.currentConfig().notifications.enabled, false);
    assert.equal(s.collector.scheduler.snapshot().availableIntervalMs, 0);
    assert.equal(s.sends.length, 5);
  } finally { if (releaseRead) releaseRead(); await s.cleanup(); }
});
