import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const require = createRequire(import.meta.url);
const { MARKETS } = require('../cloudfunctions/gxs_api/lib/markets');
const { localTime } = require('../miniprogram/pages/markets/presentation');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tap = dataset => ({ currentTarget: { dataset } });
async function setup(extra = {}, options = {}, seed = {}) {
  const state = { owner: 'Alice', member: true, rows: [], enabled: true, ...seed };
  const handlers = {
    'user.bootstrap': () => ({ identity: { userKey: state.owner }, membership: { active: state.member }, quota: { balance: 3, queryCost: 1, revision: 1 },
      notifications: { enabled: true, senderReady: true, templateIds: { restock: 'chinese' } }, subscriptions: {}, settings: {} }),
    'market.catalog': () => ({ markets: MARKETS.map(m => ({ ...m, enabled: state.enabled, monitorEnabled: state.enabled,
      notificationsEnabled: state.enabled, notificationsEnabledEn: false })) }),
    'market.follows': () => ({ follows: state.rows, monitoring: { JP: true, TW: true, HK: true }, notifications: { JP: true, TW: true, HK: true } }),
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
  assert.equal(page.data.models.length, 2);
  page.onMarket(tap({ market: 'TW' }));
  page.onChoice({ ...tap({ field: 'model' }), detail: { value: '1' } });
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
  page.onLanguage(); assert.equal(page.data.receipt.status, 'Available for pickup');
  assert.equal(rt.storage.get('gxs_markets_region_v1'), 'TW');
  assert.equal(rt.storage.get('gxs_markets_language_v1'), 'en');
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
  const { imageDisplayUrl: black } = page.data.product;
  assert.match(black, /^\/images\/products\/.+-card\.png$/);
  await page.onWatch(); assert.equal(page.data.watchRows[0].imageDisplayUrl, black);
  page.onCapacity(tap({ id: page.data.capacities[1].id }));
  assert.equal(page.data.product.imageDisplayUrl, black);
  page.onChoice({ ...tap({ field: 'color' }), detail: { value: 1 } });
  const otherFinish = page.data.product.imageDisplayUrl;
  assert.ok(otherFinish && otherFinish !== black);
  page.onProductImageError(tap({ src: black }));
  assert.equal(page.data.product.imageDisplayUrl, otherFinish);
  assert.equal(page.data.watchRows[0].imageDisplayUrl, '');
  page.onLanguage(); page.onMarket(tap({ market: 'TW' }));
  assert.equal(page.data.product.imageDisplayUrl, '');
  assert.ok(page.data.product.label && page.data.canQuery);
  assert.equal(rt.calls.filter(c => c.action === 'market.pickup').length, 0);
  await page.onQuery(); assert.equal(page.data.receipt.status, 'Available for pickup');
  page.onChoice({ ...tap({ field: 'model' }), detail: { value: 1 } });
  assert.ok(page.data.product.imageDisplayUrl && page.data.product.imageDisplayUrl !== black);
});
test('uncertain request retains its ID across markets and can settle after rollout closes', async () => {
  let first = true;
  const { page, rt, state } = await setup({ 'market.pickup': p => {
    if (first) { first = false; throw Object.assign(Error(), { code: 'call_failed' }); }
    return receipt(p, { charged: 1, refunded: 1 });
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
  page.onLanguage(); await page.onWatch();
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
test('closed market does not start new inventory requests, account changes clear last private result', async () => {
  const { page, rt, state } = await setup({}, {}, {enabled:false});
  assert.equal(page.data.canQuery,false); await page.onQuery(); assert.equal(rt.calls.filter(c => c.action === 'market.pickup').length,0);
  state.enabled = true; await page.onPullDownRefresh(); await page.onQuery();
  assert.ok(page.data.receipt);
  page.onHide(); state.owner='Bob'; rt.load('utils/store.js').resetSession(); await page.onShow();
  assert.equal(page.data.receipt,null); assert.equal(page.owner,'Bob');
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

test('a late receipt for a different WeChat user cannot update a watch or debit display', async () => {
  const pending=deferred();
  const {page,state,rt}=await setup({'market.pickup':async p=>{await pending.promise;return receipt(p,{balance:0,quotaRevision:10});}});
  const request=page.onQuery();page.onHide();state.owner='Bob';rt.load('utils/store.js').resetSession();
  await page.onShow();pending.resolve();await request;
  assert.equal(page.owner,'Bob');assert.equal(page.data.receipt,null);assert.equal(page.data.billingText,'');
  assert.equal(rt.app.globalData.bootstrap.quota.balance,3);
});

test('regional labels and the current station cadence follow the selected market and page language', async () => {
  const { page, state, handlers } = await setup();
  const catalog = handlers['market.catalog'];
  handlers['market.catalog'] = () => ({ markets: catalog().markets.map(row => ({...row, monitorStale:false,
    monitorIntervalMs: row.code === 'JP' ? 120000 : 60000 })) });
  state.rows = ['JP','TW'].map(code => {
    const site=MARKETS.find(m=>m.code===code);
    return {followId:code,market:code,partNumber:site.products[0].partNumber,storeNumbers:[site.stores[0].storeNumber],language:'zh-CN',status:'active'};
  });
  await page.onPullDownRefresh();
  assert.equal(page.data.c.title,'其他站点');assert.equal(page.data.c.sites,'选择地区');
  assert.match(page.data.watchService,/2 分钟/);page.onLanguage();assert.equal(page.data.c.title,'Regional stores');
  assert.match(page.data.watchService,/2 minutes/);page.onMarket(tap({market:'TW'}));assert.equal(page.data.watchService,'');
  handlers['market.catalog'] = () => ({markets:catalog().markets.map(m=>({...m,monitorStale:true,monitorIntervalMs:180000}))});
  await page.onPullDownRefresh();assert.match(page.data.watchService,/unconfirmed/);assert.doesNotMatch(page.data.watchService,/minutes/);
});
