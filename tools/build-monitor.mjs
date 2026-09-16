import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'cloudfunctions', 'gxs_api', 'lib');
const target = path.join(root, 'cloudfunctions', 'gxs_monitor', 'lib');
const checkOnly = process.argv.includes('--check');
const rows = [];
function build(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) { build(absolute); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const relative = path.relative(source, absolute);
    const destination = path.join(target, relative);
    const data = fs.readFileSync(absolute);
    if (!checkOnly) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, data); }
    if (!fs.existsSync(destination) || !data.equals(fs.readFileSync(destination))) throw new Error(`Monitor shared source is stale: ${relative}`);
    rows.push({ path: relative.replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
}
build(source);
console.log(JSON.stringify({ checked: checkOnly, files: rows.length, source: 'cloudfunctions/gxs_api/lib', target: 'cloudfunctions/gxs_monitor/lib' }, null, 2));
