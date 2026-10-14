// The eight verified Pro/Pro Max finish-select PNGs include transparent margins.
// Measured 2026-09-30: Pro 592x718 / 940x1112; Max 640x783 / 940x1112.
// Limit framing to these assets so other product silhouettes remain uncropped.
function productImageFit(imageUrl) {
  const match = /^https:\/\/store\.storeimages\.cdn-apple\.com\/1\/as-images\.apple\.com\/is\/iphone-18-pro(-max)?-finish-select-(black|silver|glacier|burgundy)-202609(?:\?|$)/.exec(String(imageUrl || ''));
  return match ? (match[1] ? 'product-image-fit-max' : 'product-image-fit-pro') : '';
}

// Keep the verified Apple CDN asset and its revision/signature parameters.
// Only request a smaller rendition for the thumbnail-sized mini-program views.
// The original imageUrl remains authoritative and is retried by image-error handlers.
const APPLE_IMAGE_PREFIX = 'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/';
const THUMBNAIL_WIDTH = 420;

function productThumbnailUrl(imageUrl) {
  const source = typeof imageUrl === 'string' ? imageUrl : '';
  if (!source.startsWith(APPLE_IMAGE_PREFIX)) return source;
  const width = /([?&])wid=(\d+)(?=&|$)/.exec(source);
  const height = /([?&])hei=(\d+)(?=&|$)/.exec(source);
  if (!width || !height) return source;
  const originalWidth = Number(width[2]), originalHeight = Number(height[2]);
  if (!Number.isSafeInteger(originalWidth) || !Number.isSafeInteger(originalHeight) ||
      originalWidth <= THUMBNAIL_WIDTH || originalHeight <= 0) return source;
  const thumbnailHeight = Math.max(1, Math.round(originalHeight * THUMBNAIL_WIDTH / originalWidth));
  return source.replace(/([?&])wid=\d+(?=&|$)/, '$1wid=' + THUMBNAIL_WIDTH)
    .replace(/([?&])hei=\d+(?=&|$)/, '$1hei=' + thumbnailHeight);
}

function withImageFit(product) {
  const imageUrl = product && product.imageUrl;
  return { ...product, imageFitClass: productImageFit(imageUrl), imageDisplayUrl: productThumbnailUrl(imageUrl) };
}

module.exports = { productImageFit, withImageFit, productThumbnailUrl };
