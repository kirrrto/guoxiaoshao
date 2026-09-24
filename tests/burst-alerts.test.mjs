import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { runScheduled, runBudgetMs } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { createScheduler } = require('../cloudfunctions/gxs_api/lib/engine/scheduler');
const log = { info() {}, warn() {}, error() {} };
const RESTOCK = 'qcfmYZuvfallzFUAVrEaRsWw4vtnwpucYMaao65OzCw';
const SOLDOUT = '0km1cSmh23x-cHRGw4UXzx6aTFLInWjQMoXhHuywK5M';
const notifications = (extra = {}) => ({ enabled: true, cooldownMinutes: 30,
  templateIds: { restock: RESTOCK, soldout: SOLDOUT }, templateTitle: '商品到货提醒', contentMode: 'stock_status',
  templateFields: { product: 'thing1', time: 'time2', store: 'thing7', status: null, quantity: null },
  soldoutFields: { status: 'thing1', time: 'time2', product: 'thing12', quantity: 'number6', store: 'thing19' }, ...extra });

/**
 * One followed store whose pickup display follows \`script\`: the n-th request
 * returns script[n] (the last entry repeats). Waits inside a run advance the clock.
 */
async function monitored(script, { member = true, notify = notifications() } = {}) {
  let calls = 0;
  const upstream = fakeFetch(() => ({ display: script[Math.min(calls++, script.length - 1)] }));
  const f = createFixture({ config: { collector: { enabled: true, intervalSeconds: 60 }, notifications: notify }, fetchImpl: upstream });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { ...(member ? { membership: { expiresAt: '2026-10-15T00:00:00Z' } } : {}), subscriptions: { [RESTOCK]: { credits: 5 }, [SOLDOUT]: { credits: 5 } } });
  await f.repo.saveFollow({ _id: `${userKeyOf()}|f-0001-aaaa`, userKey: userKeyOf(), partNumber: 'MJYH4CH/A', storeNumbers: ['R577'], status: 'active' });
  const sends = [];
  const sendImpl = async message => { sends.push(message); return { errcode: 0 }; };
  const run = () => runScheduled({ repo: f.repo, fetchImpl: upstream, sendImpl, clock: () => new Date(f.state.now), log, sleep: async ms => f.advance(ms) });
  return { f, run, sends, requests: () => calls, kinds: () => sends.map(m => m.templateId === SOLDOUT ? 'soldout' : 'restock') };
}

test('restock then sell-out: each confirmed by a 2s re-check, sent on its own template, cooling down separately', async () => {
  // Minute scan sees stock gone; next minute a restock, re-checked at +2s; sold out at +6s, re-checked at +8s.
  const s = await monitored(['unavailable', 'available', 'available', 'available', 'unavailable', 'unavailable']);
  await s.run();
  s.f.advance(60000);
  await s.run();
  assert.deepEqual(s.kinds(), ['restock', 'soldout'], 'a 30-minute cooldown does not hold back the sell-out');
  const soldout = s.sends[1];
  // The fake upstream names the product and store after their codes.
  assert.deepEqual(soldout.data, { thing1: { value: '已断货，本轮补货结束' }, time2: soldout.data.time2, thing12: { value: '商品 MJYH4CH/A' }, number6: { value: '0' }, thing19: { value: 'R577' } });
  assert.match(soldout.page, /eid=R577%7CMJYH4CH%2FA%7Cbecame_unavailable/);
  const user = await s.f.repo.getUser(userKeyOf());
  assert.equal(user.subscriptions[RESTOCK].credits, 4);
  assert.equal(user.subscriptions[SOLDOUT].credits, 4);
});

test('a one-sample flicker sends nothing, in either direction', async () => {
  // available once (never confirmed), then gone: neither a restock nor a sell-out.
  const blip = await monitored(['unavailable', 'available', 'unavailable', 'unavailable']);
  await blip.run(); blip.f.advance(60000); await blip.run();
  assert.deepEqual(blip.kinds(), []);
  // In stock, gone for one 2s sample, back: one restock, no sell-out and no second restock.
  const dip = await monitored(['unavailable', 'available', 'available', 'unavailable', 'available', 'available']);
  await dip.run(); dip.f.advance(60000); await dip.run();
  assert.deepEqual(dip.kinds(), ['restock']);
});

test('sell-out alerts need their own template and are for members only', async () => {
  const unconfigured = await monitored(['unavailable', 'available', 'available', 'unavailable', 'unavailable'], {
    notify: notifications({ templateIds: { restock: RESTOCK } }) });
  await unconfigured.run(); unconfigured.f.advance(60000); await unconfigured.run();
  assert.deepEqual(unconfigured.kinds(), ['restock']);
  assert.equal([...unconfigured.f.repo.tables.get('gxs_notifications').values()].filter(t => t.eventType === 'became_unavailable').length, 0, 'no sell-out tasks without a template');
  // A new account's one free alert is the restock; it never receives sell-outs.
  const trial = await monitored(['unavailable', 'available', 'available', 'unavailable', 'unavailable'], { member: false });
  await trial.run(); trial.f.advance(60000); await trial.run();
  assert.deepEqual(trial.kinds(), ['restock']);
  assert.ok((await trial.f.repo.getUser(userKeyOf())).firstReminderSentAt);
});

test('with no cooldown every new restock and sell-out is sent; the fast cadence ends 20s after the last change', async () => {
  // Changes at the minute scan, +4s and +8s; then steady.
  const s = await monitored(['unavailable', 'available', 'available', 'unavailable', 'unavailable', 'available', 'available'], { notify: notifications({ cooldownMinutes: 0 }) });
  await s.run();
  s.f.advance(60000);
  const started = s.f.state.now.getTime();
  const before = s.requests();
  await s.run();
  const elapsed = s.f.state.now.getTime() - started;
  assert.ok(elapsed >= 28000 && elapsed <= 32000, `about 20s after the last change at +10s: ${elapsed}`);
  assert.ok(s.requests() - before >= 14, 'every 2 s while hot');
  assert.deepEqual(s.kinds(), ['restock', 'soldout', 'restock']);
});

test('scheduler burst mode only speeds a store up, spaces checks and survives a cold start', async () => {
  let now = 0, change = true;
  const scheduler = createScheduler({ clock: () => new Date(now), intervalMs: 60000, burstIntervalMs: 2000, burstQuietMs: 20000,
    fetchPickup: async () => ({ record: { httpStatus: 200 }, observations: [{ status: 'available' }] }), onBatch: async () => ({ changed: change }), log });
  scheduler.setTargets([{ key: 'R577|A', storeNumber: 'R577', partNumbers: ['A'] }]);
  await Promise.all(scheduler.tick());
  assert.equal(scheduler.bursting(), true);
  assert.equal(scheduler.nextDueInMs(), 2000);
  scheduler.hurry('R577');
  assert.equal(scheduler.nextDueInMs(), 2000, 'a hurried store still waits 2s after its last request');
  const saved = JSON.parse(JSON.stringify(scheduler.checkpoint()));
  const cold = createScheduler({ clock: () => new Date(now), intervalMs: 60000, burstIntervalMs: 2000, burstQuietMs: 20000, fetchPickup: async () => ({}), onBatch: async () => ({}), log });
  cold.setTargets([{ key: 'R577|A', storeNumber: 'R577', partNumbers: ['A'] }]);
  cold.restore(saved);
  assert.equal(cold.bursting(), true, 'the next minute continues the fast cadence');
  change = false; now = 21000;
  assert.equal(scheduler.bursting(), false);
  const slow = createScheduler({ clock: () => new Date(0), intervalMs: 1000, burstIntervalMs: 2000, burstQuietMs: 20000,
    fetchPickup: async () => ({ record: { httpStatus: 200 }, observations: [{ status: 'available' }] }), onBatch: async () => ({ changed: true }), log });
  slow.setTargets([{ key: 'R577|A', storeNumber: 'R577', partNumbers: ['A'] }]);
  await Promise.all(slow.tick());
  assert.equal(slow.nextDueInMs(), 1000, 'a faster normal cadence is never slowed down');
  assert.throws(() => scheduler.configure({ burstIntervalMs: -1 }));
});

test('a run lasts as long as the platform allows, with a margin', () => {
  assert.equal(runBudgetMs({ getRemainingTimeInMillis: () => 59900 }), 54900);
  assert.equal(runBudgetMs({ getRemainingTimeInMillis: () => 120000 }), 55000);
  assert.equal(runBudgetMs({ getRemainingTimeInMillis: () => 8000 }), 5000);
  assert.equal(runBudgetMs({}), 35000);
  assert.equal(runBudgetMs(null), 35000);
});
