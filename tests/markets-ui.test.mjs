import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, userKeyOf } from './helpers/fixture.mjs';
import { marketMembership } from './helpers/market-membership.mjs';
const require = createRequire(import.meta.url);
const { MARKETS } = require('../cloudfunctions/gxs_api/lib/markets');
const { localTime } = require('../miniprogram/pages/markets/presentation');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tap = dataset => ({ currentTarget: { dataset } });
async function setup(extra = {}, options = {}, seed = {}) {
  const state = { owner: 'Alice', member: true, rows: [], enabled: true, ...seed };
  const handlers = {
    'user.bootstrap': () => ({ identity: { userKey: state.owner }, membership: { active: state.member, planId: state.planId || 'member_30d' }, quota: { balance: state.balance ?? 3, queryCost: 1, revision: 1 },
      notifications: { enabled: true, senderReady: true, templateIds: { restock: 'chinese' } }, subscriptions: {}, settings: {} }),
    'market.catalog': () => ({ markets: MARKETS.map(m => ({ ...m, enabled: state.enabled, monitorEnabled: state.enabled,
      notificationsEnabled: state.enabled, notificationsEnabledEn: false })) }),
    'market.follows': () => ({ follows: state.rows, watchRegistrationOpen: true, monitoring: { JP: true, TW: true, HK: true }, notifications: { JP: true, TW: true, HK: true } }),
    'market.pickup': p => receipt(p),
    ...extra,
  };
  const rt = runtime((action, payload) => { assert.ok(handlers[action], action); return handlers[action](payload, state); });
  const page = rt.instance('pages/markets/index.js');
  page.onLoad(options);
  await page.onShow();
  return { rt, page, state, handlers };
}
function receipt(p, overrides = {}) {
  return { ok: true, market: p.market, queryId: p.queryId, charged: 0, refunded: 0, balance: 3, quotaRevision: 1,
    results: [{ market: p.market, partNumber: p.partNumber, storeNumber: p.storeNumbers[0], status: 'available', observedAt: new Date().toISOString() }], ...overrides };
}

test('regional page loads directory on demand and maps model/finish/storage/store to exact local SKU', async () => {
  const { page, rt } = await setup();
  assert.deepEqual(Array.from(page.data.sites, s => s.code), ['JP','TW','HK']);
  assert.ok(page.data.models.includes('iPhone 18 Pro') && page.data.models.includes('iPhone 18 Pro Max'));
  assert.equal(rt.calls.find(call => call.action === 'market.catalog').payload.format, 'compact-v1');
  page.onMarket(tap({ market: 'TW' }));
  page.onChoice({ ...tap({ field: 'model' }), detail: { value: page.data.models.indexOf('iPhone 18 Pro Max') } });
  page.onChoice({ ...tap({ field: 'color' }), detail: { value: '2' } });
  const chosen = page.data.capacities.at(-1);
  page.onCapacity(tap({ id: chosen.id }));
  page.onChoice({ ...tap({ field: 'store' }), detail: { value: '1' } });
  const { model, capacity, color } = page.data.product;
  assert.ok(MARKETS[1].products.some(p => p.partNumber === chosen.id && p.model === model && p.color === color && p.capacity === capacity));
  assert.equal(rt.calls.filter(c => c.action === 'market.pickup').length, 0);
  await page.onQuery();
  const call = rt.calls.find(c => c.action === 'market.pickup');
  assert.equal(call.payload.partNumber, chosen.id);
  assert.equal(call.payload.market, 'TW');
  assert.equal(call.payload.storeNumbers[0], MARKETS[1].stores[1].storeNumber);
  assert.equal(call.payload.expectedUserKey, 'Alice'); assert.equal(call.payload.maxCost, 0);
  assert.equal(page.data.receipt.status, '可自提');
  rt.load('utils/language.js').setLanguage('en'); assert.equal(page.data.receipt.status, 'Available for pickup');
  assert.equal(rt.storage.get('gxs_markets_region_v1'), 'TW');
  assert.equal(rt.storage.get('gxs_ui_language_v1'), 'en');
});

test('changing region and returning while waiting suppresses older receipts; does not spend twice', async () => {
  const q = deferred(), { page, rt } = await setup({ 'market.pickup': async p => { await q.promise; return receipt(p); } });
  const call = page.onQuery(); await page.onQuery();
  page.onMarket(tap({ market: 'HK' })); page.onMarket(tap({ market: 'JP' }));
  q.resolve(); await call;
  assert.equal(page.data.receipt, null);
  assert.equal(rt.calls.filter(c => c.action === 'market.pickup').length, 1);
});
test('the editor, receipt and saved watch share exact local artwork; a late image failure stays with that finish', async () => {
  const { page, rt } = await setup({
    'market.watch': (p,s) => { const follow = { ...p, followId: 'image-watch', status: 'active' }; s.rows.push(follow); return { follow }; },
  });
  function selectModelFinish(model, finish) {
    page.onChoice({ ...tap({field:'model'}), detail:{value:page.data.models.indexOf(model)} });
    page.onChoice({ ...tap({field:'color'}), detail:{value:page.data.colors.findIndex(row=>row.id===finish)} });
  }
  selectModelFinish('iPhone 18 Pro','黑色');
  const { imageDisplayUrl: black } = page.data.product;
  assert.match(black, /^\/images\/products\/.+-card\.png$/);
  await page.onWatch(); assert.equal(page.data.watchRows[0].imageDisplayUrl, black);
  page.onCapacity(tap({ id: page.data.capacities[1].id }));
  assert.equal(page.data.product.imageDisplayUrl, black);
  selectModelFinish('iPhone 18 Pro','银色');
  const otherFinish = page.data.product.imageDisplayUrl;
  assert.ok(otherFinish && otherFinish !== black);
  page.onProductImageError(tap({ src: black }));
  assert.equal(page.data.product.imageDisplayUrl, otherFinish);
  assert.equal(page.data.watchRows[0].imageDisplayUrl, '');
  rt.load('utils/language.js').setLanguage('en'); page.onMarket(tap({ market: 'TW' })); selectModelFinish('iPhone 18 Pro','黑色');
  assert.equal(page.data.product.imageDisplayUrl, '');
  assert.ok(page.data.product.label && page.data.canQuery);
  assert.equal(rt.calls.filter(c => c.action === 'market.pickup').length, 0);
  await page.onQuery(); assert.equal(page.data.receipt.status, 'Available for pickup');
  selectModelFinish('iPhone 18 Pro Max','黑色');
  assert.ok(page.data.product.imageDisplayUrl && page.data.product.imageDisplayUrl !== black);
});
test('uncertain request retains its ID across markets and can settle after rollout closes', async () => {
  let first = true;
  const { page, rt, state } = await setup({ 'market.pickup': p => {
    if (first) { first = false; throw Object.assign(Error(), { code: 'call_failed' }); }
    return receipt(p, { charged: 1, refunded: 1, replayed: true });
  } });
  await page.onQuery();
  assert.equal(page.data.queryLabel, '核对上次查询');
  page.onMarket(tap({ market: 'TW' })); page.onMarket(tap({ market: 'JP' }));
  state.enabled = false; await page.onPullDownRefresh();
  assert.equal(page.data.enabled, false); assert.ok(page.data.canQuery);
  await page.onQuery();
  const attempts = rt.calls.filter(c => c.action === 'market.pickup');
  assert.equal(attempts[0].payload.queryId, attempts[1].payload.queryId);
  assert.equal(page.data.billingText, '本次未扣次');
  assert.equal(page.data.receipt.previous, true);
  assert.equal(page.data.canQuery, false);
});
test('unknown, old and invalid observations never become a fresh availability claim', async () => {
  let sequence = 0;
  const { page } = await setup({ 'market.pickup': p => {
    const result = receipt(p); sequence++;
    if (sequence === 1) result.results[0].observedAt = new Date(Date.now() - 600000).toISOString();
    if (sequence === 2) { result.ok = false; result.reason = 'upstream_unavailable'; result.results[0].status = 'unknown'; }
    if (sequence === 3) result.results[0].market = 'TW';
    if (sequence === 4) result.results[0].observedAt = new Date(Date.now() + 600000).toISOString();
    return result;
  } });
  for (let i = 1; i <= 4; i++) { await page.onQuery(); assert.equal(page.data.receipt.previous, true); if (i > 1) assert.ok(page.data.queryError); }
  assert.equal(localTime('2026-11-23T15:10:00Z', 'Asia/Tokyo'), '2026-11-24 00:10:00 UTC+9');
  assert.equal(localTime('2026-11-23T15:10:00Z', 'Asia/Taipei'), '2026-11-23 23:10:00 UTC+8');
});
test('member can watch before querying and independently pause, resume or remove with confirmation', async () => {
  const { page, rt } = await setup({
    'market.watch': (p,s) => { const follow = { ...p, followId: 'f1', status:'active', savedStatus:'active' }; s.rows.push(follow); return {follow}; },
    'market.watchStatus': (p,s) => { const f = s.rows[0]; f.savedStatus = f.status = p.status; return {follow:f}; },
  });
  rt.load('utils/language.js').setLanguage('en'); await page.onWatch();
  assert.equal(page.data.watchRows.length,1); assert.equal(page.data.targetLanguage,'English');
  assert.equal(page.data.watchService,'English WeChat alerts are not yet available.');
  assert.equal(page.data.alertTemplate,'');
  await page.onWatchStatus(tap({ id:'f1', status:'paused' })); assert.equal(page.data.watchRows[0].status, 'Paused');
  await page.onWatchStatus(tap({ id:'f1', status:'active' })); assert.equal(page.data.watchRows[0].status, 'Watch enabled');
  page.onWatchStatus(tap({ id:'f1', status:'removed' }));
  assert.equal(rt.messages.at(-1).title,'Remove this watch?');
  rt.messages.at(-1).success({confirm:false}); assert.equal(page.data.watchRows.length,1);
  assert.equal(rt.calls.filter(c => c.action==='market.pickup').length,0);
});
test('an older API without account-level permissions cannot enable new checks in a closed region', async () => {
  const { page, rt, state } = await setup({}, {}, {enabled:false});
  assert.equal(page.data.canQuery,false); await page.onQuery(); assert.equal(rt.calls.filter(c => c.action === 'market.pickup').length,0);
  state.enabled = true; await page.onPullDownRefresh(); await page.onQuery();
  assert.ok(page.data.receipt);
  page.onHide(); state.owner='Bob'; rt.load('utils/store.js').resetSession(); await page.onShow();
  assert.equal(page.data.receipt,null); assert.equal(page.owner,'Bob');
});

test('a private Taiwan preview stays scoped to the verified tester account', async () => {
  const { page, rt, state } = await setup({
    'user.bootstrap': (_, s) => ({
      identity: { userKey: s.owner }, membership: { active: true, isTester: s.owner === 'Alice' },
      ...(s.owner === 'Alice' ? { regionalQueryPreview: ['JP', 'TW', 'HK'] } : {}),
      quota: { balance: 0, revision: 1 }, notifications: {}, subscriptions: {}, settings: {},
    }),
  }, { market: 'TW', partNumber: 'MJY04ZP/A', storeNumber: 'R694' }, { enabled: false });
  assert.equal(page.data.enabled, true);
  assert.equal(page.data.canQuery, true);
  assert.equal(page.data.watchEnabled, true);
  assert.equal(page.data.alertTemplate, '');
  await page.onQuery();
  const { market, partNumber, storeNumbers, maxCost } = rt.calls.find(x => x.action === 'market.pickup').payload;
  assert.deepEqual([market, partNumber, ...storeNumbers, maxCost], ['TW', 'MJY04ZP/A', 'R694', 0]);
  assert.ok(page.data.receipt);
  page.onHide(); state.owner = 'Bob'; rt.load('utils/store.js').resetSession(); await page.onShow();
  assert.equal(page.data.receipt, null);
  assert.equal(page.data.enabled, false);
  assert.equal(page.data.watchEnabled, false);
  await page.onQuery();
  assert.equal(rt.calls.filter(x => x.action === 'market.pickup').length, 1);
});
test('monthly and annual customers manually check all three regions through the page while public checks and monitoring are closed', async () => {
  for (const planId of ['member_30d', 'member_365d']) {
    const expiry = new Date(Date.now() + 86400000).toISOString();
    const { page, rt } = await setup({ 'user.bootstrap': () => ({
      identity: { userKey: 'Alice' }, serverTime: new Date().toISOString(),
      membership: { active: true, planId, expiresAt: expiry, enhancedExpiresAt: expiry, annualExpiresAt: planId === 'member_365d' ? expiry : null },
      regionalMemberQueryMarkets: ['JP', 'TW', 'HK'], quota: { balance: 0, revision: 1 }, notifications: {}, subscriptions: {},
    }) }, {}, { enabled: false });
    const calls = () => rt.calls.filter(row => row.action === 'market.pickup');
    for (const [index, site] of MARKETS.entries()) {
      page.onMarket(tap({ market: site.code }));
      assert.equal(calls().length, index);
      assert.equal(page.data.enabled, true);
      assert.equal(page.data.canQuery, true);
      assert.equal(page.data.costText, '会员查询不扣次');
      assert.equal(page.data.watchEnabled, true);
      assert.equal(page.data.alertTemplate, '');
      await page.onQuery();
      assert.equal(calls().length, index + 1);
      assert.deepEqual(calls().at(-1).payload.storeNumbers, [page.data.store.id]);
      assert.equal(calls().at(-1).payload.market, site.code);
      assert.equal(calls().at(-1).payload.maxCost, 0);
      assert.equal(page.data.receipt.status, '可自提');
    }
    assert.equal(rt.calls.some(row => ['market.watch', 'notify.recordSubscription', 'quota.signin'].includes(row.action)), false);
    page.onUnload();
  }
});

test('a slow bootstrap cannot hide a charged regional receipt or its notification', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-01-20T00:00:00Z') });
  const site = MARKETS[1], product = site.products[0], store = site.stores[0];
  let offset = 0;
  const observedAt = () => new Date(Date.now() + offset).toISOString();
  const { page, rt } = await setup({
    'user.bootstrap': () => {
      const serverTime = new Date().toISOString();
      t.mock.timers.tick(7000);
      return { identity: { userKey: 'Alice' }, serverTime, membership: { active: false },
        quota: { balance: 1, revision: 1 }, notifications: {}, subscriptions: {} };
    },
    'market.pickup': p => receipt(p, { charged: 1, balance: 0, quotaRevision: 2, results: [{
      market: p.market, partNumber: p.partNumber, storeNumber: p.storeNumbers[0], status: 'available', observedAt: observedAt(),
    }] }),
    'notify.detail': () => ({ notification: { market: site.code, storeNumber: store.storeNumber, partNumber: product.partNumber,
      detectedAt: observedAt(), eventId: 'alert1' } }),
    'notify.open': () => ({}),
  }, { eid: 'alert1', market: site.code, partNumber: product.partNumber, storeNumber: store.storeNumber });
  const openedAlert = Boolean(page.data.alertTime);
  await page.onQuery();
  assert.deepEqual({ openedAlert, status: page.data.receipt?.status, balance: rt.app.globalData.bootstrap.quota.balance },
    { openedAlert: true, status: '可自提', balance: 0 });
  assert.equal(page.data.receipt.previous, false);
  assert.equal(rt.calls.filter(call => call.action === 'market.pickup').length, 1);
  offset = 600000;
  await page.openAlert('alert1');
  assert.equal(page.data.alertMissing, true);
  page.onUnload();
});

test('a paid grant is scoped to its regions, account and server-time expiry, including an uncertain in-flight result', async t => {
  const now = Date.parse('2027-01-02T00:00:00Z'), serverNow = now + 3600000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const expires = new Date(serverNow + 500).toISOString(), gate = deferred();
  const { page, rt, state } = await setup({
    'user.bootstrap': (_, s) => ({
      identity: { userKey: s.owner }, serverTime: new Date(serverNow + Date.now() - now).toISOString(),
      membership: { active: true, planId: s.planId, expiresAt: new Date(serverNow + 86400000).toISOString(), enhancedExpiresAt: expires },
      regionalMemberQueryMarkets: ['TW'], quota: { balance: 0 }, notifications: {}, subscriptions: {},
    }),
    'market.pickup': async p => { await gate.promise; return receipt(p); },
  }, {}, { planId: 'member_30d', enabled: false });
  assert.equal(page.data.canQuery, false);
  page.onMarket(tap({ market: 'TW' }));
  assert.equal(page.data.canQuery, true);
  const running = page.onQuery();
  t.mock.timers.tick(500); gate.resolve(); await running;
  assert.equal(page.data.enabled, false);
  assert.equal(page.data.receipt, null);
  await page.onQuery();
  assert.equal(rt.calls.filter(row => row.action === 'market.pickup').length, 1);
  rt.load('utils/store.js').resetSession(); page.paint();
  assert.equal(page.data.accountReady, false);
  page.onHide(); state.owner = 'Bob'; state.planId = 'member_7d'; await page.onShow();
  assert.equal(page.data.enabled, false);
  assert.equal(page.data.receipt, null);
  page.onUnload();
});
test('notification destination uses only authorized exact detail and never queries or debits on open', async () => {
  const n = { market:'TW', partNumber: MARKETS[1].products[5].partNumber, storeNumber:'R713', eventId:'alert1', detectedAt:new Date().toISOString() };
  let cleared = false;
  const { page, rt } = await setup({ 'notify.detail': () => { if (cleared) throw Error('expired'); return { notification:n }; }, 'notify.open':()=>({}) },
    {market:'JP',partNumber:MARKETS[0].products[0].partNumber,storeNumber:'R128',eid:'alert1'});
  assert.equal(page.market,'TW'); assert.equal(page.part, n.partNumber); assert.equal(page.data.store.id,'R713');
  assert.ok(page.data.alertTime); assert.equal(page.data.receipt,null);
  page.onHide(); cleared = true; await page.onShow(); assert.ok(page.data.alertMissing); assert.equal(page.data.alertTime,'');
  assert.equal(rt.calls.filter(c => c.action === 'market.pickup').length,0);
});

test('English watches request only English when that template and sender are ready', async () => {
  const { page, state, handlers, rt } = await setup({
    'notify.recordSubscription': p => ({ accepted:Object.keys(p.results).filter(id=>p.results[id]==='accept'), subscriptions:{enId:{credits:1}} }),
  });
  const baseCatalog=handlers['market.catalog'], baseBoot=handlers['user.bootstrap'];
  handlers['market.catalog'] = () => ({markets:baseCatalog().markets.map(m=>({...m,notificationsEnabledEn:true}))});
  handlers['user.bootstrap'] = () => {
    const boot=baseBoot();
    boot.notifications.templateIds.restockEn='enId';
    boot.subscriptions={enId:{credits:2},chinese:{credits:33}};
    return boot;
  };
  state.rows=[{followId:'watch-en',market:'JP',partNumber:page.part,storeNumbers:[page.store],language:'en',status:'active'}];
  await page.onPullDownRefresh(); assert.equal(page.data.alertTemplate,'enId'); assert.match(page.data.creditText,/2$/);
  const requests=[];
  rt.wx.requestSubscribeMessage = ({tmplIds, success}) => {requests.push(Array.from(tmplIds));success({[tmplIds[0]]:'accept'});};
  await page.onAuthorize();
  assert.deepEqual(requests,[['enId']]);
  assert.equal(page.data.watchMessage,'微信授权已记录');
  assert.deepEqual(Object.keys(rt.calls.find(c=>c.action==='notify.recordSubscription').payload.results),['enId']);
});

test('market flags and membership are independent: browse a closed market and watch before a standalone query', async () => {
  const { page, state, handlers, rt }=await setup();
  const base=handlers['market.catalog'];
  handlers['market.catalog']=()=>({markets:base().markets.map(m=>({...m,enabled:false,monitorEnabled:true}))});
  await page.onPullDownRefresh();
  assert.equal(page.data.enabled,false);
  assert.equal(page.data.watchEnabled,true);
  state.member=false;await page.onPullDownRefresh();
  assert.equal(page.data.watchEnabled,false); assert.equal(page.data.membershipLink,true);
  await page.onWatch();assert.equal(rt.calls.filter(c=>c.action==='market.watch').length,0);
});

test('monthly and annual members can save, pause, and resume across three closed sites without a pickup or alert request', async () => {
  for (const planId of ['member_30d', 'member_365d']) {
    const { page, rt } = await setup({
      'market.watch': (p, s) => {
        const follow = { ...p, followId: p.market, status: 'active', savedStatus: 'active' };
        s.rows.push(follow);
        return { follow };
      },
      'market.watchStatus': (p, s) => {
        const follow = s.rows.find(row => row.followId === p.followId);
        follow.status = follow.savedStatus = p.status;
        return { follow };
      },
    }, {}, { planId, enabled: false });
    for (const site of MARKETS) {
      page.onMarket(tap({ market: site.code }));
      assert.equal(page.data.canQuery, false);
      assert.equal(page.data.watchEnabled, true);
      assert.equal(page.data.watchService, '可先保存关注，本站尚未开启自动监测。');
      await page.onWatch();
      assert.equal(page.data.targetWatch.status, '已保存关注，本站尚未开启自动监测');
      assert.equal(page.data.watchEnabled, false);
      await page.onAuthorize();
      assert.equal(page.data.alertTemplate, '');
      await page.onWatchStatus(tap({ id: site.code, status: 'paused' }));
      assert.equal(page.data.targetWatch.status, '已暂停');
      await page.onWatchStatus(tap({ id: site.code, status: 'active' }));
      assert.equal(page.data.targetWatch.status, '已保存关注，本站尚未开启自动监测');
    }
    assert.equal(rt.calls.filter(c => c.action === 'market.watch').length, 3);
    assert.equal(rt.calls.filter(c => c.action === 'market.pickup' || c.action === 'notify.recordSubscription').length, 0);
    rt.load('utils/language.js').setLanguage('en'); assert.equal(page.data.targetWatch.status, 'Watch saved. Monitoring is not active in this region.');
  }
});

test('closed regions disclose the monitoring limit before purchase and keep legacy API saves gated', async () => {
  const { page, state, rt, handlers } = await setup({}, {}, { enabled: false, planId: 'member_7d' });
  assert.equal(page.data.membershipLink, true);
  assert.equal(page.data.watchEnabled, false);
  assert.equal(page.data.watchService, '月卡、年卡可先保存关注。本站尚未开启自动监测。');
  await page.onWatch();
  assert.equal(rt.calls.some(call => call.action === 'market.watch'), false);
  state.planId = 'member_365d';
  handlers['market.follows'] = () => ({ follows: [] });
  await page.onPullDownRefresh();
  assert.equal(page.data.watchEnabled, false);
  await page.onWatch(); assert.equal(rt.calls.some(call => call.action === 'market.watch'), false);
  state.enabled = true; await page.onPullDownRefresh(); assert.ok(page.data.watchEnabled);
});

test('a failed watch read offers a retry and a lost save response is reconciled from the exact saved watch', async () => {
  let offline = true;
  const { page, rt } = await setup({
    'market.follows': (_, s) => {
      if (offline) throw Error('offline');
      return { follows: s.rows, watchRegistrationOpen: true };
    },
    'market.watch': (p, s) => {
      s.rows.push({ ...p, followId: 'saved-tw', status: 'active' });
      throw Error('response lost');
    },
  }, { market: 'TW' }, { enabled: false });
  assert.equal(page.data.watchLoaded, false);
  assert.equal(page.data.watchEnabled, false);
  assert.equal(page.data.watchError, '暂时无法读取关注，请刷新重试。');
  offline = false;
  await page.loadWatches();
  assert.equal(page.data.watchEnabled, true);
  await page.onWatch();
  assert.equal(page.data.targetWatch.id, 'saved-tw');
  assert.equal(page.data.watchService, '已保存关注，本站尚未开启自动监测');
  assert.equal(page.data.watchMessage, '');
  await page.onWatch();
  assert.equal(rt.calls.filter(c => c.action === 'market.watch').length, 1);
});

test('the membership card reads committed slots when switching away during a regional save or removal, including a lost reply', async () => {
  const cloud = createFixture({ start: new Date().toISOString() });
  await cloud.call('user.bootstrap');
  await cloud.repo.updateUser(userKeyOf(), { membership: marketMembership(cloud.state.now, 'member_30d') });
  let hold, loseReply = false;
  const rt = runtime(async (action, payload) => {
    if (hold && ['market.watch', 'market.watchStatus'].includes(action)) await hold.promise;
    const result = await cloud.call(action, payload);
    assert.ok(result.ok, JSON.stringify(result.error));
    if (loseReply && action === 'market.watch') throw Object.assign(Error('response lost'), { code: 'call_failed' });
    return result.data;
  });
  const page = rt.instance('pages/markets/index.js');
  page.onLoad(); await page.onShow();
  const mine = rt.instance('pages/mine/index.js'); await mine.onLoad(); mine.onHide();
  assert.equal(mine.data.boot.followCount, 0);
  const reads = () => rt.calls.filter(row => row.action === 'user.bootstrap').length;
  const before = reads();
  hold = deferred(); loseReply = true;
  const saving = page.onWatch(); page.onHide();
  const entering = mine.onShow();
  hold.resolve(); await Promise.all([saving, entering]);
  assert.equal(mine.data.boot.followCount, 1);
  assert.equal(reads(), before + 1);
  mine.onHide(); loseReply = false; hold = null;
  await page.onShow();
  const id = page.data.targetWatch.id;
  await page.onWatchStatus(tap({ id, status: 'paused' }));
  await page.onWatchStatus(tap({ id, status: 'active' }));
  page.onChoice({ ...tap({ field: 'store' }), detail: { value: 1 } });
  await page.onWatch();
  await mine.onShow();
  assert.equal(mine.data.boot.followCount, 1);
  assert.equal(reads(), before + 1, 'pause, resume and adding another store use the same slot');
  mine.onHide(); hold = deferred();
  const removal = page.writeWatch('market.watchStatus', { followId: id, status: 'removed' });
  page.onHide(); page.onUnload();
  const back = mine.onShow();
  hold.resolve(); await Promise.all([removal, back]);
  assert.equal(mine.data.boot.followCount, 0);
  assert.equal(reads(), before + 2);
});

test('refused writes keep the confirmed account count; a late regional receipt cannot invalidate the next account', async () => {
  let refused = true;
  const hold = deferred();
  const { page, rt, state } = await setup({
    'market.watch': async () => {
      if (refused) throw Object.assign(Error('limit'), { code: 'too_many_follows' });
      await hold.promise;
      return { follow: { followId: 'alice-watch' } };
    },
  }, {}, { enabled: false });
  const store = rt.load('utils/store.js');
  const alice = await store.getBootstrap();
  await page.onWatch();
  assert.strictEqual(await store.getBootstrap(), alice);
  refused = false;
  const saving = page.onWatch();
  page.onHide();
  state.owner = 'Bob'; store.resetSession(); await page.onShow();
  const bob = await store.getBootstrap({ afterFollowWrites: true });
  assert.equal(bob.identity.userKey, 'Bob');
  hold.resolve(); await saving;
  assert.strictEqual(await store.getBootstrap(), bob);
});

test('a late receipt for a different WeChat user cannot update a watch or debit display', async () => {
  const pending=deferred();
  const {page,state,rt}=await setup({'market.pickup':async p=>{await pending.promise;return receipt(p,{balance:0,quotaRevision:10});}});
  const request=page.onQuery();page.onHide();state.owner='Bob';rt.load('utils/store.js').resetSession();
  await page.onShow();pending.resolve();await request;
  assert.equal(page.owner,'Bob');assert.equal(page.data.receipt,null);assert.equal(page.data.billingText,'');
  assert.equal(rt.app.globalData.bootstrap.quota.balance,3);
});

test('regional labels and the current station cadence follow the selected market and page language', async () => {
  const { page, state, handlers, rt } = await setup();
  const catalog = handlers['market.catalog'];
  handlers['market.catalog'] = () => ({ markets: catalog().markets.map(row => ({...row, monitorStale:false,
    monitorIntervalMs: row.code === 'JP' ? 120000 : 60000 })) });
  state.rows = ['JP','TW'].map(code => {
    const site=MARKETS.find(m=>m.code===code);
    page.onMarket(tap({market:code}));
    return {followId:code,market:code,partNumber:page.part,storeNumbers:[site.stores[0].storeNumber],language:'zh-CN',status:'active'};
  });
  page.onMarket(tap({market:'JP'}));
  await page.onPullDownRefresh();
  assert.equal(page.data.c.title,'其他站点');assert.equal(page.data.c.sites,'选择地区');
  assert.match(page.data.watchService,/2 分钟/);rt.load('utils/language.js').setLanguage('en');assert.equal(page.data.c.title,'Regional stores');
  assert.match(page.data.watchService,/2 minutes/);page.onMarket(tap({market:'TW'}));assert.equal(page.data.watchService,'');
  handlers['market.catalog'] = () => ({markets:catalog().markets.map(m=>({...m,monitorStale:true,monitorIntervalMs:180000}))});
  await page.onPullDownRefresh();assert.match(page.data.watchService,/unconfirmed/);assert.doesNotMatch(page.data.watchService,/minutes/);
});

test('release access starts at local midnight and uses plan ID instead of remaining days', () => {
  const { regionalAccess } = require('../miniprogram/pages/markets/presentation');
  for (const site of MARKETS) {
    const p = site.products[0], unlock = Date.parse(p.freeQueryStartsAt);
    assert.equal(localTime(p.freeQueryStartsAt,site.timeZone).slice(11,19),'00:00:00');
    for (const [plan,eligible,canWatch] of [['member_7d',true,false], ['member_30d',true,true], ['member_365d',true,true], ['trial',false,false], ['gift',false,false]]) {
      const account = { active:true, planId:plan, expiresAt:new Date(unlock+1000).toISOString() };
      const before = regionalAccess(account,p,unlock-1), after = regionalAccess(account,p,unlock);
      assert.equal(before.launchRestricted,!eligible,plan);
      assert.equal(before.canWatch,canWatch,plan);
      assert.equal(after.launchRestricted,false,plan);
      assert.equal(after.member,true,plan);
      assert.equal(regionalAccess(account,p,unlock+1000).member,false,plan);
      assert.equal(regionalAccess(account,{},unlock).launchRestricted,!eligible,plan);
    }
    assert.equal(regionalAccess({active:false,planId:'member_365d'},p,unlock-1).launchRestricted,true);
  }
});

test('regional check-in uses the shared daily quota, renders the account-confirmed balance and blocks double taps', async () => {
  const wait=deferred();
  const {page,rt}=await setup({
    'quota.signin': async p => { assert.equal(p.expectedUserKey,'Alice'); await wait.promise; return {granted:1,quota:{ balance:1, revision:2, queryCost:4, signedInToday:true }}; },
  },{}, {member:false,balance:0});
  assert.equal(page.data.signinPrimary,true); assert.equal(page.data.canQuery,false);
  const a=page.onSignin(); await page.onSignin(); await page.onQuery();
  assert.equal(rt.calls.filter(c=>c.action==='quota.signin').length,1);
  assert.equal(rt.calls.filter(c=>c.action==='market.pickup').length,0);
  wait.resolve();await a;
  assert.equal(page.data.signinMessage,'签到成功，增加 1 次查询');assert.equal(page.data.canQuery,true);
  assert.equal(page.data.showSignin,false);assert.equal(page.data.maxCost,1);
  assert.equal(rt.app.globalData.bootstrap.quota.balance,1);
  rt.load('utils/language.js').setLanguage('en');assert.equal(page.data.signinMessage,'Checked in · Credits added: 1');
  await page.onQuery();assert.equal(rt.calls.find(c=>c.action==='market.pickup').payload.maxCost,1);
});

test('a weekly member can check a launch but can only pause or delete a previously saved regional watch', async () => {
  const {page,state,handlers,rt}=await setup({}, {}, { planId:'member_7d' });
  const fixture=handlers['market.catalog'];
  handlers['market.catalog']=()=>({markets:fixture().markets.map(m=>({...m,products:m.products.map(p=>({...p, freeQueryStartsAt:'2099-12-01T15:00:00Z'}))}))});
  const query=page.payload(); state.rows=[{...query, followId:'old',status:'plan_required',savedStatus:'paused'}];
  await page.onPullDownRefresh(); assert.equal(page.data.canQuery,true);assert.equal(page.data.watchEnabled,false);
  assert.equal(page.data.watchRows[0].canResume,false);
  await page.onWatchStatus(tap({id:'old',status:'active'}));assert.equal(rt.calls.some(c=>c.action==='market.watchStatus'),false);
  state.planId='gift';await page.onPullDownRefresh(); assert.equal(page.data.canQuery,false);
  assert.match(page.data.launchNotice,/2099-12-02/);assert.match(page.data.launchNotice,/周卡、月卡或年卡/);
  await page.onQuery();assert.equal(rt.calls.some(c=>c.action==='market.pickup'),false);
});

test('an interrupted regional check-in can be retried for the same account and responses never cross accounts', async () => {
  const wait=deferred();
  const {page,rt,state,handlers}=await setup({'quota.signin': async()=>{throw Error('offline');}}, {}, {member:false,balance:0});
  await page.onSignin();assert.equal(page.data.showSignin,true);assert.match(page.data.signinMessage,/尚未确认/);
  handlers['quota.signin']=async()=>{await wait.promise; return {granted:1,quota:{balance:1,revision:2,queryCost:1,signedInToday:true}};};
  const pending=page.onSignin(); page.onHide(); state.owner='Bob'; rt.load('utils/store.js').resetSession(); await page.onShow();
  wait.resolve();await pending;
  assert.equal(page.data.signinMessage,'');assert.equal(rt.app.globalData.bootstrap.quota.balance,0);
});

test('optional regional check-in owner is verified before rewarding; old clients share the same daily ledger', async () => {
  const f=createFixture();
  const wrong=await f.call('quota.signin',{expectedUserKey:userKeyOf('someone-else')});assert.equal(wrong.error.code,'signin_account_changed');
  const current=await f.call('quota.signin',{expectedUserKey:userKeyOf()});assert.equal(current.data.granted,1);
  const old=await f.call('quota.signin');assert.equal(old.data.granted,0);assert.equal(old.data.reason,'already_signed_in');
});

test('mixed categories keep regional IDs and real variants while reference-only rows cannot start a watch or stock check', async () => {
  const base = MARKETS[0];
  const products = [
    ...base.products.filter(row => !row.category || row.category === 'iphone'),
    {category:'mac',model:'Mac 测试机型',modelEn:'Mac test model',partNumber:'LOCAL-A',configuration:'16GB 内存',configurationEn:'16GB memory',freeQueryStartsAt:'2026-01-01T00:00:00Z'},
    {category:'mac',model:'Mac 测试机型',modelEn:'Mac test model',partNumber:'LOCAL-B',configuration:'24GB 内存',configurationEn:'24GB memory',freeQueryStartsAt:'2026-01-01T00:00:00Z'},
    {category:'watch',model:'Apple Watch Ultra',id:'reference/watch-ultra',title:'Apple Watch Ultra',querySupported:false,monitorSupported:false,reason:'case_and_band'},
    ...Array.from({length:700},(_,i)=>({category:'airpods',model:'Model '+Math.floor(i/10),partNumber:'P'+i,configuration:'Version '+i,freeQueryStartsAt:'2026-01-01T00:00:00Z'})),
  ];
  const { page,rt } = await setup({'market.catalog':()=>({markets:[{...base,products,enabled:true,monitorEnabled:true}]})});
  const choice=(field,value)=>page.onChoice({...tap({field}),detail:{value}});
  const chooseCategory=code=>choice('category',page.data.categories.findIndex(row=>row.id===code));
  chooseCategory('mac');assert.equal(page.data.product.modelLabel,'Mac 测试机型');assert.equal(page.data.colors.length,0);assert.equal(page.data.capacities.length,0);
  assert.deepEqual(Array.from(page.data.variants,x=>x.id),['LOCAL-A','LOCAL-B']);
  choice('variant',1);assert.equal(page.data.product.id,'LOCAL-B');rt.load('utils/language.js').setLanguage('en');
  assert.equal(page.data.variants[1].label,'24GB memory');
  assert.equal(page.data.modelLabels[page.data.modelIndex],'Mac test model');assert.equal(page.data.product.modelLabel,'Mac test model');
  await page.onQuery();assert.equal(rt.calls.find(c=>c.action==='market.pickup').payload.partNumber,'LOCAL-B');
  chooseCategory('watch');assert.equal(page.data.product.id,'reference/watch-ultra');assert.equal(page.payload().partNumber,'');
  assert.match(page.data.product.referenceText,/case and a band/);
  assert.equal(page.data.canQuery,false);assert.equal(page.data.watchEnabled,false);assert.equal(page.data.receipt,null);
  await page.onWatch();await page.onQuery();
  assert.equal(rt.calls.filter(c=>c.action==='market.pickup').length,1);assert.equal(rt.calls.filter(c=>c.action==='market.watch').length,0);
  chooseCategory('airpods');assert.equal(page.data.variants.length,10);assert.equal(page.data.models.length,70);
  assert.equal(page.data.products,undefined);
  assert.ok(JSON.stringify({...page.data,ui:undefined}).length < JSON.stringify(products).length/3);
});

test('an open regional page refreshes account rights once at the Beijing day boundary without a manual stock check', async t => {
  const dayStart='2028-01-05T15:59:59.990Z', nextDay='2028-01-05T16:00:01Z';
  t.mock.timers.enable({ apis:['Date'], now:Date.parse(dayStart) });
  let after=false;
  const { page,rt }=await setup({
    'user.bootstrap':()=>({identity:{userKey:'Alice'},serverTime:after?nextDay:dayStart,membership:{active:false},
      quota:{balance:0,revision:after?2:1,dayKey:after?'2028-01-06':'2028-01-05',signedInToday:!after},notifications:{},subscriptions:{}}),
  });
  assert.equal(page.data.showSignin,false);
  const upcoming=rt.timers.get(page.expiryTimer);assert.ok(upcoming && upcoming.ms<=12);
  after=true;t.mock.timers.tick(20);await upcoming.fn();
  assert.equal(page.data.showSignin,true);assert.equal(rt.calls.filter(c=>c.action==='market.catalog').length,1);
  assert.equal(rt.calls.filter(c=>c.action==='user.bootstrap').length,2);assert.equal(rt.calls.filter(c=>c.action==='market.pickup').length,0);
});

test('a cached annual or monthly pass cannot allow regional watches after its enhanced rights expire', () => {
  const { regionalAccess }=require('../miniprogram/pages/markets/presentation');
  const product={freeQueryStartsAt:'2030-01-01T00:00:00Z'};
  const membership={active:true,planId:'member_365d',annualExpiresAt:'2028-01-01T00:00:00Z',enhancedExpiresAt:'2028-03-01T00:00:00Z',expiresAt:'2028-04-01T00:00:00Z'};
  assert.equal(regionalAccess(membership,product,Date.parse('2028-02-01T00:00:00Z')).canWatch,true);
  const next=regionalAccess(membership,product,Date.parse(membership.enhancedExpiresAt));
  assert.ok(next.member);assert.equal(next.canWatch,false);assert.equal(next.launchRestricted,true);
});

test('every published regional configuration is reachable and distinguishable in both languages through the real compact directory', async () => {
  const server = createFixture();
  const { page, rt } = await setup({
    'market.catalog': async payload => {
      const result = await server.call('market.catalog',payload);
      assert.equal(result.ok,true);
      assert.equal(result.data.format,'compact-v1');
      return {...result.data, markets:result.data.markets.map(site=>({...site,enabled:true,monitorEnabled:true}))};
    },
  });
  const choose = (field,value) => page.onChoice({ ...tap({field}),detail:{value} });
  const assertDistinct = options => assert.equal(new Set(options).size, options.length, options.join(' | '));
  const lookup = (options,id) => {
    const index=options.findIndex(row=>row.id===id);
    assert.notEqual(index,-1,id);
    return index;
  };
  for (const lang of ['zh-CN','en']) {
    if (page.data.lang !== lang) rt.load('utils/language.js').setLanguage(lang);
    for (const site of MARKETS) {
      page.onMarket(tap({market:site.code}));
      assert.equal(page.data.categories.length,7);
      for (const raw of site.products) {
        if (page.data.product.category!==raw.category) choose('category',lookup(page.data.categories,raw.category));
        if (page.data.product.model!==raw.model) {
          const index=page.data.models.indexOf(raw.model);
          assert.notEqual(index,-1,raw.model);
          choose('model',index);
        }
        if (page.data.product.color!==(raw.color||'')) choose('color',lookup(page.data.colors,raw.color||''));
        if (page.data.product.capacity!==(raw.capacity||'')) {
          const capacity=page.data.capacities.find(row=>row.label===(raw.capacity || page.data.c.noCapacity));
          assert.ok(capacity,raw.id);
          page.onCapacity(tap({id:capacity.id}));
        }
        const { variants, modelLabels, models, colors }=page.data;
        assertDistinct(variants.map(row=>row.label));
        assertDistinct(modelLabels);assertDistinct(colors.map(row=>row.label));
        const index=lookup(variants,raw.id);
        if(page.data.product.id!==raw.id) choose('variant',index);
        const {product}=page.data;
        assert.equal(product.id,raw.id);
        assert.equal(product.label,lang==='en'?raw.titleEn:raw.title);
        assert.equal(modelLabels[models.indexOf(raw.model)],lang==='en'?(raw.modelEn||raw.model):raw.model);
        assert.equal(page.payload().partNumber,raw.partNumber||'');
        assert.equal(page.data.canQuery,raw.querySupported);
        assert.equal(page.data.watchEnabled,raw.monitorSupported);
        if (!raw.partNumber) {
          assert.equal(page.data.receipt,null);assert.ok(product.referenceText);
          if (raw.reason?.startsWith('case_and_band')) assert.match(product.referenceText,lang==='en'? /band/:/表带/);
          if (raw.reason==='fitting_required') assert.match(product.referenceText,lang==='en'? /face/:/面部/);
          if (raw.reason==='custom_configuration') assert.match(product.referenceText,lang==='en'? /Configure/:/定制/);
        }
      }
    }
  }
  assert.equal(rt.calls.filter(call=>['market.pickup','market.watch'].includes(call.action)).length,0);
});

test('returning across a high-tier expiry refreshes the cached account even when the device clock lags', async t => {
  const localNow=Date.parse('2027-01-02T00:00:00Z'), serverNow=localNow+3600000;
  t.mock.timers.enable({apis:['Date'],now:localNow});
  let monthly=true;
  const {page,rt}=await setup({'user.bootstrap':()=>({
    identity:{userKey:'Alice'},serverTime:new Date(monthly?serverNow:serverNow+1000).toISOString(),
    membership:{active:true,planId:monthly?'member_30d':'member_7d',enhancedExpiresAt:monthly?new Date(serverNow+200).toISOString():null,
      expiresAt:new Date(serverNow+86400000).toISOString()},quota:{balance:2,revision:1},notifications:{},subscriptions:{},
  })});
  assert.equal(page.data.watchEnabled,true);
  page.onHide();t.mock.timers.tick(1000);monthly=false;await page.onShow();
  assert.equal(page.data.watchEnabled,false);assert.equal(page.data.membershipLink,true);
  assert.equal(rt.calls.filter(call=>call.action==='user.bootstrap').length,2);
  assert.equal(rt.calls.filter(call=>call.action==='market.catalog').length,1);
});

test('switching Japan–Hong Kong keeps the verified iPad configuration, resets the local store and clears the earlier receipt without spending', async () => {
  const [jp,,hk]=MARKETS;
  const target=jp.products.find(p=>p.category==='ipad'&&p.model.includes('Pro')&&p.color&&p.capacity&&p.partNumber);
  const hongKong=hk.products.find(p=>p.category===target.category&&p.model===target.model&&p.titleEn===target.titleEn);
  assert.ok(hongKong?.partNumber); assert.notEqual(hongKong.partNumber,target.partNumber);
  const {page,rt}=await setup({}, {market:'JP',partNumber:target.partNumber,storeNumber:jp.stores.at(-1).storeNumber});
  await page.onQuery(); assert.ok(page.data.receipt);assert.ok(page.data.billingText);
  page.onMarket(tap({market:'HK'}));
  assert.equal(page.part,hongKong.partNumber);assert.equal(page.store,hk.stores[0].storeNumber);
  assert.equal(page.data.receipt,null);assert.equal(page.data.billingText,'');assert.equal(page.data.selectionNotice,'');
  rt.load('utils/language.js').setLanguage('en');page.onMarket(tap({market:'JP'}));
  assert.equal(page.part,target.partNumber);assert.equal(page.store,jp.stores[0].storeNumber);
  assert.equal(rt.calls.filter(call=>call.action==='market.pickup').length,1);
  assert.equal(rt.calls.filter(call=>call.action==='market.watch').length,0);
});

test('a region with different or ambiguous Mac options retains the model or category and shows the local specifications; explicit deep links take priority', async () => {
  const [jp,tw,hk]=MARKETS;
  const base={category:'mac',model:'Mac mini',artworkPart:'MU9D3CH/A',capacity:'512GB',title:'Mac mini',freeQueryStartsAt:'2026-01-01T00:00:00Z'};
  const row=(partNumber,titleEn,extra={})=>({...base,partNumber,titleEn,title:titleEn,...extra});
  const markets=[
    {...jp,products:[row('J','Mac mini · 16GB memory')]},
    {...tw,products:[row('T1','Mac mini · 24GB memory'),row('T2','Mac mini · 32GB memory')]},
    {...hk,products:[row('H1','Mac Studio · 32GB memory',{model:'Mac Studio'})]},
  ].map(site=>({...site,enabled:true,monitorEnabled:true}));
  const {page,rt}=await setup({'market.catalog':()=>({markets})});
  page.onMarket(tap({market:'TW'}));
  assert.equal(page.part,'T1');assert.equal(page.data.product.model,'Mac mini');assert.ok(page.data.selectionNotice);
  rt.load('utils/language.js').setLanguage('en');assert.match(page.data.selectionNotice,/local configuration/);
  page.onMarket(tap({market:'HK'}));
  assert.equal(page.data.product.category,'mac');assert.equal(page.data.product.model,'Mac Studio');assert.ok(page.data.selectionNotice);
  page.launchTarget={market:'TW',partNumber:'T2',storeNumber:tw.stores.at(-1).storeNumber};await page.onShow();
  assert.equal(page.part,'T2');assert.equal(page.store,tw.stores.at(-1).storeNumber);assert.equal(page.data.selectionNotice,'');
  assert.equal(rt.calls.filter(call=>call.action==='market.pickup').length,0);
  const {matchRegionalProduct}=require('../miniprogram/pages/markets/presentation');
  const previous=row('P','Mac mini Wi‑Fi · Silver');
  assert.equal(matchRegionalProduct(previous,[row('A','mac mini Wi-Fi  Silver')]).exact,true);
  assert.equal(matchRegionalProduct(previous,[row('A','Mac mini Wi-Fi Silver'),row('B','Mac mini Wi-Fi Silver')]).exact,false);
});

test('an active administrator test account can check a new release and watch without buying a plan', async () => {
  const { page, rt } = await setup({ 'user.bootstrap': () => ({
    identity: { userKey: 'Alice' }, membership: { active: true, isTester: true, planId: null, expiresAt: null },
    quota: { balance: 0, revision: 1 }, notifications: {}, subscriptions: {}, settings: {},
  }) });
  assert.equal(page.data.canQuery, true);
  assert.equal(page.data.watchEnabled, true);
  assert.equal(page.data.membershipLink, false);
  assert.equal(page.data.costText, '库存查询不扣次数');
  rt.load('utils/language.js').setLanguage('en');
  assert.equal(page.data.costText, 'No credits needed for stock checks');
  await page.onQuery();
  assert.equal(rt.calls.find(c => c.action === 'market.pickup').payload.maxCost, 0);
});

test('the regional watch editor adds and removes individual stores and changes only that watch’s alert language', async () => {
  const cloud = createFixture({ start: new Date().toISOString() });
  await cloud.call('user.bootstrap');
  await cloud.repo.updateUser(userKeyOf(), { membership: marketMembership(cloud.state.now, 'member_30d') });
  let loseEdit = false;
  const rt = runtime(async (action, payload) => {
    const result = await cloud.call(action, payload);
    if (!result.ok) throw Object.assign(Error(result.error.message), result.error);
    if (action === 'market.editWatch' && loseEdit) throw Error('lost reply');
    return result.data;
  });
  const page = rt.instance('pages/markets/index.js');
  page.onLoad({ market: 'HK' }); await page.onShow();
  await page.onWatch();
  const id = page.data.targetWatch.id;
  page.onManageWatch(tap({ id }));
  const row = () => page.data.watchRows.find(item => item.id === id);
  const edit = (field, value, store) => page.onEditWatch({ ...tap({ id, field, store }), detail: { value } });
  assert.equal(row().editing, true);
  const firstStore = row().selectedStores[0].id, second = row().additionalStores[1].id;
  await edit('add', 0);
  assert.equal(row().selectedStores.length, 1);
  await edit('add', 1);
  assert.ok(row().selectedStores.some(s => s.id === second));
  loseEdit = true;
  await edit('language', 1);
  assert.equal(row().language, 'en');
  assert.equal(page.data.lang, 'zh-CN');
  assert.equal(page.data.targetLanguage, '英语');
  assert.equal(page.data.watchMessage, '关注已更新');
  loseEdit = false;
  edit('remove', null, firstStore);
  await rt.messages.at(-1).success({ confirm: false });
  assert.equal(row().selectedStores.length, 2);
  edit('remove', null, firstStore);
  await rt.messages.at(-1).success({ confirm: true });
  assert.deepEqual(Array.from(row().selectedStores, s => s.id), [second]);
  assert.equal(page.data.watchLabel, '将此门店加入关注');
  assert.equal(page.data.watchRows.length, 1);
  assert.equal(rt.calls.some(c => ['market.pickup', 'notify.recordSubscription'].includes(c.action)), false);
  page.onHide();
  assert.equal(page.editingWatch, null);
  page.onUnload();
});
