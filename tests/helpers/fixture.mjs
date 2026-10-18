import { createRequire } from 'node:module';
import { createMemoryRepo } from './memory-repo.mjs';

const require = createRequire(import.meta.url);
const { createHandler } = require('../../cloudfunctions/gxs_api/lib/app.js');
const { COLLECTIONS } = require('../../cloudfunctions/gxs_api/lib/collections.js');

export const CONSUMER_APPID = 'wxe96ad9e77b602f1b';
export const RESOURCE_APPID = 'wxc6dfebb77650f3a9';

export const PRODUCTS = [
  { _id: 'MJYH4CH/A', partNumber: 'MJYH4CH/A', category: 'iphone', familyKey: 'iphone-18-pro', familyName: 'iPhone 18 Pro / Pro Max', model: 'iPhone 18 Pro Max', title: 'iPhone 18 Pro Max 1TB 勃艮第酒红色', supported: true, comingSoon: false, priceCny: 16499 },
  { _id: 'MXXX1CH/A', partNumber: 'MXXX1CH/A', category: 'iphone', familyKey: 'iphone-17', familyName: 'iPhone 17', model: 'iPhone 17', title: 'iPhone 17 256GB 鼠尾草绿色', supported: true, comingSoon: false, priceCny: 5999 },
  { _id: 'MYYY2CH/A', partNumber: 'MYYY2CH/A', category: 'ipad', familyKey: 'ipad-air', familyName: 'iPad Air', model: 'iPad Air 11', title: 'iPad Air 11 英寸 128GB 蓝色', supported: true, comingSoon: false, priceCny: 4799 },
  { _id: 'MZZZ3CH/A', partNumber: 'MZZZ3CH/A', category: 'mac', familyKey: 'mac-mini', familyName: 'Mac mini', model: 'Mac mini', title: 'Mac mini M5', supported: true, comingSoon: false, priceCny: 4499 },
  { _id: 'MWWW4CH/A', partNumber: 'MWWW4CH/A', category: 'watch', familyKey: 'apple-watch', familyName: 'Apple Watch', model: 'Apple Watch Series 12', title: 'Apple Watch Series 12', supported: false, comingSoon: false, priceCny: 2999 },
];

export const STORES = [
  { _id: 'R577', storeNumber: 'R577', name: '天环广场', city: '广州', province: '广东' },
  { _id: 'R639', storeNumber: 'R639', name: '珠江新城', city: '广州', province: '广东' },
  { _id: 'R320', storeNumber: 'R320', name: '三里屯', city: '北京', province: '北京' },
  { _id: 'R448', storeNumber: 'R448', name: '西湖', city: '杭州', province: '浙江' },
];

export const userContext = (openid = 'oUSER000000000000000000001', appid = CONSUMER_APPID) => ({
  FROM_APPID: appid, FROM_OPENID: openid, APPID: RESOURCE_APPID, ENV: 'flowermean-6gjaxfqhf6c13e88', SOURCE: 'wx_client',
});
export const operatorContext = () => ({ ENV: 'flowermean-6gjaxfqhf6c13e88', SOURCE: 'wx_devtools' });
export const userKeyOf = (openid = 'oUSER000000000000000000001', appid = CONSUMER_APPID) => `${appid}:${openid}`;

/** Apple-like pickup body for one store, one status per part. */
export function appleBody(storeNumber, storeName, parts) {
  return JSON.stringify({
    head: { status: '200', data: {} },
    body: {
      stores: [{
        storeNumber,
        storeName,
        partsAvailability: Object.fromEntries(Object.entries(parts).map(([partNumber, status]) => [partNumber, {
          partNumber,
          pickupDisplay: status,
          pickupSearchQuote: status === 'available' ? '今天可取货' : status === 'default' ? '请于 9 月 20 日查看' : '暂无供应',
          messageTypes: { regular: { storePickupProductTitle: `商品 ${partNumber}`, storePickupQuote: status === 'available' ? '今天可取货' : '暂无供应' } },
        }])),
      }],
    },
  });
}

/** Fetch stub: `plan` maps storeNumber → { status?, body?, error? } and records every request. */
export function fakeFetch(plan) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = url.href || String(url);
    const storeNumber = new URL(href).searchParams.get('store');
    const parts = [...new URL(href).searchParams.entries()].filter(([k]) => k.startsWith('parts.')).map(([, v]) => v);
    calls.push({ storeNumber, parts, href });
    const step = typeof plan === 'function' ? plan(storeNumber, parts, calls.length) : plan[storeNumber];
    if (!step) throw new Error(`no plan for ${storeNumber}`);
    if (step.error) throw Object.assign(new Error(step.error), { name: 'TypeError' });
    const body = Buffer.from(step.body ?? appleBody(storeNumber, step.storeName || storeNumber, Object.fromEntries(parts.map(p => [p, step.display || 'available']))));
    return {
      status: step.status ?? 200,
      headers: { get: () => null },
      body: (async function* () { yield body; })(),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export function createFixture({ config, products = PRODUCTS, stores = STORES, fetchImpl, start = '2026-09-15T02:00:00.000Z' } = {}) {
  // Existing contract tests deliberately issue separate samples at a frozen
  // clock. Keep those explicit legacy semantics; capacity/sharing tests opt in
  // to the production defaults they exercise.
  config = { ...config, collector: { budgetMode: 'daily', ...config?.collector }, query: { sharedFreshnessSeconds: 0, ...config?.query } };
  const repo = createMemoryRepo({
    [COLLECTIONS.catalogProducts]: products,
    [COLLECTIONS.catalogStores]: stores,
    [COLLECTIONS.config]: [
      ...(config ? [{ _id: 'runtime', ...config }] : []),
      { _id: 'catalog', version: 'test|v1', families: [], excludedFamilies: [] },
    ],
  });
  const state = { now: new Date(start), fetchImpl: fetchImpl || fakeFetch({}) };
  const logs = [];
  const handle = createHandler({
    repo,
    fetchImpl: (...args) => state.fetchImpl(...args),
    clock: () => new Date(state.now),
    log: { error: (...args) => logs.push(args), info: () => {}, warn: () => {} },
    requestIdOf: () => 'req-test',
  });
  const call = async (action, payload, wxContext = userContext()) => handle({ action, payload }, wxContext);
  const advance = ms => { state.now = new Date(state.now.getTime() + ms); };
  return { repo, handle, call, advance, state, logs };
}
