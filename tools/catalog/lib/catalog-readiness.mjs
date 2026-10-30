// A catalog refresh cannot retire a reviewed prelaunch restriction. Opening a
// product requires a separate reviewed catalog change, never a calendar date.
export function retainPrelaunchRestriction(product, previous) {
  return previous?.comingSoon === true ? { ...product, comingSoon: true } : product;
}

export function retainPrelaunchRestrictions(products, previousProducts) {
  const previous = new Map(previousProducts.map(product => [`${product.familyKey}:${product.partNumber}`, product]));
  return products.map(product => retainPrelaunchRestriction(product, previous.get(`${product.familyKey}:${product.partNumber}`)));
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
