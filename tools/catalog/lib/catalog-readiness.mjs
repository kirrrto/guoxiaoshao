// A catalog refresh cannot retire a reviewed prelaunch restriction. Opening a
// product requires a separate reviewed catalog change, never a calendar date.
export function retainPrelaunchRestriction(product, previous) {
  const current = previous?.comingSoon === true ? { ...product, comingSoon: true } : product;
  // A specification-page refresh does not collect pickup observations.
  const verification = previous?.pickupVerification;
  return verification && verification.sampledPartNumber === product.partNumber
    ? { ...current, pickupVerification: verification } : current;
}

export function retainPrelaunchRestrictions(products, previousProducts) {
  const previous = new Map(previousProducts.map(product => [`${product.familyKey}:${product.partNumber}`, product]));
  return products.map(product => retainPrelaunchRestriction(product, previous.get(`${product.familyKey}:${product.partNumber}`)));
}

// Family-wide sampling cannot certify an individually reviewed SKU. Rebuild
// the family summary from the retained retail receipts, including their times.
export function exactRetailSummary(products) {
  const verified = products.filter(p => p.targetType !== 'apple_cto' && !p.comingSoon
    && p.pickupVerification?.sampledPartNumber === p.partNumber && p.pickupVerification.verified
    && ['available', 'unavailable', 'ineligible'].includes(p.pickupVerification.status));
  if (!verified.length) return null;
  return { ...verified[0].pickupVerification, sampledPartNumbers: verified.map(p => p.partNumber), reason: null };
}

export function buildPickupVerification({ observation, storeNumber, sampledPartNumber = null, skipped = 'not_sampled', checkedAt }) {
  return {
    checkedAt: observation ? observation.observedAt : checkedAt,
    storeNumber,
    sampledPartNumber,
    status: observation ? observation.status : skipped,
    reason: observation?.reason?.code ?? null,
    verified: Boolean(observation && ['available', 'unavailable', 'ineligible'].includes(observation.status)),
  };
}
