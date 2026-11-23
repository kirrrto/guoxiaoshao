// The directory arrives once per refresh. Repeated model names, specifications
// and eligibility dates share a string table across the three regions.
const PRODUCT_FIELDS = [
  'partNumber', 'id', 'category', 'familyKey', 'familyName', 'model', 'modelEn',
  'title', 'titleEn', 'color', 'colorEn', 'capacity', 'configuration', 'configurationEn',
  'artworkPart', 'releaseAt', 'freeQueryStartsAt', 'supported', 'querySupported', 'monitorSupported', 'reason',
];

function unpackProducts(rows, values) {
  if (!Array.isArray(rows) || !Array.isArray(values) || values[0] !== null) throw Error('Invalid regional catalog');
  return rows.map(row => {
    if (!Array.isArray(row) || row.length > PRODUCT_FIELDS.length) throw Error('Invalid regional configuration');
    const product = {};
    for (let i = 0; i < row.length; i++) {
      const index = row[i];
      if (!Number.isInteger(index) || index < 0 || index >= values.length) throw Error('Invalid regional catalog value');
      if (index) product[PRODUCT_FIELDS[i]] = values[index];
    }
    product.partNumber = product.partNumber || null;
    product.id = product.id || product.partNumber;
    if (!product.id || !product.model || !product.title) throw Error('Incomplete regional configuration');
    return product;
  });
}
function decodeMarketCatalog(response) {
  if (response?.format !== 'compact-v1') return response;
  const markets = response.markets.map(({ productRows, ...market }) => ({
    ...market, products: unpackProducts(productRows, response.values),
  }));
  return { markets };
}
module.exports = { PRODUCT_FIELDS, unpackProducts, decodeMarketCatalog };
