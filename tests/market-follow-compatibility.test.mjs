import test from 'node:test';
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
  await f.repo.updateUser(actor, { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
  return f;
}

test('only verified market targets can be watched, under the signed-in account and current plan', async () => {
  const f = createFixture();
  assert.equal((await f.call('market.watch', target('JP'))).error.code, 'market_monitoring_disabled');
  await f.repo.saveConfig({ ...await f.repo.getConfig(), internationalMarkets: enabled });
  assert.equal((await f.call('market.watch', target('JP'))).error.code, 'member_required');
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
  assert.equal((await f.call('market.watch', { ...payload, storeNumbers: [jp.stores[3].storeNumber] })).error.code, 'too_many_stores');
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
  assert.equal((await f.call('market.watchStatus', { ...status, status: 'active' })).error.code, 'market_monitoring_disabled');
  await f.repo.updateUser(actor, { membership: { expiresAt: '2020-01-01T00:00:00Z' } });
  for (let i = 0; i < 2; i++) assert.equal(ok(await f.call('market.watchStatus', { ...status, status: 'removed' })).follow.status, 'removed');
  assert.equal(ok(await f.call('market.follows')).savedCount, 0);
});

test('domestic and market saves share one transactional slot limit while each interface returns only its regions', async () => {
  const f = await memberFixture();
  const cn = { followId: 'domestic-001', partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
  const { follow } = ok(await f.call('follow.upsert', cn));
  ok(await f.call('market.watch', target('JP')));
  const last = await Promise.all([f.call('market.watch', target('HK')), f.call('market.watch', target('TW'))]);
  assert.equal(last.filter(res => res.ok).length, 1);
  assert.equal(last.find(res => !res.ok).error.code, 'too_many_follows');
  const { follows, otherMarketCount } = ok(await f.call('follow.list'));
  assert.equal(follows.length, 1);
  assert.equal(follows[0].followId, follow.followId);
  assert.equal(otherMarketCount, 2);
  assert.equal(ok(await f.call('market.follows')).follows.length, 2);
  const boot = ok(await f.call('user.bootstrap'));
  assert.equal(boot.followCount, 1);
  assert.equal(boot.otherMarketFollowCount, 2);
  assert.equal((await f.call('market.watchStatus', { expectedUserKey: actor, followId: follow.followId, status: 'removed' })).error.code, 'unknown_follow');
  assert.equal((await f.call('follow.upsert', { ...cn, partNumber: 'MYYY2CH/A', followId: 'domestic-002' })).error.code, 'too_many_follows');
  const sameSku = { market: 'TW', partNumber: 'X', storeNumbers: ['R001'] };
  assert.equal(validateFollowLimits([{ ...sameSku, market: 'HK' }], sameSku).ok, true);
  assert.equal(validateFollowLimits([sameSku], sameSku).reason, 'duplicate_part_number');
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
