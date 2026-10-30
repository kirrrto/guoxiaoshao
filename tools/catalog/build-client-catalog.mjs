import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clientCatalogSource } from './lib/client-catalog.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = require('../../cloudfunctions/gxs_api/lib/services/catalog.js').buildFromBundled();
const target = path.join(root, 'miniprogram/config/catalog-seed.js');
const code = clientCatalogSource(built);
fs.writeFileSync(target, code, 'utf8');
console.log(JSON.stringify({ products: built.products.length, stores: built.stores.length, bytes: fs.statSync(target).size }));
