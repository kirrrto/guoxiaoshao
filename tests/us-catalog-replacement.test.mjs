import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { replaceUsCatalog } from '../tools/catalog/markets/us-catalog.mjs';

const require = createRequire(import.meta.url);
const current = require('../catalog/markets/us.json');
const { products } = require('../catalog/products.json');

test('the US refresh preserves the reviewed file on a missing or replaced SKU and accepts additions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-us-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const destination = path.join(dir, 'us.json');
  const original = JSON.stringify(current);
  fs.writeFileSync(destination, original);

  for (const category of ['iphone', 'mac', 'homepod']) {
    const candidate = structuredClone(current);
    const family = candidate.families.find(row => row.category === category && row.products.length > 1);
    const missing = family.products.pop();
    if (category === 'mac') family.products.push({ ...missing, partNumber: 'ABCDELL/A' });
    assert.throws(() => replaceUsCatalog(destination, candidate, current.families, products),
      error => error.message.includes('us_catalog_removal_requires_review: ' + family.familyKey + ':' + missing.partNumber));
    assert.equal(fs.readFileSync(destination, 'utf8'), original);
  }

  const emptyFamily = structuredClone(current);
  emptyFamily.families[0].products = [];
  assert.throws(() => replaceUsCatalog(destination, emptyFamily, current.families, products), /us_catalog_removal_requires_review/);
  assert.equal(fs.readFileSync(destination, 'utf8'), original);

  const candidate = structuredClone(current);
  candidate.families[0].products.push({ ...candidate.families[0].products[0], partNumber: 'ABCDELL/A' });
  // Interleave a stale writer after validation and before publication.
  const rename = fs.renameSync;
  const hook = t.mock.method(fs, 'renameSync', (from, to) => {
    assert.throws(() => replaceUsCatalog(destination, current, current.families, products), { code: 'EEXIST' });
    return rename(from, to);
  });
  replaceUsCatalog(destination, candidate, current.families, products);
  hook.mock.restore();
  assert.throws(() => replaceUsCatalog(destination, current, current.families, products), /us_catalog_removal_requires_review/);
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), candidate);
});
