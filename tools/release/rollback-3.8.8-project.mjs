import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const rollbackBase = '69ce2fbb124b2f47253e9af8462a3d614fdaa520';
const gitOptions = { cwd: root, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } };

export function extractRollbackProject(dir) {
  const archive = execFileSync('git', ['archive', rollbackBase, 'project.config.json', 'miniprogram',
    'cloudfunctions/gxs_api', 'cloudfunctions/gxs_monitor', 'config/database-deployment-plan.json',
    'tests/helpers'], { ...gitOptions, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
}

export function verifyRollbackProject(dir) {
  const configBytes = readFileSync(path.join(dir, 'project.config.json'));
  const original = execFileSync('git', ['show', rollbackBase + ':project.config.json'], gitOptions);
  if (!configBytes.equals(original)) throw Error('回退包 project.config.json 与 3.8.8 原件不一致');

  const config = JSON.parse(configBytes);
  const client = path.join(dir, config.miniprogramRoot);
  const app = JSON.parse(readFileSync(path.join(client, 'app.json'), 'utf8'));
  const pages = [...app.pages, ...app.subPackages.flatMap(pkg => pkg.pages.map(page => path.join(pkg.root, page)))];
  const files = ['app.js', 'app.wxss', app.themeLocation, app.sitemapLocation,
    ...pages.flatMap(page => [page + '.js', page + '.wxml'])].map(file => path.join(client, file));
  for (const name of ['gxs_api', 'gxs_monitor']) {
    const fn = path.join(dir, config.cloudfunctionRoot, name);
    const { main } = JSON.parse(readFileSync(path.join(fn, 'package.json'), 'utf8'));
    files.push(path.join(fn, main));
  }
  for (const file of files) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw Error('回退包缺少项目入口文件 ' + path.relative(dir, file));
  }
}
