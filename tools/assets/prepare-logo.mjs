/** Package the selected generated logo without changing its artwork. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = process.argv[2];
if (!source || !fs.existsSync(source)) throw Error('Pass the generated logo PNG path as the first argument');
const masterDir = path.join(root, 'docs/brand');
const miniDir = path.join(root, 'miniprogram/images/brand');
fs.mkdirSync(masterDir, { recursive: true });
fs.mkdirSync(miniDir, { recursive: true });
const master = path.join(masterDir, 'logo-mint-master.png');
if (path.resolve(source) !== master) fs.copyFileSync(source, master);
const outputs = [
  { file: path.join(miniDir, 'logo-mint-144.png'), size: 144 },
  { file: path.join(masterDir, 'logo-mint-512.png'), size: 512 },
];
for (const output of outputs) {
  await sharp(master).resize(output.size, output.size, { fit: 'contain' }).png({ compressionLevel: 9 }).toFile(output.file);
}
const metadata = await sharp(master).metadata();
const record = { packagedAt: new Date().toISOString(), method: 'Original PNG copied unchanged; derivatives only resized using Lanczos3 and lossless PNG compression', master: { width: metadata.width, height: metadata.height, hasAlpha: metadata.hasAlpha }, files: [master, ...outputs.map(x => x.file)].map(file => ({ path: path.relative(root, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })) };
fs.writeFileSync(path.join(masterDir, 'logo-manifest.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
