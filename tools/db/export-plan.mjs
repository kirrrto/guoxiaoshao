// Generates reviewable deployment inputs only. This command never connects to
// CloudBase, changes a rule, creates an index or prints any credentials.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { COLLECTIONS, INDEX_PLAN } = require('../../cloudfunctions/gxs_api/lib/collections.js');
const output = new URL('../../config/database-deployment-plan.json', import.meta.url);
await mkdir(new URL('../../config/', import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify({
  purpose: 'Apply the rules to each named collection and add missing indexes; do not replace or delete existing indexes.',
  deployed: false,
  collections: Object.values(COLLECTIONS).map(collectionName => ({ collectionName, rules: { read: false, write: false }, indexes: INDEX_PLAN[collectionName] || [] })),
}, null, 2) + '\n', 'utf8');
console.log(fileURLToPath(output));
