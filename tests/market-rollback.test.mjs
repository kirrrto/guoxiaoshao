import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createFixture, userContext, userKeyOf } from './helpers/fixture.mjs';
import { marketMembership } from './helpers/market-membership.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const { findMarket } = createRequire(import.meta.url)('../cloudfunctions/gxs_api/lib/markets.js');
const rollbackTree = process.env.GXS_ROLLBACK_TREE;
const rollbackFixture = rollbackTree
  ? (await import(pathToFileURL(path.join(rollbackTree, 'tests/helpers/fixture.mjs')))).createFixture
  : createFixture;
const flags = ['internationalMarkets', 'internationalMonitoring', 'internationalNotifications'];
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const owner = userKeyOf();

test('closing US with one revision preserves other settings and allows a later unrelated admin save', async () => {
  const maps = Object.fromEntries(flags.map((key, i) => [key, { JP: false, TW: i === 1, HK: i !== 1, US: i !== 2 }]));
  const before = createFixture({ config: { ...maps, configRevision: 6, adminUserKeys: [owner], privateExtension: { keep: 23 }, announcement: 'A' } });
  const { revision } = ok(await before.call('admin.getConfig'));
  const patch = Object.fromEntries(flags.map(key => [key, { US: false }]));
  ok(await before.call('admin.updateConfig', { patch: { announcement: 'B' }, expectedRevision: revision }));
  assert.equal((await before.call('admin.updateConfig', { patch, expectedRevision: revision })).error.code, 'config_revision_conflict');
  assert.equal((await before.repo.getConfig()).internationalMarkets.US, true);
  const fresh = ok(await before.call('admin.getConfig'));
  ok(await before.call('admin.updateConfig', { patch, expectedRevision: fresh.revision }));
  const closed = ok(await before.call('admin.getConfig'));
  assert.equal(closed.revision, fresh.revision + 1);
  for (const key of flags) assert.deepEqual(closed.config[key], { ...maps[key], US: false });
  const raw = await before.repo.getConfig();
  for (const key of flags) {
    const { US, ...threeMarkets } = maps[key];
    assert.deepEqual(raw[key], threeMarkets);
  }
  assert.deepEqual([raw.announcement, raw.privateExtension, raw.adminUserKeys], ['B', { keep: 23 }, [owner]]);
  const old = rollbackFixture();
  await old.repo.saveConfig(raw);
  const legacy = ok(await old.call('admin.getConfig'));
  if (rollbackTree) for (const key of flags) assert.deepEqual(legacy.config[key], raw[key]);
  ok(await old.call('admin.updateConfig', { patch: { announcement: 'C' }, expectedRevision: legacy.revision }));
  const saved = ok(await old.call('admin.getConfig'));
  assert.deepEqual([saved.config.announcement, saved.revision], ['C', legacy.revision + 1]);
  const after = await old.repo.getConfig();
  for (const key of [...flags, 'privateExtension', 'adminUserKeys', 'collector', 'query']) assert.deepEqual(after[key], raw[key]);
});

test('the compatibility API can complete an interrupted 3.9.0 rollback with US:false still present', async () => {
  const maps = Object.fromEntries(flags.map(key => [key, { JP: true, TW: false, HK: true, US: false }]));
  const f = rollbackFixture({ config: { ...maps, configRevision: 11, adminUserKeys: [owner], announcement: 'keep' } });
  const initial = ok(await f.call('admin.getConfig'));
  const patch = Object.fromEntries(flags.map(key => [key, { US: false }]));
  ok(await f.call('admin.updateConfig', { patch, expectedRevision: initial.revision }));
  const current = ok(await f.call('admin.getConfig'));
  assert.equal(current.config.announcement, 'keep');
  for (const key of flags) assert.deepEqual((await f.repo.getConfig())[key], { JP: true, TW: false, HK: true });
  ok(await f.call('admin.updateConfig', { patch: { query: { maxStores: 2 } }, expectedRevision: current.revision }));
  assert.equal(ok(await f.call('admin.getConfig')).config.query.maxStores, 2);
});

const tap = dataset => ({ currentTarget: { dataset } });

function checkWithdrawnRow(page, id, status, stores) {
  const row = page.data.watchRows.find(r => r.id === id);
  assert.equal(row.status, status);
  assert.deepEqual([row.withdrawn, row.selected, row.canResume, row.editing], [true, false, false, false]);
  assert.deepEqual([row.stores, row.pauseTo, row.selectedStores, row.additionalStores, row.language],
    [stores.join(' · '), undefined, undefined, undefined, undefined]);
}

test('a catalog withdrawal keeps a saved watch visible to its owner and cancellation releases its slot', async t => {
  // The release rehearsal uses the actual three-market API and client. A
  // shallow checkout exercises the same withdrawal with an unlisted code.
  const f = createFixture();
  ok(await f.call('user.bootstrap'));
  await f.repo.updateUser(owner, { membership: marketMembership(f.state.now, 'member_30d') });
  const us = findMarket('US'), jp = findMarket('JP');
  const original = ok(await f.call('market.watch', { expectedUserKey: owner, market: 'US',
    partNumber: us.products[0].partNumber, storeNumbers: us.stores.slice(0, 2).map(store => store.storeNumber), language: 'en' })).follow;
  const code = rollbackTree ? 'US' : 'CA';
  const id = original.followId.replace('|market:US:', '|market:' + code + ':');
  const saved = { ...await f.repo.getFollow(original.followId), _id: id, market: code };
  const user = await f.repo.getUser(owner);
  const old = rollbackFixture();
  await old.repo.createUser({ ...user, followIndex: user.followIndex.map(row => ({ ...row, _id: id, market: code })) });
  await old.repo.saveFollow(saved);
  const list = () => old.call('market.follows', { expectedUserKey: owner }).then(ok);
  assert.equal((await list()).follows[0].followId, id);
  const state = { expectedUserKey: owner, followId: id };
  const foreign = await old.call('market.watchStatus', { ...state, expectedUserKey: userKeyOf('b'), status: 'removed' }, userContext('b'));
  assert.equal(foreign.error.code, 'unknown_follow');
  const jpWatch = i => ({ expectedUserKey: owner, market: 'JP', partNumber: jp.products[i].partNumber, storeNumbers: [jp.stores[0].storeNumber] });
  for (let i = 0; i < 3; i++) ok(await old.call('market.watch', jpWatch(i)));
  assert.equal((await old.call('market.watch', jpWatch(3))).error.code, 'too_many_follows');
  const rt = runtime((a, p) => old.call(a, p).then(ok), rollbackTree ? { root: path.join(rollbackTree, 'miniprogram') } : {});
  const page = rt.instance('pages/markets/index.js');
  page.onLoad();
  await page.onShow();
  assert.ok(!page.data.sites.some(s => s.code === code));
  const row = page.data.watchRows.find(r => r.id === id);
  assert.deepEqual([row.name, row.product, row.stores, row.canResume], [code, saved.partNumber, saved.storeNumbers.join(' · '), false]);
  if (rollbackTree) await t.test('the generated three-market page keeps the retired US watch inert while JP remains selectable and editable', async () => {
    assert.deepEqual(Array.from(page.data.sites, site => site.code), ['JP', 'TW', 'HK']);
    checkWithdrawnRow(page, id, '站点已停用，已停止监测', saved.storeNumbers);
    const jpRow = page.data.watchRows.find(r => r.market === 'JP');
    let scrolls = 0;
    rt.wx.pageScrollTo = () => { scrolls++; };
    page.onSelectWatch(tap({ id: jpRow.id }));
    assert.equal(page.data.targetWatch.id, jpRow.id);
    assert.equal(scrolls, 1);
    page.onManageWatch(tap({ id: jpRow.id }));
    assert.equal(page.data.watchRows.find(r => r.id === jpRow.id).editing, true);
    const calls = rt.calls.length, messages = rt.messages.length, target = page.targetKey();
    page.onSelectWatch(tap({ id }));
    page.onManageWatch(tap({ id }));
    for (const field of ['language', 'add', 'remove']) {
      await page.onEditWatch({ ...tap({ id, field, store: saved.storeNumbers[0] }), detail: { value: 1 } });
    }
    for (const status of ['paused', 'active']) await page.onWatchStatus(tap({ id, status }));
    assert.deepEqual([page.targetKey(), page.data.targetWatch.id, page.editingWatch, scrolls, rt.calls.length, rt.messages.length],
      [target, jpRow.id, jpRow.id, 1, calls, messages]);
    rt.load('utils/language.js').setLanguage('en');
    checkWithdrawnRow(page, id, 'Region discontinued. Monitoring has stopped.', saved.storeNumbers);
    const wxml = readFileSync(path.join(rollbackTree, 'miniprogram/pages/markets/index.wxml'), 'utf8');
    assert.match(wxml, /<view wx:if="{{item.withdrawn}}" class="market-watch-copy">\s*<text[^>]*>{{item.product}}<\/text><text[^>]*>{{item.name}} · {{item.stores}}<\/text>\s*<\/view>\s*<button wx:else[^>]*bindtap="onSelectWatch"/);
    assert.match(wxml, /{{item.status}}<\/text>\s*<view class="market-watch-actions">\s*<button wx:if="{{item.withdrawn}}"[^>]*data-status="removed" bindtap="onWatchStatus">{{w.removeWatch}}<\/button>\s*<block wx:else>/);
    assert.match(wxml, /<view wx:if="{{item.editing}}" class="market-watch-editor">/);
  });
  // An expired membership and a later pause must not mask the discontinued status.
  await old.repo.updateUser(owner, { membership: { expiresAt: '2020-01-01T00:00:00.000Z' } });
  await page.refresh(true);
  if (rollbackTree) {
    assert.equal(page.watchList.follows.find(r => r.followId === id).status, 'expired');
    checkWithdrawnRow(page, id, 'Region discontinued. Monitoring has stopped.', saved.storeNumbers);
  }
  const paused = ok(await old.call('market.watchStatus', { ...state, status: 'paused' })).follow;
  assert.equal((await old.call('market.watchStatus', { ...state, status: 'active' })).error.code, 'unknown_follow');
  assert.equal((await old.call('market.watchStatus', { ...state, status: 'removed', expectedUpdatedAt: original.updatedAt })).error.code, 'watch_changed');
  await page.loadWatches();
  if (rollbackTree) checkWithdrawnRow(page, id, 'Region discontinued. Monitoring has stopped.', saved.storeNumbers);
  page.onWatchStatus(tap({ id, status: 'removed' }));
  await rt.messages.at(-1).success({ confirm: true });
  assert.equal(page.data.watchRows.some(r => r.id === id), false);
  assert.deepEqual(rt.calls.find(c => c.action === 'market.watchStatus').payload,
    { followId: id, status: 'removed', expectedUpdatedAt: paused.updatedAt, expectedUserKey: owner });
  assert.equal((await list()).savedCount, 3);
  assert.equal((await old.repo.getUser(owner)).followIndex.some(r => r._id === id), false);
  assert.equal((await old.repo.getFollow(id)).status, 'removed');
  await old.repo.updateUser(owner, { membership: marketMembership(f.state.now, 'member_30d') });
  ok(await old.call('market.watch', jpWatch(3)));
  assert.equal((await list()).savedCount, 4);
  assert.equal(old.state.fetchImpl.calls.length, 0);
});
