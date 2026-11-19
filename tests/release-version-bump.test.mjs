import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tools/release/bump-version.mjs', import.meta.url));
const packages = ['', 'cloudfunctions/gxs_api', 'cloudfunctions/gxs_monitor', 'cloudfunctions/cloudbase_auth', 'tools/collector'];
const files = packages.flatMap(dir => ['package.json', 'package-lock.json'].map(file => path.join(dir, file)))
  .concat('config/delivery-targets.json', 'miniprogram/config/version.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-version-bump-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of files) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pkg = { name: 'example', version: '3.7.9', description: 'fixture version 3.7.9' };
    if (name.endsWith('package-lock.json')) pkg.packages = { '': { version: pkg.version }, 'node_modules/example': { version: pkg.version } };
    fs.writeFileSync(file, name.endsWith('.js') ? "module.exports = { VERSION: '3.7.9' };\n" : JSON.stringify(pkg, null, 2) + '\n');
  }
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const snapshot = () => files.map(read);
  const run = (version, nodeOptions = []) => spawnSync(process.execPath, [...nodeOptions, script, version], { cwd: root, encoding: 'utf8' });
  return { root, read, snapshot, run };
}

test('repeatable explicit bumps handle numeric ordering and preserve non-release fields', t => {
  const { root, read, snapshot, run } = fixture(t);
  // A previous process already finished the root manifest only.
  fs.writeFileSync(path.join(root, 'package.json'), read('package.json').replace('"version": "3.7.9"', '"version": "3.7.10"'));
  assert.equal(run('3.7.10').status, 0);
  for (const name of files.filter(file => file.endsWith('.json'))) {
    const data = JSON.parse(read(name));
    assert.equal(data.version, '3.7.10');
    assert.equal(data.description, 'fixture version 3.7.9');
    if (data.packages) {
      assert.equal(data.packages[''].version, '3.7.10');
      assert.equal(data.packages['node_modules/example'].version, '3.7.9');
    }
  }
  assert.equal(read('miniprogram/config/version.js'), "module.exports = { VERSION: '3.7.10' };\n");
  const complete = snapshot();
  assert.equal(run('3.7.10').status, 0);
  assert.deepEqual(snapshot(), complete);
});

test('a lower or non-canonical target leaves the project untouched', t => {
  const { snapshot, run } = fixture(t);
  const original = snapshot();
  for (const version of ['3.7.8', '2.99.99', '3.07.10', '3.7.10-preview']) {
    assert.notEqual(run(version).status, 0, version);
    assert.deepEqual(snapshot(), original);
  }
});

test('a late invalid or incomplete lockfile is detected before any file changes', t => {
  const { root, snapshot, run } = fixture(t);
  for (const bad of ['{', JSON.stringify({ version: '3.7.9', lockfileVersion: 3, packages: {} })]) {
    fs.writeFileSync(path.join(root, 'tools/collector/package-lock.json'), bad);
    const original = snapshot();
    assert.notEqual(run('3.7.10').status, 0);
    assert.deepEqual(snapshot(), original);
  }
});

test('a failed replacement rolls back earlier files and the same target can be retried', t => {
  const { root, snapshot, run, read } = fixture(t);
  const original = snapshot();
  const fault = path.join(root, 'fail-once.cjs');
  fs.writeFileSync(fault, `
    const fs = require('node:fs');
    const path = require('node:path');
    const rename = fs.renameSync;
    fs.renameSync = (src, dest) => {
      if (path.basename(dest) === 'delivery-targets.json') throw Error('injected write failure');
      return rename(src, dest);
    };
  `);
  const failed = run('3.7.10', ['--require', fault]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /injected write failure/);
  assert.deepEqual(snapshot(), original);
  assert.equal(run('3.7.10').status, 0);
  assert.equal(JSON.parse(read('config/delivery-targets.json')).version, '3.7.10');
});
