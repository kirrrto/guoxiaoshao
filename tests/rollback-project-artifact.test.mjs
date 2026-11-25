import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractRollbackProject, rollbackBase, verifyRollbackProject } from '../tools/release/rollback-3.8.8-project.mjs';

test('the archived 3.8.8 WeChat project retains its compiler configuration and resolves its actual entry files', t => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const git = args => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true'
    && git(['cat-file', '-e', rollbackBase + '^{commit}']).status !== 0) {
    t.skip('当前浅克隆没有 3.8.8 归档对象');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'gxs-rollback-project-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  extractRollbackProject(dir);
  verifyRollbackProject(dir);

  const file = path.join(dir, 'project.config.json');
  const bytes = readFileSync(file);
  const config = JSON.parse(bytes);
  assert.equal(config.compileType, 'miniprogram');
  assert.equal(config.miniprogramRoot, 'miniprogram/');
  assert.equal(config.srcMiniprogramRoot, config.miniprogramRoot);
  assert.equal(config.cloudfunctionRoot, 'cloudfunctions/');
  assert.equal(config.libVersion, '3.17.3');
  assert.equal(config.setting.useCompilerModule, true);

  config.setting.useCompilerModule = false;
  writeFileSync(file, JSON.stringify(config));
  assert.throws(() => verifyRollbackProject(dir), /project.config.json 与 3.8.8 原件不一致/);
  writeFileSync(file, bytes);
  rmSync(path.join(dir, config.miniprogramRoot, 'pages/query/index.wxml'));
  assert.throws(() => verifyRollbackProject(dir), /pages[/\\]query[/\\]index\.wxml/);
});
