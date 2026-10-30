import { createRequire } from 'node:module';
import { parseExactMacConfiguration, responseHash, configurationIdentity } from './mac-cto-configurations.mjs';
const require = createRequire(import.meta.url);
const { ctoPartNumber } = require('../../../cloudfunctions/gxs_api/lib/rules/product-target.js');

export function applyMacConfigurationCapture(input, capture, { generatedAt = new Date().toISOString() } = {}) {
  if (!capture?.complete || capture.familyKey !== 'mac-studio' || capture.errors?.length || capture.configurations?.length !== capture.candidateCount) throw Error('incomplete_mac_configuration_capture');
  const catalog = structuredClone(input);
  const family = catalog.families.find(f => f.familyKey === capture.familyKey);
  const chips = family?.officialConfigurations?.chips;
  if (!chips?.length) throw Error('missing_verified_configuration_ranges');
  const expected = new Set(chips.flatMap(chip => chip.memoryValues.flatMap(memory => chip.storageValues.map(storage => configurationIdentity({ chip: chip.chipId, memory: memory.toLowerCase(), storage: storage.toLowerCase() })))));
  if (expected.size !== capture.candidateCount) throw Error('configuration_range_changed');
  const prior = catalog.products.filter(p => p.familyKey === family.familyKey);
  const template = prior.find(p => p.partNumber === 'MHL64CH/A');
  if (!template?.imageUrl) throw Error('missing_verified_studio_image');
  const images = Object.fromEntries(Object.entries(template).filter(([key]) => key.startsWith('image')));
  const resolved = [], identities = new Set(), retailIds = new Set();
  for (const row of capture.configurations) {
    if (row.request?.httpStatus !== 200 || row.canonicalResponseSha256 !== responseHash(JSON.stringify(row.response))) throw Error('invalid_configuration_evidence');
    const exact = parseExactMacConfiguration(row.response, row.expected);
    if (!expected.delete(configurationIdentity(exact))) throw Error('duplicate_or_unexpected_configuration');
    const chip = chips.find(c => c.chipId === exact.chip);
    const attributes = { chipName: chip.chipName, chip: chip.chip, memory: exact.memory.toUpperCase(), capacity: exact.storage.toUpperCase() };
    if (exact.retailPartNumber) {
      const old = prior.find(p => p.partNumber === exact.retailPartNumber);
      if (!old || Object.entries(attributes).some(([k,v]) => old.attributes[k] !== v)) throw Error('retail_configuration_mismatch');
      retailIds.add(old.partNumber); resolved.push(old); continue;
    }
    if (prior.some(p => p.targetType !== 'apple_cto' && Object.entries(attributes).every(([k,v]) => p.attributes[k] === v))) throw Error('unresolved_retail_configuration_alias');
    const pickupTarget = { kind: 'apple_cto', containerPartNumber: exact.containerPartNumber, optionIds: exact.optionIds };
    const partNumber = ctoPartNumber(pickupTarget);
    if (identities.has(partNumber)) throw Error('duplicate_exact_configuration_identity');
    identities.add(partNumber);
    resolved.push({ partNumber, targetType: 'apple_cto', pickupTarget,
      category: 'mac', familyKey: family.familyKey, familySlug: family.familyKey, model: 'Mac Studio',
      title: ['Mac Studio',attributes.chipName,attributes.chip,attributes.memory,attributes.capacity].join(' '),
      titleSource: 'official_cto_selected_dimensions', attributes,
      dimensionValues: Object.fromEntries(Object.entries(exact.dimensions).map(([key,value]) => [key,value.dimensionValue])),
      priceCny: exact.priceCny, comingSoon: false, isCarrierDevice: false, querySupported: false,
      monitorSupported: false, supported: false,
      pickupVerification: { verified: false, status: 'not_applicable', reason: 'apple_configured_mac_no_store_pickup' },
      configurationVerification: { verified: true, checkedAt: row.request.finishedAt, sourceUrl: row.request.requestUrl, sha256: row.request.sha256 },
      sourceUrl: family.url, ...images });
  }
  if (expected.size || prior.filter(p => p.targetType !== 'apple_cto').some(p => !retailIds.has(p.partNumber))) throw Error('configuration_coverage_missing');
  const start = catalog.products.findIndex(p => p.familyKey === family.familyKey);
  catalog.products = catalog.products.filter(p => p.familyKey !== family.familyKey);
  catalog.products.splice(start, 0, ...resolved);
  family.productCount = resolved.length;
  family.officialConfigurations = { ...family.officialConfigurations, querySupport: 'retail_query_cto_reference_only',
    exactConfigurationsVerified: resolved.length, retailConfigurations: retailIds.size, ctoConfigurations: identities.size,
    configurationCheckedAt: capture.checkedAt };
  catalog.generatedAt = generatedAt; catalog.imagesGeneratedAt = generatedAt;
  catalog.kind = 'apple-product-target-catalog-cn';
  catalog.note = '中国大陆官网标准零售 SKU 与逐项核实的 Mac Studio 定制配置。CTO_ 编号是完整官方配置的稳定内部身份，不是零售货号；官网定制 Mac 不支持 Apple Store 店内取货，定制项仅作配置参考，不参与取货查询或自动关注。';
  catalog.count = catalog.products.length; catalog.imageCount = catalog.products.filter(p => p.imageUrl).length;
  return catalog;
}
