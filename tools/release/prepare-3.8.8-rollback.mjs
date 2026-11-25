// Build and exercise the three-market rollback from local Git objects and the npm cache.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMonitorBundle, checkMonitorBundle } from '../lib/monitor-bundle.mjs';
import { extractRollbackProject, verifyRollbackProject } from './rollback-3.8.8-project.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'gxs-3.8.8-rollback-'));
extractRollbackProject(dir);
execFileSync('git', ['apply', '--whitespace=error', path.join(root, 'tools/release/3.8.8-withdrawn-watch.patch')], { cwd: dir });
for (const file of [
  'cloudfunctions/gxs_api/lib/config.js',
  'cloudfunctions/gxs_api/lib/services/market-follows.js',
  'cloudfunctions/gxs_api/lib/repo/cloudbase-repo.js',
  'cloudfunctions/gxs_api/lib/services/admin.js',
  'cloudfunctions/gxs_api/lib/collections.js',
  'config/database-deployment-plan.json',
]) copyFileSync(path.join(root, file), path.join(dir, file));
verifyRollbackProject(dir);
if (!buildMonitorBundle(dir).passed || !checkMonitorBundle(dir).passed) throw Error('回退监测包与 API 源码不一致');
// Windows ships npm as a command script. Only fixed npm arguments go through cmd.exe.
const [npm, ...npmPrefix] = process.platform === 'win32' ? ['cmd.exe', '/d', '/c', 'npm.cmd'] : ['npm'];
for (const name of ['gxs_api', 'gxs_monitor']) {
  const cwd = path.join(dir, 'cloudfunctions', name);
  try {
    execFileSync(npm, [...npmPrefix, 'ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      '--no-bin-links', '--logs-max=0', '--update-notifier=false'], { cwd, stdio: 'inherit' });
  } catch (cause) {
    throw new Error(name + ' 无法按归档锁文件离线安装运行依赖，回退包构建已中止', { cause });
  }
  execFileSync(process.execPath, ['--no-global-search-paths', path.join(root, 'tools/release/verify-rollback-function.mjs')], {
    cwd, stdio: 'inherit', env: { TENCENTCLOUD_RUNENV: 'SCF', SCF_NAMESPACE: 'offline-rollback', TENCENTCLOUD_REGION: 'offline' },
  });
}
execFileSync(process.execPath, ['--test', 'tests/market-rollback.test.mjs'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, GXS_ROLLBACK_TREE: dir },
});
console.log('3.8.8 兼容回退包已通过本地回读与取消关注演练。目录 ' + dir);
