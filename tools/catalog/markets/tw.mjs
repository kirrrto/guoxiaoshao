// Verify catalog/markets/tw.json against saved Taiwan Apple Store product pages.
// Usage: node tools/catalog/markets/tw.mjs <directory-of-HTML> [--exact]
// Save family pages as <last segment of sourceUrl>.html. For Mac configuration
// pages use <familyKey>-<first 14 hex digits of sha256(sourceUrl)>.html.
// Every underlying URL is recorded in the catalog. No stock or network calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractProductSelectionData, extractMetricsProducts } from '../lib/parse-buy-page.mjs';

const [directory, mode] = process.argv.slice(2);
if (!directory || (mode && mode !== '--exact')) throw Error('Usage: node tools/catalog/markets/tw.mjs <cached HTML directory> [--exact]');
const hash = value => createHash('sha256').update(value).digest('hex');
const catalog = JSON.parse(fs.readFileSync(new URL('../../../catalog/markets/tw.json', import.meta.url)));
let checked = 0, reference = 0, linked = 0, changedBodies = 0;
for (const family of catalog.families) {
  const base = new URL(family.sourceUrl);
  assert.equal(base.origin, 'https://www.apple.com');
  assert.ok(base.pathname.startsWith('/tw/shop/buy-'));
  const html = fs.readFileSync(path.join(directory, path.basename(base.pathname) + '.html'), 'utf8');
  if (hash(html) !== family.sourceSha256) {
    changedBodies++;
    if (mode === '--exact') throw Error('Source snapshot changed: ' + family.familyKey);
  }
  const options = extractProductSelectionData(html)?.products;
  assert.ok(options?.length, 'No configuration selector on ' + family.sourceUrl);
  const roots = new Set(options.map(row => row.partNumber || row.btrOrFdPartNumber).filter(Boolean));
  const verified = new Set(), configurationUrls = new Set();
  for (const row of family.products) {
    assert.ok(row.partNumber && row.querySupported !== false && row.monitorSupported !== false);
    if (row.sourceUrl) {
      const selectionUrl = new URL(row.sourceUrl);
      assert.equal(selectionUrl.origin, base.origin);
      assert.ok(selectionUrl.pathname.startsWith(base.pathname + '/') && !selectionUrl.search && !selectionUrl.hash);
      assert.ok(html.includes(row.sourceUrl), 'Not linked from family page: ' + row.sourceUrl);
      const filename = family.familyKey + '-' + hash(row.sourceUrl).slice(0, 14) + '.html';
      const selections = extractMetricsProducts(fs.readFileSync(path.join(directory, filename), 'utf8'));
      assert.equal(selections.length, 1, filename);
      assert.equal(selections[0].category, 'mac', filename);
      assert.equal(selections[0].partNumber, row.partNumber, filename);
      configurationUrls.add(row.sourceUrl);
      linked++;
    } else assert.ok(roots.has(row.partNumber), 'Missing retail part on ' + family.sourceUrl + ': ' + row.partNumber);
    assert.ok(!verified.has(row.partNumber), 'Duplicate retail part: ' + row.partNumber);
    verified.add(row.partNumber);
    checked++;
  }
  if (verified.size) for (const part of roots) assert.ok(verified.has(part), 'Review added or removed retail part: ' + part);
  if (configurationUrls.size) {
    const links = new Set([...html.matchAll(/<a\b[^>]*?\shref\s*=\s*(["'])([\s\S]*?)\1/gi)]
      .map(match => match[2].trim()).filter(href => href.startsWith(family.sourceUrl + '/') && !/[?#]/.test(href)));
    assert.deepEqual(links, configurationUrls, 'Review links for ' + family.familyKey);
  }
}
console.log(JSON.stringify({ code: catalog.code, families: catalog.families.length, retail: checked, reference, linkedMacPages: linked, changedBodies }));
