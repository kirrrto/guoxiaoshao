// Fetch the official Apple China retail store list (one bounded GET) and
// write catalog/stores.json plus an evidence manifest with the body hash.
// Usage: node tools/catalog/fetch-stores.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedGet } from './lib/http.mjs';
import { parseStoreList } from './lib/parse-storelist.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_URL = 'https://www.apple.com.cn/retail/storelist/';
const day = new Date().toISOString().slice(0, 10);
const evidenceDir = resolve(root, 'evidence', 'catalog', day);
await mkdir(evidenceDir, { recursive: true });
await mkdir(resolve(root, 'catalog'), { recursive: true });

const { record, body, text } = await boundedGet(SOURCE_URL, { accept: 'text/html' });
await writeFile(resolve(evidenceDir, 'storelist.body.html'), body);
if (record.httpStatus !== 200) {
  await writeFile(resolve(evidenceDir, 'storelist.manifest.json'), JSON.stringify({ record }, null, 2) + '\n');
  throw new Error(`Store list request failed: HTTP ${record.httpStatus ?? 'n/a'} ${record.error?.message ?? ''}`);
}
const stores = parseStoreList(text);
if (stores.length < 40) throw new Error(`Only ${stores.length} stores parsed; refusing to overwrite the catalog`);
stores.sort((a, b) => (a.province ?? '').localeCompare(b.province ?? '', 'zh-Hans-CN')
  || (a.city ?? '').localeCompare(b.city ?? '', 'zh-Hans-CN') || a.storeNumber.localeCompare(b.storeNumber));

const catalog = {
  schemaVersion: 1,
  kind: 'apple-retail-stores-cn',
  source: { url: SOURCE_URL, fetchedAt: record.finishedAt, sha256: record.sha256, bytes: record.bytes },
  note: '中国大陆 Apple 直营店目录，来源为苹果官网门店列表页；不含授权经销商。storeNumber 用于取货接口 store 参数。',
  count: stores.length,
  stores,
};
await writeFile(resolve(root, 'catalog', 'stores.json'), JSON.stringify(catalog, null, 2) + '\n');
await writeFile(resolve(evidenceDir, 'storelist.manifest.json'), JSON.stringify({ record, parsedStores: stores.length }, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, stores: stores.length, provinces: new Set(stores.map(s => s.province)).size, cities: new Set(stores.map(s => s.city)).size, sha256: record.sha256 }));
