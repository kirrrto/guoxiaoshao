import fs from 'node:fs';
import path from 'node:path';

const V = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(V || '')) throw Error('Usage: node tools/release/bump-version.mjs <major.minor.patch>');
const root = process.cwd();

function updatePackageJson(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = V;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log('pkg', file);
}

function updateLock(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = V;
  if (json.packages && json.packages['']) json.packages[''].version = V;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log('lock', file);
}

updatePackageJson(path.join(root, 'package.json'));
updateLock(path.join(root, 'package-lock.json'));
for (const dir of ['cloudfunctions/gxs_api', 'cloudfunctions/gxs_monitor', 'cloudfunctions/cloudbase_auth', 'tools/collector']) {
  updatePackageJson(path.join(root, dir, 'package.json'));
  updateLock(path.join(root, dir, 'package-lock.json'));
}

const delivery = path.join(root, 'config/delivery-targets.json');
const d = JSON.parse(fs.readFileSync(delivery, 'utf8'));
d.version = V;
fs.writeFileSync(delivery, `${JSON.stringify(d, null, 2)}\n`);
console.log('delivery', delivery);

fs.writeFileSync(path.join(root, 'miniprogram/config/version.js'), `module.exports = { VERSION: '${V}' };\n`);
console.log('version.js', V);
