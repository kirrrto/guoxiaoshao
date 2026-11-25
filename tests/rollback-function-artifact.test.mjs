import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rollbackBase } from '../tools/release/rollback-3.8.8-project.mjs';
import { compareInstalledDependencies } from '../tools/release/installed-dependencies.mjs';

test('the generated rollback functions carry their archived locks and start from their own production dependencies', t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true'
    && git(['cat-file', '-e', rollbackBase + '^{commit}']).status !== 0) {
    t.skip('当前浅克隆没有 3.8.8 归档对象');
    return;
  }
  const tmp = mkdtempSync(path.join(tmpdir(), 'gxs-rollback-function-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  delete env.NODE_TEST_CONTEXT;
  const build = extra => spawnSync(process.execPath, ['tools/release/prepare-3.8.8-rollback.mjs'], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8',
  });
  const ready = build();
  assert.equal(ready.status, 0, ready.stdout + ready.stderr);
  const trees = readdirSync(tmp).filter(name => name.startsWith('gxs-3.8.8-rollback-'));
  assert.equal(trees.length, 1);
  for (const name of ['gxs_api', 'gxs_monitor']) {
    const relative = 'cloudfunctions/' + name;
    const cwd = path.join(tmp, trees[0], relative);
    const lock = git(['show', rollbackBase + ':' + relative + '/package-lock.json']);
    assert.equal(lock.status, 0, lock.stderr);
    assert.equal(readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'), lock.stdout);
    assert.deepEqual(compareInstalledDependencies(cwd), { count: 97, differences: [], passed: true });
    assert.match(ready.stdout, new RegExp(name + ' 已从实物加载入口'));

    // Preserve the real package metadata but remove its actual entry in our
    // disposable copy. Checking installed version numbers alone would pass.
    rmSync(path.join(cwd, 'node_modules/wx-server-sdk/index.js'));
    const broken = spawnSync(process.execPath, ['--no-global-search-paths', path.join(root, 'tools/release/verify-rollback-function.mjs')], {
      cwd, encoding: 'utf8', env: { NODE_PATH: path.join(root, relative, 'node_modules') },
    });
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /wx-server-sdk/);
  }

  const unavailable = build({ npm_config_cache: path.join(tmp, 'empty-cache') });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /无法按归档锁文件离线安装运行依赖/);
  assert.doesNotMatch(unavailable.stdout, /兼容回退包已通过/);
});
