import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = require('../../cloudfunctions/gxs_api/lib/services/catalog.js').buildFromBundled();
// Public catalog only. Account data and permissions must always come from the server.
const fields = ['partNumber', 'category', 'familyKey', 'familyName', 'model', 'title', 'attributes', 'priceCny', 'comingSoon', 'supported', 'verificationStatus'];
const raw = {
  version: built.meta.version,
  families: built.meta.families,
  stores: built.stores.map(({ storeNumber, name, city, province, slug }) => ({ storeNumber, name, city, province, slug })),
  products: built.products.map(product => Object.fromEntries(fields.filter(key => product[key] !== undefined).map(key => [key, product[key]]))),
};
const target = path.join(root, 'miniprogram/config/catalog-seed.js');
fs.writeFileSync(target, '// Public browsing seed; refreshes from the cloud. No user data or inventory.\nmodule.exports = ' + JSON.stringify(raw) + ';\n', 'utf8');
console.log(JSON.stringify({ products: raw.products.length, stores: raw.stores.length, bytes: fs.statSync(target).size }));
