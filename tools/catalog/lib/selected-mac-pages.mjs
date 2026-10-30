import { parseSelectedMacConfiguration } from './parse-buy-page.mjs';
import { boundedGet, sleep } from './http.mjs';
import { retainPrelaunchRestriction } from './catalog-readiness.mjs';

// Follow only explicitly linked configuration pages on this exact CN family.
// A changed layout must not turn a catalog refresh into a general crawler.
export function selectedMacLinks(html, family, { maxPages = 48 } = {}) {
  if (family.category !== 'mac') return [];
  const base = new URL(family.url);
  if (base.origin !== 'https://www.apple.com.cn' || !/^\/shop\/buy-mac\/[^/]+\/?$/.test(base.pathname)) throw Error('invalid_mac_family_url');
  const prefix = base.pathname.replace(/\/$/, '') + '/';
  const links = new Set();
  for (const match of html.matchAll(/<a\b[^>]*?\shref\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    let url;
    try { url = new URL(match[2].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) continue;
    const slug = url.pathname.slice(prefix.length);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(slug)) continue;
    links.add(url.href);
    if (links.size > maxPages) throw Error(`too_many_mac_configuration_links:${family.familyKey}:${links.size}`);
  }
  return [...links];
}

export async function collectSelectedMacPages(html, family, parsed, { fetcher = boundedGet, intervalMs = 2000, maxPages = 48 } = {}) {
  if (family.category !== 'mac' || parsed.layout !== 'configurator') return parsed;
  const links = selectedMacLinks(html, family, { maxPages });
  const byPart = new Map(parsed.products.map(product => [product.partNumber, product]));
  const selectedParts = new Set();
  for (const url of links) {
    if (intervalMs > 0) await sleep(intervalMs);
    const result = await fetcher(url, { accept: 'text/html' });
    if (result.record.httpStatus !== 200) throw Error(`mac_configuration_http:${family.familyKey}:${result.record.httpStatus ?? 'error'}`);
    const product = parseSelectedMacConfiguration(result.text, { familyKey: family.familyKey,
      familySlug: new URL(family.url).pathname.split('/').filter(Boolean).at(-1), sourceUrl: url, displayName: family.displayName });
    if (!product) throw Error(`unresolved_mac_configuration:${url}`);
    if (selectedParts.has(product.partNumber)) throw Error(`duplicate_mac_configuration:${product.partNumber}`);
    selectedParts.add(product.partNumber);
    byPart.set(product.partNumber, retainPrelaunchRestriction(product, byPart.get(product.partNumber)));
  }
  return { ...parsed, products: [...byPart.values()], selectedPageCount: links.length };
}

// Previously verified retail configurations require explicit review before
// removal. Missing links, partial HTML or a changed upstream layout cannot
// silently turn a normal refresh into a destructive catalog replacement.
export function assertMacSkuCoverage(previousProducts, products, familyKeys) {
  const included = new Set(familyKeys);
  const present = new Set(products.map(product => `${product.familyKey}:${product.partNumber}`));
  const missing = previousProducts.filter(product => product.category === 'mac' && included.has(product.familyKey)
    && !present.has(`${product.familyKey}:${product.partNumber}`)).map(product => `${product.familyKey}:${product.partNumber}`);
  if (missing.length) throw Error(`mac_catalog_removal_requires_review:${missing.join(',')}`);
}
