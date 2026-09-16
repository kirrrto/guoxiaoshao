#!/usr/bin/env node
/**
 * Copy the generated catalog (catalog/stores.json, catalog/products.json) into
 * the gxs_api cloud function so code and catalog version deploy together.
 * The operator action `admin.seedCatalog` then upserts them into the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = path.join(root, 'catalog');
const target = path.join(root, 'cloudfunctions', 'gxs_api', 'catalog');
fs.mkdirSync(target, { recursive: true });

const manifest = { syncedAt: new Date().toISOString(), files: {} };
for (const name of ['stores.json', 'products.json']) {
  const from = path.join(source, name);
  if (!fs.existsSync(from)) {
    console.error(`missing ${from}; run npm run catalog:stores / catalog:products first`);
    process.exit(1);
  }
  const body = fs.readFileSync(from);
  JSON.parse(body.toString('utf8'));
  fs.writeFileSync(path.join(target, name), body);
  manifest.files[name] = { bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}
fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
// Keep first-launch browsing data aligned with the same bundled catalog.
await import('./build-client-catalog.mjs');
