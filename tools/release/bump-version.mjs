import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!versionPattern.test(target) || process.argv.length !== 3) throw Error('Usage: node tools/release/bump-version.mjs <major.minor.patch>');
const targetParts = target.split('.').map(BigInt);
const packageDirs = ['', 'cloudfunctions/gxs_api', 'cloudfunctions/gxs_monitor', 'cloudfunctions/cloudbase_auth', 'tools/collector'];
const files = packageDirs.flatMap(dir => ['package.json', 'package-lock.json'].map(name => path.join(dir, name)));
files.push('config/delivery-targets.json', 'miniprogram/config/version.js');

function checkCurrent(current, file) {
  if (typeof current !== 'string' || !versionPattern.test(current)) throw Error('Missing or invalid version in ' + file);
  const parts = current.split('.').map(BigInt);
  const difference = parts.findIndex((value, i) => value !== targetParts[i]);
  if (difference !== -1 && parts[difference] > targetParts[difference]) throw Error(`Refusing downgrade from ${current} to ${target} in ${file}`);
}

function updatedContents(file, original) {
  if (file.endsWith('.js')) {
    const match = /^\s*module\.exports\s*=\s*\{\s*VERSION\s*:\s*(['"])([^'"]+)\1\s*\}\s*;?\s*$/.exec(original);
    checkCurrent(match?.[2], file);
    return original.replace(match[2], target);
  }
  let json;
  try { json = JSON.parse(original); }
  catch (cause) { throw new Error('Invalid JSON in ' + file, { cause }); }
  const manifests = file.endsWith('package-lock.json') ? [json, json?.packages?.['']] : [json];
  for (const manifest of manifests) checkCurrent(manifest?.version, file);
  if (manifests.every(manifest => manifest.version === target)) return original;
  for (const manifest of manifests) manifest.version = target;
  return JSON.stringify(json, null, 2) + '\n';
}

// One local release operation owns the staged replacements and their backups.
const staging = '.gxs-version-bump.tmp';
try { fs.mkdirSync(staging); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  throw Error(`Version bump already in progress. If that process was interrupted, inspect ${staging}, then remove it and retry the same target.`);
}
const committed = [];
let retainBackups = false;
try {
  const changes = [];
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const updated = updatedContents(file, original);
    if (updated === original) continue;
    const next = path.join(staging, file.split(path.sep).join('_'));
    const backup = next + '.original';
    fs.copyFileSync(file, backup);
    fs.copyFileSync(file, next);
    fs.writeFileSync(next, updated);
    changes.push({ file, next, backup });
  }
  for (const change of changes) {
    fs.renameSync(change.next, change.file);
    committed.push(change);
  }
} catch (error) {
  try {
    for (const change of committed.reverse()) fs.renameSync(change.backup, change.file);
  } catch (restoreError) {
    retainBackups = true;
    throw new AggregateError([error, restoreError], `Could not restore all versions. Original files are retained in ${staging}.`);
  }
  throw error;
} finally {
  if (!retainBackups) fs.rmSync(staging, { recursive: true, force: true });
}
console.log(`Release metadata at ${target} (${committed.length} files updated)`);
