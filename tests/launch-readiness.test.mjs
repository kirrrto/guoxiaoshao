import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { checkLaunchReadiness } from '../tools/catalog/check-launch-readiness.mjs';
const require = createRequire(import.meta.url);
const catalog = JSON.parse(fs.readFileSync(new URL('../catalog/products.json', import.meta.url), 'utf8'));
const launches = require('../miniprogram/config/product-launches');

test('launch check accurately leaves eight unsampled Duo variants unavailable regardless of calendar', () => {
  // Preserve the pre-verification case even after the bundled catalog refreshes.
  const unsampled = structuredClone(catalog);
  for (const product of unsampled.products.filter(p => p.familyKey === 'iphone-duo')) product.comingSoon = true;
  unsampled.families.find(f => f.familyKey === 'iphone-duo').pickupVerification = {
    sampledPartNumber: null, status: 'all_coming_soon', verified: false,
  };
  const result = checkLaunchReadiness({ catalog: unsampled, launches, asOf: '2026-10-11' });
  assert.equal(result.passed, true, JSON.stringify(result.errors));
  const duo = result.launches.find(row => row.familyKey === 'iphone-duo');
  assert.equal(duo.catalogProductCount, 8);
  assert.equal(duo.comingSoonCount, 8);
  assert.equal(duo.effectiveSupportedCount, 0);
  assert.equal(duo.sampledPartNumber, null);
  assert.equal(duo.operationalStatus, 'not_open_for_query_or_monitoring');
  assert.equal(checkLaunchReadiness({ catalog: unsampled, launches, asOf: '2027-01-01' }).launches[0].effectiveSupportedCount, 0);
});

test('refreshed Duo catalog uses real pickup verification while keeping official launch dates', () => {
  const result = checkLaunchReadiness({ catalog, launches, asOf: '2026-10-14' });
  assert.equal(result.passed, true, JSON.stringify(result.errors));
  const duo = result.launches.find(row => row.familyKey === 'iphone-duo');
  assert.equal(duo.catalogProductCount, 8);
  assert.equal(duo.comingSoonCount, 0);
  assert.equal(duo.effectiveSupportedCount, 8);
  assert.equal(duo.pickupVerificationStatus, 'ineligible');
  assert.equal(duo.preorderAt, '2026-10-16T20:00:00+08:00');
  assert.equal(duo.releaseDate, '2026-10-23');
  const observations = ['iphone-duo', 'iphone-duo-extra'].flatMap(name => JSON.parse(fs.readFileSync(
    new URL(`../evidence/pickup-samples/2026-10-14/${name}.json`, import.meta.url), 'utf8')).observations);
  const parts = catalog.products.filter(p => p.familyKey === 'iphone-duo').map(p => p.partNumber);
  assert.deepEqual(new Set(observations.map(o => o.partNumber)), new Set(parts));
  assert.ok(observations.every(o => o.status === 'ineligible' && o.productTitle));
});

test('launch check rejects missing or deceptive official sources, malformed dates and absent catalog family', () => {
  for (const sourceUrl of ['', 'http://www.apple.com.cn/newsroom', 'https://www.apple.com.cn.evil.example/newsroom', 'https://www.apple.com.cn@evil.example/newsroom']) {
    assert.equal(checkLaunchReadiness({ catalog, launches: [{ ...launches[0], sourceUrl }], asOf: '2026-10-11' }).passed, false);
  }
  for (const patch of [{ verifiedOn: '2026-10-12' }, { verifiedOn: '2026-02-30' }, { preorderAt: '2026-10-16T20:00:00' }, { familyKey: 'not-a-real-family' }]) {
    assert.equal(checkLaunchReadiness({ catalog, launches: [{ ...launches[0], ...patch }], asOf: '2026-10-11' }).passed, false);
  }
});
