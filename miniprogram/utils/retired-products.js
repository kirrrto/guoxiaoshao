let retired;
function isRetiredMainlandProduct(partNumber, market) {
  if (market && market !== 'CN' || !partNumber) return false;
  if (!retired) retired = new Set(require('../config/catalog-seed').retiredPartNumbers || []);
  return retired.has(partNumber);
}
module.exports = { isRetiredMainlandProduct };
