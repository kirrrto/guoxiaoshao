import test from 'node:test';
import { marketMembership } from './helpers/market-membership.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userContext, userKeyOf } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const { findMarket } = require('../cloudfunctions/gxs_api/lib/markets.js');
const { validateFollowLimits } = require('../cloudfunctions/gxs_api/lib/rules/membership.js');
const enabled = { JP: true, TW: true, HK: true };
const actor = userKeyOf();
const ok = reply => { assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.data; };
const target = code => {
  const market = findMarket(code);
  return { expectedUserKey: actor, market: code, partNumber: market.products[0].partNumber, storeNumbers: [market.stores[0].storeNumber] };
};
async function memberFixture() {
  const f = createFixture({ config: { internationalMonitoring: enabled, internationalMarkets: enabled } });
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(actor, { membership: marketMembership(f.state.now, 'member_30d') });
  return f;
}

test('only verified market targets can be watched, under the signed-in account and current plan', async () => {
  const f = createFixture();
  assert.equal((await f.call('market.watch', target('JP'))).error.code, 'market_watch_plan_required');
  assert.equal((await f.call('market.watch', { ...target('JP'), market: 'US' })).error.code, 'unknown_market');
  await f.repo.saveConfig({ ...await f.repo.getConfig(), internationalMarkets: enabled });
  assert.equal((await f.call('market.watch', target('JP'))).error.code, 'market_watch_plan_required');
  assert.equal((await f.call('market.watch', { ...target('HK'), language: 'ja' })).error.code, 'invalid_language');
  assert.equal((await f.call('market.watch', { ...target('HK'), partNumber: target('JP').partNumber })).error.code, 'unknown_product');
  assert.equal((await f.call('market.watch', { ...target('HK'), storeNumbers: target('TW').storeNumbers })).error.code, 'unknown_store');
  assert.equal((await f.call('market.watch', { ...target('JP'), expectedUserKey: undefined })).error.code, 'market_account_changed');
  assert.equal((await f.call('market.watchStatus', { expectedUserKey: 'other', status: 'paused' })).error.code, 'market_account_changed');
  assert.equal((await f.call('market.follows', { expectedUserKey: 'other' })).error.code, 'market_account_changed');
  assert.deepEqual(await f.repo.listFollows(actor), []);
});

test('saving additional stores is atomic and idempotent, preserving original language and pause state', async () => {
  const f = await memberFixture();
  const jp = findMarket('JP'), payload = target('JP');
  const { follow: first } = ok(await f.call('market.watch', { ...payload, language: 'en' }));
  const write = await Promise.all([jp.stores[1], jp.stores[2]].map(store => f.call('market.watch', { ...payload, storeNumbers: [store.storeNumber] })));
  write.forEach(ok);
  const list = ok(await f.call('market.follows', { expectedUserKey: actor }));
  assert.equal(list.follows.length, 1);
  assert.equal(list.savedCount, 1);
  assert.equal(list.follows[0].language, 'en');
  assert.deepEqual(list.follows[0].storeNumbers, jp.stores.slice(0, 3).map(s => s.storeNumber).sort());
  ok(await f.call('market.watch', { ...payload, storeNumbers: [jp.stores[3].storeNumber] }));
  assert.equal((await f.call('market.watch', { ...payload, storeNumbers: [jp.stores[4].storeNumber] })).error.code, 'too_many_stores');
  const status = { expectedUserKey: actor, followId: first.followId, status: 'paused' };
  const { follow: paused } = ok(await f.call('market.watchStatus', status));
  const { follow: replay } = ok(await f.call('market.watch', payload));
  assert.equal(replay.status, 'paused');
  assert.equal(replay.updatedAt, paused.updatedAt);
  const { follow: duplicate } = ok(await f.call('market.watchStatus', status));
  assert.equal(duplicate.updatedAt, paused.updatedAt);
  assert.equal((await f.call('follow.remove', { followId: first.followId })).error.code, 'unknown_follow');
  assert.equal((await f.call('market.watchStatus', { ...status, expectedUserKey: userKeyOf('bob') }, userContext('bob'))).error.code, 'unknown_follow');
  await f.repo.saveConfig({ ...await f.repo.getConfig(), internationalMonitoring: {}, internationalMarkets: {} });
  assert.equal(ok(await f.call('market.watchStatus', { ...status, status: 'active' })).follow.status, 'active');
  await f.repo.updateUser(actor, { membership: { expiresAt: '2020-01-01T00:00:00Z' } });
  for (let i = 0; i < 2; i++) assert.equal(ok(await f.call('market.watchStatus', { ...status, status: 'removed' })).follow.status, 'removed');
  assert.equal(ok(await f.call('market.follows')).savedCount, 0);
});

test('domestic and market saves share one transactional slot limit while each interface returns only its regions', async () => {
  const f = await memberFixture();
  const cn = { followId: 'domestic-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
  const { follow } = ok(await f.call('follow.upsert', cn));
  ok(await f.call('market.watch', target('JP')));
  ok(await f.call('market.watch', { ...target('JP'), partNumber: findMarket('JP').products[1].partNumber }));
  const last = await Promise.all([f.call('market.watch', target('HK')), f.call('market.watch', target('TW'))]);
  assert.equal(last.filter(res => res.ok).length, 1);
  assert.equal(last.find(res => !res.ok).error.code, 'too_many_follows');
  const { follows, otherMarketCount } = ok(await f.call('follow.list'));
  assert.equal(follows.length, 1);
  assert.equal(follows[0].followId, follow.followId);
  assert.equal(otherMarketCount, 3);
  assert.equal(ok(await f.call('market.follows')).follows.length, 3);
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.followCount, 1);
  assert.equal(boot.otherMarketFollowCount, 3);
  assert.equal((await f.call('market.watchStatus', { expectedUserKey: actor, followId: follow.followId, status: 'removed' })).error.code, 'unknown_follow');
  assert.equal((await f.call('follow.upsert', { ...cn, partNumber: 'MYYY2CH/A', followId: 'domestic-002' })).error.code, 'too_many_follows');
  const sameSku = { market: 'TW', partNumber: 'X', storeNumbers: ['R001'] };
  assert.equal(validateFollowLimits([{ ...sameSku, market: 'HK' }], sameSku).ok, true);
  assert.equal(validateFollowLimits([sameSku], sameSku).reason, 'duplicate_part_number');
});

test('a regional watch survives a downgrade; only a current monthly or annual pass can add, resume or use it', async () => {
  const f = await memberFixture();
  await f.repo.saveConfig({ ...await f.repo.getConfig(), internationalMarkets: {}, internationalMonitoring: {} });
  const watch = ok(await f.call('market.watch', target('JP'))).follow;
  const state = status => ({ expectedUserKey: actor, followId: watch.followId, status });
  for (const lower of ['member_7d','member_trial']) {
    await f.repo.updateUser(actor, { membership: marketMembership(f.state.now, lower, 100 * 86400000) });
    const snapshots = ok(await f.call('market.follows'));
    assert.equal(snapshots.canWatch, false);
    assert.deepEqual([snapshots.follows[0].status, snapshots.follows[0].savedStatus, snapshots.follows[0].eligibleStoreNumbers], ['plan_required','active',[]]);
    assert.equal((await f.call('market.watch', target('TW'))).error.code, 'market_watch_plan_required');
    ok(await f.call('market.watchStatus', state('paused')));
    assert.equal((await f.call('market.watchStatus', state('active'))).error.code, 'market_watch_plan_required');
    await f.repo.updateUser(actor, { membership: marketMembership(f.state.now, 'member_365d', 2000) });
    const yes = ok(await f.call('market.watchStatus', state('active'))).follow;
    assert.deepEqual(yes.eligibleStoreNumbers, watch.storeNumbers);
  }
  f.advance(2000);
  assert.equal(ok(await f.call('market.follows')).follows[0].status, 'expired');
  assert.equal(ok(await f.call('market.watchStatus', state('removed'))).follow.status, 'removed');
});

test('international notification entries stay in the markets tab on cold and warm launches', () => {
  const rt = runtime(); rt.load('app.js');
  const region = target('JP');
  const eid = ['JP', region.storeNumbers[0], region.partNumber, 'restock_confirmed', '2026-11-23T12:00:00.000Z'].join('|');
  const options = { path: 'pages/markets/index', query: { market: 'JP', partNumber: encodeURIComponent(region.partNumber), storeNumber: region.storeNumbers[0], eid: encodeURIComponent(eid) } };
  rt.app.prepareEntryCloud = () => {};
  rt.app.watchForUpdate = () => {};
  rt.app.refreshConsentLater = () => {};
  for (const lifecycle of ['onLaunch', 'onShow']) {
    rt.app.globalData.pendingMarketTarget = null;
    rt.app[lifecycle](options);
    const result = JSON.parse(JSON.stringify(rt.app.globalData.pendingMarketTarget));
    assert.deepEqual(result, { market: 'JP', partNumber: region.partNumber, storeNumber: region.storeNumbers[0], eid });
    assert.equal(rt.app.globalData.pendingAlert, null);
  }
  rt.app.captureSharedTarget({ ...options, query: { ...options.query, market: 'US' } });
  assert.equal(rt.app.globalData.pendingMarketTarget, null);
  rt.app.captureSharedTarget({ ...options, query: { ...options.query, eid: '%qq' } });
  assert.equal(rt.app.globalData.pendingMarketTarget, null);
  rt.app.captureAlert({ query: options.query });
  assert.equal(rt.app.globalData.pendingAlert, null);
});

test('an old mainland notification link cannot present a regional receipt as a mainland pickup', async () => {
  const rt = runtime(async () => ({ notification: { market: 'JP', eventId: 'regional-event' } }));
  const page = rt.instance('pages/follow/index.js');
  await page.loadAlert('regional-event');
  assert.equal(page.data.alert.retryable, false);
  assert.match(page.data.alert.error, /其他站点/);
  assert.equal(page.presentedAlertId, undefined);
  assert.deepEqual(rt.calls.map(call => call.action), ['notify.detail']);
});

test('regional watch edits keep independent settings and protect concurrent changes and the last store', async () => {
  const f = await memberFixture(), payload = target('TW');
  const [first, second] = findMarket('TW').stores.map(s => s.storeNumber);
  const { follow } = ok(await f.call('market.watch', { ...payload, storeNumbers: [first, second] }));
  const edit = patch => f.call('market.editWatch', { followId: follow.followId, expectedUserKey: actor, expectedUpdatedAt: follow.updatedAt, ...patch });
  assert.equal((await edit({ language: 'other' })).error.code, 'invalid_language');
  assert.equal((await edit({ language: 'en', removeStore: first })).error.code, 'invalid_payload');
  assert.equal((await edit({ language: 'en', expectedUserKey: 'changed' })).error.code, 'market_account_changed');
  const edits = await Promise.all([edit({ language: 'en' }), edit({ removeStore: second })]);
  assert.deepEqual(edits.map(r => r.ok).sort(), [false, true]);
  assert.equal(edits.find(r => !r.ok).error.code, 'watch_changed');
  const current = ok(await f.call('market.follows')).follows[0];
  const update = current.language === 'en' ? { removeStore: second } : { language: 'en' };
  const edited = ok(await edit({ ...update, expectedUpdatedAt: current.updatedAt })).follow;
  assert.deepEqual([edited.storeNumbers, edited.language, edited.savedStatus], [[first], 'en', 'active']);
  assert.equal((await edit({ removeStore: first, expectedUpdatedAt: edited.updatedAt })).error.code, 'last_watch_store');
  const staleAdd = await f.call('market.watch', { ...payload, storeNumbers: [second], expectedUpdatedAt: follow.updatedAt });
  assert.equal(staleAdd.error.code, 'watch_changed');
  const staleRemoval = await f.call('market.watchStatus', { expectedUserKey: actor, followId: follow.followId, status: 'removed', expectedUpdatedAt: follow.updatedAt });
  assert.equal(staleRemoval.error.code, 'watch_changed');

  ok(await f.call('market.watch', { ...payload, storeNumbers: [second] }));
  const { follow: paused } = ok(await f.call('market.watchStatus', { expectedUserKey: actor, followId: follow.followId, status: 'paused' }));
  f.advance(2 * 86400000);
  assert.equal((await edit({ language: 'zh-CN', expectedUpdatedAt: paused.updatedAt })).error.code, 'market_watch_plan_required');
  const reduced = ok(await edit({ removeStore: first, expectedUpdatedAt: paused.updatedAt })).follow;
  assert.deepEqual([reduced.storeNumbers, reduced.language, reduced.savedStatus], [[second], 'en', 'paused']);
  assert.equal(ok(await f.call('market.follows')).savedCount, 1);
});
