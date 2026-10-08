const PLAN_IDS = ['member_7d', 'member_30d', 'member_365d'];
const fmt = require('./format');

function planId(product) {
  if (product && PLAN_IDS.includes(product.planId)) return product.planId;
  if (product && PLAN_IDS.includes(product.id)) return product.id;
  return 'member_7d';
}

/** Server products own pricing; the client only preserves the chosen plan. */
function memberProducts(boot) {
  const list = Array.isArray(boot.memberProducts) && boot.memberProducts.length
    ? boot.memberProducts : [boot.memberProduct];
  return list.filter(item => item && Number.isInteger(item.priceFen) && item.priceFen > 0
    && Number.isInteger(item.days) && item.days > 0)
    .map(item => ({ ...item, planId: planId(item) }));
}

function renewalPreview(product, membership, now = Date.now()) {
  const days = product && product.days;
  const expires = membership && Date.parse(membership.expiresAt);
  const active = Boolean(membership && membership.active && Number.isFinite(expires) && expires > now);
  const end = Number.isInteger(days) && days > 0 ? (active ? expires : now) + days * 86400000 : NaN;
  return {
    title: active ? '剩余有效期继续保留' : '付款确认后开通',
    description: '按所选套餐全价购买，权益相同，不抵扣差价，不自动续费。',
    extensionText: Number.isInteger(days) && days > 0 ? `${active ? '在原到期时间后增加' : '本次开通'} ${days} 天` : '',
    expiresAtText: Number.isFinite(end) && Number.isFinite(new Date(end).getTime()) ? fmt.fmtDateTime(end) : '',
  };
}

module.exports = { planId, memberProducts, renewalPreview };
