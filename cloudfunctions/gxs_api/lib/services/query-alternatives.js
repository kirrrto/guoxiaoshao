'use strict';
const { ApiError } = require('../errors');
const { isMember, accountLimits } = require('../rules/membership');
const { resolvePlanMetadata } = require('../rules/member-plan');
const { isLiveRestricted } = require('../rules/new-product');
const { WINDOW_MS, sameVariant, storeChoices, freshAvailable } = require('../rules/query-alternatives');
function choices(values, pattern, label, maxChoices) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxChoices || new Set(values).size !== values.length
    || values.some(value => typeof value !== 'string' || !pattern.test(value))) throw new ApiError('invalid_alternative_scope', `${label}需选择 1–${maxChoices} 项，不能重复`);
  return values;
}
async function alternatives(ctx, payload) {
  if (typeof payload.queryId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.queryId)) throw new ApiError('invalid_query_id', '请从刚完成的查询查看备选');
  // Read only: an existing completed query is the access proof. Do not create a
  // user, reserve budget, collect stock, write history, enqueue work or debit.
  let [user, query] = await Promise.all([ctx.repo.getUser(ctx.identity.userKey), ctx.repo.getQuery(`${ctx.identity.userKey}|${payload.queryId}`)]);
  user = await resolvePlanMetadata(user, id => ctx.repo.getOrder(id));
  const limits = accountLimits(user, ctx.clock(), ctx.config);
  const parts = choices(payload.partNumbers, /^[A-Z0-9]{5}CH\/A$/, '配置', limits.alternativeMaxColors);
  const numbers = choices(payload.storeNumbers, /^R\d{3}$/, '门店', limits.queryMaxStores);
  if (!user || !query || query.userKey !== user._id || query.kind !== 'live' || query.status !== 'success' || !query.response || query.response.ok !== true
    || !(query.member === true || Number(query.charged) > Number(query.response.refunded || 0))) throw new ApiError('alternatives_query_required', '需从本人刚完成的有效付费或会员查询查看备选');
  const finished = Date.parse(query.finishedAt), expires = finished + WINDOW_MS;
  const checkWindow = () => {
    const now = ctx.clock().getTime();
    if (!Number.isFinite(finished) || finished > now || now >= expires) throw new ApiError('alternatives_expired', '本次备选查看窗口已结束，请重新查询后确认');
    return now;
  };
  checkWindow();
  const [base, products, stores] = await Promise.all([ctx.repo.getProduct(query.partNumber), Promise.all(parts.map(part => ctx.repo.getProduct(part))), ctx.repo.listStores()]);
  const now = checkWindow();
  const canRead = (product, time = now) => product && product.supported === true && !product.comingSoon
    && (isMember(user, new Date(time)) || !isLiveRestricted(product, ctx.config.newProductWindows, new Date(time)).restricted);
  if (!canRead(base) || products.some(product => !canRead(product))) throw new ApiError('alternatives_restricted', '所选配置当前不支持查看，或处于新品会员限制期');
  if (products.some(product => !sameVariant(base, product))) throw new ApiError('alternative_variant_mismatch', '仅可选择同机型、同容量且其他配置相同的颜色');
  const allowedStores = storeChoices(stores, query.storeNumbers, limits.queryMaxStores);
  if (numbers.some(number => !allowedStores.some(store => store.storeNumber === number))) throw new ApiError('alternative_store_mismatch', '仅可选择本次查询门店及列出的附近或同城门店');
  const targets = parts.flatMap(part => numbers.map(number => `${number}|${part}`));
  const rows = await ctx.repo.getLatest(targets);
  const readAt = checkWindow();
  if (!canRead(base, readAt) || products.some(product => !canRead(product, readAt))) throw new ApiError('alternatives_restricted', '配置访问权限已变化，请重新确认');
  const results = rows.filter(row => targets.includes(row._id) && row._id === `${row.storeNumber}|${row.partNumber}` && freshAvailable(row, readAt)).map(row => {
    const product = products.find(item => item.partNumber === row.partNumber), store = stores.find(item => item.storeNumber === row.storeNumber);
    return { partNumber: row.partNumber, storeNumber: row.storeNumber, productTitle: product.title, color: product.attributes && product.attributes.color || null,
      storeName: store.name, city: store.city, status: 'available', quote: row.quote || null, observedAt: row.observedAt, knownAt: row.knownAt || row.observedAt,
      expiresAt: new Date(Math.min(expires, Date.parse(row.observedAt) + WINDOW_MS, Date.parse(row.knownAt || row.observedAt) + WINDOW_MS)).toISOString() };
  });
  return { queryId: query.queryId, basePartNumber: query.partNumber, partNumbers: parts, storeNumbers: numbers,
    finishedAt: query.finishedAt, expiresAt: new Date(expires).toISOString(), readAt: new Date(readAt).toISOString(), results };
}
module.exports = { alternatives };
