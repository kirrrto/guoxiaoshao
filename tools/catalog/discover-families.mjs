// Discover product-family buy pages from the category landing pages.
// One bounded GET per category, spaced out; writes evidence/catalog/<day>/families.json
// Usage: node tools/catalog/discover-families.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedGet, sleep } from './lib/http.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const day = new Date().toISOString().slice(0, 10);
const evidenceDir = resolve(root, 'evidence', 'catalog', day);
await mkdir(evidenceDir, { recursive: true });

const categories = [
  { category: 'iphone', landing: 'https://www.apple.com.cn/shop/buy-iphone' },
  { category: 'ipad', landing: 'https://www.apple.com.cn/shop/buy-ipad' },
  { category: 'mac', landing: 'https://www.apple.com.cn/shop/buy-mac' },
  { category: 'watch', landing: 'https://www.apple.com.cn/shop/buy-watch' },
  { category: 'airpods', landing: 'https://www.apple.com.cn/shop/buy-airpods' },
  { category: 'vision', landing: 'https://www.apple.com.cn/shop/buy-vision' },
  { category: 'homepod', landing: 'https://www.apple.com.cn/shop/buy-homepod' },
];

const results = [];
for (const [index, item] of categories.entries()) {
  if (index > 0) await sleep(1500);
  const { record, text } = await boundedGet(item.landing, { accept: 'text/html' });
  const pattern = new RegExp(`href="(?:https://www\\.apple\\.com\\.cn)?(/shop/buy-${item.category}/[a-z0-9-]+)(?:[/?#"]|")`, 'g');
  const links = new Set();
  let match;
  if (record.httpStatus === 200) {
    while ((match = pattern.exec(text)) !== null) links.add(match[1]);
  }
  const titleMatch = text.match(/<title>([^<]*)<\/title>/);
  results.push({ ...item, record, title: titleMatch ? titleMatch[1] : null, familyPaths: [...links].sort() });
  console.log(JSON.stringify({ category: item.category, status: record.httpStatus, location: record.headers?.location ?? null, families: [...links].sort() }));
  if ([403, 429, 541].includes(record.httpStatus)) {
    console.log('Access/rate-limit response; stopping discovery without retry.');
    break;
  }
}
await writeFile(resolve(evidenceDir, 'families.json'), JSON.stringify({ discoveredAt: new Date().toISOString(), results }, null, 2) + '\n');
