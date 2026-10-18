// The eight verified Pro/Pro Max finish-select PNGs include transparent margins.
// Measured 2026-09-30: Pro 592x718 / 940x1112; Max 640x783 / 940x1112.
// Limit framing to these assets so other product silhouettes remain uncropped.
function productImageFit(imageUrl) {
  const match = /^https:\/\/store\.storeimages\.cdn-apple\.com\/1\/as-images\.apple\.com\/is\/iphone-18-pro(-max)?-finish-select-(black|silver|glacier|burgundy)-202609(?:\?|$)/.exec(String(imageUrl || ''));
  return match ? (match[1] ? 'product-image-fit-max' : 'product-image-fit-pro') : '';
}

// Apple catalog images are verified as full, byte-for-byte CDN URLs.
// Changing wid/hei created failed image requests in WeChat 3.17.3.
// Until every smaller rendition is verified end-to-end, fail closed:
// display the exact original URL without generating unverified dimensions.
function productThumbnailUrl(imageUrl) {
  return typeof imageUrl === 'string' ? imageUrl : '';
}

function withImageFit(product) {
  const imageUrl = product && product.imageUrl;
  return { ...product, imageFitClass: productImageFit(imageUrl), imageDisplayUrl: productThumbnailUrl(imageUrl) };
}

module.exports = { productImageFit, withImageFit, productThumbnailUrl };
