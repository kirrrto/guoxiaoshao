// Public catalog capabilities. Raw Apple configuration options stay server-side.
function canQuery(product) {
  return Boolean(product && !product.comingSoon && (product.querySupported === undefined ? product.supported === true : product.querySupported === true));
}
function canMonitor(product) {
  return Boolean(product && !product.comingSoon && (product.monitorSupported === undefined ? product.supported === true : product.monitorSupported === true));
}
function isPublicTargetIdentity(value) {
  return typeof value === 'string' && (/^[A-Za-z0-9/_-]{1,64}$/.test(value) || /^CTO_[A-F0-9]{64}$/.test(value));
}
module.exports = { canQuery, canMonitor, isPublicTargetIdentity };
