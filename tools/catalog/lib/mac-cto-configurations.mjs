import { createHash } from 'node:crypto';

export const MAC_CTO_DIMENSIONS = {
  chip: 'processor-dimensionChip-cpuCoreCount-gpuCoreCount',
  memory: 'memory-dimensionMemory',
  storage: 'storage-dimensionCapacity',
};

export function configurationRequestUrl(collection, expected) {
  if (!/^[A-Z0-9_]+$/.test(collection)) throw Error('invalid_cto_collection');
  const url = new URL('https://www.apple.com.cn/shop/api/cto/update-config');
  url.searchParams.set('collection', collection);
  url.searchParams.set('fae', 'true');
  url.searchParams.set('sv.processor-dimensionChip', expected.chip.split('-')[0]);
  for (const [key, dimension] of Object.entries(MAC_CTO_DIMENSIONS)) url.searchParams.set('sv.' + dimension, expected[key]);
  url.searchParams.set('sv.software_final-preInstalledSoftware', 'none');
  url.searchParams.set('sv.software_logic-preInstalledSoftware', 'none');
  return url.href;
}

// The server may adjust dependent selections. Only the exact requested result
// can become a target; neither compatible options nor a shared container suffice.
export function parseExactMacConfiguration(response, expected) {
  const kit = response?.body?.selectedKits;
  if (String(response?.head?.status) !== '200' || response?.body?.isReset || !kit) throw Error('invalid_cto_response');
  for (const [key, dimension] of Object.entries(MAC_CTO_DIMENSIONS)) {
    if (kit.dimensions?.[dimension]?.dimensionValue !== expected[key]) throw Error(`cto_selection_mismatch:${key}`);
    const option = response.body.options?.[dimension]?.compatibleOptions?.[expected[key]];
    if (!option || option.isBlocked !== false) throw Error(`cto_selection_blocked:${key}`);
  }
  const config = kit.productConfiguration;
  const required = ['memory','thunderbolt','storage','ethernet_adapter','countrykit','software_final','processor','software_logic'];
  if (!config || required.some(key => !/^(?:CH)?065-[A-Z0-9]+$/.test(config[key] || '')) || Object.keys(config).length !== required.length) throw Error('invalid_cto_option_identifiers');
  const optionIds = Object.values(config).sort();
  if (new Set(optionIds).size !== optionIds.length || !/^RO_MACSTUDIO_[A-Z0-9_]+$/.test(kit.aosContainerPartNumber || '')) throw Error('invalid_cto_identity');
  if (kit.dimensions['software_final-preInstalledSoftware']?.dimensionValue !== 'none' || kit.dimensions['software_logic-preInstalledSoftware']?.dimensionValue !== 'none') throw Error('unexpected_cto_software');
  for (const [key, dimension] of Object.entries(MAC_CTO_DIMENSIONS)) {
    const optionKey = key === 'chip' ? 'processor' : key;
    if (kit.dimensions[dimension].partNumber !== config[optionKey]) throw Error(`cto_option_dimension_mismatch:${key}`);
  }
  const retailPartNumber = kit.btrOrFdPartNumber || null;
  if (retailPartNumber && !/^[A-Z0-9]{5}CH\/A$/.test(retailPartNumber)) throw Error('invalid_cto_retail_part');
  if (!Number.isFinite(kit.priceData?.amount) || kit.priceData.amount <= 0) throw Error('invalid_cto_price');
  return { ...expected, retailPartNumber, containerPartNumber: kit.aosContainerPartNumber, optionIds,
    productConfiguration: config, priceCny: kit.priceData.amount, dimensions: kit.dimensions };
}

export const configurationIdentity = expected => `${expected.chip}-${expected.memory}-${expected.storage}`;
export const responseHash = text => createHash('sha256').update(text).digest('hex');
