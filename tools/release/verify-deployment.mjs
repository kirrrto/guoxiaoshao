/** Read-only verification of downloaded cloud code against the release source. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FUNCTIONS = ['gxs_api', 'gxs_monitor', 'cloudbase_auth'];
const slash = value => value.replaceAll('\\', '/');
function filesAt(root) {
  const files = new Map();
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', 'output'].includes(item.name)) continue;
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Deployment inputs must not contain symbolic links');
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) {
        const relative = slash(path.relative(root, file));
        // The cloud control plane supplies config.json and remote installation
        // can rewrite package-lock.json. Verify triggers/installed SDK separately.
        if (relative === 'config.json' || relative === 'package-lock.json') continue;
        if (!/\.(?:js|json)$/.test(relative)) continue;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)).replace(/\r\n?/g, '\n');
        files.set(relative, crypto.createHash('sha256').update(text).digest('hex'));
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return files;
}

export function verifyDeployment(sourceRoot, downloadedRoot) {
  const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
  const functions = FUNCTIONS.map(name => {
    const expected = filesAt(path.join(sourceRoot, 'cloudfunctions', name));
    const actual = filesAt(path.join(downloadedRoot, name));
    const differences = [];
    if (!expected.has('index.js') || !expected.has('package.json')) differences.push({ kind: 'invalid_source' });
    for (const [file, sha256] of expected) {
      if (!actual.has(file)) differences.push({ file, kind: 'missing' });
      else if (actual.get(file) !== sha256) differences.push({ file, kind: 'content_mismatch' });
    }
    for (const file of actual.keys()) if (!expected.has(file)) differences.push({ file, kind: 'unexpected_runtime_file' });
    return { name, passed: differences.length === 0, comparedFiles: expected.size, differences,
      sourceHashes: Object.fromEntries([...expected].sort(([a], [b]) => a.localeCompare(b))) };
  });
  return { version, checkedAt: new Date().toISOString(), passed: functions.every(item => item.passed), functions,
    scope: 'Downloaded JavaScript and JSON runtime source including package metadata; does not prove runtime config, triggers, installed dependencies, traffic, payment, notifications or frontend publication.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1]; };
  const directory = value('--download-dir');
  if (!directory || directory.startsWith('--')) throw new Error('Usage: node tools/release/verify-deployment.mjs --download-dir <directory containing three downloaded functions> [--out report.json]');
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = verifyDeployment(source, path.resolve(directory));
  const out = value('--out');
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); }
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
