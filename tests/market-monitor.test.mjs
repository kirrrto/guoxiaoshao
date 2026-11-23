import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { applyObservation, targetKeyOf } = require('../cloudfunctions/gxs_api/lib/engine/events');
const { COLLECTIONS } = require('../cloudfunctions/gxs_api/lib/collections');
const log = { info() {}, warn() {}, error() {} };
const all = { JP: true, TW: true, HK: true };
const sites = [
  ['JP', 'R128', 'MJR54J/A', 'en'],
  ['TW', 'R713', 'MJRP4ZP/A', 'zh-CN'],
  ['HK', 'R409', 'MJRP4ZA/A', 'zh-CN'],
];

async function setup(config = {}) {
  const plan = { R128: { display: 'unavailable' }, R713: { display: 'unavailable' }, R409: { display: 'available' } };
  const upstream = fakeFetch(plan);
  const f = createFixture({ start: '2026-11-23T14:59:00Z', fetchImpl: upstream, config: {
    collector: { enabled: true, intervalSeconds: 60 }, internationalMarkets: all, internationalMonitoring: all, internationalNotifications: all,
    notifications: { enabled: true, templateIds: { restock: 'TPL_ZH', restockEn: 'TPL_EN' } }, ...config,
  } });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z', planId: 'annual' },
    subscriptions: { TPL_ZH: { credits: 5 }, TPL_EN: { credits: 5 } }, settings: { notifyEnabled: true, dnd: { enabled: false } } });
  for (const [market, store, partNumber, language] of sites) {
    const result = await f.call('market.watch', { market, partNumber, language, storeNumbers: [store], expectedUserKey: userKeyOf() });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const messages = [];
  const pass = () => runScheduled({ repo: f.repo, fetchImpl: upstream, clock: () => f.state.now, log,
    sendImpl: async m => { messages.push(m); return { errcode: 0 }; } });
  return { f, messages, pass, upstream, plan };
}

test('regional minute ticks keep the mainland queue independent, separate local days and deliver each confirmed restock once', async () => {
  const { f, messages, pass, upstream, plan } = await setup();
  await pass();
  assert.equal(messages.length, 0, 'first observation never sends an overseas restock alert');
  assert.equal(upstream.calls.length, 3);
  const status = await f.repo.getCollectorStatus();
  assert.equal(status.groupCount, 0);
  for (const [market] of sites) assert.equal(status.markets[market].groupCount, 1);
  await pass();
  assert.equal(upstream.calls.length, 3, 'duplicate minute invocation restores each market checkpoint');
  f.advance(60000);
  plan.R128.display = plan.R713.display = 'available';
  await pass();
  assert.equal(messages.length, 0, 'transition needs an independent confirming sample');
  f.advance(60000); await pass();
  assert.equal(messages.length, 2);
  const expected = [['JP','TPL_EN','en'],['TW','TPL_ZH','zh_CN']];
  for (const [market, template, lang] of expected) {
    const message = messages.find(m => m.page.includes('market=' + market));
    assert.ok(message);
    assert.ok(message.page.startsWith('pages/markets/index?'));
    assert.match(message.page, /storeNumber=R\d{3}.*eid=/);
    assert.equal(message.templateId, template);
    assert.equal(message.lang, lang);
    const eid = new URL('https://example.invalid/' + message.page).searchParams.get('eid');
    const detail = await f.call('notify.detail', { eventId: eid });
    assert.equal(detail.ok, true);
    assert.equal(detail.data.notification.market, market);
    assert.equal(detail.data.latest.status, 'available');
  }
  f.advance(60000); await pass();
  assert.equal(messages.length, 2);
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL_EN.credits, 4);
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL_ZH.credits, 4);
  const days = [...f.repo.tables.get(COLLECTIONS.observationDays).values()];
  assert.ok(days.some(row => row.market === 'JP' && row.dayKey === '2026-11-24'));
  assert.ok(days.filter(row => row.market === 'TW').every(row => row.dayKey === '2026-11-23'));
});

test('a three-minute regional cadence confirms a restock next minute across cold starts and drops a saturated sibling request', async () => {
  const limits = { maxRequestsPerMinute: 1, maxRequestsPerDay: 600 };
  const { f, messages, pass, upstream, plan } = await setup({ internationalQueryLimits: limits });
  await pass();
  assert.equal((await f.repo.getCollectorStatus()).markets.TW.intervalMs, 180000);
  f.advance(180000);
  plan.R128.display = plan.R713.display = 'available';
  await pass();
  await pass();
  assert.equal(messages.length, 0);
  assert.equal(upstream.calls.length, 6);

  f.advance(60000);
  const spent = await f.repo.consumeCollectorBudget({ ...limits, now: f.state.now.toISOString(), market: 'JP', budgetMode: 'daily', source: 'auto', autoShare: 0.8 });
  assert.equal(spent.allowed, true);
  await pass(); await pass();
  assert.deepEqual(messages.map(m => new URL('https://example.invalid/' + m.page).searchParams.get('market')), ['TW']);
  assert.equal(upstream.calls.length, 7);
  const callsFor = store => upstream.calls.filter(row => row.storeNumber === store).length;
  assert.deepEqual(['R128','R713','R409'].map(callsFor), [2,3,2]);
  f.advance(60000); await pass();
  assert.equal(upstream.calls.length, 7, 'an exhausted priority slot cannot be rearmed or become a late query');
  f.advance(60000); await pass();
  assert.equal(callsFor('R128'), 3, 'normal coverage resumes on its own cadence');
  assert.equal(messages.length, 1, 'expired stock is never delivered');
});

test('a manual regional transition discovered after the timer scan gets exactly one independent timely confirmation', async () => {
  const { f, messages, pass, upstream, plan } = await setup({ internationalQueryLimits: { maxRequestsPerMinute: 6, maxRequestsPerDay: 600 } });
  await pass();
  f.advance(10000); plan.R128.display = 'available';
  const manual = await f.call('market.pickup', { market: 'JP', partNumber: 'MJR54J/A', storeNumbers: ['R128'], queryId: 'manual-finds-market-restock', expectedUserKey: userKeyOf(), maxCost: 1 });
  assert.equal(manual.data.results[0].status, 'available');
  f.advance(50000);
  await pass(); await pass();
  assert.equal(messages.length, 1);
  assert.equal(upstream.calls.filter(call => call.storeNumber === 'R128').length, 3);
  assert.equal(upstream.calls.filter(call => call.storeNumber !== 'R128').length, 2);
});

test('a Japanese 503 and a stopped Hong Kong watch leave Taiwan observing and do not manufacture a recovery alert', async () => {
  const { f, messages, pass, upstream, plan } = await setup();
  await pass();
  const hk = (await f.call('market.follows', {})).data.follows.find(row => row.market === 'HK');
  await f.call('market.watchStatus', { expectedUserKey: userKeyOf(), followId: hk.followId, status: 'removed' });
  f.advance(60000); plan.R128.status = 503; await pass();
  const [jp] = await f.repo.getLatest([targetKeyOf('R128','MJR54J/A','JP')]);
  assert.ok(jp.unknownSince);
  assert.equal(jp.status, 'unavailable');
  delete plan.R128.status; plan.R128.display = 'available';
  for (let i = 0; i < 3; i++) { f.advance(60000); await pass(); }
  assert.equal(messages.length, 0);
  assert.equal(upstream.calls.filter(c => c.storeNumber === 'R409').length, 1);
  assert.equal(upstream.calls.filter(c => c.storeNumber === 'R713').length, 5);
});

test('a pending/ineligible or unknown stock state cannot produce an overseas restock', () => {
  for (const status of ['pending','ineligible','unknown']) {
    const sample = { storeNumber: 'R128', partNumber: 'P', market: 'JP', observedAt: '2026-11-01T00:00:00Z', status };
    const first = applyObservation(null, sample);
    const change = applyObservation(first.latest, { ...sample, status: 'available', observedAt: '2026-11-01T00:01:00Z' });
    assert.equal(change.events.length, 0);
  }
  assert.notEqual(targetKeyOf('R128','SKU','JP'), targetKeyOf('R128','SKU','HK'));
  assert.notEqual(targetKeyOf('R128','SKU','JP'), targetKeyOf('R128','SKU'));
});
