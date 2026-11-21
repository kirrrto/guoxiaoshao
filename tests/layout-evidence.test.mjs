import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('layout verification rejects empty, untraceable and unmatched previews', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-layout-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'index.html'),
    '<select id="page"></select><select id="scenario"></select><select id="width"></select><iframe id="frame"></iframe>');
  const snapshot = { page: 'history', scenario: 'free', width: 375, file: 'history-free-375.html' };
  for (const [snapshots, sourceHashes, args, expected] of [
    [[], [], [], /No layout snapshots in preview manifest/],
    [[snapshot], [], [], /Preview source hashes missing/],
    [[snapshot], [{ file: 'index.html', sha256: 'unused' }], ['--images-only'], /No layout snapshots match/],
  ]) {
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ snapshots, sourceHashes }));
    const result = spawnSync(process.execPath, ['tools/ui-preview/check-layout.mjs', directory, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(path.join(directory, 'layout-metrics.json')), false);
  }
});
