import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareInstalledDependencies } from '../tools/release/installed-dependencies.mjs';

test('a matching lock alone does not verify the production tree returned by CloudBase', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-installed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scoped = 'node_modules/@cloud/sdk';
  const nested = scoped + '/node_modules/client';
  const extra = 'node_modules/extra';
  function install(key, version) {
    const dir = path.join(root, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
    '': { version: '3.7.0' }, [scoped]: { version: '4.0.2' }, [nested]: { version: '2.0.0' }
  } }));
  install(scoped, '4.0.2');
  install(nested, '2.0.0');
  assert.deepEqual(compareInstalledDependencies(root), { count: 2, passed: true, differences: [] });
  install(nested, '1.0.0');
  install(extra, '1.0.0');
  assert.deepEqual(compareInstalledDependencies(root).differences, [
    { path: nested, expected: '2.0.0', actual: '1.0.0' },
    { path: extra, expected: null, actual: '1.0.0' },
  ]);
  fs.rmSync(path.join(root, scoped), { recursive: true });
  assert.ok(compareInstalledDependencies(root).differences.some(d => d.path === scoped && d.actual === null));
});
