import { createFixture, fakeFetch, operatorContext, userKeyOf } from './fixture.mjs';
export const BASE = 'MXXX1CH/A';
export const SILVER = 'MXXX2CH/A';
export const BLACK = 'MXXX3CH/A';
export const QUERY_ID = 'paid-alternatives-origin';
const base = { _id: BASE, partNumber: BASE, category: 'iphone', familyKey: 'iphone-17', model: 'iPhone 17', title: 'iPhone 17 256GB 绿色',
  familyName: 'iPhone 17', supported: true, comingSoon: false, priceCny: 5999, attributes: { capacity: '256GB', color: '绿色', connectivity: '5G' } };
export const products = [base, ...[
  [SILVER, '银色', {}], [BLACK, '黑色', {}], ['MXXX4CH/A', '蓝色', { attributes: { capacity: '512GB' } }],
  ['MXXX5CH/A', '紫色', { model: 'iPhone 17 Pro' }], ['MXXX6CH/A', '红色', { attributes: { connectivity: 'Wi-Fi' } }],
  ['MXXX7CH/A', '粉色', { attributes: { capacity: null } }], ['MXXX8CH/A', '黄色', { supported: false }],
].map(([partNumber, color, patch]) => ({ ...base, ...patch, _id: partNumber, partNumber, title: `iPhone 17 ${color}`,
  attributes: { ...base.attributes, color, ...patch.attributes } }))];
export const stores = ['R577', 'R578', 'R579', 'R580', 'R581'].map((storeNumber, i) => ({ _id: storeNumber, storeNumber, name: `广州门店 ${i + 1}`, city: '广州', province: '广东' }))
  .concat({ _id: 'R320', storeNumber: 'R320', name: '北京门店', city: '北京', province: '北京' });
export const ok = response => { if (!response.ok) throw Object.assign(Error(response.error.message), { code: response.error.code }); return response.data; };
export const tablesSnapshot = repo => JSON.stringify([...repo.tables].map(([name, rows]) => [name, [...rows]]));
export async function alternativesFixture({ member = false, config = {}, storeCatalog = stores, query = true } = {}) {
  const fetchImpl = fakeFetch(() => ({ display: 'unavailable' }));
  const f = createFixture({ products, stores: storeCatalog, fetchImpl, config });
  ok(await f.call('user.bootstrap'));
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: 3, grantId: 'alternatives-credit-seed' }, operatorContext()));
  if (member) ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 1, grantId: 'alternatives-member-seed' }, operatorContext()));
  const origin = query ? ok(await f.call('query.pickup', { queryId: QUERY_ID, partNumber: BASE, storeNumbers: ['R577'] })) : null;
  const observe = (partNumber = SILVER, storeNumber = 'R578', patch = {}) => f.repo.saveLatest({ _id: `${storeNumber}|${partNumber}`, partNumber, storeNumber,
    status: 'available', observedAt: f.state.now.toISOString(), knownAt: f.state.now.toISOString(), quote: '今天可取货', ...patch });
  const read = (patch = {}, identity) => f.call('query.alternatives', { queryId: QUERY_ID, partNumbers: [SILVER], storeNumbers: ['R578'], ...patch }, identity);
  return { ...f, origin, observe, read, fetchImpl };
}
