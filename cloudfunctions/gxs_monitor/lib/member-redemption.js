'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');

// Campaign identity stays stable across deployments, so changing request IDs or
// renewing an expired membership cannot redeem this campaign a second time.
const CAMPAIGN = Object.freeze({ id: 'launch_30d_v1', days: 30, productId: 'member_30d' });
const CODE_HASHES = [
  Buffer.from('b310f2af8fee342c601e00da10a5867f78ac748147735c0f72338c6d051f78b8', 'hex'),
  Buffer.from('f6c352ac727a292f52c2e116a151dad677c3d24d34fba2f16cb7c75b7bfbf229', 'hex'),
];
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const CLAIMS_ID = 'member_redemption_claims_launch_30d_v1';

function hashCode(code) {
  if (typeof code !== 'string' || code.length > 128) return null;
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}
function matchesCodeHash(hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false;
  const candidate = Buffer.from(hash, 'hex');
  return CODE_HASHES.some(expected => timingSafeEqual(candidate, expected));
}
function attemptsId(userKey) { return `member_redemption_attempts_${createHash('sha256').update(userKey).digest('hex')}`; }

module.exports = { CAMPAIGN, MAX_FAILURES, LOCK_MS, CLAIMS_ID, hashCode, matchesCodeHash, attemptsId };
