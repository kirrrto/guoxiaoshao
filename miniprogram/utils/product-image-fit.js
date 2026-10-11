// The eight verified Pro/Pro Max finish-select PNGs include transparent margins.
// Measured 2026-09-30: Pro 592x718 / 940x1112; Max 640x783 / 940x1112.
// Limit framing to these assets so other product silhouettes remain uncropped.
function productImageFit(imageUrl) {
  const match = /^https:\/\/store\.storeimages\.cdn-apple\.com\/1\/as-images\.apple\.com\/is\/iphone-18-pro(-max)?-finish-select-(black|silver|glacier|burgundy)-202609(?:\?|$)/.exec(String(imageUrl || ''));
  return match ? (match[1] ? 'product-image-fit-max' : 'product-image-fit-pro') : '';
}

function withImageFit(product) {
  return { ...product, imageFitClass: productImageFit(product && product.imageUrl) };
}

module.exports = { productImageFit, withImageFit };
