const launches = require('../config/product-launches');
function launchView(catalog, selection, now = Date.now()) {
  const product = selection && catalog && catalog.productByPart && catalog.productByPart[selection.partNumber];
  const entry = launches.find(item => (!product || product.familyKey === item.familyKey) && now < Date.parse(item.displayUntil));
  if (!entry) return null;
  const products = Object.values(catalog && catalog.productByPart || {}).filter(item => item.familyKey === entry.familyKey);
  if (!products.length) return null;
  const open = products.some(item => item.supported === true && !item.comingSoon);
  return { ...entry, status: now < Date.parse(entry.preorderAt) ? '预购准备' : '新品选购',
    availability: open ? '已开放部分配置查询，以目录中可选配置为准。' : '尚未开放取货查询；预购时间不代表门店库存已可查。',
    preparation: '提前在 Apple 官方渠道确认账号、取货联系人与付款方式。果小哨不会替你下单。' };
}
// Fixed known official destination. No untrusted URL is accepted from a share,
// a remote message or a query response, and no SKU URL is guessed.
function officialPurchaseUrl(product) {
  const launch = launches.find(item => item.familyKey === (product && product.familyKey));
  return launch ? launch.officialUrl : 'https://www.apple.com.cn/store';
}
module.exports = { launchView, officialPurchaseUrl };
