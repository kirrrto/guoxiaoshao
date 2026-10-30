'use strict';
const { createHash } = require('node:crypto');

const RETAIL_PART_PATTERN = /^[A-Z0-9]{5}CH\/A$/;
const CTO_PART_PATTERN = /^CTO_[A-F0-9]{64}$/;
const PRODUCT_IDENTITY_PATTERN = /^(?:[A-Z0-9]{5}CH\/A|CTO_[A-F0-9]{64})$/;
const isCtoPartNumber = value => typeof value === 'string' && CTO_PART_PATTERN.test(value);
const isProductIdentity = value => typeof value === 'string' && PRODUCT_IDENTITY_PATTERN.test(value);

function canonicalCtoTarget(target) {
  if (!target || target.kind !== 'apple_cto' || typeof target.containerPartNumber !== 'string'
    || !/^RO_MACSTUDIO_[A-Z0-9_]{8,100}$/.test(target.containerPartNumber)
    || !Array.isArray(target.optionIds) || target.optionIds.length !== 8
    || target.optionIds.some(id => typeof id !== 'string' || !/^(?:[A-Z]{2})?065-[A-Z0-9]{4}$/.test(id))
    || new Set(target.optionIds).size !== target.optionIds.length) throw new TypeError('invalid_cto_pickup_target');
  return { kind: 'apple_cto', containerPartNumber: target.containerPartNumber, optionIds: [...target.optionIds].sort() };
}

function ctoPartNumber(target) {
  const normalized = canonicalCtoTarget(target);
  return `CTO_${createHash('sha256').update(JSON.stringify([normalized.containerPartNumber, normalized.optionIds])).digest('hex').toUpperCase()}`;
}

/** Only trusted catalog documents resolve CTO identities; request payloads never supply options. */
function resolvePickupTarget(product) {
  if (!product || !isProductIdentity(product.partNumber)) throw new TypeError('invalid_product_identity');
  if (isCtoPartNumber(product.partNumber)) {
    if (product.targetType !== 'apple_cto') throw new TypeError('missing_cto_target_type');
    const pickupTarget = canonicalCtoTarget(product.pickupTarget);
    if (ctoPartNumber(pickupTarget) !== product.partNumber) throw new TypeError('cto_identity_mismatch');
    return { partNumber: product.partNumber, targetType: 'apple_cto', pickupTarget,
      sourcePartNumber: pickupTarget.containerPartNumber,
      responseKey: pickupTarget.containerPartNumber + pickupTarget.optionIds.join('') };
  }
  if (product.targetType && product.targetType !== 'retail') throw new TypeError('retail_target_type_mismatch');
  if (product.pickupTarget) throw new TypeError('retail_target_override');
  return { partNumber: product.partNumber, targetType: 'retail', sourcePartNumber: product.partNumber, responseKey: product.partNumber };
}

function canQueryProduct(product) {
  if (!product) return false;
  if (isCtoPartNumber(product.partNumber)) {
    try { resolvePickupTarget(product); } catch (_) { return false; }
    return product.querySupported === true && !product.comingSoon;
  }
  return product.comingSoon !== true && (product.querySupported === undefined ? product.supported !== false : product.querySupported === true);
}

function canMonitorProduct(product) {
  if (!product) return false;
  if (isCtoPartNumber(product.partNumber)) {
    try { resolvePickupTarget(product); } catch (_) { return false; }
    return product.monitorSupported === true && product.supported === true && !product.comingSoon;
  }
  return product.monitorSupported === undefined ? product.supported === true : product.monitorSupported === true;
}

module.exports = { RETAIL_PART_PATTERN, CTO_PART_PATTERN, PRODUCT_IDENTITY_PATTERN, isCtoPartNumber, isProductIdentity,
  canonicalCtoTarget, ctoPartNumber, resolvePickupTarget, canQueryProduct, canMonitorProduct };
