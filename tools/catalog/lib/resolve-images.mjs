import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { boundedGet, sleep } from './http.mjs';
import { imageFromGalleryResponse } from './product-images.mjs';

export async function resolveProductImages(products, { cacheDir, offline = false, onProgress = () => {}, fetcher = boundedGet, intervalMs = 750 } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const requests = new Map();
  for (const product of products) if (product.imageRequest) requests.set(product.imageRequest.identity, product.imageRequest);
  const resolved = new Map();
  const evidence = [];
  let fetched = 0;
  for (const [identity, request] of requests) {
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const cacheFile = join(cacheDir, `${key}.json`);
    let cached;
    try { cached = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
    if (!cached && !offline) {
      if (fetched) await sleep(intervalMs);
      const result = await fetcher(request.url);
      fetched++;
      let response = null;
      try { response = JSON.parse(result.text); } catch {}
      cached = { identity, request, record: result.record, response };
      await writeFile(cacheFile, JSON.stringify(cached, null, 2) + '\n');
      if ([403, 429, 541].includes(result.record.httpStatus)) throw new Error(`gallery_access_or_rate_limit:${result.record.httpStatus}`);
    }
    const image = cached && cached.record.httpStatus === 200 && imageFromGalleryResponse(cached.response, request);
    if (image) {
      const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const keyText = normalize(image.imageKey);
      for (const [dimension, value] of Object.entries(request.matchDimensions)) {
        if (/dimensionColor|dimensionScreensize/.test(dimension) && !keyText.includes(normalize(value))) {
          throw new Error(`gallery_image_dimension_mismatch:${identity}:${dimension}:${image.imageKey}`);
        }
      }
      resolved.set(identity, image);
    }
    const entry = { identity, requestUrl: request.url, cacheFile: key + '.json', httpStatus: cached && cached.record.httpStatus || null,
      sha256: cached && cached.record.sha256 || null, fetchedAt: cached && cached.record.finishedAt || null, imageKey: image && image.imageKey || null, matched: Boolean(image) };
    evidence.push(entry); onProgress(entry);
  }
  for (const product of products) {
    if (!product.imageRequest) continue;
    const image = resolved.get(product.imageRequest.identity);
    if (image) { Object.assign(product, image); delete product.imageRequest; delete product.imageUnavailableReason; }
    else {
      // Keep the unresolved request for diagnosis, but do not retain a previous
      // selection's URL when the current selection could not be verified.
      for (const key of Object.keys(product)) if (key.startsWith('image') && key !== 'imageRequest') delete product[key];
      product.imageUnavailableReason = offline ? 'gallery_not_cached' : 'gallery_image_unavailable';
    }
  }
  return { fetched, evidence, missing: products.filter(p => !p.imageUrl).map(p => p.partNumber) };
}
