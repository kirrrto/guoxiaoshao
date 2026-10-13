/** Image identities come only from Apple's embedded SKU dictionary or gallery. */
export const IMAGE_HOSTS = new Set(['store.storeimages.cdn-apple.com', 'storeimages.cdn-apple.com']);

export function isOfficialImageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname); } catch { return false; }
}

export function imageFromDescriptor(image, { source, sourceUrl, matchDimensions = {}, imageKey = null } = {}) {
  if (!image || image.noImage) return null;
  const sources = Array.isArray(image.sources) ? image.sources : [];
  const preferred = sources.find(s => s.type === 'image/png') || sources.find(s => s.type === 'image/jpeg') || sources[0];
  const originalUrl = preferred && typeof preferred.srcSet === 'string' ? preferred.srcSet.trim().split(/\s+(?:\d+(?:\.\d+)?[wx])(?:\s*,\s*|$)/)[0] : null;
  if (!isOfficialImageUrl(originalUrl)) return null;
  const url = new URL(originalUrl);
  const width = Number(url.searchParams.get('wid')) || Number(image.width);
  const height = Number(url.searchParams.get('hei')) || Number(image.height);
  // Preserve the exact signed rendition. Changing wid/hei while retaining .v
  // was verified to return HTTP 404; source identity alone is not sufficient.
  return { imageUrl: url.href, imageAlt: typeof image.alt === 'string' ? image.alt.replace(/<[^>]*>/g, '').replace(/\u00a0/g, ' ').trim() : '',
    imageWidth: width || null, imageHeight: height || null, imageKey: imageKey || image.imageName || image.originalImageName || null,
    imageSource: source, imageSourceUrl: sourceUrl, imageOriginalUrl: originalUrl, imageMatchDimensions: matchDimensions };
}

export function imagePlan({ data, gallery, raw, dimensionValues, sourceUrl }) {
  const descriptor = raw.imageKey && data.imageDictionary && data.imageDictionary[raw.imageKey];
  const exact = imageFromDescriptor(descriptor, { source: 'apple-selector', sourceUrl, matchDimensions: dimensionValues, imageKey: raw.imageKey });
  if (exact) return { image: exact, request: null };
  const summary = gallery && gallery.productGalleryData && gallery.productGalleryData.summary;
  const required = summary && summary.warmStateImageSetRules || [];
  const galleryDimensions = { ...dimensionValues };
  // The iMac retail rows explicitly name STAND containers, while the page
  // labels desktop as 支架 and vesa as VESA 支架转换器. Standard retail rows
  // omit this fixed option from dimensions; include that observed fixed option
  // so Apple's summary gallery can resolve its complete selection.
  if (required.includes('chassis-dimensionStandType') && !galleryDimensions['chassis-dimensionStandType']
      && /_STAND_/.test(raw.aosContainerPartNumber || '') && data.configDisplayValues?.['chassis-dimensionStandType']?.desktop) {
    galleryDimensions['chassis-dimensionStandType'] = 'desktop';
  }
  const visualKeys = Object.keys(dimensionValues).filter(k => /color|screensize|finish|charging/i.test(k));
  const summaryImage = summary && summary.coldStateGalleries && summary.coldStateGalleries.length === 1 && summary.coldStateGalleries[0].asset && summary.coldStateGalleries[0].asset.image;
  // A family summary is safe only when these retail choices have no appearance
  // selection. Never substitute a multi-colour cold-state collage for a SKU.
  if (summaryImage && !visualKeys.length) {
    const image = imageFromDescriptor(summaryImage, { source: 'apple-family-summary', sourceUrl, matchDimensions: dimensionValues });
    if (image) return { image, request: null };
  }
  if (!gallery || !gallery.productGalleryUrl || !required.length) return { image: null, request: null };
  const url = new URL(gallery.productGalleryUrl, sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.apple.com.cn' || !/^\/shop\/api\/(?:kit-)?product-gallery$/.test(url.pathname)) return { image: null, request: null };
  // Apple's step1evolution.js sends one dm.<dimension>=value parameter per
  // selected gallery dimension, not a JSON blob in dm and not a guessed URL.
  for (const [key, value] of Object.entries(galleryDimensions)) {
    if (gallery.productGalleryData[key] || required.includes(key)) url.searchParams.set(`dm.${key}`, value);
  }
  const matching = Object.fromEntries(required.filter(k => galleryDimensions[k]).map(k => [k, galleryDimensions[k]]));
  return { image: null, request: { url: url.href, matchDimensions: matching, requiredDimensions: required,
    identity: `${new URL(sourceUrl).pathname}|${JSON.stringify(matching)}` } };
}

export function imageFromGalleryResponse(body, request) {
  if (!body || !body.head || ![200, '200'].includes(body.head.status)) return null;
  const summary = body.body && body.body.summary;
  if (!Array.isArray(summary) || !summary.length) return null;
  const image = summary[0] && summary[0].asset && summary[0].asset.image;
  return imageFromDescriptor(image, { source: 'apple-gallery', sourceUrl: request.url, matchDimensions: request.matchDimensions });
}
