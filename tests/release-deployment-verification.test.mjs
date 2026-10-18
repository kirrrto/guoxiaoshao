import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyDeployment } from '../tools/release/verify-deployment.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-deploy-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), downloaded = path.join(root, 'downloaded');
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  write(path.join(source, 'package.json'), '{"version":"1.5.1"}');
  for (const name of ['gxs_api', 'gxs_monitor', 'cloudbase_auth']) {
    for (const base of [path.join(source, 'cloudfunctions'), downloaded]) {
      write(path.join(base, name, 'index.js'), 'exports.main = async () => "new-behavior";\n');
      write(path.join(base, name, 'package.json'), '{"version":"1.5.1"}\n');
    }
  }
  return { source, downloaded, write };
}

test('a same-version cloud function with old behavior fails content verification', t => {
  const f = fixture(t);
  f.write(path.join(f.downloaded, 'gxs_api/index.js'), 'exports.main = async () => "old-behavior";\n');
  const report = verifyDeployment(f.source, f.downloaded);
  assert.equal(report.passed, false);
  assert.deepEqual(report.functions[0].differences, [{ file: 'index.js', kind: 'content_mismatch' }]);
});

test('missing monitor and unexpected runtime files cannot pass release verification', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.downloaded, 'gxs_monitor/index.js'));
  f.write(path.join(f.downloaded, 'gxs_api/old-entry.js'), 'module.exports = {};');
  const report = verifyDeployment(f.source, f.downloaded);
  assert.equal(report.passed, false);
  assert.ok(report.functions[0].differences.some(x => x.kind === 'unexpected_runtime_file'));
  assert.ok(report.functions[1].differences.some(x => x.kind === 'missing'));
});

test('line endings and control-plane metadata do not create false deployment mismatches', t => {
  const f = fixture(t);
  f.write(path.join(f.downloaded, 'gxs_api/index.js'), 'exports.main = async () => "new-behavior";\r\n');
  f.write(path.join(f.downloaded, 'gxs_api/config.json'), '{"cloudMetadata":true}');
  f.write(path.join(f.downloaded, 'gxs_api/package-lock.json'), '{"installedByCloud":true}');
  f.write(path.join(f.downloaded, 'gxs_api/node_modules/ignored.js'), 'dependency content');
  assert.equal(verifyDeployment(f.source, f.downloaded).passed, true);
});
