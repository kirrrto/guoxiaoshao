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
const groups = [], groupIndex = new Map(), attrKeys = [], attrKeyIndex = new Map(), statuses = [], statusIndex = new Map();
const idxOf = (arr, map, val) => { const k = JSON.stringify(val); if (!map.has(k)) { map.set(k, arr.length); arr.push(val); } return map.get(k); };
const packedProducts = raw.products.map(p => {
  const gIdx = idxOf(groups, groupIndex, [p.category, p.familyKey, p.familyName, p.model]);
  const sIdx = idxOf(statuses, statusIndex, p.verificationStatus);
  const attrs = Object.entries(p.attributes || {}).map(([k, v]) => [idxOf(attrKeys, attrKeyIndex, k), v]);
  return [p.partNumber, gIdx, p.title, attrs, p.priceCny, (p.comingSoon ? 1 : 0) | (p.supported ? 2 : 0), sIdx];
});
const packed = { v: raw.version, f: raw.families, st: raw.stores.map(s => [s.storeNumber, s.name, s.city, s.province, s.slug]), g: groups, k: attrKeys, vs: statuses, p: packedProducts };
const target = path.join(root, 'miniprogram/config/catalog-seed.js');
const code = `// Public browsing seed; refreshes from the cloud. No user data or inventory.
const D = ${JSON.stringify(packed)};
module.exports = {
  version: D.v,
  families: D.f,
  stores: D.st.map(([storeNumber, name, city, province, slug]) => ({ storeNumber, name, city, province, slug })),
  products: D.p.map(([partNumber, g, title, a, priceCny, fl, s]) => {
    const [category, familyKey, familyName, model] = D.g[g];
    const attributes = {};
    for (const [ki, val] of a) attributes[D.k[ki]] = val;
    const out = { partNumber, category, familyKey, familyName };
    if (model !== undefined) out.model = model;
    return Object.assign(out, { title, attributes, priceCny, comingSoon: Boolean(fl & 1), supported: Boolean(fl & 2), verificationStatus: D.vs[s] });
  }),
};\n`;
fs.writeFileSync(target, code, 'utf8');
console.log(JSON.stringify({ products: raw.products.length, stores: raw.stores.length, bytes: fs.statSync(target).size }));
