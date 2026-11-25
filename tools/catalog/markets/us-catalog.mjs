import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function verifyUsCatalog(us, expectedFamilies, mainland) {
  assert.equal(us.code, 'US');
  assert.deepEqual(us.families.map(f => f.familyKey), expectedFamilies.map(f => f.familyKey));
  const mainlandParts = new Set(mainland.map(p => p.partNumber));
  const seenParts = new Set();
  const categories = new Set();
  for (const family of us.families) {
    assert.ok(['iphone', 'ipad', 'mac', 'airpods', 'homepod'].includes(family.category), family.category);
    categories.add(family.category);
    assert.match(family.sourceUrl || '', /^https:\/\/www\.apple\.com\/shop\/buy-/);
    assert.ok(Array.isArray(family.products) && family.products.length > 0, family.familyKey);
    for (const product of family.products) {
      assert.match(product.partNumber || '', /^[A-Z0-9]{5,12}\/A$/);
      assert.equal(seenParts.has(product.partNumber), false, 'Duplicate US SKU: ' + product.partNumber);
      seenParts.add(product.partNumber);
      assert.notEqual(product.querySupported, false);
      assert.notEqual(product.monitorSupported, false);
      assert.ok(product.title && product.titleEn && product.model, product.partNumber);
      if (product.artworkPart) assert.ok(mainlandParts.has(product.artworkPart), 'Unknown artworkPart: ' + product.artworkPart);
    }
  }
  assert.deepEqual([...categories].sort(), ['airpods', 'homepod', 'ipad', 'iphone', 'mac']);
  return { checked: true, code: 'US', families: us.families.length, products: seenParts.size };
}

// An incomplete storefront response can still look like a valid catalog. Compare
// the exact family/SKU pairs with the last reviewed file before replacing it.
export function replaceUsCatalog(destination, candidate, expectedFamilies, mainland) {
  // Reserve the replacement before reading its baseline. Another refresh may
  // have accepted additional SKUs while this candidate was being fetched.
  const staging = path.join(path.dirname(destination), '.us-catalog-replacement');
  fs.mkdirSync(staging);
  try {
    const previous = JSON.parse(fs.readFileSync(destination, 'utf8'));
    assert.equal(previous.code, 'US');
    const pairs = catalog => catalog.families.flatMap(family =>
      family.products.map(product => family.familyKey + ':' + product.partNumber));
    const present = new Set(pairs(candidate));
    const missing = pairs(previous).filter(key => !present.has(key));
    if (missing.length) throw Error('us_catalog_removal_requires_review: ' + missing.join(', '));
    verifyUsCatalog(candidate, expectedFamilies, mainland);
    const staged = path.join(staging, 'us.json');
    fs.writeFileSync(staged, JSON.stringify(candidate, null, 2) + '\n');
    fs.renameSync(staged, destination);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
