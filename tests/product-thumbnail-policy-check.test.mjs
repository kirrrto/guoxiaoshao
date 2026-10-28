import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = 'tools/assets/build-product-thumbnails.mjs';
const policyPath = 'config/product-image-policy.json';
const manifestPath = 'evidence/assets/product-thumbnails.manifest.json';

test('the actual --check rejects changed encoding policy against unchanged artifacts, including missing metadata', async t => {
  const run = directory => spawnSync(process.execPath, [path.join(directory, script), '--check'], { cwd: directory, encoding: 'utf8', windowsHide: true });
  const baseline = run(root);
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gxs-image-policy-'));
  t.after(async () => { if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('gxs-image-policy-')) await fs.rm(directory, { recursive: true, force: true }); });
  const policy = JSON.parse(await fs.readFile(path.join(root, policyPath), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog/products.json'), 'utf8'));
  // Each negative run uses the real command in an isolated checkout skeleton.
  // No product images or source files in the working checkout are modified.
  for (const file of [script, 'tools/catalog/lib/http.mjs', policyPath, 'catalog/products.json', manifestPath,
    'miniprogram/config/product-thumbnails.js', `evidence/catalog/${catalog.imagesGeneratedAt.slice(0, 10)}/images.verification.json`]) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
  }
  for (const [field, changed] of Object.entries({ jpegQuality: 84, pngColors: 128, alphaClear: 0, alphaSolid: 255 })) {
    await fs.writeFile(path.join(directory, policyPath), JSON.stringify({ ...policy, [field]: changed }));
    const result = run(directory);
    assert.notEqual(result.status, 0, `changed ${field} must invalidate the old encoder manifest`);
    assert.match(result.stderr, new RegExp(`thumbnail_encoder_policy_mismatch:${field}`));
    assert.doesNotMatch(result.stderr, /ENOENT/, 'the encoding policy gate runs before image-file reads');
  }
  await fs.writeFile(path.join(directory, policyPath), JSON.stringify(policy));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, manifestPath), 'utf8'));
  delete manifest.encoder.transparent.alphaSnap;
  await fs.writeFile(path.join(directory, manifestPath), JSON.stringify(manifest));
  const missing = run(directory);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /thumbnail_encoder_policy_mismatch:alphaClear/);
});
