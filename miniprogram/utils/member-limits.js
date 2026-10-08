// Display and picker limits come from the authenticated server snapshot. Do
// not infer a paid plan from remaining days, local storage or a product label.
function bounded(value, fallback = 3) {
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : fallback;
}
function selectionLimits(account) {
  const limits = account && account.limits || {};
  return { colors: bounded(limits.alternativeMaxColors), stores: bounded(limits.queryMaxStores) };
}
function productBenefit(product) {
  const limits = product && product.limits || {};
  return `${bounded(limits.maxFollows)} 个配置 · 每配置 ${bounded(limits.maxStoresPerFollow)} 家门店`;
}
module.exports = { selectionLimits, productBenefit };
