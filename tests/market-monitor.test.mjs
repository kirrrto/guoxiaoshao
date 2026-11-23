import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, fakeFetch, userKeyOf } from './helpers/fixture.mjs';
import { marketMembership } from './helpers/market-membership.mjs';

const require = createRequire(import.meta.url);
const { runScheduled } = require('../cloudfunctions/gxs_api/lib/engine/scheduled');
const { sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const { createWechatSender } = require('../cloudfunctions/gxs_api/lib/engine/wechat-sender');
const { applyObservation, targetKeyOf } = require('../cloudfunctions/gxs_api/lib/engine/events');
const { COLLECTIONS } = require('../cloudfunctions/gxs_api/lib/collections');
const log = { info() {}, warn() {}, error() {} };
const all = { JP: true, TW: true, HK: true };
const sites = [
  ['JP', 'R128', 'MJR54J/A', 'en'],
  ['TW', 'R713', 'MJRP4ZP/A', 'zh-CN'],
  ['HK', 'R409', 'MJRP4ZA/A', 'zh-CN'],
];

async function setup(config = {}, planId = 'member_365d') {
  const plan = { R128: { display: 'unavailable' }, R713: { display: 'unavailable' }, R409: { display: 'available' } };
  const upstream = fakeFetch(plan);
  const f = createFixture({ start: '2026-11-23T14:59:00Z', fetchImpl: upstream, config: {
    collector: { enabled: true, intervalSeconds: 60 }, internationalMarkets: all, internationalMonitoring: all, internationalNotifications: all,
    notifications: { enabled: true, templateIds: { restock: 'TPL_ZH', restockEn: 'TPL_EN' } }, ...config,
  } });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: planId ? marketMembership(f.state.now, planId) : {},
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

async function setupTestAdmin(t) {
  const previous = process.env.GXS_TEST_ADMIN_USER_KEY;
  process.env.GXS_TEST_ADMIN_USER_KEY = userKeyOf();
  t.after(() => {
    if (previous === undefined) delete process.env.GXS_TEST_ADMIN_USER_KEY;
    else process.env.GXS_TEST_ADMIN_USER_KEY = previous;
  });
  return setup({ adminUserKeys: [userKeyOf()] }, null);
}

test('monthly and annual members can save all three regions before monitoring starts; the timer picks up the saved watches when enabled', async () => {
  const off = { JP: false, TW: false, HK: false };
  for (const planId of ['member_30d', 'member_365d']) {
    const { f, messages, pass, upstream } = await setup({
      internationalMarkets: off, internationalMonitoring: off, internationalNotifications: off,
    }, planId);
    const list = (await f.call('market.follows')).data;
    assert.deepEqual([list.watchRegistrationOpen, list.canWatch, list.savedCount], [true, true, 3]);
    assert.deepEqual(list.monitoring, off);
    assert.deepEqual(list.notifications, off);
    await pass();
    assert.equal(upstream.calls.length, 0);
    assert.equal(messages.length, 0);
    const config = await f.repo.getConfig();
    await f.repo.saveConfig({ ...config, collector: { ...config.collector, enabled: false }, internationalMonitoring: all, internationalNotifications: all });
    const globallyStopped = (await f.call('market.follows')).data;
    assert.deepEqual(globallyStopped.monitoring, off);
    assert.deepEqual(globallyStopped.notifications, off);
    await f.repo.saveConfig({ ...config, internationalMonitoring: { ...off, TW: true } });
    f.advance(60000); await pass();
    assert.deepEqual(upstream.calls.map(c => c.storeNumber), ['R713']);
    assert.equal((await f.call('market.follows')).data.savedCount, 3);
    assert.equal(messages.length, 0);
  }
});

for (const stage of ['final database read', 'WeChat token refresh', 'message already posted']) {
  test('a language edit during ' + stage + ' respects the message handoff and its original credit', async () => {
    const { f, pass, plan, upstream } = await setup();
    await pass();
    plan.R128.display = 'available';
    f.advance(60000); await pass();
    f.advance(60000);
    await runScheduled({ repo: f.repo, fetchImpl: upstream, clock: () => f.state.now, log });
    const [task] = await f.repo.listPendingNotifications({ limit: 10 });
    assert.equal(task.market, 'JP');
    const config = await f.repo.getConfig(), user = await f.repo.getUser(userKeyOf());
    let edits = 0, posts = 0;
    const edit = async () => {
      const result = await f.call('market.editWatch', { expectedUserKey: userKeyOf(), followId: task.followId,
        expectedUpdatedAt: task.targetSnapshot.updatedAt, language: 'zh-CN' });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      edits++;
    };
    if (stage === 'final database read') {
      const getConfig = f.repo.getConfig;
      let reads = 0;
      f.repo.getConfig = async () => {
        if (++reads === 2) { f.repo.getConfig = getConfig; await edit(); }
        return getConfig();
      };
    }
    const sender = createWechatSender({ appid: user.appid, expectedAppid: user.appid, appSecret: 'test-secret',
      clock: () => f.state.now, fetchImpl: async url => {
        if (url.endsWith('/stable_token')) {
          if (stage === 'WeChat token refresh') await edit();
          return Response.json({ access_token: 'test-token', expires_in: 3600 });
        }
        assert.match(new URL(url).pathname, /message\/subscribe\/send$/);
        posts++;
        if (stage === 'message already posted') { await edit(); throw Error('reply lost'); }
        return Response.json({ errcode: 0 });
      } });
    const send = () => sendTask({ task, config, repo: f.repo, sendImpl: sender, now: f.state.now, clock: () => f.state.now });
    const result = await send();
    assert.equal(edits, 1);
    const dispatched = stage === 'message already posted';
    assert.equal(result.status, dispatched ? 'uncertain' : 'skipped');
    if (!dispatched) assert.equal(result.reason, 'follow_not_active');
    await send();
    assert.equal(posts, dispatched ? 1 : 0);
    const subs = (await f.repo.getUser(userKeyOf())).subscriptions;
    assert.deepEqual([subs.TPL_EN.credits, subs.TPL_ZH.credits], [dispatched ? 4 : 5, 5]);
  });
}

test('a designated admin without a membership monitors regional stock and spends only actual WeChat authorizations', async t => {
  const { f, pass, messages, plan } = await setupTestAdmin(t);
  await f.repo.updateUser(userKeyOf(), { subscriptions: { TPL_EN: { credits: 1 }, TPL_ZH: { credits: 0 } } });
  await pass();
  for (const [market] of sites) assert.equal((await f.repo.getCollectorStatus()).markets[market].groupCount, 1);
  plan.R128.display = plan.R713.display = 'available';
  f.advance(60000); await pass();
  f.advance(60000); await pass();
  assert.deepEqual(messages.map(m => m.templateId), ['TPL_EN']);
  const user = await f.repo.getUser(userKeyOf());
  assert.equal(user.subscriptions.TPL_EN.credits, 0);
  assert.deepEqual(user.membership, {});
  const notifications = await f.repo.listNotifications(userKeyOf(), 10);
  assert.ok(notifications.some(n => n.market === 'TW' && n.reason === 'no_subscription_credit'));
});

test('revoking the designated admin after credit reservation stops delivery and restores the authorization', async t => {
  const { f, pass, messages, upstream, plan } = await setupTestAdmin(t);
  await pass();
  plan.R128.display = 'available';
  f.advance(60000); await pass();
  const reserve = f.repo.reserveSubscriptionCredit;
  f.repo.reserveSubscriptionCredit = async args => {
    const result = await reserve(args);
    assert.equal(result.reserved, true);
    await f.repo.saveConfig({ ...await f.repo.getConfig(), adminUserKeys: [] });
    return result;
  };
  f.advance(60000); await pass();
  assert.equal(messages.length, 0);
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL_EN.credits, 5);
  const notifications = await f.repo.listNotifications(userKeyOf(), 10);
  assert.ok(notifications.some(n => n.market === 'JP' && n.reason === 'membership_required'));
  const samples = upstream.calls.length;
  f.advance(60000); await pass();
  assert.equal(upstream.calls.length, samples);
  assert.deepEqual((await f.repo.getCollectorStatus()).markets, {});
  assert.equal((await f.repo.listFollows(userKeyOf())).length, 3);
});

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

test('a withdrawn regional store or product cannot create a restock task or send one queued before delisting', () => {
  const { buildTasks, skipReason } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
  const config = {collector:{enabled:true},notifications:{enabled:true,templateIds:{restock:'OK'}},
    internationalMonitoring:{JP:true},internationalNotifications:{JP:true}};
  const now = new Date('2026-11-23T02:00:00Z');
  for (const target of [{partNumber:'MFHE4J/A',storeNumber:'R128'}, {partNumber:'MJR54J/A',storeNumber:'R999'}]) {
    const event={...target,market:'JP',type:'restock_confirmed',previousStatus:'unavailable',detectedAt:now.toISOString()};
    const follow={market:'JP',partNumber:target.partNumber,storeNumbers:[target.storeNumber],userKey:'owner',status:'active'};
    assert.deepEqual(buildTasks({events:[event],follows:[follow],users:new Map(),config,now}),[]);
    assert.equal(skipReason({task:{...event,eventType:event.type},follow,config,now}),'invalid_market_target');
  }
});

test('a regional tier downgrade after planning stops delivery and the next tick removes regional targets without deleting watches', async () => {
  const { f, messages, pass, upstream, plan } = await setup();
  await pass();
  f.advance(60000); plan.R128.display = 'available'; await pass();
  const reserve = f.repo.reserveSubscriptionCredit;
  f.repo.reserveSubscriptionCredit = async args => {
    const reservation = await reserve(args);
    await f.repo.updateUser(userKeyOf(), { membership: marketMembership(f.state.now, 'member_7d') });
    return reservation;
  };
  f.advance(60000); await pass();
  assert.equal(messages.length, 0);
  assert.equal((await f.repo.getUser(userKeyOf())).subscriptions.TPL_EN.credits, 5);
  const history = await f.repo.listNotifications(userKeyOf(), 10);
  const receipt = history.find(n => n.market === 'JP' && n.reason === 'market_watch_plan_required');
  assert.ok(receipt);
  const before = upstream.calls.length;
  const readLatest = f.repo.getLatest;
  let latestReads = 0;
  f.repo.getLatest = async keys => { latestReads++; return readLatest(keys); };
  const wallet = (await f.repo.getUser(userKeyOf())).quota.balance;
  const payload = { eventId: receipt.eventId, expectedUserKey: userKeyOf() };
  const detail = await f.call('notify.detail', payload);
  assert.equal(detail.data.notification.eventId, receipt.eventId);
  assert.equal(detail.data.latest.restricted, true);
  assert.equal(latestReads, 0);
  assert.equal((await f.call('notify.open', payload)).ok, true);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, wallet);
  f.advance(60000); await pass();
  assert.equal(upstream.calls.length, before);
  assert.deepEqual((await f.repo.getCollectorStatus()).markets, {});
  assert.equal((await f.repo.listFollows(userKeyOf())).length, 3);
});

for (const edit of ['language', 'removeStore']) {
  test('a confirmed regional restock rechecks a watch ' + edit + ' edit after reserving the old template credit', async () => {
    const { f, pass, plan, messages, upstream } = await setup({ internationalQueryLimits: { maxRequestsPerMinute: 30, maxRequestsPerDay: 20000 } });
    const { findMarket } = require('../cloudfunctions/gxs_api/lib/markets');
    const [market, store, partNumber] = sites[0];
    const other = findMarket(market).stores.find(s => s.storeNumber !== store).storeNumber;
    plan[other] = { display: 'unavailable' };
    const saved = await f.call('market.watch', { expectedUserKey: userKeyOf(), market, partNumber, storeNumbers: [other] });
    assert.equal(saved.ok, true);
    const follow = saved.data.follow;
    await pass();
    plan[store].display = 'available';
    f.advance(60000); await pass();
    let reservations = 0;
    const reserve = f.repo.reserveSubscriptionCredit;
    f.repo.reserveSubscriptionCredit = async args => {
      const result = await reserve(args);
      assert.equal(result.reserved, true);
      reservations++;
      const reply = await f.call('market.editWatch', { expectedUserKey: userKeyOf(), followId: follow.followId,
        expectedUpdatedAt: follow.updatedAt, [edit]: edit === 'language' ? 'zh-CN' : store });
      assert.equal(reply.ok, true, JSON.stringify(reply.error));
      return result;
    };
    f.advance(60000); await pass();
    assert.equal(reservations, 1);
    assert.equal(messages.length, 0);
    const user = await f.repo.getUser(userKeyOf());
    assert.deepEqual([user.subscriptions.TPL_EN.credits, user.subscriptions.TPL_ZH.credits], [5,5]);
    const rows = await f.repo.listNotifications(userKeyOf(), 10);
    assert.ok(rows.some(n => n.market === market && n.status === 'skipped' && n.reason === 'follow_not_active'));
    if (edit === 'removeStore') {
      const count = () => upstream.calls.filter(c => c.storeNumber === store).length;
      const before = count();
      f.advance(60000); await pass();
      assert.equal(count(), before);
    }
  });
}
