// The eight verified Pro/Pro Max finish-select PNGs include transparent margins.
// Measured 2026-09-30: Pro 592x718 / 940x1112; Max 640x783 / 940x1112.
// Limit framing to these assets so other product silhouettes remain uncropped.
function productImageFit(imageUrl) {
  const match = /^https:\/\/store\.storeimages\.cdn-apple\.com\/1\/as-images\.apple\.com\/is\/iphone-18-pro(-max)?-finish-select-(black|silver|glacier|burgundy)-202609(?:\?|$)/.exec(String(imageUrl || ''));
  return match ? (match[1] ? 'product-image-fit-max' : 'product-image-fit-pro') : '';
}

// Display only packaged renditions derived from the exact verified original.
// Keep source URLs untouched. A known SKU can reuse its verified rendition when
// an old cache or backend URL rotates; new SKUs require the catalog asset build.
let displayAssets = null;
let displayParts = null;
function productThumbnailUrl(imageUrl, variant = 'card', partNumber = '') {
  if (!displayAssets) {
    displayAssets = Object.create(null);
    displayParts = Object.create(null);
    const mapping = require('../config/product-thumbnails');
    for (const asset of mapping.assets) {
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
  const asset = displayAssets[typeof imageUrl === 'string' ? imageUrl : ''] || displayParts[partNumber];
  return asset ? (variant === 'poster' && asset.poster || asset.card) : '';
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

module.exports = { productImageFit, withImageFit, productThumbnailUrl };
