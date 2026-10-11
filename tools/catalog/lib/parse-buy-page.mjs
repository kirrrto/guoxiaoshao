/**
 * Extract standard-configuration retail SKUs from an Apple China "buy" page.
 *
 * Pages embed `window.PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: {...} }`.
 * Two layouts exist:
 *  - selector pages (iPhone/iPad/AirPods/HomePod/Vision): `products[]` carry
 *    `partNumber` + `dimensionXxx` keys; labels live in `displayValues`.
 *  - configurator pages (Mac): `products[]` carry `btrOrFdPartNumber` for
 *    preconfigured retail SKUs (CTO-only bases have null) and a `dimensions`
 *    map; labels live in `mainDisplayValues`. Memory/storage option codes are
 *    not resolvable from the page, so Mac titles are partial until the pickup
 *    API returns Apple's own product title.
 *
 * Nothing here is a supply signal; it only describes which retail SKUs exist.
 */

import { imagePlan } from './product-images.mjs';

const decodeEntities = text => text
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/[\u2060\u200b]/g, '')
  .replace(/\u00a0/g, ' ')
  .replace(/\u2011/g, '-');

/** HTML label → array of text lines (block-level tags and helper spans start new lines). */
export function labelToText(html) {
  if (typeof html !== 'string') return null;
  const cleaned = html
    .replace(/<as-footnote[\s\S]*?<\/as-footnote>/gi, '')
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<span class="visuallyhidden">[\s\S]*?<\/span>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<(?:div|p|li|br|span class="(?:form-label-small|as-subheading|typography-caption)")[^>]*>/gi, '\n')
    .replace(/<\/(?:div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const lines = decodeEntities(cleaned).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.length ? lines : null;
}

/** Find the balanced JSON object that starts at `start` (which must be `{`). */
export function sliceBalancedJson(text, start) {
  if (text[start] !== '{') throw new Error('expected object start');
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unterminated JSON object');
}

export function extractProductSelectionData(html) {
  const anchor = html.indexOf('window.PRODUCT_SELECTION_BOOTSTRAP');
  if (anchor < 0) return null;
  const key = html.indexOf('productSelectionData', anchor);
  if (key < 0) return null;
  const brace = html.indexOf('{', key);
  return JSON.parse(sliceBalancedJson(html, brace));
}

export function extractBuyFlowGallery(html) {
  const anchor = html.indexOf('window.buyFlowGallery');
  if (anchor < 0) return null;
  try { return JSON.parse(sliceBalancedJson(html, html.indexOf('{', anchor))); } catch { return null; }
}

export function extractMetricsProducts(html) {
  const match = html.match(/<script type="application\/json" id="metrics">([\s\S]*?)<\/script>/);
  if (!match) return [];
  try {
    const products = JSON.parse(match[1])?.data?.products;
    return Array.isArray(products) ? products : [];
  } catch {
    return [];
  }
}

export function extractPageTitle(html) {
  const match = html.match(/<title>([^<]*)<\/title>/);
  if (!match) return null;
  return decodeEntities(match[1]).replace(/^(购买|选购)\s*/, '').replace(/\s*-\s*Apple.*$/, '').trim() || null;
}

const RETAIL_PART = /^[A-Z0-9]{5}CH\/A$/;
const BRAND_PREFIX = /^(iPhone|iPad|Mac|iMac|AirPods|HomePod|Apple)/;

/** Map upstream dimension keys onto stable attribute names. */
export function shortKey(dimension) {
  if (/cpuCoreCount/.test(dimension)) return 'chip';
  if (/dimensionChip$/.test(dimension)) return 'chipName';
  const idx = dimension.lastIndexOf('dimension');
  const tail = idx >= 0 ? dimension.slice(idx + 'dimension'.length) : dimension;
  const key = tail.replace(/^[A-Z]/, c => c.toLowerCase());
  return { screensize: 'screensize', color: 'color', capacity: 'capacity', connection: 'connection', finish: 'finish', memory: 'memory', bandsize: 'bandSize', tier: 'tier' }[key.toLowerCase()] ?? key;
}

function readLabel(displayValues, mainDisplayValues, dimension, value) {
  const entry = displayValues?.[dimension]?.[value] ?? mainDisplayValues?.[dimension]?.[value];
  if (entry === undefined || entry === null) return null;
  if (typeof entry === 'string') return labelToText(entry);
  const components = entry.dimensionComponents;
  if (components?.cpuCoreCount && components?.gpuCoreCount) {
    const detail = labelToText(entry.header ?? null);
    return [`${components.cpuCoreCount}核CPU/${components.gpuCoreCount}核GPU`, ...(detail ? detail.slice(1) : [])];
  }
  return labelToText(entry.value ?? entry.header ?? entry.label ?? entry.title ?? null);
}

/** Title order mirrors Apple's pickup titles: model, chip, connection, capacity, finish, color. */
const TITLE_ORDER = ['chipName', 'chip', 'memory', 'connection', 'capacity', 'finish', 'color'];

/**
 * Normalize one buy page into retail SKUs.
 * Returns { supported, reason, pageTitle, dimensions, products, rejected }.
 */
export function parseBuyPage(html, { category, familyKey, familySlug, sourceUrl, displayName = null }) {
  const pageTitle = extractPageTitle(html);
  const data = extractProductSelectionData(html);
  const gallery = extractBuyFlowGallery(html);
  if (!data) {
    return { supported: false, reason: 'no_product_selection_bootstrap', pageTitle, dimensions: [], products: [], rejected: [] };
  }
  const sections = Array.isArray(data.sections) && data.sections.length ? data.sections : (Array.isArray(data.mainSections) ? data.mainSections : []);
  const dimensionOrder = sections.map(section => section.formFieldName ?? section.dimension).filter(Boolean);
  const rawProducts = Array.isArray(data.products) ? data.products : [];
  const metrics = new Map(extractMetricsProducts(html).map(item => [item.partNumber, item]));
  const layout = rawProducts.some(product => 'btrOrFdPartNumber' in product) ? 'configurator' : 'selector';
  const baseName = displayName ?? pageTitle;

  const products = [];
  const rejected = [];
  for (const raw of rawProducts) {
    const partNumber = raw.partNumber ?? raw.btrOrFdPartNumber ?? raw.part ?? null;
    if (layout === 'configurator' && !raw.btrOrFdPartNumber) {
      rejected.push({ partNumber: raw.aosContainerPartNumber ?? null, reason: 'cto_only_base' });
      continue;
    }
    if (typeof partNumber !== 'string' || !RETAIL_PART.test(partNumber)) {
      rejected.push({ partNumber, reason: 'not_retail_part_number' });
      continue;
    }
    const dimensionValues = {};
    for (const [key, value] of Object.entries(raw)) {
      if (/(?:^|-)dimension(?!Steporder)/.test(key) && key !== 'dimensions' && typeof value === 'string') dimensionValues[key] = value;
    }
    if (raw.dimensions && typeof raw.dimensions === 'object') {
      for (const [key, value] of Object.entries(raw.dimensions)) if (typeof value === 'string') dimensionValues[key] = value;
    }
    const orderedDims = [...dimensionOrder.filter(d => d in dimensionValues), ...Object.keys(dimensionValues).filter(d => !dimensionOrder.includes(d))];

    const attributes = {};
    let model = null;
    for (const dimension of orderedDims) {
      const value = dimensionValues[dimension];
      const key = shortKey(dimension);
      const lines = readLabel(data.displayValues, data.mainDisplayValues, dimension, value);
      if (!lines) {
        attributes[key] = value;
        continue;
      }
      let primary = lines[0];
      if (key === 'screensize' || key === 'connection') primary = primary.replace(/机型$/, '').trim();
      if (key === 'capacity') primary = primary.replace(/\s*存储容量$/, '').replace(/^(\d+)\s+(GB|TB)\b/, '$1$2').trim();
      if (key === 'chipName') primary = primary.replace(/\s*芯片$/, '').trim();
      if (key === 'screensize' && !model) {
        model = BRAND_PREFIX.test(primary) ? primary : `${baseName ?? ''} ${primary}`.trim();
        attributes.screensize = primary;
        if (lines.length > 1) attributes.screensizeDetail = lines.slice(1).join(' · ');
        continue;
      }
      attributes[key] = primary;
      if (lines.length > 1) attributes[`${key}Detail`] = lines.slice(1).join(' · ');
    }
    if (!model) model = baseName;

    const metric = metrics.get(partNumber);
    let price = metric?.price?.fullPrice ?? null;
    if (price === null && typeof raw.price === 'string' && /^\d+_\d{2}$/.test(raw.price)) price = Number(raw.price.replace('_', '.'));
    for (const priceKey of [raw.priceKey, raw.fullPrice]) {
      if (price !== null || typeof priceKey !== 'string') continue;
      const amount = data.mainDisplayValues?.prices?.[priceKey]?.amount ?? data.displayValues?.prices?.[priceKey]?.amount;
      if (typeof amount === 'number') price = amount;
    }

    const titleParts = [];
    const pushPart = value => {
      if (!value || value === model) return;
      const trimmed = model && value.startsWith(`${model} `) ? value.slice(model.length + 1).trim() : value;
      if (trimmed && !titleParts.includes(trimmed)) titleParts.push(trimmed);
    };
    for (const key of TITLE_ORDER) pushPart(attributes[key]);
    for (const key of Object.keys(attributes)) {
      if (!TITLE_ORDER.includes(key) && key !== 'screensize' && !key.endsWith('Detail')) pushPart(attributes[key]);
    }
    const picture = imagePlan({ data, gallery, raw, dimensionValues, sourceUrl });
    products.push({
      partNumber,
      basePartNumber: raw.basePartNumber ?? partNumber.slice(0, 5),
      category,
      familyKey,
      familySlug,
      model,
      title: [model, ...titleParts].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      titleSource: layout === 'configurator' ? 'partial_page_labels' : 'page_labels',
      englishName: metric?.name ?? null,
      attributes,
      dimensionValues,
      priceCny: typeof price === 'number' && Number.isFinite(price) ? price : null,
      comingSoon: Boolean(raw.comingSoon ?? raw.isComingSoon),
      isCarrierDevice: Boolean(raw.isCarrierDevice),
      upstreamContainer: raw.aosContainerPartNumber ?? null,
      sourceUrl,
      ...(picture.image || {}),
      ...(picture.request ? { imageRequest: picture.request } : {}),
    });
  }
  const seen = new Set();
  const unique = products.filter(product => (seen.has(product.partNumber) ? false : (seen.add(product.partNumber), true)));
  return {
    supported: unique.length > 0,
    reason: unique.length ? null : (rejected.length ? 'only_component_parts' : 'no_products'),
    layout,
    pageTitle,
    dimensions: dimensionOrder,
    products: unique,
    rejected,
  };
}
