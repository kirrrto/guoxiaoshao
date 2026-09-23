'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');

// Campaign identity stays stable across deployments, so changing request IDs or
// renewing an expired membership cannot redeem this campaign a second time.
const CAMPAIGN = Object.freeze({ id: 'launch_30d_v1', days: 30, productId: 'member_30d' });
const EXPECTED_HASH = Buffer.from('b310f2af8fee342c601e00da10a5867f78ac748147735c0f72338c6d051f78b8', 'hex');
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function hashCode(code) {
  if (typeof code !== 'string' || code.length > 128) return null;
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}
function matchesCodeHash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(hash, 'hex'), EXPECTED_HASH);
}
function attemptsId(userKey) { return `member_redemption_attempts_${createHash('sha256').update(userKey).digest('hex')}`; }
// Campaign-wide claim counter in gxs_config, incremented in the redemption transaction.
const CLAIMS_ID = `member_redemption_claims_${CAMPAIGN.id}`;

module.exports = { CAMPAIGN, MAX_FAILURES, LOCK_MS, CLAIMS_ID, hashCode, matchesCodeHash, attemptsId };
