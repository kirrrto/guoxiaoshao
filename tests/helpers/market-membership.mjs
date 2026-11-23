export function marketMembership(now, planId, remainingMs = 86400000) {
  const at = new Date(now);
  return {
    expiresAt: new Date(at.getTime() + remainingMs).toISOString(),
    entitlements: { version: 1, planMetadataVersion: 1, settledAt: at.toISOString(), segments: [
      { orderId: 'fixture-' + planId, source: planId === 'member_trial' ? 'trial_compensation' : 'virtual_payment', planId, remainingMs },
    ] },
  };
}
