// The eight verified Pro/Pro Max finish-select PNGs include transparent margins.
// Measured 2026-09-30: Pro 592x718 / 940x1112; Max 640x783 / 940x1112.
// Limit framing to these assets so other product silhouettes remain uncropped.
const proFinishSource = /^https:\/\/store\.storeimages\.cdn-apple\.com\/1\/as-images\.apple\.com\/is\/iphone-18-pro(-max)?-finish-select-(black|silver|glacier|burgundy)-202609(?:\?|$)/;
function productImageFit(imageUrl) {
  const match = proFinishSource.exec(String(imageUrl || ''));
  return match ? (match[1] ? 'product-image-fit-max' : 'product-image-fit-pro') : '';
}

// Display only packaged renditions derived from the exact verified original.
// Keep source URLs untouched. A known SKU can reuse its verified rendition when
// an old cache or backend URL rotates; new SKUs require the catalog asset build.
let displayAssets = null;
let displayParts = null;
const finishCards = new Map();
const finishLabels = new Map([
  ['黑色', 'black'], ['Black', 'black'], ['银色', 'silver'], ['Silver', 'silver'],
  ['冰川蓝色', 'glacier'], ['Glacier', 'glacier'], ['勃艮第酒红色', 'burgundy'], ['Burgundy', 'burgundy'],
]);
function loadDisplayAssets() {
  if (!displayAssets) {
    displayAssets = Object.create(null);
    displayParts = Object.create(null);
    const mapping = require('../config/product-thumbnails');
    for (const asset of mapping.assets) {
      const finish = proFinishSource.exec(asset.source);
      if (finish) finishCards.set((finish[1] ? 'iPhone 18 Pro Max' : 'iPhone 18 Pro') + '|' + finish[2], asset.card);
      displayAssets[asset.source] = asset;
      displayAssets[asset.card] = asset;
      displayAssets[asset.card.replace(/\.(?:png|jpg)$/, '.webp')] = asset;
      if (asset.poster) {
        displayAssets[asset.poster] = asset;
        displayAssets[asset.poster.replace(/\.(?:png|jpg)$/, '.webp')] = asset;
      }
    }
    for (const part of Object.keys(mapping.byPart)) displayParts[part] = mapping.assets[mapping.byPart[part]];
  }
}
function productThumbnailUrl(imageUrl, variant = 'card', partNumber = '') {
  loadDisplayAssets();
  const asset = displayAssets[typeof imageUrl === 'string' ? imageUrl : ''] || displayParts[partNumber];
  return asset ? (variant === 'poster' && asset.poster || asset.card) : '';
}

// Local SKUs differ by region. Only the verified model and exterior finish identify shared artwork.
function regionalProductThumbnail(product) {
  if (!product || !product.model) return '';
  const finish = finishLabels.get(product.color || product.colorEn);
  if (!finish || (product.colorEn && finishLabels.get(product.colorEn) !== finish)) return '';
  loadDisplayAssets();
  return finishCards.get(product.model + '|' + finish) || '';
}

function withImageFit(product) {
  const imageUrl = product && product.imageUrl;
  const partNumber = product && product.partNumber;
  return {
    ...product,
    imageFitClass: productImageFit(imageUrl),
    imageDisplayUrl: productThumbnailUrl(imageUrl, 'card', partNumber) || productThumbnailUrl(product && product.imageDisplayUrl, 'card', partNumber),
  };
}

module.exports = { productImageFit, withImageFit, productThumbnailUrl, regionalProductThumbnail };
